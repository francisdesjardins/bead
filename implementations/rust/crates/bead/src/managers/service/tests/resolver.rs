//! A resolver's decoded request, application answers, failures and trace.

use core::time::Duration;
use std::sync::Arc;

use bytes::Bytes;

use super::{Fixture, Recording, header, locked, props};
use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::debug::{DebugDirection, DebugType};
use crate::envelope::{Envelope, FailureRecord};
use crate::errors::{CallError, ResolverError};
use crate::failure::Failure;
use crate::managers::service::{RequestResolverDependencies, ResolverCallback, Resolving};
use crate::payloads::{CodecRefusal, JsonCodec, PayloadCodec, TextCodec};
use crate::router::types::{RouterAnswer, SignalReason};
use crate::testing::pair::echo;
use crate::testing::scripted::handle_of;

pub(super) fn resolving(
    fixture: &Fixture,
    callback: ResolverCallback<TextCodec, TextCodec>,
) -> Resolving<TextCodec, TextCodec> {
    Resolving {
        manager: Arc::clone(&fixture.manager.inner),
        procedure: echo(),
        request: TextCodec,
        result: Arc::new(TextCodec),
        validate: None,
        fail_fast: false,
        callback,
        call_type: DebugType::Request,
        listed: None,
    }
}

fn failed(code: ProtocolCode) -> RouterAnswer {
    RouterAnswer::Failure(Failure::protocol(code, RouterSide::Server).record())
}

fn application(code: u16, detail: &str) -> Failure {
    Failure::application(
        core::num::NonZeroU16::new(code).expect("a nonzero code"),
        detail,
    )
}

