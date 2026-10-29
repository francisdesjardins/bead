//! A router's timers, re-armed by what a call does: a timer cancelled once it fired, its job queued
//! behind what re-armed it and not yet run, does nothing, as the other sides' generations and
//! cleared timeouts hold it. The bytes are those of `spec/conversations.json`'s conversations named
//! beside each test.

use core::fmt;
use core::sync::atomic::{AtomicBool, Ordering};
use core::time::Duration;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use bytes::Bytes;

use super::locked;
use super::server::{Served, first};
use crate::clock::{Clock, Schedule, SharedClock, Timer, TimerCallback};
use crate::constants::ProcedureKind;
use crate::envelope::{CreditHeader, Envelope, ResultHeader};
use crate::identity::Procedure;
use crate::managers::service::{ResolverDependencies, Response};
use crate::payloads::RawCodec;
use crate::router::client::{ClientRequest, RouterClient, RouterClientOptions};
use crate::router::server::{CallHooks, RouterServerOptions};
use crate::router::types::{RouterLimitsOptions, TransportMessage};
use crate::testing::SteppingClock;
use crate::testing::hexadecimal;
use crate::testing::scripted::ScriptedClient;

// a timer armed on a hand-fired clock: whether it was cancelled, and what it calls until it fires
struct Armed {
    schedule: Schedule,
    callback: Option<TimerCallback>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Debug)]
struct HandTimer(Arc<AtomicBool>);

impl Timer for HandTimer {
    fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// A clock whose timers fire only when a test fires them, as a platform's timer fires once due and
/// posts its job behind whatever its owner's queue holds; its readings and its activity a stepping
/// clock's.
struct HandFired {
    clock: Arc<SteppingClock>,
    armed: Mutex<Vec<Armed>>,
}

impl fmt::Debug for HandFired {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("HandFired").finish_non_exhaustive()
    }
}

impl HandFired {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            clock: SteppingClock::new(super::january_first()),
            armed: Mutex::default(),
        })
    }

    // fires the last timer armed for `due` that is live: its callback runs, its job posted behind
    // what came before it
    fn fire(&self, due: Duration) {
        let callback = locked(&self.armed)
            .iter_mut()
            .rev()
            .find(|armed| {
                armed.schedule == Schedule::Once(due) && !armed.cancelled.load(Ordering::SeqCst)
            })
            .and_then(|armed| armed.callback.take());

        (callback.expect("a live timer of that due"))();
    }
}

impl Clock for HandFired {
    fn monotonic(&self) -> Duration {
        self.clock.monotonic()
    }

    fn wall(&self) -> SystemTime {
        self.clock.wall()
    }

    fn arm(&self, schedule: Schedule, callback: TimerCallback) -> Arc<dyn Timer> {
        let cancelled = Arc::new(AtomicBool::new(false));

        locked(&self.armed).push(Armed {
            schedule,
            callback: Some(callback),
            cancelled: Arc::clone(&cancelled),
        });

        Arc::new(HandTimer(cancelled))
    }

    fn activity(&self) -> Option<Arc<crate::testing::Activity>> {
        self.clock.activity()
    }
}

fn message_of(text: &str) -> TransportMessage {
    TransportMessage {
        data: Bytes::from(hexadecimal::bytes_of(text).expect("hexadecimal")),
        ..TransportMessage::default()
    }
}

fn limits_of(inactivity: Option<Duration>) -> RouterLimitsOptions {
    RouterLimitsOptions {
        chunk_bytes: Some(64),
        window_bytes: Some(128),
        transfer_inactivity_timeout: inactivity,
        ..RouterLimitsOptions::default()
    }
}

