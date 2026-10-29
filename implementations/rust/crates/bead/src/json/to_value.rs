//! `bead::json::to_value`: a `serde::Serializer` of Bead's own, with its own compound serializers,
//! so a double that is not finite is refused at any depth, where `serde_json`'s writes `null`.

use core::fmt;

use serde::ser::{self, Serialize};
use serde_json::{Map, Number, Value};

use super::JsonRefusal;

impl ser::Error for JsonRefusal {
    fn custom<T: fmt::Display>(message: T) -> Self {
        Self::NoJsonValue(message.to_string())
    }
}

/// The `json` value `value` stands for, through `serde`: the road from a resolver's type to a
/// `json` payload.
///
/// A double that is not finite is refused at any depth, as both other sides' writers refuse it. A
/// `Value` the application built with `serde_json::json!` from a NaN holds `null` already, before
/// Bead sees it.
///
/// # Errors
///
/// [`JsonRefusal::NotAFiniteNumber`] for a double that is not finite, and
/// [`JsonRefusal::NoJsonValue`] for a map whose keys are not strings, or what `serde` refuses.
pub fn to_value<T: Serialize + ?Sized>(value: &T) -> Result<Value, JsonRefusal> {
    value.serialize(Serializer)
}

/// The serializer to a `json` value.
#[derive(Debug, Clone, Copy)]
struct Serializer;

fn double(value: f64) -> Result<Value, JsonRefusal> {
    Number::from_f64(value)
        .map(Value::Number)
        .ok_or(JsonRefusal::NotAFiniteNumber)
}

impl ser::Serializer for Serializer {
    type Ok = Value;
    type Error = JsonRefusal;
    type SerializeSeq = Sequence;
    type SerializeTuple = Sequence;
    type SerializeTupleStruct = Sequence;
    type SerializeTupleVariant = VariantSequence;
    type SerializeMap = Members;
    type SerializeStruct = Members;
    type SerializeStructVariant = VariantMembers;

    fn serialize_bool(self, value: bool) -> Result<Value, JsonRefusal> {
        Ok(Value::Bool(value))
    }

    fn serialize_i8(self, value: i8) -> Result<Value, JsonRefusal> {
        Ok(Value::Number(Number::from(value)))
    }

    fn serialize_i16(self, value: i16) -> Result<Value, JsonRefusal> {
        Ok(Value::Number(Number::from(value)))
    }

    fn serialize_i32(self, value: i32) -> Result<Value, JsonRefusal> {
        Ok(Value::Number(Number::from(value)))
    }

    fn serialize_i64(self, value: i64) -> Result<Value, JsonRefusal> {
        Ok(Value::Number(Number::from(value)))
    }

    fn serialize_u8(self, value: u8) -> Result<Value, JsonRefusal> {
        Ok(Value::Number(Number::from(value)))
    }

    fn serialize_u16(self, value: u16) -> Result<Value, JsonRefusal> {
        Ok(Value::Number(Number::from(value)))
    }

    fn serialize_u32(self, value: u32) -> Result<Value, JsonRefusal> {
        Ok(Value::Number(Number::from(value)))
    }

    fn serialize_u64(self, value: u64) -> Result<Value, JsonRefusal> {
        Ok(Value::Number(Number::from(value)))
    }

    fn serialize_f32(self, value: f32) -> Result<Value, JsonRefusal> {
        double(f64::from(value))
    }

    fn serialize_f64(self, value: f64) -> Result<Value, JsonRefusal> {
        double(value)
    }

    fn serialize_char(self, value: char) -> Result<Value, JsonRefusal> {
        Ok(Value::String(value.to_string()))
    }

    fn serialize_str(self, value: &str) -> Result<Value, JsonRefusal> {
        Ok(Value::String(value.to_owned()))
    }

    fn serialize_bytes(self, value: &[u8]) -> Result<Value, JsonRefusal> {
        Ok(Value::Array(
            value
                .iter()
                .map(|&byte| Value::Number(Number::from(byte)))
                .collect(),
        ))
    }

    fn serialize_none(self) -> Result<Value, JsonRefusal> {
        Ok(Value::Null)
    }

    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<Value, JsonRefusal> {
        value.serialize(self)
    }

    fn serialize_unit(self) -> Result<Value, JsonRefusal> {
        Ok(Value::Null)
    }

