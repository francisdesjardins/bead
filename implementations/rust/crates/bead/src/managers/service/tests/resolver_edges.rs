//! Client command resolvers, raw failures and errors passed back to the router.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::resolver::resolving;
use super::{ClientFixture, Fixture, Recording, header, locked, props};
use crate::constants::{ProcedureKind, ProtocolCode, RouterSide};
use crate::debug::{DebugDirection, DebugType};
use crate::envelope::{Envelope, RequestHeader};
use crate::errors::ResolverError;
use crate::failure::Failure;
use crate::identity::Procedure;
use crate::managers::service::RequestResolverDependencies;
use crate::payloads::{CodecRefusal, JsonCodec, PayloadCodec, TextCodec};
use crate::router::admissions::BeforeRequest;
use crate::router::types::RouterError;
use crate::testing::pair::echo;
use crate::testing::scripted::{Sending, handle_of};

#[tokio::test]
async fn a_request_is_answered_once_a_second_answer_is_a_programmer_error_and_sends_nothing() {
    let fixture = Fixture::new();
    let recording = Arc::new(Recording::default());
    let second = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&second);
    let resolver = crate::managers::service::Resolving {
        manager: Arc::clone(&fixture.manager.inner),
        admit: None,
        procedure: echo(),
        request: JsonCodec,
        result: Arc::new(JsonCodec),
        validate: None,
        fail_fast: false,
        callback: Arc::new(move |request, response| {
            let hearing = Arc::clone(&hearing);
            Box::pin(async move {
                response.result(request.payload.clone()).await?;
                let result = response
                    .result(request.payload)
                    .await
                    .expect_err("a second result");
                let failure = response
                    .failure(&Failure::application(
                        core::num::NonZeroU16::new(1).expect("an application code"),
                        "",
                    ))
                    .await
                    .expect_err("a second answer as a failure");
                for error in [result, failure] {
                    let ResolverError::Other(error) = error else {
                        panic!("a programmer error");
                    };
                    locked(&hearing).push(error.is::<crate::errors::ProgrammerError>());
                }
                Ok(())
            })
        }),
        call_type: DebugType::Request,
        listed: None,
    };
    resolver
        .resolve(props(&recording, br#"{"text":"hi"}"#))
        .await
        .expect("the first answer");
    assert_eq!(
        recording.answers(),
        [crate::router::types::RouterAnswer::Result(
            Bytes::from_static(br#"{"text":"hi"}"#)
        )]
    );
    assert_eq!(*locked(&second), [true, true]);
}

#[tokio::test]
async fn may_be_a_refusal_of_admission_of_the_routers_side_with_a_detail() {
    let fixture = Fixture::new();
    for (refusal, expected) in [
        (
            Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Server),
            Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Server),
        ),
        (
            Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server)
                .saying("admins only"),
            Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server)
                .saying("admins only"),
        ),
        (
            Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Client),
            Failure::protocol(ProtocolCode::PROCEDURE_FAILED, RouterSide::Server),
        ),
    ] {
        let recording = Arc::new(Recording::default());
        let wrong_side = refusal.side() == Some(RouterSide::Client);
        let resolver = resolving(
            &fixture,
            Arc::new(move |_, response| response.failure(&refusal)),
        );
        let outcome = resolver.resolve(props(&recording, b"hi")).await;
        if wrong_side {
            let ResolverError::Other(error) = outcome.expect_err("a refusal from the other side")
            else {
                panic!("a programmer error");
            };
            assert!(error.is::<crate::errors::ProgrammerError>());
        } else {
            outcome.expect("the refusal answered");
        }
        assert_eq!(
            recording.answers(),
            [crate::router::types::RouterAnswer::Failure(
                expected.record()
            )]
        );
    }
}

fn command() -> Procedure {
    Procedure {
        procedure_kind: Some(ProcedureKind::Command),
        ..echo()
    }
}

