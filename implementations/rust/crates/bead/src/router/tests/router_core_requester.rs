//! The requester's shared scenarios, through a scripted core port: answers, transfers and timers.

use core::num::NonZeroU16;
use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::result_of;
use crate::constants::{EnvelopeKind, FailureScope, ProtocolCode, RouterSide};
use crate::envelope::{
    ChunkHeader, CreditHeader, Envelope, FailureHeader, FailureRecord, RequestHeader, ResultHeader,
};
use crate::errors::CallError;
use crate::failure::FailureOrigin;
use crate::router::core as router_core;
use crate::router::requester;
use crate::router::types::{CallAddress, RouterActivity, RouterError, RouterLimitsOptions};
use crate::testing::core_port::{Peer, PeerOptions, completed, request_of, scripted_header};
use crate::transport::Sent;

// spec 9.1
async fn drawn_call_ids(source_payload: bool) {
    let peer = Peer::with_options(
        RouterSide::Server,
        &PeerOptions {
            last_call_id: Some(8),
            ..PeerOptions::default()
        },
    )
    .expect("a bounded server");
    peer.owner
        .run(|state| {
            state.held.push(4);
        })
        .await
        .expect("4 held");
    let drawn = Arc::new(Mutex::new(Vec::new()));
    let request = || {
        let ids = Arc::clone(&drawn);
        let mut request = request_of("a");
        request.on_call_id = Some(Box::new(move |id| super::locked(&ids).push(id)));
        peer.request((Bytes::new(), request))
    };
    let two = request();
    let six = request();
    peer.receive((result_of(2, None), Arc::from("a")));
    completed(two).await.expect("2 answered");
    let eight = request();
    let two_again = request();
    let error = completed(request()).await.expect_err("no id left");
    let CallError::Failure(failure) = error else {
        panic!("capacity exceeded");
    };
    assert_eq!(
        (failure.code(), failure.side()),
        (
            ProtocolCode::CAPACITY_EXCEEDED.get(),
            Some(RouterSide::Server)
        )
    );
    assert_eq!(
        peer.sent()
            .await
            .iter()
            .map(|(_, envelope)| envelope.call_id())
            .collect::<Vec<_>>(),
        [2, 6, 8, 2]
    );
    assert_eq!(*super::locked(&drawn), [2, 6, 8, 2]);
    peer.owner
        .run(router_core::dispose)
        .await
        .expect("disposed");
    for pending in [six, eight, two_again] {
        assert!(matches!(
            completed(pending).await,
            Err(CallError::Disconnected(_))
        ));
    }

    let client = Peer::new(RouterSide::Client, &RouterLimitsOptions::default());
    let mut request = request_of("a");
    request.options.timeout = Duration::from_millis(1);
    let ids = Arc::clone(&drawn);
    request.on_call_id = Some(Box::new(move |id| super::locked(&ids).push(id)));
    let first = client.request((
        if source_payload {
            Bytes::from_static(&[1])
        } else {
            Bytes::new()
        },
        request,
    ));
    client.settle().await;
    assert_eq!(client.sent().await[0].1.call_id(), 1);
    assert_eq!(super::locked(&drawn).last(), Some(&1));
    client.clock.advance(Duration::from_millis(1)).await;
    assert!(
        matches!(completed(first).await, Err(CallError::TimedOut(timeout)) if timeout == Duration::from_millis(1))
    );
    for (side, last) in [(RouterSide::Server, 7), (RouterSide::Client, 8)] {
        assert!(
            Peer::with_options(
                side,
                &PeerOptions {
                    last_call_id: Some(last),
                    ..PeerOptions::default()
                }
            )
            .is_err(),
            "the peer's parity is refused as the core is built"
        );
    }
}

pub(super) fn limits() -> RouterLimitsOptions {
    RouterLimitsOptions {
        chunk_bytes: Some(64),
        maximum_envelope_bytes: Some(64),
        window_bytes: Some(128),
        ..RouterLimitsOptions::default()
    }
}

pub(super) fn pattern(total: usize) -> Bytes {
    (0..total)
        .map(|index| u8::try_from(index % 256).expect("a byte"))
        .collect()
}

pub(super) fn opening(call_id: u32, (payload, total): (Bytes, u64)) -> Envelope {
    Envelope::Result {
        header: ResultHeader {
            call_id,
            total: Some(total),
            credential: None,
        },
        payload,
    }
}

pub(super) fn chunk(call_id: u32, (payload, offset, is_last): (Bytes, u64, bool)) -> Envelope {
    Envelope::Chunk {
        header: ChunkHeader {
            call_id,
            offset,
            is_last,
        },
        payload,
    }
}

