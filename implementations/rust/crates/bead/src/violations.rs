//! `PAYLOAD_INVALID`'s violations and its detail (spec 18.3, 18.6, 18.7).
//!
//! Lines of canonical JSON, a violation a line in their order, then a closing line, written under
//! the detail's bound and read back line by line, each through the `json` codec, so a cut keeps
//! every whole line.

use core::num::NonZeroU16;

use serde_json::{Map, Value};

use crate::constants::{FailureScope, ProtocolCode};
use crate::json;

#[cfg(test)]
mod tests;

/// A violation, the breach of one rule (spec 18.3).
///
/// Its path, its rule's id, the bounds its rule takes, its words, and whether it is a map key's;
/// and the value that broke it, which stays on the side that judged and never goes on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Violation {
    /// The members its rule takes, as protobuf's JSON mapping writes them; none for a flag alone.
    pub bounds: Option<Map<String, Value>>,
    /// The path from the request's message to the field (spec 18.4); none for the message's own.
    pub field_path: Option<String>,
    /// Whether it is a map key's.
    pub for_key: bool,
    /// Its words (spec 18.8.6).
    pub message: Option<String>,
    /// Its rule's id.
    pub rule_id: String,
    /// What broke it, held by the side that judged alone.
    pub value: Option<Value>,
}

/// What a judging gives: the violations its detail can carry, the count of the rest, and whether
/// it stopped at its first.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Judged {
    /// The violations, in their order (spec 18.5).
    pub violations: Vec<Violation>,
    /// The violations judged past its bound.
    pub more: u64,
    /// Whether it stopped at its first.
    pub stopped: bool,
}

/// What a reader read of a detail (spec 18.7).
///
/// Its violations, and its closing line's count, or that its side stopped; neither where the detail
/// holds no closing line.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReadViolations {
    /// The violations read, in their order.
    pub violations: Vec<Violation>,
    /// The closing line's count, where one counts.
    pub more: Option<u64>,
    /// Whether a closing line says its side stopped.
    pub stopped: bool,
}

/// The closing line at its longest, `{"more":N}` with N at 2⁵³ − 1, and the line feed before it.
pub const CLOSING_BYTES: usize = 26;

// what an envelope holds beside a failure's detail: its prefix, an announcement's block, its
// record (spec 7.4)
const ENVELOPE_BESIDE_DETAIL: usize = 32;

// the largest count a closing line writes and reads, the largest integer an I-JSON number holds
// exactly (RFC 7493 §2.2)
const LARGEST_COUNT: u64 = 9_007_199_254_740_991;

