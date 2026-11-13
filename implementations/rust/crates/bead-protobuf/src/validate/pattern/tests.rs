//! A pattern's table walked as generated code walks it: tables written by hand as beadc writes
//! them, their reads counted, so a match is seen to cost one cell a code point and a search of the
//! bounds, whatever the pattern. The twin of the TypeScript side's `pattern.test.ts` and the C#
//! side's `PatternTests`.

use super::{PatternTable, Reads, matches_pattern, walked};

// `^(a+)+$`, as its DFA: state 0 the start, 1 dead, 2 after one `a` or more, accepting at the end;
// class 0 every code point but `a`, class 1 `a`
const NESTED: PatternTable = PatternTable {
    accepting: &[2],
    bounds: &[0, 0x61, 0x62],
    class_count: 2,
    classes: &[0, 1, 0],
    dead: Some(1),
    matched: None,
    state_count: 3,
    transitions: &[1, 2, 1, 1, 1, 2],
};

// `ok`, unanchored: matched for good once `ok` was read, wherever it is
const ANYWHERE: PatternTable = PatternTable {
    accepting: &[2],
    bounds: &[0, 0x6b, 0x6c, 0x6f, 0x70],
    class_count: 3,
    classes: &[0, 1, 0, 2, 0],
    dead: None,
    matched: Some(2),
    state_count: 3,
    transitions: &[0, 0, 1, 0, 2, 1, 2, 2, 2],
};

// the largest table beadc takes, 16,384 cells: 4,096 states in a ring, each of 4 classes stepping on
const RING_STATES: u16 = 4_096;
const RING_CLASSES: u16 = 4;
const RING_RANGES: u32 = 1_024;

// the reads of a walk, counted
#[derive(Default)]
struct Counted {
    bounds: usize,
    cells: usize,
}

impl Reads for Counted {
    fn bound(&mut self) {
        self.bounds = self.bounds.saturating_add(1);
    }

    fn cell(&mut self) {
        self.cells = self.cells.saturating_add(1);
    }
}

#[expect(
    clippy::disallowed_methods,
    reason = "the test repeats its own string a bounded number of times"
)]
fn repeated(text: &str, count: usize) -> String {
    text.repeat(count)
}

fn counted(table: &PatternTable, text: &str) -> (bool, Counted) {
    let mut reads = Counted::default();
    let matched = walked(table, (text, &mut reads));

    (matched, reads)
}

// a ring of RING_STATES states, each class stepping to the next, over RING_RANGES ranges
fn ring_of() -> PatternTable {
    let mut transitions = Vec::new();

    for state in 0..RING_STATES {
        for class in 0..RING_CLASSES {
            transitions.push(state.saturating_add(1).saturating_add(class) % RING_STATES);
        }
    }

    PatternTable {
        accepting: &[0],
        bounds: Vec::leak((0..RING_RANGES).map(|at| at.saturating_mul(64)).collect()),
        class_count: RING_CLASSES,
        classes: Vec::leak(
            (0..RING_RANGES)
                .map(|at| u16::try_from(at).expect("a range") % RING_CLASSES)
                .collect(),
        ),
        dead: None,
        matched: None,
        state_count: RING_STATES,
        transitions: Vec::leak(transitions),
    }
}

#[test]
fn matches_in_time_linear_in_its_input() {
    // * a backtracking engine never ends on this one; a table reads a cell a character
    for length in [1_000, 100_000] {
        let (matched, reads) = counted(&NESTED, &format!("{}!", repeated("a", length)));

        assert!(!matched, "refused at the end");
        assert_eq!(reads.cells, length + 1, "a cell a character");
        assert!(reads.bounds <= (length + 1) * 2, "a search of 3 bounds");
    }

    assert!(matches_pattern(&NESTED, &repeated("a", 100_000)), "matched");
    assert!(!matches_pattern(&NESTED, ""), "nothing matches nothing");
}

#[test]
fn walks_one_cell_a_character_whatever_the_pattern_s_size() {
    let ring = ring_of();
    // 1 MiB of characters, the first code point of every range in turn, a surrogate's left out
    let points: Vec<char> = ring
        .bounds
        .iter()
        .filter_map(|point| char::from_u32(*point))
        .collect();
    let text: String = (0..1_048_576).map(|at| points[at % points.len()]).collect();
    let (matched, reads) = counted(&ring, &text);

    assert_eq!(ring.transitions.len(), 16_384, "the largest table");
    assert!(matched, "back at the start");
    assert_eq!(reads.cells, 1_048_576, "a cell a character");
    // a binary search over 1,024 bounds: 10 reads a character
    assert_eq!(reads.bounds, 1_048_576 * 10, "10 reads a character");
}

#[test]
fn keeps_a_match_once_reached_wherever_it_is_and_stops_there() {
    let (matched, reads) = counted(&ANYWHERE, &format!("xxok{}", repeated("y", 1_000)));

    assert!(matched, "matched");
    assert_eq!(reads.cells, 4, "stopped there");
    assert!(!matches_pattern(&ANYWHERE, "o k"), "no ok");
}

#[test]
fn reads_a_surrogate_alone_as_u_fffd_a_code_point_of_no_range_of_its_own() {
    let replacement = PatternTable {
        accepting: &[2],
        bounds: &[0, 0xFFFD, 0xFFFE],
        class_count: 2,
        classes: &[0, 1, 0],
        dead: Some(1),
        matched: None,
        state_count: 3,
        transitions: &[1, 2, 1, 1, 1, 1],
    };

    // ! a Rust string holds no surrogate: its UTF-8 is refused before a rule reads it, where the
    // other sides read it as U+FFFD, which is read here as itself
    assert!(
        core::str::from_utf8(&[0xED, core::hint::black_box(0xA0), 0x80]).is_err(),
        "a surrogate's UTF-8 refused"
    );
    assert!(matches_pattern(&replacement, "\u{FFFD}"), "U+FFFD its own");
    assert!(!matches_pattern(&replacement, "😀"), "another code point");
}
