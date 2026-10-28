//! The owner's tests (decision 0044): calls sent in the order they are made, whatever becomes of
//! their futures; a call a listener makes within a turn, and an envelope a listener hands its
//! router within one; a router kept by its transport; and a router refused off a runtime, or on
//! one without its time driver.

use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::UNIX_EPOCH;

use bytes::Bytes;
use serde_json::Value;

use crate::clock::SharedClock;
use crate::constants::{EnvelopeKind, ProcedureKind};
use crate::debug::{DebugDirection, TracedEnvelope};
use crate::envelope::{Envelope, ResultHeader};
use crate::identity::Procedure;
use crate::managers::service::{
    RequestDependencies, RequestOptions, ResolverDependencies, Response,
};
use crate::payloads::JsonCodec;
use crate::router::client::{ClientRequest, RouterClient, RouterClientOptions};
use crate::router::server::CallHooks;
use crate::router::types::{ResolvedRequestOptions, RouterError};
use crate::testing::SteppingClock;
use crate::testing::pair::{Pair, PairOptions, echo};
use crate::testing::scripted::ScriptedClient;
use crate::transport::{ClientTransport, ReadyState};

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn scripted() -> (Arc<SteppingClock>, Arc<ScriptedClient>, RouterClient) {
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let transport = ScriptedClient::new(shared);
    let carried: Arc<dyn ClientTransport> = Arc::<ScriptedClient>::clone(&transport);
    let router =
        RouterClient::new(carried, &RouterClientOptions::default()).expect("a router built");

    (clock, transport, router)
}

fn request() -> ClientRequest {
    ClientRequest {
        procedure: echo(),
        options: ResolvedRequestOptions {
            timeout: Duration::from_secs(1),
            destination_id: None,
            connection_handle: None,
            credential: None,
            signal: None,
            close_on_timeout: false,
        },
        series: None,
        refusal: None,
        subscribes: None,
    }
}

fn result_of(call_id: u32, payload: &[u8]) -> Envelope {
    Envelope::Result {
        header: ResultHeader {
            call_id,
            total: None,
            credential: None,
        },
        payload: Bytes::copy_from_slice(payload),
    }
}

fn payloads_of(transport: &ScriptedClient) -> Vec<Vec<u8>> {
    transport
        .envelopes()
        .iter()
        .filter_map(|envelope| match envelope {
            Envelope::Request { payload, .. } => Some(payload.to_vec()),
            Envelope::Result { .. }
            | Envelope::Failure { .. }
            | Envelope::Notification { .. }
            | Envelope::Chunk { .. }
            | Envelope::Credit { .. }
            | Envelope::Cancel { .. } => None,
        })
        .collect()
}

#[tokio::test]
async fn sends_each_call_in_the_order_it_is_made_whatever_order_it_is_awaited_in() {
    let (clock, transport, router) = scripted();
    let calls: Vec<_> = [&[1_u8][..], &[2], &[3]]
        .into_iter()
        .map(|payload| {
            router
                .request(
                    Bytes::copy_from_slice(payload),
                    (request(), CallHooks::default()),
                )
                .expect("a call")
        })
        .collect();

    clock.settle().await;

    for (call_id, payload) in [(1, &b"a"[..]), (3, b"b"), (5, b"c")] {
        transport.deliver(&result_of(call_id, payload));
    }

    // awaited last to first
    let mut answers = Vec::new();

    for call in calls.into_iter().rev() {
        answers.push(call.await.expect("answered").payload.to_vec());
    }

    assert_eq!(
        payloads_of(&transport),
        [vec![1], vec![2], vec![3]],
        "sent in the order made"
    );
    assert_eq!(
        answers,
        [b"c".to_vec(), b"b".to_vec(), b"a".to_vec()],
        "each its own answer"
    );
}

#[tokio::test]
async fn a_call_s_future_dropped_unpolled_still_sends_its_call() {
    let (clock, transport, router) = scripted();
    let reported: Arc<Mutex<Vec<String>>> = Arc::default();
    let hearing = Arc::clone(&reported);

    router.on_error(Arc::new(move |error: &RouterError| {
        locked(&hearing).push(error.to_string());
    }));

    let call = router
        .request(Bytes::from_static(&[7]), (request(), CallHooks::default()))
        .expect("a call");

    drop(call);
    clock.settle().await;

    assert_eq!(payloads_of(&transport), [vec![7]], "sent all the same");

    // its answer goes nowhere, and nothing is reported
    transport.deliver(&result_of(1, b"a"));
    clock.settle().await;

    assert!(locked(&reported).is_empty(), "its answer heard in silence");
}

