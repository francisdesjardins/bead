//! `http.proto`'s path templates (spec/transcoding.md 3): parsed by its grammar, a request's path
//! matched raw, its verb split at the last unencoded `:`, the routes ordered by the peers'
//! precedence, and each variable's value decoded.

use core::cmp::Ordering;

use crate::errors::ProgrammerError;

#[cfg(test)]
mod tests;

/// A segment of a template: a literal, `*`, one segment, or `**`, zero or more.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    /// A literal, matched by its segment's text exactly.
    Literal(String),
    /// `*`, one segment.
    Star,
    /// `**`, the rest of the path, none among it.
    Stars,
}

/// A variable of a template: its field path, and the segments it takes, `start` to `end`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variable {
    /// Its field path, of proto names.
    pub field_path: String,
    /// The first segment it takes.
    pub start: usize,
    /// The segment after its last.
    pub end: usize,
    /// Whether it takes more than one segment, or `**`: its value keeps each `%2F` (3.8).
    pub is_multi_segment: bool,
}

/// A template of `http.proto`'s grammar, parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
    /// Its text, as its route gives it.
    pub text: String,
    /// Its segments.
    pub segments: Vec<Segment>,
    /// Its variables, in their order.
    pub variables: Vec<Variable>,
    /// Its verb, after a `:`, where it has one.
    pub verb: Option<String>,
}

/// A request's path as a route matches it: its segments raw, its verb split off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawPath {
    /// Its segments, raw, by `/`.
    pub segments: Vec<String>,
    /// What follows the last `:` its last segment holds unencoded.
    pub verb: Option<String>,
}

/// A variable's value, decoded, by its field path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariableValue {
    /// The field path its variable names, of proto names.
    pub field_path: String,
    /// Its value, decoded.
    pub value: String,
}

/// Why a variable's value does not decode, and the field path it names, which a gateway answers
/// 400 `PAYLOAD_UNDECODABLE` at that parameter (7.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariableRefusal {
    /// The field path its variable names.
    pub field_path: String,
    /// Why it does not decode.
    pub reason: &'static str,
}

// a segment's rank under 3.5's precedence: a literal, then `*`, then `**`; a template that ends
// where the path ends before a `**` that takes none
const END: i8 = -1;
const LITERAL_RANK: i8 = 0;
const STAR_RANK: i8 = 1;
const STARS_RANK: i8 = 2;

const NO_PERCENT: &str = "a % that two hexadecimal digits do not follow";
const NO_UTF8: &str = "a value whose bytes are not UTF-8";

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────

// the length of a literal of a template at the start of `rest` (http.proto's grammar)
fn literal_length(rest: &[u8]) -> usize {
    rest.iter()
        .take_while(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-')
        })
        .count()
}

// the length of an identifier at the start of `rest`
fn identifier_length(rest: &[u8]) -> usize {
    match rest.first() {
        Some(first) if first.is_ascii_alphabetic() || *first == b'_' => rest
            .iter()
            .take_while(|byte| byte.is_ascii_alphanumeric() || **byte == b'_')
            .count(),
        _ => 0,
    }
}

// the length of a field path at the start of `rest`: identifiers between dots
fn field_path_length(rest: &[u8]) -> usize {
    let mut length = identifier_length(rest);

    if length == 0 {
        return 0;
    }

    loop {
        let after = rest.get(length..).unwrap_or_default();

        if after.first() != Some(&b'.') {
            return length;
        }

        let next = identifier_length(after.get(1..).unwrap_or_default());

        if next == 0 {
            return length;
        }

        length = length.saturating_add(1).saturating_add(next);
    }
}

// a template's text as it is parsed: where it is, whether inside a variable, and what it read
struct Parsing<'a> {
    text: &'a str,
    at: usize,
    inside: bool,
    segments: Vec<Segment>,
    // each variable's field path, its first segment and the one after its last
    variables: Vec<Variable>,
}

