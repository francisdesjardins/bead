//! The cases of the wire literal rule (decision 0057): a line the rule refuses follows a comment of
//! its own, `// refused:` and why, as every case file marks it, and every other line is one it
//! leaves out. No crate compiles this file: the house's test reads it, and fails unless the lines
//! refused are exactly the ones marked. Every number here is one 0x80 a comment holds, and none of
//! them is refused for it.

// ── Refused ─────────────────────────────────────────────────────────────────────────────────

fn opcode_of(first: u8) -> u8 {
    // refused: a hex literal in a function
    first & 0x0F
}

fn flags_of(first: u8) -> bool {
    // refused: a binary literal in a function
    first == 0b0010
}

fn after_a_string(first: u8) -> (&'static str, u8) {
    // refused: a literal after a string that holds `(`, `{`, `'` and a backquote
    ("( { ' ` 0x80", first & 0x7F)
}

fn after_a_raw_string(first: u8) -> (&'static str, u8) {
    // refused: a literal after a raw string that holds a quote and a hex number
    (r#"a " ( { 0x80"#, first | 0x80)
}

fn tag_of(byte: u8) -> u8 {
    // refused: a decimal literal above 1 that `&` takes
    byte & 7
}

fn digit_of(digit: u8) -> u8 {
    // refused: a decimal literal above 1 that `|` takes
    digit | 128
}

fn turned(byte: u8) -> u8 {
    // refused: a decimal literal above 1 that `^` takes
    byte ^ 255
}

fn set(flags: &mut u8) {
    // refused: a compound form
    *flags |= 4;
}

fn cast(length: u64) -> u64 {
    // refused: a literal under parentheses and a cast
    length & (255 as u64)
}

fn arm(first: u8) -> &'static str {
    match first {
        // refused: a hex literal in a pattern
        0x80 => "final",
        _ => "not",
    }
}

fn inner() -> u8 {
    // refused: a const of a function is no module's
    const INNER: u8 = 0x80;

    INNER
}

// refused: a literal inside a closure that a const holds
const PICK: fn(u8) -> u8 = |byte| byte & 0x0F;

fn asserted(first: u8) {
    // refused: a hex literal in an assertion's expression
    assert!(first & 0x80 != 0, "final");
}

fn matched(first: u8) -> bool {
    // refused: a hex literal in a `matches!`'s expression
    matches!(first & 0x0F, 1 | 2)
}

fn said(first: u8) -> String {
    // refused: a hex literal in a format's argument, the hole of its template
    format!("{} {{0x80}}", first & 0x7F)
}

fn filled() -> Vec<u8> {
    // refused: a hex literal in a macro's tokens that parse as no expression
    vec![0x80; 4]
}

fn scanned(first: u8) -> Vec<u8> {
    // refused: a decimal literal beside a `&` in tokens that parse as no expression
    vec![first & 15; 2]
}

struct Head;

impl Head {
    fn opcode(first: u8) -> u8 {
        // refused: a hex literal in a method
        first & 0x0F
    }
}

// ── Left out ────────────────────────────────────────────────────────────────────────────────

/// RFC 6455 §5.2: the opcode, the low four bits of a frame's first byte, 0x0F.
const OPCODE_MASK: u8 = 0x0F;

/// A definition of more than one literal.
static BYTE_ORDER_MARK: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// A definition whose literals are an expression's.
const LONGEST_HEAD_BYTES: usize = 0x2 + 0x8 + 0x4;

/// A module's definitions.
mod codes {
    /// Its definition.
    pub(crate) const NORMAL_CLOSURE: u16 = 0x3E8;
}

/// An enum's discriminants.
enum Opcode {
    Text = 0x1,
    Binary = 0b10,
}

impl Head {
    /// An associated const.
    const FIN_BIT: u8 = 0x80;
}

trait Framed {
    /// An associated const a trait declares.
    const MASK_BIT: u8 = 0x80;
}

fn kept(first: u8, code: u16) -> (u8, u8, u8, bool, &'static str) {
    // a decimal literal no bitwise operator takes, a shift's, and one of 0 or 1
    let length = 126;
    let shifted = first << 4 >> 7;
    let low = first & 1 | 0;
    // a pattern's `|` is no operator
    let is_failure = matches!(code, 1002 | 1008);
    let said = match code {
        1000 | 1001 => "clean",
        _ => "not",
    };

    (length, shifted, low, is_failure, said)
}

fn strings() -> (&'static str, &'static str, &'static [u8], u8, char) {
    // strings, a raw one, a byte string, a byte and a character hold no literal
    ("0x80", r"0b0010 & 7", b"\x80", b'\x7F', '\u{80}')
}

fn referenced() -> u8 {
    // a reference is no operator, nor `&&`
    let taken = &2;

    if *taken > 1 && *taken < 3 { 1 } else { 0 }
}

fn chained(first: u8) -> bool {
    // `&&` and `||` in tokens that parse as no expression
    let all = vec![first > 2 && first < 9; 2];

    all.iter().any(|kept| *kept || first == 5)
}

#[cfg(test)]
mod tests {
    const PROBE: u8 = 0x80;

    fn probe(first: u8) -> u8 {
        first & 0x0F
    }
}

#[cfg(test)]
fn probe(first: u8) -> u8 {
    first ^ 0xFF
}
