//! The Rust side's own checks that no lint holds (decision 0044), as `oxlint-plugin.mjs` and
//! `check-surface.mjs` hold the TypeScript side's: the parameter rule, the options struct's shape,
//! each library crate's public surface pinned to its list, no tuple on that surface, the count of
//! the tuples of three elements or more a function takes, the comment tags, and every member under
//! the workspace's lints. Its tests run them over every crate's source, and over the cases of each
//! verdict.

mod members;
mod options;
mod parameters;
mod surface;
mod tags;
mod tuples;
mod wide;

pub use members::members_of;
pub use options::options_of;
pub use parameters::parameters_of;
pub use surface::surface_of;
pub use tags::{Comment, CommentKind, comments_of, tags_of};
pub use tuples::{crate_tuples_of, tuples_of};
pub use wide::wide_tuples_of;

/// A place a check refused, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// Its line, from 1.
    pub line: usize,
    /// Why it was refused.
    pub reason: &'static str,
}
mod futures;
pub use futures::futures_of;
