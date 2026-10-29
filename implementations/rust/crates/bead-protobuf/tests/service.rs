//! The `proto` codecs through the service layer, over a pair of the in-memory transport: a request
//! or a result that leaves a required field unset (spec 17.9.7), refused where a codec reads it or
//! writes it. `echo` takes and answers a `Probe` of `spec/codecs.proto`; a peer of no such codec
//! sends and answers its bytes raw. The value that leaves `Needs.shade` unset is a dynamic message,
//! the form that holds one; a `Probe` holds none. The twins of the TypeScript side's
//! `service-client.test.ts` and `service-server.test.ts`, and the C# side's `ServiceClientTests`
//! and `ServiceServerTests`.

#![expect(
    clippy::disallowed_methods,
    reason = "a native target: its calls wait on tokio's timers"
)]

use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bead::testing::instants::new_year;
use bead::testing::pair::{Pair, PairOptions, echo};
use bead::{
    CallError, DebugEvent, FailureOrigin, FailureScope, PayloadCodec, ProtocolCode, RawCodec,
    RequestDependencies, RequestOptions, ResolverDependencies, Response, RouterSide, TracedError,
};
use bead_protobuf::testing::codecs::{Needs, Probe, Shade, descriptor_pool};
use bead_protobuf::{DynamicCodec, ProtoCodec};
use buffa::MessageField;
use buffa_descriptor::reflect::{DynamicMessage, ReflectMessageMut, Value};
use bytes::Bytes;

// how long a call is waited on
const PATIENCE: Duration = Duration::from_secs(10);

// the words the codec refuses the unset value in, reading and writing
const WORDS: &str = "a proto message leaves bead.codecs.v1.Needs.shade unset";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

async fn pair() -> Result<Pair, String> {
    Pair::connected((new_year(), PairOptions::default())).await
}

fn typed() -> ProtoCodec<Probe> {
    ProtoCodec::new()
}

// Probe's dynamic codec, by the pool its generated code embeds
fn dynamic() -> DynamicCodec {
    let schema = typed().schema().clone();

    DynamicCodec::new(Arc::clone(schema.pool()), schema.message())
}

// a Probe whose needs leaves its shade unset, as a dynamic message
fn unset() -> Option<DynamicMessage> {
    let pool = Arc::clone(descriptor_pool());
    let probe = pool.message_index("bead.codecs.v1.Probe")?;
    let needs = pool.message_index("bead.codecs.v1.Needs")?;
    let mut held = DynamicMessage::new(Arc::clone(&pool), needs);
    let mut message = DynamicMessage::new(Arc::clone(&pool), probe);

    held.set(pool.message(needs).field_by_name("must")?, Value::U32(1));
    message.set(
        pool.message(probe).field_by_name("needs")?,
        Value::Message(held),
    );

    Some(message)
}

// the unset value's bytes, as a peer of no such codec writes them
fn unset_bytes() -> Bytes {
    Bytes::from_static(&[0x3A, 0x02, 0x08, 0x01])
}

// a Probe whose needs is whole
fn whole() -> Probe {
    Probe {
        needs: MessageField::some(Needs {
            must: 1,
            shade: Shade::SHADE_LIGHT,
            ..Needs::default()
        }),
        ..Probe::default()
    }
}

// spec 17.2.4, 17.9.7
#[tokio::test]
async fn fails_a_call_whose_request_leaves_a_required_field_unset_before_anything_goes_and_sends_nothing()
 {
    let pair = pair().await.expect("a pair connected");
    let sent: Arc<Mutex<Vec<Bytes>>> = Arc::default();
    let sending = Arc::clone(&sent);
    let steps: Arc<Mutex<Vec<DebugEvent>>> = Arc::default();
    let hearing = Arc::clone(&steps);

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(RawCodec, RawCodec))
        .expect("echo resolved")
        .on(Arc::new(move |request, response: Response<RawCodec>| {
            locked(&sending).push(request.payload.clone());

            response.result(request.payload)
        }))
        .expect("echo registered");

    let manager = pair.client.services();

    manager.on_debug(Arc::new(
        move |_error: Option<&TracedError>, event: &DebugEvent| {
            locked(&hearing).push(event.clone());
        },
    ));

    // * the codec's own refusal, its writer's, as the value is written (spec 17.2, item 4)
    let refused = manager
        .get_request(&echo(), RequestDependencies::of(dynamic(), typed()))
        .expect("echo asked")
        .call(
            unset().expect("a Probe left unset"),
            RequestOptions::default(),
        )
        .expect("a call");
    let refused = tokio::time::timeout(PATIENCE, refused)
        .await
        .expect("failed at once");

    pair.settle().await;

    assert!(
        matches!(&refused, Err(CallError::Other(error)) if error.to_string() == WORDS),
        "its codec's refusal: {refused:?}"
    );

    // no call is made: no step told, nothing sent
    assert!(locked(&steps).is_empty(), "no step told");
    assert!(locked(&sent).is_empty(), "nothing sent");

    // a Probe whose needs is whole goes as ever
    let answered = manager
        .get_request(&echo(), RequestDependencies::of(typed(), typed()))
        .expect("echo asked")
        .call(whole(), RequestOptions::default())
        .expect("a call");
    let answered = tokio::time::timeout(PATIENCE, answered)
        .await
        .expect("answered within its patience");

    assert_eq!(answered.ok(), Some(whole()), "echoed");
    assert_eq!(
        *locked(&sent),
        [typed().encode(&whole()).expect("written")],
        "its bytes sent"
    );
}

