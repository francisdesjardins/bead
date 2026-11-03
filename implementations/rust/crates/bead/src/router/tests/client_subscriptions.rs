//! A client's notification registrations and the calls they bind, cancel and reserve.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::client::Notified;
use super::{
    Scripted, TIMEOUT, answered, failure_of, locked, notification_of, request_of, result_of,
};
use crate::UnregisterNotificationOptions;
use crate::constants::{EnvelopeKind, ProtocolCode};
use crate::duration::NEVER;
use crate::envelope::Envelope;
use crate::errors::CallError;
use crate::router::types::RouterActivity;
use crate::testing::surface::Consumer;

async fn subscribed(scripted: &Scripted, (notification, call_id): (&Arc<Notified>, u32)) {
    let subscribing = scripted.subscribe((&notification.like(), TIMEOUT)).await;
    scripted.transport.deliver(&result_of(call_id, None));
    answered(subscribing).await.expect("subscribed");
}

#[tokio::test]
async fn triggers_the_notification_whose_subscription_opened_their_call_one_ahead_of_its_result_included()
 {
    let scripted = Scripted::new();
    let notification = Notified::new(None);
    let activity = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&activity);
    scripted.router.on_activity(Arc::new(move |what| {
        locked(&hearing).push(what);
    }));
    scripted
        .router
        .register_notification(notification.like())
        .expect("registered");
    assert!(scripted.router.has_notification(&notification.like()));
    assert!(
        !scripted
            .router
            .has_notification(&Notified::new(None).like())
    );
    let subscribing = scripted.subscribe((&notification.like(), TIMEOUT)).await;
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.transport.deliver(&result_of(1, None));
    answered(subscribing).await.expect("subscribed");
    scripted.transport.deliver(&notification_of(1, 6));
    scripted.settle().await;
    assert_eq!(notification.triggered(), [5, 6]);
    assert_eq!(
        *locked(&activity),
        [
            RouterActivity::Request,
            RouterActivity::Notification,
            RouterActivity::Response,
            RouterActivity::Notification
        ]
    );
    scripted
        .router
        .unregister_notification(
            &notification.like(),
            &UnregisterNotificationOptions::default(),
        )
        .await;
    assert!(!scripted.router.has_notification(&notification.like()));
}

#[tokio::test]
async fn a_request_that_subscribes_says_it_opens_a_subscription_and_an_ordinary_one_does_not() {
    let scripted = Scripted::new();
    let notification = Notified::new(None);
    let subscribing = scripted.subscribe((&notification.like(), TIMEOUT)).await;
    let ordinary = scripted
        .router
        .request(Bytes::new(), request_of((None, TIMEOUT)))
        .expect("an ordinary request");
    scripted.settle().await;
    scripted.transport.deliver(&result_of(1, None));
    scripted.transport.deliver(&result_of(3, None));
    answered(subscribing).await.expect("subscribed");
    answered(ordinary).await.expect("answered");
    assert_eq!(
        scripted
            .transport
            .envelopes()
            .iter()
            .map(|envelope| {
                let Envelope::Request { header, .. } = envelope else {
                    panic!("a request")
                };
                header.opens_subscription
            })
            .collect::<Vec<_>>(),
        [true, false]
    );
}

#[tokio::test]
async fn an_ordinary_request_to_the_procedure_never_moves_the_subscription() {
    let scripted = Scripted::new();
    let notification = Notified::new(None);
    subscribed(&scripted, (&notification, 1)).await;
    let ordinary = scripted
        .router
        .request(Bytes::new(), request_of((None, TIMEOUT)))
        .expect("an ordinary request");
    scripted.settle().await;
    scripted.transport.deliver(&result_of(3, None));
    answered(ordinary).await.expect("answered");
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.settle().await;
    assert_eq!(notification.triggered(), [5]);
    assert_eq!(scripted.codes(), Vec::<String>::new());
}

#[tokio::test]
async fn a_subscription_refused_lets_go_of_its_call_id_one_that_times_out_is_cancelled_its_call_id_reserved_a_while()
 {
    let scripted = Scripted::new();
    let notification = Notified::new(None);
    let refused = scripted.subscribe((&notification.like(), TIMEOUT)).await;
    scripted
        .transport
        .deliver(&failure_of(1, (ProtocolCode::ACCESS_DENIED, None)));
    assert!(
        matches!(answered(refused).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::ACCESS_DENIED.get())
    );
    assert!(!scripted.router.is_reserved(1).await);
    let timeout = Duration::from_millis(10);
    let failing = scripted.subscribe((&notification.like(), timeout)).await;
    assert_eq!(scripted.clock.dues(), [timeout]);
    scripted.clock.advance(timeout).await;
    assert!(matches!(answered(failing).await, Err(CallError::TimedOut(given)) if given == timeout));
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.transport.deliver(&notification_of(3, 5));
    scripted.settle().await;
    assert_eq!(notification.triggered(), Vec::<u8>::new());
    assert_eq!(scripted.codes(), ["SUBSCRIPTION_UNKNOWN"]);
    assert_eq!(
        scripted.transport.calls(),
        [
            (EnvelopeKind::Request, 1),
            (EnvelopeKind::Request, 3),
            (EnvelopeKind::Cancel, 3)
        ]
    );
    assert_eq!(scripted.clock.dues(), [timeout]);
    assert!(scripted.router.is_reserved(3).await);
    scripted.clock.advance(timeout).await;
    scripted.transport.deliver(&notification_of(3, 5));
    scripted.settle().await;
    assert_eq!(
        scripted.codes(),
        ["SUBSCRIPTION_UNKNOWN", "SUBSCRIPTION_UNKNOWN"]
    );
}

