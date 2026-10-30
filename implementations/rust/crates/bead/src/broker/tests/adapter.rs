//! The adapter contract's Rust values: capabilities, diagnostics and optional listener callbacks.

use core::sync::atomic::{AtomicUsize, Ordering};
use std::error::Error;
use std::sync::Arc;

use bytes::Bytes;

use crate::broker::adapter::{
    BrokerCapabilities, BrokerDown, BrokerError, BrokerListener, BrokerMessage,
    BrokerMessageOptions, BrokerPublication,
};
use crate::errors::ProgrammerError;

fn publication() -> BrokerPublication {
    BrokerPublication::of(["bead", "i", "ada"], Bytes::from_static(b"private payload"))
}

#[test]
fn combines_capabilities_without_offering_any_that_are_absent() {
    let grouped = BrokerCapabilities::GROUPS | BrokerCapabilities::WILL;

    assert!(grouped.contains(BrokerCapabilities::NONE), "the empty set");
    assert!(
        grouped.contains(BrokerCapabilities::GROUPS),
        "groups offered"
    );
    assert!(grouped.contains(BrokerCapabilities::WILL), "a will offered");
    assert!(!grouped.contains(BrokerCapabilities::EXPIRY), "no expiry");
    assert!(
        !grouped.contains(BrokerCapabilities::GROUPS | BrokerCapabilities::NO_SUBSCRIBER),
        "every requested capability is due"
    );
    assert_eq!(
        grouped | BrokerCapabilities::NO_SUBSCRIBER | BrokerCapabilities::EXPIRY,
        BrokerCapabilities::ALL,
        "the complete set"
    );
    assert_eq!(
        BrokerCapabilities::default(),
        BrokerCapabilities::NONE,
        "no optional capability by default"
    );
}

#[test]
fn reports_a_refusal_as_its_cause_and_a_link_failure_as_its_message_alone() {
    let misuse = ProgrammerError::new("the adapter offers no groups");
    let refused = BrokerError::from(misuse.clone());

    assert_eq!(
        refused.to_string(),
        misuse.to_string(),
        "the refusal's message"
    );
    let cause = refused.source().expect("the refusal's cause");
    assert_eq!(
        cause.downcast_ref::<ProgrammerError>(),
        Some(&misuse),
        "the typed refusal"
    );

    let failed = BrokerError::failed("its broker closes the link");

    assert_eq!(
        failed.to_string(),
        "its broker closes the link",
        "the failure"
    );
    assert!(failed.source().is_none(), "no fabricated cause");
}

#[test]
fn describes_a_message_by_its_topic_and_size_without_its_payload() {
    let message = BrokerMessage::new(publication(), BrokerMessageOptions::default());

    assert_eq!(message.topic(), ["bead", "i", "ada"], "the topic tokens");
    assert_eq!(
        message.payload(),
        b"private payload".as_slice(),
        "the payload"
    );
    assert_eq!(
        format!("{message:?}"),
        "BrokerMessage { topic: [\"bead\", \"i\", \"ada\"], payload: 15 bytes, is_retained: false, .. }",
        "diagnostics carry the size alone"
    );
}

#[test]
fn describes_a_settle_without_calling_it_and_shares_it_through_cloned_options() {
    let settles = Arc::new(AtomicUsize::new(0));
    let counting = Arc::clone(&settles);
    let options = BrokerMessageOptions {
        is_retained: Some(true),
        settle: Some(Arc::new(move || {
            counting.fetch_add(1, Ordering::SeqCst);
        })),
    };

    assert_eq!(
        format!("{options:?}"),
        "BrokerMessageOptions { is_retained: Some(true), settle: true }",
        "a callback's presence"
    );
    assert_eq!(
        format!("{:?}", BrokerMessageOptions::default()),
        "BrokerMessageOptions { is_retained: None, settle: false }",
        "absent options"
    );
    let copy = options.clone();
    let first = BrokerMessage::new(publication(), options);
    let second = BrokerMessage::new(publication(), copy);

    assert_eq!(
        settles.load(Ordering::SeqCst),
        0,
        "not settled by diagnostics"
    );
    assert!(
        first.is_retained() && second.is_retained(),
        "retained in both"
    );
    first.settle();
    second.settle();
    assert_eq!(settles.load(Ordering::SeqCst), 2, "one settle per message");
}

#[derive(Default)]
struct MessagesOnly(AtomicUsize);

impl BrokerListener for MessagesOnly {
    fn on_message(&self, _message: &BrokerMessage) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct DownsOnly(AtomicUsize);

impl BrokerListener for DownsOnly {
    fn on_down(&self, down: BrokerDown) {
        if down.is_taken_over {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[test]
fn lets_a_listener_hear_messages_or_link_loss_alone() {
    let message = BrokerMessage::new(publication(), BrokerMessageOptions::default());
    let messages = MessagesOnly::default();
    let downs = DownsOnly::default();

    messages.on_down(BrokerDown::of(true));
    messages.on_message(&message);
    downs.on_message(&message);
    downs.on_down(BrokerDown::of(false));
    downs.on_down(BrokerDown::of(true));
    assert_eq!(messages.0.load(Ordering::SeqCst), 1, "one message");
    assert_eq!(downs.0.load(Ordering::SeqCst), 1, "one takeover");
}
