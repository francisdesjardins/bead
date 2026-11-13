//! What a `proto` request's generated rules judge with (spec 18, decisions 0035 and 0051): a sink
//! that holds the violations its detail carries and counts the rest, a path built for a violation
//! held alone, a value made JSON for a violation held alone, and the readings 18.8 fixes: code
//! points, UTF-8 bytes, `==`, a map's keys in order. The TypeScript side's twin is `validatorOf`
//! and its helpers, the C# side's `Validators`, `IViolationSink` and `ViolationRule`.
//!
//! A message's rules are generated as one function, [`MessageRules`], that judges each field in
//! spec 18.5's order into a [`ViolationSink`], each rule a constant [`ViolationRule`] and each
//! pattern a constant [`PatternTable`]; [`validator_of`] makes it the `validate` of its descriptor.
//! A value the sink keeps is borrowed as a [`RuleValue`], made JSON only for a violation it holds:
//! past its bound, it counts and reads nothing.

use core::fmt;
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::sync::Arc;

use bead::{Judged, ProgrammerError, Validate, ValidateOptions, Violation, ViolationHolder};
use buffa::{EnumValue, Enumeration};
use serde_json::{Map, Number, Value};

mod pattern;
#[cfg(test)]
mod tests;

pub use pattern::{PatternTable, matches_pattern};

/// A string key's subscript holds 64 bytes of its UTF-8 at most (spec 18.4).
const KEY_BYTES: usize = 64;

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// ── Rules ─────────────────────────────────────────────────────────────────────

/// A rule's site, a constant of a generated file: what every violation of it says, fixed when
/// beadc writes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViolationRule {
    /// Its rule's id, protovalidate's `rule_id`.
    pub rule_id: &'static str,
    /// Its words (spec 18.8.6).
    pub message: &'static str,
    /// The members its rule takes, a JSON object as protobuf's JSON mapping writes them; none for
    /// a rule that takes none.
    pub bounds: Option<&'static str>,
    /// Whether it judges a map's key.
    pub for_key: bool,
}

/// What broke a rule, borrowed from the message judged: the sink makes it JSON only for a
/// violation it holds, and it stays on the side that judged.
#[derive(Clone, Copy)]
#[non_exhaustive]
pub enum RuleValue<'a> {
    /// No value kept: a field unset, or a message, or a list or a map of messages.
    Absent,
    /// A `bool`.
    Bool(bool),
    /// A signed integer, an enum's number among them.
    Signed(i64),
    /// An unsigned integer.
    Unsigned(u64),
    /// A `float` or a `double`.
    Float(f64),
    /// A `string`.
    Text(&'a str),
    /// A `bytes`, kept as its base64.
    Bytes(&'a [u8]),
    /// A repeated field's items, or a map's entries.
    Items(&'a dyn RuleItems),
}

impl fmt::Debug for RuleValue<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Absent => formatter.write_str("Absent"),
            Self::Bool(value) => formatter.debug_tuple("Bool").field(value).finish(),
            Self::Signed(value) => formatter.debug_tuple("Signed").field(value).finish(),
            Self::Unsigned(value) => formatter.debug_tuple("Unsigned").field(value).finish(),
            Self::Float(value) => formatter.debug_tuple("Float").field(value).finish(),
            Self::Text(value) => formatter.debug_tuple("Text").field(value).finish(),
            Self::Bytes(value) => formatter.debug_tuple("Bytes").field(value).finish(),
            Self::Items(_) => formatter.write_str("Items(..)"),
        }
    }
}

/// A map's key, as a path's subscript renders it (spec 18.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MapKey<'a> {
    /// A signed integer key.
    Signed(i64),
    /// An unsigned integer key.
    Unsigned(u64),
    /// A `bool` key.
    Bool(bool),
    /// A `string` key.
    Text(&'a str),
}

