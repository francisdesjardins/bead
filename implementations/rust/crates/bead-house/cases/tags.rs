//! The cases of the comment tags: a line the rule refuses follows a comment of its own, `// refused:`
//! and why, and every other line is one it accepts. No crate compiles this file: the house's test
//! reads it, and fails unless the lines refused are exactly the ones marked.

// ! a plain comment opens with a tag
// ? an open question
// TODO work to do beside the code
// * the key point of a block

/// A doc comment carries no tag.
pub struct Plain;

// refused: an outer doc comment that opens with the `!` tag
/// ! a doc comment never alerts
pub struct Alerting;

// refused: an outer doc comment that opens with `TODO`
/// TODO work no doc comment holds
pub struct Owed;

// refused: an inner doc comment that opens with the `*` tag
//! * the key point, where a doc comment cannot carry it
pub struct Inner;

/** A block doc comment carries none either. */
pub struct Block;

// refused: a block doc comment that opens with the `?` tag
/** ? an open question */
pub struct Asking;

//// four slashes are a plain comment: ! may follow
/*** three stars a plain block */
pub struct Plainly;

// what a string or a character holds is no comment
pub const SLASHES: &str = "/// ! within a string";
pub const RAW: &str = r#"//! ! within a raw string, "quoted""#;
pub const QUOTE: char = '"';
pub const SLASH: char = '/';

pub fn of<'a>(text: &'a str) -> &'a str {
    text
}
