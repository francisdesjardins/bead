//! What a client's router traces and counts: each envelope out and in, a debug listener that
//! panics, the calls it refuses before they go, cancels and cannot hand over, the notifications it
//! hears and the subscriptions it drops, and a call's duration on a coarse clock.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::{
    Scripted, client::Notified, codes_of, failure_of, locked, notification_of, request_header_of,
    request_of, result_of, token,
};
use crate::clock::{Clock, Schedule, SharedClock, Timer, TimerCallback};
use crate::constants::{CredentialScheme, ProcedureKind, ProtocolCode, SERVER_CONNECTION_HANDLE};
use crate::debug::{DebugDirection, TracedEnvelope};
use crate::envelope::{Credential, Header, ResultHeader};
use crate::errors::CallError;
use crate::identity::Procedure;
use crate::metrics::{MetricsRegistry, MetricsRegistryOptions};
use crate::router::client::{ClientRequest, RouterClientOptions};
use crate::router::server::{Call, CallHooks};
use crate::router::types::RequestCredential;
use crate::testing::SteppingClock;
use crate::testing::pair::echo;
use crate::testing::scripted::Sending;

// echo's labels among the calls a client makes, requests
const LABELS: &str = "service=\"2\",procedure=\"echo\",type=\"request\"";

// a line of echo's series among the calls a client makes, by the rest of its name, its labels and
// its value
fn made_of(rest: &str) -> String {
    format!(
        "bead_client_call_{}",
        rest.replace("{}", &format!("{{{LABELS}}}"))
            .replace("{outcome", &format!("{{{LABELS},outcome"))
    )
}

/// The lines of a registry's exposition that count something: no comment, no zero, no sum, and of
/// the buckets only the first.
pub(super) fn counts_of(registry: &MetricsRegistry) -> Vec<String> {
    registry
        .exposition()
        .text
        .split('\n')
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with('#')
                && !line.ends_with(" 0")
                && !line.contains("_sum{")
                && (!line.contains("_bucket{") || line.contains("le=\"0.0\""))
        })
        .map(str::to_owned)
        .collect()
}

// echo's handled and started counts, and its duration's _count, in order
fn echo_counts_of(registry: &MetricsRegistry) -> Vec<String> {
    let mut lines: Vec<String> = counts_of(registry)
        .into_iter()
        .filter(|line| line.contains("procedure=\"echo\"") && !line.contains("_bucket{"))
        .collect();

    lines.sort();
    lines
}

fn registry() -> MetricsRegistry {
    MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry")
}

fn counted(registry: &MetricsRegistry) -> Scripted {
    let options = RouterClientOptions {
        metrics_registry: Some(registry.clone()),
        ..RouterClientOptions::default()
    };

    Scripted::with(&options)
}

// a call to echo counted into its requester's series
fn call_of(
    scripted: &Scripted,
    request: ClientRequest,
) -> Result<Call, crate::errors::ProgrammerError> {
    let series = scripted
        .router
        .declare_requester(&echo())
        .expect("echo declared");

    scripted.router.request(
        Bytes::new(),
        (ClientRequest { series, ..request }, CallHooks::default()),
    )
}

