//! A message read from its JSON by Bead's mapping (spec/transcoding.md 5.2 to 5.4): its members by
//! its fields, each by its JSON name or its proto name and never by both; `null` its field unset
//! but where it is a value of its own; each scalar and well-known type in its one form; a message
//! nested more than 100 deep refused before it is built; then a required field unset.

use std::collections::HashSet;
use std::sync::Arc;

use buffa::editions::{EnumType, FieldPresence};
use buffa_descriptor::reflect::{
    DynamicMessage, MapKey, MapValue, ReflectMessage, ReflectMessageMut, Value,
};
use buffa_descriptor::{
    DescriptorPool, EnumDescriptor, FieldDescriptor, FieldKind, MessageIndex, ScalarType,
    SingularKind,
};

use super::base64::bytes_of_base64;
use super::text::{Integer, Node, integer_of_digits, is_integer_text, is_number_text};
use super::wellknown::{Instant, read_duration, read_field_mask, read_timestamp};
use super::{
    At, MAXIMUM_DEPTH, Refusal, article_of, field_at, field_named, given_at, is_in_oneof,
    is_own_form, is_wrapper, item_at, nested_past, short_name,
};
use crate::records::ProtoSchema;
use crate::required::unset_of;

const NULL_VALUE: &str = "google.protobuf.NullValue";
const VALUE: &str = "google.protobuf.Value";

/// An integer scalar's type: its bounds, whether it holds 64 bits, and its name.
#[derive(Debug, Clone, Copy)]
pub(crate) struct IntegerType {
    pub(crate) least: i128,
    pub(crate) most: i128,
    pub(crate) is_64: bool,
    pub(crate) name: &'static str,
}

const INT32: (i128, i128) = (-(1 << 31), (1 << 31) - 1);
const UINT32: (i128, i128) = (0, (1 << 32) - 1);
const INT64: (i128, i128) = (-(1 << 63), (1 << 63) - 1);
const UINT64: (i128, i128) = (0, (1 << 64) - 1);

/// Each integer scalar's type; none for another scalar.
pub(crate) const fn integer_type_of(scalar: ScalarType) -> Option<IntegerType> {
    let ((least, most), is_64, name) = match scalar {
        ScalarType::Int32 => (INT32, false, "int32"),
        ScalarType::Sint32 => (INT32, false, "sint32"),
        ScalarType::Sfixed32 => (INT32, false, "sfixed32"),
        ScalarType::Uint32 => (UINT32, false, "uint32"),
        ScalarType::Fixed32 => (UINT32, false, "fixed32"),
        ScalarType::Int64 => (INT64, true, "int64"),
        ScalarType::Sint64 => (INT64, true, "sint64"),
        ScalarType::Sfixed64 => (INT64, true, "sfixed64"),
        ScalarType::Uint64 => (UINT64, true, "uint64"),
        ScalarType::Fixed64 => (UINT64, true, "fixed64"),
        ScalarType::Double
        | ScalarType::Float
        | ScalarType::Bool
        | ScalarType::String
        | ScalarType::Bytes => return None,
    };

    Some(IntegerType {
        least,
        most,
        is_64,
        name,
    })
}

// an integer's value as its scalar holds it, its bounds checked before
fn integer_value(scalar: ScalarType, integer: i128) -> Option<Value> {
    match scalar {
        ScalarType::Int32 | ScalarType::Sint32 | ScalarType::Sfixed32 => {
            i32::try_from(integer).ok().map(Value::I32)
        }
        ScalarType::Uint32 | ScalarType::Fixed32 => u32::try_from(integer).ok().map(Value::U32),
        ScalarType::Int64 | ScalarType::Sint64 | ScalarType::Sfixed64 => {
            i64::try_from(integer).ok().map(Value::I64)
        }
        ScalarType::Uint64 | ScalarType::Fixed64 => u64::try_from(integer).ok().map(Value::U64),
        ScalarType::Double
        | ScalarType::Float
        | ScalarType::Bool
        | ScalarType::String
        | ScalarType::Bytes => None,
    }
}

