//! A server's connection token provider: one announcement, failed answers, and OPAQUE commands.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::server::{Served, first, request_of, second};
use super::{answered, locked, options_of, result_of, token};
use crate::RouterRequest;
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope, RequestHeader, ResultHeader};
use crate::errors::CallError;
use crate::failure::FailureOrigin;
use crate::managers::service::{RequestResolverDependencies, Response};
use crate::payloads::TextCodec;
use crate::router::server::RouterServerOptions;
use crate::router::types::{RequestCredential, RouterError};
use crate::testing::core_port::error_of;
use crate::testing::pair::echo;

fn resolve(served: &Served) {
    served
        .services
        .get_request_resolver(
            &echo(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("echo resolved")
        .on(Arc::new(|request, response: Response<TextCodec>| {
            response.result(format!("{}!", request.payload))
        }))
        .expect("echo registered");
}

#[tokio::test]
async fn requests_go_to_the_resolver_registered_which_answers_on_their_call_id_announcing_the_session_once()
 {
    let served = Served::new(&RouterServerOptions {
        session_token_of: Some(Arc::new(|handle| Ok((*handle == first()).then(token)))),
        ..RouterServerOptions::default()
    });
    resolve(&served);
    for (handle, id, payload) in [
        (first(), 31, "hi"),
        (first(), 33, "ho"),
        (second(), 31, "hu"),
    ] {
        served
            .transport
            .deliver(&request_of((id, &echo(), payload)), &handle);
    }
    served.settle().await;
    assert_eq!(
        served.transport.take(),
        [
            (
                first(),
                Envelope::Result {
                    header: ResultHeader {
                        call_id: 31,
                        total: None,
                        credential: Some(Credential::Opaque(token()))
                    },
                    payload: Bytes::from_static(b"hi!")
                }
            ),
            (
                first(),
                Envelope::Result {
                    header: ResultHeader {
                        call_id: 33,
                        total: None,
                        credential: None
                    },
                    payload: Bytes::from_static(b"ho!")
                }
            ),
            (
                second(),
                Envelope::Result {
                    header: ResultHeader {
                        call_id: 31,
                        total: None,
                        credential: None
                    },
                    payload: Bytes::from_static(b"hu!")
                }
            ),
        ]
    );
    assert_eq!(served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn requests_whose_answers_session_cannot_be_told_are_answered_by_nothing_and_reported() {
    let error = error_of("no session");
    let failed = error.clone();
    let served = Served::new(&RouterServerOptions {
        session_token_of: Some(Arc::new(move |_| Err(failed.clone()))),
        ..RouterServerOptions::default()
    });
    resolve(&served);
    served
        .transport
        .deliver(&request_of((1, &echo(), "")), &first());
    served.settle().await;
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(served.reported(), ["no session first"]);
    let reports = locked(&served.reports);
    assert!(
        matches!((&error, &reports[0].0), (RouterError::Other(expected),RouterError::Other(actual)) if Arc::ptr_eq(expected, actual))
    );
    drop(reports);
}

#[tokio::test]
async fn its_own_requests_present_opaque_when_they_ask_their_connections_session_as_session_token_of_gives_it_and_fail_before_they_go_session_required_when_it_has_none()
 {
    let held = Arc::new(Mutex::new(None));
    let holding = Arc::clone(&held);
    let served = Served::new(&RouterServerOptions {
        session_token_of: Some(Arc::new(move |handle| {
            Ok(if *handle == first() {
                *locked(&holding)
            } else {
                None
            })
        })),
        ..RouterServerOptions::default()
    });
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    let present = |handle| {
        let mut options = options_of(Duration::from_secs(5));
        options.connection_handle = Some(handle);
        options.credential = Some(RequestCredential::Opaque);
        served
            .router
            .request(
                Bytes::new(),
                RouterRequest {
                    procedure: echo(),
                    options,
                    series: None,
                    refusal: None,
                    subscribes: None,
                    on_call_id: None,
                    on_sent: None,
                },
            )
            .expect("an OPAQUE command")
    };
    for handle in [first(), second()] {
        if handle == second() {
            *locked(&held) = Some(token());
        }
        assert!(
            matches!(answered(present(handle)).await, Err(CallError::Failure(failure))
            if failure.code() == ProtocolCode::SESSION_REQUIRED.get()
                && failure.origin() == FailureOrigin::Local && failure.side() == Some(RouterSide::Server))
        );
    }
    assert_eq!(served.transport.take(), Vec::new());
    let asking = present(first());
    served.settle().await;
    served.transport.deliver(&result_of(2, None), &first());
    answered(asking).await.expect("answered on its connection");
    assert_eq!(
        served.transport.take(),
        [(
            first(),
            Envelope::Request {
                header: RequestHeader {
                    credential: Some(Credential::Opaque(token())),
                    ..super::request_header_of(2)
                },
                payload: Bytes::new()
            }
        )]
    );
    assert_eq!(served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn a_token_provider_that_panics_fails_only_its_answer_and_the_next_answer_can_announce() {
    let called = Arc::new(core::sync::atomic::AtomicBool::new(false));
    let calling = Arc::clone(&called);
    let served = Served::new(&RouterServerOptions {
        session_token_of: Some(Arc::new(move |_| {
            assert!(
                calling.swap(true, core::sync::atomic::Ordering::SeqCst),
                "no session"
            );
            Ok(Some(token()))
        })),
        ..RouterServerOptions::default()
    });
    resolve(&served);
    served
        .transport
        .deliver(&request_of((1, &echo(), "hi")), &first());
    served.settle().await;
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(locked(&served.reports).len(), 1);
    served
        .transport
        .deliver(&request_of((3, &echo(), "ho")), &first());
    served.settle().await;
    assert_eq!(
        served.transport.take(),
        [(
            first(),
            Envelope::Result {
                header: ResultHeader {
                    call_id: 3,
                    total: None,
                    credential: Some(Credential::Opaque(token()))
                },
                payload: Bytes::from_static(b"ho!")
            }
        )]
    );
}