    fn serialize_unit_struct(self, _name: &'static str) -> Result<Value, JsonRefusal> {
        Ok(Value::Null)
    }

    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
    ) -> Result<Value, JsonRefusal> {
        Ok(Value::String(variant.to_owned()))
    }

    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        _name: &'static str,
        value: &T,
    ) -> Result<Value, JsonRefusal> {
        value.serialize(self)
    }

    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<Value, JsonRefusal> {
        let mut members = Map::new();

        members.insert(variant.to_owned(), value.serialize(self)?);

        Ok(Value::Object(members))
    }

    fn serialize_seq(self, length: Option<usize>) -> Result<Sequence, JsonRefusal> {
        Ok(Sequence {
            items: Vec::with_capacity(length.unwrap_or(0)),
        })
    }

    fn serialize_tuple(self, length: usize) -> Result<Sequence, JsonRefusal> {
        self.serialize_seq(Some(length))
    }

    fn serialize_tuple_struct(
        self,
        _name: &'static str,
        length: usize,
    ) -> Result<Sequence, JsonRefusal> {
        self.serialize_seq(Some(length))
    }

    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        length: usize,
    ) -> Result<VariantSequence, JsonRefusal> {
        Ok(VariantSequence {
            variant,
            items: Vec::with_capacity(length),
        })
    }

    fn serialize_map(self, _length: Option<usize>) -> Result<Members, JsonRefusal> {
        Ok(Members {
            members: Map::new(),
            name: None,
        })
    }

    fn serialize_struct(self, _name: &'static str, length: usize) -> Result<Members, JsonRefusal> {
        self.serialize_map(Some(length))
    }

    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        _length: usize,
    ) -> Result<VariantMembers, JsonRefusal> {
        Ok(VariantMembers {
            variant,
            members: Map::new(),
        })
    }
}

/// An array's items, as each is serialized.
#[derive(Debug)]
struct Sequence {
    items: Vec<Value>,
}

impl ser::SerializeSeq for Sequence {
    type Ok = Value;
    type Error = JsonRefusal;

    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), JsonRefusal> {
        self.items.push(value.serialize(Serializer)?);
        Ok(())
    }

    fn end(self) -> Result<Value, JsonRefusal> {
        Ok(Value::Array(self.items))
    }
}

impl ser::SerializeTuple for Sequence {
    type Ok = Value;
    type Error = JsonRefusal;

    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), JsonRefusal> {
        ser::SerializeSeq::serialize_element(self, value)
    }

    fn end(self) -> Result<Value, JsonRefusal> {
        ser::SerializeSeq::end(self)
    }
}

impl ser::SerializeTupleStruct for Sequence {
    type Ok = Value;
    type Error = JsonRefusal;

    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), JsonRefusal> {
        ser::SerializeSeq::serialize_element(self, value)
    }

    fn end(self) -> Result<Value, JsonRefusal> {
        ser::SerializeSeq::end(self)
    }
}

/// A tuple variant's items, under its name.
#[derive(Debug)]
struct VariantSequence {
    variant: &'static str,
    items: Vec<Value>,
}

impl ser::SerializeTupleVariant for VariantSequence {
    type Ok = Value;
    type Error = JsonRefusal;

    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), JsonRefusal> {
        self.items.push(value.serialize(Serializer)?);
        Ok(())
    }

    fn end(self) -> Result<Value, JsonRefusal> {
        let mut members = Map::new();

        members.insert(self.variant.to_owned(), Value::Array(self.items));

        Ok(Value::Object(members))
    }
}

/// An object's members, as each is serialized, and the name the next value takes.
#[derive(Debug)]
struct Members {
    members: Map<String, Value>,
    name: Option<String>,
}

impl ser::SerializeMap for Members {
    type Ok = Value;
    type Error = JsonRefusal;

    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result<(), JsonRefusal> {
        match key.serialize(Serializer)? {
            Value::String(name) => {
                self.name = Some(name);
                Ok(())
            }
            Value::Number(number) => {
                self.name = Some(number.to_string());
                Ok(())
            }
            Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => Err(
                JsonRefusal::NoJsonValue("a map whose keys are not strings".to_owned()),
            ),
        }
    }

    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), JsonRefusal> {
        let name = self.name.take().unwrap_or_default();

        self.members.insert(name, value.serialize(Serializer)?);
        Ok(())
    }

    fn end(self) -> Result<Value, JsonRefusal> {
        Ok(Value::Object(self.members))
    }
}

impl ser::SerializeStruct for Members {
    type Ok = Value;
    type Error = JsonRefusal;

    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), JsonRefusal> {
        self.members
            .insert(key.to_owned(), value.serialize(Serializer)?);
        Ok(())
    }

    fn end(self) -> Result<Value, JsonRefusal> {
        Ok(Value::Object(self.members))
    }
}

/// A struct variant's members, under its name.
#[derive(Debug)]
struct VariantMembers {
    variant: &'static str,
    members: Map<String, Value>,
}

impl ser::SerializeStructVariant for VariantMembers {
    type Ok = Value;
    type Error = JsonRefusal;

    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), JsonRefusal> {
        self.members
            .insert(key.to_owned(), value.serialize(Serializer)?);
        Ok(())
    }

    fn end(self) -> Result<Value, JsonRefusal> {
        let mut members = Map::new();

        members.insert(self.variant.to_owned(), Value::Object(self.members));

        Ok(Value::Object(members))
    }
}