pub(super) fn credit(call_id: u32, end: u64) -> Envelope {
    Envelope::Credit {
        header: CreditHeader {
            call_id,
            credit_end: end,
            paced: false,
        },
    }
}

pub(super) fn failed(
    call_id: u32,
    (code, scope, relays, detail): (u16, FailureScope, u8, &str),
) -> Envelope {
    Envelope::Failure {
        header: FailureHeader {
            call_id,
            credential: None,
        },
        failure: FailureRecord {
            code: NonZeroU16::new(code).expect("a failure code"),
            scope,
            relays,
            detail: detail.to_owned(),
        },
    }
}

pub(super) async fn pieces(peer: &Peer) -> Vec<(EnvelopeKind, u32, Option<u64>, usize)> {
    peer.sent()
        .await
        .iter()
        .map(|(_, envelope)| match envelope {
            Envelope::Request { header, payload } => (
                EnvelopeKind::Request,
                header.call_id,
                header.total,
                payload.len(),
            ),
            Envelope::Chunk { header, payload } => (
                EnvelopeKind::Chunk,
                header.call_id,
                Some(header.offset),
                payload.len(),
            ),
            Envelope::Credit { header } => (
                EnvelopeKind::Credit,
                header.call_id,
                Some(header.credit_end),
                0,
            ),
            Envelope::Cancel { header } => (EnvelopeKind::Cancel, header.call_id, None, 0),
            other @ (Envelope::Result { .. }
            | Envelope::Failure { .. }
            | Envelope::Notification { .. }) => panic!("a request's pieces expected: {other:?}"),
        })
        .collect()
}

pub(super) async fn quiet(peer: &Peer) {
    peer.owner
        .run(|state| {
            assert!(state.reports.is_empty(), "{:?}", state.reports);
        })
        .await
        .expect("reports checked");
}

// spec 9.2
async fn unpaired_failures(client_call_id: u32) {
    for side in [RouterSide::Server, RouterSide::Client] {
        let peer = Peer::new(side, &RouterLimitsOptions::default());
        peer.owner
            .run(|state| {
                state.takes_unpaired = true;
            })
            .await
            .expect("failures taken");
        let code = if side == RouterSide::Server { 32 } else { 9 };
        let scope = if side == RouterSide::Server {
            FailureScope::Protocol
        } else {
            FailureScope::Application
        };
        let call_id = if side == RouterSide::Client {
            client_call_id
        } else {
            3
        };
        peer.receive((failed(call_id, (code, scope, 0, "")), Arc::from("a")));
        peer.settle().await;
        quiet(&peer).await;
        if side == RouterSide::Server {
            peer.owner
                .run(|state| {
                    state.takes_unpaired = false;
                })
                .await
                .expect("failures refused");
            peer.receive((failed(5, (code, scope, 0, "")), Arc::from("a")));
        }
        peer.receive((result_of(7, None), Arc::from("a")));
        peer.settle().await;
        peer.owner.run(move |state| {
            assert_eq!(state.unpaired.iter().map(|(handle, header, failure)| (handle.as_ref(), header.call_id, failure.code.get())).collect::<Vec<_>>(), if side == RouterSide::Server { vec![("a", 3, 32), ("a", 5, 32)] } else { vec![("a", client_call_id, 9)] });
            assert_eq!(state.reports.len(), if side == RouterSide::Server { 2 } else { 1 });
            assert!(state.reports.iter().all(|(handle, error)| handle.as_ref() == "a" && matches!(error, RouterError::Failure(failure) if failure.code() == ProtocolCode::CALL_UNKNOWN.get())));
        }).await.expect("unpaired outcomes checked");
    }
    let bare = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    bare.receive((
        failed(3, (32, FailureScope::Protocol, 0, "")),
        Arc::from("a"),
    ));
    bare.settle().await;
    bare.owner.run(|state| {
        assert_eq!(state.reports.len(), 1);
        assert!(matches!(&state.reports[0], (handle, RouterError::Failure(failure)) if handle.as_ref() == "a" && failure.code() == ProtocolCode::CALL_UNKNOWN.get()));
    }).await.expect("bare side checked");
}

