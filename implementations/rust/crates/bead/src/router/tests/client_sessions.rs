//! A client's session announcements and the calls that explicitly present their token.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{
    Scripted, TIMEOUT, answered, failure_of, request_header_of, request_of, result_of, token,
};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope};
use crate::errors::CallError;
use crate::failure::FailureOrigin;
use crate::router::server::{Call, CallHooks};
use crate::router::types::{RequestCredential, RouterAnswer, TransportMessage};
use crate::session_token::SessionToken;

fn ask(scripted: &Scripted, credential: Option<RequestCredential>) -> Call {
    let mut request = request_of((None, TIMEOUT));
    request.options.credential = credential;
    scripted
        .router
        .request(Bytes::new(), (request, CallHooks::default()))
        .expect("a request")
}

#[tokio::test]
async fn fails_a_jwt_or_an_elsewhere_over_a_transport_not_secure_before_it_goes_destination_unreachable_where_a_call_presenting_none_or_opaque_goes()
 {
    let jwt = RequestCredential::Jwt("a.b.c".to_owned());
    let scripted = Scripted::with(&crate::router::client::RouterClientOptions {
        credential: Some(jwt.clone()),
        ..crate::router::client::RouterClientOptions::default()
    });
    scripted.transport.secure(false);
    for credential in [
        None,
        Some(RequestCredential::Elsewhere(
            "Bearer mF_9.B5f-4.1JqM".to_owned(),
        )),
    ] {
        let CallError::Failure(failure) = answered(ask(&scripted, credential))
            .await
            .expect_err("an insecure transport")
        else {
            panic!("a failure")
        };
        assert_eq!(failure.code(), ProtocolCode::DESTINATION_UNREACHABLE.get());
        assert_eq!(failure.origin(), FailureOrigin::Local);
    }
    assert_eq!(scripted.transport.sent(), Vec::<TransportMessage>::new());
    scripted
        .transport
        .deliver(&result_of(99, Some(Credential::Opaque(token()))));
    scripted.settle().await;
    let calls = [
        ask(&scripted, Some(RequestCredential::None)),
        ask(&scripted, Some(RequestCredential::Opaque)),
    ];
    scripted.settle().await;
    for call_id in [1, 3] {
        scripted.transport.deliver(&result_of(call_id, None));
    }
    for call in calls {
        answered(call).await.expect("a result");
    }
    assert_eq!(
        scripted
            .transport
            .envelopes()
            .iter()
            .map(|envelope| {
                let Envelope::Request { header, .. } = envelope else {
                    panic!("a request")
                };
                (header.call_id, header.credential.clone())
            })
            .collect::<Vec<_>>(),
        [(1, None), (3, Some(Credential::Opaque(token())))]
    );
    assert!(
        scripted
            .transport
            .sent()
            .iter()
            .all(|message| message.credential.is_none())
    );
    assert_eq!(scripted.router.credential(), Some(jwt));
}

#[tokio::test]
async fn reports_bytes_that_are_not_an_envelope_and_an_envelope_of_a_kind_it_does_not_take() {
    let scripted = Scripted::new();
    crate::testing::surface::Consumer::new().refuses("pub fn check() -> bead::TransportMessage { bead::TransportMessage { data: String::from(\"text\"), ..bead::TransportMessage::default() } }", ("E0308", "mismatched types"));
    for data in [
        Bytes::from_static(&[0x0a, 0x14]),
        Bytes::from_static(&[0xa1, 0x17, 0, 2, 0, 0, 0, 2]),
    ] {
        scripted.transport.deliver_message(&TransportMessage {
            data,
            ..TransportMessage::default()
        });
    }
    scripted.settle().await;
    assert_eq!(scripted.codes(), ["ENVELOPE_MALFORMED", "KIND_UNSUPPORTED"]);
}

#[tokio::test]
async fn dispose_lets_go_of_the_transport_rejects_what_still_waits_and_sends_nothing_more() {
    let scripted = Scripted::new();
    let handed = Arc::new(Mutex::new(Vec::new()));
    scripted
        .router
        .register_resolver((
            &crate::identity::Procedure {
                kind: Some(crate::constants::ProcedureKind::Command),
                ..crate::testing::pair::echo()
            },
            crate::router::core::Handler {
                resolve: super::keeping((&handed, None)),
                admit: None,
                maximum_payload_bytes: None,
                forwards_credentials: false,
                notifies: false,
            },
        ))
        .expect("a command resolver");
    scripted.transport.deliver(&Envelope::Request {
        header: request_header_of(2),
        payload: Bytes::new(),
    });
    scripted.settle().await;
    let answerer = Arc::clone(&super::locked(&handed)[0].answerer);
    let waiting = ask(&scripted, None);
    scripted.settle().await;
    assert_eq!(scripted.transport.listener_count(), 1);
    let sent = scripted.transport.sent().len();
    scripted.router.dispose().await;
    scripted.transport.deliver(&result_of(1, None));
    assert!(matches!(
        answered(waiting).await,
        Err(CallError::Disconnected(_))
    ));
    assert!(matches!(
        answered(ask(&scripted, None)).await,
        Err(CallError::Disconnected(_))
    ));
    assert!(matches!(
        answerer.respond(RouterAnswer::Result(Bytes::new())).await,
        Err(CallError::Disconnected(_))
    ));
    assert_eq!(scripted.transport.sent().len(), sent);
    assert_eq!(scripted.codes(), Vec::<String>::new());
    assert_eq!(scripted.transport.listener_count(), 0);
}

