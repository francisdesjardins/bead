//! A client's requests through its facade: call ids, answers, sessions, timers and send limits.

use core::future::Future;
use core::num::NonZeroU16;
use core::task::{Context, Waker};
use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{Scripted, TIMEOUT, answered, locked, request_header_of, request_of, result_of, token};
use crate::constants::{EnvelopeKind, FailureScope, ProtocolCode, RouterSide};
use crate::envelope::{
    ChunkHeader, Credential, Envelope, FailureHeader, FailureRecord, ResultHeader,
};
use crate::errors::CallError;
use crate::failure::{FailureOrigin, ProcedureAddress};
use crate::managers::service::{
    RequestDependencies, RequestOptions, ServiceManager, ServiceManagerOptions, ServiceRouter,
};
use crate::payloads::TextCodec;
use crate::router::client::{RouterClient, RouterClientOptions};
use crate::router::core::Side;
use crate::router::server::Call;
use crate::router::types::{LIMIT_DEFAULTS, RouterActivity, RouterError, RouterLimitsOptions};
use crate::testing::pair::echo;
use crate::testing::scripted::Sending;
use crate::transport::RouterClientTransport;

fn request(scripted: &Scripted, payload: &'static [u8]) -> Call {
    scripted
        .router
        .request(Bytes::from_static(payload), request_of((None, TIMEOUT)))
        .expect("a request")
}

#[tokio::test]
async fn takes_any_transport_of_this_package() {
    let scripted = Scripted::new();
    let transport: Arc<dyn RouterClientTransport> =
        Arc::<crate::testing::scripted::ScriptedClient>::clone(&scripted.transport);
    assert!(Arc::ptr_eq(&scripted.router.transport(), &transport));
    assert_eq!(scripted.router.session_token(), None);
    assert_eq!(
        scripted
            .router
            .owner()
            .run(|state| state.core().side)
            .await
            .expect("the router's side"),
        RouterSide::Client
    );
}

#[tokio::test]
async fn sends_a_request_on_an_odd_call_id_and_resolves_with_its_result() {
    let scripted = Scripted::new();
    let activity = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&activity);
    scripted
        .router
        .on_activity(Arc::new(move |what| locked(&hearing).push(what)));
    let asking = request(&scripted, &[1, 2]);
    scripted.settle().await;
    assert_eq!(
        scripted.transport.envelopes(),
        [Envelope::Request {
            header: request_header_of(1),
            payload: Bytes::from_static(&[1, 2])
        }]
    );
    scripted.transport.deliver(&Envelope::Result {
        header: ResultHeader {
            call_id: 1,
            total: None,
            credential: None,
        },
        payload: Bytes::from_static(&[9]),
    });
    let answer = answered(asking).await.expect("the result");
    scripted.settle().await;
    assert_eq!(
        answer.header,
        ResultHeader {
            call_id: 1,
            total: None,
            credential: None
        }
    );
    assert_eq!(answer.payload.as_ref(), [9]);
    assert_eq!(
        *locked(&activity),
        [RouterActivity::Request, RouterActivity::Response]
    );
    assert_eq!(scripted.codes(), Vec::<String>::new());
}

#[tokio::test]
async fn numbers_its_requests_1_3_and_pairs_each_result_with_its_own() {
    let scripted = Scripted::new();
    let first = request(&scripted, &[1]);
    let second = request(&scripted, &[2]);
    scripted.settle().await;
    assert_eq!(
        scripted.transport.calls(),
        [(EnvelopeKind::Request, 1), (EnvelopeKind::Request, 3)]
    );
    for (call_id, value) in [(3, 20), (1, 10)] {
        scripted.transport.deliver(&Envelope::Result {
            header: ResultHeader {
                call_id,
                total: None,
                credential: None,
            },
            payload: Bytes::from(vec![value]),
        });
    }
    assert_eq!(
        answered(first)
            .await
            .expect("the first's result")
            .payload
            .as_ref(),
        [10]
    );
    assert_eq!(
        answered(second)
            .await
            .expect("the second's result")
            .payload
            .as_ref(),
        [20]
    );
    assert_eq!(scripted.codes(), Vec::<String>::new());
}