// spec 7, 9.2
async fn received_failures() {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let ask = || {
        let mut request = request_of("a");
        request.options.destination_id = Some(4);
        peer.request((Bytes::new(), request))
    };
    let (direct, relayed, application) = (ask(), ask(), ask());
    for (call_id, failure) in [
        (2, (19, FailureScope::Protocol, 0, "why")),
        (4, (18, FailureScope::Protocol, 1, "")),
        (6, (21, FailureScope::Application, 0, "")),
    ] {
        peer.receive((failed(call_id, failure), Arc::from("a")));
    }
    for (answer, code, scope, origin, side, relays, detail) in [
        (
            direct,
            19,
            FailureScope::Protocol,
            FailureOrigin::Peer,
            Some(RouterSide::Client),
            0,
            "why",
        ),
        (
            relayed,
            18,
            FailureScope::Protocol,
            FailureOrigin::Relayed,
            None,
            1,
            "",
        ),
        (
            application,
            21,
            FailureScope::Application,
            FailureOrigin::Peer,
            Some(RouterSide::Client),
            0,
            "",
        ),
    ] {
        let CallError::Failure(failure) = completed(answer).await.expect_err("peer failure") else {
            panic!("a failure expected");
        };
        assert_eq!(
            (
                failure.code().get(),
                failure.scope(),
                failure.origin(),
                failure.side(),
                failure.relays(),
                failure.detail()
            ),
            (code, scope, origin, side, relays, detail)
        );
        assert_eq!(failure.destination_id(), Some(4));
        assert_eq!(
            failure.procedure(),
            Some(crate::testing::pair::echo().address())
        );
    }
}

// spec 12.2
async fn oversized_result(source_payload: bool) {
    for (side, maximum, total, call_id) in [
        (RouterSide::Server, None, 16_777_217, 2),
        (RouterSide::Client, Some(100), 300, 1),
    ] {
        let peer = Peer::new(side, &RouterLimitsOptions::default());
        let mut request = request_of("a");
        request.maximum_payload_bytes = maximum;
        let request_payload = if source_payload && side == RouterSide::Server {
            Bytes::new()
        } else {
            Bytes::from_static(&[1])
        };
        let asked = peer.request((request_payload.clone(), request));
        peer.receive((
            opening(
                call_id,
                (
                    if side == RouterSide::Client {
                        pattern(32)
                    } else {
                        Bytes::new()
                    },
                    total,
                ),
            ),
            Arc::from("a"),
        ));
        let CallError::Failure(failure) = completed(asked)
            .await
            .expect_err("oversized result refused")
        else {
            panic!("a failure expected");
        };
        assert_eq!(
            (failure.code(), failure.origin(), failure.side()),
            (
                ProtocolCode::PAYLOAD_TOO_LARGE.get(),
                FailureOrigin::Local,
                Some(side)
            )
        );
        assert_eq!(
            failure.detail(),
            if side == RouterSide::Server {
                "a payload is 16777216 bytes at most, not 16777217"
            } else {
                "a payload is 100 bytes at most, not 300"
            }
        );
        peer.settle().await;
        assert_eq!(
            pieces(&peer).await,
            [
                (EnvelopeKind::Request, call_id, None, request_payload.len()),
                (EnvelopeKind::Cancel, call_id, None, 0)
            ]
        );
    }
}

// spec 9.1
#[tokio::test]
async fn fails_before_it_goes_a_call_past_the_calls_its_peer_answers_at_once_and_sends_one_once_a_call_is_answered()
 {
    let peer = Peer::new(
        RouterSide::Server,
        &RouterLimitsOptions {
            maximum_answering_calls: Some(2),
            ..RouterLimitsOptions::default()
        },
    );
    let first = peer.request((Bytes::new(), request_of("a")));
    let second = peer.request((Bytes::new(), request_of("a")));
    let other = peer.request((Bytes::new(), request_of("b")));
    let refused = completed(peer.request((Bytes::new(), request_of("a"))))
        .await
        .expect_err("capacity refused");
    assert!(
        matches!(refused, CallError::Failure(failure) if failure.code() == ProtocolCode::CAPACITY_EXCEEDED.get() && failure.origin() == FailureOrigin::Local && failure.side() == Some(RouterSide::Server) && failure.detail() == "the calls waiting on a are 2 at most")
    );
    assert_eq!(peer.sent().await.len(), 3);
    peer.receive((result_of(2, None), Arc::from("a")));
    let third = peer.request((Bytes::new(), request_of("a")));
    completed(first).await.expect("first answered");
    peer.settle().await;
    assert_eq!(
        peer.sent()
            .await
            .iter()
            .map(|(handle, envelope)| (handle.to_string(), envelope.call_id()))
            .collect::<Vec<_>>(),
        [
            ("a".to_owned(), 2),
            ("a".to_owned(), 4),
            ("b".to_owned(), 6),
            ("a".to_owned(), 8)
        ]
    );
    peer.owner
        .run(|state| {
            router_core::reject_pending(state, ("all gone", None));
        })
        .await
        .expect("calls ended");
    for answer in [second, other, third] {
        assert!(
            matches!(completed(answer).await, Err(CallError::Disconnected(reason)) if reason == "all gone")
        );
    }
}

