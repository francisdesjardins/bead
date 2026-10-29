//! A `json` payload's reader, its writer and its road from a type (spec 17.5 to 17.7, decision
//! 0016).
//!
//! Bead's own, since `serde_json` reads a surrogate alone as an error, keeps the last of a name
//! given twice, and writes a double that is not finite as `null`.
//!
//! The reader holds a text to RFC 8259 and 17.5's checks, in the order the TypeScript reader
//! checks them; the writer writes RFC 8785's canonical form, each number as ECMAScript's
//! `Number::toString` spells it, each object's names sorted by their UTF-16 code units.

use core::fmt;
use std::error::Error;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Number, Value};

#[cfg(test)]
mod tests;
mod to_value;

pub use to_value::to_value;

/// How deep a `json` value nests at most, the outermost at depth 1 (spec 17.5, item 7).
pub const DEPTH: usize = 64;

/// Why a `json` payload does not read, or a value does not write, as `spec/codecs.json` derives
/// its reasons.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum JsonRefusal {
    /// A payload whose bytes are not UTF-8.
    NotUtf8,
    /// A payload that starts with a byte order mark.
    ByteOrderMark,
    /// A payload that is not one JSON text.
    NotJson,
    /// An object naming a member twice.
    NameTwice,
    /// A string or a name holding a surrogate alone.
    SurrogateAlone,
    /// A number past the largest double.
    NumberPastADouble,
    /// A value nested deeper than 64.
    NestedPast64,
    /// A double that is not finite, given to a writer.
    NotAFiniteNumber,
    /// What JSON has no value for, given to a writer.
    NoJsonValue(String),
    /// A value that does not read as the type asked of it.
    NotItsType(String),
}

impl fmt::Display for JsonRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotUtf8 => formatter.write_str("not UTF-8"),
            Self::ByteOrderMark => formatter.write_str("a byte order mark"),
            Self::NotJson => formatter.write_str("not JSON"),
            Self::NameTwice => formatter.write_str("a name twice"),
            Self::SurrogateAlone => formatter.write_str("a surrogate alone"),
            Self::NumberPastADouble => formatter.write_str("a number past a double"),
            Self::NestedPast64 => formatter.write_str("nested past 64"),
            Self::NotAFiniteNumber => formatter.write_str("not a finite number"),
            Self::NoJsonValue(what) => write!(formatter, "no JSON value: {what}"),
            Self::NotItsType(why) => write!(formatter, "not its type: {why}"),
        }
    }
}

impl Error for JsonRefusal {}

/// What a reader does with a string or a name holding a surrogate alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum LoneSurrogates {
    /// Refuses it: a `json` payload (spec 17.5).
    #[default]
    Refuse,
    /// Reads a string so as `null`, a value that names nothing: a token's claims (spec 13.8). A
    /// name so is refused either way.
    AsNull,
}

// the bytes of a scan, by name
const QUOTE: u8 = b'"';
const BACKSLASH: u8 = b'\\';

// where the string opening at `index` closes: the index of its closing quote, the length for none
fn end_of_string(text: &[u8], index: usize) -> usize {
    let mut at = index.saturating_add(1);

    while let Some(&byte) = text.get(at) {
        match byte {
            QUOTE => return at,
            BACKSLASH => at = at.saturating_add(2),
            _ => at = at.saturating_add(1),
        }
    }

    text.len()
}

