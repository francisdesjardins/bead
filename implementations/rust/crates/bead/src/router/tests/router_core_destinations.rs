//! A destination's handler owns its admission, payload limit and answers, apart from local resolvers.

use std::sync::Arc;

use bytes::Bytes;

use super::router_core_sessions::handler;
use super::{Handed, locked};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Envelope, RequestHeader};
use crate::failure::Failure;
use crate::router::core::{self as router_core, AdmissionRefusal};
use crate::router::types::{RouterAnswer, RouterLimitsOptions};
use crate::testing::core_port::{Peer, scripted_header};
use crate::testing::pair::echo;

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the routed and local handlers, admission refusal and dispatch identity share one source scenario"
)]
async fn takes_a_request_for_a_destination_to_the_handler_its_port_gives_and_answers_it_by_that_handler_never_a_resolver_at_the_same_address()
 {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let handled = Handed::default();
    let local = Handed::default();
    let routed = Arc::new(handler((&handled, &Arc::default())));
    let mut refusing = handler((&Handed::default(), &Arc::default()));
    refusing.resolve = Arc::new(|_| panic!("a refused destination reaches no callback"));
    refusing.admit = Some(Arc::new(|_| {
        Ok(Some(AdmissionRefusal {
            failure: Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server),
            by: None,
        }))
    }));
    let refusing = Arc::new(refusing);
    let accepted = Arc::clone(&routed);
    let denied = Arc::clone(&refusing);
    let mut registered = handler((&local, &Arc::default()));
    registered.maximum_payload_bytes = Some(8);
    peer.owner
        .run(move |state| {
            router_core::register_resolver(&state.core.resolvers, (&echo(), registered, None))
                .expect("the local resolver");
            state.destination_of = Some(Box::new(move |destination| match destination {
                5 => Some(Arc::clone(&accepted)),
                7 => Some(Arc::clone(&denied)),
                _ => None,
            }));
        })
        .await
        .expect("the destination handlers");
    for (call_id, destination_id, payload) in [
        (1, 5, Bytes::from_static(&[0, 1, 2, 3])),
        (3, 6, Bytes::new()),
        (5, 7, Bytes::new()),
        (7, 5, Bytes::new()),
    ] {
        peer.receive((
            Envelope::Request {
                header: RequestHeader {
                    destination_id: Some(destination_id),
                    ..scripted_header(call_id)
                },
                payload,
            },
            Arc::from("a"),
        ));
    }
    peer.settle().await;
    let requests = locked(&handled).clone();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        (
            requests[0].header.destination_id,
            requests[0].payload.as_ref()
        ),
        (Some(5), [0, 1, 2, 3].as_slice())
    );
    assert_eq!(
        (
            requests[1].header.destination_id,
            requests[1].payload.as_ref()
        ),
        (Some(5), [].as_slice())
    );
    assert!(locked(&local).is_empty());
    let payload = Bytes::from((0..64).collect::<Vec<u8>>());
    requests[0]
        .answerer
        .respond(RouterAnswer::Result(payload.clone()))
        .await
        .expect("the routed answer exceeds the local limit");

    // * an answer goes only through the answerer its request was handed: nothing goes out on 7
    // until that one answers it
    let sent = peer.sent().await;
    assert_eq!(sent.len(), 3);
    for (index, call_id, code) in [
        (0, 3, ProtocolCode::DESTINATION_UNKNOWN),
        (1, 5, ProtocolCode::ACCESS_DENIED),
    ] {
        let (handle, Envelope::Failure { header, failure }) = &sent[index] else {
            panic!("a refused request")
        };
        assert_eq!(handle.as_ref(), "a");
        assert_eq!((header.call_id, failure.code), (call_id, code.get()));
    }
    let (_, Envelope::Failure { failure, .. }) = &sent[0] else {
        panic!("the unknown destination")
    };
    assert_eq!(
        failure.detail,
        "this peer relays nothing, to 6 or elsewhere"
    );
    assert!(
        matches!(&sent[2], (handle, Envelope::Result { header, payload: answer }) if handle.as_ref() == "a" && header.call_id == 1 && *answer == payload)
    );
    requests[1]
        .answerer
        .respond(RouterAnswer::Result(payload.clone()))
        .await
        .expect("the dispatched header answers");
    assert!(
        matches!(peer.sent().await.last(), Some((handle, Envelope::Result { header, payload: answer })) if handle.as_ref() == "a" && header.call_id == 7 && *answer == payload)
    );
    peer.owner
        .run(move |state| {
            assert_eq!(state.before.len(), 4);
            assert!(state.before[0].handler.is_none());
            for (answer, handler) in
                state.before[1..]
                    .iter()
                    .zip([refusing, Arc::clone(&routed), routed])
            {
                assert!(Arc::ptr_eq(
                    answer.handler.as_ref().expect("the destination's handler"),
                    &handler
                ));
            }
            assert!(state.reports.is_empty());
            router_core::dispose(state);
        })
        .await
        .expect("the handlers that write each answer");
}
