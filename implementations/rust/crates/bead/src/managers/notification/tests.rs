//! The notification manager's tests (spec 11): each subscription under the call id of the request
//! that made it, one a procedure for each session of a connection, in the order they were made,
//! cleaned with its connection; and a paced subscription's credit and queue (spec 11.7 to 11.11).

use std::sync::Arc;

use bytes::Bytes;

use super::{
    NotificationKey, NotificationManager, PACING_DEFAULTS, Pacing, PacingLimits,
    PacingLimitsOptions, PacingOutcome, SubscribingCall, Subscription, pacing_limits_of,
};
use crate::constants::RouterSide;
use crate::failure::ProcedureAddress;
use crate::identity::Procedure;
use crate::metrics::{MetricsRegistry, MetricsRegistryOptions, NotificationSeries};
use crate::router::types::{ConnectionHandle, SessionIdentifier};

const FIRST: &str = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";
const SECOND: &str = "type=WS;ip=127.0.0.1;port=50002;ordinal=1";
const UNKNOWN: &str = "type=WS;ip=127.0.0.1;port=1;ordinal=1";

const LIMITS: PacingLimits = PacingLimits {
    maximum_queued_notification_bytes: 1_024,
    maximum_queued_notifications: 8,
};

fn handle(text: &str) -> ConnectionHandle {
    Arc::from(text)
}

fn address((service_id, procedure_id): (u16, u16)) -> ProcedureAddress {
    ProcedureAddress {
        service_id,
        procedure_id,
    }
}

// a subscribing call of a connection, in its connection's session, unpaced and uncounted
fn call((call_id, connection): (u32, &str)) -> SubscribingCall {
    SubscribingCall {
        call_id,
        connection_handle: handle(connection),
        end: None,
        identifier: None,
        paced: false,
        series: None,
    }
}

fn paced((call_id, connection): (u32, &str)) -> SubscribingCall {
    SubscribingCall {
        paced: true,
        ..call((call_id, connection))
    }
}

fn manager() -> NotificationManager {
    NotificationManager::new(PACING_DEFAULTS)
}

fn registered(
    notifications: &mut NotificationManager,
    (procedure, subscribing): ((u16, u16), SubscribingCall),
) -> u32 {
    notifications
        .register(address(procedure), &subscribing)
        .expect("registered")
}

// a subscription as the manager hands it out: its call id, its connection and its procedure
fn subscription(
    (call_id, connection): (u32, &str),
    (service_id, procedure_id): (u16, u16),
) -> Subscription {
    Subscription {
        call_id,
        connection_handle: handle(connection),
        procedure: address((service_id, procedure_id)),
        identifier: None,
    }
}

fn call_ids(subscriptions: &[Subscription]) -> Vec<(String, u32)> {
    subscriptions
        .iter()
        .map(|held| (held.connection_handle.to_string(), held.call_id))
        .collect()
}

fn one_byte() -> (Option<NotificationKey>, Bytes) {
    (None, Bytes::from_static(&[0]))
}

fn sized(size: usize) -> (Option<NotificationKey>, Bytes) {
    (None, Bytes::from(vec![0_u8; size]))
}

fn word(text: &'static str) -> (Option<NotificationKey>, Bytes) {
    (None, Bytes::from_static(text.as_bytes()))
}

