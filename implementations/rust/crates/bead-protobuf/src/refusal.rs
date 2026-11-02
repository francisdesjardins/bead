//! A `proto` codec's refusal (spec 17.2, decision 0016): its reason in 17.2's words and no others,
//! a request's `PAYLOAD_UNDECODABLE` carrying it as its detail; what more the side knows, Buffa's
//! own error, the record the check refused, the required field's full name and its way there, in
//! its cause, never on the wire. The TypeScript side's twin is a `SyntaxError` or a `TypeError` of
//! the reason and its `cause`, the C# side's a `FormatException` of the reason and its inner
//! exception.

use core::fmt;
use std::error::Error;
use std::sync::Arc;

use bead::CodecRefusal;

/// A reader's reason for bytes that are no encoding of its message, and a writer's for what its
/// reader would refuse so, or a value of another message.
pub(crate) const NOT_ITS_MESSAGE: &str = "not its message";

/// A reader's and a writer's reason for a message nested more than 100 deep below the top one
/// (17.9.3).
pub(crate) const NESTED_PAST_100: &str = "nested past 100";

/// A reader's and a writer's reason for a message that leaves a required field unset (17.9.7).
pub(crate) const A_REQUIRED_FIELD_UNSET: &str = "a required field unset";

/// What Bead's own check or walk found, in its words: a refusal's cause.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Found(String);

impl fmt::Display for Found {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for Found {}

/// A refusal saying `reason`, caused by `cause`.
pub(crate) fn refusal<C: Error + Send + Sync + 'static>(reason: &str, cause: C) -> CodecRefusal {
    CodecRefusal::new(reason).caused_by(Arc::new(cause))
}

/// A refusal saying `reason`, caused by what Bead found, in `words`.
pub(crate) fn found<W: Into<String>>(reason: &str, words: W) -> CodecRefusal {
    refusal(reason, Found(words.into()))
}