#[tokio::test]
async fn rejects_with_the_failure_the_server_answers_as_the_servers() {
    let scripted = Scripted::new();
    let refused = request(&scripted, &[]);
    let failed = request(&scripted, &[]);
    scripted.settle().await;
    for (call_id, code, scope, detail) in [
        (
            1,
            ProtocolCode::PROCEDURE_UNKNOWN.get(),
            FailureScope::Protocol,
            "no procedure 1 in service 2",
        ),
        (
            3,
            NonZeroU16::new(21).expect("21"),
            FailureScope::Application,
            "out of range",
        ),
    ] {
        scripted.transport.deliver(&Envelope::Failure {
            header: FailureHeader {
                call_id,
                credential: None,
            },
            failure: FailureRecord {
                code,
                scope,
                detail: detail.to_owned(),
                relays: 0,
            },
        });
    }
    let CallError::Failure(protocol) = answered(refused).await.expect_err("a protocol failure")
    else {
        panic!("a failure")
    };
    assert_eq!(
        (
            protocol.code(),
            protocol.detail(),
            protocol.origin(),
            protocol.side()
        ),
        (
            ProtocolCode::PROCEDURE_UNKNOWN.get(),
            "no procedure 1 in service 2",
            FailureOrigin::Peer,
            Some(RouterSide::Server)
        )
    );
    let CallError::Failure(application) =
        answered(failed).await.expect_err("an application failure")
    else {
        panic!("a failure")
    };
    assert_eq!(
        (
            application.code().get(),
            application.procedure(),
            application.scope(),
            application.detail()
        ),
        (
            21,
            Some(ProcedureAddress {
                service_id: 2,
                procedure_id: 1
            }),
            FailureScope::Application,
            "out of range"
        )
    );
}

#[tokio::test]
async fn times_out_and_cancels_its_call_a_result_too_late_says_nothing_while_its_call_id_is_reserved()
 {
    let scripted = Scripted::new();
    let timeout = Duration::from_millis(10);
    let asking = scripted
        .router
        .request(Bytes::new(), request_of((None, timeout)))
        .expect("a request");
    scripted.settle().await;
    assert_eq!(scripted.clock.dues(), [timeout]);
    scripted.clock.advance(timeout).await;
    assert!(matches!(answered(asking).await, Err(CallError::TimedOut(given)) if given == timeout));
    assert_eq!(
        scripted.transport.calls(),
        [(EnvelopeKind::Request, 1), (EnvelopeKind::Cancel, 1)]
    );
    assert!(scripted.router.is_reserved(1).await);
    scripted.transport.deliver(&result_of(1, None));
    scripted.settle().await;
    assert_eq!(scripted.codes(), Vec::<String>::new());
    assert_eq!(scripted.clock.dues(), [timeout]);
    scripted.clock.advance(timeout).await;
    assert!(!scripted.router.is_reserved(1).await);
    scripted.transport.deliver(&result_of(1, None));
    scripted.settle().await;
    assert_eq!(scripted.codes(), ["CALL_UNKNOWN"]);
}

