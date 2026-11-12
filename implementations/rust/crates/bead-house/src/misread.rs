//! Text a misread left: a file's UTF-8 read as Windows-1252, then written as UTF-8 again, which
//! turns a character of three bytes opening `E2 80` or `E2 82`, a dash or a quote among them, into
//! `â` then `€` and a third character. No lint reads it, and a crate's documentation opens with it.

use crate::Finding;

const MISREAD: &str = "UTF-8 read as Windows-1252 and written again: write the character it was";

// what such a misread leaves: `â`, then `€`, Windows-1252's 0x80
const MARK: &str = "\u{e2}\u{20ac}";

/// The lines of `source` that hold what a misread of UTF-8 as Windows-1252 leaves.
#[must_use]
pub fn misread_of(source: &str) -> Vec<Finding> {
    source
        .lines()
        .enumerate()
        .filter(|(_, line)| line.contains(MARK))
        .map(|(index, _)| Finding {
            line: index.saturating_add(1),
            reason: MISREAD,
        })
        .collect()
}
