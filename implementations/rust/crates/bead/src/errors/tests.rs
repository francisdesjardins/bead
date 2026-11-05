//! An error enum adds no second link for a cause whose words it displays.

use std::error::Error;
use std::fmt;
use std::sync::Arc;

use super::{CallError, ConnectError, ProgrammerError, ResolverError, TransportError};
use crate::router::types::RouterError;

#[test]
fn keeps_the_original_reason_as_cause() {
    let reason = Arc::new(std::io::Error::other("root"));
    let source: Arc<dyn Error + Send + Sync> = Arc::<std::io::Error>::clone(&reason);
    let error = ConnectError::caused("wrapped", source);

    assert_eq!(error.message(), "wrapped");
    assert!(core::ptr::eq(
        error
            .source()
            .expect("the original reason")
            .downcast_ref::<std::io::Error>()
            .expect("the original error type"),
        reason.as_ref()
    ));
}

#[test]
fn timeout_error_keeps_the_milliseconds_waited_and_says_them_or_the_words_it_is_given() {
    let timeout = core::time::Duration::from_millis(5_000);
    let connect = TransportError::TimedOut(timeout);
    assert!(matches!(connect, TransportError::TimedOut(given) if given == timeout));
    assert_eq!(connect.to_string(), "timed out after 5000ms");

    let timeout = core::time::Duration::from_millis(10);
    let unanswered = CallError::TimedOut(timeout);
    assert!(matches!(unanswered, CallError::TimedOut(given) if given == timeout));
    assert_eq!(unanswered.to_string(), "no answer came in 10 milliseconds");
}

#[test]
fn a_cancel_names_its_drawn_call_and_none_when_it_draws_nothing() {
    for call_id in [1, 2, u32::MAX] {
        assert_eq!(
            CallError::Cancelled(Some(call_id)).to_string(),
            format!("call {call_id} was cancelled")
        );
    }
    assert_eq!(
        CallError::Cancelled(None).to_string(),
        "the call was cancelled"
    );
}

#[derive(Debug)]
struct Leaf;

impl fmt::Display for Leaf {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("leaf")
    }
}

impl Error for Leaf {}

#[derive(Debug)]
struct Context(Leaf);

impl fmt::Display for Context {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("context")
    }
}

impl Error for Context {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.0)
    }
}

fn chain(error: &dyn Error) -> Vec<String> {
    let mut words = vec![error.to_string()];
    let mut source = error.source();

    while let Some(error) = source {
        words.push(error.to_string());
        source = error.source();
    }

    words
}

#[test]
fn each_error_enum_displays_its_cause_once_and_keeps_its_sources() {
    assert_eq!(
        chain(&CallError::Other(Arc::new(Context(Leaf)))),
        ["context", "leaf"]
    );
    assert_eq!(
        chain(&ResolverError::other(Context(Leaf))),
        ["context", "leaf"]
    );
    let connect = ConnectError::caused("connect", Arc::new(Context(Leaf)));
    assert_eq!(
        chain(&TransportError::Connect(connect)),
        ["connect", "context", "leaf"]
    );
    assert_eq!(
        chain(&TransportError::cancelled_by(
            "cancelled",
            Arc::new(Context(Leaf))
        )),
        ["cancelled", "context", "leaf"]
    );
    assert_eq!(
        chain(&TransportError::cancelled("cancelled")),
        ["cancelled"]
    );
    assert_eq!(
        chain(&RouterError::Other(Arc::new(Context(Leaf)))),
        ["context", "leaf"]
    );

    let refusal = ProgrammerError::new("refused");
    for words in [
        chain(&CallError::Refused(refusal.clone())),
        chain(&TransportError::Refused(refusal)),
    ] {
        assert_eq!(words, ["refused"], "no duplicate wrapper");
    }
}

// both states named in its words and held by its value; this side reads neither back
#[test]
fn ready_state_error_names_both_states() {
    use crate::transport::ReadyState;

    let error = super::ReadyStateError::new(ReadyState::Closed.name(), ReadyState::Open.name());
    assert_eq!(
        error.to_string(),
        "the transport client is closed, not open"
    );
    assert_eq!(
        error,
        super::ReadyStateError::new(ReadyState::Closed.name(), ReadyState::Open.name())
    );
    assert_ne!(
        error,
        super::ReadyStateError::new(ReadyState::Open.name(), ReadyState::Closed.name())
    );
}
