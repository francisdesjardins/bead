//! A resolver's admission sees the header before decoding and keeps the callback out on refusal.

use core::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use bytes::Bytes;

use super::{Fixture, Recording, header, locked, props};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Envelope, FailureRecord};
use crate::failure::Failure;
use crate::managers::service::ResolverDependencies;
use crate::payloads::{JsonCodec, TextCodec};
use crate::router::admissions::BeforeRequest;
use crate::router::core::Handler;
use crate::router::types::RouterAnswer;
use crate::testing::pair::echo;
use crate::testing::scripted::handle_of;

async fn sent(fixture: &Fixture, (call_id, payload): (u32, &[u8])) -> Envelope {
    fixture.transport.deliver(
        &Envelope::Request {
            header: crate::envelope::RequestHeader {
                call_id,
                ..header()
            },
            payload: Bytes::copy_from_slice(payload),
        },
        &handle_of(1),
    );
    fixture.clock.settle().await;
    let mut sent = fixture.transport.take();
    assert_eq!(sent.len(), 1);
    sent.remove(0).1
}

fn failure(envelope: Envelope) -> FailureRecord {
    let Envelope::Failure { failure, .. } = envelope else {
        panic!("a refusal")
    };
    failure
}

async fn handler(fixture: &Fixture, procedure_id: u16) -> Arc<Handler> {
    fixture
        .router
        .owner()
        .run(move |state| {
            Arc::clone(
                &locked(&state.core.resolvers)
                    .get(&(2, procedure_id))
                    .expect("registered")
                    .handler,
            )
        })
        .await
        .expect("the router holds its handler")
}

#[tokio::test]
async fn a_request_before_request_refuses_is_answered_with_an_access_denied_seen_on_its_header_alone()
 {
    let fixture = Fixture::new();
    let handed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let reading = Arc::clone(&handed);
    let mut dependencies = ResolverDependencies::of(TextCodec, TextCodec);
    dependencies.before_request = Some(BeforeRequest::new(
        move |request| {
            locked(&reading).push((
                Arc::clone(&request.connection_handle),
                request.header.clone(),
                request.session.clone(),
            ));
            request.header.call_id == 9
        },
        None,
    ));
    fixture
        .manager
        .get_request_resolver(&echo(), dependencies)
        .expect("defined")
        .on(Arc::new(|request, response| {
            assert_eq!(request.payload, "allowed");
            response.result(request.payload)
        }))
        .expect("registered");
    fixture.transport.open(&handle_of(1), true);
    assert_eq!(
        failure(sent(&fixture, (7, b"refused")).await),
        Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server).record()
    );
    assert!(
        matches!(sent(&fixture, (9, b"allowed")).await, Envelope::Result { payload, .. } if payload.as_ref() == b"allowed")
    );
    assert_eq!(
        *locked(&handed),
        [
            (handle_of(1), header(), None),
            (
                handle_of(1),
                crate::envelope::RequestHeader {
                    call_id: 9,
                    ..header()
                },
                None
            ),
        ]
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn refuses_with_an_access_denied_what_is_not_admitted_with_true() {
    for admits in [false, true] {
        let fixture = Fixture::new();
        let mut dependencies = ResolverDependencies::of(TextCodec, TextCodec);
        dependencies.before_request = Some(BeforeRequest::new(move |_| admits, None));
        fixture
            .manager
            .get_request_resolver(&echo(), dependencies)
            .expect("defined")
            .on(Arc::new(|request, response| {
                response.result(request.payload)
            }))
            .expect("registered");
        fixture.transport.open(&handle_of(1), true);
        let answer = sent(&fixture, (7, b"hi")).await;
        if admits {
            assert!(
                matches!(answer, Envelope::Result { payload, .. } if payload.as_ref() == b"hi")
            );
        } else {
            assert_eq!(
                failure(answer),
                Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server).record()
            );
        }
        fixture.router.dispose().await;
    }
    let consumer = crate::testing::surface::Consumer::new();
    consumer.accepts(
        "pub fn check() -> bead::BeforeRequest { bead::BeforeRequest::new(|_| true, None) }",
    );
    consumer.refuses(
        "pub fn check() -> bead::BeforeRequest { bead::BeforeRequest::new(|_| (), None) }",
        ("E0308", "mismatched types"),
    );
    consumer.refuses("pub fn check() -> bead::BeforeRequest { bead::BeforeRequest::new(|_| bead::Failure::protocol(bead::ProtocolCode::SESSION_REQUIRED, bead::RouterSide::Server), None) }", ("E0308", "mismatched types"));
}