// spec 10.4
async fn failed_request_opening() {
    for later in [false, true] {
        let peer = Peer::new(RouterSide::Server, &limits());
        let expected: Arc<dyn std::error::Error + Send + Sync> =
            Arc::new(std::io::Error::other("gone"));
        for length in [0, 200] {
            let error = RouterError::Other(Arc::clone(&expected));
            peer.owner
                .run(move |state| {
                    state.sending.push_back(if later {
                        Ok(Sent::Later(Box::pin(async { Err(error) })))
                    } else {
                        Err(error)
                    });
                })
                .await
                .expect("send fails");
            let returned = completed(peer.request((Bytes::from(vec![0; length]), request_of("a"))))
                .await
                .expect_err("send failed");
            assert_eq!(returned.to_string(), "gone");
            assert!(
                matches!(returned, CallError::Other(error) if Arc::ptr_eq(&error, &expected)),
                "the same transport error returns"
            );
        }
        peer.receive((result_of(2, None), Arc::from("a")));
        peer.settle().await;
        assert_eq!(
            pieces(&peer).await,
            [
                (EnvelopeKind::Request, 2, None, 0),
                (EnvelopeKind::Request, 4, Some(200), 44)
            ]
        );
        peer.owner.run(|state| {
            assert_eq!(state.reports.len(), 1);
            assert!(matches!(&state.reports[0], (handle, RouterError::Failure(failure)) if handle.as_ref() == "a" && failure.code() == ProtocolCode::CALL_UNKNOWN.get()));
        }).await.expect("late answer reported");
    }
}

