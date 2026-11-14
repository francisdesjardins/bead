//! Incoming transfers refused before credit, credited from within a send, or broken by a chunk.

use std::sync::Arc;

use bytes::Bytes;

use super::locked;
use super::router_core_requester::opening as result_opening;
use super::router_core_sessions::receive;
use super::router_core_transfer_edges::{Outgoing, chunk, limits, opening, outgoing, serving};
use crate::constants::ProtocolCode;
use crate::envelope::{ChunkHeader, Envelope};
use crate::router::types::{RouterError, RouterLimitsOptions};
use crate::testing::core_port::{Peer, completed, request_of};

pub(super) fn pattern((total, dotnet): (usize, bool)) -> Bytes {
    (0..total)
        .map(|index| {
            let value = if dotnet {
                index.wrapping_mul(7).wrapping_add(index >> 8) % 251
            } else {
                index.wrapping_mul(7).wrapping_add(3) % 256
            };
            u8::try_from(value).expect("a byte")
        })
        .collect()
}

pub(super) async fn reports(peer: &Peer) -> Vec<(String, ProtocolCode)> {
    peer.owner
        .run(|state| {
            state
                .reports
                .iter()
                .map(|(handle, error)| {
                    let RouterError::Failure(failure) = error else {
                        panic!("a protocol failure, not {error:?}");
                    };
                    (
                        handle.to_string(),
                        failure.protocol_code().expect("a protocol code"),
                    )
                })
                .collect()
        })
        .await
        .expect("the reports read")
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the twin plays each refusal of spec 12.3's order, and the wait of 0, in one table"
)]
async fn refuse_an_opening_before_any_credit_goes_each_by_its_own_failure_and_keep_nothing_of_it() {
    for (index, total, length, code, detail) in [
        (
            0,
            0,
            1,
            ProtocolCode::PAYLOAD_TOO_LARGE,
            "a transfer declares its total, not 0",
        ),
        (
            1,
            1_025,
            1,
            ProtocolCode::PAYLOAD_TOO_LARGE,
            "a payload is 1024 bytes at most, not 1025",
        ),
        (
            2,
            8,
            1,
            ProtocolCode::PAYLOAD_TOO_LARGE,
            "this peer takes no transfer",
        ),
        (
            3,
            4,
            4,
            ProtocolCode::CHUNK_INVALID,
            "an opening of 4 bytes holds its whole total of 4",
        ),
        (
            4,
            8,
            1,
            ProtocolCode::CAPACITY_EXCEEDED,
            "the transfers a connection receives at once are 1 at most",
        ),
        (
            5,
            8,
            1,
            ProtocolCode::CHUNK_INVALID,
            "an opening carries 44 bytes of its payload, not 1",
        ),
        // a wait of 0 for the budget refuses at once an opening the budget left cannot hold
        (
            6,
            100,
            44,
            ProtocolCode::CAPACITY_EXCEEDED,
            "a total of 100 bytes waited 0 milliseconds for the budget",
        ),
    ] {
        let follows_one = matches!(index, 4 | 6);
        // chunks of 64 bytes, in envelopes as large as by default, for a refusal's detail to go
        // whole
        let options = RouterLimitsOptions {
            chunk_bytes: Some(64),
            window_bytes: Some(128),
            maximum_payload_bytes: Some(if index == 6 { 128 } else { 1_024 }),
            maximum_transfers: match index {
                2 => Some(0),
                4 => Some(1),
                _ => None,
            },
            buffered_bytes_budget: (index == 6).then_some(128),
            transfer_inactivity_timeout: (index == 6)
                .then_some(core::time::Duration::from_millis(1)),
            ..RouterLimitsOptions::default()
        };
        let (peer, handed) = serving(false, &options).await;
        peer.owner
            .run(move |state| {
                if follows_one {
                    receive(
                        state,
                        (opening(1, (Bytes::from(vec![0; 44]), 128)), "a", None),
                    );
                }
                receive(
                    state,
                    (opening(3, (Bytes::from(vec![1; length]), total)), "a", None),
                );
                receive(
                    state,
                    (chunk(3, (4, Bytes::from_static(&[1]), 8)), "a", None),
                );
            })
            .await
            .expect("the opening and its uncredited chunk received");
        peer.settle().await;
        let sent = peer.sent().await;
        assert_eq!(sent.len(), if follows_one { 2 } else { 1 });
        if follows_one {
            let (handle, Envelope::Credit { header }) = &sent[0] else {
                panic!("the admitted transfer credited");
            };
            assert_eq!(handle.as_ref(), "a");
            assert_eq!(header.call_id, 1);
            assert!(!header.paced);
        }
        let (handle, Envelope::Failure { header, failure }) = sent.last().expect("the refusal")
        else {
            panic!("the opening refused");
        };
        assert_eq!(handle.as_ref(), "a");
        assert_eq!(header.call_id, 3);
        assert_eq!(header.credential, None);
        assert_eq!(failure.code, code.get());
        assert_eq!(failure.detail, detail);
        assert_eq!(
            reports(&peer).await,
            [("a".to_owned(), ProtocolCode::CALL_UNKNOWN)]
        );
        assert!(locked(&handed).is_empty());
    }
}