// a JSON value's text in section 17.7's form
fn canonical_of(value: &Value) -> String {
    json::write(value)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

// a violation as its line carries it: its members alone, none empty
fn members_of(violation: &Violation) -> Map<String, Value> {
    let mut members = Map::new();

    if let Some(bounds) = violation
        .bounds
        .as_ref()
        .filter(|bounds| !bounds.is_empty())
    {
        members.insert("bounds".to_owned(), Value::Object(bounds.clone()));
    }

    if let Some(field_path) = violation
        .field_path
        .as_ref()
        .filter(|path| !path.is_empty())
    {
        members.insert("fieldPath".to_owned(), Value::String(field_path.clone()));
    }

    if violation.for_key {
        members.insert("forKey".to_owned(), Value::Bool(true));
    }

    if let Some(message) = violation
        .message
        .as_ref()
        .filter(|message| !message.is_empty())
    {
        members.insert("message".to_owned(), Value::String(message.clone()));
    }

    members.insert(
        "ruleId".to_owned(),
        Value::String(violation.rule_id.clone()),
    );

    members
}

// a violation's lines, whole, then without its message, then without its bounds too
fn lines_of(violation: &Violation) -> Vec<String> {
    let mut whole = members_of(violation);
    let mut lines = vec![canonical_of(&Value::Object(whole.clone()))];

    whole.remove("message");
    lines.push(canonical_of(&Value::Object(whole.clone())));
    whole.remove("bounds");
    lines.push(canonical_of(&Value::Object(whole)));
    lines.dedup();

    lines
}

/// The detail's bound under a router's limits (spec 7.4).
///
/// `maximum_detail_bytes`, and `maximum_envelope_bytes` less the 32 bytes an envelope holds beside
/// its detail.
#[must_use]
pub fn detail_bound_of(maximum_detail_bytes: usize, maximum_envelope_bytes: usize) -> usize {
    maximum_detail_bytes.min(maximum_envelope_bytes.saturating_sub(ENVELOPE_BESIDE_DETAIL))
}

/// Whether a judging refuses its request: a violation held, or one counted past its bound.
#[must_use]
pub fn is_refused(judged: &Judged) -> bool {
    !judged.violations.is_empty() || judged.more > 0
}

/// What holds violations within a detail's bound, line by line as its writer writes (spec 18.6).
#[derive(Debug, Clone)]
pub struct ViolationHolder {
    maximum_bytes: usize,
    lines: Vec<String>,
    size: usize,
    is_full: bool,
}

impl ViolationHolder {
    /// A holder of a detail of `maximum_bytes`.
    #[must_use]
    pub fn new(maximum_bytes: usize) -> Self {
        Self {
            maximum_bytes,
            lines: Vec::new(),
            size: 0,
            is_full: false,
        }
    }

    /// Holds `violation` where one of its lines holds, the closing line's 26 bytes kept.
    ///
    /// Whole, then without its `message`, then without its `bounds` too; the first that holds in
    /// none fills it, and every one after is refused.
    pub fn hold(&mut self, violation: &Violation) -> bool {
        if self.is_full {
            return false;
        }

        let separator = usize::from(!self.lines.is_empty());

        for line in lines_of(violation) {
            let size = self
                .size
                .saturating_add(separator)
                .saturating_add(line.len());

            if size.saturating_add(CLOSING_BYTES) <= self.maximum_bytes {
                self.size = size;
                self.lines.push(line);

                return true;
            }
        }

        self.is_full = true;

        false
    }

    /// The lines held, in their order.
    #[must_use]
    pub fn lines(&self) -> &[String] {
        &self.lines
    }
}

/// The detail of `PAYLOAD_INVALID` that `judged` gives, under `maximum_bytes` (spec 18.6).
///
/// The lines of the violations it holds, then `{"more":N}`, N every one it leaves out, or
/// `{"stopped":true}`; an empty detail where the bound holds no closing line.
#[must_use]
pub fn violations_detail_of(judged: &Judged, maximum_bytes: usize) -> String {
    let mut holder = ViolationHolder::new(maximum_bytes);
    let mut held = 0_u64;

    for violation in &judged.violations {
        if !holder.hold(violation) {
            break;
        }

        held = held.saturating_add(1);
    }

    let mut closing = Map::new();

    if judged.stopped {
        closing.insert("stopped".to_owned(), Value::Bool(true));
    } else {
        let count = judged
            .more
            .saturating_add(u64::try_from(judged.violations.len()).unwrap_or(u64::MAX))
            .saturating_sub(held);

        // * a count past 2⁵³ − 1 is written as it, the largest integer I-JSON holds (spec 18.6)
        closing.insert(
            "more".to_owned(),
            Value::Number(count.min(LARGEST_COUNT).into()),
        );
    }

    let mut lines = holder.lines;

    lines.push(canonical_of(&Value::Object(closing)));

    let size = lines
        .iter()
        .map(|line| line.len().saturating_add(1))
        .sum::<usize>()
        .saturating_sub(1);

    if size > maximum_bytes {
        String::new()
    } else {
        lines.join("\n")
    }
}

// a scalar as `%s` writes it: a string as it is, a number as section 17.7.4 writes it, a literal
fn scalar_words_of(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(_) | Value::Bool(_) => Some(canonical_of(value)),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

// bytes in base64 as RFC 4648 §4 writes them, in lower-case hexadecimal, `%x`'s form
fn hexadecimal_of(value: &Value) -> Option<String> {
    let Value::String(text) = value else {
        return None;
    };
    let bytes = standard_base64(text.as_bytes())?;

    Some(bytes.iter().fold(String::new(), |mut text, byte| {
        use core::fmt::Write as _;

        write!(text, "{byte:02x}").ok();
        text
    }))
}

// the bytes base64 of the standard alphabet spells, by fours, padded to the last, as `atob` reads
// it: the bits past the last byte dropped, whatever they are
fn standard_base64(text: &[u8]) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(4) {
        return None;
    }

    let padding = text.iter().rev().take_while(|&&byte| byte == b'=').count();

    if padding > 2 {
        return None;
    }

    let body = text.get(..text.len().saturating_sub(padding))?;
    let mut bytes = Vec::new();
    let mut word = 0_u32;
    let mut bits = 0_u32;

    for &character in body {
        let value = match character {
            b'A'..=b'Z' => character.wrapping_sub(b'A'),
            b'a'..=b'z' => character.wrapping_sub(b'a').wrapping_add(26),
            b'0'..=b'9' => character.wrapping_sub(b'0').wrapping_add(52),
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };

        word = (word << 6) | u32::from(value);
        bits = bits.saturating_add(6);

        if bits >= 8 {
            bits = bits.saturating_sub(8);
            bytes.push(u8::try_from((word >> bits) & 0xff).ok()?);
        }
    }

    Some(bytes)
}

// the twelve number types of validate.proto's rules
const NUMBER_TYPES: [&str; 12] = [
    "float", "double", "int32", "int64", "uint32", "uint64", "sint32", "sint64", "fixed32",
    "fixed64", "sfixed32", "sfixed64",
];

fn bound_words(member: &str) -> &'static str {
    match member {
        "gt" => "greater than",
        "gte" => "greater than or equal to",
        "lt" => "less than",
        _ => "less than or equal to",
    }
}