// the float nearest a double, as ECMAScript's Math.fround rounds it
#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    reason = "a float field holds the double read rounded to its nearest float, ties to even"
)]
const fn float_of(value: f64) -> f32 {
    value as f32
}

/// A scalar's value of `node`, read as 5.3 pins its type's forms.
#[expect(
    clippy::too_many_lines,
    reason = "each scalar's forms in 5.3's order, as the other sides hold them"
)]
pub(crate) fn read_scalar(scalar: ScalarType, (node, at): (&Node, &At)) -> Result<Value, Refusal> {
    if let Some(integer) = integer_type_of(scalar) {
        let IntegerType {
            least,
            most,
            is_64,
            name,
        } = integer;
        let article = article_of(name);
        let no_integer = || Refusal::new(format!("{article} {name} that is no integer")).at(at);
        let read = match node {
            Node::Number { text, .. } => match integer_of_digits(text) {
                Integer::Fraction => return Err(no_integer()),
                read @ (Integer::Of(_) | Integer::Past) => read,
            },
            Node::String(text) if is_64 => {
                if !is_integer_text(text) {
                    return Err(Refusal::new(format!(
                        "{article} {name} string off -?(0|[1-9][0-9]*)"
                    ))
                    .at(at));
                }

                integer_of_digits(text)
            }
            Node::String(text) if is_number_text(text) => match integer_of_digits(text) {
                Integer::Fraction => return Err(no_integer()),
                read @ (Integer::Of(_) | Integer::Past) => read,
            },
            Node::Array(_) | Node::Bool(_) | Node::Null | Node::Object(_) | Node::String(_) => {
                return Err(Refusal::new(format!("no {name}")).at(at));
            }
        };

        return match read {
            Integer::Of(value) if (least..=most).contains(&value) => {
                integer_value(scalar, value).ok_or_else(|| Refusal::new("no integer").at(at))
            }
            Integer::Of(_) | Integer::Past | Integer::Fraction => {
                Err(Refusal::new(format!("{article} {name} past its range")).at(at))
            }
        };
    }

    match scalar {
        ScalarType::Double | ScalarType::Float => {
            let is_float = scalar == ScalarType::Float;
            let name = if is_float { "float" } else { "double" };
            let value = match node {
                Node::Number { value, .. } => *value,
                Node::String(text) if is_number_text(text) => {
                    let value = text.parse::<f64>().unwrap_or(f64::INFINITY);

                    if !value.is_finite() {
                        return Err(Refusal::new(format!("a {name} past its range")).at(at));
                    }

                    value
                }
                Node::String(text) if text == "Infinity" => f64::INFINITY,
                Node::String(text) if text == "-Infinity" => f64::NEG_INFINITY,
                Node::String(text) if text == "NaN" => f64::NAN,
                Node::Array(_) | Node::Bool(_) | Node::Null | Node::Object(_) | Node::String(_) => {
                    return Err(Refusal::new(format!("no {name}")).at(at));
                }
            };

            if !is_float {
                return Ok(Value::F64(value));
            }

            let float = float_of(value);

            if value.is_finite() && !float.is_finite() {
                return Err(Refusal::new("a float past its range").at(at));
            }

            Ok(Value::F32(float))
        }
        ScalarType::Bool => match node {
            Node::Bool(value) => Ok(Value::Bool(*value)),
            Node::Array(_)
            | Node::Null
            | Node::Number { .. }
            | Node::Object(_)
            | Node::String(_) => Err(Refusal::new("no bool").at(at)),
        },
        ScalarType::String => match node {
            Node::String(value) => Ok(Value::String(value.clone())),
            Node::Array(_) | Node::Bool(_) | Node::Null | Node::Number { .. } | Node::Object(_) => {
                Err(Refusal::new("no string").at(at))
            }
        },
        ScalarType::Bytes
        | ScalarType::Int32
        | ScalarType::Sint32
        | ScalarType::Sfixed32
        | ScalarType::Uint32
        | ScalarType::Fixed32
        | ScalarType::Int64
        | ScalarType::Sint64
        | ScalarType::Sfixed64
        | ScalarType::Uint64
        | ScalarType::Fixed64 => match node {
            Node::String(text) => bytes_of_base64(text)
                .map(Value::Bytes)
                .map_err(|refused| Refusal::new(refused.reason()).at(at)),
            Node::Array(_) | Node::Bool(_) | Node::Null | Node::Number { .. } | Node::Object(_) => {
                Err(Refusal::new("no bytes").at(at))
            }
        },
    }
}