// spec 12
#[expect(
    clippy::too_many_lines,
    reason = "the shared result scenario checks each credit checkpoint, duplicate chunks, pending completion and the final bytes together"
)]
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
async fn credited_result() {
    for (side, call_id) in [(RouterSide::Server, 2), (RouterSide::Client, 1)] {
        let peer = Peer::new(side, &limits());
        let payload = pattern(300);
        let mut asked = peer.request((
            if side == RouterSide::Client {
                Bytes::from_static(&[1])
            } else {
                Bytes::new()
            },
            request_of("a"),
        ));
        peer.receive((opening(call_id, (payload.slice(..32), 300)), Arc::from("a")));
        peer.settle().await;
        assert_eq!(
            pieces(&peer).await.last(),
            Some(&(EnvelopeKind::Credit, call_id, Some(160), 0))
        );
        for (start, end) in [
            (80, 128),
            (80, 128),
            (32, 80),
            (128, 176),
            (176, 224),
            (224, 272),
        ] {
            peer.receive((
                chunk(
                    call_id,
                    (
                        payload.slice(start..end),
                        u64::try_from(start).expect("an offset"),
                        false,
                    ),
                ),
                Arc::from("a"),
            ));
        }
        peer.settle().await;
        assert_eq!(
            pieces(&peer)
                .await
                .iter()
                .filter_map(|(kind, _, end, _)| (*kind == EnvelopeKind::Credit).then_some(*end))
                .collect::<Vec<_>>(),
            [Some(160), Some(256), Some(300)]
        );
        assert!(matches!(
            asked.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        peer.owner
            .run(|state| {
                assert_eq!(state.activity, [(RouterActivity::Request, Arc::from("a"))]);
            })
            .await
            .expect("still receiving");
        for (start, end) in [(272, 300), (272, 300), (224, 272)] {
            peer.receive((
                chunk(
                    call_id,
                    (
                        payload.slice(start..end),
                        u64::try_from(start).expect("an offset"),
                        end == 300,
                    ),
                ),
                Arc::from("a"),
            ));
        }
        let result = completed(asked).await.expect("whole result");
        assert_eq!(result.payload, payload);
        assert_eq!(
            result.header,
            ResultHeader {
                call_id,
                total: Some(300),
                credential: None
            }
        );
        peer.settle().await;
        assert_eq!(
            pieces(&peer).await,
            [
                (
                    EnvelopeKind::Request,
                    call_id,
                    None,
                    usize::from(side == RouterSide::Client)
                ),
                (EnvelopeKind::Credit, call_id, Some(160), 0),
                (EnvelopeKind::Credit, call_id, Some(256), 0),
                (EnvelopeKind::Credit, call_id, Some(300), 0)
            ]
        );
        peer.owner
            .run(move |state| {
                assert_eq!(
                    state.activity,
                    [
                        (RouterActivity::Request, Arc::from("a")),
                        (RouterActivity::Response, Arc::from("a"))
                    ]
                );
                assert!(state.core.pending.is_reserved(call_id, &Arc::from("a")));
            })
            .await
            .expect("the call settled once");
        quiet(&peer).await;
    }
}

// spec 12.4
async fn broken_result(source_payload: bool) {
    for (side, call_id, total) in [(RouterSide::Server, 2, 150), (RouterSide::Client, 1, 300)] {
        let peer = Peer::new(side, &limits());
        let request_payload = if source_payload && side == RouterSide::Client {
            Bytes::from_static(&[1])
        } else {
            Bytes::new()
        };
        let asked = peer.request((request_payload.clone(), request_of("a")));
        peer.receive((opening(call_id, (pattern(32), total)), Arc::from("a")));
        peer.receive((
            chunk(
                call_id,
                (
                    pattern(if total == 150 { 48 } else { 20 }),
                    32,
                    total == 150,
                ),
            ),
            Arc::from("a"),
        ));
        peer.receive((
            chunk(
                call_id,
                (pattern(48), if total == 150 { 80 } else { 32 }, false),
            ),
            Arc::from("a"),
        ));
        let CallError::Failure(failure) = completed(asked).await.expect_err("invalid chunk") else {
            panic!("a failure expected");
        };
        assert_eq!(
            (
                failure.code(),
                failure.origin(),
                failure.side(),
                failure.procedure()
            ),
            (
                ProtocolCode::CHUNK_INVALID.get(),
                FailureOrigin::Local,
                Some(side),
                Some(crate::testing::pair::echo().address())
            )
        );
        peer.settle().await;
        assert_eq!(
            pieces(&peer).await,
            [
                (EnvelopeKind::Request, call_id, None, request_payload.len()),
                (
                    EnvelopeKind::Credit,
                    call_id,
                    Some(if total == 150 { 150 } else { 160 }),
                    0
                ),
                (EnvelopeKind::Cancel, call_id, None, 0)
            ]
        );
        quiet(&peer).await;
    }
}

// spec 12.2, 12.5
async fn failed_result_transfer() {
    for side in [RouterSide::Server, RouterSide::Client] {
        let first_id = if side == RouterSide::Server { 2_u32 } else { 1 };
        let second_id = first_id.saturating_add(2);
        let request_payload = if side == RouterSide::Client {
            Bytes::from_static(&[1])
        } else {
            Bytes::new()
        };
        let peer = Peer::new(
            side,
            &RouterLimitsOptions {
                buffered_bytes_budget: Some(200),
                maximum_payload_bytes: Some(200),
                ..limits()
            },
        );
        let first = peer.request((request_payload.clone(), request_of("a")));
        peer.receive((
            opening(first_id, (Bytes::from(vec![0; 32]), 200)),
            Arc::from("a"),
        ));
        peer.receive((
            failed(
                first_id,
                (
                    ProtocolCode::TRANSFER_STALLED.get().get(),
                    FailureScope::Protocol,
                    0,
                    "",
                ),
            ),
            Arc::from("a"),
        ));
        peer.receive((chunk(first_id, (pattern(48), 32, false)), Arc::from("a")));
        assert!(
            matches!(completed(first).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::TRANSFER_STALLED.get() && failure.origin() == FailureOrigin::Peer)
        );
        let second = peer.request((request_payload.clone(), request_of("a")));
        peer.receive((
            opening(second_id, (Bytes::from(vec![0; 32]), 200)),
            Arc::from("a"),
        ));
        peer.settle().await;
        assert_eq!(
            pieces(&peer).await,
            [
                (EnvelopeKind::Request, first_id, None, request_payload.len()),
                (EnvelopeKind::Credit, first_id, Some(160), 0),
                (
                    EnvelopeKind::Request,
                    second_id,
                    None,
                    request_payload.len()
                ),
                (EnvelopeKind::Credit, second_id, Some(160), 0)
            ]
        );
        quiet(&peer).await;
        peer.owner
            .run(move |state| {
                requester::cancel(
                    state,
                    (
                        &CallAddress {
                            call_id: second_id,
                            connection_handle: Arc::from("a"),
                        },
                        None,
                    ),
                );
            })
            .await
            .expect("second cancelled");
        assert!(matches!(
            completed(second).await,
            Err(CallError::Cancelled(_))
        ));
    }
}

// spec 9.2, 12
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
async fn duplicate_result(source_payload: bool) {
    for (side, call_id) in [(RouterSide::Server, 2), (RouterSide::Client, 1)] {
        for total in [80, 100] {
            let peer = Peer::new(side, &limits());
            let payload = pattern(total);
            let request_payload = if source_payload && side == RouterSide::Client {
                Bytes::from_static(&[1])
            } else {
                Bytes::new()
            };
            let asked = peer.request((request_payload, request_of("a")));
            peer.receive((
                opening(
                    call_id,
                    (payload.slice(..32), u64::try_from(total).expect("a total")),
                ),
                Arc::from("a"),
            ));
            peer.receive((
                Envelope::Result {
                    header: ResultHeader {
                        call_id,
                        total: None,
                        credential: None,
                    },
                    payload: Bytes::from_static(&[9]),
                },
                Arc::from("a"),
            ));
            for offset in (32..total).step_by(48) {
                let end = offset.saturating_add(48).min(total);
                peer.receive((
                    chunk(
                        call_id,
                        (
                            payload.slice(offset..end),
                            u64::try_from(offset).expect("an offset"),
                            end == total,
                        ),
                    ),
                    Arc::from("a"),
                ));
            }
            assert_eq!(
                completed(asked)
                    .await
                    .expect("the transfer completes")
                    .payload,
                payload
            );
            peer.owner.run(move |state| {
                assert_eq!(state.reports.len(), 1);
                assert!(matches!(&state.reports[0], (handle, RouterError::Failure(failure)) if handle.as_ref() == "a" && failure.code() == ProtocolCode::ENVELOPE_MALFORMED.get() && failure.to_string().contains(&format!("call {call_id} is answered already, by a transfer"))));
            }).await.expect("the duplicate reported");
        }
    }
}

// spec 12.3
#[expect(
    clippy::too_many_lines,
    clippy::disallowed_methods,
    reason = "the shared parity, credit and answer scenario slices its fixed 200 or 300 byte payloads at 44 bytes"
)]
async fn credited_request() {
    for (side, call_id, total) in [(RouterSide::Server, 2, 200), (RouterSide::Client, 1, 300)] {
        let peer = Peer::new(side, &limits());
        let payload = pattern(total);
        let asked = peer.request((payload.clone(), request_of("a")));
        peer.settle().await;
        assert_eq!(
            peer.sent().await[0].1,
            Envelope::Request {
                header: RequestHeader {
                    total: Some(u64::try_from(total).expect("a total")),
                    ..scripted_header(call_id)
                },
                payload: payload.slice(..44)
            }
        );
        assert_eq!(
            pieces(&peer).await,
            [(
                EnvelopeKind::Request,
                call_id,
                Some(u64::try_from(total).expect("a total")),
                44
            )]
        );
        peer.receive((
            credit(call_id, if total == 200 { 140 } else { 172 }),
            Arc::from("a"),
        ));
        peer.settle().await;
        assert_eq!(
            &pieces(&peer).await[1..],
            [
                (EnvelopeKind::Chunk, call_id, Some(44), 48),
                (EnvelopeKind::Chunk, call_id, Some(92), 48)
            ]
        );
        peer.owner
            .run(|state| {
                assert_eq!(state.activity, []);
            })
            .await
            .expect("not wholly handed off");
        peer.receive((
            credit(call_id, u64::try_from(total).expect("a total")),
            Arc::from("a"),
        ));
        peer.settle().await;
        let sent = peer.sent().await;
        let mut assembled = Vec::new();
        let mut lasts = Vec::new();
        for (_, envelope) in &sent {
            assert!(crate::testing::scripted::bytes_of(envelope).len() <= 64);
            match envelope {
                Envelope::Request { payload, .. } => assembled.extend_from_slice(payload),
                Envelope::Chunk { header, payload } => {
                    assembled.extend_from_slice(payload);
                    lasts.push(header.is_last);
                }
                other @ (Envelope::Result { .. }
                | Envelope::Failure { .. }
                | Envelope::Notification { .. }
                | Envelope::Credit { .. }
                | Envelope::Cancel { .. }) => panic!("a request or chunk expected: {other:?}"),
            }
        }
        assert_eq!(assembled, payload);
        assert_eq!(
            lasts,
            if total == 200 {
                vec![false, false, false, true]
            } else {
                vec![false, false, false, false, false, true]
            }
        );
        assert_eq!(
            &pieces(&peer).await[3..],
            if total == 200 {
                vec![
                    (EnvelopeKind::Chunk, call_id, Some(140), 48),
                    (EnvelopeKind::Chunk, call_id, Some(188), 12),
                ]
            } else {
                vec![
                    (EnvelopeKind::Chunk, call_id, Some(140), 48),
                    (EnvelopeKind::Chunk, call_id, Some(188), 48),
                    (EnvelopeKind::Chunk, call_id, Some(236), 48),
                    (EnvelopeKind::Chunk, call_id, Some(284), 16),
                ]
            }
        );
        peer.owner
            .run(|state| {
                assert_eq!(state.activity, [(RouterActivity::Request, Arc::from("a"))]);
            })
            .await
            .expect("request wholly handed off");
        let result = if side == RouterSide::Client {
            Bytes::from_static(&[1])
        } else {
            Bytes::from_static(&[9])
        };
        peer.receive((
            Envelope::Result {
                header: ResultHeader {
                    call_id,
                    total: None,
                    credential: None,
                },
                payload: result.clone(),
            },
            Arc::from("a"),
        ));
        assert_eq!(completed(asked).await.expect("answered").payload, result);
        quiet(&peer).await;
    }
}

