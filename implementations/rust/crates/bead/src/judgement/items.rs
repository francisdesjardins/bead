//! A field's value read as an Item of RFC 9651, Structured Field Values for HTTP: a bare item and
//! its parameters, parsed as §4.2 parses one.
//!
//! The field's lines are combined first, as its caller gives them. What a field of Bead's holds is
//! one constraint on that Item, judged by its reader; a parameter it does not know it ignores
//! (§2.3). The other sides' `parseItem` and `StructuredFields.ParseItem` are its twins.

#[cfg(test)]
mod tests;

// the longest an Integer is, its sign aside, and a Decimal before and after its point (§3.3.1,
// §3.3.2)
const INTEGER_DIGITS: usize = 15;
const DECIMAL_INTEGER_DIGITS: usize = 12;
const DECIMAL_FRACTION_DIGITS: usize = 3;

/// A bare item of RFC 9651 (§3.3), its type beside its value: `0` and `0.0` are not one item.
#[derive(Debug, Clone, PartialEq)]
pub enum BareItem {
    /// A Boolean (§3.3.6).
    Boolean(bool),
    /// A Byte Sequence (§3.3.5): the octets its base64 spells.
    ByteSequence(Vec<u8>),
    /// A Date (§3.3.7): seconds since the Unix epoch, an Integer.
    Date(i64),
    /// A Decimal (§3.3.2): three fractional digits at most.
    Decimal(f64),
    /// A Display String (§3.3.8): Unicode text, told apart from a String.
    DisplayString(String),
    /// An Integer (§3.3.1): fifteen digits at most, `-0` read as 0.
    Integer(i64),
    /// A String (§3.3.3): SP and visible ASCII.
    String(String),
    /// A Token (§3.3.4), told apart from a String.
    Token(String),
}

/// A parameter of an Item (§3.1.2): its key, and its bare item.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct Parameter {
    /// Its key: a lower-case letter or `*`, then lower-case letters, digits and `_-.*`.
    pub key: String,
    /// Its value: true for a key given alone.
    pub value: BareItem,
}

/// An Item of RFC 9651 (§3.3): its bare item, and its parameters in their order, a key given twice
/// holding its last value at its first place (§4.2.3.2).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct Item {
    /// Its bare item.
    pub bare_item: BareItem,
    /// Its parameters, in the order they came.
    pub parameters: Vec<Parameter>,
}

// what is left of a field value to parse, from `index` on: ASCII alone, so a byte is a character
struct Input<'a> {
    bytes: &'a [u8],
    index: usize,
}

impl Input<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.index).copied()
    }

    fn at(&self, ahead: usize) -> Option<u8> {
        self.bytes.get(self.index.saturating_add(ahead)).copied()
    }

    fn advance(&mut self, by: usize) {
        self.index = self.index.saturating_add(by);
    }

    fn discard_spaces(&mut self) {
        while self.peek() == Some(b' ') {
            self.advance(1);
        }
    }

    fn text(&self, (start, end): (usize, usize)) -> String {
        self.bytes
            .get(start..end)
            .map(|bytes| bytes.iter().copied().map(char::from).collect())
            .unwrap_or_default()
    }
}

// what a token goes on with: RFC 9110's tchar, a colon and a slash (§4.2.6)
fn is_token_character(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~:/".contains(&byte)
}

// what a key goes on with (§4.2.3.3)
fn is_key_character(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-.*".contains(&byte)
}

// what a String holds: SP and visible ASCII, no control character, DEL nor past ASCII (§4.2.5)
const fn is_stringable(byte: u8) -> bool {
    matches!(byte, b' '..=b'~')
}