/// A repeated field's items, or a map's entries, as a rule reads them whole: implemented for
/// Buffa's lists and maps of scalars, strings, bytes and enums.
pub trait RuleItems {
    /// Hands `visit` each item in its order, or each entry of a map, its key beside its value.
    fn each<'a>(&'a self, visit: &mut dyn FnMut(Option<MapKey<'a>>, RuleValue<'a>));
}

/// Where a generated file's rules write, in spec 18.5's order: a violation at the path the sink
/// stands at, and the steps of that path. A sink builds a path only for a violation it keeps.
pub trait ViolationSink {
    /// Adds a violation of `rule`, of `value`: `true` where the judging stops there, under
    /// `fail_fast`.
    fn add(&mut self, rule: &ViolationRule, value: RuleValue<'_>) -> bool;

    /// Steps into the field `name` of the message it stands at, or names its oneof.
    fn enter(&mut self, name: &'static str);

    /// Steps into the item `index` of the repeated field `name`.
    fn enter_index(&mut self, name: &'static str, index: usize);

    /// Steps into the entry `key` of the map field `name`.
    fn enter_key(&mut self, name: &'static str, key: MapKey<'_>);

    /// Steps back out of the last step it took.
    fn leave(&mut self);
}

/// A message's generated rules: each judged into `sink`, `true` where the judging stopped.
pub type MessageRules<M> = fn(&M, &mut dyn ViolationSink) -> bool;

// ── The sink ──────────────────────────────────────────────────────────────────

// a string key's first 64 bytes of UTF-8 at most, cut on a character, and whether it was cut
#[derive(Clone, Copy)]
struct KeyText {
    bytes: [u8; KEY_BYTES],
    length: usize,
    is_cut: bool,
}

impl KeyText {
    fn of(text: &str) -> Self {
        // * cut back to a character's start: the end of the last character that holds whole
        let length = text
            .char_indices()
            .map(|(at, character)| at.saturating_add(character.len_utf8()))
            .take_while(|end| *end <= KEY_BYTES)
            .last()
            .unwrap_or(0);
        let mut bytes = [0; KEY_BYTES];

        if let (Some(part), Some(target)) = (text.as_bytes().get(..length), bytes.get_mut(..length))
        {
            target.copy_from_slice(part);
        }

        Self {
            bytes,
            length,
            is_cut: length < text.len(),
        }
    }

    fn text(&self) -> &str {
        self.bytes
            .get(..self.length)
            .and_then(|bytes| core::str::from_utf8(bytes).ok())
            .unwrap_or_default()
    }
}

// what a step holds beside its name: nothing, an item's index, or an entry's key
#[derive(Clone, Copy)]
enum Subscript {
    None,
    Index(usize),
    Signed(i64),
    Unsigned(u64),
    Bool(bool),
    Text(KeyText),
}

// one step of a path: a field, or an item or an entry of one, its subscript kept as it was given
#[derive(Clone, Copy)]
struct Step {
    name: &'static str,
    subscript: Subscript,
}

// a JSON text in section 17.7's form
fn canonical_of(value: &Value) -> String {
    bead::json::write(value)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

// a key's subscript (spec 18.4): an integer or a boolean as it reads, a string in section 17.7's
// form, whole within 64 bytes of UTF-8, else cut back to a character's start and marked `...`
fn subscript_of(subscript: &Subscript) -> Option<String> {
    match subscript {
        Subscript::None => None,
        Subscript::Index(index) => Some(index.to_string()),
        Subscript::Signed(key) => Some(key.to_string()),
        Subscript::Unsigned(key) => Some(key.to_string()),
        Subscript::Bool(key) => Some(key.to_string()),
        Subscript::Text(key) => {
            let text = canonical_of(&Value::String(key.text().to_owned()));

            Some(if key.is_cut { text + "..." } else { text })
        }
    }
}

// bytes as protobuf's JSON mapping writes them: base64, padded
fn base64_of(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len().div_ceil(3).saturating_mul(4));

    for chunk in bytes.chunks(3) {
        let first = chunk.first().copied().unwrap_or(0);
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        let joined = (u32::from(first) << 16) | (u32::from(second) << 8) | u32::from(third);
        let digit = |shift: u32| {
            usize::try_from((joined >> shift) & 0x3F)
                .ok()
                .and_then(|index| BASE64.get(index))
                .map_or('=', |digit| char::from(*digit))
        };

        text.push(digit(18));
        text.push(digit(12));
        text.push(if chunk.len() > 1 { digit(6) } else { '=' });
        text.push(if chunk.len() > 2 { digit(0) } else { '=' });
    }

    text
}

// a float as protobuf's JSON mapping writes it: a number, or the name of what no number is
fn float_of(value: f64) -> Value {
    Number::from_f64(value).map_or_else(
        || {
            Value::String(
                if value.is_nan() {
                    "NaN"
                } else if value.is_sign_negative() {
                    "-Infinity"
                } else {
                    "Infinity"
                }
                .to_owned(),
            )
        },
        Value::Number,
    )
}

// a map's key as a JSON object's member names it
fn key_of(key: MapKey<'_>) -> String {
    match key {
        MapKey::Signed(key) => key.to_string(),
        MapKey::Unsigned(key) => key.to_string(),
        MapKey::Bool(key) => key.to_string(),
        MapKey::Text(key) => key.to_owned(),
    }
}

// what broke a rule, as the side that judged keeps it
fn json_of(value: RuleValue<'_>) -> Option<Value> {
    match value {
        RuleValue::Absent => None,
        RuleValue::Bool(value) => Some(Value::Bool(value)),
        RuleValue::Signed(value) => Some(Value::from(value)),
        RuleValue::Unsigned(value) => Some(Value::from(value)),
        RuleValue::Float(value) => Some(float_of(value)),
        RuleValue::Text(value) => Some(Value::String(value.to_owned())),
        RuleValue::Bytes(value) => Some(Value::String(base64_of(value))),
        RuleValue::Items(items) => {
            let mut list = Vec::new();
            let mut map = Map::new();

            items.each(&mut |key, value| {
                let value = json_of(value).unwrap_or(Value::Null);

                match key {
                    Some(key) => {
                        map.insert(key_of(key), value);
                    }
                    None => list.push(value),
                }
            });

            Some(if map.is_empty() {
                Value::Array(list)
            } else {
                Value::Object(map)
            })
        }
    }
}

// the sink a validator judges into (spec 18.6): it keeps a violation while a detail of its bound
// would write it, sized as the writer sizes it with the closing line's bytes kept, and past that
// counts the rest without building their path or their value; it stops at the first under
// fail_fast
struct Judging {
    fail_fast: bool,
    holder: Option<ViolationHolder>,
    steps: Vec<Step>,
    violations: Vec<Violation>,
    more: u64,
    is_full: bool,
    refusal: Option<ProgrammerError>,
}

impl Judging {
    // the path the sink stands at (spec 18.4): its steps by `.`, an item by its index and an entry
    // by its key; none at the message's own
    fn path(&self) -> Option<String> {
        if self.steps.is_empty() {
            return None;
        }

        let mut path = String::new();

        for (at, step) in self.steps.iter().enumerate() {
            if at > 0 {
                path.push('.');
            }

            path.push_str(step.name);

            if let Some(subscript) = subscript_of(&step.subscript) {
                path.push('[');
                path.push_str(&subscript);
                path.push(']');
            }
        }

        Some(path)
    }

    fn push(&mut self, step: Step) {
        self.steps.push(step);
    }
}

impl ViolationSink for Judging {
    fn add(&mut self, rule: &ViolationRule, value: RuleValue<'_>) -> bool {
        if self.is_full {
            self.more = self.more.saturating_add(1);

            return self.fail_fast;
        }

        let bounds = match rule.bounds.map(serde_json::from_str::<Map<String, Value>>) {
            Some(Ok(bounds)) => Some(bounds),
            Some(Err(error)) => {
                // ! beadc writes an object: another text is its rule's fault, the judging's error
                self.refusal.get_or_insert_with(|| {
                    ProgrammerError::new(format!(
                        "the bounds of the rule {} are no JSON object: {error}",
                        rule.rule_id
                    ))
                });

                None
            }
            None => None,
        };
        let mut violation = Violation {
            bounds,
            field_path: self.path(),
            for_key: rule.for_key,
            message: Some(rule.message.to_owned()),
            rule_id: rule.rule_id.to_owned(),
            value: None,
        };

        // * held first, as its line is sized without its value: a value is made for a violation
        // held alone
        if self
            .holder
            .as_mut()
            .is_none_or(|holder| holder.hold(&violation))
        {
            violation.value = json_of(value);
            self.violations.push(violation);
        } else {
            self.is_full = true;
            self.more = self.more.saturating_add(1);
        }

        self.fail_fast
    }

    fn enter(&mut self, name: &'static str) {
        self.push(Step {
            name,
            subscript: Subscript::None,
        });
    }

    fn enter_index(&mut self, name: &'static str, index: usize) {
        self.push(Step {
            name,
            subscript: Subscript::Index(index),
        });
    }

    fn enter_key(&mut self, name: &'static str, key: MapKey<'_>) {
        let subscript = match key {
            MapKey::Signed(key) => Subscript::Signed(key),
            MapKey::Unsigned(key) => Subscript::Unsigned(key),
            MapKey::Bool(key) => Subscript::Bool(key),
            MapKey::Text(key) => Subscript::Text(KeyText::of(key)),
        };

        self.push(Step { name, subscript });
    }

    fn leave(&mut self) {
        self.steps.pop();
    }
}

// ── Judging ───────────────────────────────────────────────────────────────────

/// Judges `rules` into a sink that holds the violations a detail of its options' bound carries.
///
/// It holds each as its writer sizes it, and counts the rest without building their path or their
/// value, or stops at the first under `fail_fast` (spec 18.2, 18.6). A judging that breaks nothing
/// allocates no violation.
///
/// # Errors
///
/// A [`ProgrammerError`] where a rule's bounds are no JSON object, which beadc never writes.
pub fn judge_rules<F>(rules: F, options: &ValidateOptions) -> Result<Judged, ProgrammerError>
where
    F: FnOnce(&mut dyn ViolationSink) -> bool,
{
    let fail_fast = options.fail_fast.unwrap_or(false);
    let mut judging = Judging {
        fail_fast,
        holder: options.maximum_bytes.map(ViolationHolder::new),
        steps: Vec::new(),
        violations: Vec::new(),
        more: 0,
        is_full: false,
        refusal: None,
    };
    let stopped = rules(&mut judging) && fail_fast;

    if let Some(refusal) = judging.refusal {
        return Err(refusal);
    }

    let mut judged = Judged::default();

    if judging.violations.is_empty() && judging.more == 0 {
        return Ok(judged);
    }

    judged.violations = judging.violations;
    judged.more = judging.more;
    judged.stopped = stopped;

    Ok(judged)
}

/// The validator of a message's `rules`, as a descriptor's `validate` takes it: its rules judged
/// by [`judge_rules`] under the options its layer gives.
#[must_use]
pub fn validator_of<M: 'static>(rules: MessageRules<M>) -> Validate<M> {
    Arc::new(move |message: &M, options: &ValidateOptions| {
        judge_rules(|sink| rules(message, sink), options)
            .map_err(|refusal| -> Box<dyn Error + Send + Sync> { Box::new(refusal) })
    })
}

// ── The readings ──────────────────────────────────────────────────────────────

/// A string's length in code points (spec 18.8.2).
#[must_use]
pub fn code_point_length(text: &str) -> u64 {
    u64::try_from(text.chars().count()).unwrap_or(u64::MAX)
}

/// A string's length in the UTF-8 it is sent as (spec 18.8.2).
#[must_use]
pub fn utf8_length(text: &str) -> u64 {
    u64::try_from(text.len()).unwrap_or(u64::MAX)
}

/// Whether two byte strings are one.
#[must_use]
pub fn bytes_equal(bytes: &[u8], other: &[u8]) -> bool {
    bytes == other
}

/// Whether `bytes` starts with `prefix`.
#[must_use]
pub fn bytes_start_with(bytes: &[u8], prefix: &[u8]) -> bool {
    bytes.starts_with(prefix)
}

/// Whether `bytes` ends with `suffix`.
#[must_use]
pub fn bytes_end_with(bytes: &[u8], suffix: &[u8]) -> bool {
    bytes.ends_with(suffix)
}

/// Whether `bytes` holds `part`; an empty part, every byte string.
#[must_use]
pub fn bytes_contain(bytes: &[u8], part: &[u8]) -> bool {
    part.is_empty() || bytes.windows(part.len()).any(|window| window == part)
}

// an item as `==` compares it: a float's `0` and `-0` one, and a NaN no item at all
#[derive(PartialEq, Eq, Hash)]
enum Compared<'a> {
    Bool(bool),
    Signed(i64),
    Unsigned(u64),
    Float(u64),
    Text(&'a str),
    Bytes(&'a [u8]),
}

/// Whether no two items are one, as `==` compares them (spec 18.8.4): `0` and `-0` one, two NaN
/// two, bytes by their bytes.
#[must_use]
pub fn is_unique(items: &dyn RuleItems) -> bool {
    let mut seen = HashSet::new();
    let mut is_unique = true;

    items.each(&mut |_, value| {
        let compared = match value {
            RuleValue::Bool(value) => Compared::Bool(value),
            RuleValue::Signed(value) => Compared::Signed(value),
            RuleValue::Unsigned(value) => Compared::Unsigned(value),
            // ! NaN equals nothing, itself among it
            RuleValue::Float(value) if value.is_nan() => return,
            RuleValue::Float(value) => Compared::Float(if value == 0.0 {
                0.0_f64.to_bits()
            } else {
                value.to_bits()
            }),
            RuleValue::Text(value) => Compared::Text(value),
            RuleValue::Bytes(value) => Compared::Bytes(value),
            RuleValue::Absent | RuleValue::Items(_) => return,
        };

        if !seen.insert(compared) {
            is_unique = false;
        }
    });

    is_unique
}

/// An entry of a map, as [`entries_by_key`] orders them.
#[derive(Debug)]
pub struct MapEntry<'a, K, V> {
    /// Its key.
    pub key: &'a K,
    /// Its value.
    pub value: &'a V,
}

/// A map's entries by key (spec 18.5), as protobuf's deterministic serialization orders them.
///
/// Integers ascending, `false` before `true`, strings by code points, which their UTF-8's bytes
/// order alike.
#[must_use]
pub fn entries_by_key<K: Ord, V, S>(map: &HashMap<K, V, S>) -> Vec<MapEntry<'_, K, V>> {
    let mut entries: Vec<MapEntry<'_, K, V>> = map
        .iter()
        .map(|(key, value)| MapEntry { key, value })
        .collect();

    entries.sort_by(|one, other| one.key.cmp(other.key));

    entries
}

// ── Buffa's lists and maps ────────────────────────────────────────────────────

// an item of a list, or a value of a map, as a rule reads it
trait Item {
    fn value(&self) -> RuleValue<'_>;
}

// a map's key, as a path's subscript renders it
trait Key {
    fn key(&self) -> MapKey<'_>;
}

impl Item for bool {
    fn value(&self) -> RuleValue<'_> {
        RuleValue::Bool(*self)
    }
}

