//! Declarations are checked before their callbacks, cache conflicts and admission refusals.

use core::num::NonZeroU16;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{ClientFixture, Fixture, header, locked};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope, ResultHeader};
use crate::failure::Failure;
use crate::managers::service::{
    NotificationDependencies, NotificationResolverDependencies, RequestDependencies,
    RequestOptions, RequestResolverDependencies,
};
use crate::payloads::{JsonCodec, TextCodec};
use crate::router::admissions::BeforeRequest;
use crate::router::core::{AdmissionRequest, Carried};
use crate::router::types::{CallSession, RouterError};
use crate::testing::pair::echo;
use crate::testing::scripted::handle_of;

#[tokio::test]
async fn refuses_a_resolver_off_section_16_as_it_is_asked_for_before_its_callback_is_given() {
    let fixture = Fixture::new();
    let named = crate::identity::Procedure {
        procedure_name: "Echo".to_owned(),
        ..echo()
    };
    let ranged = crate::identity::Procedure {
        service_revision: 0,
        ..echo()
    };
    let request = fixture
        .manager
        .get_request_resolver(
            &named,
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect_err("the request's name is off its form");
    let command = fixture
        .manager
        .get_command_resolver(
            &named,
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect_err("the name is checked before the command's kind");
    let notification = fixture
        .manager
        .get_notification_resolver(
            &ranged,
            NotificationResolverDependencies::new(
                RequestResolverDependencies::new(TextCodec, TextCodec),
                TextCodec,
            ),
        )
        .expect_err("the notification's revision is out of its range");
    for error in [request, command] {
        assert!(error.to_string().contains(" is off its form: "));
    }
    assert!(notification.to_string().contains(" is out of its range: "));
    fixture
        .router
        .owner()
        .run(|state| assert!(locked(&state.core.resolvers).is_empty()))
        .await
        .expect("no callback is registered");
    assert_eq!(fixture.transport.take(), []);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn refuses_a_procedure_off_section_16_before_its_own_reason_a_notifications_asked_for_otherwise()
 {
    let fixture = ClientFixture::new();
    let dependencies =
        || NotificationDependencies::new(RequestDependencies::new(TextCodec, TextCodec), TextCodec);
    let notification = fixture
        .manager
        .get_notification(&echo(), dependencies())
        .expect("the notification is known");
    for (procedure, reason) in [
        (
            crate::identity::Procedure {
                procedure_name: "Echo".to_owned(),
                ..echo()
            },
            " is off its form: ",
        ),
        (
            crate::identity::Procedure {
                service_revision: 0,
                ..echo()
            },
            " is out of its range: ",
        ),
    ] {
        let error = fixture
            .manager
            .get_notification(&procedure, dependencies())
            .expect_err("the declaration's identity comes before its cache conflict");
        assert!(error.to_string().contains(reason), "{error}");
    }
    let same = fixture
        .manager
        .get_notification(&echo(), dependencies())
        .expect("the valid notification remains known");
    assert!(Arc::ptr_eq(&notification.as_like(), &same.as_like()));
    let renamed = crate::identity::Procedure {
        procedure_name: "other".to_owned(),
        ..echo()
    };
    let error = fixture
        .manager
        .get_notification(&renamed, dependencies())
        .expect_err("a valid declaration reaches the manager's cache conflict");
    assert!(error.to_string().contains("already a notification"));
    assert_eq!(fixture.transport.envelopes(), []);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_trigger_the_router_never_registered_is_a_programmer_error() {
    let fixture = ClientFixture::new();
    let notification = fixture
        .manager
        .get_notification(
            &echo(),
            NotificationDependencies::new(
                RequestDependencies::new(JsonCodec, JsonCodec),
                JsonCodec,
            ),
        )
        .expect("a notification, without a registration");
    let outcome = notification
        .as_like()
        .trigger(Bytes::from_static(br#"{"text":"stray"}"#));
    let Err(RouterError::Other(error)) = outcome else {
        panic!("an unregistered trigger is a programmer error");
    };
    assert!(error.is::<crate::errors::ProgrammerError>());
    assert_eq!(error.to_string(), "echo should not have been triggered");
    assert!(!fixture.router.has_notification(&notification.as_like()));
    assert_eq!(fixture.transport.envelopes(), []);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn the_same_procedure_asked_for_with_payloads_of_other_types_is_an_invalid_operation() {
    let fixture = ClientFixture::new();
    let first = fixture
        .manager
        .get_notification(
            &echo(),
            NotificationDependencies::new(
                RequestDependencies::new(JsonCodec, JsonCodec),
                JsonCodec,
            ),
        )
        .expect("the notification reads structured text");
    let error = fixture
        .manager
        .get_notification(
            &echo(),
            NotificationDependencies::new(
                RequestDependencies::new(TextCodec, TextCodec),
                TextCodec,
            ),
        )
        .expect_err("another payload type cannot name that same notification");
    assert_eq!(
        error.to_string(),
        "2/1 is already a notification of other payloads"
    );
    let same = fixture
        .manager
        .get_notification(
            &echo(),
            NotificationDependencies::new(
                RequestDependencies::new(JsonCodec, JsonCodec),
                JsonCodec,
            ),
        )
        .expect("the first notification remains known");
    assert!(Arc::ptr_eq(&first.as_like(), &same.as_like()));
    assert_eq!(fixture.transport.envelopes(), []);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_refusal_that_is_not_an_admission_of_the_routers_side_is_a_programmer_error_as_the_resolver_is_made()
 {
    let fixture = Fixture::new();
    for refusal in [
        Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Client),
        Failure::protocol(ProtocolCode::PROCEDURE_UNKNOWN, RouterSide::Server),
        Failure::application(NonZeroU16::new(33).expect("an application code"), ""),
    ] {
        let mut dependencies = RequestResolverDependencies::new(TextCodec, TextCodec);
        dependencies.before_request = Some(BeforeRequest::new(|_| false, Some(refusal)));
        let error = fixture
            .manager
            .get_request_resolver(&echo(), dependencies)
            .expect_err("only this side's admissions are refusals");
        assert_eq!(
            error.to_string(),
            "echo refuses with a failure that is not an admission's of the server's table"
        );
    }
    let mut dependencies = NotificationResolverDependencies::new(
        RequestResolverDependencies::new(TextCodec, TextCodec),
        TextCodec,
    );
    dependencies.before_request = Some(BeforeRequest::new(
        |_| false,
        Some(Failure::protocol(
            ProtocolCode::ACCESS_DENIED,
            RouterSide::Client,
        )),
    ));
    fixture
        .manager
        .get_notification_resolver(&echo(), dependencies)
        .expect_err("the notification's admission belongs to the other side");
    fixture
        .router
        .owner()
        .run(|state| assert!(locked(&state.core.resolvers).is_empty()))
        .await
        .expect("no callback is registered");
    fixture.router.dispose().await;
}

#[tokio::test]
async fn keeps_its_refusal_session_required_whatever_the_call_presented_for_its_router_to_answer() {
    for credential in [
        None,
        Some(Credential::Opaque(
            crate::SessionToken::new([1; 16]).expect("a token"),
        )),
        Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
        Some(Credential::Elsewhere),
    ] {
        let request = AdmissionRequest {
            connection_handle: handle_of(1),
            header: crate::envelope::RequestHeader {
                credential,
                ..header()
            },
            session: None,
            carried: None,
        };
        for refusal in [
            Some(Failure::protocol(
                ProtocolCode::SESSION_REQUIRED,
                RouterSide::Server,
            )),
            Some(
                Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Server)
                    .saying("sign in first"),
            ),
            None,
        ] {
            let expected = refusal.clone().unwrap_or_else(|| {
                Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server)
            });
            let admission = BeforeRequest::new(|_| false, refusal);
            let refused = admission.admission(RouterSide::Server)(&request)
                .expect("the admission settles")
                .expect("the request is refused");
            assert_eq!(refused.failure.record(), expected.record());
            assert_eq!(refused.failure.side(), expected.side());
            assert!(refused.by.is_none());
        }
    }
}

#[tokio::test]
async fn hands_before_request_the_connection_the_header_and_the_calls_session_alone_never_a_bearer_credential_its_call_came_with()
 {
    let handed = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&handed);
    let before = BeforeRequest::new(
        move |request| {
            locked(&hearing).push(request.clone());
            true
        },
        None,
    );
    let session = Arc::new(CallSession {
        data: Some(serde_json::json!("ada")),
        ..CallSession::default()
    });
    let header = crate::envelope::RequestHeader {
        credential: Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
        ..header()
    };
    assert!(
        before.admission(RouterSide::Server)(&AdmissionRequest {
            connection_handle: handle_of(1),
            header: header.clone(),
            session: Some(Arc::clone(&session)),
            carried: Some(Carried {
                header,
                transport_credential: Some("Bearer e".to_owned())
            }),
        })
        .expect("the admission settles")
        .is_none()
    );
    let handed = locked(&handed);
    assert_eq!(handed.len(), 1);
    let request = &handed[0];
    assert_eq!(request.connection_handle, handle_of(1));
    assert_eq!(
        request.header,
        crate::envelope::RequestHeader {
            credential: Some(Credential::Jwt(Bytes::new())),
            ..self::header()
        }
    );
    assert!(Arc::ptr_eq(
        request.session.as_ref().expect("its session"),
        &session
    ));
    drop(handed);
    crate::testing::surface::Consumer::new().refuses(
        "pub fn check(request: &bead::AdmissionRequest) { let _ = &request.carried; }",
        ("E0616", "private"),
    );
}

#[tokio::test]
async fn hands_the_router_a_procedures_payload_limit_with_its_requests_and_its_resolver_and_nothing_else_it_carries()
 {
    let fixture = Fixture::new();
    let limited = crate::identity::Procedure {
        maximum_payload_bytes: Some(64),
        procedure_kind: None,
        ..echo()
    };
    let declared = Arc::new(Mutex::new(Vec::new()));
    let declaring = Arc::clone(&declared);
    let called = Arc::new(Mutex::new(Vec::new()));
    let calling = Arc::clone(&called);
    fixture
        .router
        .observe_requester(crate::testing::scripted::RequesterProbe {
            declared: Arc::new(move |procedure, _| {
                locked(&declaring).push(procedure.clone());
            }),
            called: Arc::new(move |request| {
                locked(&calling).push(request.procedure.clone());
            }),
        });
    fixture
        .manager
        .get_request_resolver(
            &limited,
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("defined")
        .on(Arc::new(|_, _| Box::pin(async { Ok(()) })))
        .expect("registered");
    assert_eq!(
        super::admissions::handler(&fixture, 1)
            .await
            .maximum_payload_bytes,
        Some(64)
    );
    let requester = fixture
        .manager
        .get_request(&limited, RequestDependencies::new(TextCodec, TextCodec))
        .expect("declared");
    fixture.transport.open(&handle_of(1), true);
    let waiting = requester
        .call(
            "hi".to_owned(),
            &RequestOptions {
                connection_handle: Some(handle_of(1)),
                ..RequestOptions::default()
            },
        )
        .expect("a request");
    fixture.clock.settle().await;
    assert_eq!(
        locked(&declared).as_slice(),
        core::slice::from_ref(&limited)
    );
    assert_eq!(*locked(&called), [limited]);
    assert_eq!(
        fixture.transport.take(),
        [(
            handle_of(1),
            Envelope::Request {
                header: crate::envelope::RequestHeader {
                    call_id: 2,
                    ..header()
                },
                payload: Bytes::from_static(b"hi"),
            }
        )]
    );
    fixture.transport.deliver(
        &Envelope::Result {
            header: ResultHeader {
                call_id: 2,
                total: None,
                credential: None,
            },
            payload: Bytes::new(),
        },
        &handle_of(1),
    );
    fixture.clock.settle().await;
    assert_eq!(waiting.await.expect("answered"), "");
    fixture.router.dispose().await;
    // A Rust declaration has no dynamic properties to copy onto a handler.
    crate::testing::surface::Consumer::new().refuses(
        "pub fn check(mut procedure: bead::Procedure) { procedure.extra = \"kept here\"; }",
        ("E0609", "no field"),
    );
}