// a rule's template (spec 18.8.6): its words, each placeholder `%s`, `%d` or `%x` written from the
// member beside it, in their order
fn template_of(rule_id: &str) -> Option<(String, Vec<&str>)> {
    let fixed: Option<(&str, &[&str])> = match rule_id {
        "float.finite" | "double.finite" => Some(("must be finite", &[])),
        "bool.const" | "enum.const" => Some(("must equal %s", &["const"])),
        "string.const" => Some(("must equal `%s`", &["const"])),
        "string.len" => Some(("must be %s characters", &["len"])),
        "string.min_len" => Some(("must be at least %s characters", &["min_len"])),
        "string.max_len" => Some(("must be at most %s characters", &["max_len"])),
        "string.len_bytes" => Some(("must be %s bytes", &["len_bytes"])),
        "string.min_bytes" => Some(("must be at least %s bytes", &["min_bytes"])),
        "string.max_bytes" => Some(("must be at most %s bytes", &["max_bytes"])),
        "string.pattern" => Some(("does not match regex pattern `%s`", &["pattern"])),
        "string.prefix" => Some(("does not have prefix `%s`", &["prefix"])),
        "string.suffix" => Some(("does not have suffix `%s`", &["suffix"])),
        "string.contains" => Some(("does not contain substring `%s`", &["contains"])),
        "string.not_contains" => Some(("contains substring `%s`", &["not_contains"])),
        "string.in" | "enum.in" => Some(("must be in list %s", &["in"])),
        "string.not_in" | "enum.not_in" => Some(("must not be in list %s", &["not_in"])),
        "bytes.const" => Some(("must be %x", &["const"])),
        "bytes.len" => Some(("must be %s bytes", &["len"])),
        "bytes.min_len" => Some(("must be at least %s bytes", &["min_len"])),
        "bytes.max_len" => Some(("must be at most %s bytes", &["max_len"])),
        "bytes.prefix" => Some(("does not have prefix %x", &["prefix"])),
        "bytes.suffix" => Some(("does not have suffix %x", &["suffix"])),
        "bytes.contains" => Some(("does not contain %x", &["contains"])),
        "enum.defined_only" => Some(("value must be one of the defined enum values", &[])),
        "repeated.min_items" => Some(("must contain at least %d item(s)", &["min_items"])),
        "repeated.max_items" => Some(("must contain no more than %s item(s)", &["max_items"])),
        "repeated.unique" => Some(("repeated value must contain unique items", &[])),
        "map.min_pairs" => Some(("map must be at least %d entries", &["min_pairs"])),
        "map.max_pairs" => Some(("map must be at most %d entries", &["max_pairs"])),
        _ => None,
    };

    if let Some((words, members)) = fixed {
        return Some((words.to_owned(), members.to_vec()));
    }

    let (kind, rule) = rule_id.split_once('.')?;

    if !NUMBER_TYPES.contains(&kind) {
        return None;
    }

    match rule {
        "const" => Some(("must equal %s".to_owned(), vec!["const"])),
        "in" => Some(("must be in list %s".to_owned(), vec!["in"])),
        "not_in" => Some(("must not be in list %s".to_owned(), vec!["not_in"])),
        "lt" | "lte" | "gt" | "gte" => {
            let member = ["lt", "lte", "gt", "gte"]
                .into_iter()
                .find(|&member| member == rule)?;

            Some((format!("must be {} %s", bound_words(member)), vec![member]))
        }
        _ => {
            let (range, is_exclusive) = rule
                .strip_suffix("_exclusive")
                .map_or((rule, false), |range| (range, true));
            let (lower, upper) = range.split_once('_')?;
            let lower = ["gt", "gte"].into_iter().find(|&member| member == lower)?;
            let upper = ["lt", "lte"].into_iter().find(|&member| member == upper)?;

            Some((
                format!(
                    "must be {} %s {} {} %s",
                    bound_words(lower),
                    if is_exclusive { "or" } else { "and" },
                    bound_words(upper)
                ),
                vec![lower, upper],
            ))
        }
    }
}

