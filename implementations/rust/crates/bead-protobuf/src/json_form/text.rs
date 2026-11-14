//! A body's JSON text as Bead's mapping reads it (spec/transcoding.md 5.2.1): section 17.5 of
//! spec.md but for its depth, which the message's descriptor counts, and the digits of each number,
//! which it keeps; and the tokens its writer writes (5.6, 17.7).

use super::{Refusal, TEXT_DEPTH, nested_past};

/// A JSON value as Bead's mapping reads it: each number with its digits, each object's members in
/// their order.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Node {
    Array(Vec<Self>),
    Bool(bool),
    Null,
    Number { text: String, value: f64 },
    Object(Vec<(String, Self)>),
    String(String),
}

// ── Reading ───────────────────────────────────────────────────────────────────

// a text's reading: its characters, and where it stands
struct Text<'a> {
    bytes: &'a [u8],
    at: usize,
}

fn not_json() -> Refusal {
    Refusal::new("not JSON")
}

impl Text<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn advance(&mut self, count: usize) {
        self.at = self.at.saturating_add(count);
    }

    fn skip(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.advance(1);
        }
    }

    fn take(&mut self, expected: u8) -> Result<(), Refusal> {
        if self.peek() != Some(expected) {
            return Err(not_json());
        }

        self.advance(1);
        Ok(())
    }

    // four hexadecimal digits of a `\u` escape
    fn hex4(&mut self) -> Result<u32, Refusal> {
        let mut value = 0_u32;

        for _ in 0..4 {
            let digit = self
                .peek()
                .and_then(|byte| char::from(byte).to_digit(16))
                .ok_or_else(not_json)?;

            value = value.saturating_mul(16).saturating_add(digit);
            self.advance(1);
        }

        Ok(value)
    }

    // a string, its quotes and escapes read, a surrogate alone refused
    fn string(&mut self) -> Result<String, Refusal> {
        self.take(b'"')?;

        let mut value = Vec::new();

        loop {
            let byte = self.peek().ok_or_else(not_json)?;

            self.advance(1);

            match byte {
                b'"' => break,
                b'\\' => {
                    let escape = self.peek().ok_or_else(not_json)?;

                    self.advance(1);

                    let character = match escape {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => self.escaped()?,
                        _ => return Err(not_json()),
                    };
                    let mut buffer = [0_u8; 4];

                    value.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
                }
                0x00..=0x1F => return Err(not_json()),
                _ => value.push(byte),
            }
        }

        String::from_utf8(value).map_err(|_unread| Refusal::new("not UTF-8"))
    }

    // the character of a `\u` escape, a surrogate pair's whole
    fn escaped(&mut self) -> Result<char, Refusal> {
        let first = self.hex4()?;

        if (0xD800..0xDC00).contains(&first) {
            if self.bytes.get(self.at..self.at.saturating_add(2)) != Some(b"\\u".as_slice()) {
                return Err(Refusal::new("a surrogate alone"));
            }

            self.advance(2);

            let second = self.hex4()?;

            if !(0xDC00..0xE000).contains(&second) {
                return Err(Refusal::new("a surrogate alone"));
            }

            let code = 0x10000_u32
                .saturating_add((first.saturating_sub(0xD800)) << 10)
                .saturating_add(second.saturating_sub(0xDC00));

            return char::from_u32(code).ok_or_else(|| Refusal::new("a surrogate alone"));
        }

        char::from_u32(first).ok_or_else(|| Refusal::new("a surrogate alone"))
    }

    // past a number of JSON's grammar, whatever its size
    fn number_grammar(&mut self) -> Result<(), Refusal> {
        if self.peek() == Some(b'-') {
            self.advance(1);
        }

        match self.peek() {
            Some(b'0') => self.advance(1),
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(not_json()),
        }

        if self.peek() == Some(b'.') {
            self.advance(1);

            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(not_json());
            }

            self.digits();
        }

        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.advance(1);

            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.advance(1);
            }

            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(not_json());
            }

            self.digits();
        }

        Ok(())
    }

    // a number's text, JSON's grammar, from where it stands
    fn number(&mut self) -> Result<Node, Refusal> {
        let start = self.at;

        self.number_grammar()?;

        let text = self
            .bytes
            .get(start..self.at)
            .and_then(|bytes| core::str::from_utf8(bytes).ok())
            .ok_or_else(not_json)?
            .to_owned();
        let value = text.parse::<f64>().map_err(|_unread| not_json())?;

        if !value.is_finite() {
            return Err(Refusal::new("a number past a double"));
        }

        Ok(Node::Number { text, value })
    }

    fn digits(&mut self) {
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.advance(1);
        }
    }

    fn literal(&mut self, word: &[u8], node: Node) -> Result<Node, Refusal> {
        if self.bytes.get(self.at..self.at.saturating_add(word.len())) != Some(word) {
            return Err(not_json());
        }

        self.advance(word.len());
        Ok(node)
    }

    fn value(&mut self, depth: u32) -> Result<Node, Refusal> {
        self.skip();

        match self.peek() {
            Some(open @ (b'[' | b'{')) => {
                if depth >= TEXT_DEPTH {
                    return Err(nested_past());
                }

                self.advance(1);
                self.skip();

                if open == b'[' {
                    self.array(depth)
                } else {
                    self.object(depth)
                }
            }
            Some(b'"') => self.string().map(Node::String),
            Some(b't') => self.literal(b"true", Node::Bool(true)),
            Some(b'f') => self.literal(b"false", Node::Bool(false)),
            Some(b'n') => self.literal(b"null", Node::Null),
            _ => self.number(),
        }
    }

    fn array(&mut self, depth: u32) -> Result<Node, Refusal> {
        let mut items = Vec::new();

        if self.peek() == Some(b']') {
            self.advance(1);

            return Ok(Node::Array(items));
        }

        loop {
            items.push(self.value(depth.saturating_add(1))?);
            self.skip();

            let next = self.peek();

            self.advance(1);

            match next {
                Some(b']') => return Ok(Node::Array(items)),
                Some(b',') => {}
                _ => return Err(not_json()),
            }
        }
    }

    fn object(&mut self, depth: u32) -> Result<Node, Refusal> {
        let mut members: Vec<(String, Node)> = Vec::new();

        if self.peek() == Some(b'}') {
            self.advance(1);

            return Ok(Node::Object(members));
        }

        loop {
            self.skip();

            if self.peek() != Some(b'"') {
                return Err(not_json());
            }

            let name = self.string()?;

            if members.iter().any(|(held, _)| *held == name) {
                return Err(Refusal::new("a member named twice"));
            }

            self.skip();
            self.take(b':')?;

            let value = self.value(depth.saturating_add(1))?;

            members.push((name, value));
            self.skip();

            let next = self.peek();

            self.advance(1);

            match next {
                Some(b'}') => return Ok(Node::Object(members)),
                Some(b',') => {}
                _ => return Err(not_json()),
            }
        }
    }
}

