//! What the application's code a router calls within its turn panics (decision 0044): a hook's or
//! a transport's send's, its own call's throw, the router answering the next, as the other sides'
//! writers take a send that throws; and any other, the last resort, ending the router at once, each
//! call it waits on failed with that panic for its reason, no later call left stranded.

use core::fmt;
use core::sync::atomic::{AtomicBool, Ordering};
use core::time::Duration;
use std::sync::Arc;
use std::time::SystemTime;

use bytes::Bytes;

use super::server::{first, request_of};
use super::{Handed, Scripted, answer, keeping, locked, request_of as call_of, result_of};
use crate::clock::{Clock, Schedule, SharedClock, Timer, TimerCallback};
use crate::errors::CallError;
use crate::router::client::{RouterClient, RouterClientOptions};
use crate::router::server::CallHooks;
use crate::router::types::{RouterAnswer, RouterError};
use crate::testing::SteppingClock;
use crate::testing::pair::echo;
use crate::testing::scripted::{ScriptedClient, Sending};

// the words of a call's error, its kind first
fn said(outcome: &Result<crate::router::types::RouterResult, CallError>) -> String {
    match outcome {
        Ok(_) => "answered".to_owned(),
        Err(CallError::Other(error)) => format!("other: {error}"),
        Err(CallError::Disconnected(reason)) => format!("disconnected: {reason}"),
        Err(error) => format!("{error:?}"),
    }
}

// a call to echo, its hooks given
fn call_with(scripted: &Scripted, hooks: CallHooks) -> crate::router::server::Call {
    scripted
        .router
        .request(
            Bytes::from_static(b"hi"),
            (call_of((None, super::TIMEOUT)), hooks),
        )
        .expect("a call")
}

// decision 0044: a hook is the application's code its router calls within its turn; what it panics
// fails its own call, as a hook that throws rejects its call on the TypeScript side, and nothing
// of it goes out
#[tokio::test]
async fn a_hook_that_panics_fails_its_own_call_and_the_router_answers_the_next() {
    let scripted = Scripted::new();
    let broken = call_with(
        &scripted,
        CallHooks {
            on_call_id: Some(Box::new(|_call_id| {
                panic!("this hook breaks, on purpose");
            })),
            ..CallHooks::default()
        },
    );

    scripted.settle().await;

    assert_eq!(
        said(&super::answered(broken).await),
        "other: a hook panicked: this hook breaks, on purpose",
        "its own call failed with its panic"
    );
    assert!(
        scripted.transport.envelopes().is_empty(),
        "nothing of it went out"
    );

    let handed = call_with(
        &scripted,
        CallHooks {
            on_sent: Some(Box::new(|_is_sent| {
                panic!("this hook breaks too");
            })),
            ..CallHooks::default()
        },
    );

    scripted.settle().await;

    assert_eq!(
        said(&super::answered(handed).await),
        "other: a hook panicked: this hook breaks too",
        "a call whose hand-off hook panics fails alike"
    );

    let next = call_with(&scripted, CallHooks::default());

    scripted.settle().await;

    let (_, call_id) = *scripted.transport.calls().last().expect("the next sent");

    scripted.transport.deliver(&result_of(call_id, None));

    assert_eq!(
        said(&super::answered(next).await),
        "answered",
        "the router answers the next"
    );
    assert!(scripted.codes().is_empty(), "nothing reported");
}

// spec 15.1, decision 0044: a send that panics is the transport's throw, as the other sides'
// writers take one: undone, and its call failed with it
#[tokio::test]
async fn a_request_whose_send_panics_fails_as_its_transport_s_throw_would_and_the_router_answers_the_next()
 {
    for panicking in [
        Sending::Panicked("the transport breaks".to_owned()),
        Sending::PanickedLater("the transport breaks later".to_owned()),
    ] {
        let scripted = Scripted::new();
        let words = match &panicking {
            Sending::Panicked(words) | Sending::PanickedLater(words) => words.clone(),
            Sending::Taken | Sending::Thrown(_) | Sending::Rejected(_) => String::new(),
        };

        scripted.transport.send_as(panicking);

        let broken = call_with(&scripted, CallHooks::default());

        scripted.settle().await;

        assert_eq!(
            said(&super::answered(broken).await),
            format!("other: a transport panicked: {words}"),
            "its call failed with the panic its transport stands for"
        );

        scripted.transport.send_as(Sending::Taken);

        let next = call_with(&scripted, CallHooks::default());

        scripted.settle().await;

        let (_, call_id) = *scripted.transport.calls().last().expect("the next sent");

        scripted.transport.deliver(&result_of(call_id, None));

        assert_eq!(
            said(&super::answered(next).await),
            "answered",
            "the router answers the next"
        );
        assert!(
            scripted.codes().is_empty(),
            "its caller heard it alone: {:?}",
            scripted.codes()
        );
    }
}

