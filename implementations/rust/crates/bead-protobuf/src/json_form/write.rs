//! A message written in Bead's proto JSON form (spec/transcoding.md 5.6 to 5.8): its members by JSON
//! name in their fields' numbers' order, a map's entries and a `Struct`'s members sorted by UTF-16
//! code units, an aliased enum by its first name, a `float` at its shortest, each well-known type
//! in its form; what the form holds none of refused (5.7), which a gateway answers 500.

use std::sync::Arc;

use buffa_descriptor::reflect::{
    DynamicMessage, MapKey, MapKeyRef, ReflectList, ReflectMap, ReflectMessage, ValueRef,
};
use buffa_descriptor::{FieldDescriptor, FieldKind, ScalarType, SingularKind};

use super::base64::base64_of;
use super::read::integer_type_of;
use super::text::{double_text, float_text, string_json};
use super::wellknown::{Instant, duration_json, field_mask_json, timestamp_json};
use super::{MAXIMUM_DEPTH, Refusal, is_own_form, is_wrapper};
use crate::codec::decode_options;
use crate::records::{ProtoSchema, filtered};

const NULL_VALUE: &str = "google.protobuf.NullValue";

/// What a writing carries down a message: the schema whose pool an `Any` names a message of, and
/// how deep it stands.
#[derive(Clone, Copy)]
struct Writing<'a> {
    schema: &'a ProtoSchema,
    depth: u32,
}

impl Writing<'_> {
    fn deeper(self, by: u32) -> Self {
        Self {
            schema: self.schema,
            depth: self.depth.saturating_add(by),
        }
    }
}

fn nested_past() -> Refusal {
    Refusal::new(format!("a message nested past {MAXIMUM_DEPTH}"))
}

fn assert_depth(depth: u32) -> Result<(), Refusal> {
    if depth > MAXIMUM_DEPTH {
        return Err(nested_past());
    }

    Ok(())
}

// a double's or a float's JSON (5.6.1, 5.6.6): its token, `"NaN"` and the infinities as strings
fn non_finite(value: f64) -> Option<&'static str> {
    if value.is_nan() {
        Some("\"NaN\"")
    } else if value.is_infinite() {
        Some(if value > 0.0 {
            "\"Infinity\""
        } else {
            "\"-Infinity\""
        })
    } else if value.classify() == core::num::FpCategory::Zero {
        Some("0")
    } else {
        None
    }
}

/// A scalar's JSON (5.6.1, 5.6.6).
fn scalar_json(value: &ValueRef<'_>) -> Option<String> {
    Some(match value {
        ValueRef::F64(value) => {
            non_finite(*value).map_or_else(|| double_text(*value), ToOwned::to_owned)
        }
        ValueRef::F32(value) => {
            non_finite(f64::from(*value)).map_or_else(|| float_text(*value), ToOwned::to_owned)
        }
        ValueRef::Bool(value) => value.to_string(),
        ValueRef::String(value) => string_json(value),
        ValueRef::Bytes(value) => format!("\"{}\"", base64_of(value)),
        ValueRef::I64(value) => format!("\"{value}\""),
        ValueRef::U64(value) => format!("\"{value}\""),
        ValueRef::I32(value) => value.to_string(),
        ValueRef::U32(value) => value.to_string(),
        ValueRef::EnumNumber(_) | ValueRef::Message(_) | ValueRef::List(_) | ValueRef::Map(_) => {
            return None;
        }
    })
}

// a field's scalar that holds no value of its own: none of what its kind writes
fn no_form() -> Refusal {
    Refusal::new("a value its field's type holds none of")
}

/// An enum's JSON: the name of its value declared first for its number, or its number (5.6.5).
fn enum_json(writing: Writing<'_>, (index, number): (buffa_descriptor::EnumIndex, i32)) -> String {
    let descriptor = writing.schema.pool().enumeration(index);

    if descriptor.full_name() == NULL_VALUE {
        return "null".to_owned();
    }

    descriptor
        .values()
        .iter()
        .find(|value| value.number() == number)
        .map_or_else(|| number.to_string(), |value| string_json(value.name()))
}