/// A body's bytes read as one JSON text (5.2.1): UTF-8, no byte order mark, one text, no member
/// named twice, no surrogate alone, no number past the largest double, nested no deeper than any
/// message nests.
pub(crate) fn read_text(bytes: &[u8]) -> Result<Node, Refusal> {
    if core::str::from_utf8(bytes).is_err() {
        return Err(Refusal::new("not UTF-8"));
    }

    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(Refusal::new("a byte order mark"));
    }

    let mut text = Text { bytes, at: 0 };
    let node = text.value(0)?;

    text.skip();

    if text.at != bytes.len() {
        return Err(not_json());
    }

    Ok(node)
}

// ── Grammars ──────────────────────────────────────────────────────────────────

/// Whether `text` is a JSON number, whole: `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`.
pub(crate) fn is_number_text(text: &str) -> bool {
    let mut reading = Text {
        bytes: text.as_bytes(),
        at: 0,
    };

    reading.number_grammar().is_ok() && reading.at == text.len()
}

/// Whether `text` is an integer's digits: `-?(0|[1-9][0-9]*)`.
pub(crate) fn is_integer_text(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);

    match digits.as_bytes() {
        [b'0'] => true,
        [b'1'..=b'9', rest @ ..] => rest.iter().all(u8::is_ascii_digit),
        _ => false,
    }
}

