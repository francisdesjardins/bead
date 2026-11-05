//! Peers with different chunk sizes refuse the opening or the first short chunk on the wire.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use super::locked;
use super::router_core_transfer_edges::serving;
use super::router_core_transfer_refusals::pattern;
use crate::constants::{EnvelopeKind, ProtocolCode, RouterSide};
use crate::envelope::Envelope;
use crate::errors::CallError;
use crate::failure::FailureOrigin;
use crate::router::types::RouterLimitsOptions;
use crate::testing::core_port::{Peer, completed, request_of};
use crate::testing::scripted;

type Queue = Arc<Mutex<VecDeque<(bool, Envelope)>>>;

fn limits(chunk_bytes: u64) -> RouterLimitsOptions {
    RouterLimitsOptions {
        chunk_bytes: Some(chunk_bytes),
        window_bytes: Some(chunk_bytes.saturating_mul(2)),
        ..RouterLimitsOptions::default()
    }
}

async fn connect(queue: Queue, (peer, to_server): (&Peer, bool)) {
    peer.owner
        .run(move |state| {
            state.on_transmit = Some(Box::new(move |_, envelope| {
                locked(&queue).push_back((to_server, envelope.clone()));
            }));
        })
        .await
        .expect("the peer connected to the wire");
}

#[tokio::test]
async fn refuses_the_opening_of_a_sender_whose_chunk_bytes_is_larger_than_its_own_envelope_too_large_and_the_chunks_of_one_whose_chunk_bytes_is_smaller_chunk_invalid_both_ends_setting_their_limits_alike()
 {
    for dotnet in [false, true] {
        for (requester_size, receiver_size, code, detail) in [
            (
                128,
                64,
                ProtocolCode::ENVELOPE_TOO_LARGE,
                "a request is 64 bytes at most, not 128",
            ),
            (
                64,
                128,
                ProtocolCode::CHUNK_INVALID,
                "a chunk before the last carries 112 bytes, not 48",
            ),
        ] {
            let requester = Peer::new(RouterSide::Client, &limits(requester_size));
            let (receiver, handed) = serving(false, &limits(receiver_size)).await;
            let queue = Queue::default();
            connect(Arc::clone(&queue), (&requester, true)).await;
            connect(Arc::clone(&queue), (&receiver, false)).await;
            let mut options = request_of("a");
            if dotnet {
                options.options.timeout = core::time::Duration::from_secs(5);
            }
            let asking = requester.request((pattern((300, dotnet)), options));
            requester.settle().await;
            let mut traffic = Vec::new();
            loop {
                let next = { locked(&queue).pop_front() };
                let Some((to_server, envelope)) = next else {
                    break;
                };
                assert!(traffic.len() < 100, "the wire settles");
                traffic.push((
                    to_server,
                    envelope.kind(),
                    scripted::bytes_of(&envelope).len(),
                ));
                let peer = if to_server { &receiver } else { &requester };
                peer.receive((envelope, Arc::from("a")));
                peer.settle().await;
            }
            let outcome = completed(asking).await;
            let Err(CallError::Failure(failure)) = outcome else {
                panic!("the receiving peer refuses the transfer: {outcome:?}");
            };
            assert_eq!(failure.code(), code.get());
            assert_eq!(failure.detail(), detail);
            assert_eq!(failure.origin(), FailureOrigin::Peer);
            let mut expected = vec![(
                true,
                EnvelopeKind::Request,
                usize::try_from(requester_size).expect("an envelope size"),
            )];
            if requester_size == 64 {
                expected.push((false, EnvelopeKind::Credit, 16));
                expected.extend(
                    [48, 48, 48, 48, 48, 16].map(|size| (true, EnvelopeKind::Chunk, 16 + size)),
                );
            }
            assert_eq!(traffic[..traffic.len() - 1], expected);
            let (to_server, kind, _) = traffic.last().expect("the refusal sent");
            assert!(!to_server);
            assert_eq!(*kind, EnvelopeKind::Failure);
            assert!(locked(&handed).is_empty());
        }
    }
}