// spec 10.4, 12.3
async fn failed_request_chunk() {
    for (side, call_id, total, credit_end) in [
        (RouterSide::Server, 2, 200, 92),
        (RouterSide::Client, 1, 300, 300),
    ] {
        let peer = Peer::new(side, &limits());
        let asked = peer.request((pattern(total), request_of("a")));
        peer.settle().await;
        let message = if side == RouterSide::Client {
            "the transport refused the chunk"
        } else {
            "gone"
        };
        let expected: Arc<dyn std::error::Error + Send + Sync> =
            Arc::new(std::io::Error::other(message));
        let error = RouterError::Other(Arc::clone(&expected));
        peer.owner
            .run(move |state| {
                state.sending.push_back(if side == RouterSide::Client {
                    Ok(Sent::Later(Box::pin(async { Err(error) })))
                } else {
                    Err(error)
                });
            })
            .await
            .expect("chunk fails");
        peer.receive((credit(call_id, credit_end), Arc::from("a")));
        let returned = completed(asked).await.expect_err("chunk failed");
        assert_eq!(returned.to_string(), message);
        assert!(
            matches!(returned, CallError::Other(error) if Arc::ptr_eq(&error, &expected)),
            "the same transport error returns"
        );
        peer.settle().await;
        if side == RouterSide::Server {
            assert_eq!(
                pieces(&peer).await,
                [
                    (EnvelopeKind::Request, 2, Some(200), 44),
                    (EnvelopeKind::Chunk, 2, Some(44), 48),
                    (EnvelopeKind::Cancel, 2, None, 0)
                ]
            );
        }
        assert_eq!(
            pieces(&peer)
                .await
                .iter()
                .filter(|(kind, _, _, _)| *kind == EnvelopeKind::Cancel)
                .count(),
            1,
            "one cancel goes out"
        );
        peer.owner
            .run(move |state| {
                assert!(state.core.pending.is_reserved(call_id, &Arc::from("a")));
            })
            .await
            .expect("call id reserved");
        peer.receive((result_of(call_id, None), Arc::from("a")));
        peer.settle().await;
        quiet(&peer).await;
    }
}