impl Item for i32 {
    fn value(&self) -> RuleValue<'_> {
        RuleValue::Signed(i64::from(*self))
    }
}

impl Item for i64 {
    fn value(&self) -> RuleValue<'_> {
        RuleValue::Signed(*self)
    }
}

impl Item for u32 {
    fn value(&self) -> RuleValue<'_> {
        RuleValue::Unsigned(u64::from(*self))
    }
}

impl Item for u64 {
    fn value(&self) -> RuleValue<'_> {
        RuleValue::Unsigned(*self)
    }
}

impl Item for f32 {
    fn value(&self) -> RuleValue<'_> {
        RuleValue::Float(f64::from(*self))
    }
}

impl Item for f64 {
    fn value(&self) -> RuleValue<'_> {
        RuleValue::Float(*self)
    }
}

impl Item for String {
    fn value(&self) -> RuleValue<'_> {
        RuleValue::Text(self)
    }
}

impl Item for Vec<u8> {
    fn value(&self) -> RuleValue<'_> {
        RuleValue::Bytes(self)
    }
}

impl<E: Enumeration> Item for EnumValue<E> {
    fn value(&self) -> RuleValue<'_> {
        RuleValue::Signed(i64::from(self.to_i32()))
    }
}

impl Key for bool {
    fn key(&self) -> MapKey<'_> {
        MapKey::Bool(*self)
    }
}

