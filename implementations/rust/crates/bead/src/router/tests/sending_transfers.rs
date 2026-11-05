//! Sending transfers: credit, connection isolation and the identity of a transfer on a reused call.

use std::sync::Arc;

use bytes::Bytes;

use crate::router::parts::{SendingFor, SendingTransfers};
use crate::router::transfer::OutgoingTransfer;
use crate::router::types::CallAddress;

fn call((id, handle): (u32, &str)) -> CallAddress {
    CallAddress {
        call_id: id,
        connection_handle: Arc::from(handle),
    }
}

fn open(sendings: &mut SendingTransfers, (call, purpose): (&CallAddress, SendingFor)) {
    sendings.open(
        call,
        (
            OutgoingTransfer::new(Bytes::from_static(&[0; 200]), (40, 48)),
            purpose,
        ),
    );
}

fn offsets(sendings: &mut SendingTransfers, call: &CallAddress) -> Vec<u64> {
    std::iter::from_fn(|| sendings.next_chunk(call))
        .map(|chunk| chunk.offset)
        .collect()
}

#[test]
fn sends_nothing_before_a_credit_then_the_chunks_each_one_lets_go_to_its_total() {
    let mut sendings = SendingTransfers::default();
    let call = call((1, "a"));
    open(&mut sendings, (&call, SendingFor::Request(1)));
    assert_eq!(offsets(&mut sendings, &call), Vec::<u64>::new());
    assert_eq!(sendings.credit(&call, 168), Some(SendingFor::Request(1)));
    assert_eq!(offsets(&mut sendings, &call), [40, 88]);
    assert_eq!(sendings.credit(&call, 200), Some(SendingFor::Request(1)));
    assert_eq!(offsets(&mut sendings, &call), [136, 184]);
    assert_eq!(sendings.credit(&call, 400), None);
    assert_eq!(offsets(&mut sendings, &call), Vec::<u64>::new());
}

#[test]
fn drops_a_credit_that_grants_nothing_and_one_that_comes_for_no_transfer() {
    let mut sendings = SendingTransfers::default();
    let call = call((1, "a"));
    open(&mut sendings, (&call, SendingFor::Request(1)));
    assert_eq!(sendings.credit(&call, 100), Some(SendingFor::Request(1)));
    assert_eq!(sendings.credit(&call, 90), None);
    assert_eq!(sendings.credit(&call, 100), None);
    assert_eq!(sendings.credit(&self::call((3, "a")), 200), None);
    assert_eq!(sendings.credit(&self::call((1, "b")), 200), None);
    assert_eq!(offsets(&mut sendings, &call), [40]);
}

#[test]
fn closes_no_transfer_but_its_own_not_one_opened_on_its_call_since() {
    let mut sendings = SendingTransfers::default();
    let call = call((1, "a"));
    open(&mut sendings, (&call, SendingFor::Request(1)));
    open(&mut sendings, (&call, SendingFor::Request(2)));
    sendings.close(&call, SendingFor::Request(1));
    assert!(sendings.is_open(&call, SendingFor::Request(2)));
    assert_eq!(sendings.credit(&call, 88), Some(SendingFor::Request(2)));
    assert_eq!(offsets(&mut sendings, &call), [40]);
}

#[test]
fn closes_every_transfer_of_a_connection_or_of_every_one_nothing_more_of_them_goes() {
    let mut sendings = SendingTransfers::default();
    let first = call((1, "a"));
    let second = call((3, "a"));
    let other = call((1, "b"));
    for call in [&first, &second, &other] {
        open(&mut sendings, (call, SendingFor::Request(1)));
    }
    sendings.close_all(Some(&Arc::from("a")));
    for call in [&first, &second] {
        assert_eq!(sendings.credit(call, 88), None);
        assert_eq!(offsets(&mut sendings, call), Vec::<u64>::new());
    }
    assert_eq!(sendings.credit(&other, 88), Some(SendingFor::Request(1)));
    assert_eq!(offsets(&mut sendings, &other), [40]);
    assert_eq!(sendings.gauges().counts.get("sendingTransfers"), Some(&1));
    assert_eq!(
        sendings.gauges().connection_handles,
        std::collections::BTreeSet::from([Arc::from("b")])
    );
    sendings.close_all(Some(&Arc::from("a")));
    sendings.close_all(None);
    assert_eq!(sendings.credit(&other, 200), None);
    assert_eq!(offsets(&mut sendings, &other), Vec::<u64>::new());
    assert!(sendings.gauges().connection_handles.is_empty());
    assert_eq!(sendings.gauges().counts.get("sendingTransfers"), Some(&0));
}

