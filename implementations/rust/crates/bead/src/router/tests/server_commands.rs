//! A server's own commands: the connection named by each request, the even call ids drawn,
//! failures and timeouts, and what happens when a connection closes.

use core::time::Duration;
use std::sync::Arc;

use bytes::Bytes;

use super::server::{Served, first, news, second};
use super::{answered, failure_of, locked, options_of, result_of};
use crate::RouterRequest;
use crate::constants::{EnvelopeKind, ProcedureKind, ProtocolCode, RouterSide};
use crate::debug::{DebugDirection, DebugType};
use crate::envelope::{Envelope, RequestHeader, ResultHeader};
use crate::errors::CallError;
use crate::failure::FailureOrigin;
use crate::identity::Procedure;
use crate::managers::service::{CommandOptions, NotificationDependencies, RequestDependencies};
use crate::payloads::TextCodec;
use crate::router::server::{Call, RouterServerOptions};
use crate::router::types::{ConnectionHandle, TransportMessage};
use crate::testing::pair::echo;

fn command() -> Procedure {
    Procedure {
        procedure_kind: Some(ProcedureKind::Command),
        ..echo()
    }
}

fn request(handle: Option<&ConnectionHandle>, timeout: Duration) -> RouterRequest {
    let mut options = options_of(timeout);
    options.connection_handle = handle.cloned();
    RouterRequest {
        procedure: command(),
        options,
        series: None,
        refusal: None,
        subscribes: None,
        on_call_id: None,
        on_sent: None,
    }
}

fn ask(served: &Served, (handle, timeout): (&ConnectionHandle, Duration)) -> Call {
    served
        .router
        .request(Bytes::new(), request(Some(handle), timeout))
        .expect("a command")
}

