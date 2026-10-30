//! The router core's requester, through a server's router, whose commands go out on any of its
//! connections, and a client's: the call ids its requests go out on, what their headers write,
//! how answers pair with them, and the call ids it reserves.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::server::{Served, first, header_of, second};
use super::{Scripted, answered, locked, options_of, request_of as client_request_of, result_of};
use crate::constants::ProcedureKind;
use crate::envelope::{Envelope, RequestHeader};
use crate::identity::Procedure;
use crate::router::server::{CallHooks, RouterServerOptions, ServerRequest};
use crate::router::types::{ConnectionHandle, RouterResult};
use crate::testing::pair::echo;

// echo as a command, which a server's router makes
fn command() -> Procedure {
    Procedure {
        kind: Some(ProcedureKind::Command),
        ..echo()
    }
}

// a command to `connection_handle` of `payload`, to `destination_id` when given, `hooks` told
fn command_of(
    served: &Served,
    (connection_handle, payload, destination_id, hooks): (
        &ConnectionHandle,
        Bytes,
        Option<u32>,
        CallHooks,
    ),
) -> crate::router::server::Call {
    let mut options = options_of(Duration::from_secs(1));

    options.connection_handle = Some(Arc::clone(connection_handle));
    options.destination_id = destination_id;

    served
        .router
        .request(
            payload,
            (
                ServerRequest {
                    procedure: command().address(),
                    maximum_payload_bytes: None,
                    options,
                    series: None,
                    refusal: None,
                },
                hooks,
            ),
        )
        .expect("a command")
}

fn requests_of(envelopes: &[Envelope]) -> Vec<(RequestHeader, Bytes)> {
    envelopes
        .iter()
        .filter_map(|envelope| match envelope {
            Envelope::Request { header, payload } => Some((header.clone(), payload.clone())),
            Envelope::Result { .. }
            | Envelope::Failure { .. }
            | Envelope::Notification { .. }
            | Envelope::Chunk { .. }
            | Envelope::Credit { .. }
            | Envelope::Cancel { .. } => None,
        })
        .collect()
}

fn payload_of(outcome: &RouterResult) -> Vec<u8> {
    outcome.payload.to_vec()
}

// the call id each hook heard, and how many envelopes had gone out as it did
type Told = Arc<Mutex<Vec<(u32, usize)>>>;

// ── Its requests ─────────────────────────────────────────────────────────────────────────────