impl Parsing<'_> {
    fn rest(&self) -> &[u8] {
        self.text.as_bytes().get(self.at..).unwrap_or_default()
    }

    fn advance(&mut self, by: usize) {
        self.at = self.at.saturating_add(by);
    }

    fn is_at(&self, byte: u8) -> bool {
        self.rest().first() == Some(&byte)
    }

    // the segments from where it is, inside a variable or not
    fn segments(&mut self) -> Result<(), &'static str> {
        loop {
            if self.rest().starts_with(b"**") {
                self.segments.push(Segment::Stars);
                self.advance(2);
            } else if self.is_at(b'*') {
                self.segments.push(Segment::Star);
                self.advance(1);
            } else if self.is_at(b'{') {
                self.variable()?;
            } else {
                let length = literal_length(self.rest());

                if length == 0 {
                    return Err("a literal that is no segment");
                }

                let literal = self
                    .text
                    .get(self.at..self.at.saturating_add(length))
                    .unwrap_or_default();

                self.segments.push(Segment::Literal(literal.to_owned()));
                self.advance(length);
            }

            if !self.is_at(b'/') {
                return Ok(());
            }

            self.advance(1);
        }
    }

    // a variable, from its `{`
    fn variable(&mut self) -> Result<(), &'static str> {
        if self.inside {
            return Err("a variable within a variable");
        }

        let length = field_path_length(self.rest().get(1..).unwrap_or_default());

        if length == 0 {
            return Err("a variable that names no field path");
        }

        let from = self.at.saturating_add(1);
        let field_path = self
            .text
            .get(from..from.saturating_add(length))
            .unwrap_or_default()
            .to_owned();
        let start = self.segments.len();

        self.advance(length.saturating_add(1));

        if self.is_at(b'=') {
            self.advance(1);
            self.inside = true;
            self.segments()?;
            self.inside = false;
        } else {
            self.segments.push(Segment::Star);
        }

        if !self.is_at(b'}') {
            return Err("a variable that does not close");
        }

        self.advance(1);

        let end = self.segments.len();
        let taken = self.segments.get(start..end).unwrap_or_default();

        self.variables.push(Variable {
            field_path,
            start,
            end,
            is_multi_segment: end.saturating_sub(start) > 1 || taken.contains(&Segment::Stars),
        });

        Ok(())
    }
}

/// `text` parsed as `http.proto`'s grammar writes a template (`:221-230`).
///
/// `/` first, then segments, each a literal, `*`, `**` or a variable, `**` last but the verb, and a
/// verb of one literal after a `:` (transcoding 3.9).
///
/// # Errors
///
/// Why it is no template: its words.
pub fn parse_template(text: &str) -> Result<Template, &'static str> {
    if !text.starts_with('/') {
        return Err("a template that does not begin with /");
    }

    let mut parsing = Parsing {
        text,
        at: 1,
        inside: false,
        segments: Vec::new(),
        variables: Vec::new(),
    };

    parsing.segments()?;

    let mut verb = None;

    if parsing.is_at(b':') {
        let from = parsing.at.saturating_add(1);
        let length = literal_length(text.as_bytes().get(from..).unwrap_or_default());

        if length == 0 || from.saturating_add(length) != text.len() {
            return Err("a verb that is no literal");
        }

        verb = text.get(from..).map(str::to_owned);
        parsing.at = text.len();
    }

    if parsing.at != text.len() {
        return Err("a literal that is no segment");
    }

    let before_last = parsing
        .segments
        .split_last()
        .map_or(&[][..], |(_, rest)| rest);

    if before_last.contains(&Segment::Stars) {
        return Err("a ** that is not its last segment");
    }

    Ok(Template {
        text: text.to_owned(),
        segments: parsing.segments,
        variables: parsing.variables,
        verb,
    })
}

/// `text` parsed, for a route table's template.
///
/// # Errors
///
/// A [`ProgrammerError`] for one off the grammar.
pub fn template_of(text: &str) -> Result<Template, ProgrammerError> {
    parse_template(text).map_err(|reason| {
        ProgrammerError::new(format!("{text} is no template of http.proto's: {reason}"))
    })
}

// a template's shape, up to its variables' names
fn shape_of(template: &Template) -> String {
    let segments: Vec<String> = template
        .segments
        .iter()
        .map(|segment| match segment {
            Segment::Literal(text) => format!("={text}"),
            Segment::Star => "*".to_owned(),
            Segment::Stars => "**".to_owned(),
        })
        .collect();
    let verb = template
        .verb
        .as_ref()
        .map_or_else(String::new, |verb| format!(":{verb}"));

    format!("/{}{verb}", segments.join("/"))
}