#[tokio::test]
async fn a_subscription_that_waits_without_end_let_go_of_is_cancelled_and_its_call_id_reserved_5_s_or_until_the_connection_closes()
 {
    let scripted = Scripted::new();
    let notification = Notified::new(None);
    let subscribing = scripted.subscribe((&notification.like(), NEVER)).await;
    scripted.transport.deliver(&result_of(1, None));
    answered(subscribing).await.expect("subscribed");
    scripted
        .router
        .unregister_notification(
            &notification.like(),
            &UnregisterNotificationOptions::default(),
        )
        .await;
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.settle().await;
    assert_eq!(scripted.clock.dues(), [Duration::from_secs(5)]);
    assert_eq!(scripted.codes(), Vec::<String>::new());
    scripted.transport.close_connection();
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.settle().await;
    assert_eq!(scripted.codes(), ["SUBSCRIPTION_UNKNOWN"]);
    assert_eq!(
        scripted.transport.calls(),
        [(EnvelopeKind::Request, 1), (EnvelopeKind::Cancel, 1)]
    );
    assert_eq!(scripted.clock.dues(), Vec::<Duration>::new());
}

#[tokio::test]
async fn a_notification_let_go_of_is_cancelled_unless_its_subscription_was_taken_away_already_and_only_when_bound()
 {
    let scripted = Scripted::new();
    let notification = Notified::new(None);
    subscribed(&scripted, (&notification, 1)).await;
    scripted
        .router
        .unregister_notification(
            &notification.like(),
            &UnregisterNotificationOptions::default(),
        )
        .await;
    subscribed(&scripted, (&notification, 3)).await;
    scripted
        .router
        .unregister_notification(
            &notification.like(),
            &UnregisterNotificationOptions {
                cancel: Some(false),
            },
        )
        .await;
    scripted
        .router
        .register_notification(notification.like())
        .expect("registered without a call");
    scripted
        .router
        .unregister_notification(
            &notification.like(),
            &UnregisterNotificationOptions::default(),
        )
        .await;
    scripted
        .router
        .unregister_notification(
            &Notified::new(None).like(),
            &UnregisterNotificationOptions::default(),
        )
        .await;
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.transport.deliver(&notification_of(3, 5));
    scripted.settle().await;
    assert_eq!(
        scripted.transport.calls(),
        [
            (EnvelopeKind::Request, 1),
            (EnvelopeKind::Cancel, 1),
            (EnvelopeKind::Request, 3)
        ]
    );
    assert_eq!(scripted.codes(), Vec::<String>::new());
}

#[tokio::test]
async fn takes_away_only_the_notification_that_asks_not_another_of_its_procedure() {
    let scripted = Scripted::new();
    let held = Notified::new(None);
    subscribed(&scripted, (&held, 1)).await;
    scripted
        .router
        .unregister_notification(
            &Notified::new(None).like(),
            &UnregisterNotificationOptions::default(),
        )
        .await;
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.settle().await;
    assert!(scripted.router.has_notification(&held.like()));
    assert_eq!(held.triggered(), [5]);
}

#[tokio::test]
async fn refuses_a_second_notification_for_one_procedure() {
    let scripted = Scripted::new();
    scripted
        .router
        .register_notification(Notified::new(None).like())
        .expect("one notification");
    scripted
        .router
        .register_notification(Notified::new(None).like())
        .expect_err("a second notification for the procedure");
    scripted.settle().await;
    assert_eq!(scripted.transport.sent().len(), 0);
}

#[test]
fn cannot_notify_nor_subscribe_a_connection_only_a_server_does() {
    let consumer = Consumer::new();
    consumer.accepts("pub fn check() { let _register = bead::RouterClient::register_notification; let _unregister = bead::RouterClient::unregister_notification; }");
    for method in ["notify", "subscribe"] {
        consumer.refuses(
            &format!("pub fn check(router: &bead::RouterClient) {{ router.{method}(); }}"),
            ("E0599", "no method named"),
        );
    }
}