#[tokio::test]
async fn makes_and_registers_the_resolver_only_once_it_is_given_its_callback() {
    let fixture = Fixture::new();
    let define = fixture
        .manager
        .get_request_resolver(
            &echo(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("a definition");
    assert_eq!(define.procedure.procedure_name, "echo");
    assert_eq!(define.procedure.procedure_id, 1);
    fixture.transport.open(&handle_of(1), true);
    fixture.transport.deliver(
        &Envelope::Request {
            header: header(),
            payload: Bytes::from_static(b"hi"),
        },
        &handle_of(1),
    );
    fixture.clock.settle().await;
    assert!(
        matches!(&fixture.transport.take()[0].1, Envelope::Failure { failure, .. } if failure.code == ProtocolCode::SERVICE_UNKNOWN.get())
    );
    define
        .on(Arc::new(|request, response| {
            response.result(request.payload)
        }))
        .expect("registered with its callback");
    fixture.transport.deliver(
        &Envelope::Request {
            header: header(),
            payload: Bytes::from_static(b"hi"),
        },
        &handle_of(1),
    );
    fixture.clock.settle().await;
    assert!(
        matches!(&fixture.transport.take()[0].1, Envelope::Result { payload, .. } if payload.as_ref() == b"hi")
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn hands_the_callback_a_decoded_request_and_sends_its_answer_back() {
    let fixture = Fixture::new();
    let recording = Arc::new(Recording::default());
    let resolver = resolving(
        &fixture,
        Arc::new(|request, response| {
            assert_eq!(request.payload, "hi");
            assert_eq!(request.connection_handle, handle_of(1));
            assert_eq!(request.header, header());
            response.result(format!("{}!", request.payload))
        }),
    );
    resolver
        .resolve(props(&recording, b"hi"))
        .await
        .expect("resolved");
    assert_eq!(
        recording.answers(),
        [RouterAnswer::Result(Bytes::from_static(b"hi!"))]
    );
}

#[tokio::test]
async fn hands_the_callback_the_signal_of_its_call_which_its_cancel_aborts() {
    let fixture = Fixture::new();
    let recording = Arc::new(Recording::default());
    let request = props(&recording, b"hi");
    let signal = request.signal.clone();
    let resolver = resolving(
        &fixture,
        Arc::new(move |request, response| {
            assert!(!request.signal.is_aborted());
            signal.abort(SignalReason::Cancelled);
            assert!(request.signal.is_aborted());
            response.result("late".to_owned())
        }),
    );
    resolver.resolve(request).await.expect("resolved");
    assert_eq!(
        recording.answers(),
        [RouterAnswer::Result(Bytes::from_static(b"late"))]
    );
}

#[tokio::test]
async fn an_answer_with_a_failure_of_the_procedures_own_sends_it_as_the_applications() {
    let fixture = Fixture::new();
    let recording = Arc::new(Recording::default());
    let failure = application(7, "why");
    let resolver = resolving(
        &fixture,
        Arc::new(move |_, response| response.failure(&failure)),
    );
    resolver
        .resolve(props(&recording, b"hi"))
        .await
        .expect("resolved");
    assert_eq!(
        recording.answers(),
        [RouterAnswer::Failure(application(7, "why").record())]
    );
}

#[tokio::test]
async fn a_payload_that_does_not_decode_is_answered_as_undecodable_its_reason_as_its_detail_never_reaching_the_callback()
 {
    let fixture = Fixture::new();
    let recording = Arc::new(Recording::default());
    let resolver = Resolving {
        manager: Arc::clone(&fixture.manager.inner),
        procedure: echo(),
        request: JsonCodec,
        result: Arc::new(TextCodec),
        validate: None,
        fail_fast: false,
        callback: Arc::new(|_, _| panic!("an undecodable request never reaches the callback")),
        call_type: DebugType::Request,
        listed: None,
    };
    resolver
        .resolve(props(&recording, b"{not json"))
        .await
        .expect("refused");
    assert_eq!(
        recording.answers(),
        [RouterAnswer::Failure(
            Failure::protocol(ProtocolCode::PAYLOAD_UNDECODABLE, RouterSide::Server)
                .saying("not JSON".to_owned())
                .record()
        )]
    );
}

#[tokio::test]
async fn a_callback_that_fails_after_it_answered_is_not_answered_again() {
    let fixture = Fixture::new();
    let recording = Arc::new(Recording::default());
    let resolver = resolving(
        &fixture,
        Arc::new(|request, response| {
            Box::pin(async move {
                response.result(request.payload).await?;
                Err(ResolverError::other(std::io::Error::other("after")))
            })
        }),
    );
    let error = resolver
        .resolve(props(&recording, b"hi"))
        .await
        .expect_err("the error reaches the router");
    assert_eq!(error.to_string(), "after");
    assert_eq!(
        recording.answers(),
        [RouterAnswer::Result(Bytes::from_static(b"hi"))]
    );
}

#[tokio::test]
async fn an_answer_the_router_cannot_send_is_answered_as_failed_and_the_callback_hears_why() {
    let fixture = Fixture::new();
    let recording = Arc::new(Recording::default());
    let refusal = CallError::Failure(Failure::protocol(
        ProtocolCode::PAYLOAD_TOO_LARGE,
        RouterSide::Server,
    ));
    *locked(&recording.refuse_payload) = Some(refusal.clone());
    let resolver = resolving(
        &fixture,
        Arc::new(move |request, response| {
            let refusal = refusal.clone();
            Box::pin(async move {
                let error = response
                    .result(request.payload)
                    .await
                    .expect_err("the router refuses");
                assert_eq!(error.to_string(), refusal.to_string());
                Ok(())
            })
        }),
    );
    resolver
        .resolve(props(&recording, b"hi"))
        .await
        .expect("resolved");
    assert_eq!(
        recording.answers(),
        [failed(ProtocolCode::PROCEDURE_FAILED)]
    );
    assert_eq!(locked(&recording.attempts).len(), 2);
}

#[tokio::test]
async fn tells_an_answer_its_router_cannot_send_again_at_its_start_with_why_beside_it() {
    let fixture = Fixture::new();
    let heard = fixture.heard();
    let recording = Arc::new(Recording::default());
    *locked(&recording.refuse_payload) = Some(CallError::Failure(Failure::protocol(
        ProtocolCode::PAYLOAD_TOO_LARGE,
        RouterSide::Server,
    )));
    *locked(&recording.delay) = Some((Arc::clone(&fixture.clock), Duration::from_millis(5)));
    let clock = Arc::clone(&fixture.clock);
    let resolver = resolving(
        &fixture,
        Arc::new(move |request, response| {
            let clock = Arc::clone(&clock);
            Box::pin(async move {
                clock.advance(Duration::from_millis(10)).await;
                response
                    .result(request.payload)
                    .await
                    .expect_err("the callback hears the refusal");
                Ok(())
            })
        }),
    );
    resolver
        .resolve(props(&recording, b"hi"))
        .await
        .expect("resolved");
    let heard = locked(&heard).clone();
    assert_eq!(
        heard
            .iter()
            .map(|(error, step)| (
                step.direction,
                error.is_some(),
                step.started_at,
                step.duration
            ))
            .collect::<Vec<_>>(),
        [
            (DebugDirection::Rx, false, 1_767_225_600_000, None),
            (DebugDirection::Tx, false, 1_767_225_600_000, Some(10)),
            (DebugDirection::Tx, true, 1_767_225_600_000, Some(15)),
        ]
    );
    for (_, event) in &heard[1..] {
        assert_eq!(
            event
                .tx
                .as_ref()
                .expect("an answer")
                .as_ref()
                .as_any()
                .downcast_ref::<String>(),
            Some(&"hi".to_owned())
        );
    }
    assert!(
        heard[2]
            .0
            .as_ref()
            .expect("a refusal")
            .contains("PAYLOAD_TOO_LARGE")
    );
    assert_eq!(
        recording.answers(),
        [failed(ProtocolCode::PROCEDURE_FAILED)]
    );
}

#[tokio::test]
async fn tells_nothing_more_than_its_request_for_a_callback_that_fails_on_its_signal_its_call_cancelled_or_gone_with_its_connection()
 {
    let fixture = Fixture::new();
    let heard = fixture.heard();
    let recording = Arc::new(Recording::default());
    let resolver = resolving(
        &fixture,
        Arc::new(|request, _| {
            request.signal.abort(SignalReason::Cancelled);
            Box::pin(async { Err(ResolverError::other(std::io::Error::other("cancelled"))) })
        }),
    );
    resolver
        .resolve(props(&recording, b"hi"))
        .await
        .expect_err("the router hears cancellation");
    assert_eq!(
        locked(&heard)
            .iter()
            .map(|(error, step)| (step.direction, step.call_type, error.is_some()))
            .collect::<Vec<_>>(),
        [(DebugDirection::Rx, DebugType::Request, false)]
    );
}

#[tokio::test]
async fn traces_an_application_failure_as_the_answer_with_its_request_and_duration() {
    let fixture = Fixture::new();
    let heard = fixture.heard();
    let recording = Arc::new(Recording::default());
    let clock = Arc::clone(&fixture.clock);
    let resolver = resolving(
        &fixture,
        Arc::new(move |_, response| {
            let clock = Arc::clone(&clock);
            Box::pin(async move {
                clock.advance(Duration::from_millis(30)).await;
                response.failure(&application(7, "why")).await
            })
        }),
    );
    resolver
        .resolve(props(&recording, b"hi"))
        .await
        .expect("resolved");
    let heard = locked(&heard).clone();
    assert_eq!(
        heard
            .iter()
            .map(|(error, event)| (
                error.is_none(),
                event.direction,
                event.duration,
                event.started_at
            ))
            .collect::<Vec<_>>(),
        [
            (true, DebugDirection::Rx, None, 1_767_225_600_000),
            (true, DebugDirection::Tx, Some(30), 1_767_225_600_000),
        ]
    );
    for (_, event) in &heard {
        assert_eq!(
            (
                event.call_id,
                event.connection_handle.clone(),
                event.call_type
            ),
            (Some(7), Some(handle_of(1)), DebugType::Request)
        );
        assert_eq!(
            event
                .rx
                .as_ref()
                .expect("the request")
                .as_ref()
                .as_any()
                .downcast_ref::<String>(),
            Some(&"hi".to_owned())
        );
    }
    let failure = heard[1]
        .1
        .tx
        .as_ref()
        .expect("the answer")
        .as_ref()
        .as_any()
        .downcast_ref::<FailureRecord>()
        .expect("a failure");
    assert_eq!(
        (failure.code.get(), failure.scope, failure.detail.as_str()),
        (7, FailureScope::Application, "why")
    );
    assert_eq!(
        recording.answers(),
        [RouterAnswer::Failure(failure.clone())]
    );
}

#[derive(Debug)]
struct Unwritable;

impl PayloadCodec for Unwritable {
    type Value = String;
    fn decode(&self, bytes: &Bytes) -> Result<String, CodecRefusal> {
        TextCodec.decode(bytes)
    }
    fn encode(&self, _value: &String) -> Result<Bytes, CodecRefusal> {
        Err(CodecRefusal::new("cannot encode"))
    }
    fn encoding(&self) -> &'static str {
        "text"
    }
}

#[tokio::test]
async fn an_answer_that_cannot_go_out_leaves_the_request_to_be_answered_as_failed() {
    let fixture = Fixture::new();
    let recording = Arc::new(Recording::default());
    let resolver = Resolving {
        manager: Arc::clone(&fixture.manager.inner),
        procedure: echo(),
        request: TextCodec,
        result: Arc::new(Unwritable),
        validate: None,
        fail_fast: false,
        callback: Arc::new(|request, response| response.result(request.payload)),
        call_type: DebugType::Request,
        listed: None,
    };
    let error = resolver
        .resolve(props(&recording, b"hi"))
        .await
        .expect_err("cannot encode");
    assert_eq!(error.to_string(), "cannot encode");
    for failure in [
        Failure::protocol(ProtocolCode::SERVICE_UNKNOWN, RouterSide::Server),
        Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Client),
    ] {
        let resolver = resolving(
            &fixture,
            Arc::new(move |_, response| response.failure(&failure)),
        );
        resolver
            .resolve(props(&recording, b"hi"))
            .await
            .expect_err("an invalid answer");
    }
    crate::testing::surface::Consumer::new().refuses(
        "pub fn check() -> bead::Failure { bead::Failure::application(1.5, \"\") }",
        ("E0308", "mismatched types"),
    );
    assert_eq!(core::num::NonZeroU16::new(0), None);
    u16::try_from(0x1_0000_u32).expect_err("an application code fits u16");
    assert_eq!(
        recording.answers(),
        [
            failed(ProtocolCode::PROCEDURE_FAILED),
            failed(ProtocolCode::PROCEDURE_FAILED),
            failed(ProtocolCode::PROCEDURE_FAILED)
        ]
    );
}