#[tokio::test]
async fn refuses_with_the_refusal_a_before_request_carries_and_never_reaches_the_callback() {
    for carries_refusal in [true, false] {
        let fixture = Fixture::new();
        let mut dependencies = ResolverDependencies::of(TextCodec, TextCodec);
        dependencies.before_request = Some(BeforeRequest::new(
            |_| false,
            carries_refusal
                .then(|| Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Server)),
        ));
        fixture
            .manager
            .get_request_resolver(&echo(), dependencies)
            .expect("defined")
            .on(Arc::new(|_, _| {
                panic!("a refusal never reaches the callback")
            }))
            .expect("registered");
        fixture.transport.open(&handle_of(1), true);
        let expected = if carries_refusal {
            ProtocolCode::SESSION_REQUIRED
        } else {
            ProtocolCode::ACCESS_DENIED
        };
        assert_eq!(
            failure(sent(&fixture, (7, b"hi")).await),
            Failure::protocol(expected, RouterSide::Server).record()
        );
        fixture.router.dispose().await;
    }
}

#[tokio::test]
async fn is_asked_before_the_payload_is_read_a_request_refused_is_refused_undecodable_and_never_traced()
 {
    let fixture = Fixture::new();
    let heard = fixture.heard();
    let mut dependencies = ResolverDependencies::of(JsonCodec, JsonCodec);
    dependencies.before_request = Some(BeforeRequest::new(|_| false, None));
    fixture
        .manager
        .get_request_resolver(&echo(), dependencies)
        .expect("defined")
        .on(Arc::new(|_, _| {
            panic!("a refusal never reaches the callback")
        }))
        .expect("registered");
    fixture.transport.open(&handle_of(1), true);
    assert_eq!(
        failure(sent(&fixture, (7, b"{not json")).await),
        Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server).record()
    );
    assert_eq!(locked(&heard).len(), 0);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn is_not_asked_again_of_a_request_its_router_admitted() {
    let fixture = Fixture::new();
    let admits = Arc::new(AtomicUsize::new(0));
    let called = Arc::clone(&admits);
    let mut dependencies = ResolverDependencies::of(TextCodec, TextCodec);
    dependencies.before_request = Some(BeforeRequest::new(
        move |_| {
            called.fetch_add(1, Ordering::SeqCst);
            false
        },
        None,
    ));
    fixture
        .manager
        .get_request_resolver(&echo(), dependencies)
        .expect("defined")
        .on(Arc::new(|request, response| {
            response.result(request.payload)
        }))
        .expect("registered");
    let recording = Arc::new(Recording::default());
    let handler = handler(&fixture, 1).await;
    (handler.resolve)(props(&recording, b"hi"))
        .await
        .expect("the admitted call resolves");
    assert_eq!(admits.load(Ordering::SeqCst), 0);
    assert_eq!(
        recording.answers(),
        [RouterAnswer::Result(Bytes::from_static(b"hi"))]
    );
    let consumer = crate::testing::surface::Consumer::new();
    consumer.refuses(
        "pub fn check(props: bead::RequestProps<String>) -> bool { props.is_admitted }",
        ("E0609", "no field `is_admitted`"),
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn is_the_resolvers_to_answer_for_its_router_nothing_admits_a_failure_refuses_a_throw_goes_on()
 {
    let fixture = Fixture::new();
    let admission = crate::router::core::AdmissionRequest {
        connection_handle: handle_of(1),
        header: header(),
        session: None,
        carried: None,
    };
    for (id, before) in [
        (1, None),
        (2, Some(BeforeRequest::new(|_| true, None))),
        (3, Some(BeforeRequest::new(|_| false, None))),
        (
            4,
            Some(BeforeRequest::new(
                |_| false,
                Some(Failure::protocol(
                    ProtocolCode::SESSION_REQUIRED,
                    RouterSide::Server,
                )),
            )),
        ),
        (5, Some(BeforeRequest::new(|_| panic!("thrown"), None))),
    ] {
        let mut dependencies = ResolverDependencies::of(TextCodec, TextCodec);
        dependencies.before_request = before;
        fixture
            .manager
            .get_request_resolver(&crate::identity::Procedure { id, ..echo() }, dependencies)
            .expect("defined")
            .on(Arc::new(|_, _| Box::pin(async { Ok(()) })))
            .expect("registered");
        let handler = handler(&fixture, id).await;
        let outcome = handler
            .admit
            .as_ref()
            .map(|admit| admit(&admission))
            .transpose();
        match id {
            1 | 2 => assert!(outcome.expect("admitted").flatten().is_none()),
            3 | 4 => {
                let refused = outcome.expect("refused").flatten().expect("a refusal");
                let code = if id == 3 {
                    ProtocolCode::ACCESS_DENIED
                } else {
                    ProtocolCode::SESSION_REQUIRED
                };
                assert_eq!(
                    refused.failure.record(),
                    Failure::protocol(code, RouterSide::Server).record()
                );
            }
            5 => assert!(
                outcome
                    .expect_err("an admission error goes to its router")
                    .to_string()
                    .contains("thrown")
            ),
            _ => panic!("the five outcomes"),
        }
    }
    fixture.router.dispose().await;
}