#[tokio::test]
async fn learns_the_session_from_a_results_opening_before_the_rest_of_its_transfer_comes() {
    let scripted = Scripted::new();
    let mut asking = Box::pin(request(&scripted, &[]));
    scripted.settle().await;
    scripted.transport.deliver(&Envelope::Result {
        header: ResultHeader {
            call_id: 1,
            total: Some(100),
            credential: Some(Credential::Opaque(token())),
        },
        payload: Bytes::from(vec![0; 16]),
    });
    scripted.settle().await;
    assert_eq!(scripted.router.session_token(), Some(token()));
    assert!(
        asking
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending(),
        "the transfer is still in flight"
    );
    scripted.transport.deliver(&Envelope::Chunk {
        header: ChunkHeader {
            call_id: 1,
            offset: 16,
            is_last: true,
        },
        payload: Bytes::from(vec![0; 84]),
    });
    let result = crate::testing::patience(super::PATIENCE, asking)
        .await
        .expect("the transfer settles")
        .expect("the result");
    assert_eq!(result.payload.as_ref(), [0; 100]);
    assert_eq!(scripted.codes(), Vec::<String>::new());
}

#[tokio::test]
async fn writes_the_destination_a_request_names_refuses_a_destination_of_0_and_writes_none_left_undefined()
 {
    let scripted = Scripted::new();
    let mut calls = Vec::new();
    for destination in [Some(7), None] {
        let mut request = request_of((None, TIMEOUT));
        request.options.destination_id = destination;
        calls.push(
            scripted
                .router
                .request(Bytes::new(), request)
                .expect("a destination"),
        );
    }
    let mut zero = request_of((None, TIMEOUT));
    zero.options.destination_id = Some(0);
    let refused = scripted
        .router
        .request(Bytes::new(), zero)
        .expect("a request future");
    assert!(
        matches!(answered(refused).await, Err(CallError::Refused(_))),
        "destination zero is a programmer error"
    );
    scripted.settle().await;
    assert_eq!(
        scripted.transport.envelopes(),
        [
            Envelope::Request {
                header: crate::envelope::RequestHeader {
                    destination_id: Some(7),
                    ..request_header_of(1)
                },
                payload: Bytes::new()
            },
            Envelope::Request {
                header: request_header_of(3),
                payload: Bytes::new()
            },
        ]
    );
    scripted.router.dispose().await;
    for call in calls {
        assert!(matches!(
            answered(call).await,
            Err(CallError::Disconnected(_))
        ));
    }
}

#[tokio::test]
async fn rejects_every_request_still_waiting_and_forgets_the_session_when_a_reconnection_starts() {
    let scripted = Scripted::new();
    let first = request(&scripted, &[]);
    scripted.settle().await;
    scripted
        .transport
        .deliver(&result_of(1, Some(Credential::Opaque(token()))));
    answered(first).await.expect("the first's result");
    assert_eq!(scripted.router.session_token(), Some(token()));
    let waiting = request(&scripted, &[]);
    scripted.settle().await;
    scripted.transport.replace();
    let CallError::Disconnected(reason) = answered(waiting)
        .await
        .expect_err("the replaced connection")
    else {
        panic!("a disconnect")
    };
    assert_eq!(reason, "the connection was replaced before the answer");
    assert_eq!(scripted.router.session_token(), None);
    assert_eq!(scripted.codes(), Vec::<String>::new());
}

#[tokio::test]
async fn rejects_when_the_transport_cannot_send_and_when_the_payload_is_too_large() {
    let scripted = Scripted::new();
    let refused: Arc<dyn std::error::Error + Send + Sync> =
        Arc::new(std::io::Error::other("not open"));
    scripted
        .transport
        .send_as(Sending::Error(RouterError::Other(Arc::clone(&refused))));
    let CallError::Other(actual) = answered(request(&scripted, &[]))
        .await
        .expect_err("the transport's refusal")
    else {
        panic!("the transport's error")
    };
    assert!(Arc::ptr_eq(&actual, &refused));
    scripted.transport.send_as(Sending::Taken);
    let asking = scripted
        .router
        .request(
            Bytes::from(vec![0; 0x100_0001]),
            request_of((None, TIMEOUT)),
        )
        .expect("a request");
    let CallError::Failure(failure) = answered(asking).await.expect_err("a payload too large")
    else {
        panic!("a failure")
    };
    assert_eq!(
        (failure.code(), failure.origin(), failure.side()),
        (
            ProtocolCode::PAYLOAD_TOO_LARGE.get(),
            FailureOrigin::Local,
            Some(RouterSide::Client)
        )
    );
    assert_eq!(scripted.transport.sent().len(), 1);
}