async fn required(call: Call) {
    let CallError::Failure(failure) = answered(call).await.expect_err("SESSION_REQUIRED") else {
        panic!("a failure")
    };
    assert_eq!(failure.code(), ProtocolCode::SESSION_REQUIRED.get());
    assert_eq!(failure.origin(), FailureOrigin::Local);
    assert_eq!(failure.side(), Some(RouterSide::Client));
}

#[tokio::test]
async fn learns_the_session_from_every_answer_paired_or_not_keeps_it_loses_it_and_presents_it_on_no_call_that_does_not_ask_for_it()
 {
    let scripted = Scripted::new();
    scripted
        .transport
        .deliver(&result_of(99, Some(Credential::Opaque(token()))));
    scripted.settle().await;
    assert_eq!(scripted.router.session_token(), Some(token()));
    assert_eq!(scripted.codes(), ["CALL_UNKNOWN"]);
    let first = ask(&scripted, None);
    scripted.settle().await;
    scripted.transport.deliver(&result_of(1, None));
    answered(first).await.expect("an answer");
    assert_eq!(scripted.router.session_token(), Some(token()));
    assert!(
        matches!(&scripted.transport.envelopes()[0], Envelope::Request { header, .. } if *header == request_header_of(1))
    );
    let second = ask(&scripted, None);
    scripted.settle().await;
    scripted.transport.deliver(&failure_of(
        3,
        (ProtocolCode::SESSION_REQUIRED, Some(Credential::None)),
    ));
    assert!(
        matches!(answered(second).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::SESSION_REQUIRED.get())
    );
    assert_eq!(scripted.router.session_token(), None);
    scripted
        .transport
        .deliver(&result_of(98, Some(Credential::Opaque(token()))));
    scripted.transport.close_connection();
    scripted.settle().await;
    assert_eq!(scripted.router.session_token(), None);
    scripted
        .transport
        .deliver(&result_of(97, Some(Credential::Opaque(token()))));
    scripted.transport.replace();
    scripted.settle().await;
    assert_eq!(scripted.router.session_token(), None);
    assert!(scripted.transport.envelopes().iter().all(|envelope| matches!(envelope, Envelope::Request { header, .. } if header.credential.is_none())));
}

#[tokio::test]
async fn presents_opaque_the_session_it_learned_on_a_call_that_asks_and_on_no_other_one_that_asks_before_any_session_fails_before_it_goes_session_required()
 {
    let scripted = Scripted::new();
    required(ask(&scripted, Some(RequestCredential::Opaque))).await;
    assert_eq!(scripted.transport.sent(), Vec::<TransportMessage>::new());
    scripted
        .transport
        .deliver(&result_of(99, Some(Credential::Opaque(token()))));
    scripted.settle().await;
    let mut calls = vec![
        ask(&scripted, Some(RequestCredential::Opaque)),
        ask(&scripted, None),
        ask(&scripted, Some(RequestCredential::None)),
    ];
    scripted.settle().await;
    let other = SessionToken::new([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
        .expect("another token");
    scripted
        .transport
        .deliver(&result_of(97, Some(Credential::Opaque(other))));
    scripted.settle().await;
    calls.push(ask(&scripted, Some(RequestCredential::Opaque)));
    scripted.settle().await;
    for call_id in [1, 3, 5, 7] {
        scripted.transport.deliver(&result_of(call_id, None));
    }
    for call in calls {
        answered(call).await.expect("a result");
    }
    assert_eq!(
        scripted
            .transport
            .envelopes()
            .iter()
            .map(|envelope| {
                let Envelope::Request { header, .. } = envelope else {
                    panic!("a request")
                };
                (header.call_id, header.credential.clone())
            })
            .collect::<Vec<_>>(),
        [
            (1, Some(Credential::Opaque(token()))),
            (3, None),
            (5, None),
            (7, Some(Credential::Opaque(other)))
        ]
    );
    scripted
        .transport
        .deliver(&result_of(95, Some(Credential::None)));
    scripted.settle().await;
    required(ask(&scripted, Some(RequestCredential::Opaque))).await;
    assert_eq!(scripted.transport.sent().len(), 4);
}