fn integer_or_decimal_of(input: &mut Input<'_>) -> Option<BareItem> {
    let is_negative = input.peek() == Some(b'-');

    if is_negative {
        input.advance(1);
    }

    if !input.peek().is_some_and(|byte| byte.is_ascii_digit()) {
        return None;
    }

    let start = input.index;
    let mut point: Option<usize> = None;

    while let Some(byte) = input.peek() {
        if byte.is_ascii_digit() {
        } else if point.is_none() && byte == b'.' {
            if input.index.saturating_sub(start) > DECIMAL_INTEGER_DIGITS {
                return None;
            }

            point = Some(input.index);
        } else {
            break;
        }

        input.advance(1);

        let read = input.index.saturating_sub(start);

        if read > INTEGER_DIGITS.saturating_add(usize::from(point.is_some())) {
            return None;
        }
    }

    let digits = input.text((start, input.index));

    let Some(point) = point else {
        // * `-0` is 0 (§4.2.4): a sign kept on a zero would tell two counts apart that are one
        let value: i64 = digits.parse().ok()?;

        return Some(BareItem::Integer(if is_negative {
            value.checked_neg()?
        } else {
            value
        }));
    };
    let fraction = input.index.saturating_sub(point).saturating_sub(1);

    if fraction == 0 || fraction > DECIMAL_FRACTION_DIGITS {
        return None;
    }

    let value: f64 = digits.parse().ok()?;
    let signed = if is_negative { -value } else { value };

    Some(BareItem::Decimal(if signed == 0.0 { 0.0 } else { signed }))
}

fn string_of(input: &mut Input<'_>) -> Option<BareItem> {
    let mut value = String::new();

    input.advance(1);

    while let Some(byte) = input.peek() {
        input.advance(1);

        match byte {
            b'"' => return Some(BareItem::String(value)),
            b'\\' => {
                let escaped = input
                    .peek()
                    .filter(|escaped| matches!(escaped, b'"' | b'\\'))?;

                input.advance(1);
                value.push(char::from(escaped));
            }
            _ if is_stringable(byte) => value.push(char::from(byte)),
            _ => return None,
        }
    }

    None
}

fn token_of(input: &mut Input<'_>) -> BareItem {
    let start = input.index;

    input.advance(1);

    while input.peek().is_some_and(is_token_character) {
        input.advance(1);
    }

    BareItem::Token(input.text((start, input.index)))
}

// the value of a base64 character (RFC 4648 §4)
fn sextet_of(byte: u8) -> Option<u32> {
    let value = match byte {
        b'A'..=b'Z' => byte.checked_sub(b'A')?,
        b'a'..=b'z' => byte.checked_sub(b'a')?.checked_add(26)?,
        b'0'..=b'9' => byte.checked_sub(b'0')?.checked_add(52)?,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    };

    Some(u32::from(value))
}

// base64, its padding optional and its pad bits ignored, as §4.2.7 advises: what the HTML
// Standard's forgiving decoder, `atob`, gives
fn forgiving_base64_of(content: &[u8]) -> Option<Vec<u8>> {
    let unpadded = if content.len().is_multiple_of(4) {
        content
            .strip_suffix(b"==")
            .or_else(|| content.strip_suffix(b"="))
            .unwrap_or(content)
    } else {
        content
    };

    if unpadded.len() % 4 == 1 {
        return None;
    }

    let mut decoded = Vec::with_capacity(unpadded.len().saturating_mul(3) / 4);
    let mut buffer = 0_u32;
    let mut bits = 0_u32;

    for byte in unpadded {
        buffer = buffer.wrapping_shl(6) | sextet_of(*byte)?;
        bits = bits.saturating_add(6);

        if bits >= 8 {
            bits = bits.saturating_sub(8);
            decoded.push(u8::try_from(buffer.wrapping_shr(bits) & 0xFF).ok()?);
            buffer &= 1_u32.wrapping_shl(bits).wrapping_sub(1);
        }
    }

    Some(decoded)
}

fn byte_sequence_of(input: &mut Input<'_>) -> Option<BareItem> {
    let start = input.index.saturating_add(1);
    let length = input
        .bytes
        .get(start..)?
        .iter()
        .position(|byte| *byte == b':')?;
    let end = start.saturating_add(length);
    let content = input.bytes.get(start..end)?;

    input.index = end.saturating_add(1);

    if !content
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return None;
    }

    forgiving_base64_of(content).map(BareItem::ByteSequence)
}

fn boolean_of(input: &mut Input<'_>) -> Option<BareItem> {
    let value = match input.at(1)? {
        b'0' => false,
        b'1' => true,
        _ => return None,
    };

    input.advance(2);

    Some(BareItem::Boolean(value))
}