/// Whether two templates tie under 3.5's precedence: one shape, up to their variables' names (3.9).
#[must_use]
pub fn is_tie(one: &Template, other: &Template) -> bool {
    shape_of(one) == shape_of(other)
}

// ── Matching ─────────────────────────────────────────────────────────────────────────────────

// whether a segment is `.` or `..`, as it came or once percent-decoded (3.6)
fn is_dot_segment(segment: &str) -> bool {
    let decoded = segment.replace("%2e", ".").replace("%2E", ".");

    decoded == "." || decoded == ".."
}

/// A request's path, raw, as routes match it (3.6, 3.7).
///
/// Its segments by `/`, its verb what
/// follows the last `:` its last segment holds unencoded; none for a path that matches no route,
/// one with an empty segment or a dot segment, raw or once decoded.
#[must_use]
pub fn raw_path_of(path: &str) -> Option<RawPath> {
    let rest = path.strip_prefix('/')?;
    let mut segments: Vec<String> = rest.split('/').map(str::to_owned).collect();
    let mut verb = None;

    if let Some(last) = segments.last_mut()
        && let Some((before, after)) = last.rsplit_once(':')
    {
        verb = Some(after.to_owned());
        *last = before.to_owned();
    }

    if segments
        .iter()
        .any(|segment| segment.is_empty() || is_dot_segment(segment))
    {
        return None;
    }

    Some(RawPath { segments, verb })
}

// whether a template's last segment is `**`
fn is_open(template: &Template) -> bool {
    template.segments.last() == Some(&Segment::Stars)
}

/// Whether `template` matches `path`: its verb the path's, a literal its segment's text exactly,
/// `*` one segment, `**` the rest, none among them (3.6, 3.7).
#[must_use]
pub fn matches_template(template: &Template, path: &RawPath) -> bool {
    if template.verb != path.verb {
        return false;
    }

    let fixed = if is_open(template) {
        template
            .segments
            .split_last()
            .map_or(&[][..], |(_, rest)| rest)
    } else {
        &*template.segments
    };
    let fits = if is_open(template) {
        path.segments.len() >= fixed.len()
    } else {
        path.segments.len() == fixed.len()
    };

    fits && fixed
        .iter()
        .zip(&path.segments)
        .all(|(segment, given)| match segment {
            Segment::Literal(text) => text == given,
            Segment::Star | Segment::Stars => true,
        })
}

// a matching template's ranks for a path of `count` segments (3.5)
fn ranks_of(template: &Template, count: usize) -> Vec<i8> {
    let mut ranks: Vec<i8> = template
        .segments
        .iter()
        .map(|segment| match segment {
            Segment::Literal(_) => LITERAL_RANK,
            Segment::Star => STAR_RANK,
            Segment::Stars => STARS_RANK,
        })
        .collect();

    if template.segments.len() == count {
        ranks.push(END);
    }

    ranks
}

impl Template {
    /// Of it and `other`, two templates that match `path`, the order 3.5 answers them by: `Less`
    /// where it answers, `Greater` where `other` does, compared segment by segment from the first.
    #[must_use]
    pub fn compare_precedence(&self, other: &Self, path: &RawPath) -> Ordering {
        let left = ranks_of(self, path.segments.len());
        let right = ranks_of(other, path.segments.len());

        left.iter()
            .zip(&right)
            .map(|(left, right)| left.cmp(right))
            .find(|ordering| *ordering != Ordering::Equal)
            .unwrap_or_else(|| left.len().cmp(&right.len()))
    }
}

/// The index of the template of `templates` that answers `path` by 3.5's precedence, the first of
/// two that tie; none where none matches.
pub fn route_index_of<'a, I>(templates: I, path: &RawPath) -> Option<usize>
where
    I: IntoIterator<Item = &'a Template>,
{
    let mut best: Option<(usize, &Template)> = None;

    for (index, template) in templates.into_iter().enumerate() {
        if !matches_template(template, path) {
            continue;
        }

        let answers =
            best.is_none_or(|(_, held)| template.compare_precedence(held, path) == Ordering::Less);

        if answers {
            best = Some((index, template));
        }
    }

    best.map(|(index, _)| index)
}

// ── Decoding ─────────────────────────────────────────────────────────────────────────────────

fn hex_of(byte: u8) -> Option<u8> {
    char::from(byte)
        .to_digit(16)
        .and_then(|digit| u8::try_from(digit).ok())
}