// a message's field `number`'s value, its default where it holds none
fn int_field(message: &dyn ReflectMessage, number: u32) -> i64 {
    message
        .message_descriptor()
        .field(number)
        .map_or(0, |field| match message.get(field) {
            ValueRef::I64(value) => value,
            ValueRef::I32(value) => i64::from(value),
            ValueRef::Bool(_)
            | ValueRef::U32(_)
            | ValueRef::U64(_)
            | ValueRef::F32(_)
            | ValueRef::F64(_)
            | ValueRef::String(_)
            | ValueRef::Bytes(_)
            | ValueRef::EnumNumber(_)
            | ValueRef::Message(_)
            | ValueRef::List(_)
            | ValueRef::Map(_) => 0,
        })
}

fn instant_of(message: &dyn ReflectMessage) -> Instant {
    Instant {
        seconds: int_field(message, 1),
        nanos: i32::try_from(int_field(message, 2)).unwrap_or(i32::MAX),
    }
}

// a message's field `number`, where it has it
fn field_of(message: &dyn ReflectMessage, number: u32) -> Option<&FieldDescriptor> {
    message.message_descriptor().field(number)
}

// each item of a list, in its order
fn items_of(list: &dyn ReflectList) -> impl Iterator<Item = ValueRef<'_>> + '_ {
    (0..list.len()).filter_map(move |index| list.get(index))
}

// a map's keys as its JSON members name them, sorted by UTF-16 code units, each with its key
fn sorted_keys(map: &dyn ReflectMap) -> Vec<(String, MapKey)> {
    let mut keys = Vec::with_capacity(map.len());

    map.for_each(&mut |key, _| {
        let text = match key {
            MapKeyRef::Bool(key) => key.to_string(),
            MapKeyRef::I32(key) => key.to_string(),
            MapKeyRef::I64(key) => key.to_string(),
            MapKeyRef::U32(key) => key.to_string(),
            MapKeyRef::U64(key) => key.to_string(),
            MapKeyRef::String(key) => key.to_owned(),
        };

        keys.push((text, key.to_owned()));
    });
    keys.sort_by(|(one, _), (other, _)| one.encode_utf16().cmp(other.encode_utf16()));
    keys
}

fn value_json(message: &dyn ReflectMessage, writing: Writing<'_>) -> Result<String, Refusal> {
    assert_depth(writing.depth)?;

    let below = writing.deeper(1);

    for number in 1..=6 {
        let Some(field) = field_of(message, number) else {
            continue;
        };

        if !message.has(field) {
            continue;
        }

        return match (number, message.get(field)) {
            (1, _) => Ok("null".to_owned()),
            (2, ValueRef::F64(value)) => {
                if !value.is_finite() {
                    return Err(Refusal::new("a Value whose number is not finite"));
                }

                Ok(non_finite(value).map_or_else(|| double_text(value), ToOwned::to_owned))
            }
            (3, ValueRef::String(value)) => Ok(string_json(value)),
            (4, ValueRef::Bool(value)) => Ok(value.to_string()),
            (5, ValueRef::Message(held)) => struct_json(&*held, below),
            (6, ValueRef::Message(held)) => list_value_json(&*held, below),
            _ => Err(no_form()),
        };
    }

    Err(Refusal::new("a Value that holds no kind"))
}

fn struct_json(message: &dyn ReflectMessage, writing: Writing<'_>) -> Result<String, Refusal> {
    assert_depth(writing.depth)?;

    let Some(fields) = field_of(message, 1) else {
        return Ok("{}".to_owned());
    };
    let ValueRef::Map(map) = message.get(fields) else {
        return Ok("{}".to_owned());
    };
    // * a member is a map's entry, a message below the Struct, and its Value one below that
    let below = writing.deeper(2);
    let mut members = Vec::with_capacity(map.len());

    for (name, key) in sorted_keys(map) {
        let Some(ValueRef::Message(value)) = map.get(&key) else {
            return Err(Refusal::new("a Value that holds no kind"));
        };

        members.push(format!(
            "{}:{}",
            string_json(&name),
            value_json(&*value, below)?
        ));
    }

    Ok(format!("{{{}}}", members.join(",")))
}