// spec 10.1, 12.4
async fn result_inactivity() {
    for (side, call_id, inactivity, total) in [
        (RouterSide::Server, 2, 250, 150),
        (RouterSide::Client, 1, 2_000, 300),
    ] {
        let peer = Peer::new(
            side,
            &RouterLimitsOptions {
                transfer_inactivity_timeout: Some(Duration::from_millis(inactivity)),
                ..limits()
            },
        );
        let mut request = request_of("a");
        request.options.timeout =
            Duration::from_secs(if side == RouterSide::Server { 1 } else { 5 });
        let mut asked = peer.request((Bytes::new(), request));
        peer.receive((opening(call_id, (pattern(32), total)), Arc::from("a")));
        peer.settle().await;
        let part = chunk(call_id, (pattern(48), 32, false));
        if side == RouterSide::Client {
            peer.clock.advance(Duration::from_millis(1_500)).await;
        }
        peer.receive((part.clone(), Arc::from("a")));
        peer.settle().await;
        if side == RouterSide::Client {
            peer.clock.advance(Duration::from_millis(1_500)).await;
        }
        peer.receive((part, Arc::from("a")));
        peer.settle().await;
        if side == RouterSide::Server {
            assert_eq!(
                peer.armed(),
                [
                    Duration::from_secs(1),
                    Duration::from_millis(250),
                    Duration::from_millis(250)
                ],
                "a duplicate chunk arms no timer"
            );
        }
        assert_eq!(
            peer.clock.dues(),
            [Duration::from_millis(if side == RouterSide::Server {
                250
            } else {
                500
            })]
        );
        if side == RouterSide::Server {
            peer.clock.advance(Duration::from_millis(249)).await;
        }
        assert!(matches!(
            asked.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        peer.clock
            .advance(Duration::from_millis(if side == RouterSide::Server {
                1
            } else {
                500
            }))
            .await;
        let error = completed(asked)
            .await
            .expect_err("inactivity ends the result");
        assert!(
            matches!(error, CallError::TimedOut(timeout) if timeout == Duration::from_millis(inactivity))
        );
        assert_eq!(
            error.to_string(),
            format!("no answer came in {inactivity} milliseconds")
        );
        peer.settle().await;
        assert_eq!(
            pieces(&peer).await.last(),
            Some(&(EnvelopeKind::Cancel, call_id, None, 0))
        );
        quiet(&peer).await;
    }
}

#[tokio::test]
async fn offer_the_side_a_failure_that_answers_no_call_waiting_and_never_a_result() {
    unpaired_failures(3).await;
}

#[tokio::test]
async fn offers_the_side_a_failure_that_answers_no_call_waiting_and_never_a_result() {
    unpaired_failures(7).await;
}

#[tokio::test]
async fn reject_a_result_whose_transfer_is_past_the_payloads_limit_and_cancel_its_call() {
    oversized_result(false).await;
}

#[tokio::test]
async fn rejects_a_result_whose_transfer_is_past_the_payloads_limit_and_cancels_its_call() {
    oversized_result(true).await;
}

#[tokio::test]
async fn receive_a_result_in_a_transfer_credited_as_it_comes_and_settle_its_call_once_whole() {
    credited_result().await;
}

#[tokio::test]
async fn receives_a_result_in_a_transfer_credited_as_it_comes_and_settles_its_call_once_whole() {
    credited_result().await;
}

#[tokio::test]
async fn reject_a_result_whose_chunk_breaks_its_transfer_cancel_its_call_and_drop_what_comes_after()
{
    broken_result(false).await;
}

#[tokio::test]
async fn rejects_a_result_whose_chunk_breaks_its_transfer_cancels_its_call_and_drops_what_comes_after()
 {
    broken_result(true).await;
}

#[tokio::test]
async fn end_a_results_transfer_the_peer_fails_giving_the_budget_back_and_drop_what_comes_after() {
    failed_result_transfer().await;
}

#[tokio::test]
async fn ends_a_results_transfer_the_peer_fails_giving_the_budget_back_and_drops_what_comes_after()
{
    failed_result_transfer().await;
}

#[tokio::test]
async fn report_a_second_result_on_a_call_whose_result_comes_in_a_transfer_and_go_on_receiving_it()
{
    duplicate_result(false).await;
}

#[tokio::test]
async fn reports_a_second_result_on_a_call_whose_result_comes_in_a_transfer_and_goes_on_receiving_it()
 {
    duplicate_result(true).await;
}

#[tokio::test]
async fn send_a_request_as_a_transfer_its_opening_the_chunks_each_credit_lets_go_then_wait_on_its_answer()
 {
    credited_request().await;
}

#[tokio::test]
async fn sends_a_request_as_a_transfer_its_opening_the_chunks_each_credit_lets_go_then_waits_on_its_answer()
 {
    credited_request().await;
}

#[tokio::test]
async fn end_a_request_whose_chunk_cannot_go_out_telling_the_peer_to_cancel_it() {
    failed_request_chunk().await;
}

#[tokio::test]
async fn ends_a_request_whose_chunk_cannot_go_out_telling_the_peer_to_cancel_it() {
    failed_request_chunk().await;
}

#[tokio::test]
async fn set_a_calls_timer_going_again_as_the_bytes_of_its_result_come_and_not_for_bytes_it_has() {
    result_inactivity().await;
}

#[tokio::test]
async fn sets_a_calls_timer_going_again_as_the_bytes_of_its_result_come_and_not_for_bytes_it_has() {
    result_inactivity().await;
}

#[tokio::test]
async fn reject_with_the_failure_the_peer_answers_as_its_side_or_through_a_relay_of_no_side_where_the_call_went()
 {
    received_failures().await;
}

#[tokio::test]
async fn rejects_with_the_failure_the_peer_answers_as_its_side_or_through_a_relay_of_no_side_where_the_call_went()
 {
    received_failures().await;
}

#[tokio::test]
async fn draw_their_call_ids_round_their_range_skip_the_ones_held_and_fail_once_every_one_is() {
    drawn_call_ids(false).await;
}

#[tokio::test]
async fn draws_its_call_ids_round_their_range_skips_the_ones_held_and_fails_once_every_one_is() {
    drawn_call_ids(true).await;
}

#[tokio::test]
async fn send_no_cancel_for_a_request_whose_send_failed_whole_or_its_transfers_opening() {
    failed_request_opening().await;
}

#[tokio::test]
async fn sends_no_cancel_for_a_request_whose_send_failed_whole_or_its_transfers_opening() {
    failed_request_opening().await;
}