/// What a number's digits write as an integer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Integer {
    /// The integer, exactly.
    Of(i128),
    /// No integer: a fraction, or no number.
    Fraction,
    /// Past what any 64-bit type holds.
    Past,
}

// the largest power of ten past which no integer of 64 bits is, as a number's exponent
const LARGEST_EXPONENT: usize = 20;

/// The integer a JSON number's digits write, read exactly: `1e2` and `5.0` among them.
pub(crate) fn integer_of_digits(text: &str) -> Integer {
    let (is_negative, unsigned) = text
        .strip_prefix('-')
        .map_or((false, text), |rest| (true, rest));
    let (mantissa, exponent_text) = unsigned
        .split_once(['e', 'E'])
        .map_or((unsigned, None), |(mantissa, exponent)| {
            (mantissa, Some(exponent))
        });
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let is_digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());

    if !is_digits(whole) || (mantissa.contains('.') && !is_digits(fraction)) {
        return Integer::Fraction;
    }

    let exponent = match exponent_text {
        None => 0_i64,
        Some(exponent) => {
            let (sign, digits) = match exponent.as_bytes().first() {
                Some(b'-') => (-1_i64, exponent.get(1..).unwrap_or_default()),
                Some(b'+') => (1, exponent.get(1..).unwrap_or_default()),
                _ => (1, exponent),
            };

            if !is_digits(digits) {
                return Integer::Fraction;
            }

            // * clamped far past any 64-bit integer's digits, so its arithmetic never overflows
            let magnitude = digits.parse::<i64>().unwrap_or(i64::MAX).min(1 << 40);

            sign.saturating_mul(magnitude)
        }
    };
    let joined = format!("{whole}{fraction}");
    let significant = joined.trim_start_matches('0');

    if significant.is_empty() {
        return Integer::Of(0);
    }

    let digits = significant.trim_end_matches('0');
    let trailing = significant.len().saturating_sub(digits.len());
    let exponent = exponent
        .saturating_sub(i64::try_from(fraction.len()).unwrap_or(i64::MAX))
        .saturating_add(i64::try_from(trailing).unwrap_or(i64::MAX));
    let Ok(exponent) = u32::try_from(exponent) else {
        return Integer::Fraction;
    };

    if digits
        .len()
        .saturating_add(usize::try_from(exponent).unwrap_or(usize::MAX))
        > LARGEST_EXPONENT.saturating_add(1)
    {
        return Integer::Past;
    }

    let magnitude = digits
        .parse::<i128>()
        .ok()
        .and_then(|digits| digits.checked_mul(10_i128.checked_pow(exponent)?));

    magnitude.map_or(Integer::Past, |magnitude| {
        Integer::Of(if is_negative {
            magnitude.saturating_neg()
        } else {
            magnitude
        })
    })
}

// ── Writing ───────────────────────────────────────────────────────────────────

/// A string's JSON token, as 17.7 writes one: `"` and `\` escaped, each control character by its
/// short escape or `\u` and four lower-case digits, every other character as it is.
pub(crate) fn string_json(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// A double's JSON token as ECMAScript's `Number::toString` writes it, the shortest that reads back
/// (5.6.1): finite and not 0, which its caller writes apart.
pub(crate) fn double_text(value: f64) -> String {
    ryu_js::Buffer::new().format_finite(value).to_owned()
}

/// A float's JSON token, its shortest decimal that reads back to it, written as a double of those
/// digits is (5.6.1): finite and not 0, which its caller writes apart.
pub(crate) fn float_text(value: f32) -> String {
    ryu_js::Buffer::new().format_finite(value).to_owned()
}