fn list_value_json(message: &dyn ReflectMessage, writing: Writing<'_>) -> Result<String, Refusal> {
    assert_depth(writing.depth)?;

    let Some(values) = field_of(message, 1) else {
        return Ok("[]".to_owned());
    };
    let ValueRef::List(list) = message.get(values) else {
        return Ok("[]".to_owned());
    };
    let below = writing.deeper(1);
    let items = items_of(list)
        .map(|item| match item {
            ValueRef::Message(value) => value_json(&*value, below),
            ValueRef::Bool(_)
            | ValueRef::I32(_)
            | ValueRef::I64(_)
            | ValueRef::U32(_)
            | ValueRef::U64(_)
            | ValueRef::F32(_)
            | ValueRef::F64(_)
            | ValueRef::String(_)
            | ValueRef::Bytes(_)
            | ValueRef::EnumNumber(_)
            | ValueRef::List(_)
            | ValueRef::Map(_) => Err(no_form()),
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(format!("[{}]", items.join(",")))
}

/// An `Any`'s JSON: `@type` first, then its message's members or its `value` (5.6.2, 5.6.7).
fn any_json(message: &dyn ReflectMessage, writing: Writing<'_>) -> Result<String, Refusal> {
    let type_url =
        field_of(message, 1).map_or_else(String::new, |field| match message.get(field) {
            ValueRef::String(text) => text.to_owned(),
            ValueRef::Bool(_)
            | ValueRef::I32(_)
            | ValueRef::I64(_)
            | ValueRef::U32(_)
            | ValueRef::U64(_)
            | ValueRef::F32(_)
            | ValueRef::F64(_)
            | ValueRef::Bytes(_)
            | ValueRef::EnumNumber(_)
            | ValueRef::Message(_)
            | ValueRef::List(_)
            | ValueRef::Map(_) => String::new(),
        });
    let value = field_of(message, 2).map_or_else(Vec::new, |field| match message.get(field) {
        ValueRef::Bytes(bytes) => bytes.to_vec(),
        ValueRef::Bool(_)
        | ValueRef::I32(_)
        | ValueRef::I64(_)
        | ValueRef::U32(_)
        | ValueRef::U64(_)
        | ValueRef::F32(_)
        | ValueRef::F64(_)
        | ValueRef::String(_)
        | ValueRef::EnumNumber(_)
        | ValueRef::Message(_)
        | ValueRef::List(_)
        | ValueRef::Map(_) => Vec::new(),
    });

    if type_url.is_empty() && value.is_empty() {
        return Ok("{}".to_owned());
    }

    let pool = writing.schema.pool();
    let Some(index) = type_url
        .rsplit_once('/')
        .and_then(|(_, type_name)| pool.message_index(type_name))
    else {
        return Err(Refusal::new(
            "an Any whose type its definitions do not hold",
        ));
    };
    let schema = writing.schema.at(index);
    let unread = || Refusal::new("an Any whose bytes do not read as its type");
    // * read as 17.9 reads a payload, its records checked, but for 17.9.7, which looks into no Any
    let bytes = filtered(&value, &schema).map_err(|_unread| unread())?;
    let limit = MAXIMUM_DEPTH
        .saturating_add(1)
        .saturating_sub(writing.depth);
    let held = DynamicMessage::decode_with_options(
        Arc::clone(pool),
        index,
        &bytes,
        &decode_options().with_recursion_limit(limit),
    )
    .map_err(|_unread| unread())?;
    let below = writing.deeper(1);
    let kind = format!("\"@type\":{}", string_json(&type_url));

    if is_own_form(pool.message(index).full_name()) {
        return Ok(format!(
            "{{{kind},\"value\":{}}}",
            message_json(&held, below)?
        ));
    }

    let mut members = vec![kind];

    members.extend(members_of(&held, below)?);

    Ok(format!("{{{}}}", members.join(",")))
}

/// A value of `kind`, one item of a field where it is repeated or a map.
fn kind_value_json(
    (kind, value): (SingularKind, &ValueRef<'_>),
    writing: Writing<'_>,
) -> Result<String, Refusal> {
    match (kind, value) {
        (SingularKind::Message(_), ValueRef::Message(held)) => {
            message_json(&**held, writing.deeper(1))
        }
        (SingularKind::Enum(index), ValueRef::EnumNumber(number)) => {
            Ok(enum_json(writing, (index, *number)))
        }
        (SingularKind::Scalar(_), value) => scalar_json(value).ok_or_else(no_form),
        (SingularKind::Message(_) | SingularKind::Enum(_), _) => Err(no_form()),
    }
}

/// A field's JSON, whole: a list's items, a map's entries sorted, a singular field's value (5.6).
fn field_json(
    (field, value): (&FieldDescriptor, &ValueRef<'_>),
    writing: Writing<'_>,
) -> Result<String, Refusal> {
    match (field.kind(), value) {
        (FieldKind::List(kind), ValueRef::List(list)) => {
            let items = items_of(*list)
                .map(|item| kind_value_json((kind, &item), writing))
                .collect::<Result<Vec<_>, _>>()?;

            Ok(format!("[{}]", items.join(",")))
        }
        (FieldKind::Map { value: kind, .. }, ValueRef::Map(map)) => {
            if !map.is_empty() {
                assert_depth(writing.depth.saturating_add(1))?;
            }

            let entry = writing.deeper(1);
            let mut entries = Vec::with_capacity(map.len());

            for (text, key) in sorted_keys(*map) {
                let held = map.get(&key).ok_or_else(no_form)?;

                entries.push(format!(
                    "{}:{}",
                    string_json(&text),
                    kind_value_json((kind, &held), entry)?
                ));
            }

            Ok(format!("{{{}}}", entries.join(",")))
        }
        (FieldKind::Singular(kind), value) => kind_value_json((kind, value), writing),
        (FieldKind::List(_) | FieldKind::Map { .. }, _) => Err(no_form()),
    }
}

// whether a scalar's or an enum's field of no presence of its own holds its default
fn is_implicit_default(
    (field, value): (&FieldDescriptor, &ValueRef<'_>),
    message: &buffa_descriptor::MessageDescriptor,
) -> bool {
    let is_zero = match value {
        ValueRef::F64(value) => value.classify() == core::num::FpCategory::Zero,
        ValueRef::F32(value) => value.classify() == core::num::FpCategory::Zero,
        ValueRef::Bool(_)
        | ValueRef::I32(_)
        | ValueRef::I64(_)
        | ValueRef::U32(_)
        | ValueRef::U64(_)
        | ValueRef::String(_)
        | ValueRef::Bytes(_)
        | ValueRef::EnumNumber(_)
        | ValueRef::Message(_)
        | ValueRef::List(_)
        | ValueRef::Map(_) => false,
    };

    is_zero
        && field.presence() == buffa::editions::FieldPresence::Implicit
        && !super::is_in_oneof(message, field)
}

/// A message's members, by their JSON names in their fields' numbers' order (5.6.2, 5.6.3): each
/// set one, a field of no presence of its own at its default left out.
fn members_of(message: &dyn ReflectMessage, writing: Writing<'_>) -> Result<Vec<String>, Refusal> {
    let mut fields: Vec<&FieldDescriptor> = message.message_descriptor().fields().iter().collect();

    fields.sort_by_key(|field| field.number());

    let mut members = Vec::with_capacity(fields.len());

    for field in fields {
        if !message.has(field) {
            continue;
        }

        let value = message.get(field);

        // * a field of no presence of its own at its default, -0 among it, is left out (5.6.3)
        if is_implicit_default((field, &value), message.message_descriptor()) {
            continue;
        }

        members.push(format!(
            "{}:{}",
            string_json(field.json_name()),
            field_json((field, &value), writing)?
        ));
    }

    Ok(members)
}

/// A message's JSON in Bead's proto JSON form, `writing.depth` below the one written.
fn message_json(message: &dyn ReflectMessage, writing: Writing<'_>) -> Result<String, Refusal> {
    assert_depth(writing.depth)?;

    let descriptor = message.message_descriptor();
    let wrong = |reason: &'static str| Refusal::new(reason);

    match descriptor.full_name() {
        "google.protobuf.Timestamp" => return timestamp_json(instant_of(message)).map_err(wrong),
        "google.protobuf.Duration" => return duration_json(instant_of(message)).map_err(wrong),
        "google.protobuf.FieldMask" => {
            let paths =
                field_of(message, 1).map_or_else(Vec::new, |field| match message.get(field) {
                    ValueRef::List(list) => items_of(list)
                        .filter_map(|item| match item {
                            ValueRef::String(path) => Some(path.to_owned()),
                            ValueRef::Bool(_)
                            | ValueRef::I32(_)
                            | ValueRef::I64(_)
                            | ValueRef::U32(_)
                            | ValueRef::U64(_)
                            | ValueRef::F32(_)
                            | ValueRef::F64(_)
                            | ValueRef::Bytes(_)
                            | ValueRef::EnumNumber(_)
                            | ValueRef::Message(_)
                            | ValueRef::List(_)
                            | ValueRef::Map(_) => None,
                        })
                        .collect(),
                    ValueRef::Bool(_)
                    | ValueRef::I32(_)
                    | ValueRef::I64(_)
                    | ValueRef::U32(_)
                    | ValueRef::U64(_)
                    | ValueRef::F32(_)
                    | ValueRef::F64(_)
                    | ValueRef::String(_)
                    | ValueRef::Bytes(_)
                    | ValueRef::EnumNumber(_)
                    | ValueRef::Message(_)
                    | ValueRef::Map(_) => Vec::new(),
                });

            return field_mask_json(&paths).map_err(wrong);
        }
        "google.protobuf.Struct" => return struct_json(message, writing),
        "google.protobuf.Value" => return value_json(message, writing),
        "google.protobuf.ListValue" => return list_value_json(message, writing),
        "google.protobuf.Any" => return any_json(message, writing),
        _ => {}
    }

    if is_wrapper(descriptor)
        && let Some(field) = descriptor.fields().first()
    {
        return scalar_json(&message.get(field)).ok_or_else(no_form);
    }

    Ok(format!("{{{}}}", members_of(message, writing)?.join(",")))
}

/// `message`'s JSON in Bead's proto JSON form (5.6): a result's, read by its stock library first.
pub(crate) fn write_message(
    message: &DynamicMessage,
    schema: &ProtoSchema,
) -> Result<String, Refusal> {
    message_json(message, Writing { schema, depth: 0 })
}

/// The JSON of `message`'s top-level `field`, its default written where it is at its default too,
/// so that a body is always there (5.8): a message unset its empty one's, an enum unset its first
/// value's.
pub(crate) fn write_field(
    message: &DynamicMessage,
    (field, schema): (&FieldDescriptor, &ProtoSchema),
) -> Result<String, Refusal> {
    let writing = Writing { schema, depth: 0 };
    let pool = schema.pool();

    if !message.has(field) {
        match field.kind() {
            FieldKind::Singular(SingularKind::Message(index)) => {
                return message_json(
                    &DynamicMessage::new(Arc::clone(pool), index),
                    writing.deeper(1),
                );
            }
            FieldKind::Singular(SingularKind::Enum(index)) => {
                let first = pool
                    .enumeration(index)
                    .values()
                    .first()
                    .map_or(0, buffa_descriptor::EnumValueDescriptor::number);

                return Ok(enum_json(writing, (index, first)));
            }
            FieldKind::Singular(SingularKind::Scalar(scalar)) => {
                return Ok(default_json(scalar));
            }
            FieldKind::List(_) | FieldKind::Map { .. } => {}
        }
    }

    field_json((field, &message.get(field)), writing)
}

// a scalar's default's JSON, where a oneof's member holds none
fn default_json(scalar: ScalarType) -> String {
    match scalar {
        ScalarType::Bool => "false".to_owned(),
        ScalarType::String | ScalarType::Bytes => "\"\"".to_owned(),
        ScalarType::Double
        | ScalarType::Float
        | ScalarType::Int32
        | ScalarType::Sint32
        | ScalarType::Sfixed32
        | ScalarType::Uint32
        | ScalarType::Fixed32
        | ScalarType::Int64
        | ScalarType::Sint64
        | ScalarType::Sfixed64
        | ScalarType::Uint64
        | ScalarType::Fixed64 => {
            if integer_type_of(scalar).is_some_and(|integer| integer.is_64) {
                "\"0\"".to_owned()
            } else {
                "0".to_owned()
            }
        }
    }
}
