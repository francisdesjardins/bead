//! The router core's requester, through a server's router, whose commands go out on any of its
//! connections, and a client's: the call ids its requests go out on, what their headers write,
//! how answers pair with them, and the call ids it reserves.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::server::{Served, first, header_of, second};
use super::{Scripted, answered, locked, options_of, request_of as client_request_of, result_of};
use crate::RouterRequest;
use crate::constants::ProcedureKind;
use crate::envelope::{Envelope, RequestHeader};
use crate::identity::Procedure;
use crate::router::server::RouterServerOptions;
use crate::router::types::{ConnectionHandle, RouterResult};
use crate::testing::pair::echo;

// echo as a command, which a server's router makes
fn command() -> Procedure {
    Procedure {
        procedure_kind: Some(ProcedureKind::Command),
        ..echo()
    }
}

// what hears a call's id
type OnCallId = Option<Box<dyn FnOnce(u32) + Send>>;

// a command to `connection_handle` of `payload`, to `destination_id` when given, `on_call_id` told
// its call id
fn command_of(
    served: &Served,
    (connection_handle, payload, destination_id, on_call_id): (
        &ConnectionHandle,
        Bytes,
        Option<u32>,
        OnCallId,
    ),
) -> crate::router::server::Call {
    let mut options = options_of(Duration::from_secs(1));

    options.connection_handle = Some(Arc::clone(connection_handle));
    options.destination_id = destination_id;

    served
        .router
        .request(
            payload,
            RouterRequest {
                procedure: command(),
                options,
                series: None,
                refusal: None,
                subscribes: None,
                on_call_id,
                on_sent: None,
            },
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
            Some(Box::new(move |call_id| {
                locked(&telling).push((call_id, transport.envelopes(&first()).len()));
            })),
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
        .request(Bytes::from_static(&[1]), {
            let mut request = client_request_of((None, Duration::from_secs(5)));

            request.on_call_id = Some(Box::new(move |call_id| {
                locked(&hearing).push((call_id, carried.envelopes().len()));
            }));
            request
        })
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
async fn destinations() {
    let served = Served::new(&RouterServerOptions::default());

    served.transport.open(&first(), true);

    let calls = [
        command_of(&served, (&first(), Bytes::new(), Some(7), None)),
        command_of(&served, (&first(), Bytes::new(), None, None)),
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

    let asked = command_of(&served, (&first(), Bytes::new(), Some(3), None));

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
            .reserve(call_id, Some(milliseconds(timeout)))
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

#[tokio::test]
async fn writes_the_destination_a_request_names_and_none_left_out() {
    destinations().await;
}

#[tokio::test]
async fn write_the_destination_they_name_and_none_left_out() {
    destinations().await;
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "both side parities with their wire, trace, callback and activity assertions"
)]
async fn go_out_on_a_call_id_of_its_side_naming_their_procedure_and_nothing_of_a_session() {
    use crate::constants::RouterSide;
    use crate::debug::DebugDirection;
    use crate::router::types::{RouterActivity, RouterLimitsOptions};
    use crate::testing::core_port::{Peer, completed, request_of};

    for (side, id, payload, answer) in [
        (
            RouterSide::Server,
            2,
            Bytes::from_static(&[1, 2, 3]),
            Bytes::from_static(&[9]),
        ),
        (
            RouterSide::Client,
            1,
            Bytes::from_static(&[1]),
            Bytes::from_static(&[1]),
        ),
    ] {
        let peer = Peer::new(side, &RouterLimitsOptions::default());
        peer.owner
            .run(|state| {
                state.token = Some(Box::new(|_| panic!("a request asks no session")));
            })
            .await
            .expect("the token provider must not run");
        let told: Told = Arc::default();
        let telling = Arc::clone(&told);
        let mut request = request_of("a");
        request.on_call_id = Some(Box::new(move |call_id| {
            locked(&telling).push((call_id, 0));
        }));
        let before = Arc::clone(&told);
        peer.owner
            .run(move |state| {
                state.on_transmit = Some(Box::new(move |state, _| {
                    assert_eq!(
                        *locked(&before),
                        [(id, 0)],
                        "the id is told before transmit"
                    );
                    assert_eq!(state.sent.len(), 1, "this is its first envelope");
                }));
            })
            .await
            .expect("the send observes the callback");
        let asked = peer.request((payload.clone(), request));
        peer.settle().await;
        assert_eq!(*locked(&told), [(id, 0)]);
        assert_eq!(
            peer.sent().await,
            [(
                Arc::from("a"),
                Envelope::Request {
                    header: header_of((id, &echo())),
                    payload,
                }
            )]
        );
        peer.owner
            .run(move |state| {
                assert_eq!(state.traces.len(), 1);
                let (direction, traced) = &state.traces[0];
                assert_eq!(*direction, DebugDirection::Tx);
                assert_eq!(traced.connection_handle.as_ref(), "a");
                assert_eq!(
                    traced.header,
                    crate::envelope::EnvelopeHeader::Request(header_of((id, &echo())))
                );
                assert_eq!(traced.credential_scheme, None);
                assert_eq!(state.activity, [(RouterActivity::Request, Arc::from("a"))]);
            })
            .await
            .expect("the trace and request activity");
        peer.receive((
            Envelope::Result {
                header: crate::envelope::ResultHeader {
                    call_id: id,
                    total: None,
                    credential: None,
                },
                payload: answer.clone(),
            },
            Arc::from("a"),
        ));
        let result = completed(asked).await.expect("the paired result");
        assert_eq!(result.payload, answer);
        assert_eq!(
            result.header,
            crate::envelope::ResultHeader {
                call_id: id,
                total: None,
                credential: None,
            }
        );
        peer.owner
            .run(|state| {
                assert_eq!(
                    state.activity,
                    [
                        (RouterActivity::Request, Arc::from("a")),
                        (RouterActivity::Response, Arc::from("a")),
                    ]
                );
                assert!(state.reports.is_empty());
            })
            .await
            .expect("one request and response");
    }
}

#[tokio::test]
async fn pair_by_call_id_alone_on_their_own_connection_once() {
    use crate::constants::{ProtocolCode, RouterSide};
    use crate::errors::CallError;
    use crate::router::types::{RouterActivity, RouterError, RouterLimitsOptions};
    use crate::testing::core_port::{Peer, completed, request_of};

    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let mut request = request_of("a");
    request.options.destination_id = Some(3);
    let mut asked = peer.request((Bytes::new(), request));
    peer.receive((result_of(2, None), Arc::from("b")));
    peer.settle().await;
    assert!(matches!(
        asked.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    peer.receive((
        Envelope::Result {
            header: crate::envelope::ResultHeader {
                call_id: 2,
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(&[9]),
        },
        Arc::from("a"),
    ));
    peer.receive((result_of(2, None), Arc::from("a")));
    let result: Result<_, CallError> = completed(asked).await;
    assert_eq!(
        result.expect("only the first matching response").payload,
        Bytes::from_static(&[9])
    );
    peer.owner.run(|state| {
        assert_eq!(state.reports.len(), 2);
        for ((handle, error), expected) in state.reports.iter().zip(["b", "a"]) {
            assert_eq!(handle.as_ref(), expected);
            assert!(matches!(error, RouterError::Failure(failure) if failure.code() == ProtocolCode::CALL_UNKNOWN.get()));
        }
        assert_eq!(state.activity, [
            (RouterActivity::Request, Arc::from("a")),
            (RouterActivity::Response, Arc::from("a")),
        ]);
        assert_eq!(state.answers.iter().map(|(handle, header)| (handle.as_ref(), header.call_id())).collect::<Vec<_>>(),
            [("b", 2), ("a", 2), ("a", 2)]);
    }).await.expect("all responses reach the side before pairing");
}

#[tokio::test]
async fn keep_the_later_end_of_a_call_id_reserved_twice_clearing_the_timer_it_replaces() {
    use crate::constants::RouterSide;
    use crate::router::requester;
    use crate::router::types::{CallAddress, RouterLimitsOptions};
    use crate::testing::core_port::Peer;

    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    peer.owner
        .run(|state| {
            for (call_id, timeout) in [(2, 20), (2, 200), (4, 200), (4, 20)] {
                requester::reserve(
                    state,
                    (
                        &CallAddress {
                            call_id,
                            connection_handle: Arc::from("a"),
                        },
                        Some(Duration::from_millis(timeout)),
                    ),
                );
            }
        })
        .await
        .expect("both reservation orders");
    assert_eq!(peer.armed(), [20, 200, 200].map(Duration::from_millis));
    assert_eq!(peer.clock.dues(), [Duration::from_millis(200); 2]);
    for expected in [true, false] {
        peer.clock.advance(Duration::from_millis(100)).await;
        peer.owner
            .run(move |state| {
                assert_eq!(
                    [
                        state.core.pending.is_reserved(2, &Arc::from("a")),
                        state.core.pending.is_reserved(4, &Arc::from("a"))
                    ],
                    [expected; 2]
                );
            })
            .await
            .expect("the later deadlines alone control both reservations");
    }
}

async fn direct_answer(
    peer: &crate::testing::core_port::Peer,
    answer: crate::router::core::Answer,
) {
    peer.owner
        .run(move |state| {
            crate::router::requester::receive_answer(state, (answer, &Arc::from("a"), false));
        })
        .await
        .expect("the requester receives its answer directly");
}

#[tokio::test]
async fn sends_a_call_on_a_call_id_of_its_side_settles_it_with_the_answer_paired_to_it_and_hands_its_port_an_answer_no_call_waits_on()
 {
    use crate::constants::{ProtocolCode, RouterSide};
    use crate::envelope::{FailureHeader, ResultHeader};
    use crate::failure::Failure;
    use crate::router::core::Answer;
    use crate::router::requester;
    use crate::router::types::{CallAddress, RouterError};
    use crate::testing::core_port::{Peer, completed, request_of};

    let peer = Peer::new(RouterSide::Server, &super::router_core_requester::limits());
    let called = peer.request((Bytes::from_static(&[1]), request_of("a")));
    let id = peer
        .owner
        .run(|state| {
            assert_eq!(state.sent.len(), 1);
            assert_eq!(state.sent[0].0.as_ref(), "a");
            let Envelope::Request { header, .. } = &state.sent[0].1 else {
                panic!("a request")
            };
            assert_eq!(header.call_id % 2, 0);
            assert_eq!(state.core.pending.gauges().counts["pendingCalls"], 1);
            header.call_id
        })
        .await
        .expect("one pending request");
    let unpaired_id = id.checked_add(2).expect("a second call ID");
    let unpaired = || {
        Answer::Failure(
            FailureHeader {
                call_id: unpaired_id,
                credential: None,
            },
            Failure::protocol(ProtocolCode::PROCEDURE_FAILED, RouterSide::Server).record(),
        )
    };
    direct_answer(&peer, unpaired()).await;
    peer.owner
        .run(move |state| {
            assert_eq!(state.reports.len(), 1);
            assert_eq!(state.core.pending.gauges().counts["pendingCalls"], 1);
            requester::reserve(
                state,
                (
                    &CallAddress {
                        call_id: unpaired_id,
                        connection_handle: Arc::from("a"),
                    },
                    Some(Duration::from_millis(30)),
                ),
            );
        })
        .await
        .expect("the unknown answer leaves the call pending");
    direct_answer(&peer, unpaired()).await;
    peer.owner
        .run(|state| {
            assert_eq!(state.reports.len(), 1);
        })
        .await
        .expect("the reservation silences its late answer");
    peer.clock.advance(Duration::from_millis(30)).await;
    peer.owner
        .run(move |state| {
            assert!(!state.core.pending.is_reserved(unpaired_id, &Arc::from("a")));
        })
        .await
        .expect("the reservation expires");
    let answer = || {
        Answer::Result(
            ResultHeader {
                call_id: id,
                total: None,
                credential: None,
            },
            Bytes::from_static(&[7]),
        )
    };
    direct_answer(&peer, answer()).await;
    assert_eq!(
        completed(called).await.expect("the paired result").payload,
        Bytes::from_static(&[7])
    );
    direct_answer(&peer, answer()).await;
    peer.owner.run(|state| {
        assert_eq!(state.reports.len(), 2);
        for (handle, error) in &state.reports {
            assert_eq!(handle.as_ref(), "a");
            assert!(matches!(error, RouterError::Failure(failure) if failure.code() == ProtocolCode::CALL_UNKNOWN.get()));
        }
        assert_eq!(state.core.pending.gauges().counts["pendingCalls"], 0);
    }).await.expect("both protocol failures and no other report");
}