// whether `text` opens an array or an object deeper than 64, its strings skipped: a count over the
// text, whether or not it is JSON, before it is parsed, so a peer never chooses how deep it goes
fn is_too_deep(text: &[u8]) -> bool {
    let mut depth = 0_usize;
    let mut index = 0_usize;

    while let Some(&byte) = text.get(index) {
        match byte {
            QUOTE => index = end_of_string(text, index),
            b'[' | b'{' => {
                depth = depth.saturating_add(1);

                if depth > DEPTH {
                    return true;
                }
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }

        index = index.saturating_add(1);
    }

    false
}

// a refusal met as the parser reads: one of the grammar's, or of the value's
enum Met {
    Grammar,
    Surrogate,
    PastADouble,
    NameTwice,
}

struct Parser<'text> {
    text: &'text [u8],
    at: usize,
    surrogates: LoneSurrogates,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.get(self.at).copied()
    }

    fn skip_white(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.peek() {
            self.at = self.at.saturating_add(1);
        }
    }

    fn expect(&mut self, literal: &[u8]) -> Result<(), Met> {
        let end = self.at.saturating_add(literal.len());

        if self.text.get(self.at..end) == Some(literal) {
            self.at = end;
            Ok(())
        } else {
            Err(Met::Grammar)
        }
    }

    fn value(&mut self) -> Result<Value, Met> {
        self.skip_white();

        match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(QUOTE) => self.string().map(|(text, has_lone)| {
                if has_lone {
                    Value::Null
                } else {
                    Value::String(text)
                }
            }),
            Some(b't') => self.expect(b"true").map(|()| Value::Bool(true)),
            Some(b'f') => self.expect(b"false").map(|()| Value::Bool(false)),
            Some(b'n') => self.expect(b"null").map(|()| Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) | None => Err(Met::Grammar),
        }
    }

    fn object(&mut self) -> Result<Value, Met> {
        let mut members = Map::new();
        let mut is_twice = false;

        self.at = self.at.saturating_add(1);
        self.skip_white();

        if self.peek() == Some(b'}') {
            self.at = self.at.saturating_add(1);
            return Ok(Value::Object(members));
        }

        loop {
            self.skip_white();

            if self.peek() != Some(QUOTE) {
                return Err(Met::Grammar);
            }

            let (name, has_lone) = self.string()?;

            // ! a name holding a surrogate alone is refused whatever a value so is read as
            if has_lone {
                return Err(Met::Surrogate);
            }

            self.skip_white();
            self.expect(b":")?;

            let value = self.value()?;

            is_twice = members.insert(name, value).is_some() || is_twice;
            self.skip_white();

            match self.peek() {
                Some(b',') => self.at = self.at.saturating_add(1),
                Some(b'}') => {
                    self.at = self.at.saturating_add(1);
                    break;
                }
                Some(_) | None => return Err(Met::Grammar),
            }
        }

        if is_twice {
            return Err(Met::NameTwice);
        }

        Ok(Value::Object(members))
    }

    fn array(&mut self) -> Result<Value, Met> {
        let mut items = Vec::new();

        self.at = self.at.saturating_add(1);
        self.skip_white();

        if self.peek() == Some(b']') {
            self.at = self.at.saturating_add(1);
            return Ok(Value::Array(items));
        }

        loop {
            items.push(self.value()?);
            self.skip_white();

            match self.peek() {
                Some(b',') => self.at = self.at.saturating_add(1),
                Some(b']') => {
                    self.at = self.at.saturating_add(1);
                    break;
                }
                Some(_) | None => return Err(Met::Grammar),
            }
        }

        Ok(Value::Array(items))
    }

    fn hex4(&mut self) -> Result<u16, Met> {
        let end = self.at.saturating_add(4);
        let digits = self.text.get(self.at..end).ok_or(Met::Grammar)?;
        let digits = core::str::from_utf8(digits).map_err(|_error| Met::Grammar)?;

        if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(Met::Grammar);
        }

        self.at = end;

        u16::from_str_radix(digits, 16).map_err(|_error| Met::Grammar)
    }

    // a string's text, each surrogate alone U+FFFD, and whether it held one: refused, unless its
    // reader reads it as null
    fn string(&mut self) -> Result<(String, bool), Met> {
        let mut units: Vec<u16> = Vec::new();
        let mut text = String::new();
        let mut has_lone = false;

        self.at = self.at.saturating_add(1);

        loop {
            let start = self.at;

            while let Some(byte) = self.peek() {
                if byte == QUOTE || byte == BACKSLASH || byte < 0x20 {
                    break;
                }

                self.at = self.at.saturating_add(1);
            }

            let run = self.text.get(start..self.at).ok_or(Met::Grammar)?;

            if !run.is_empty() {
                flush(&mut units, (&mut text, &mut has_lone));
                text.push_str(core::str::from_utf8(run).map_err(|_error| Met::Grammar)?);
            }

            match self.peek() {
                Some(QUOTE) => {
                    self.at = self.at.saturating_add(1);
                    flush(&mut units, (&mut text, &mut has_lone));
                    break;
                }
                Some(BACKSLASH) => {
                    self.at = self.at.saturating_add(1);

                    let escaped = self.peek().ok_or(Met::Grammar)?;

                    self.at = self.at.saturating_add(1);

                    let short = match escaped {
                        QUOTE => '"',
                        BACKSLASH => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            units.push(self.hex4()?);
                            continue;
                        }
                        _ => return Err(Met::Grammar),
                    };

                    flush(&mut units, (&mut text, &mut has_lone));
                    text.push(short);
                }
                Some(_) | None => return Err(Met::Grammar),
            }
        }

        if has_lone && self.surrogates == LoneSurrogates::Refuse {
            return Err(Met::Surrogate);
        }

        Ok((text, has_lone))
    }

    fn number(&mut self) -> Result<Value, Met> {
        let start = self.at;
        let mut is_whole = true;

        if self.peek() == Some(b'-') {
            self.at = self.at.saturating_add(1);
        }

        match self.peek() {
            Some(b'0') => self.at = self.at.saturating_add(1),
            Some(b'1'..=b'9') => self.digits(),
            Some(_) | None => return Err(Met::Grammar),
        }

        if self.peek() == Some(b'.') {
            self.at = self.at.saturating_add(1);
            is_whole = false;

            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(Met::Grammar);
            }

            self.digits();
        }

        if let Some(b'e' | b'E') = self.peek() {
            self.at = self.at.saturating_add(1);
            is_whole = false;

            if let Some(b'+' | b'-') = self.peek() {
                self.at = self.at.saturating_add(1);
            }

            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(Met::Grammar);
            }

            self.digits();
        }

        let written = self.text.get(start..self.at).ok_or(Met::Grammar)?;
        let written = core::str::from_utf8(written).map_err(|_error| Met::Grammar)?;

        number_of(written, is_whole).map(Value::Number)
    }

    fn digits(&mut self) {
        while let Some(b'0'..=b'9') = self.peek() {
            self.at = self.at.saturating_add(1);
        }
    }
}

