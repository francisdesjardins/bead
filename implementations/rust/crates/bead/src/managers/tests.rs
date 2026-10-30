//! The service manager's tests, over a pair of the in-memory transport: an answer or a notification
//! that does not decode, and a call or a notification whose value does not write.

use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;
use serde_json::Value;

use crate::constants::{FailureScope, ProcedureKind, ProtocolCode, RouterSide};
use crate::debug::{DebugDirection, DebugType};
use crate::errors::CallError;
use crate::failure::FailureOrigin;
use crate::identity::{Deprecation, Procedure};
use crate::managers::service::{
    DebugEvent, NotificationDependencies, NotifyOptions, RequestDependencies, RequestOptions,
    ResolverDependencies, Response, ServiceManager, TracedError,
};
use crate::payloads::{CodecRefusal, JsonCodec, PayloadCodec, RawCodec};
use crate::router::types::RouterError;
use crate::testing::pair::{Pair, PairOptions, echo};

// what a manager's debug listener heard: whether the step went wrong and why, and the step
type Heard = Arc<Mutex<Vec<(Option<String>, DebugEvent)>>>;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

async fn pair() -> Pair {
    Pair::connected((crate::testing::instants::new_year(), PairOptions::default()))
        .await
        .expect("a pair connected")
}

// a client over the test kit's scripted transport, on a stepping clock: what it sends read, what it
// hears written by the test
fn scripted() -> (
    Arc<crate::testing::SteppingClock>,
    Arc<crate::testing::scripted::ScriptedClient>,
    crate::client::Client,
) {
    let clock = crate::testing::SteppingClock::new(crate::testing::instants::new_year());
    let shared: crate::clock::SharedClock = Arc::<crate::testing::SteppingClock>::clone(&clock);
    let transport = crate::testing::scripted::ScriptedClient::new(shared);
    let carried: Arc<dyn crate::transport::ClientTransport> =
        Arc::<crate::testing::scripted::ScriptedClient>::clone(&transport);
    let client = crate::client::Client::new(carried, &crate::client::ClientOptions::default())
        .expect("a client built");

    (clock, transport, client)
}

fn recorded(manager: &ServiceManager) -> Heard {
    let heard: Heard = Arc::default();
    let hearing = Arc::clone(&heard);

    manager.on_debug(Arc::new(
        move |error: Option<&TracedError>, event: &DebugEvent| {
            locked(&hearing).push((error.map(ToString::to_string), event.clone()));
        },
    ));

    heard
}

fn ticks() -> Procedure {
    Procedure {
        id: 2,
        name: "ticks".to_owned(),
        kind: Some(ProcedureKind::Notifies),
        ..echo()
    }
}

// a codec that writes no value
#[derive(Debug)]
struct Unwritable;

impl PayloadCodec for Unwritable {
    type Value = Value;

    fn decode(&self, bytes: &Bytes) -> Result<Value, CodecRefusal> {
        JsonCodec.decode(bytes)
    }

    fn encode(&self, _value: &Value) -> Result<Bytes, CodecRefusal> {
        Err(CodecRefusal::new("cannot write"))
    }

    fn encoding(&self) -> &'static str {
        "json"
    }
}

// spec 17.2.2
#[tokio::test]
async fn an_answer_that_does_not_decode_fails_the_call_here_with_its_header_and_its_call() {
    let (clock, transport, client) = scripted();
    let manager = client.services();
    let heard = recorded(manager);
    let options = RequestOptions {
        destination_id: Some(4),
        ..RequestOptions::default()
    };
    let call = manager
        .get_request(&echo(), RequestDependencies::of(JsonCodec, JsonCodec))
        .expect("echo asked")
        .call(Value::from("x"), options)
        .expect("echo called");

    clock.settle().await;

    let answer = crate::envelope::ResultHeader {
        call_id: 1,
        total: None,
        credential: None,
    };

    transport.deliver(&crate::envelope::Envelope::Result {
        header: answer.clone(),
        payload: Bytes::from_static(b"{not json"),
    });
    clock.settle().await;

    let failed = crate::testing::patience(Duration::from_secs(10), call)
        .await
        .expect("answered within its patience");
    let Err(CallError::Failure(failure)) = failed else {
        panic!("failed here: {failed:?}");
    };

    assert_eq!(
        failure.protocol_code(),
        Some(ProtocolCode::PAYLOAD_UNDECODABLE),
        "its code"
    );
    assert_eq!(failure.origin(), FailureOrigin::Local, "raised here");
    assert_eq!(failure.scope(), FailureScope::Protocol, "the protocol's");
    assert_eq!(failure.side(), Some(RouterSide::Client), "by the client");
    assert_eq!(failure.procedure(), Some(echo().address()), "its call");
    assert_eq!(failure.destination_id(), Some(4), "its call's destination");
    assert!(
        matches!(failure.header(), Some(crate::envelope::Header::Result(header)) if *header == answer),
        "its answer's header"
    );
    assert!(
        !failure.detail().is_empty(),
        "the decoder's words in its detail"
    );

    // told as the call's answer: the failure, and what it carries
    let heard = locked(&heard).clone();

    assert_eq!(
        heard
            .iter()
            .map(|(error, event)| (error.is_some(), event.direction))
            .collect::<Vec<_>>(),
        [(false, DebugDirection::Tx), (true, DebugDirection::Rx)],
        "its steps"
    );
}