impl Key for i32 {
    fn key(&self) -> MapKey<'_> {
        MapKey::Signed(i64::from(*self))
    }
}

impl Key for i64 {
    fn key(&self) -> MapKey<'_> {
        MapKey::Signed(*self)
    }
}

impl Key for u32 {
    fn key(&self) -> MapKey<'_> {
        MapKey::Unsigned(u64::from(*self))
    }
}

impl Key for u64 {
    fn key(&self) -> MapKey<'_> {
        MapKey::Unsigned(*self)
    }
}

impl Key for String {
    fn key(&self) -> MapKey<'_> {
        MapKey::Text(self)
    }
}

// a list of each kind of item a rule reads whole
macro_rules! lists_of {
    ($($item:ty),*) => {
        $(
            impl RuleItems for Vec<$item> {
                fn each<'a>(&'a self, visit: &mut dyn FnMut(Option<MapKey<'a>>, RuleValue<'a>)) {
                    for item in self {
                        visit(None, Item::value(item));
                    }
                }
            }
        )*
    };
}

// a map of `$key` to each kind of value a rule reads whole
macro_rules! maps_of {
    ($key:ty: $($value:ty),*) => {
        $(
            impl<S> RuleItems for HashMap<$key, $value, S> {
                fn each<'a>(&'a self, visit: &mut dyn FnMut(Option<MapKey<'a>>, RuleValue<'a>)) {
                    for (key, value) in self {
                        visit(Some(Key::key(key)), Item::value(value));
                    }
                }
            }
        )*

        impl<E: Enumeration, S> RuleItems for HashMap<$key, EnumValue<E>, S> {
            fn each<'a>(&'a self, visit: &mut dyn FnMut(Option<MapKey<'a>>, RuleValue<'a>)) {
                for (key, value) in self {
                    visit(Some(Key::key(key)), Item::value(value));
                }
            }
        }
    };
}

lists_of!(bool, i32, i64, u32, u64, f32, f64, String, Vec<u8>);

impl<E: Enumeration> RuleItems for Vec<EnumValue<E>> {
    fn each<'a>(&'a self, visit: &mut dyn FnMut(Option<MapKey<'a>>, RuleValue<'a>)) {
        for item in self {
            visit(None, Item::value(item));
        }
    }
}

maps_of!(bool: bool, i32, i64, u32, u64, f32, f64, String, Vec<u8>);
maps_of!(i32: bool, i32, i64, u32, u64, f32, f64, String, Vec<u8>);
maps_of!(i64: bool, i32, i64, u32, u64, f32, f64, String, Vec<u8>);
maps_of!(u32: bool, i32, i64, u32, u64, f32, f64, String, Vec<u8>);
maps_of!(u64: bool, i32, i64, u32, u64, f32, f64, String, Vec<u8>);
maps_of!(String: bool, i32, i64, u32, u64, f32, f64, String, Vec<u8>);