#[tokio::test]
async fn tells_a_command_made_with_the_call_id_its_router_drew_on_its_connection() {
    let served = Served::new(&RouterServerOptions::default());
    let steps = Arc::new(std::sync::Mutex::new(Vec::new()));
    let hearing = Arc::clone(&steps);
    served.services.on_debug(Arc::new(move |error, event| {
        assert!(error.is_none());
        locked(&hearing).push((
            event.direction,
            event.call_type,
            event.call_id,
            event.connection_handle.clone(),
        ));
    }));
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    let command = served
        .services
        .get_command(&command(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("the command declared");
    let running = command
        .call(
            "run".to_owned(),
            &CommandOptions {
                timeout: Some(Duration::from_secs(1)),
                ..CommandOptions::new(second())
            },
        )
        .expect("the command made");
    served.settle().await;
    served.transport.deliver(
        &Envelope::Result {
            header: ResultHeader {
                call_id: 2,
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(b"done"),
        },
        &second(),
    );
    assert_eq!(
        crate::testing::patience(Duration::from_secs(10), running)
            .await
            .expect("answered")
            .expect("a result"),
        "done"
    );
    assert_eq!(
        *locked(&steps),
        [
            (
                DebugDirection::Tx,
                DebugType::Command,
                Some(2),
                Some(second())
            ),
            (
                DebugDirection::Rx,
                DebugType::Command,
                Some(2),
                Some(second())
            )
        ]
    );
    assert_eq!(served.reported(), Vec::<String>::new());
}

// spec 9.1
#[tokio::test]
async fn commands_go_to_the_connection_their_options_name_on_even_call_ids_and_resolve_with_that_connections_result_alone()
 {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    let running = served
        .router
        .request(
            Bytes::from_static(b"ping"),
            request(Some(&first()), Duration::from_secs(1)),
        )
        .expect("the command made");
    served.settle().await;
    assert_eq!(
        served.transport.take(),
        [(
            first(),
            Envelope::Request {
                header: RequestHeader {
                    call_id: 2,
                    service_id: 2,
                    procedure_id: 1,
                    destination_id: None,
                    opens_subscription: false,
                    paced: false,
                    total: None,
                    credential: None,
                },
                payload: Bytes::from_static(b"ping"),
            }
        )]
    );
    served.transport.deliver(&result_of(2, None), &second());
    served.transport.deliver(
        &Envelope::Result {
            header: ResultHeader {
                call_id: 2,
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(b"pong"),
        },
        &first(),
    );
    assert_eq!(
        answered(running)
            .await
            .expect("answered on its connection")
            .payload,
        b"pong".as_slice()
    );
    served.settle().await;
    assert_eq!(served.reported(), ["CALL_UNKNOWN second"]);
    assert_eq!(
        *locked(&served.activity),
        ["Request first", "Response first"]
    );
}

// spec 9.1, 11
#[tokio::test]
async fn commands_name_their_connection_and_it_must_be_open_a_server_holds_no_subscription() {
    let served = Served::new(&RouterServerOptions::default());
    served
        .router
        .request(Bytes::new(), request(None, Duration::from_secs(1)))
        .expect_err("a command must name its connection");
    assert!(matches!(
        answered(ask(&served, (&first(), Duration::from_secs(1)))).await,
        Err(CallError::Disconnected(_))
    ));
    served.transport.open(&first(), true);
    served.settle().await;
    // a server's request that subscribes is refused, open connection or not, as on the other sides
    let mut subscribing = request(Some(&first()), Duration::from_secs(1));
    subscribing.procedure = news();
    subscribing.subscribes = Some(super::client::Notified::of(news()).like());
    assert_eq!(
        served
            .router
            .request(Bytes::new(), subscribing)
            .expect_err("a server does not subscribe")
            .message(),
        "a server does not subscribe to notifications; it sends them"
    );
    // its service layer refuses a subscriber before any call is made: by its side first, before
    // spec 16.10's reasons, a notification being a client's router's alone (spec 16.11)
    let refused = served
        .services
        .get_notification(
            &news(),
            NotificationDependencies::new(
                RequestDependencies::new(TextCodec, TextCodec),
                TextCodec,
            ),
        )
        .expect_err("a server cannot subscribe");
    assert_eq!(
        (refused.reason(), refused.message()),
        (
            None,
            "only a client hears notifications; a server notifies them"
        )
    );
    served.transport.close_connection(&first());
    assert!(matches!(
        answered(ask(&served, (&first(), Duration::from_secs(1)))).await,
        Err(CallError::Disconnected(_))
    ));
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(served.reported(), Vec::<String>::new());
}

// spec 9.1
#[tokio::test]
async fn commands_reach_a_connection_that_spoke_before_the_router_saw_it_open() {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.deliver_message(
        &TransportMessage {
            data: Bytes::from_static(&[0xa1, 0x80, 0, 2, 0, 0, 0, 1]),
            ..TransportMessage::default()
        },
        &first(),
    );
    let running = ask(&served, (&first(), Duration::from_secs(1)));
    served.settle().await;
    assert_eq!(
        served.transport.calls(&first()),
        [(EnvelopeKind::Request, 2)]
    );
    served.transport.deliver(&result_of(2, None), &first());
    answered(running)
        .await
        .expect("the connection is known from its message");
    assert_eq!(served.reported(), Vec::<String>::new());
}

// spec 9.1, 10.1
#[tokio::test]
async fn commands_reject_with_the_failure_answered_time_out_and_are_rejected_when_their_connection_closes()
 {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    let running = ask(&served, (&first(), Duration::from_secs(1)));
    served.settle().await;
    let mut failure = failure_of(2, (ProtocolCode::PROCEDURE_UNKNOWN, None));
    if let Envelope::Failure { failure, .. } = &mut failure {
        failure.detail = "why".to_owned();
    }
    served.transport.deliver(&failure, &first());
    let Err(CallError::Failure(failure)) = answered(running).await else {
        panic!("the peer's failure")
    };
    assert_eq!(failure.code(), ProtocolCode::PROCEDURE_UNKNOWN.get());
    assert_eq!(failure.detail(), "why");
    assert_eq!(failure.origin(), FailureOrigin::Peer);
    assert_eq!(failure.side(), Some(RouterSide::Client));
    let timing = ask(&served, (&first(), Duration::from_millis(10)));
    served.settle().await;
    served.clock.advance(Duration::from_millis(10)).await;
    let timed = answered(timing).await.expect_err("the router's timeout");
    assert!(matches!(timed, CallError::TimedOut(delay) if delay == Duration::from_millis(10)));
    assert_eq!(timed.to_string(), "no answer came in 10 milliseconds");
    let closing = ask(&served, (&first(), Duration::from_secs(1)));
    let staying = ask(&served, (&second(), Duration::from_secs(1)));
    served.settle().await;
    served.transport.close_connection(&first());
    assert!(matches!(
        answered(closing).await,
        Err(CallError::Disconnected(_))
    ));
    served.transport.deliver(&result_of(8, None), &second());
    answered(staying)
        .await
        .expect("the other connection answers");
    assert_eq!(served.reported(), Vec::<String>::new());
}

// spec 9.1, 12.1
#[tokio::test]
async fn commands_refuse_a_payload_too_large_here() {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    let called = served
        .router
        .request(
            Bytes::from(vec![0; 0x100_0001]),
            request(Some(&first()), Duration::from_secs(1)),
        )
        .expect("the command made");
    assert!(
        matches!(answered(called).await, Err(CallError::Failure(failure))
        if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get() && failure.side() == Some(RouterSide::Server)
            && failure.origin() == FailureOrigin::Local)
    );
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(served.reported(), Vec::<String>::new());
}