// spec 17.2.3
#[tokio::test]
async fn a_notification_that_does_not_decode_fails_here_for_the_router_to_report() {
    let pair = pair().await;
    let notifier = pair
        .server
        .services()
        .get_notification_resolver(
            &ticks(),
            (ResolverDependencies::of(JsonCodec, JsonCodec), RawCodec),
        )
        .expect("ticks resolved")
        .on(Arc::new(|_request, response: Response<JsonCodec>| {
            response.result(Value::Null)
        }))
        .expect("ticks registered");
    let manager = pair.client.services();
    let heard: Arc<Mutex<Vec<Value>>> = Arc::default();
    let hearing = Arc::clone(&heard);
    let notification = manager
        .get_notification(
            &ticks(),
            NotificationDependencies::of((JsonCodec, JsonCodec, JsonCodec)),
        )
        .expect("ticks heard");
    let registering = notification.on(
        (
            Value::Null,
            Arc::new(move |value: Value| {
                locked(&hearing).push(value);

                Box::pin(async { Ok(()) })
            }),
        ),
        RequestOptions::default(),
    );

    pair.settle().await;
    registering.await.expect("subscribed");

    let seen = recorded(manager);

    notifier
        .notify(Bytes::from_static(b"{not json"), &NotifyOptions::default())
        .await;
    pair.settle().await;

    let reports = locked(&pair.client_reports).clone();
    let failure = reports.iter().find_map(|error| match error {
        RouterError::Failure(failure) => Some(failure.clone()),
        RouterError::Other(_) => None,
    });
    let failure = failure.expect("a failure reported");

    assert_eq!(
        failure.protocol_code(),
        Some(ProtocolCode::PAYLOAD_UNDECODABLE),
        "its code"
    );
    assert_eq!(failure.origin(), FailureOrigin::Local, "raised here");
    assert_eq!(failure.side(), Some(RouterSide::Client), "by the client");
    assert_eq!(
        failure.procedure(),
        Some(ticks().address()),
        "its procedure"
    );
    assert!(failure.header().is_none(), "no header of a call");
    assert!(locked(&heard).is_empty(), "its callback heard nothing");

    let seen = locked(&seen).clone();

    assert_eq!(
        seen.iter()
            .map(|(error, event)| (error.is_some(), event.direction, event.call_type))
            .collect::<Vec<_>>(),
        [(true, DebugDirection::Rx, DebugType::Notification)],
        "told once, with its failure"
    );
}