// the octet a `%` at `at` of `bytes` encodes, where two hexadecimal digits follow it
fn octet_at(bytes: &[u8], at: usize) -> Option<u8> {
    let high = hex_of(*bytes.get(at.saturating_add(1))?)?;
    let low = hex_of(*bytes.get(at.saturating_add(2))?)?;

    Some(high.wrapping_shl(4) | low)
}

// `text` percent-decoded, each `%XX` an octet, a `%` that two hexadecimal digits do not follow
// kept as it is where `keeps` says so, refused otherwise; then read as UTF-8, a BOM kept
fn decode(text: &str, keeps: bool) -> Result<String, &'static str> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;

    while let Some(byte) = bytes.get(at) {
        if *byte != b'%' {
            decoded.push(*byte);
            at = at.saturating_add(1);

            continue;
        }

        match octet_at(bytes, at) {
            Some(octet) => {
                decoded.push(octet);
                at = at.saturating_add(3);
            }
            None if keeps => {
                decoded.push(b'%');
                at = at.saturating_add(1);
            }
            None => return Err(NO_PERCENT),
        }
    }

    String::from_utf8(decoded).or(Err(NO_UTF8))
}

/// `text` percent-decoded, then read as UTF-8: a `%` that two hexadecimal digits do not follow, or
/// bytes that are no UTF-8, refused.
///
/// # Errors
///
/// Why it does not decode: its words.
pub fn decode_of(text: &str) -> Result<String, &'static str> {
    decode(text, false)
}

/// `text` percent-decoded and read as UTF-8, as a query's name or value (transcoding 4.3).
///
/// Its `+` already a space; none where its bytes are no UTF-8. A `%` that two hexadecimal digits do
/// not follow stays as it is, as the WHATWG URL Standard's decoder leaves it.
#[must_use]
pub fn query_decode_of(text: &str) -> Option<String> {
    decode(text, true).ok()
}

// whether `part` is `%2F` or `%2f`, which a multi-segment variable keeps as it came
fn is_slash(part: &[u8]) -> bool {
    part.len() == 3
        && part.first() == Some(&b'%')
        && part
            .get(1..)
            .is_some_and(|rest| rest.eq_ignore_ascii_case(b"2f"))
}

// a multi-segment variable's value decoded, but each `%2F` and `%2f`
fn decode_multi(value: &str) -> Result<String, &'static str> {
    let bytes = value.as_bytes();
    let mut decoded = String::with_capacity(value.len());
    let mut from = 0;
    let mut at = 0;

    while at < bytes.len() {
        let end = at.saturating_add(3);

        if bytes.get(at..end).is_some_and(is_slash) {
            decoded.push_str(&decode_of(value.get(from..at).unwrap_or_default())?);
            decoded.push_str(value.get(at..end).unwrap_or_default());
            at = end;
            from = end;
        } else {
            at = at.saturating_add(1);
        }
    }

    decoded.push_str(&decode_of(value.get(from..).unwrap_or_default())?);

    Ok(decoded)
}

/// The values `template`'s variables take of `path`, which it matches, by their field paths.
///
/// Each its segments by `/`, a single-segment one percent-decoded whole, a multi-segment one but each
/// `%2F` and `%2f`, which stays as it came (3.8).
///
/// # Errors
///
/// Why one does not decode, and its field path.
pub fn variables_of(
    template: &Template,
    path: &RawPath,
) -> Result<Vec<VariableValue>, VariableRefusal> {
    let count = template.segments.len();
    let mut values = Vec::with_capacity(template.variables.len());

    for variable in &template.variables {
        // the path's segments a template's segment takes: one each, the rest for a `**`
        let end = if is_open(template) && variable.end == count {
            path.segments.len()
        } else {
            variable.end
        };
        let value = path
            .segments
            .get(variable.start..end)
            .unwrap_or_default()
            .join("/");
        let decoded = if variable.is_multi_segment {
            decode_multi(&value)
        } else {
            decode_of(&value)
        };

        match decoded {
            Ok(value) => values.push(VariableValue {
                field_path: variable.field_path.clone(),
                value,
            }),
            Err(reason) => {
                return Err(VariableRefusal {
                    field_path: variable.field_path.clone(),
                    reason,
                });
            }
        }
    }

    Ok(values)
}