// spec 9.0, 15.1: the twin of `free_the_call_of_an_answer_that_could_not_go_out_so_its_call_id_
// opens_again`, its transport panicking where that one's throws
#[tokio::test]
async fn an_answer_whose_send_panics_fails_as_its_transport_s_throw_would_and_its_call_id_opens_again()
 {
    let handed = Handed::default();
    let served = super::serving(crate::router::core::Handler {
        resolve: keeping((&handed, None)),
        admit: None,
        maximum_payload_bytes: None,
        forwards_credentials: false,
        notifies: false,
    });

    served
        .transport
        .deliver(&request_of((1, &echo(), "\u{1}")), &first());
    served.settle().await;
    served.transport.send_as((
        &first(),
        Sending::Panicked("the transport breaks".to_owned()),
    ));

    let answerer = Arc::clone(&locked(&handed)[0].answerer);
    let refused = answerer
        .respond(RouterAnswer::Result(Bytes::from_static(&[1])))
        .await;

    assert!(
        matches!(&refused, Err(CallError::Other(error))
            if error.to_string() == "a transport panicked: the transport breaks"),
        "the transport's panic reaches the answerer: {refused:?}"
    );

    served.transport.send_as((&first(), Sending::Taken));
    served
        .transport
        .deliver(&request_of((1, &echo(), "\u{2}")), &first());
    served.settle().await;
    answer(&handed, (1, b"2")).await;
    served.settle().await;

    assert_eq!(
        locked(&handed)
            .iter()
            .map(|props| props.header.call_id)
            .collect::<Vec<_>>(),
        [1, 1],
        "the failed answer frees the call id"
    );
    assert_eq!(
        served.sent_since(),
        ["first result 1 \u{1}", "first result 1 2"],
        "the replacement answered"
    );
    assert!(
        served.reported().is_empty(),
        "the answer's caller hears the failure alone"
    );
}

/// A clock that breaks as it arms its next timer once told to: an application's clock, called
/// within a router's turn.
struct Breaking {
    clock: Arc<SteppingClock>,
    breaks: AtomicBool,
}

impl fmt::Debug for Breaking {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Breaking").finish_non_exhaustive()
    }
}

impl Clock for Breaking {
    fn monotonic(&self) -> Duration {
        self.clock.monotonic()
    }

    fn wall(&self) -> SystemTime {
        self.clock.wall()
    }

    fn arm(&self, schedule: Schedule, callback: TimerCallback) -> Arc<dyn Timer> {
        // * once: the panic of one turn, what follows it arming its timers as ever
        assert!(
            !self.breaks.swap(false, Ordering::SeqCst),
            "this clock breaks, on purpose"
        );

        self.clock.arm(schedule, callback)
    }

    fn activity(&self) -> Option<Arc<crate::testing::Activity>> {
        self.clock.activity()
    }
}

// decision 0044: a panic within a turn other than at a site the spec lets throw leaves its state
// half changed, with nothing to undo it: its router ends at once, each call it waits on failed now
// with that panic for its reason, the panic reported, and a call made after refused at once, on the
// thread that ran the turn too
#[tokio::test]
async fn a_turn_that_panics_ends_its_router_failing_each_call_it_waits_on_with_that_panic_and_strands_no_later_call()
 {
    let clock = Arc::new(Breaking {
        clock: SteppingClock::new(super::january_first()),
        breaks: AtomicBool::new(false),
    });
    let shared: SharedClock = Arc::<Breaking>::clone(&clock);
    let transport = ScriptedClient::new(shared);
    let carried: Arc<dyn crate::transport::ClientTransport> =
        Arc::<ScriptedClient>::clone(&transport);
    let router =
        RouterClient::new(carried, &RouterClientOptions::default()).expect("a router built");
    let reported: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let hearing = Arc::clone(&reported);

    router.on_error(Arc::new(move |error: &RouterError| {
        locked(&hearing).push(error.to_string());
    }));

    let request = || {
        router
            .request(
                Bytes::from_static(b"hi"),
                (call_of((None, super::TIMEOUT)), CallHooks::default()),
            )
            .expect("a call")
    };
    let waiting = request();

    clock.clock.settle().await;
    clock.breaks.store(true, Ordering::SeqCst);

    // * its timer armed within its turn, on a clock that breaks
    let breaking = request();

    clock.clock.settle().await;

    let reason = "disconnected: a turn of the router's panicked: this clock breaks, on purpose";

    assert_eq!(
        said(&super::answered(waiting).await),
        reason,
        "the call it waited on failed now, with the panic for its reason"
    );
    assert_eq!(
        said(&super::answered(breaking).await),
        reason,
        "the call whose turn panicked too"
    );
    assert_eq!(
        *locked(&reported),
        ["a turn of the router's panicked: this clock breaks, on purpose"],
        "the panic reported"
    );

    // * on this one thread, the turn's: refused at once, never stranded
    let later = request();

    assert_eq!(
        said(&super::answered(later).await),
        "disconnected: the router was disposed",
        "a call made after refused at once"
    );
    assert_eq!(
        router.gauges().await,
        crate::router::types::Gauges::default(),
        "its owner gone"
    );
}
