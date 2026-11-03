//! Refusal words match their counterparts.

use super::{CallError, TransportError};

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