#[tokio::test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
async fn find_a_transfer_that_a_chunk_comes_for_at_once_as_its_first_credit_goes_out() {
    for dotnet in [false, true] {
        let (peer, handed) = serving(false, &limits()).await;
        peer.owner
            .run(move |state| {
                state.on_transmit = Some(Box::new(move |state, envelope| {
                    if let Envelope::Credit { header } = envelope {
                        let offset = if header.call_id == 1 { 44 } else { 28 };
                        receive(
                            state,
                            (
                                chunk(
                                    header.call_id,
                                    (
                                        offset,
                                        pattern((76, dotnet))
                                            .slice(usize::try_from(offset).expect("an offset")..),
                                        76,
                                    ),
                                ),
                                "a",
                                None,
                            ),
                        );
                    }
                }));
            })
            .await
            .expect("the port answers each first credit within its send");
        let asking = peer.request((Bytes::new(), request_of("a")));
        peer.receive((
            opening(1, (pattern((76, dotnet)).slice(..44), 76)),
            Arc::from("a"),
        ));
        peer.settle().await;
        peer.receive((
            result_opening(2, (pattern((76, dotnet)).slice(..28), 76)),
            Arc::from("a"),
        ));
        assert_eq!(
            completed(asking)
                .await
                .expect("the result assembled")
                .payload,
            pattern((76, dotnet))
        );
        assert_eq!(
            locked(&handed)
                .iter()
                .map(|props| props.payload.clone())
                .collect::<Vec<_>>(),
            [pattern((76, dotnet))]
        );
        assert_eq!(reports(&peer).await, []);
    }
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the twin keeps the broken, abandoned and reused call in one scenario"
)]
#[expect(
    clippy::disallowed_methods,
    reason = "the test slices its own fixed payload at offsets within its length"
)]
async fn end_a_requests_transfer_with_the_failure_a_chunk_breaks_and_drop_what_its_credit_let_come_after()
 {
    for (dotnet, end) in [(false, 124), (true, 132)] {
        let (peer, handed) = serving(false, &limits()).await;
        peer.owner
            .run(move |state| {
                let payload = pattern((200, dotnet));
                receive(state, (opening(1, (payload.slice(..44), 200)), "a", None));
                receive(
                    state,
                    (
                        Envelope::Chunk {
                            header: ChunkHeader {
                                call_id: 1,
                                is_last: true,
                                offset: 44,
                            },
                            payload: payload.slice(44..84),
                        },
                        "a",
                        None,
                    ),
                );
                for (offset, end) in [(84, end), (160, 200)] {
                    receive(
                        state,
                        (
                            chunk(
                                1,
                                (
                                    offset,
                                    payload.slice(usize::try_from(offset).expect("an offset")..end),
                                    200,
                                ),
                            ),
                            "a",
                            None,
                        ),
                    );
                }
                receive(state, (opening(3, (payload.slice(..44), 200)), "a", None));
                receive(
                    state,
                    (chunk(3, (168, payload.slice(168..), 200)), "a", None),
                );
                receive(
                    state,
                    (
                        Envelope::Request {
                            header: crate::testing::core_port::scripted_header(1),
                            payload: if end == 124 {
                                Bytes::new()
                            } else {
                                Bytes::from_static(&[1])
                            },
                        },
                        "a",
                        None,
                    ),
                );
                receive(
                    state,
                    (chunk(1, (84, payload.slice(84..end), 200)), "a", None),
                );
            })
            .await
            .expect("the broken transfers and reused call received");
        peer.settle().await;
        assert_eq!(
            outgoing(&peer).await,
            [
                ("a".to_owned(), Outgoing::Credit(1, 172)),
                (
                    "a".to_owned(),
                    Outgoing::Failure(1, ProtocolCode::CHUNK_INVALID.get().get())
                ),
                ("a".to_owned(), Outgoing::Credit(3, 172)),
                (
                    "a".to_owned(),
                    Outgoing::Failure(3, ProtocolCode::CREDIT_EXCEEDED.get().get())
                ),
            ]
        );
        assert_eq!(
            reports(&peer).await,
            [
                ("a".to_owned(), ProtocolCode::CREDIT_EXCEEDED),
                ("a".to_owned(), ProtocolCode::ENVELOPE_MALFORMED),
            ]
        );
        peer.owner
            .run(|state| {
                assert!(
                    state.reports[1]
                        .1
                        .to_string()
                        .contains("call 1 receives no transfer")
                );
            })
            .await
            .expect("the open call's report");
        assert_eq!(
            locked(&handed)
                .iter()
                .map(|props| (props.header.call_id, props.header.total))
                .collect::<Vec<_>>(),
            [(1, None)]
        );
    }
}