// spec 17.2.4
#[tokio::test]
async fn a_call_whose_value_does_not_write_fails_before_anything_goes_nothing_requested_traced_or_deprecated()
 {
    let pair = pair().await;
    let manager = pair.client.services();
    let seen = recorded(manager);
    let deprecated: Arc<Mutex<Vec<Procedure>>> = Arc::default();
    let telling = Arc::clone(&deprecated);
    let asked: Arc<Mutex<usize>> = Arc::default();
    let counting = Arc::clone(&asked);

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(JsonCodec, JsonCodec))
        .expect("echo resolved")
        .on(Arc::new(move |request, response: Response<JsonCodec>| {
            *locked(&counting) += 1;

            response.result(request.payload)
        }))
        .expect("echo registered");
    manager.on_deprecated(Arc::new(move |procedure: &Procedure| {
        locked(&telling).push(procedure.clone());
    }));

    let requester = manager
        .get_request(
            &Procedure {
                deprecation: Some(Deprecation::default()),
                ..echo()
            },
            RequestDependencies::of(Unwritable, JsonCodec),
        )
        .expect("echo asked");

    // * written before its trace and its deprecation: no call is made (spec 17.2, item 4)
    let refused = requester
        .call(Value::from("x"), RequestOptions::default())
        .expect("a call");
    let refused = crate::testing::patience(Duration::from_secs(10), refused)
        .await
        .expect("failed at once");

    pair.settle().await;

    assert!(
        matches!(&refused, Err(CallError::Other(error)) if error.to_string() == "cannot write"),
        "its codec's refusal: {refused:?}"
    );
    assert!(locked(&seen).is_empty(), "nothing traced");
    assert!(locked(&deprecated).is_empty(), "nothing deprecated");
    assert_eq!(*locked(&asked), 0, "nothing requested");
}

// spec 17.2.6
#[tokio::test]
async fn a_notification_whose_value_does_not_write_goes_to_its_router_in_its_payload_s_place_its_failure_told_at_its_start_and_resolves()
 {
    let pair = pair().await;
    let notifier = pair
        .server
        .services()
        .get_notification_resolver(
            &ticks(),
            (ResolverDependencies::of(JsonCodec, JsonCodec), Unwritable),
        )
        .expect("ticks resolved")
        .on(Arc::new(|_request, response: Response<JsonCodec>| {
            response.result(Value::Null)
        }))
        .expect("ticks registered");
    let notification = pair
        .client
        .services()
        .get_notification(
            &ticks(),
            NotificationDependencies::of((JsonCodec, JsonCodec, JsonCodec)),
        )
        .expect("ticks heard");
    let registering = notification.on(
        (
            Value::Null,
            Arc::new(|_value: Value| Box::pin(async { Ok(()) })),
        ),
        RequestOptions::default(),
    );

    pair.settle().await;
    registering.await.expect("subscribed");

    let seen = recorded(pair.server.services());

    // resolves all the same
    crate::testing::patience(
        Duration::from_secs(10),
        notifier.notify(Value::from("news"), &NotifyOptions::default()),
    )
    .await
    .expect("resolved");
    pair.settle().await;

    let reported: Vec<String> = locked(&pair.server_reports)
        .iter()
        .map(|(error, _handle)| error.to_string())
        .collect();

    assert_eq!(reported, ["cannot write"], "its router told why, once");

    // told as a notification sent, then as its failure to go at that start (spec/debugging.md 4.2)
    let seen = locked(&seen).clone();

    assert_eq!(
        seen.iter()
            .map(|(error, event)| (error.clone(), event.direction, event.call_type))
            .collect::<Vec<_>>(),
        [
            (None, DebugDirection::Tx, DebugType::Notification),
            (
                Some("cannot write".to_owned()),
                DebugDirection::Tx,
                DebugType::Notification
            ),
        ],
        "its steps"
    );
    assert_eq!(
        seen.iter()
            .map(|(_, event)| event.started_at)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        1,
        "told at one start"
    );
}

// a codec of JSON that panics as it reads or as it writes, as an application's might
#[derive(Debug)]
struct Breaking {
    reads: bool,
    writes: bool,
}

impl PayloadCodec for Breaking {
    type Value = Value;

    fn decode(&self, bytes: &Bytes) -> Result<Value, CodecRefusal> {
        assert!(!self.reads, "this codec breaks as it reads, on purpose");

        JsonCodec.decode(bytes)
    }

    fn encode(&self, value: &Value) -> Result<Bytes, CodecRefusal> {
        assert!(!self.writes, "this codec breaks as it writes, on purpose");

        JsonCodec.encode(value)
    }

    fn encoding(&self) -> &'static str {
        "json"
    }
}

