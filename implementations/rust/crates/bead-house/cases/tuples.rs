//! The cases of the rule against tuples on the surface: a line the rule refuses follows a comment of
//! its own, `// refused:` and why, and every other line is one it accepts. No crate compiles this
//! file: the house's test reads it, and fails unless the lines refused are exactly the ones marked.

use std::collections::BTreeMap;

// ── Taken or given ───────────────────────────────────────────────────────────────────────────

// refused: a parameter taken as a tuple
pub fn tupled((a, b): (u32, u32)) {}

// refused: a tuple given back
pub fn gives() -> (u32, u32) {}

// refused: a tuple at depth
pub fn listed() -> Vec<(u32, u32)> {}

// refused: an iterator of pairs, the map itself given in its place
pub fn pairs() -> impl Iterator<Item = (u32, u32)> {}

pub struct Router;

impl Router {
    // refused: a method's tuple, beside its receiver
    pub fn reserve(&self, (call_id, timeout): (u32, u64)) {}

    fn private((a, b, c): (u32, u32, u32)) {}

    pub(crate) fn inner((a, b, c): (u32, u32, u32)) {}
}

pub trait Side {
    // refused: a trait's method, where the trait declares it
    fn split(&self) -> (u32, u32);
}

// a trait's method is judged where its trait declares it
impl Side for Router {
    fn split(&self) -> (u32, u32) {}
}

// a function of the crate's own counts a tuple as one parameter, as the parameter rule does
fn tupled_inside((a, b, c): (u32, u32, u32)) {}

pub(crate) fn tupled_crate((a, b, c): (u32, u32, u32)) {}

pub fn unit() -> Result<(), String> {}

pub fn mapped() -> BTreeMap<u32, u32> {}

// ── Held ─────────────────────────────────────────────────────────────────────────────────────

pub struct Held {
    // refused: a public field of pairs
    pub pairs: Vec<(u32, u32)>,
    held: (u32, u32),
}

// refused: a public alias of a tuple
pub type Pair = (u32, u32);

// refused: a constant of a tuple
pub const RANGE: (u32, u32) = (1, 2);

// an alias of the crate's own is judged by what it stands for
type Hidden = (u32, u32);

// refused: a tuple an alias of the crate's own carries in
pub fn first(pair: Hidden) {}

pub(crate) fn hidden_inside(pair: Hidden) {}

// ── Unnamed fields ───────────────────────────────────────────────────────────────────────────

pub enum Changed {
    // refused: a variant of two unnamed fields
    Value(u32, u32),
    Named { new_value: u32, old_value: u32 },
    One(u32),
}

// refused: a struct of two unnamed fields
pub struct Two(pub u32, pub u32);

// a newtype keeps its one field (C-NEWTYPE)
pub struct Id(pub u32);

pub(crate) struct Inner(u32, u32);

// ── Left out ─────────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
pub fn tested() -> (u32, u32) {}

pub mod testing {
    pub fn kit() -> (u32, u32) {}
}