fn keyed((key, text): (NotificationKey, &'static str)) -> (Option<NotificationKey>, Bytes) {
    (Some(key), Bytes::from_static(text.as_bytes()))
}

fn words(payloads: &[Bytes]) -> Vec<String> {
    payloads
        .iter()
        .map(|payload| String::from_utf8_lossy(payload).into_owned())
        .collect()
}

fn counts(notifications: &NotificationManager) -> Vec<(&'static str, u64)> {
    notifications.gauges().counts.into_iter().collect()
}

fn series_of(notifications: &NotificationManager, (call_id, connection): (u32, &str)) -> String {
    format!(
        "{:?}",
        notifications.series_of(call_id, &handle(connection))
    )
}

fn news(id: u16) -> Procedure {
    Procedure {
        service_id: 10,
        id,
        service_revision: 1,
        name: if id == 1 { "news" } else { "other" }.to_owned(),
        kind: None,
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

fn notifying_of(series: Option<NotificationSeries>) -> NotificationSeries {
    series.expect("a procedure that notifies is counted")
}

#[test]
fn forgets_a_removed_subscription_s_metrics_series_and_keeps_another_connection_s_series() {
    let registry = MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let metrics = registry.attach(RouterSide::Server);
    let one = notifying_of(
        metrics
            .declare_resolver(&news(1), true)
            .expect("declared")
            .notifying,
    );
    let other = notifying_of(
        metrics
            .declare_resolver(&news(2), true)
            .expect("declared")
            .notifying,
    );
    let mut notifications = manager();
    let before = registry.exposition();

    registered(
        &mut notifications,
        (
            (10, 1),
            SubscribingCall {
                series: Some(one.clone()),
                ..call((13, FIRST))
            },
        ),
    );
    registered(
        &mut notifications,
        (
            (10, 2),
            SubscribingCall {
                series: Some(other.clone()),
                ..call((13, SECOND))
            },
        ),
    );

    let (one, other) = (format!("{:?}", Some(one)), format!("{:?}", Some(other)));

    assert_eq!(series_of(&notifications, (13, FIRST)), one, "its own");
    assert_eq!(series_of(&notifications, (13, SECOND)), other, "its own");
    assert_eq!(
        series_of(&notifications, (99, FIRST)),
        "None",
        "a call id none holds"
    );
    assert_eq!(
        series_of(&notifications, (13, UNKNOWN)),
        "None",
        "a connection none knows"
    );
    assert_eq!(
        notifications
            .unregister(13, &handle(FIRST))
            .map(|held| held.call_id),
        Some(13),
        "taken out"
    );
    assert_eq!(series_of(&notifications, (13, FIRST)), "None", "forgotten");
    assert_eq!(series_of(&notifications, (13, SECOND)), other, "kept");

    notifications.clean(&handle(SECOND));

    assert_eq!(series_of(&notifications, (13, SECOND)), "None", "forgotten");

    // * the same place may subscribe without counting; a removed series never comes back
    registered(&mut notifications, ((10, 1), call((13, FIRST))));

    assert!(notifications.has(13, &handle(FIRST)), "subscribed again");
    assert_eq!(series_of(&notifications, (13, FIRST)), "None", "uncounted");
    assert!(
        notifications.unregister(13, &handle(FIRST)).is_some(),
        "taken out"
    );
    assert!(notifications.subscriptions(None).is_empty(), "none held");
    assert_eq!(registry.exposition(), before, "nothing counted");
}

#[test]
fn registers_each_subscription_under_the_call_id_of_the_request_that_made_it() {
    let mut notifications = manager();

    assert_eq!(
        registered(&mut notifications, ((10, 1), call((1, FIRST)))),
        1,
        "its call id"
    );
    assert_eq!(
        registered(&mut notifications, ((10, 2), call((3, SECOND)))),
        3,
        "its call id"
    );
    assert_eq!(
        registered(&mut notifications, ((20, 1), call((5, FIRST)))),
        5,
        "its call id"
    );
    assert_eq!(
        notifications.subscriptions(None),
        [
            subscription((1, FIRST), (10, 1)),
            subscription((5, FIRST), (20, 1)),
            subscription((3, SECOND), (10, 2)),
        ],
        "each under its call id, by connection"
    );
}

#[test]
fn holds_one_subscription_a_procedure_for_each_session_of_a_connection_its_connection_s_and_each_credential_s_by_its_identifier_octet_for_octet()
 {
    let mut notifications = manager();
    let grace = SessionIdentifier::JwtSub {
        issuer: "https://a.example".to_owned(),
        sub: "grace".to_owned(),
    };
    let grace_elsewhere = SessionIdentifier::JwtSub {
        issuer: "https://b.example".to_owned(),
        sub: "grace".to_owned(),
    };
    let grace_upper = SessionIdentifier::JwtSub {
        issuer: "https://a.example".to_owned(),
        sub: "Grace".to_owned(),
    };
    let identifiers = [
        None,
        Some(grace.clone()),
        Some(grace_elsewhere.clone()),
        Some(grace_upper.clone()),
    ];
    // the call each session holds its place with, looked up by a copy of its identifier
    let places_of = |notifications: &NotificationManager| -> Vec<Option<u32>> {
        identifiers
            .iter()
            .map(|identifier| {
                notifications
                    .subscription_of(address((10, 1)), (&handle(FIRST), identifier.as_ref()))
            })
            .collect()
    };

    for (call_id, identifier) in [
        (1, None),
        (3, Some(grace.clone())),
        (5, Some(grace_elsewhere.clone())),
        // its sub in another case: another session
        (7, Some(grace_upper.clone())),
    ] {
        registered(
            &mut notifications,
            (
                (10, 1),
                SubscribingCall {
                    identifier,
                    ..call((call_id, FIRST))
                },
            ),
        );
    }

    // a second of one session is refused, a copy of its identifier the same session
    assert!(
        notifications
            .register(
                address((10, 1)),
                &SubscribingCall {
                    identifier: Some(grace.clone()),
                    ..call((9, FIRST))
                },
            )
            .is_err(),
        "a second of one session refused"
    );
    assert_eq!(
        places_of(&notifications),
        [Some(1), Some(3), Some(5), Some(7)],
        "one place a session"
    );
    assert_eq!(
        notifications.candidates(address((10, 1))),
        [
            subscription((1, FIRST), (10, 1)),
            Subscription {
                identifier: Some(grace),
                ..subscription((3, FIRST), (10, 1))
            },
            Subscription {
                identifier: Some(grace_elsewhere),
                ..subscription((5, FIRST), (10, 1))
            },
            Subscription {
                identifier: Some(grace_upper),
                ..subscription((7, FIRST), (10, 1))
            },
        ],
        "each with its session's identifier"
    );

    // the one of a credential's session taken away, every other place stays
    notifications.unregister(3, &handle(FIRST));

    assert_eq!(
        places_of(&notifications),
        [Some(1), None, Some(5), Some(7)],
        "the others stay"
    );
}

// the order the wire sees: the failures a session's end sends, the connections a notification goes
// to
#[test]
fn keeps_its_subscriptions_and_candidates_in_the_order_they_were_made_one_taken_away_between() {
    const THIRD: &str = "type=WS;ip=127.0.0.1;port=50003;ordinal=1";

    let mut notifications = manager();

    registered(&mut notifications, ((10, 1), call((1, FIRST))));
    registered(&mut notifications, ((10, 2), call((3, FIRST))));
    registered(&mut notifications, ((10, 1), call((7, SECOND))));
    notifications.unregister(1, &handle(FIRST));
    registered(&mut notifications, ((10, 3), call((5, FIRST))));
    registered(&mut notifications, ((10, 1), call((9, THIRD))));

    assert_eq!(
        call_ids(&notifications.subscriptions(Some(&handle(FIRST)))),
        [(FIRST.to_owned(), 3), (FIRST.to_owned(), 5)],
        "its subscriptions in order"
    );
    assert_eq!(
        call_ids(&notifications.candidates(address((10, 1)))),
        [(SECOND.to_owned(), 7), (THIRD.to_owned(), 9)],
        "its candidates in order"
    );
}

#[test]
fn takes_the_same_call_id_on_two_connections_as_two_subscriptions() {
    let mut notifications = manager();

    registered(&mut notifications, ((10, 1), call((13, FIRST))));
    registered(&mut notifications, ((10, 1), call((13, SECOND))));

    assert_eq!(
        notifications.candidates(address((10, 1))),
        [
            subscription((13, FIRST), (10, 1)),
            subscription((13, SECOND), (10, 1)),
        ],
        "two subscriptions"
    );
    assert!(notifications.has(13, &handle(FIRST)), "the first's");
    assert!(notifications.has(13, &handle(SECOND)), "the second's");

    notifications.unregister(13, &handle(FIRST));

    assert!(!notifications.has(13, &handle(FIRST)), "the first's gone");
    assert!(notifications.has(13, &handle(SECOND)), "the second's kept");
}

// a platform's shape: what it hands out is a Vec of its own, which the manager holds nothing of
#[test]
fn lists_the_candidates_of_one_procedure_as_a_copy() {
    let mut notifications = manager();

    registered(&mut notifications, ((10, 1), call((1, FIRST))));
    registered(&mut notifications, ((10, 1), call((3, SECOND))));
    registered(&mut notifications, ((10, 2), call((5, SECOND))));

    let mut candidates = notifications.candidates(address((10, 1)));

    assert_eq!(
        candidates,
        [
            subscription((1, FIRST), (10, 1)),
            subscription((3, SECOND), (10, 1)),
        ],
        "its own procedure's alone"
    );

    candidates.clear();

    assert_eq!(
        notifications.candidates(address((10, 1))).len(),
        2,
        "a copy"
    );
    assert!(
        notifications.candidates(address((10, 3))).is_empty(),
        "none for a procedure none subscribed to"
    );
    assert!(
        notifications.candidates(address((99, 1))).is_empty(),
        "none for a service none subscribed to"
    );
}

#[test]
fn refuses_a_second_subscription_of_a_connection_to_a_procedure_and_a_call_id_it_holds_registering_nothing()
 {
    let mut notifications = manager();

    registered(&mut notifications, ((10, 1), call((7, FIRST))));

    assert!(
        notifications
            .register(address((10, 1)), &call((9, FIRST)))
            .is_err(),
        "a second to the procedure refused"
    );
    assert!(
        notifications
            .register(address((20, 2)), &call((7, FIRST)))
            .is_err(),
        "a call id it holds refused"
    );
    assert_eq!(
        notifications.subscriptions(None),
        [subscription((7, FIRST), (10, 1))],
        "nothing registered"
    );
    // no entry was made for what was refused
    assert!(
        notifications.candidates(address((20, 2))).is_empty(),
        "no candidate kept for the refused"
    );
    assert_eq!(
        notifications.gauges().connection_handles.len(),
        1,
        "one connection"
    );
}

#[test]
fn cleans_a_connection_s_subscriptions_everywhere_and_prunes_what_empties() {
    let mut notifications = manager();

    registered(&mut notifications, ((10, 1), call((1, FIRST))));
    registered(&mut notifications, ((10, 1), call((3, SECOND))));
    registered(&mut notifications, ((10, 2), call((5, FIRST))));
    registered(&mut notifications, ((20, 1), call((7, FIRST))));

    notifications.clean(&handle(FIRST));
    notifications.clean(&handle(FIRST));
    notifications.clean(&handle(UNKNOWN));

    assert_eq!(
        notifications.subscriptions(None),
        [subscription((3, SECOND), (10, 1))],
        "the other connection's alone"
    );
    assert!(
        notifications.candidates(address((10, 2))).is_empty()
            && notifications.candidates(address((20, 1))).is_empty(),
        "what emptied pruned"
    );
    assert!(!notifications.has(1, &handle(FIRST)), "none held");
}

#[test]
fn unregisters_one_subscription_of_its_own_connection_pruning_what_empties_any_other_is_none() {
    let mut notifications = manager();

    registered(&mut notifications, ((10, 1), call((1, FIRST))));
    registered(&mut notifications, ((20, 1), call((3, SECOND))));

    // no connection takes another's
    let call_id_of = |held: Option<Subscription>| held.map(|held| held.call_id);

    assert_eq!(
        call_id_of(notifications.unregister(3, &handle(FIRST))),
        None,
        "another's"
    );
    assert_eq!(
        call_id_of(notifications.unregister(3, &handle(SECOND))),
        Some(3),
        "its own"
    );
    assert_eq!(
        call_id_of(notifications.unregister(3, &handle(SECOND))),
        None,
        "gone"
    );
    assert_eq!(
        call_id_of(notifications.unregister(99, &handle(FIRST))),
        None,
        "none held"
    );
    assert!(
        notifications.candidates(address((20, 1))).is_empty(),
        "pruned"
    );
    assert_eq!(
        notifications.subscriptions(None),
        [subscription((1, FIRST), (10, 1))],
        "the other kept"
    );

    // a call id let go of may subscribe again
    registered(&mut notifications, ((20, 1), call((3, SECOND))));

    assert_eq!(
        notifications.subscription_of(address((20, 1)), (&handle(SECOND), None)),
        Some(3),
        "subscribed again"
    );
}

#[test]
fn finds_the_subscription_a_connection_has_to_a_procedure_among_its_own_only() {
    let mut notifications = manager();

    registered(&mut notifications, ((10, 1), call((1, FIRST))));
    registered(&mut notifications, ((10, 2), call((3, FIRST))));
    registered(&mut notifications, ((20, 1), call((5, FIRST))));
    registered(&mut notifications, ((10, 1), call((7, SECOND))));

    let of = |procedure: (u16, u16), connection: &str| {
        notifications.subscription_of(address(procedure), (&handle(connection), None))
    };

    assert_eq!(of((10, 1), FIRST), Some(1), "its own");
    assert_eq!(of((20, 1), FIRST), Some(5), "its own");
    assert_eq!(of((10, 1), SECOND), Some(7), "its own");
    assert_eq!(of((20, 2), FIRST), None, "none to that procedure");
    assert_eq!(of((10, 2), SECOND), None, "another's alone");
    assert_eq!(of((10, 1), UNKNOWN), None, "a connection none knows");
}

// a platform's shape: what it hands out is a Vec of its own, which the manager holds nothing of
#[test]
fn hands_out_copies_of_its_subscriptions() {
    let mut notifications = manager();

    registered(&mut notifications, ((10, 1), call((1, FIRST))));

    let mut handed = notifications.subscriptions(None);

    if let Some(held) = handed.first_mut() {
        held.call_id = 99;
    }

    assert_eq!(
        notifications.subscriptions(None),
        [subscription((1, FIRST), (10, 1))],
        "unchanged"
    );
    assert!(!notifications.has(99, &handle(FIRST)), "nothing changed");
}

#[test]
fn counts_the_subscriptions_it_notifies_and_their_connections_until_each_is_cleaned() {
    let mut notifications = manager();

    registered(&mut notifications, ((10, 1), call((1, FIRST))));
    registered(&mut notifications, ((10, 2), call((3, FIRST))));
    registered(&mut notifications, ((10, 1), call((5, SECOND))));

    let gauges = notifications.gauges();

    assert_eq!(
        gauges.counts.get("notifiedSubscriptions"),
        Some(&3),
        "three"
    );
    assert_eq!(
        gauges.connection_handles.into_iter().collect::<Vec<_>>(),
        [handle(FIRST), handle(SECOND)],
        "both connections"
    );

    notifications.clean(&handle(FIRST));

    let gauges = notifications.gauges();

    assert_eq!(gauges.counts.get("notifiedSubscriptions"), Some(&1), "one");
    assert_eq!(
        gauges.connection_handles.into_iter().collect::<Vec<_>>(),
        [handle(SECOND)],
        "the one left"
    );
}

#[test]
fn paces_a_subscription_whose_request_asked_and_no_other() {
    let mut notifications = manager();

    registered(&mut notifications, ((10, 1), paced((1, FIRST))));
    registered(&mut notifications, ((10, 2), call((3, FIRST))));

    assert_eq!(
        notifications
            .pacing_of(1, &handle(FIRST))
            .map(|pacing| pacing.offer(one_byte())),
        Some(PacingOutcome::Send),
        "paced"
    );
    assert!(
        notifications.pacing_of(3, &handle(FIRST)).is_none(),
        "unpaced"
    );
    // another connection's call id, and one no connection holds
    assert!(
        notifications.pacing_of(1, &handle(SECOND)).is_none(),
        "another connection's"
    );
    assert!(
        notifications.pacing_of(7, &handle(FIRST)).is_none(),
        "none held"
    );
}

#[test]
fn lets_a_pacing_go_with_its_subscription_however_it_goes() {
    let mut notifications = manager();
    let paused_of = |notifications: &NotificationManager| {
        let counts = notifications.gauges().counts;

        (
            counts.get("pausedSubscriptions").copied(),
            counts.get("queuedNotifications").copied(),
        )
    };

    registered(&mut notifications, ((10, 1), paced((1, FIRST))));
    registered(&mut notifications, ((10, 2), paced((3, FIRST))));

    // each its first credit spent, and one queued: a pacing kept would queue what comes next
    for call_id in [1, 1, 3, 3] {
        if let Some(pacing) = notifications.pacing_of(call_id, &handle(FIRST)) {
            pacing.offer(one_byte());
        }
    }

    assert_eq!(paused_of(&notifications), (Some(2), Some(2)), "both paused");

    notifications.unregister(1, &handle(FIRST));

    assert!(
        notifications.pacing_of(1, &handle(FIRST)).is_none(),
        "gone with its subscription"
    );
    assert_eq!(paused_of(&notifications), (Some(1), Some(1)), "one left");

    notifications.clean(&handle(FIRST));

    assert!(
        notifications.pacing_of(3, &handle(FIRST)).is_none(),
        "gone with its connection"
    );
    assert_eq!(paused_of(&notifications), (Some(0), Some(0)), "none left");

    // registered again, it starts anew
    registered(&mut notifications, ((10, 1), paced((1, FIRST))));

    assert_eq!(
        notifications
            .pacing_of(1, &handle(FIRST))
            .map(|pacing| pacing.offer(one_byte())),
        Some(PacingOutcome::Send),
        "anew"
    );
}

#[test]
fn counts_what_paced_subscriptions_queue_all_together_and_the_fullest_at_their_limits() {
    let mut notifications = NotificationManager::new(PacingLimits {
        maximum_queued_notification_bytes: 100,
        maximum_queued_notifications: 5,
    });
    let empty = notifications.gauges();

    assert_eq!(
        empty.ceilings.into_iter().collect::<Vec<_>>(),
        [
            ("largestQueuedNotificationBytes", 100),
            ("largestQueuedNotifications", 5)
        ],
        "its limits"
    );
    assert_eq!(
        counts(&notifications),
        [
            ("largestQueuedNotificationBytes", 0),
            ("largestQueuedNotifications", 0),
            ("notifiedSubscriptions", 0),
            ("pausedSubscriptions", 0),
            ("queuedNotificationBytes", 0),
            ("queuedNotifications", 0),
        ],
        "nothing yet"
    );

    // each paced one's first credit spent at once
    for (call_id, connection) in [(1, FIRST), (3, FIRST), (5, SECOND)] {
        registered(
            &mut notifications,
            (
                (10, u16::try_from(call_id).expect("an id")),
                paced((call_id, connection)),
            ),
        );

        if let Some(pacing) = notifications.pacing_of(call_id, &handle(connection)) {
            pacing.offer(one_byte());
        }
    }

    registered(&mut notifications, ((10, 7), call((7, FIRST))));
    registered(&mut notifications, ((10, 9), paced((9, FIRST))));

    for (call_id, connection, sizes) in [
        (1, FIRST, &[10_usize, 20][..]),
        (3, FIRST, &[40]),
        (5, SECOND, &[5, 5, 5]),
    ] {
        for &size in sizes {
            if let Some(pacing) = notifications.pacing_of(call_id, &handle(connection)) {
                pacing.offer(sized(size));
            }
        }
    }

    assert_eq!(
        counts(&notifications),
        [
            ("largestQueuedNotificationBytes", 40),
            ("largestQueuedNotifications", 3),
            ("notifiedSubscriptions", 5),
            // the fourth paced one still has its first credit
            ("pausedSubscriptions", 3),
            ("queuedNotificationBytes", 85),
            ("queuedNotifications", 6),
        ],
        "all together and the fullest"
    );

    if let Some(pacing) = notifications.pacing_of(5, &handle(SECOND)) {
        pacing.credit(10);
    }

    assert_eq!(
        counts(&notifications),
        [
            ("largestQueuedNotificationBytes", 40),
            ("largestQueuedNotifications", 2),
            ("notifiedSubscriptions", 5),
            ("pausedSubscriptions", 2),
            ("queuedNotificationBytes", 70),
            ("queuedNotifications", 3),
        ],
        "what a credit let go no longer counted"
    );
}

#[test]
fn queues_at_the_defaults_when_its_options_say_nothing_and_refuses_a_limit_that_is_none() {
    assert_eq!(
        manager().gauges().ceilings.into_iter().collect::<Vec<_>>(),
        [
            (
                "largestQueuedNotificationBytes",
                PACING_DEFAULTS.maximum_queued_notification_bytes
            ),
            (
                "largestQueuedNotifications",
                PACING_DEFAULTS.maximum_queued_notifications
            ),
        ],
        "the defaults"
    );
    assert!(
        pacing_limits_of(&PacingLimitsOptions {
            maximum_queued_notifications: Some(0),
            ..PacingLimitsOptions::default()
        })
        .is_err(),
        "a limit that is none refused"
    );
}

#[test]
fn queues_a_paced_subscription_up_to_the_limits_it_was_built_with() {
    let mut notifications = NotificationManager::new(
        pacing_limits_of(&PacingLimitsOptions {
            maximum_queued_notifications: Some(1),
            ..PacingLimitsOptions::default()
        })
        .expect("its limits"),
    );

    registered(&mut notifications, ((10, 1), paced((1, FIRST))));

    let outcomes: Vec<PacingOutcome> = (0..3)
        .filter_map(|_| {
            notifications
                .pacing_of(1, &handle(FIRST))
                .map(|pacing| pacing.offer(one_byte()))
        })
        .collect();

    assert_eq!(
        outcomes,
        [
            PacingOutcome::Send,
            PacingOutcome::Queued,
            PacingOutcome::Exceeded
        ],
        "up to its limits"
    );
}

#[test]
fn queue_64_notifications_and_1_mib_at_most_by_default() {
    assert_eq!(
        PACING_DEFAULTS,
        PacingLimits {
            maximum_queued_notification_bytes: 1_048_576,
            maximum_queued_notifications: 64,
        },
        "64 and 1 MiB"
    );
    assert_eq!(
        pacing_limits_of(&PacingLimitsOptions::default()),
        Ok(PACING_DEFAULTS),
        "the defaults when none is given"
    );

    // past its first credit, a pacing at the defaults queues 64 and no more
    let mut pacing = Pacing::new(PACING_DEFAULTS);

    assert_eq!(pacing.offer(word("sent")), PacingOutcome::Send, "sent");

    for _ in 0..64 {
        assert_eq!(pacing.offer(one_byte()), PacingOutcome::Queued, "queued");
    }

    assert_eq!(pacing.offer(one_byte()), PacingOutcome::Exceeded, "past 64");
}

#[test]
fn take_each_limit_given_over_the_default_one_left_out_keeping_it() {
    assert_eq!(
        pacing_limits_of(&PacingLimitsOptions {
            maximum_queued_notifications: Some(1),
            ..PacingLimitsOptions::default()
        }),
        Ok(PacingLimits {
            maximum_queued_notification_bytes: 1_048_576,
            maximum_queued_notifications: 1,
        }),
        "the bytes kept"
    );
    assert_eq!(
        pacing_limits_of(&PacingLimitsOptions {
            maximum_queued_notification_bytes: Some(9_007_199_254_740_991),
            ..PacingLimitsOptions::default()
        }),
        Ok(PacingLimits {
            maximum_queued_notification_bytes: 9_007_199_254_740_991,
            maximum_queued_notifications: 64,
        }),
        "the count kept"
    );
}

// a platform's shape: a u64 holds no number under 0 nor a fraction, so 0 is the one value refused
#[test]
fn refuse_a_limit_that_is_not_a_whole_number_above_0_naming_it() {
    for (options, name) in [
        (
            PacingLimitsOptions {
                maximum_queued_notifications: Some(0),
                ..PacingLimitsOptions::default()
            },
            "maximumQueuedNotifications",
        ),
        (
            PacingLimitsOptions {
                maximum_queued_notification_bytes: Some(0),
                ..PacingLimitsOptions::default()
            },
            "maximumQueuedNotificationBytes",
        ),
    ] {
        assert_eq!(
            pacing_limits_of(&options).map_err(|refused| refused.to_string()),
            Err(format!("{name} is a whole number above 0, not 0")),
            "refused, naming it"
        );
    }
}

#[test]
fn sends_the_first_notification_credited_by_asking_and_queues_the_next() {
    let mut pacing = Pacing::new(LIMITS);

    assert!(!pacing.is_paused(), "credited by asking");
    assert_eq!(pacing.offer(word("first")), PacingOutcome::Send, "sent");
    assert!(pacing.is_paused(), "its credit spent");
    assert_eq!(
        pacing.offer(word("second")),
        PacingOutcome::Queued,
        "queued"
    );
    assert_eq!(pacing.queued_notifications(), 1, "one queued");
    assert_eq!(pacing.queued_notification_bytes(), 6, "its bytes");
}

#[test]
fn lets_go_in_order_what_a_credit_reaches_and_sends_at_once_while_credit_is_left() {
    let mut pacing = Pacing::new(LIMITS);

    pacing.offer(word("a"));

    for text in ["b", "c", "d"] {
        pacing.offer(word(text));
    }

    // counted from the first: 3 sent at most, so 2 of the 3 queued
    assert_eq!(words(&pacing.credit(3)), ["b", "c"], "in order");
    assert_eq!(pacing.queued_notifications(), 1, "one left");
    assert!(pacing.is_paused(), "paused");
    assert_eq!(words(&pacing.credit(6)), ["d"], "the last");
    assert!(!pacing.is_paused(), "credit left");
    assert_eq!(pacing.queued_notification_bytes(), 0, "none queued");
    assert_eq!(pacing.offer(word("e")), PacingOutcome::Send, "at once");
    assert_eq!(pacing.offer(word("f")), PacingOutcome::Send, "at once");
    assert_eq!(pacing.offer(word("g")), PacingOutcome::Queued, "past it");
}

#[test]
fn grants_nothing_for_a_credit_at_or_below_the_one_it_has() {
    let mut pacing = Pacing::new(LIMITS);

    pacing.offer(word("a"));
    pacing.offer(word("b"));

    assert!(pacing.credit(1).is_empty(), "the one it has");
    assert!(pacing.credit(0).is_empty(), "below it");
    assert_eq!(words(&pacing.credit(2)), ["b"], "above it");
    // a credit that came late, below the one granted since
    assert!(pacing.credit(1).is_empty(), "late");
    assert_eq!(pacing.offer(word("c")), PacingOutcome::Queued, "no credit");
}

#[test]
fn keeps_the_credit_it_has_when_one_below_it_comes_late_with_credit_left() {
    let mut pacing = Pacing::new(LIMITS);

    pacing.offer(word("a"));
    pacing.credit(4);
    pacing.credit(2);

    assert_eq!(
        [
            pacing.offer(word("b")),
            pacing.offer(word("c")),
            pacing.offer(word("d")),
            pacing.offer(word("e")),
        ],
        [
            PacingOutcome::Send,
            PacingOutcome::Send,
            PacingOutcome::Send,
            PacingOutcome::Queued,
        ],
        "its credit of 4 kept"
    );
}

#[test]
fn keeps_the_latest_of_a_key_in_the_place_of_the_first_and_every_notification_without_one() {
    let mut pacing = Pacing::new(LIMITS);

    pacing.offer(keyed((NotificationKey::Number(7), "sent")));
    pacing.offer(keyed((NotificationKey::Number(7), "7 a")));
    pacing.offer(word("event 1"));
    pacing.offer(keyed((NotificationKey::Text("nine".to_owned()), "9 a")));
    pacing.offer(word("event 2"));
    pacing.offer(keyed((NotificationKey::Number(7), "7 b")));
    // a number and a string are two keys
    pacing.offer(keyed((NotificationKey::Text("7".to_owned()), "\"7\"")));

    assert_eq!(pacing.queued_notifications(), 5, "five places");
    assert_eq!(
        words(&pacing.credit(100)),
        ["7 b", "event 1", "9 a", "event 2", "\"7\""],
        "the latest of a key in the first's place"
    );
}

#[test]
fn counts_the_bytes_of_what_replaces_not_of_what_it_replaced() {
    let mut pacing = Pacing::new(LIMITS);

    pacing.offer(word("sent"));
    pacing.offer((Some(NotificationKey::Number(1)), Bytes::from(vec![0; 10])));
    pacing.offer((Some(NotificationKey::Number(1)), Bytes::from(vec![0; 4])));
    pacing.offer(sized(3));

    assert_eq!(pacing.queued_notification_bytes(), 7, "4 and 3");

    pacing.credit(2);

    assert_eq!(pacing.queued_notification_bytes(), 3, "3 left");
}

#[test]
fn says_a_queue_went_past_its_count_but_not_a_key_that_only_replaces() {
    let mut pacing = Pacing::new(PacingLimits {
        maximum_queued_notifications: 2,
        ..LIMITS
    });

    pacing.offer(word("sent"));

    assert_eq!(
        pacing.offer(keyed((NotificationKey::Number(1), "a"))),
        PacingOutcome::Queued,
        "one"
    );
    assert_eq!(
        pacing.offer(keyed((NotificationKey::Number(2), "b"))),
        PacingOutcome::Queued,
        "two"
    );
    assert_eq!(
        pacing.offer(keyed((NotificationKey::Number(1), "c"))),
        PacingOutcome::Queued,
        "replaced"
    );
    assert_eq!(pacing.offer(word("d")), PacingOutcome::Exceeded, "three");
    assert_eq!(pacing.queued_notifications(), 3, "three queued");
}

#[test]
fn says_a_queue_went_past_its_bytes_a_replacement_larger_than_what_it_replaced_too() {
    let mut pacing = Pacing::new(PacingLimits {
        maximum_queued_notification_bytes: 8,
        ..LIMITS
    });

    pacing.offer(word("sent"));

    assert_eq!(
        pacing.offer((Some(NotificationKey::Number(1)), Bytes::from(vec![0; 4]))),
        PacingOutcome::Queued,
        "4"
    );
    assert_eq!(
        pacing.offer((Some(NotificationKey::Number(2)), Bytes::from(vec![0; 4]))),
        PacingOutcome::Queued,
        "8"
    );
    assert_eq!(
        pacing.offer((Some(NotificationKey::Number(2)), Bytes::from(vec![0; 5]))),
        PacingOutcome::Exceeded,
        "9"
    );
    assert_eq!(pacing.queued_notification_bytes(), 9, "9 queued");
}

#[test]
fn says_a_notification_larger_than_its_bytes_went_past_them_alone() {
    let mut pacing = Pacing::new(PacingLimits {
        maximum_queued_notification_bytes: 8,
        ..LIMITS
    });

    pacing.offer(word("sent"));

    assert_eq!(pacing.offer(sized(9)), PacingOutcome::Exceeded, "alone");
}