// decision 0044: a codec's panic is its throw, as both other sides answer any throw of a request's
// decode PAYLOAD_UNDECODABLE: the twin of "a payload that does not decode is answered as
// undecodable, with no detail, never reaching the callback", its codec panicking
#[tokio::test]
async fn a_request_whose_codec_panics_as_it_reads_is_answered_as_undecodable_with_no_detail_never_reaching_the_callback()
 {
    let pair = pair().await;
    let reached = Arc::new(Mutex::new(0_u32));
    let reaching = Arc::clone(&reached);

    pair.server
        .services()
        .get_request_resolver(
            &echo(),
            ResolverDependencies::of(
                Breaking {
                    reads: true,
                    writes: false,
                },
                JsonCodec,
            ),
        )
        .expect("echo resolved")
        .on(Arc::new(move |request, response: Response<JsonCodec>| {
            *locked(&reaching) += 1;

            response.result(request.payload)
        }))
        .expect("echo registered");

    let call = pair
        .client
        .services()
        .get_request(&echo(), RequestDependencies::of(JsonCodec, JsonCodec))
        .expect("echo asked")
        .call(Value::from("x"), RequestOptions::default())
        .expect("echo called");

    pair.settle().await;

    let failed = crate::testing::patience(Duration::from_secs(10), call)
        .await
        .expect("answered within its patience");
    let Err(CallError::Failure(failure)) = failed else {
        panic!("failed: {failed:?}");
    };

    assert_eq!(
        (failure.protocol_code(), failure.detail()),
        (Some(ProtocolCode::PAYLOAD_UNDECODABLE), ""),
        "undecodable, with no detail"
    );
    assert_eq!(*locked(&reached), 0, "never reaching the callback");
    assert!(
        locked(&pair.server_reports).is_empty(),
        "nothing reported, as for a decode that refuses"
    );
}

// decision 0044, spec 17.2.2: a result whose codec panics fails its call here, as one that refuses
// does, and the router answers the next
#[tokio::test]
async fn an_answer_whose_codec_panics_as_it_reads_fails_the_call_here_undecodable_and_the_router_answers_the_next()
 {
    let pair = pair().await;

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(JsonCodec, JsonCodec))
        .expect("echo resolved")
        .on(Arc::new(|request, response: Response<JsonCodec>| {
            response.result(request.payload)
        }))
        .expect("echo registered");

    let manager = pair.client.services();
    let call = manager
        .get_request(
            &echo(),
            RequestDependencies::of(
                JsonCodec,
                Breaking {
                    reads: true,
                    writes: false,
                },
            ),
        )
        .expect("echo asked")
        .call(Value::from("x"), RequestOptions::default())
        .expect("echo called");

    pair.settle().await;

    let failed = crate::testing::patience(Duration::from_secs(10), call)
        .await
        .expect("answered within its patience");
    let Err(CallError::Failure(failure)) = failed else {
        panic!("failed here: {failed:?}");
    };

    assert_eq!(
        failure.protocol_code(),
        Some(ProtocolCode::PAYLOAD_UNDECODABLE),
        "its code"
    );
    assert_eq!(failure.origin(), FailureOrigin::Local, "raised here");
    assert_eq!(
        failure.detail(),
        "a codec panicked: this codec breaks as it reads, on purpose",
        "the codec's panic in its detail"
    );

    let next = manager
        .get_request(&echo(), RequestDependencies::of(JsonCodec, JsonCodec))
        .expect("echo asked")
        .call(Value::from("y"), RequestOptions::default())
        .expect("echo called");

    pair.settle().await;

    assert_eq!(
        crate::testing::patience(Duration::from_secs(10), next)
            .await
            .expect("answered within its patience")
            .expect("answered"),
        Value::from("y"),
        "the router answers the next"
    );
}

// decision 0044: a value whose codec panics as it writes fails its call with that throw, as the
// TypeScript side rejects a call whose encode throws: nothing goes
#[tokio::test]
async fn a_call_whose_codec_panics_as_it_writes_fails_with_its_throw_and_nothing_goes() {
    let pair = pair().await;
    let manager = pair.client.services();
    let heard = recorded(manager);
    let call = manager
        .get_request(
            &echo(),
            RequestDependencies::of(
                Breaking {
                    reads: false,
                    writes: true,
                },
                JsonCodec,
            ),
        )
        .expect("echo asked")
        .call(Value::from("x"), RequestOptions::default())
        .expect("a call made, its throw its outcome");

    pair.settle().await;

    let failed = crate::testing::patience(Duration::from_secs(10), call)
        .await
        .expect("failed within its patience");

    assert!(
        matches!(&failed, Err(CallError::Other(error))
            if error.to_string() == "a codec panicked: this codec breaks as it writes, on purpose"),
        "its throw: {failed:?}"
    );
    assert!(locked(&heard).is_empty(), "nothing went, nothing traced");
}
