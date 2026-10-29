//! The Rust side's own checks that no lint holds (decision 0044), as `oxlint-plugin.mjs` holds the
//! TypeScript side's: the parameter rule, the comment tags, and every member under the workspace's
//! lints. Its tests run them over every crate's source, and over the cases of each verdict.

mod members;
mod parameters;
mod tags;

pub use members::members_of;
pub use parameters::parameters_of;
pub use tags::{Comment, CommentKind, comments_of, tags_of};

/// A place a check refused, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// Its line, from 1.
    pub line: usize,
    /// Why it was refused.
    pub reason: &'static str,
}