#[tokio::test]
async fn a_call_a_listener_makes_within_a_turn_goes_as_that_turn_ends_before_any_job_queued_after_it()
 {
    let (clock, transport, router) = scripted();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let (telling, within, carried) = (Arc::clone(&seen), router.clone(), Arc::clone(&transport));
    let is_first = Arc::new(Mutex::new(true));

    router.on_debug(Arc::new(
        move |direction: DebugDirection, traced: &TracedEnvelope| {
            if direction != DebugDirection::Rx || traced.header.kind() != EnvelopeKind::Result {
                return;
            }

            if !core::mem::replace(&mut *locked(&is_first), false) {
                return;
            }

            // within its router's turn: a call, then a job queued after it
            let before = carried.sent().len();
            let call = within
                .request(Bytes::from_static(&[2]), (request(), CallHooks::default()))
                .expect("a call within a turn");

            drop(call);
            locked(&telling).push(format!(
                "sent within the listener {}",
                carried.sent().len() - before
            ));

            let (queued, sent) = (Arc::clone(&telling), Arc::clone(&carried));

            within.owner().offer(Box::new(move |_state| {
                locked(&queued).push(format!(
                    "sent before the job queued after it {}",
                    sent.sent().len() - before
                ));
            }));
        },
    ));

    let first = router
        .request(Bytes::from_static(&[1]), (request(), CallHooks::default()))
        .expect("a call");

    clock.settle().await;
    transport.deliver(&result_of(1, b"a"));
    first.await.expect("answered");
    clock.settle().await;

    assert_eq!(
        *locked(&seen),
        [
            "sent within the listener 0",
            "sent before the job queued after it 1"
        ],
        "it goes as the turn ends, before the job queued after it"
    );
    assert_eq!(
        payloads_of(&transport),
        [vec![1], vec![2]],
        "both sent, in order"
    );
}

#[tokio::test]
async fn an_envelope_a_listener_hands_its_router_within_a_turn_is_taken_behind_what_came_before_it()
{
    let (clock, transport, router) = scripted();
    let heard: Arc<Mutex<Vec<u32>>> = Arc::default();
    let (hearing, carried) = (Arc::clone(&heard), Arc::clone(&transport));

    router.on_debug(Arc::new(
        move |direction: DebugDirection, traced: &TracedEnvelope| {
            if direction != DebugDirection::Rx || traced.header.kind() != EnvelopeKind::Result {
                return;
            }

            let call_id = traced.header.call_id();

            locked(&hearing).push(call_id);

            // within its router's turn, its transport hands it the third answer
            if call_id == 1 {
                carried.deliver(&result_of(5, b"c"));
            }
        },
    ));

    let calls: Vec<_> = [&[1_u8][..], &[2], &[3]]
        .into_iter()
        .map(|payload| {
            router
                .request(
                    Bytes::copy_from_slice(payload),
                    (request(), CallHooks::default()),
                )
                .expect("a call")
        })
        .collect();

    clock.settle().await;

    // the first two answers queued before the first is taken
    transport.deliver(&result_of(1, b"a"));
    transport.deliver(&result_of(3, b"b"));

    for call in calls {
        call.await.expect("answered");
    }

    assert_eq!(
        *locked(&heard),
        [1, 3, 5],
        "the answer handed within a turn taken behind the one queued before it"
    );
}

#[tokio::test]
async fn keeps_its_connection_when_the_application_drops_its_last_handle() {
    let pair = Pair::connected((crate::testing::instants::new_year(), PairOptions::default()))
        .await
        .expect("a pair connected");
    let command = Procedure {
        id: 9,
        name: "clock".to_owned(),
        kind: Some(ProcedureKind::Command),
        ..echo()
    };

    pair.client
        .services()
        .get_command_resolver(&command, ResolverDependencies::of(JsonCodec, JsonCodec))
        .expect("clock resolved")
        .on(Arc::new(|_request, response: Response<JsonCodec>| {
            response.result(Value::from("noon"))
        }))
        .expect("clock registered");

    let Pair {
        clock,
        server,
        memory,
        client,
        transport,
        connection_handle,
        ..
    } = pair;

    // the application lets go of its client: its transport keeps its router, and its connection
    drop(client);
    clock.settle().await;

    assert_eq!(
        transport.ready_state(),
        ReadyState::Open,
        "its connection kept"
    );
    assert_eq!(memory.clients().len(), 1, "its server holds it still");

    let options = RequestOptions {
        connection_handle: Some(connection_handle),
        ..RequestOptions::default()
    };

    let asked = server
        .services()
        .get_command(&command, RequestDependencies::of(JsonCodec, JsonCodec))
        .expect("clock asked")
        .call(Value::Null, options)
        .expect("clock called");

    clock.settle().await;

    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), asked)
            .await
            .expect("answered within its patience")
            .expect("answered"),
        Value::from("noon"),
        "its router answers still"
    );
}

#[test]
fn a_router_built_outside_a_runtime_is_refused() {
    let clock: SharedClock = SteppingClock::new(UNIX_EPOCH);
    let transport: Arc<dyn ClientTransport> = ScriptedClient::new(clock);
    let refused = RouterClient::new(transport, &RouterClientOptions::default())
        .expect_err("refused outside a runtime");

    assert_eq!(
        refused.message(),
        "a router is built within a tokio runtime, or given its handle",
        "said why"
    );
}

#[test]
fn a_router_on_a_runtime_without_its_time_driver_is_refused() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("a runtime without its time driver");
    let clock: SharedClock = SteppingClock::new(UNIX_EPOCH);
    let transport: Arc<dyn ClientTransport> = ScriptedClient::new(clock);
    let options = RouterClientOptions {
        runtime: Some(runtime.handle().clone()),
        ..RouterClientOptions::default()
    };

    let refused =
        RouterClient::new(transport, &options).expect_err("refused without its time driver");

    assert_eq!(
        refused.message(),
        "a router's runtime enables tokio's time driver",
        "said why"
    );
}