/// An enum's number of `node`: one of its values' names, or a number its values or its openness
/// take.
fn read_enum(descriptor: &EnumDescriptor, (node, at): (&Node, &At)) -> Result<i32, Refusal> {
    let name = short_name(descriptor.full_name());

    match node {
        Node::Null if descriptor.full_name() == NULL_VALUE => Ok(0),
        Node::String(text) => descriptor
            .value_by_name(text)
            .map(buffa_descriptor::EnumValueDescriptor::number)
            .ok_or_else(|| Refusal::new(format!("no value of {name} of that name")).at(at)),
        Node::Number { text, .. } => {
            let number = match integer_of_digits(text) {
                Integer::Fraction => {
                    return Err(Refusal::new("an enum number that is no integer").at(at));
                }
                Integer::Of(value) => i32::try_from(value).ok(),
                Integer::Past => None,
            }
            .ok_or_else(|| Refusal::new("an enum number past its range").at(at))?;

            if descriptor.enum_type() == EnumType::Closed && descriptor.value(number).is_none() {
                return Err(Refusal::new(format!("no value of {name} of that number")).at(at));
            }

            Ok(number)
        }
        Node::Array(_) | Node::Bool(_) | Node::Null | Node::Object(_) => {
            Err(Refusal::new(format!("no {name}")).at(at))
        }
    }
}

/// A map's key of its member's name, its value canonical (5.3.8).
fn read_map_key(scalar: ScalarType, (key, at): (&str, &At)) -> Result<MapKey, Refusal> {
    match scalar {
        ScalarType::String => return Ok(MapKey::String(key.to_owned())),
        ScalarType::Bool => {
            return match key {
                "true" => Ok(MapKey::Bool(true)),
                "false" => Ok(MapKey::Bool(false)),
                _ => Err(Refusal::new("a bool key that is neither true nor false").at(at)),
            };
        }
        ScalarType::Double
        | ScalarType::Float
        | ScalarType::Bytes
        | ScalarType::Int32
        | ScalarType::Sint32
        | ScalarType::Sfixed32
        | ScalarType::Uint32
        | ScalarType::Fixed32
        | ScalarType::Int64
        | ScalarType::Sint64
        | ScalarType::Sfixed64
        | ScalarType::Uint64
        | ScalarType::Fixed64 => {}
    }

    let integer = integer_type_of(scalar);
    let name = integer.map_or("integer", |integer| integer.name);
    let article = article_of(name);
    let off = || Refusal::new(format!("{article} {name} key off -?(0|[1-9][0-9]*)")).at(at);
    let past = || Refusal::new(format!("{article} {name} key past its range")).at(at);
    let Some(integer) = integer.filter(|_| is_integer_text(key)) else {
        return Err(off());
    };
    let value = match integer_of_digits(key) {
        Integer::Of(value) if (integer.least..=integer.most).contains(&value) => value,
        Integer::Of(_) | Integer::Past | Integer::Fraction => return Err(past()),
    };

    match integer_value(scalar, value).ok_or_else(past)? {
        Value::I32(key) => Ok(MapKey::I32(key)),
        Value::U32(key) => Ok(MapKey::U32(key)),
        Value::I64(key) => Ok(MapKey::I64(key)),
        Value::U64(key) => Ok(MapKey::U64(key)),
        Value::Bool(_)
        | Value::F32(_)
        | Value::F64(_)
        | Value::String(_)
        | Value::Bytes(_)
        | Value::EnumNumber(_)
        | Value::Message(_)
        | Value::List(_)
        | Value::Map(_) => Err(past()),
    }
}

