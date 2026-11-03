//! Credit returned from within a transport's send finds its transfer and keeps chunks in order.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::locked;
use super::router_core_requester::credit;
use super::router_core_sending_edges::asked;
use super::router_core_sessions::receive;
use super::router_core_transfer_edges::{limits, serving};
use super::router_core_transfer_refusals::{pattern, reports};
use crate::constants::EnvelopeKind;
use crate::envelope::Envelope;
use crate::router::types::RouterAnswer;
use crate::testing::core_port::{State, completed, request_of};

type Depth = Arc<Mutex<(usize, usize)>>;

fn credit_each(state: &mut State, (deferred, depth): (bool, Depth)) {
    state.on_transmit = Some(Box::new(move |state, envelope| {
        {
            let mut current = locked(&depth);
            current.0 = current.0.saturating_add(1);
            current.1 = current.1.max(current.0);
        }
        let end = match envelope {
            Envelope::Chunk { header, payload } => Some(
                header
                    .offset
                    .saturating_add(u64::try_from(payload.len()).expect("a length")),
            ),
            Envelope::Request { header, payload } if header.total.is_some() => {
                Some(u64::try_from(payload.len()).expect("a length"))
            }
            Envelope::Result { header, payload } if header.total.is_some() => {
                Some(u64::try_from(payload.len()).expect("a length"))
            }
            Envelope::Request { .. }
            | Envelope::Result { .. }
            | Envelope::Failure { .. }
            | Envelope::Notification { .. }
            | Envelope::Credit { .. }
            | Envelope::Cancel { .. } => None,
        };
        // The next send has the same hook even when a credit pumps within this send.
        credit_each(state, (deferred, Arc::clone(&depth)));
        if let Some(end) = end {
            let credit = credit(envelope.call_id(), end.saturating_add(48));
            if deferred {
                state
                    .core
                    .owner
                    .post(Box::new(move |state| receive(state, (credit, "a", None))))
                    .expect("the credit queued");
            } else {
                receive(state, (credit, "a", None));
            }
        }
        let mut current = locked(&depth);
        current.0 = current
            .0
            .checked_sub(1)
            .expect("a send returns at its depth");
    }));
}

#[tokio::test]
async fn find_a_transfer_it_sends_at_once_for_a_credit_that_comes_back_as_its_opening_goes_and_never_send_inside_a_send()
 {
    for deferred in [false, true] {
        let (peer, handed) = serving(false, &limits()).await;
        let depth = Depth::default();
        let measuring = Arc::clone(&depth);
        peer.owner
            .run(move |state| credit_each(state, (deferred, measuring)))
            .await
            .expect("each send returns a chunk's credit");
        let payload = pattern((200, deferred));
        let asking = peer.request((payload.clone(), request_of("a")));
        let answerer = asked(&peer, (&handed, Bytes::new())).await;
        answerer
            .respond(RouterAnswer::Result(payload.clone()))
            .await
            .expect("the result sent through returned credits");
        peer.receive((super::result_of(2, None), Arc::from("a")));
        completed(asking).await.expect("the request answered");
        let sent = peer.sent().await;
        let pieces = sent
            .iter()
            .map(|(handle, envelope)| {
                assert_eq!(handle.as_ref(), "a");
                let (at, payload) = match envelope {
                    Envelope::Request { header, payload } => {
                        (header.total.expect("a request transfer"), payload)
                    }
                    Envelope::Result { header, payload } => {
                        (header.total.expect("a result transfer"), payload)
                    }
                    Envelope::Chunk { header, payload } => (header.offset, payload),
                    Envelope::Failure { .. }
                    | Envelope::Notification { .. }
                    | Envelope::Credit { .. }
                    | Envelope::Cancel { .. } => panic!("a transfer's opening or chunk"),
                };
                (envelope.kind(), envelope.call_id(), at, payload.len())
            })
            .collect::<Vec<_>>();
        assert_eq!(
            pieces,
            [
                (EnvelopeKind::Request, 2, 200, 44),
                (EnvelopeKind::Chunk, 2, 44, 48),
                (EnvelopeKind::Chunk, 2, 92, 48),
                (EnvelopeKind::Chunk, 2, 140, 48),
                (EnvelopeKind::Chunk, 2, 188, 12),
                (EnvelopeKind::Result, 1, 200, 28),
                (EnvelopeKind::Chunk, 1, 28, 48),
                (EnvelopeKind::Chunk, 1, 76, 48),
                (EnvelopeKind::Chunk, 1, 124, 48),
                (EnvelopeKind::Chunk, 1, 172, 28),
            ]
        );
        for id in [2, 1] {
            let assembled: Bytes = sent
                .iter()
                .filter(|(_, envelope)| envelope.call_id() == id)
                .flat_map(|(_, envelope)| match envelope {
                    Envelope::Request { payload, .. }
                    | Envelope::Result { payload, .. }
                    | Envelope::Chunk { payload, .. } => payload.iter().copied(),
                    Envelope::Failure { .. }
                    | Envelope::Notification { .. }
                    | Envelope::Credit { .. }
                    | Envelope::Cancel { .. } => panic!("a payload"),
                })
                .collect();
            assert_eq!(assembled, payload);
        }
        // Inline receive nests inside the opening alone; the owner's queue, like C#'s, nests none.
        assert_eq!(*locked(&depth), (0, if deferred { 1 } else { 2 }));
        assert_eq!(reports(&peer).await, []);
    }
}
