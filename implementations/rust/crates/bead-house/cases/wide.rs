//! The cases of the count of tuples of three elements or more a function takes: a line the rule
//! counts follows a comment of its own, `// refused:` and why, as every case file marks it, and
//! every other line is one it leaves out. No crate compiles this file: the house's test reads it,
//! and fails unless the lines counted are exactly the ones marked.

use std::collections::BTreeMap;

// ── Counted ──────────────────────────────────────────────────────────────────────────────────

// refused: a tuple of three, by its pattern
fn opened((a, b, c): (u32, u32, u32)) {}

// refused: a tuple of four, whole
fn whole(call: (u32, u32, u32, u32)) {}

// refused: a tuple of three, borrowed
fn borrowed(call: &(u32, String, bool)) {}

// refused: a tuple of three, under parentheses
fn parenthesized(call: ((u32, u32, u32))) {}

pub struct Router;

impl Router {
    // refused: a method's, beside its receiver
    pub(crate) fn reserve(&self, (call_id, timeout, side): (u32, u64, bool)) {}
}

pub trait Side {
    // refused: a trait's method, where the trait declares it
    fn split(&self, (a, b, c): (u32, u32, u32));
}

// ── Left out ─────────────────────────────────────────────────────────────────────────────────

// a tuple of two is one parameter, which the parameter rule counts
fn pair((a, b): (u32, u32)) {}

// the unit is no tuple
fn unit(nothing: ()) {}

// a tuple nested in a type's argument is no parameter's own type
fn nested(calls: Vec<(u32, u32, u32)>, keyed: BTreeMap<u32, (u32, u32, u32)>) {}

// a tuple given back is no parameter
fn gives() -> (u32, u32, u32) {}

// a trait's method is counted where its trait declares it
impl Side for Router {
    fn split(&self, (a, b, c): (u32, u32, u32)) {}
}

fn closure() {
    // a closure's parameter is no function's
    let take = |(a, b, c): (u32, u32, u32)| a;
    // a local is no parameter
    let local: (u32, u32, u32) = (1, 2, 3);
}

pub struct Held {
    // a field is no parameter
    pub call: (u32, u32, u32),
}