/// A reading: the pool its messages are of, the schema whose shapes judge a required field, and
/// where and how deep it stands.
#[derive(Clone)]
pub(crate) struct Reading<'a> {
    pub(crate) pool: &'a Arc<DescriptorPool>,
    pub(crate) at: At,
    pub(crate) depth: u32,
}

impl Reading<'_> {
    fn deeper(&self, by: u32) -> Self {
        Self {
            pool: self.pool,
            at: self.at.clone(),
            depth: self.depth.saturating_add(by),
        }
    }

    fn placed(&self, at: At) -> Self {
        Self {
            pool: self.pool,
            at,
            depth: self.depth,
        }
    }
}

// throws where a message `depth` below the one read would be built past 17.9.3's bound
fn assert_depth(depth: u32, at: &At) -> Result<(), Refusal> {
    if depth > MAXIMUM_DEPTH {
        return Err(nested_past().at(at));
    }

    Ok(())
}

// whether a `null` given for a value of the field is a value of its own (5.2.2)
fn is_null_itself(pool: &DescriptorPool, field: &FieldDescriptor) -> bool {
    let held = match field.kind() {
        FieldKind::Singular(kind) | FieldKind::List(kind) | FieldKind::Map { value: kind, .. } => {
            kind
        }
    };

    match held {
        SingularKind::Message(index) => pool.message(index).full_name() == VALUE,
        SingularKind::Enum(index) => pool.enumeration(index).full_name() == NULL_VALUE,
        SingularKind::Scalar(_) => false,
    }
}