/// 18.8.6's words of a violation, from its rule's id and its bounds.
///
/// For the rules beadc compiles alone, by their templates in `validate.proto`: none for another
/// id, nor where a member its template takes is missing or of another shape.
#[must_use]
pub fn words_of(violation: &Violation) -> Option<String> {
    let (template, members) = template_of(&violation.rule_id)?;
    let mut words = String::new();
    let mut rest = template.as_str();

    for member in members {
        let at = rest.find('%')?;
        let (before, after) = rest.split_at(at);
        let placeholder = after.get(..2)?;

        words.push_str(before);
        rest = after.get(2..)?;

        let value = violation
            .bounds
            .as_ref()
            .and_then(|bounds| bounds.get(member));
        let written = match (placeholder, value) {
            ("%x", Some(value)) => hexadecimal_of(value)?,
            (_, Some(Value::Array(items))) if member == "in" || member == "not_in" => {
                let items: Option<Vec<String>> = items.iter().map(scalar_words_of).collect();

                format!("[{}]", items?.join(", "))
            }
            (_, Some(value)) if member != "in" && member != "not_in" => scalar_words_of(value)?,
            _ => return None,
        };

        words.push_str(&written);
    }

    words.push_str(rest);

    Some(words)
}

// a line read as a violation (spec 18.3, 18.7): its members alone, each of its type, none empty
fn as_violation(value: &Value) -> Option<Violation> {
    let Value::Object(members) = value else {
        return None;
    };
    let known = ["bounds", "fieldPath", "forKey", "message", "ruleId"];

    if !members.keys().all(|name| known.contains(&name.as_str())) {
        return None;
    }

    let text = |name: &str| match members.get(name) {
        None => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(_) => None,
    };
    let Some(Value::String(rule_id)) = members.get("ruleId") else {
        return None;
    };
    let bounds = match members.get("bounds") {
        None => None,
        Some(Value::Object(bounds)) => Some(bounds.clone()),
        Some(_) => return None,
    };
    let for_key = match members.get("forKey") {
        None => false,
        Some(Value::Bool(for_key)) => *for_key,
        Some(_) => return None,
    };

    // * a member empty is absent, as protovalidate drops an empty field path or message
    Some(Violation {
        bounds: bounds.filter(|bounds| !bounds.is_empty()),
        field_path: text("fieldPath")?.filter(|path| !path.is_empty()),
        for_key,
        message: text("message")?.filter(|message| !message.is_empty()),
        rule_id: rule_id.clone(),
        value: None,
    })
}

/// The violations a `PAYLOAD_INVALID`'s detail carries (spec 18.7).
///
/// Each whole line that reads as one, up to the first that does not, a line without its `message`
/// given the words its rule and its bounds give; then its closing line's count, or that its side
/// stopped. A failure of another code gives none.
#[must_use]
pub fn violations_of((code, scope): (NonZeroU16, FailureScope), detail: &str) -> ReadViolations {
    let mut read = ReadViolations::default();

    if code != ProtocolCode::PAYLOAD_INVALID.get()
        || scope != FailureScope::Protocol
        || detail.is_empty()
    {
        return read;
    }

    for line in detail.split('\n') {
        let value = json::read(line.as_bytes()).ok();

        if let Some(mut violation) = value.as_ref().and_then(as_violation) {
            if violation.message.is_none() {
                violation.message = words_of(&violation);
            }

            read.violations.push(violation);

            continue;
        }

        if let Some(Value::Object(closing)) = &value
            && closing.len() == 1
        {
            match (closing.get("more"), closing.get("stopped")) {
                // * a count is an integer from 0 to 2⁵³ − 1 (spec 18.7); a count of -0 is 0
                (Some(Value::Number(more)), _) => {
                    let count = more
                        .as_u64()
                        .or_else(|| more.as_f64().filter(|&double| double == 0.0).map(|_zero| 0));

                    if let Some(count) = count.filter(|&count| count <= LARGEST_COUNT) {
                        read.more = Some(count);
                    }
                }
                (_, Some(Value::Bool(true))) => read.stopped = true,
                _ => {}
            }
        }

        break;
    }

    read
}