// debugging 1.1, 5.1
#[tokio::test]
async fn tells_each_envelope_out_and_in_with_its_connection_server_its_header_and_never_its_session_token()
 {
    let scripted = Scripted::new();
    let seen: Arc<Mutex<Vec<(DebugDirection, TracedEnvelope)>>> = Arc::default();
    let hearing = Arc::clone(&seen);

    scripted.router.on_debug(Arc::new(
        move |direction: DebugDirection, traced: &TracedEnvelope| {
            locked(&hearing).push((direction, traced.clone()));
        },
    ));

    let answering = scripted
        .router
        .request(
            Bytes::new(),
            (request_of((None, super::TIMEOUT)), CallHooks::default()),
        )
        .expect("echo called");

    scripted.settle().await;
    scripted
        .transport
        .deliver(&result_of(1, Some(Credential::Opaque(token()))));

    let answered = super::answered(answering).await.expect("echo answered");

    assert_eq!(answered.header.call_id, 1, "its call id");

    scripted.settle().await;

    // on its one connection, the server, the session announced traced by its scheme alone
    let server: crate::router::types::ConnectionHandle = Arc::from(SERVER_CONNECTION_HANDLE);

    assert_eq!(
        *locked(&seen),
        [
            (
                DebugDirection::Tx,
                TracedEnvelope {
                    connection_handle: Arc::clone(&server),
                    header: Header::Request(request_header_of(1)),
                    credential_scheme: None,
                }
            ),
            (
                DebugDirection::Rx,
                TracedEnvelope {
                    connection_handle: server,
                    header: Header::Result(ResultHeader {
                        call_id: 1,
                        total: None,
                        credential: None,
                    }),
                    credential_scheme: Some(CredentialScheme::OPAQUE),
                }
            ),
        ],
        "each envelope, with its connection and its header"
    );
}

// debugging 2.2, 2.3
#[tokio::test]
async fn a_debug_listener_that_throws_on_an_envelope_is_reported_and_the_envelope_and_its_call_go_on_every_listener_told()
 {
    let scripted = Scripted::new();
    let told: Arc<Mutex<Vec<DebugDirection>>> = Arc::default();
    let hearing = Arc::clone(&told);

    scripted.router.on_debug(Arc::new(
        |_direction: DebugDirection, _traced: &TracedEnvelope| {
            panic!("listener bug");
        },
    ));
    scripted.router.on_debug(Arc::new(
        move |direction: DebugDirection, _traced: &TracedEnvelope| {
            locked(&hearing).push(direction);
        },
    ));

    let answering = scripted
        .router
        .request(
            Bytes::new(),
            (request_of((None, super::TIMEOUT)), CallHooks::default()),
        )
        .expect("echo called");

    scripted.settle().await;
    scripted.transport.deliver(&result_of(1, None));

    let answered = super::answered(answering).await.expect("echo answered");

    assert_eq!(answered.header.call_id, 1, "its call goes on");

    scripted.settle().await;

    assert_eq!(scripted.transport.sent().len(), 1, "its envelope goes on");
    assert_eq!(
        *locked(&told),
        [DebugDirection::Tx, DebugDirection::Rx],
        "every listener told"
    );

    let codes = scripted.codes();

    assert_eq!(codes.len(), 2, "each panic reported: {codes:?}");
    assert!(
        codes.iter().all(|code| code.contains("listener bug")),
        "reported as it panicked: {codes:?}"
    );
}