// spec 9.1
#[tokio::test]
async fn sends_its_requests_on_a_call_id_of_its_side_naming_their_procedure_and_nothing_of_a_session()
 {
    let served = Served::new(&RouterServerOptions::default());
    let told: Told = Arc::default();
    let (telling, transport) = (Arc::clone(&told), Arc::clone(&served.transport));

    served.transport.open(&first(), true);

    let asked = command_of(
        &served,
        (
            &first(),
            Bytes::from_static(&[1, 2, 3]),
            None,
            CallHooks {
                on_call_id: Some(Box::new(move |call_id| {
                    locked(&telling).push((call_id, transport.envelopes(&first()).len()));
                })),
                on_sent: None,
            },
        ),
    );

    served.settle().await;

    assert_eq!(*locked(&told), [(2, 0)], "its call id, before it went");
    assert_eq!(
        requests_of(&served.transport.envelopes(&first())),
        [(header_of((2, &echo())), Bytes::from_static(&[1, 2, 3]))],
        "its procedure named, nothing of a session"
    );

    served.transport.deliver(
        &Envelope::Result {
            header: crate::envelope::ResultHeader {
                call_id: 2,
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(&[9]),
        },
        &first(),
    );
    served.settle().await;

    assert_eq!(
        answered(asked).await.as_ref().map(payload_of).ok(),
        Some(vec![9]),
        "answered"
    );
    assert_eq!(
        *locked(&served.activity),
        ["Request first", "Response first"],
        "its activity"
    );
    assert!(served.reported().is_empty(), "nothing reported");

    // a client's, odd, its call id told before it goes
    let scripted = Scripted::new();
    let heard: Told = Arc::default();
    let (hearing, carried) = (Arc::clone(&heard), Arc::clone(&scripted.transport));
    let call = scripted
        .router
        .request(
            Bytes::from_static(&[1]),
            (
                client_request_of((None, Duration::from_secs(5))),
                CallHooks {
                    on_call_id: Some(Box::new(move |call_id| {
                        locked(&hearing).push((call_id, carried.envelopes().len()));
                    })),
                    on_sent: None,
                },
            ),
        )
        .expect("a request");

    scripted.settle().await;

    assert_eq!(*locked(&heard), [(1, 0)], "call id 1, before it went");
    assert_eq!(
        requests_of(&scripted.transport.envelopes()),
        [(header_of((1, &echo())), Bytes::from_static(&[1]))],
        "its procedure named"
    );

    scripted.transport.deliver(&result_of(1, None));
    scripted.settle().await;

    assert!(answered(call).await.is_ok(), "answered");
    assert!(scripted.codes().is_empty(), "nothing reported");
}

// spec 14.1
#[tokio::test]
async fn writes_the_destination_a_request_names_and_none_left_out() {
    let served = Served::new(&RouterServerOptions::default());

    served.transport.open(&first(), true);

    let calls = [
        command_of(
            &served,
            (&first(), Bytes::new(), Some(7), CallHooks::default()),
        ),
        command_of(
            &served,
            (&first(), Bytes::new(), None, CallHooks::default()),
        ),
    ];

    served.settle().await;

    assert_eq!(
        requests_of(&served.transport.envelopes(&first()))
            .into_iter()
            .map(|(header, _)| header)
            .collect::<Vec<_>>(),
        [
            RequestHeader {
                destination_id: Some(7),
                ..header_of((2, &echo()))
            },
            header_of((4, &echo()))
        ],
        "the destination named, and none left out"
    );

    drop(calls);
}

// a command goes out on one connection: its answer on another pairs with nothing
// spec 9.1
#[tokio::test]
async fn pairs_its_requests_by_call_id_alone_on_their_own_connection_once() {
    let served = Served::new(&RouterServerOptions::default());
    let result = |payload: &'static [u8]| Envelope::Result {
        header: crate::envelope::ResultHeader {
            call_id: 2,
            total: None,
            credential: None,
        },
        payload: Bytes::from_static(payload),
    };

    served.transport.open(&first(), true);
    served.transport.open(&second(), true);

    let asked = command_of(
        &served,
        (&first(), Bytes::new(), Some(3), CallHooks::default()),
    );

    served.settle().await;
    served.transport.deliver(&result(&[]), &second());
    served.settle().await;

    served.transport.deliver(&result(&[9]), &first());
    // the same response again, behind it
    served.transport.deliver(&result(&[]), &first());
    served.settle().await;

    assert_eq!(
        answered(asked).await.as_ref().map(payload_of).ok(),
        Some(vec![9]),
        "the first on its own connection, never another connection's"
    );
    assert_eq!(
        served.reported(),
        ["CALL_UNKNOWN second", "CALL_UNKNOWN first"],
        "the others paired with nothing"
    );
    assert_eq!(
        *locked(&served.activity),
        ["Request first", "Response first"],
        "its activity"
    );
}

// ── The call ids it reserves ─────────────────────────────────────────────────────────────────

// spec 10.3
#[tokio::test]
async fn keeps_the_later_end_of_a_call_id_reserved_twice_clearing_the_timer_it_replaces() {
    let scripted = Scripted::new();
    let milliseconds = Duration::from_millis;

    for (call_id, timeout) in [(1, 20), (1, 200), (3, 200), (3, 20)] {
        scripted
            .router
            .reserve((call_id, Some(milliseconds(timeout))))
            .expect("held")
            .await;
    }

    // the first replaced, its timer cleared; the last never armed
    assert_eq!(
        scripted.clock.dues(),
        [milliseconds(200), milliseconds(200)],
        "the later end of each"
    );

    scripted.clock.advance(milliseconds(100)).await;

    assert_eq!(
        [
            scripted.router.is_reserved(1).await,
            scripted.router.is_reserved(3).await
        ],
        [true, true]
    );

    scripted.clock.advance(milliseconds(100)).await;

    assert_eq!(
        [
            scripted.router.is_reserved(1).await,
            scripted.router.is_reserved(3).await
        ],
        [false, false]
    );
}