#[test]
fn counts_the_transfers_sent_and_the_connections_they_go_to() {
    let mut sendings = SendingTransfers::default();
    let first = call((1, "a"));
    open(&mut sendings, (&first, SendingFor::Request(1)));
    open(&mut sendings, (&call((3, "a")), SendingFor::Request(2)));
    assert_eq!(sendings.gauges().counts.get("sendingTransfers"), Some(&2));
    assert_eq!(
        sendings.gauges().connection_handles,
        std::collections::BTreeSet::from([Arc::from("a")])
    );
    sendings.close(&first, SendingFor::Request(1));
    assert_eq!(sendings.gauges().counts.get("sendingTransfers"), Some(&1));
}

fn receive_credit(state: &mut crate::testing::core_port::State, (call_id, end): (u32, u64)) {
    crate::router::core::receive(
        state,
        (
            crate::router::types::TransportMessage {
                data: crate::testing::scripted::bytes_of(&crate::envelope::Envelope::Credit {
                    header: crate::envelope::CreditHeader {
                        call_id,
                        credit_end: end,
                        paced: false,
                    },
                }),
                ..crate::router::types::TransportMessage::default()
            },
            &Arc::from("a"),
        ),
    );
}

#[tokio::test]
async fn takes_a_credit_that_comes_as_its_chunks_go_out_as_a_raise_alone_which_they_take_on() {
    use crate::constants::RouterSide;
    use crate::envelope::Envelope;
    use crate::router::types::RouterLimitsOptions;
    use crate::testing::core_port::Peer;

    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    peer.owner
        .run(|state| {
            open(
                &mut state.core.sendings,
                (&call((2, "a")), SendingFor::Request(1)),
            );
            let mut credits = Vec::new();
            state.on_transmit = Some(Box::new(move |state, envelope| {
                let Envelope::Chunk { header, .. } = envelope else {
                    panic!("a chunk")
                };
                let before = state.sent.len();
                credits.push(
                    state.core.sendings.sent[&Arc::from("a")][&2]
                        .outgoing
                        .credit_end(),
                );
                receive_credit(state, (2, header.offset.saturating_add(96)));
                // Every nested send would extend this history within another chunk's hand-off.
                assert_eq!(
                    state.sent.len(),
                    before,
                    "no chunk goes inside another's send"
                );
                if header.is_last {
                    assert_eq!(credits, [88, 136, 184, 200]);
                }
            }));
            receive_credit(state, (2, 88));
            let offsets = state
                .sent
                .iter()
                .map(|(_, envelope)| {
                    let Envelope::Chunk { header, .. } = envelope else {
                        panic!("a chunk")
                    };
                    header.offset
                })
                .collect::<Vec<_>>();
            assert_eq!(offsets, [40, 88, 136, 184]);
            assert_eq!(state.reports.len(), 0);
            crate::router::core::dispose(state);
        })
        .await
        .expect("reentrant credits checked");
}

#[tokio::test]
async fn sends_nothing_more_of_a_transfer_once_ended_even_as_a_credit_s_chunks_go_out() {
    use crate::constants::RouterSide;
    use crate::envelope::Envelope;
    use crate::router::types::RouterLimitsOptions;
    use crate::testing::core_port::Peer;

    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    peer.owner
        .run(|state| {
            let ended = call((2, "a"));
            let kept = call((4, "a"));
            open(&mut state.core.sendings, (&ended, SendingFor::Request(1)));
            open(&mut state.core.sendings, (&kept, SendingFor::Request(2)));
            state.on_transmit = Some(Box::new(|state, envelope| {
                if envelope.call_id() == 2 {
                    state
                        .core
                        .sendings
                        .close(&call((2, "a")), SendingFor::Request(1));
                }
            }));
            receive_credit(state, (2, 200));
            state.core.sendings.close(&ended, SendingFor::Request(1));
            receive_credit(state, (4, 200));
            for _ in 0..2 {
                state.core.sendings.close(&kept, SendingFor::Request(2));
            }
            let offsets = |call_id| {
                state
                    .sent
                    .iter()
                    .filter_map(|(_, envelope)| {
                        if let Envelope::Chunk { header, .. } = envelope {
                            (header.call_id == call_id).then_some(header.offset)
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
            };
            assert_eq!(offsets(2), [40]);
            assert_eq!(offsets(4), [40, 88, 136, 184]);
            assert_eq!(state.reports.len(), 0);
            crate::router::core::dispose(state);
        })
        .await
        .expect("a transfer ends within its send");
}