// debugging 9.3, 9.6.1, 9.6.2
#[tokio::test]
async fn counts_a_call_refused_before_it_goes_session_required_or_destination_unreachable_as_started_and_ended_in_the_turn_it_started_and_a_programmer_s_error_or_an_aborted_signal_as_nothing()
 {
    let registry = registry();
    let scripted = counted(&registry);
    let asked = |credential: RequestCredential| {
        let mut request = request_of((None, super::TIMEOUT));

        request.options.credential = Some(credential);

        call_of(&scripted, request).expect("a call")
    };

    scripted.transport.carry(false);

    // OPAQUE with no session known, and an ELSEWHERE its transport cannot carry, both queued on its
    // owner, then a read right behind them: what each did in its own turn is counted by then
    let no_session = asked(RequestCredential::Opaque);
    let uncarried = asked(RequestCredential::Elsewhere("x".to_owned()));
    let reading = registry.clone();
    let in_their_turns = scripted
        .router
        .owner()
        .run(move |_state| echo_counts_of(&reading))
        .await
        .expect("read on its owner");

    assert_eq!(
        in_their_turns,
        [
            made_of("duration_seconds_count{} 2"),
            made_of("handled_total{outcome=\"failure\",code=\"DESTINATION_UNREACHABLE\"} 1"),
            made_of("handled_total{outcome=\"failure\",code=\"SESSION_REQUIRED\"} 1"),
            made_of("started_total{} 2"),
        ],
        "started and ended in the turn each started"
    );

    let codes: Vec<Option<u16>> = [
        super::answered(no_session).await,
        super::answered(uncarried).await,
    ]
    .iter()
    .map(|outcome| match outcome {
        Err(CallError::Failure(failure)) => Some(failure.code().get()),
        Ok(_)
        | Err(
            CallError::Cancelled
            | CallError::Disconnected(_)
            | CallError::TimedOut(_)
            | CallError::Refused(_)
            | CallError::Other(_),
        ) => None,
    })
    .collect();

    assert_eq!(
        codes,
        [
            Some(ProtocolCode::SESSION_REQUIRED.get().get()),
            Some(ProtocolCode::DESTINATION_UNREACHABLE.get().get())
        ],
        "each refused by its code"
    );

    // a programmer's error, and a signal aborted already: neither is a call
    let stray = Notified::new(None);
    let aborted = CancellationToken::new();

    aborted.cancel();

    assert!(
        call_of(&scripted, request_of((Some(stray.like()), super::TIMEOUT))).is_err(),
        "a notification it does not hold refused"
    );

    // an ELSEWHERE that gives nothing to carry and a scheme to come: no RequestCredential holds
    // either
    let mut request = request_of((None, super::TIMEOUT));

    request.options.credential = Some(RequestCredential::Jwt(String::new()));

    assert!(
        call_of(&scripted, request).is_err(),
        "a JWT of no token refused"
    );

    let mut cancelled = request_of((None, super::TIMEOUT));

    cancelled.options.signal = Some(aborted);

    let cancelled = call_of(&scripted, cancelled).expect("a call aborted already");

    assert!(
        matches!(super::answered(cancelled).await, Err(CallError::Cancelled)),
        "an aborted signal cancels it"
    );
    scripted.settle().await;

    assert!(
        echo_counts_of(&registry).contains(&made_of("started_total{} 2")),
        "nothing more started: {:?}",
        echo_counts_of(&registry)
    );
}

// debugging 9.3
#[tokio::test]
async fn counts_a_call_that_would_present_a_withdrawn_default_as_started_and_ended_in_the_turn_it_started_session_required()
 {
    let registry = registry();
    let options = RouterClientOptions {
        metrics_registry: Some(registry.clone()),
        credential: Some(RequestCredential::Jwt("a.b.c".to_owned())),
        ..RouterClientOptions::default()
    };

    let scripted = Scripted::with(&options);
    let refused = call_of(&scripted, request_of((None, super::TIMEOUT))).expect("a call");

    scripted.settle().await;
    scripted
        .transport
        .deliver(&failure_of(1, (ProtocolCode::SESSION_REQUIRED, None)));

    assert!(
        matches!(super::answered(refused).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::SESSION_REQUIRED.get()),
        "refused SESSION_REQUIRED"
    );

    let withdrawn = call_of(&scripted, request_of((None, super::TIMEOUT))).expect("a call");
    let withdrawn = super::answered(withdrawn).await;

    assert!(
        matches!(&withdrawn, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::SESSION_REQUIRED.get() && failure.detail() == "the default credential was withdrawn"),
        "refused before it goes: {withdrawn:?}"
    );
    assert_eq!(
        echo_counts_of(&registry),
        [
            made_of("duration_seconds_count{} 2"),
            made_of("handled_total{outcome=\"failure\",code=\"SESSION_REQUIRED\"} 2"),
            made_of("started_total{} 2"),
        ],
        "both counted"
    );
    assert_eq!(scripted.transport.sent().len(), 1, "the second never went");
}

