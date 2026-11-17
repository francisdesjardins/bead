//! A `pattern` rule's match (spec 18.8.5, decision 0035): the DFA beadc builds from the pattern's
//! RE2 program, walked a code point at a time, its class by a search of the ranges' bounds, then
//! one cell, so a match costs a constant per character whatever the pattern, never a backtracking
//! engine's. The TypeScript side's twin is `matchesPattern`, the C# side's `Pattern.Matches`.

#[cfg(test)]
mod tests;

/// A pattern's table, as beadc writes it into generated code.
///
/// The code points split into classes every instruction treats alike, each class written once by
/// the bounds of its ranges, and the transitions of each state by class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PatternTable {
    /// The states the text's end leaves matched, ascending.
    pub accepting: &'static [u16],
    /// The first code point of each range, ascending from 0; a code point's range is the last that
    /// starts at or below it.
    pub bounds: &'static [u32],
    /// How many classes the code points fall into: a row's cells.
    pub class_count: u16,
    /// The class of each range, by its index in `bounds`.
    pub classes: &'static [u16],
    /// The state no text leaves for a match, where it has one: the walk ends there, refused.
    pub dead: Option<u16>,
    /// The state a match, once reached, keeps whatever follows, where it has one: the walk ends
    /// there, taken.
    pub matched: Option<u16>,
    /// How many states it holds.
    pub state_count: u16,
    /// Each state's next, by class: the cell of state `s` and class `c` at `s × class_count + c`,
    /// the start state 0's first.
    pub transitions: &'static [u16],
}

// what a walk reads of its table, counted by the tests alone
pub(super) trait Reads {
    fn bound(&mut self);
    fn cell(&mut self);
}

// a walk that counts nothing
impl Reads for () {
    fn bound(&mut self) {}

    fn cell(&mut self) {}
}

// the class of `point` in `table`: the range it falls in, by a binary search over their bounds
fn class_of<R: Reads>(table: &PatternTable, (point, reads): (u32, &mut R)) -> usize {
    let bounds = table.bounds;
    let mut low = 0_usize;
    let mut high = bounds.len().saturating_sub(1);

    while low < high {
        let middle = low.saturating_add(high).saturating_add(1) / 2;

        reads.bound();

        if bounds.get(middle).is_some_and(|bound| *bound <= point) {
            low = middle;
        } else {
            high = middle.saturating_sub(1);
        }
    }

    table
        .classes
        .get(low)
        .map_or(0, |class| usize::from(*class))
}

// the walk of `text`, each read of the table told to `reads`
pub(super) fn walked<R: Reads>(table: &PatternTable, (text, reads): (&str, &mut R)) -> bool {
    let class_count = usize::from(table.class_count);
    let mut state = 0_u16;

    for character in text.chars() {
        let class = class_of(table, (u32::from(character), &mut *reads));
        let cell = usize::from(state)
            .saturating_mul(class_count)
            .saturating_add(class);

        reads.cell();

        // ! a cell past the table is no state's: the walk ends there, refused
        let Some(next) = table.transitions.get(cell).copied() else {
            return false;
        };

        state = next;

        if table.matched == Some(state) {
            return true;
        }

        if table.dead == Some(state) {
            return false;
        }
    }

    table.accepting.contains(&state)
}

/// Whether `table`'s pattern matches anywhere in `text`, unless it is anchored.
///
/// One class and one cell a code point; the walk ends at the state a match keeps, or at the one no
/// match leaves. A Rust string holds no surrogate: Buffa refuses a `string` whose UTF-8 carries
/// one, where the other sides read it as U+FFFD.
#[must_use]
pub fn matches_pattern(table: &PatternTable, text: &str) -> bool {
    walked(table, (text, &mut ()))
}
