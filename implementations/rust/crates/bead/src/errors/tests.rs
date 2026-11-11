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

    let error = super::ReadyStateError::new(ReadyState::Closed, ReadyState::Open);
    assert_eq!(
        error.to_string(),
        "the transport client is closed, not open"
    );
    assert_eq!(error.got(), ReadyState::Closed);
    assert_eq!(error.expected(), ReadyState::Open);
    assert_eq!(
        error,
        super::ReadyStateError::new(ReadyState::Closed, ReadyState::Open)
    );
    assert_ne!(
        error,
        super::ReadyStateError::new(ReadyState::Open, ReadyState::Closed)
    );
}

// Rust's From, `ResolverError::other` and Error adapters keep one diagnostic and the cause chain
// it already names.
#[test]
fn converting_a_failure_or_ready_state_keeps_its_diagnostic_and_source_chain() {
    use crate::constants::{ProtocolCode, RouterSide};
    use crate::failure::Failure;
    use crate::transport::ReadyState;

    let failure = Failure::protocol(ProtocolCode::PROCEDURE_FAILED, RouterSide::Server)
        .caused_by(Arc::new(Context(Leaf)));
    let expected = chain(&failure);
    let call = CallError::from(failure.clone());
    let resolver = ResolverError::other(failure);

    assert_eq!(
        chain(&call),
        expected,
        "conversion adds no wrapper to a call failure"
    );
    assert_eq!(
        chain(&resolver),
        expected,
        "conversion adds no wrapper to a resolver failure"
    );

    let state = super::ReadyStateError::new(ReadyState::Closed, ReadyState::Open);

    for words in [
        chain(&CallError::ReadyState(state.clone())),
        chain(&TransportError::from(state)),
    ] {
        assert_eq!(
            words,
            ["the transport client is closed, not open"],
            "a ready-state error has no invented cause"
        );
    }

    assert_eq!(
        chain(&TransportError::from(ConnectError::caused(
            "connect",
            Arc::new(Context(Leaf))
        ))),
        ["connect", "context", "leaf"],
        "From keeps a connect's cause"
    );
    assert_eq!(
        chain(&TransportError::TimedOut(
            core::time::Duration::from_millis(1)
        )),
        ["timed out after 1ms"],
        "a timeout has no source"
    );
    assert_eq!(
        chain(&CallError::Cancelled(None)),
        ["the call was cancelled"],
        "a cancellation has no source"
    );
    assert_eq!(
        chain(&CallError::Disconnected("gone".to_owned())),
        ["gone"],
        "a disconnect has no source"
    );
    assert_eq!(
        chain(&CallError::TimedOut(core::time::Duration::from_millis(1))),
        ["no answer came in 1 milliseconds"],
        "a call timeout has no source"
    );
    assert_eq!(
        super::Disposed.to_string(),
        "the router is disposed",
        "a disposed owner names its refusal"
    );
}