// the UTF-16 code units of escapes gathered, each pair a character, each surrogate alone U+FFFD,
// written to `text`, and whether one was alone
fn flush(units: &mut Vec<u16>, (text, has_lone): (&mut String, &mut bool)) {
    for decoded in char::decode_utf16(units.drain(..)) {
        if let Ok(character) = decoded {
            text.push(character);
        } else {
            text.push(char::REPLACEMENT_CHARACTER);
            *has_lone = true;
        }
    }
}

// the value of a number written so: a whole number within 64 bits an integer, -0 the double -0.0,
// any other the double nearest it, as `JSON.parse` reads it
fn number_of(written: &str, is_whole: bool) -> Result<Number, Met> {
    let is_negative_zero = written.starts_with('-')
        && written
            .bytes()
            .all(|byte| matches!(byte, b'-' | b'0' | b'.' | b'e' | b'E' | b'+'));

    if is_whole && !is_negative_zero {
        if let Ok(integer) = written.parse::<u64>() {
            return Ok(Number::from(integer));
        }

        if let Ok(integer) = written.parse::<i64>() {
            return Ok(Number::from(integer));
        }
    }

    let double: f64 = written.parse().map_err(|_error| Met::Grammar)?;

    if !double.is_finite() {
        return Err(Met::PastADouble);
    }

    if !is_negative_zero && let Some(integer) = integer_of(double) {
        return Ok(Number::from(integer));
    }

    Number::from_f64(double).ok_or(Met::PastADouble)
}

/// `double` as the integer it is, when it is a whole number every side holds exactly: within
/// 2⁵³ − 1 of 0.
pub(crate) fn integer_of(double: f64) -> Option<i64> {
    if !double.is_finite() || double.fract() != 0.0 || double.abs() > 9_007_199_254_740_991.0 {
        return None;
    }

    let mut buffer = ryu_js::Buffer::new();

    buffer.format_finite(double).parse::<i64>().ok()
}

/// How a text is read beyond its bytes.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct ReadJsonOptions {
    /// What a string or a name holding a surrogate alone is read as: refused when none.
    pub lone_surrogates: Option<LoneSurrogates>,
}

/// The value of a `json` payload, read as spec 17.5 and 17.6 read one.
///
/// Its bytes in UTF-8, read strictly; no byte order mark; nested 64 deep at most, counted before
/// it is parsed; one JSON text (RFC 8259); no name twice, no surrogate alone, no number past a
/// double. A whole number within 64 bits is an integer, any other number the double nearest it.
///
/// # Errors
///
/// The [`JsonRefusal`] of the first check it fails.
pub fn read(bytes: &[u8]) -> Result<Value, JsonRefusal> {
    read_with(bytes, &ReadJsonOptions::default())
}