#[tokio::test]
async fn refuses_a_payload_that_would_go_as_a_transfer_where_it_sends_none_before_anything_goes_out()
 {
    let scripted = Scripted::with(&RouterClientOptions {
        limits: Some(RouterLimitsOptions {
            maximum_transfers: Some(0),
            ..RouterLimitsOptions::default()
        }),
        ..RouterClientOptions::default()
    });
    let services = ServiceManager::new(
        ServiceRouter::Client(scripted.router.clone()),
        &ServiceManagerOptions::default(),
    )
    .expect("a service manager");
    let requester = services
        .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("echo's requester");
    let asking = requester
        .call("x".repeat(2 * 1_048_576), &RequestOptions::default())
        .expect("a request");
    let CallError::Failure(failure) = crate::testing::patience(super::PATIENCE, asking)
        .await
        .expect("the refusal settles")
        .expect_err("no transfer is sent")
    else {
        panic!("a failure")
    };
    assert_eq!(
        (failure.code(), failure.origin(), failure.side()),
        (
            ProtocolCode::PAYLOAD_TOO_LARGE.get(),
            FailureOrigin::Local,
            Some(RouterSide::Client)
        )
    );
    assert!(failure.detail().contains("which this side sends none of"));
    assert_eq!(scripted.transport.sent().len(), 0);
}

#[tokio::test]
async fn requests_are_held_to_the_limits_the_router_is_built_with_which_must_hold_together_and_show_them()
 {
    let scripted = Scripted::with(&RouterClientOptions {
        limits: Some(RouterLimitsOptions {
            maximum_payload_bytes: Some(8),
            ..RouterLimitsOptions::default()
        }),
        ..RouterClientOptions::default()
    });
    assert_eq!(
        scripted.router.limits(),
        crate::router::types::RouterLimits {
            maximum_payload_bytes: 8,
            ..LIMIT_DEFAULTS
        }
    );
    let heard = Arc::new(Mutex::new(Vec::new()));
    let mut calls = Vec::new();
    for length in [9, 1] {
        let hearing = Arc::clone(&heard);
        calls.push(
            scripted
                .router
                .request(Bytes::from(vec![0; length]), {
                    let mut request = request_of((None, TIMEOUT));

                    request.on_sent = Some(Box::new(move |handed| {
                        locked(&hearing).push((length, handed));
                    }));
                    request
                })
                .expect("a request"),
        );
        if length == 9 {
            let CallError::Failure(failure) = answered(calls.pop().expect("the refused call"))
                .await
                .expect_err("nine exceeds eight")
            else {
                panic!("a failure")
            };
            assert_eq!(failure.code(), ProtocolCode::PAYLOAD_TOO_LARGE.get());
            assert_eq!(failure.detail(), "a payload is 8 bytes at most, not 9");
            assert_eq!(scripted.transport.sent().len(), 0);
        }
    }
    scripted.settle().await;
    assert_eq!(*locked(&heard), [(1, true)]);
    let call_id = scripted.transport.envelopes()[0].call_id();
    scripted.transport.deliver(&result_of(call_id, None));
    answered(calls.pop().expect("the accepted call"))
        .await
        .expect("the result");
    let listeners = scripted.transport.listener_count();
    RouterClient::new(
        Arc::<crate::testing::scripted::ScriptedClient>::clone(&scripted.transport),
        &RouterClientOptions {
            limits: Some(RouterLimitsOptions {
                chunk_bytes: Some(63),
                ..RouterLimitsOptions::default()
            }),
            ..RouterClientOptions::default()
        },
    )
    .expect_err("limits that do not hold together");
    assert_eq!(scripted.transport.listener_count(), listeners);
}