// a value of `kind`, one item of a field where it is repeated or a map (5.2.2, 5.2.3)
fn read_value_of(
    kind: SingularKind,
    (node, reading): (&Node, &Reading<'_>),
) -> Result<Value, Refusal> {
    match kind {
        SingularKind::Message(index) => {
            read_message_at(index, (node, &reading.deeper(1))).map(Value::Message)
        }
        SingularKind::Enum(index) => {
            read_enum(reading.pool.enumeration(index), (node, &reading.at)).map(Value::EnumNumber)
        }
        SingularKind::Scalar(scalar) => read_scalar(scalar, (node, &reading.at)),
    }
}

// whether a scalar's or an enum's value is its default, which a field of no presence of its own
// leaves unwritten
fn is_default(value: &Value) -> bool {
    match value {
        Value::Bool(value) => !value,
        Value::I32(value) | Value::EnumNumber(value) => *value == 0,
        Value::I64(value) => *value == 0,
        Value::U32(value) => *value == 0,
        Value::U64(value) => *value == 0,
        Value::F32(value) => value.classify() == core::num::FpCategory::Zero,
        Value::F64(value) => value.classify() == core::num::FpCategory::Zero,
        Value::String(value) => value.is_empty(),
        Value::Bytes(value) => value.is_empty(),
        Value::Message(_) | Value::List(_) | Value::Map(_) => false,
    }
}

// sets `field` of `message` to `value`; refused where the field holds no value of its kind, which
// the reading never builds
pub(crate) fn put(
    message: &mut DynamicMessage,
    (field, value): (&FieldDescriptor, Value),
) -> Result<(), Refusal> {
    message.try_set(field, value).map_err(|refused| {
        Refusal::new(format!("a value its field's type holds none of: {refused}"))
    })
}

// sets `field` of `message` to `value`, a field of no presence of its own left unset at its
// default, as protobuf's writers leave it unwritten
fn set(
    message: &mut DynamicMessage,
    (field, value): (&FieldDescriptor, Value),
) -> Result<(), Refusal> {
    let is_implicit = field.presence() == FieldPresence::Implicit
        && matches!(
            field.kind(),
            FieldKind::Singular(SingularKind::Scalar(_) | SingularKind::Enum(_))
        );

    if is_implicit && !is_in_oneof(message.message_descriptor(), field) && is_default(&value) {
        return Ok(());
    }

    put(message, (field, value))
}

// a message of `index` with its first field set to `value`: a well-known type of its own form
fn holding(
    pool: &Arc<DescriptorPool>,
    (index, values): (MessageIndex, Vec<(u32, Value)>),
) -> Result<DynamicMessage, Refusal> {
    let mut message = DynamicMessage::new(Arc::clone(pool), index);

    for (number, value) in values {
        if let Some(field) = pool.message(index).field(number) {
            set(&mut message, (field, value))?;
        }
    }

    Ok(message)
}

fn read_instant(
    reading: &Reading<'_>,
    (index, instant): (MessageIndex, Instant),
) -> Result<DynamicMessage, Refusal> {
    holding(
        reading.pool,
        (
            index,
            vec![
                (1, Value::I64(instant.seconds)),
                (2, Value::I32(instant.nanos)),
            ],
        ),
    )
}

/// A `google.protobuf.Value` of `node`: JSON itself, a number a double's (5.4.5).
fn read_value_message(
    index: MessageIndex,
    (node, reading): (&Node, &Reading<'_>),
) -> Result<DynamicMessage, Refusal> {
    assert_depth(reading.depth, &reading.at)?;

    let pool = reading.pool;
    let descriptor = pool.message(index);
    let held_of = |number: u32| match descriptor.field(number).map(FieldDescriptor::kind) {
        Some(FieldKind::Singular(SingularKind::Message(held))) => Some(held),
        Some(_) | None => None,
    };
    let below = reading.deeper(1);
    let (number, value) = match node {
        Node::Null => (1, Value::EnumNumber(0)),
        Node::Number { value, .. } => (2, Value::F64(*value)),
        Node::String(value) => (3, Value::String(value.clone())),
        Node::Bool(value) => (4, Value::Bool(*value)),
        Node::Object(_) => {
            let held = held_of(5).ok_or_else(|| Refusal::new("a Value of no Struct"))?;

            (5, Value::Message(read_struct(held, (node, &below))?))
        }
        Node::Array(_) => {
            let held = held_of(6).ok_or_else(|| Refusal::new("a Value of no ListValue"))?;

            (6, Value::Message(read_list_value(held, (node, &below))?))
        }
    };
    let mut message = DynamicMessage::new(Arc::clone(pool), index);

    if let Some(field) = descriptor.field(number) {
        put(&mut message, (field, value))?;
    }

    Ok(message)
}

fn read_struct(
    index: MessageIndex,
    (node, reading): (&Node, &Reading<'_>),
) -> Result<DynamicMessage, Refusal> {
    assert_depth(reading.depth, &reading.at)?;

    let Node::Object(members) = node else {
        return Err(Refusal::new("a Struct that is no object").at(&reading.at));
    };

    // * its members are a map's entries, messages below it, counted before any is read
    if !members.is_empty() {
        assert_depth(reading.depth.saturating_add(1), &reading.at)?;
    }

    let pool = reading.pool;
    let descriptor = pool.message(index);
    let Some(fields) = descriptor.field(1) else {
        return Err(Refusal::new("a Struct of no fields"));
    };
    let FieldKind::Map {
        value: SingularKind::Message(value_index),
        ..
    } = fields.kind()
    else {
        return Err(Refusal::new("a Struct of no fields"));
    };
    let mut entries = Vec::with_capacity(members.len());

    for (name, member) in members {
        // * a member is a map's entry, a message below the Struct, and its Value one below that
        let value = read_value_message(
            value_index,
            (
                member,
                &Reading {
                    pool,
                    at: given_at(&reading.at, name),
                    depth: reading.depth.saturating_add(2),
                },
            ),
        )?;

        entries.push((MapKey::String(name.clone()), Value::Message(value)));
    }

    let mut message = DynamicMessage::new(Arc::clone(pool), index);

    if !entries.is_empty() {
        put(
            &mut message,
            (fields, Value::Map(MapValue::from_entries(entries))),
        )?;
    }

    Ok(message)
}

fn read_list_value(
    index: MessageIndex,
    (node, reading): (&Node, &Reading<'_>),
) -> Result<DynamicMessage, Refusal> {
    assert_depth(reading.depth, &reading.at)?;

    let Node::Array(items) = node else {
        return Err(Refusal::new("a ListValue that is no array").at(&reading.at));
    };
    let pool = reading.pool;
    let descriptor = pool.message(index);
    let Some(values) = descriptor.field(1) else {
        return Err(Refusal::new("a ListValue of no values"));
    };
    let FieldKind::List(SingularKind::Message(value_index)) = values.kind() else {
        return Err(Refusal::new("a ListValue of no values"));
    };
    let mut read = Vec::with_capacity(items.len());

    for (at, item) in items.iter().enumerate() {
        read.push(Value::Message(read_value_message(
            value_index,
            (
                item,
                &Reading {
                    pool,
                    at: item_at(&reading.at, at),
                    depth: reading.depth.saturating_add(1),
                },
            ),
        )?));
    }

    let mut message = DynamicMessage::new(Arc::clone(pool), index);

    if !read.is_empty() {
        put(&mut message, (values, Value::List(read)))?;
    }

    Ok(message)
}

/// An `Any` of `node`: its `@type`, a message of the pool, then that message's members (5.4.6).
fn read_any(
    index: MessageIndex,
    (node, reading): (&Node, &Reading<'_>),
) -> Result<DynamicMessage, Refusal> {
    let at = &reading.at;
    let Node::Object(members) = node else {
        return Err(Refusal::new("an Any that is no object").at(at));
    };
    let pool = reading.pool;

    if members.is_empty() {
        return Ok(DynamicMessage::new(Arc::clone(pool), index));
    }

    let Some((_, type_node)) = members.iter().find(|(name, _)| name == "@type") else {
        return Err(Refusal::new("an Any without its @type").at(at));
    };
    let Node::String(type_url) = type_node else {
        return Err(Refusal::new("an Any whose @type is no URL").at(at));
    };
    let Some((_, type_name)) = type_url.rsplit_once('/') else {
        return Err(Refusal::new("an Any whose @type is no URL").at(at));
    };
    let Some(held) = pool.message_index(type_name) else {
        return Err(Refusal::new("an Any of a type its definitions do not hold").at(at));
    };
    let rest: Vec<(String, Node)> = members
        .iter()
        .filter(|(name, _)| name != "@type")
        .cloned()
        .collect();
    let below = reading.deeper(1);
    let message = if is_own_form(type_name) {
        let [(name, value)] = rest.as_slice() else {
            return Err(Refusal::new(
                "an Any of a well-known type whose members are not its value alone",
            )
            .at(at));
        };

        if name != "value" {
            return Err(Refusal::new(
                "an Any of a well-known type whose members are not its value alone",
            )
            .at(at));
        }

        read_message_at(held, (value, &below.placed(field_at(at, "value"))))?
    } else {
        read_message_at(held, (&Node::Object(rest), &below))?
    };
    // * written as it holds it, a required field unset among it: 17.9.7 does not look into an Any
    let bytes = message
        .try_encode_to_vec()
        .map_err(|_unwritten| Refusal::new("an Any that cannot be written").at(at))?;

    holding(
        pool,
        (
            index,
            vec![
                (1, Value::String(type_url.clone())),
                (2, Value::Bytes(bytes)),
            ],
        ),
    )
}

/// The well-known type `index` of `node`, by its own form; none for one read as any message.
fn read_well_known(
    index: MessageIndex,
    (node, reading): (&Node, &Reading<'_>),
) -> Option<Result<DynamicMessage, Refusal>> {
    let descriptor = reading.pool.message(index);
    let at = &reading.at;
    let string = || match node {
        Node::String(text) => Some(text.as_str()),
        Node::Array(_) | Node::Bool(_) | Node::Null | Node::Number { .. } | Node::Object(_) => None,
    };

    Some(match descriptor.full_name() {
        "google.protobuf.Timestamp" => string()
            .ok_or("a Timestamp that is no string")
            .and_then(read_timestamp)
            .map_err(|reason| Refusal::new(reason).at(at))
            .and_then(|instant| read_instant(reading, (index, instant))),
        "google.protobuf.Duration" => string()
            .ok_or("a Duration off its form")
            .and_then(read_duration)
            .map_err(|reason| Refusal::new(reason).at(at))
            .and_then(|instant| read_instant(reading, (index, instant))),
        "google.protobuf.FieldMask" => string()
            .ok_or("a FieldMask that is no string")
            .and_then(read_field_mask)
            .map_err(|reason| Refusal::new(reason).at(at))
            .and_then(|paths| {
                let values = if paths.is_empty() {
                    vec![]
                } else {
                    vec![(
                        1,
                        Value::List(paths.into_iter().map(Value::String).collect()),
                    )]
                };

                holding(reading.pool, (index, values))
            }),
        "google.protobuf.Struct" => read_struct(index, (node, reading)),
        "google.protobuf.Value" => read_value_message(index, (node, reading)),
        "google.protobuf.ListValue" => read_list_value(index, (node, reading)),
        "google.protobuf.Any" => read_any(index, (node, reading)),
        _ if is_wrapper(descriptor) => {
            let field = descriptor.fields().first()?;
            let FieldKind::Singular(SingularKind::Scalar(scalar)) = field.kind() else {
                return None;
            };

            read_scalar(scalar, (node, at))
                .and_then(|value| holding(reading.pool, (index, vec![(1, value)])))
        }
        _ => return None,
    })
}

/// A message of `index` of `node`, `reading.depth` below the one read (5.2.2 to 5.2.4).
pub(crate) fn read_message_at(
    index: MessageIndex,
    (node, reading): (&Node, &Reading<'_>),
) -> Result<DynamicMessage, Refusal> {
    let at = &reading.at;

    assert_depth(reading.depth, at)?;

    if let Some(well_known) = read_well_known(index, (node, reading)) {
        return well_known;
    }

    let pool = reading.pool;
    let descriptor = pool.message(index);
    let Node::Object(members) = node else {
        let name = short_name(descriptor.full_name());

        return Err(Refusal::new(format!("{} {name} that is no object", article_of(name))).at(at));
    };
    let mut message = DynamicMessage::new(Arc::clone(pool), index);
    // the fields named so far, by their numbers; each oneof's member set, by its index
    let mut named = HashSet::new();
    let mut chosen = HashSet::new();

    for (name, value) in members {
        let Some(field) = field_named(descriptor, name) else {
            return Err(Refusal::new("a key no field names").at(&given_at(at, name)));
        };
        let here = field_at(at, field.json_name());

        if !named.insert(field.number()) {
            return Err(Refusal::new("a field by its two names").at(&here));
        }

        let below = reading.placed(here.clone());

        match field.kind() {
            FieldKind::List(kind) => {
                if matches!(value, Node::Null) {
                    continue;
                }

                let Node::Array(items) = value else {
                    return Err(Refusal::new("a repeated field that is no array").at(&here));
                };
                let mut list = Vec::with_capacity(items.len());

                for (index, item) in items.iter().enumerate() {
                    let item_here = item_at(&here, index);

                    if matches!(item, Node::Null) && !is_null_itself(pool, field) {
                        return Err(Refusal::new("a null item").at(&item_here));
                    }

                    list.push(read_value_of(kind, (item, &below.placed(item_here)))?);
                }

                if !list.is_empty() {
                    put(&mut message, (field, Value::List(list)))?;
                }
            }
            FieldKind::Map { key, value: kind } => {
                if matches!(value, Node::Null) {
                    continue;
                }

                let Node::Object(entries) = value else {
                    return Err(Refusal::new("a map that is no object").at(&here));
                };

                if !entries.is_empty() {
                    assert_depth(reading.depth.saturating_add(1), &here)?;
                }

                let mut keys = HashSet::new();
                let mut map = Vec::with_capacity(entries.len());

                for (text, item) in entries {
                    let key_here = given_at(&here, text);
                    let read = read_map_key(key, (text, &key_here))?;

                    if !keys.insert(read.clone()) {
                        return Err(Refusal::new("two keys of one value").at(&key_here));
                    }

                    if matches!(item, Node::Null) && !is_null_itself(pool, field) {
                        return Err(Refusal::new("a null value in a map").at(&key_here));
                    }

                    // * the entry is a message below this one, and its value one below the entry
                    let entry = Reading {
                        pool,
                        at: key_here,
                        depth: reading.depth.saturating_add(1),
                    };

                    map.push((read, read_value_of(kind, (item, &entry))?));
                }

                if !map.is_empty() {
                    put(
                        &mut message,
                        (field, Value::Map(MapValue::from_entries(map))),
                    )?;
                }
            }
            FieldKind::Singular(kind) => {
                // * null leaves its field unset, but where it is a value of its own
                if matches!(value, Node::Null) && !is_null_itself(pool, field) {
                    continue;
                }

                let read = read_value_of(kind, (value, &below))?;

                if is_in_oneof(descriptor, field) {
                    if let Some(oneof) = field.oneof_index()
                        && !chosen.insert(oneof)
                    {
                        return Err(Refusal::new("two members of one oneof").at(&here));
                    }

                    put(&mut message, (field, read))?;
                } else {
                    set(&mut message, (field, read))?;
                }
            }
        }
    }

    Ok(message)
}

/// The reason of step 4 (transcoding 5.2), which names no member or key of the request.
const UNSET: &str = "a required field unset";

/// Step 4 of transcoding 5.2, spec 17.9.7's walk over `message`, a message read whole: the first
/// field of `LEGACY_REQUIRED` presence it leaves unset refused, at the member its object lacks, by
/// JSON names, an item by its index and a map's value by its key. An `Any`'s message is not looked
/// into.
pub(crate) fn judge_unset(message: &DynamicMessage, schema: &ProtoSchema) -> Result<(), Refusal> {
    let Some(unset) = unset_of(message, schema) else {
        return Ok(());
    };
    let mut at = At::default();

    for step in unset.steps() {
        at = field_at(&at, step.field().json_name());
        at = match step.place() {
            crate::required::Place::Field => at,
            crate::required::Place::Index(index) => item_at(&at, *index),
            crate::required::Place::Key(key) => given_at(&at, &key_text(key)),
        };
    }

    at = field_at(&at, unset.field().json_name());

    Err(Refusal::new(UNSET).unset().at(&at))
}

// a map's key as its JSON member names it
fn key_text(key: &MapKey) -> String {
    match key {
        MapKey::Bool(key) => key.to_string(),
        MapKey::I32(key) => key.to_string(),
        MapKey::I64(key) => key.to_string(),
        MapKey::U32(key) => key.to_string(),
        MapKey::U64(key) => key.to_string(),
        MapKey::String(key) => key.clone(),
    }
}

/// A message of `schema` of `node`, read by steps 2 and 3 alone: a binding sets its mask before
/// step 4.
pub(crate) fn read_draft(schema: &ProtoSchema, node: &Node) -> Result<DynamicMessage, Refusal> {
    read_message_at(
        schema.message(),
        (
            node,
            &Reading {
                pool: schema.pool(),
                at: At::default(),
                depth: 0,
            },
        ),
    )
}

/// A message of `schema` of `node`, read by Bead's mapping (transcoding 5.2, items 2 to 4).
pub(crate) fn read_message(schema: &ProtoSchema, node: &Node) -> Result<DynamicMessage, Refusal> {
    let message = read_draft(schema, node)?;

    judge_unset(&message, schema)?;

    Ok(message)
}