// a server's router on a hand-fired clock, its limits `limits`, procedure `id` of service 1
// answered by `answer`
fn served_on(
    (clock, limits): (&Arc<HandFired>, RouterLimitsOptions),
    (id, answer): (u16, &'static [u8]),
) -> Served {
    let shared: SharedClock = Arc::<HandFired>::clone(clock);
    let served = Served::on(
        (shared, Arc::clone(&clock.clock)),
        &RouterServerOptions {
            limits: Some(limits),
            ..RouterServerOptions::default()
        },
    );
    let procedure = Procedure {
        service_id: 1,
        id,
        service_revision: 1,
        name: "large".to_owned(),
        kind: Some(ProcedureKind::Request),
        maximum_payload_bytes: None,
        deprecation: None,
    };

    served
        .services
        .get_request_resolver(&procedure, ResolverDependencies::of(RawCodec, RawCodec))
        .expect("resolved")
        .on(Arc::new(move |_request, response: Response<RawCodec>| {
            response.result(Bytes::from_static(answer))
        }))
        .expect("registered");
    served.transport.open(&first(), true);

    served
}

// "a request whose transfer goes silent is answered TRANSFER_STALLED, each chunk placed setting it
// going again, its call then held abandoned as long": its opening, then one chunk of 44 bytes
const REQUEST: &str = "A1 10 04 05  00 00 00 01  00 01 00 01  00 00 00 00 00 00 01 2C | 22 61 62 63 64 65 66 67 68 69 6A 6B 6C 6D 6E 6F 70 71 72 73 74 75 76 77 78 79 7A 61 62 63 64 65 66 67 68 69 6A 6B 6C 6D 6E 6F 70 71";
const CHUNK: &str = "A1 14 40 04  00 00 00 01  00 00 00 00 00 00 00 2C | 72 73 74 75 76 77 78 79 7A 61 62 63 64 65 66 67 68 69 6A 6B 6C 6D 6E 6F 70 71 72 73 74 75 76 77 78 79 7A 61 62 63 64 65 66 67 68 69 6A 6B 6C 6D";

// spec 12.8, as the C# side's twin: a timer fires off the owner's turn, so a chunk can come
// between its firing and its job; JavaScript's one thread has no such race
#[tokio::test]
async fn hears_no_stall_of_a_timer_stopped_as_it_fired_on_its_way_to_the_scheduler() {
    const INACTIVITY: Duration = Duration::from_secs(30);

    let clock = HandFired::new();
    let served = served_on((&clock, limits_of(None)), (1, b"\"ok\""));

    served
        .transport
        .deliver_message(&message_of(REQUEST), &first());
    served.settle().await;

    assert_eq!(
        served.sent_since(),
        ["first Credit 1"],
        "its window granted"
    );

    // * the chunk came, then the timer's due: both queued before the owner takes either
    served
        .transport
        .deliver_message(&message_of(CHUNK), &first());
    clock.fire(INACTIVITY);
    served.settle().await;

    assert!(
        served.sent_since().is_empty(),
        "the old timer's job ends nothing: the chunk set it going again"
    );
    assert!(served.reported().is_empty(), "nothing reported");

    // the timer the chunk armed is the one that counts
    clock.fire(INACTIVITY);
    served.settle().await;

    assert_eq!(
        served.sent_since(),
        ["first failure 1 TRANSFER_STALLED"],
        "silent past the chunk's own timer"
    );
}

// "a result that gets no credit is ended TRANSFER_STALLED, a credit that grants setting it going
// again, one that grants nothing not": a request answered 100 bytes, then a credit of 76
const ASK: &str = "A1 10 00 03  00 00 00 01  00 01 00 07 | 7B 22 6C 65 6E 67 74 68 22 3A 39 38 7D";
const CREDIT: &str = "A1 15 00 04  00 00 00 01  00 00 00 00 00 00 00 4C";

// spec 12.8, as the C# side's twin: as the request's, for a result the router sends
#[tokio::test]
async fn ends_nothing_by_a_result_s_timer_that_fired_as_a_credit_set_it_going_again() {
    const INACTIVITY: Duration = Duration::from_secs(15);

    static ANSWER: [u8; 100] = {
        let mut answer = [b'x'; 100];

        answer[0] = b'"';
        answer[99] = b'"';

        answer
    };

    let clock = HandFired::new();
    let served = served_on((&clock, limits_of(Some(INACTIVITY))), (7, &ANSWER));

    served.transport.deliver_message(&message_of(ASK), &first());
    served.settle().await;

    assert_eq!(
        served.sent_since().len(),
        1,
        "its result's opening, waiting on a credit"
    );

    // * the credit came, then the timer's due: both queued before the owner takes either
    served
        .transport
        .deliver_message(&message_of(CREDIT), &first());
    clock.fire(INACTIVITY);
    served.settle().await;

    assert_eq!(
        served.sent_since(),
        ["first Chunk 1"],
        "the chunk the credit let go, and the old timer's job ends nothing"
    );
    assert!(served.reported().is_empty(), "nothing reported");
}

// spec 12.8, as the C# side's twin: a request sent as a transfer waits on its inactivity, each part
// handed off setting it going again
#[tokio::test]
async fn ends_nothing_by_a_timer_that_fired_as_a_credit_set_it_going_again() {
    const INACTIVITY: Duration = Duration::from_secs(30);

    let clock = HandFired::new();
    let shared: SharedClock = Arc::<HandFired>::clone(&clock);
    let transport = ScriptedClient::new(shared);
    let carried: Arc<dyn crate::transport::ClientTransport> =
        Arc::<ScriptedClient>::clone(&transport);
    let router = RouterClient::new(
        carried,
        &RouterClientOptions {
            limits: Some(limits_of(Some(INACTIVITY))),
            ..RouterClientOptions::default()
        },
    )
    .expect("a router built");
    let call = router
        .request(
            Bytes::from(vec![7; 200]),
            (
                ClientRequest {
                    procedure: crate::testing::pair::echo(),
                    options: super::options_of(Duration::from_secs(60)),
                    series: None,
                    refusal: None,
                    subscribes: None,
                },
                CallHooks::default(),
            ),
        )
        .expect("a call");

    clock.clock.settle().await;

    let opened = transport.envelopes().len();

    // * the credit came, then the timer's due: both queued before the owner takes either
    transport.deliver(&Envelope::Credit {
        header: CreditHeader {
            call_id: 1,
            credit_end: 400,
            paced: false,
        },
    });
    clock.fire(INACTIVITY);
    clock.clock.settle().await;

    let sent = transport.envelopes();

    assert!(
        sent.len() > opened
            && sent
                .iter()
                .all(|envelope| !matches!(envelope, Envelope::Cancel { .. })),
        "its chunks went, and no cancel: {sent:?}"
    );

    transport.deliver(&Envelope::Result {
        header: ResultHeader {
            call_id: 1,
            total: None,
            credential: None,
        },
        payload: Bytes::from_static(b"done"),
    });

    let answered = super::answered(call).await;

    assert!(
        matches!(&answered, Ok(result) if result.payload.as_ref() == b"done"),
        "the call goes on to its answer, its old timer's job ending nothing: {answered:?}"
    );
}

// a session's timer: a touch restarts both its timers, each re-armed
#[tokio::test]
async fn a_session_s_timer_that_fired_behind_the_touch_that_restarted_it_reaches_nothing() {
    const TIMEOUT: Duration = Duration::from_secs(1);

    let clock = HandFired::new();
    let shared: SharedClock = Arc::<HandFired>::clone(&clock);
    let transport = crate::testing::scripted::ScriptedServer::new(Arc::clone(&shared));
    let carried: Arc<dyn crate::transport::ServerTransport> =
        Arc::<crate::testing::scripted::ScriptedServer>::clone(&transport);
    let server = crate::server::Server::new(carried, &crate::server::ServerOptions::default())
        .expect("a server built");
    let sessions = server.sessions();
    let reached: Arc<Mutex<Vec<String>>> = Arc::default();
    let hearing = Arc::clone(&reached);

    sessions.on(Arc::new(
        move |event: &crate::managers::sessions::SessionEvent| {
            if let crate::managers::sessions::SessionEvent::SessionInactivityTimeoutReached(
                session,
            ) = event
            {
                locked(&hearing).push(session.connection_handle.to_string());
            }
        },
    ));
    transport.open(&first(), true);
    clock.clock.settle().await;

    let mut session = sessions.create(first());

    session.session_inactivity_timeout = Some(TIMEOUT);
    sessions.set(session).await.expect("stored");

    // * the touch came, then the timer's due: both queued before the owner takes either
    let touched = sessions.touch(first());

    clock.fire(TIMEOUT);
    clock.clock.settle().await;

    assert!(touched.await.is_some(), "touched");
    assert!(
        locked(&reached).is_empty(),
        "the old timer's job reaches nothing: the touch restarted it"
    );

    clock.fire(TIMEOUT);
    clock.clock.settle().await;

    assert_eq!(
        *locked(&reached),
        [first().to_string()],
        "the timer the touch armed is the one that counts"
    );
}