fn date_of(input: &mut Input<'_>) -> Option<BareItem> {
    input.advance(1);

    match integer_or_decimal_of(input)? {
        BareItem::Integer(seconds) => Some(BareItem::Date(seconds)),
        BareItem::Boolean(_)
        | BareItem::ByteSequence(_)
        | BareItem::Date(_)
        | BareItem::Decimal(_)
        | BareItem::DisplayString(_)
        | BareItem::String(_)
        | BareItem::Token(_) => None,
    }
}

// a hexadecimal digit in lower case, as a Display String writes its octets (§4.2.10)
fn lowercase_hex_of(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => byte.checked_sub(b'0'),
        b'a'..=b'f' => byte.checked_sub(b'a')?.checked_add(10),
        _ => None,
    }
}

// percent-encoded UTF-8 between quotes, its hex digits in lower case (§4.2.10)
fn display_string_of(input: &mut Input<'_>) -> Option<BareItem> {
    if input.at(1) != Some(b'"') {
        return None;
    }

    let mut bytes = Vec::new();

    input.advance(2);

    while let Some(byte) = input.peek() {
        input.advance(1);

        if !is_stringable(byte) {
            return None;
        }

        match byte {
            b'"' => return String::from_utf8(bytes).ok().map(BareItem::DisplayString),
            b'%' => {
                let high = lowercase_hex_of(input.peek()?)?;
                let low = lowercase_hex_of(input.at(1)?)?;

                input.advance(2);
                bytes.push(high.wrapping_shl(4) | low);
            }
            _ => bytes.push(byte),
        }
    }

    None
}

// a bare item, by the character it opens on (§4.2.3.1)
fn bare_item_of(input: &mut Input<'_>) -> Option<BareItem> {
    match input.peek()? {
        b'-' | b'0'..=b'9' => integer_or_decimal_of(input),
        b'"' => string_of(input),
        b'*' | b'A'..=b'Z' | b'a'..=b'z' => Some(token_of(input)),
        b':' => byte_sequence_of(input),
        b'?' => boolean_of(input),
        b'@' => date_of(input),
        b'%' => display_string_of(input),
        _ => None,
    }
}

// a key: a lower-case letter or `*`, then lower-case letters, digits and `_-.*` (§4.2.3.3)
fn key_of(input: &mut Input<'_>) -> Option<String> {
    let start = input.index;

    if !input
        .peek()
        .is_some_and(|first| first == b'*' || first.is_ascii_lowercase())
    {
        return None;
    }

    input.advance(1);

    while input.peek().is_some_and(is_key_character) {
        input.advance(1);
    }

    Some(input.text((start, input.index)))
}

// each parameter after a `;`, a key without a value true, a key given twice its last value at its
// first place (§4.2.3.2)
fn parameters_of(input: &mut Input<'_>) -> Option<Vec<Parameter>> {
    let mut parameters: Vec<Parameter> = Vec::new();

    while input.peek() == Some(b';') {
        input.advance(1);
        input.discard_spaces();

        let key = key_of(input)?;
        let value = if input.peek() == Some(b'=') {
            input.advance(1);
            bare_item_of(input)?
        } else {
            BareItem::Boolean(true)
        };

        match parameters.iter_mut().find(|parameter| parameter.key == key) {
            Some(parameter) => parameter.value = value,
            None => parameters.push(Parameter { key, value }),
        }
    }

    Some(parameters)
}

/// A field value parsed as an Item of RFC 9651 (§4.2, §4.2.3), its field lines combined first by
/// `, ` as RFC 9110 §5.3 combines them.
///
/// Its bare item and its parameters; none when it does not parse: past ASCII, empty, of anything
/// left after the item, two lines of it among them. Spaces around it are discarded, a tab is not.
#[must_use]
pub fn parse_item(value: &str) -> Option<Item> {
    if !value.is_ascii() {
        return None;
    }

    let mut input = Input {
        bytes: value.as_bytes(),
        index: 0,
    };

    input.discard_spaces();

    let bare_item = bare_item_of(&mut input)?;
    let parameters = parameters_of(&mut input)?;

    input.discard_spaces();

    (input.index == value.len()).then_some(Item {
        bare_item,
        parameters,
    })
}