// debugging 9.6.12
#[tokio::test]
async fn counts_a_call_its_caller_cancels_as_cancelled_and_one_its_transport_refuses_as_an_error() {
    let registry = registry();
    let scripted = counted(&registry);
    let cancelling = CancellationToken::new();
    let mut request = request_of((None, super::TIMEOUT));

    request.options.signal = Some(cancelling.clone());

    let cancelled = call_of(&scripted, request).expect("a call");

    scripted.settle().await;
    cancelling.cancel();

    assert!(
        matches!(super::answered(cancelled).await, Err(CallError::Cancelled)),
        "cancelled by its caller"
    );

    scripted
        .transport
        .send_as(Sending::Thrown("this transport refuses".to_owned()));

    let refused = call_of(&scripted, request_of((None, super::TIMEOUT))).expect("a call");
    let refused = super::answered(refused).await;

    assert!(
        matches!(&refused, Err(CallError::Other(error)) if error.to_string() == "this transport refuses"),
        "its transport's error: {refused:?}"
    );
    scripted.settle().await;

    assert_eq!(
        echo_counts_of(&registry),
        [
            made_of("duration_seconds_count{} 2"),
            made_of("handled_total{outcome=\"cancelled\"} 1"),
            made_of("handled_total{outcome=\"error\"} 1"),
            made_of("started_total{} 2"),
        ],
        "one cancelled, one an error"
    );
}

// debugging 9.1.6, 10.2, 10.3.3
#[tokio::test]
async fn counts_a_notification_heard_under_a_subscription_it_holds_and_a_subscription_dropped_at_this_end_by_the_failure_that_ends_it_or_with_its_connection_never_by_its_own_cancel()
 {
    let registry = registry();
    let scripted = counted(&registry);
    let notification = Notified::new(None);
    let other = Notified::of(Procedure {
        id: 2,
        name: "other".to_owned(),
        kind: Some(ProcedureKind::Notifies),
        ..echo()
    });

    // answered, its subscription hears a notification; one under no subscription is reported
    let subscribing = scripted
        .subscribe((&notification.like(), super::TIMEOUT))
        .await;

    scripted.transport.deliver(&result_of(1, None));
    super::answered(subscribing).await.expect("subscribed");
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.transport.deliver(&notification_of(9, 5));
    scripted.settle().await;

    // a failure on its call id once answered drops it, by its code
    scripted
        .transport
        .deliver(&failure_of(1, (ProtocolCode::CAPACITY_EXCEEDED, None)));
    scripted.settle().await;

    // subscribed again, its own cancel drops nothing
    let again = scripted
        .subscribe((&notification.like(), super::TIMEOUT))
        .await;

    scripted.transport.deliver(&result_of(3, None));
    super::answered(again).await.expect("subscribed again");
    scripted
        .router
        .unregister_notification((&notification.like(), true))
        .await;

    // and again, a close drops it with no code; a subscription not yet answered, none
    let last = scripted
        .subscribe((&notification.like(), super::TIMEOUT))
        .await;

    scripted.transport.deliver(&result_of(5, None));
    super::answered(last)
        .await
        .expect("subscribed a third time");

    let _unanswered = scripted.subscribe((&other.like(), super::TIMEOUT)).await;

    scripted.transport.close_connection();
    scripted.settle().await;

    assert_eq!(
        codes_of(&locked(&scripted.errors)),
        ["SUBSCRIPTION_UNKNOWN"],
        "the stray reported"
    );
    assert_eq!(
        counts_of(&registry)
            .into_iter()
            .filter(|line| line.starts_with("bead_notifications_")
                || line.starts_with("bead_subscriptions_"))
            .collect::<Vec<_>>(),
        [
            "bead_notifications_heard_total{service=\"2\",procedure=\"echo\"} 1",
            "bead_subscriptions_dropped_total{service=\"2\",procedure=\"echo\"} 1",
            "bead_subscriptions_dropped_total{service=\"2\",procedure=\"echo\",code=\"CAPACITY_EXCEEDED\"} 1",
        ],
        "one heard, two dropped"
    );
}