#[tokio::test]
async fn get_command_resolver_runs_the_servers_request_registered_in_the_router_and_tells_debug_it_is_a_command()
 {
    let fixture = ClientFixture::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&seen);
    fixture.manager.on_debug(Arc::new(move |_, event| {
        locked(&hearing).push((event.direction, event.call_type));
    }));
    fixture
        .manager
        .get_command_resolver(
            &command(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("defined")
        .on(Arc::new(|request, response| {
            response.result(format!("{}!", request.payload))
        }))
        .expect("registered");
    fixture.transport.deliver(&Envelope::Request {
        header: RequestHeader {
            call_id: 2,
            ..header()
        },
        payload: Bytes::from_static(b"hi"),
    });
    fixture.clock.settle().await;
    assert!(
        matches!(&fixture.transport.envelopes()[0], Envelope::Result { payload, .. } if payload.as_ref() == b"hi!")
    );
    assert_eq!(
        *locked(&seen),
        [
            (DebugDirection::Rx, DebugType::Command),
            (DebugDirection::Tx, DebugType::Command)
        ]
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn on_a_clients_router_a_refusal_is_the_clients() {
    let fixture = ClientFixture::new();
    let mut dependencies = RequestResolverDependencies::new(JsonCodec, JsonCodec);
    dependencies.before_request = Some(BeforeRequest::new(|_| false, None));
    fixture
        .manager
        .get_command_resolver(&command(), dependencies)
        .expect("defined")
        .on(Arc::new(|_, _| panic!("a refusal keeps the callback out")))
        .expect("registered");
    for (call_id, payload) in [
        (2, b"{not json".as_slice()),
        (4, br#"{"text":"hi"}"#.as_slice()),
    ] {
        fixture.transport.deliver(&Envelope::Request {
            header: RequestHeader {
                call_id,
                ..header()
            },
            payload: Bytes::copy_from_slice(payload),
        });
    }
    fixture.clock.settle().await;
    let sent = fixture.transport.envelopes();
    assert_eq!(sent.len(), 2);
    for envelope in sent {
        assert!(
            matches!(envelope, Envelope::Failure { failure, .. } if failure == Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Client).record())
        );
    }
    fixture.router.dispose().await;
}

#[tokio::test]
async fn are_the_procedures_own_from_1_to_65535_and_nothing_outside() {
    let fixture = Fixture::new();
    let recording = Arc::new(Recording::default());
    for code in [1, 0x1000, 0xffff] {
        let resolver = resolving(
            &fixture,
            Arc::new(move |_, response| {
                response.failure(&Failure::application(
                    core::num::NonZeroU16::new(code).expect("a nonzero code"),
                    "",
                ))
            }),
        );
        resolver
            .resolve(props(&recording, b"hi"))
            .await
            .expect("answered");
    }
    assert_eq!(
        recording.answers(),
        [1, 0x1000, 0xffff].map(|code| crate::router::types::RouterAnswer::Failure(
            Failure::application(
                core::num::NonZeroU16::new(code).expect("a nonzero code"),
                ""
            )
            .record()
        ))
    );
    let consumer = crate::testing::surface::Consumer::new();
    consumer.accepts("pub fn check(code: core::num::NonZeroU16) -> bead::Failure { bead::Failure::application(code, \"\") }");
    for value in ["0", "0x10000", "1.5", "-1"] {
        consumer.refuses(
            &format!(
                "pub fn check() -> bead::Failure {{ bead::Failure::application({value}, \"\") }}"
            ),
            ("E0308", "mismatched types"),
        );
    }
    assert_eq!(core::num::NonZeroU16::new(0), None);
}

#[tokio::test]
async fn a_refusal_that_cannot_go_out_is_not_answered_again() {
    let fixture = Fixture::new();
    let error: Arc<dyn std::error::Error + Send + Sync> = Arc::new(std::io::Error::other("gone"));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&seen);
    fixture.router.on_error(Arc::new(move |error, _| {
        locked(&hearing).push(error.clone());
    }));
    let mut dependencies = RequestResolverDependencies::new(TextCodec, TextCodec);
    dependencies.before_request = Some(BeforeRequest::new(|_| false, None));
    fixture
        .manager
        .get_request_resolver(&echo(), dependencies)
        .expect("defined")
        .on(Arc::new(|_, _| panic!("a refusal keeps the callback out")))
        .expect("registered");
    fixture.transport.open(&handle_of(1), true);
    fixture.transport.send_as((
        &handle_of(1),
        Sending::Error(RouterError::Other(Arc::clone(&error))),
    ));
    fixture.transport.deliver(
        &Envelope::Request {
            header: header(),
            payload: Bytes::from_static(b"hi"),
        },
        &handle_of(1),
    );
    fixture.clock.settle().await;
    let sent = fixture.transport.take();
    assert_eq!(sent.len(), 1);
    assert!(
        matches!(&sent[0].1, Envelope::Failure { failure, .. } if failure.code == ProtocolCode::ACCESS_DENIED.get())
    );
    assert!(
        matches!(locked(&seen).as_slice(), [RouterError::Other(reason)] if Arc::ptr_eq(reason, &error))
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_callback_that_fails_before_it_answers_is_answered_as_failed_and_its_reason_goes_on_to_the_router()
 {
    let fixture = Fixture::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&seen);
    fixture.router.on_error(Arc::new(move |error, _| {
        locked(&hearing).push(error.to_string());
    }));
    fixture
        .manager
        .get_request_resolver(
            &echo(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("defined")
        .on(Arc::new(|_, _| panic!("thrown")))
        .expect("registered");
    fixture
        .manager
        .get_request_resolver(
            &Procedure {
                procedure_id: 2,
                ..echo()
            },
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("defined")
        .on(Arc::new(|_, _| {
            Box::pin(async { Err(ResolverError::other(std::io::Error::other("rejected"))) })
        }))
        .expect("registered");
    let mut dependencies = RequestResolverDependencies::new(TextCodec, TextCodec);
    dependencies.before_request = Some(BeforeRequest::new(|_| panic!("thrown"), None));
    fixture
        .manager
        .get_request_resolver(
            &Procedure {
                procedure_id: 3,
                ..echo()
            },
            dependencies,
        )
        .expect("defined")
        .on(Arc::new(|_, _| {
            panic!("an admission error keeps the callback out")
        }))
        .expect("registered");
    fixture.transport.open(&handle_of(1), true);
    for id in 1..=3 {
        fixture.transport.deliver(
            &Envelope::Request {
                header: RequestHeader {
                    call_id: 2 * u32::from(id) + 1,
                    procedure_id: id,
                    ..header()
                },
                payload: Bytes::from_static(b"hi"),
            },
            &handle_of(1),
        );
        fixture.clock.settle().await;
    }
    let seen = locked(&seen).clone();
    assert_eq!(seen.len(), 3);
    assert!(seen[0].contains("thrown"));
    assert_eq!(seen[1], "rejected");
    assert!(seen[2].contains("thrown"));
    let sent = fixture.transport.take();
    assert_eq!(sent.len(), 3);
    for (_, envelope) in sent {
        assert!(
            matches!(envelope, Envelope::Failure { failure, .. } if failure == Failure::protocol(ProtocolCode::PROCEDURE_FAILED, RouterSide::Server).record())
        );
    }
    fixture.router.dispose().await;
}

#[derive(Debug)]
struct Broken;

impl PayloadCodec for Broken {
    type Value = String;

    fn decode(&self, _payload: &Bytes) -> Result<String, CodecRefusal> {
        panic!("a codec that fails to read");
    }

    fn encode(&self, value: &String) -> Result<Bytes, CodecRefusal> {
        TextCodec.encode(value)
    }

    fn encoding(&self) -> &'static str {
        "text"
    }
}

#[tokio::test]
async fn a_payload_whose_codec_throws_other_than_its_refusal_is_answered_procedure_failed_with_no_detail_and_reported_never_reaching_the_callback()
 {
    let fixture = Fixture::new();
    let recording = Arc::new(Recording::default());
    let resolver = crate::managers::service::Resolving {
        manager: Arc::clone(&fixture.manager.inner),
        admit: None,
        procedure: echo(),
        request: Broken,
        result: Arc::new(TextCodec),
        validate: None,
        fail_fast: false,
        callback: Arc::new(|_, _| panic!("a broken codec never reaches the callback")),
        call_type: DebugType::Request,
        listed: None,
    };
    let error = resolver
        .resolve(props(&recording, b"hi"))
        .await
        .expect_err("the reason goes to the router");
    assert!(error.to_string().contains("a codec that fails to read"));
    assert_eq!(
        recording.answers(),
        [crate::router::types::RouterAnswer::Failure(
            Failure::protocol(ProtocolCode::PROCEDURE_FAILED, RouterSide::Server).record()
        )]
    );
}

// what the other sides' types refuse, this side refuses as it runs: a resolver answers a refusal of
// admission of its router's side or a failure of its own, and a routing failure is a programmer
// error, answered PROCEDURE_FAILED; a refusal of its admission that is no admission's is refused as
// the resolver is made
#[tokio::test]
async fn are_typed_a_refusal_of_admission_or_the_procedures_own_and_no_other() {
    let fixture = Fixture::new();
    for (answered, expected) in [
        (
            Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Server),
            Some(Failure::protocol(
                ProtocolCode::SESSION_REQUIRED,
                RouterSide::Server,
            )),
        ),
        (
            Failure::application(
                core::num::NonZeroU16::new(21).expect("an application code"),
                "",
            ),
            None,
        ),
        (
            Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server)
                .saying("admins only"),
            Some(
                Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server)
                    .saying("admins only"),
            ),
        ),
    ] {
        let recording = Arc::new(Recording::default());
        let failure = answered.clone();
        let resolver = resolving(
            &fixture,
            Arc::new(move |_, response| response.failure(&failure)),
        );
        resolver
            .resolve(props(&recording, b"hi"))
            .await
            .expect("answered as it is");
        assert_eq!(
            recording.answers(),
            [crate::router::types::RouterAnswer::Failure(
                expected.unwrap_or(answered).record()
            )]
        );
    }

    let recording = Arc::new(Recording::default());
    let resolver = resolving(
        &fixture,
        Arc::new(|_, response| {
            response.failure(&Failure::protocol(
                ProtocolCode::SERVICE_UNKNOWN,
                RouterSide::Server,
            ))
        }),
    );
    let ResolverError::Other(error) = resolver
        .resolve(props(&recording, b"hi"))
        .await
        .expect_err("a routing failure is the router's to answer")
    else {
        panic!("a programmer error");
    };
    assert!(error.is::<crate::errors::ProgrammerError>());
    assert_eq!(
        recording.answers(),
        [crate::router::types::RouterAnswer::Failure(
            Failure::protocol(ProtocolCode::PROCEDURE_FAILED, RouterSide::Server).record()
        )]
    );

    let mut dependencies = RequestResolverDependencies::new(TextCodec, TextCodec);
    dependencies.before_request = Some(BeforeRequest::new(
        |_| false,
        Some(Failure::protocol(
            ProtocolCode::PROCEDURE_UNKNOWN,
            RouterSide::Server,
        )),
    ));
    fixture
        .manager
        .get_request_resolver(
            &Procedure {
                procedure_id: 91,
                ..echo()
            },
            dependencies,
        )
        .expect_err("a refusal is an admission failure");
    fixture.router.dispose().await;
}
