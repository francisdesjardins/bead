//! A message an adapter hands its participant (spec 15.19): its acknowledgement, given once.

use core::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use bytes::Bytes;

use crate::broker::adapter::{BrokerMessage, BrokerMessageOptions, BrokerPublication};

fn publication() -> BrokerPublication {
    BrokerPublication::of(["bead", "i", "ada"], Bytes::from_static(&[0xB1]))
}

#[test]
fn acknowledges_its_broker_once_and_nothing_when_built_without_a_settle() {
    let settled = Arc::new(AtomicUsize::new(0));
    let counting = Arc::clone(&settled);
    let counted = BrokerMessage::new(
        publication(),
        BrokerMessageOptions {
            is_retained: Some(true),
            settle: Some(Arc::new(move || {
                counting.fetch_add(1, Ordering::SeqCst);
            })),
        },
    );

    // * a second settle does nothing, nor a clone's
    let copy = counted.clone();

    counted.settle();
    counted.settle();
    copy.settle();
    assert_eq!(
        (settled.load(Ordering::SeqCst), counted.is_retained()),
        (1, true),
        "acknowledged once"
    );

    // none given, as at most once: acknowledged to nothing, and not retained
    let bare = BrokerMessage::new(publication(), BrokerMessageOptions::default());

    bare.settle();
    assert_eq!(
        (bare.is_retained(), bare.payload().first().copied()),
        (false, Some(0xB1)),
        "a message bare"
    );
}