// a clock whose monotonic reading moves by 100 µs, as a browser's does, over a finer one
#[derive(Debug)]
struct Coarse {
    fine: Arc<SteppingClock>,
}

impl Clock for Coarse {
    fn monotonic(&self) -> Duration {
        let fine = self.fine.monotonic().as_micros();

        let step = fine.checked_rem(100).unwrap_or_default();

        Duration::from_micros(u64::try_from(fine.saturating_sub(step)).unwrap_or(u64::MAX))
    }

    fn wall(&self) -> std::time::SystemTime {
        self.fine.wall()
    }

    fn arm(&self, schedule: Schedule, callback: TimerCallback) -> Arc<dyn Timer> {
        self.fine.arm(schedule, callback)
    }

    fn activity(&self) -> Option<Arc<crate::testing::Activity>> {
        self.fine.activity()
    }
}

// µs written us, an identifier being ASCII alone
// debugging 11.4
#[tokio::test]
async fn observes_a_call_on_a_clock_whose_monotonic_reading_moves_by_100_us_as_a_browser_s_does_as_0_or_100_us()
 {
    let registry = registry();
    let fine = SteppingClock::new(super::january_first());
    let coarse: SharedClock = Arc::new(Coarse {
        fine: Arc::clone(&fine),
    });
    let transport = crate::testing::scripted::ScriptedClient::new(Arc::clone(&coarse));
    let carried: Arc<dyn crate::transport::ClientTransport> =
        Arc::<crate::testing::scripted::ScriptedClient>::clone(&transport);
    let options = RouterClientOptions {
        metrics_registry: Some(registry.clone()),
        ..RouterClientOptions::default()
    };

    let router =
        crate::router::client::RouterClient::new(carried, &options).expect("a router built");
    let series = router.declare_requester(&echo()).expect("echo declared");

    // a call of 30 µs, from where the clock is now
    for (call_id, before) in [(1, 0), (3, 50)] {
        fine.advance(Duration::from_micros(before)).await;

        let answering = router
            .request(
                Bytes::new(),
                (
                    ClientRequest {
                        series: series.clone(),
                        ..request_of((None, super::TIMEOUT))
                    },
                    CallHooks::default(),
                ),
            )
            .expect("echo called");

        fine.settle().await;
        fine.advance(Duration::from_micros(30)).await;
        transport.deliver(&result_of(call_id, None));
        super::answered(answering).await.expect("echo answered");
        fine.settle().await;
    }

    let text = registry.exposition().text;
    let lines: Vec<&str> = text.split('\n').collect();

    assert_eq!(
        lines
            .iter()
            .filter(|line| line.starts_with("bead_client_call_")
                && line.contains("procedure=\"echo\"")
                && !line.contains("_bucket{")
                && !line.ends_with(" 0"))
            .copied()
            .collect::<Vec<_>>(),
        [
            made_of("duration_seconds_sum{} 0.0001"),
            made_of("duration_seconds_count{} 2"),
            made_of("handled_total{outcome=\"result\"} 2"),
            made_of("started_total{} 2"),
        ],
        "one of 0 µs and one of 100 µs"
    );

    // the bucket of 0 holds the first, and the bucket of 100 µs, 0.0001, both
    let bucket_of = |le: &str, count: u32| {
        format!("bead_client_call_duration_seconds_bucket{{{LABELS},le=\"{le}\"}} {count}")
    };

    assert_eq!(
        lines
            .iter()
            .filter(
                |line| line.starts_with("bead_client_call_duration_seconds_bucket{service=\"2\"")
            )
            .take(5)
            .map(|line| (*line).to_owned())
            .collect::<Vec<_>>(),
        [
            bucket_of("0.0", 1),
            bucket_of("1e-05", 1),
            bucket_of("5e-05", 1),
            bucket_of("0.0001", 2),
            bucket_of("0.0003", 2)
        ],
        "its buckets"
    );
}