#[tokio::test]
async fn fails_a_call_whose_result_leaves_a_required_field_unset_with_payload_undecodable() {
    let pair = pair().await.expect("a pair connected");

    // * a peer of no such codec answers what the codec refuses to read (spec 17.9.7)
    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(RawCodec, RawCodec))
        .expect("echo resolved")
        .on(Arc::new(|_request, response: Response<RawCodec>| {
            response.result(unset_bytes())
        }))
        .expect("echo registered");

    let failed = pair
        .client
        .services()
        .get_request(&echo(), RequestDependencies::of(typed(), typed()))
        .expect("echo asked")
        .call(Probe::default(), RequestOptions::default())
        .expect("a call");
    let failed = tokio::time::timeout(PATIENCE, failed)
        .await
        .expect("answered within its patience");
    let Err(CallError::Failure(failure)) = failed else {
        panic!("failed here: {failed:?}");
    };

    assert_eq!(
        (failure.protocol_code(), failure.scope()),
        (
            Some(ProtocolCode::PAYLOAD_UNDECODABLE),
            FailureScope::Protocol
        ),
        "its code"
    );
    assert_eq!(
        (failure.origin(), failure.side()),
        (FailureOrigin::Local, Some(RouterSide::Client)),
        "raised here, by the client"
    );
}

// spec 17.2.5, 17.9.7
#[tokio::test]
async fn answers_payload_undecodable_to_a_request_that_leaves_a_required_field_unset_before_its_resolver()
 {
    let pair = pair().await.expect("a pair connected");
    let resolved: Arc<Mutex<Vec<Probe>>> = Arc::default();
    let resolving = Arc::clone(&resolved);

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(typed(), typed()))
        .expect("echo resolved")
        .on(Arc::new(
            move |request, response: Response<ProtoCodec<Probe>>| {
                locked(&resolving).push(request.payload.clone());

                response.result(request.payload)
            },
        ))
        .expect("echo registered");

    // * a peer of no such codec sends what the codec refuses to read (spec 17.9.7)
    let failed = pair
        .client
        .services()
        .get_request(&echo(), RequestDependencies::of(RawCodec, RawCodec))
        .expect("echo asked")
        .call(unset_bytes(), RequestOptions::default())
        .expect("a call");
    let failed = tokio::time::timeout(PATIENCE, failed)
        .await
        .expect("answered within its patience");

    pair.settle().await;

    assert!(
        matches!(&failed, Err(CallError::Failure(failure)) if failure.protocol_code() == Some(ProtocolCode::PAYLOAD_UNDECODABLE)),
        "answered PAYLOAD_UNDECODABLE: {failed:?}"
    );
    assert!(locked(&resolved).is_empty(), "its resolver not called");
    assert!(locked(&pair.server_reports).is_empty(), "nothing reported");
}

#[tokio::test]
async fn answers_procedure_failed_to_a_result_that_leaves_a_required_field_unset_and_reports_it() {
    let pair = pair().await.expect("a pair connected");
    let left = unset().expect("a Probe left unset");

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(typed(), dynamic()))
        .expect("echo resolved")
        .on(Arc::new(
            move |_request, response: Response<DynamicCodec>| response.result(left.clone()),
        ))
        .expect("echo registered");

    let failed = pair
        .client
        .services()
        .get_request(&echo(), RequestDependencies::of(typed(), typed()))
        .expect("echo asked")
        .call(Probe::default(), RequestOptions::default())
        .expect("a call");
    let failed = tokio::time::timeout(PATIENCE, failed)
        .await
        .expect("answered within its patience");

    pair.settle().await;

    assert!(
        matches!(&failed, Err(CallError::Failure(failure)) if failure.protocol_code() == Some(ProtocolCode::PROCEDURE_FAILED)),
        "answered PROCEDURE_FAILED: {failed:?}"
    );

    // * reported in the codec's words, its writer's (spec 17.2, item 5)
    let reports: Vec<String> = locked(&pair.server_reports)
        .iter()
        .map(|(error, _)| error.to_string())
        .collect();

    assert_eq!(reports, [WORDS], "reported once");
}
