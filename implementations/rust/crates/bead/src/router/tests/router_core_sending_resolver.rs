//! A resolver's failure behind a transferred result neither replaces it nor sends a second answer.

use super::locked;
use super::router_core_requester::credit;
use super::router_core_sending_edges::{pattern, payload, pieces, sent};
use super::router_core_sessions::{handler, request};
use super::router_core_transfer_edges::limits;
use crate::ResolverError;
use crate::constants::RouterSide;
use crate::envelope::{CancelHeader, Envelope};
use crate::errors::CallError;
use crate::router::core as router_core;
use crate::router::types::{BoxFuture, RouterAnswer, RouterError};
use crate::testing::core_port::Peer;
use crate::testing::pair::echo;
use bytes::Bytes;
use std::sync::{Arc, Mutex};

type Answers = Arc<Mutex<Vec<BoxFuture<Result<(), CallError>>>>>;

#[tokio::test]
async fn keep_a_result_going_that_its_resolver_failed_behind_a_second_answer_going_nowhere_until_the_peer_cancels_it()
 {
    for dotnet in [false, true] {
        let peer = Peer::new(RouterSide::Server, &limits());
        let answers = Answers::default();
        let collecting = Arc::clone(&answers);
        let mut handler = handler((&Arc::default(), &Arc::default()));
        let broken = Arc::new(std::io::Error::other("failed behind its answer"));
        let refused = Arc::clone(&broken);
        handler.resolve = Arc::new(move |props| {
            locked(&collecting).extend([
                props
                    .answerer
                    .respond(RouterAnswer::Result(pattern((150, dotnet)))),
                props
                    .answerer
                    .respond(RouterAnswer::Result(Bytes::from_static(&[1]))),
            ]);
            let refused = Arc::clone(&refused);
            Box::pin(
                async move { Err(ResolverError::Other(Box::new(RouterError::Other(refused)))) },
            )
        });
        peer.owner
            .run(move |state| {
                router_core::register_resolver(&state.core.resolvers, (&echo(), handler, None))
                    .expect("the resolver registered");
            })
            .await
            .expect("the port ready");
        peer.receive((request(1, None), Arc::from("a")));
        peer.settle().await;
        peer.receive((credit(1, 80), Arc::from("a")));
        peer.receive((
            Envelope::Cancel {
                header: CancelHeader { call_id: 1 },
            },
            Arc::from("a"),
        ));
        peer.receive((credit(1, 150), Arc::from("a")));
        let pending = { locked(&answers).drain(..).collect::<Vec<_>>() };
        assert_eq!(pending.len(), 2);
        for (index, response) in pending.into_iter().enumerate() {
            let outcome = response.await;
            if index == 0 {
                assert!(
                    matches!(outcome, Err(CallError::Cancelled(_))),
                    "{outcome:?}"
                );
            } else {
                outcome.expect("the second answer settles without sending");
            }
        }
        let envelopes = sent(&peer).await;
        assert_eq!(pieces(&envelopes), [(150, false, 28), (28, false, 48)]);
        assert_eq!(payload(&envelopes), pattern((150, dotnet)).slice(..76));
        peer.owner
            .run(move |state| {
                assert_eq!(state.reports.len(), 1);
                let (handle, RouterError::Other(error)) = &state.reports[0] else {
                    panic!("the resolver's exact error")
                };
                assert_eq!(handle.as_ref(), "a");
                assert_eq!(error.to_string(), "failed behind its answer");
                let expected: Arc<dyn std::error::Error + Send + Sync> = broken;
                assert!(Arc::ptr_eq(error, &expected));
            })
            .await
            .expect("the resolver failure reported once");
    }
}