/// The value of a JSON text, as [`read`] reads one, a surrogate alone read as `options` says.
///
/// # Errors
///
/// The [`JsonRefusal`] of the first check it fails.
pub fn read_with(bytes: &[u8], options: &ReadJsonOptions) -> Result<Value, JsonRefusal> {
    let text = core::str::from_utf8(bytes).map_err(|_error| JsonRefusal::NotUtf8)?;

    if text.starts_with('\u{feff}') {
        return Err(JsonRefusal::ByteOrderMark);
    }

    if is_too_deep(bytes) {
        return Err(JsonRefusal::NestedPast64);
    }

    let mut parser = Parser {
        text: bytes,
        at: 0,
        surrogates: options.lone_surrogates.unwrap_or_default(),
    };
    let value = parser.value().and_then(|value| {
        parser.skip_white();

        if parser.at == bytes.len() {
            Ok(value)
        } else {
            Err(Met::Grammar)
        }
    });

    value.map_err(|met| match met {
        Met::Grammar => JsonRefusal::NotJson,
        Met::Surrogate => JsonRefusal::SurrogateAlone,
        Met::PastADouble => JsonRefusal::NumberPastADouble,
        Met::NameTwice => JsonRefusal::NameTwice,
    })
}

// writes `text` as a JSON string, as RFC 8785 §3.2.2.2 escapes one
fn write_string(text: &str, out: &mut String) {
    out.push('"');

    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if u32::from(control) < 0x20 => {
                use core::fmt::Write as _;

                write!(out, "\\u{:04x}", u32::from(control)).ok();
            }
            other => out.push(other),
        }
    }

    out.push('"');
}

// writes `number` as ECMAScript's Number::toString spells the double it stands for (RFC 8785
// §3.2.2.3), -0 as 0
fn write_number(number: &Number, out: &mut String) {
    let double = number.as_f64().unwrap_or(0.0);

    if double == 0.0 {
        out.push('0');
    } else {
        let mut buffer = ryu_js::Buffer::new();

        out.push_str(buffer.format_finite(double));
    }
}

// whether `one` comes before `other` by their UTF-16 code units (RFC 8785 §3.2.3)
fn by_utf16(one: &str, other: &str) -> core::cmp::Ordering {
    one.encode_utf16().cmp(other.encode_utf16())
}

fn write_value(value: &Value, (depth, out): (usize, &mut String)) -> Result<(), JsonRefusal> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(number, out),
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            if depth == DEPTH {
                return Err(JsonRefusal::NestedPast64);
            }

            out.push('[');

            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }

                write_value(item, (depth.saturating_add(1), out))?;
            }

            out.push(']');
        }
        Value::Object(members) => {
            if depth == DEPTH {
                return Err(JsonRefusal::NestedPast64);
            }

            let mut names: Vec<&String> = members.keys().collect();

            names.sort_by(|one, other| by_utf16(one, other));
            out.push('{');

            for (index, name) in names.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }

                write_string(name, out);
                out.push(':');

                if let Some(item) = members.get(name) {
                    write_value(item, (depth.saturating_add(1), out))?;
                }
            }

            out.push('}');
        }
    }

    Ok(())
}

/// The bytes of `value`'s canonical form, as spec 17.7 writes it: RFC 8785's.
///
/// Each object's names sorted by their UTF-16 code units, each number as ECMAScript spells the
/// double it stands for, -0 as 0.
///
/// # Errors
///
/// [`JsonRefusal::NestedPast64`] for a value nested deeper than 64.
pub fn write(value: &Value) -> Result<Vec<u8>, JsonRefusal> {
    let mut out = String::new();

    write_value(value, (0, &mut out))?;

    Ok(out.into_bytes())
}

/// `value` read as `T`, through `serde`: the road back from a `json` payload's value to a type.
///
/// # Errors
///
/// [`JsonRefusal::NotItsType`] for a value that does not read as `T`.
pub fn from_value<T: DeserializeOwned>(value: Value) -> Result<T, JsonRefusal> {
    serde_json::from_value(value).map_err(|error| JsonRefusal::NotItsType(error.to_string()))
}

/// The bytes of `value`'s canonical form, through [`to_value`] then [`write()`].
///
/// # Errors
///
/// What [`to_value`] or [`write()`] refuses.
pub fn to_bytes<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>, JsonRefusal> {
    write(&to_value(value)?)
}
