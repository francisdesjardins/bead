//! What a router holds for its manager of a call it dispatched: the failure it answered in its
//! resolver's place, and none its resolver answered (debugging 4.2).

use core::num::NonZeroU16;
use std::sync::Arc;

use bytes::Bytes;

use super::{Handed, failures_of, keeping, locked, resolving, server};
use crate::constants::{ProtocolCode, RouterSide};
use crate::failure::Failure;
use crate::router::types::RouterAnswer;
use crate::testing::pair::echo;

#[tokio::test]
async fn holds_for_its_manager_the_failure_it_answered_in_a_resolver_s_place_and_none_its_resolver_answered()
 {
    let handed: Handed = Arc::default();
    let served = resolving(keeping((&handed, Some("the resolver breaks"))));
    // the first fails before it answers, answered PROCEDURE_FAILED in its place; the second answers
    // a failure of its own; the third answers a result
    for (call_id, payload) in [(1, "thrown"), (3, "own"), (5, "result")] {
        served.transport.deliver(
            &server::request_of((call_id, &echo(), payload)),
            &server::first(),
        );
    }
    served.settle().await;
    let answerers: Vec<_> = locked(&handed)
        .iter()
        .map(|props| Arc::clone(&props.answerer))
        .collect();
    let own = Failure::application(
        NonZeroU16::new(21).expect("21 is no zero"),
        "nothing to echo",
    );
    answerers[1]
        .respond(RouterAnswer::Failure(own.record()))
        .await
        .expect("its own failure answered");
    answerers[2]
        .respond(RouterAnswer::Result(Bytes::from_static(&[1])))
        .await
        .expect("its result answered");
    served.settle().await;
    assert_eq!(
        failures_of(&served),
        [
            (ProtocolCode::PROCEDURE_FAILED.get().get(), String::new()),
            (21, "nothing to echo".to_owned())
        ]
    );
    assert!(
        served.transport.envelopes(&server::first()).iter().any(
            |envelope| matches!(envelope, crate::envelope::Envelope::Result { header, payload }
                if header.call_id == 5 && payload.as_ref() == [1])
        ),
        "its result went"
    );
    assert_eq!(
        answerers[0].answered().await,
        Some(Failure::protocol(ProtocolCode::PROCEDURE_FAILED, RouterSide::Server).record()),
        "the failure it answered in its resolver's place"
    );
    for answerer in &answerers[1..] {
        assert_eq!(
            answerer.answered().await,
            None,
            "none its resolver answered"
        );
    }
    assert_eq!(served.reported(), ["the resolver breaks first"]);
}
