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
    let pair = pair().await;

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(RawCodec, RawCodec))
        .expect("echo resolved")
        .on(Arc::new(|_request, response: Response<RawCodec>| {
            response.result(Bytes::from_static(b"{not json"))
        }))
        .expect("echo registered");

    let manager = pair.client.services();
    let heard = recorded(manager);
    let call = manager
        .get_request(&echo(), RequestDependencies::of(JsonCodec, JsonCodec))
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
    assert_eq!(failure.scope(), FailureScope::Protocol, "the protocol's");
    assert_eq!(failure.side(), Some(RouterSide::Client), "by the client");
    assert_eq!(failure.procedure(), Some(echo().address()), "its call");
    assert!(
        matches!(failure.header(), Some(crate::envelope::Header::Result(_))),
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
