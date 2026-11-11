//! The serde representations the Rust-native serializer takes: each scalar and compound form,
//! their JSON shapes, and a refusal carried through every compound without becoming null.

use std::collections::BTreeMap;

use serde::Serialize;
use serde::ser::{SerializeSeq, Serializer};
use serde_json::{Value, json};

use super::to_value;
use crate::json::JsonRefusal;

#[derive(Serialize)]
struct Unit;

#[derive(Serialize)]
struct Newtype(Vec<u8>);

#[derive(Serialize)]
struct Pair(f64, bool);

#[derive(Serialize)]
enum Variant {
    Unit,
    Newtype(f64),
    Pair(f64, bool),
    Record { reading: f64, valid: bool },
}

#[derive(Serialize)]
struct Record {
    name: char,
    reading: Option<f64>,
}

struct Octets(Vec<u8>);

impl Serialize for Octets {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(&self.0)
    }
}

struct Uncounted;

impl Serialize for Uncounted {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(None)?;

        sequence.serialize_element(&1)?;
        sequence.serialize_element(&2)?;
        sequence.end()
    }
}

struct Refused;

impl Serialize for Refused {
    fn serialize<S: Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom(
            "the reading refuses serialization",
        ))
    }
}

#[test]
fn maps_serde_s_integer_widths_and_finite_floats_to_json_numbers() {
    for (value, expected) in [
        (to_value(&i8::MIN), json!(-128)),
        (to_value(&i16::MIN), json!(-32_768)),
        (to_value(&i32::MIN), json!(-2_147_483_648_i64)),
        (to_value(&i64::MIN), json!(i64::MIN)),
        (to_value(&u8::MAX), json!(255)),
        (to_value(&u16::MAX), json!(65_535)),
        (to_value(&u32::MAX), json!(4_294_967_295_u64)),
        (to_value(&u64::MAX), json!(u64::MAX)),
        (to_value(&1.5_f32), json!(1.5)),
        (to_value(&-2.5_f64), json!(-2.5)),
    ] {
        assert_eq!(
            value.unwrap(),
            expected,
            "the native number keeps its value"
        );
    }
}

#[test]
fn maps_serde_s_scalars_options_and_unit_forms_to_their_json_values() {
    for (value, expected) in [
        (to_value(&true), json!(true)),
        (to_value(&'é'), json!("é")),
        (to_value("text"), json!("text")),
        (to_value(&Octets(vec![0, 127, 255])), json!([0, 127, 255])),
        (to_value(&None::<u8>), Value::Null),
        (to_value(&Some(7_u8)), json!(7)),
        (to_value(&()), Value::Null),
        (to_value(&Unit), Value::Null),
        (to_value(&Variant::Unit), json!("Unit")),
        (to_value(&Newtype(vec![1, 2])), json!([1, 2])),
    ] {
        assert_eq!(
            value.unwrap(),
            expected,
            "the serde representation has its JSON shape"
        );
    }
}

#[test]
fn maps_serde_s_sequences_maps_structs_and_tagged_variants_to_their_json_shapes() {
    for (value, expected) in [
        (to_value(&vec![1, 2]), json!([1, 2])),
        (to_value(&(1.5, true)), json!([1.5, true])),
        (to_value(&Pair(1.5, true)), json!([1.5, true])),
        (to_value(&Uncounted), json!([1, 2])),
        (to_value(&BTreeMap::from([("name", 7)])), json!({"name": 7})),
        (
            to_value(&BTreeMap::from([(7_u8, "value")])),
            json!({"7": "value"}),
        ),
        (
            to_value(&Record {
                name: 'x',
                reading: Some(1.5),
            }),
            json!({"name": "x", "reading": 1.5}),
        ),
        (to_value(&Variant::Newtype(1.5)), json!({"Newtype": 1.5})),
        (
            to_value(&Variant::Pair(1.5, true)),
            json!({"Pair": [1.5, true]}),
        ),
        (
            to_value(&Variant::Record {
                reading: 1.5,
                valid: true,
            }),
            json!({"Record": {"reading": 1.5, "valid": true}}),
        ),
    ] {
        assert_eq!(
            value.unwrap(),
            expected,
            "compound elements and names reach their JSON value"
        );
    }
}

#[test]
fn refuses_non_finite_numbers_through_each_serde_compound_representation() {
    for refused in [
        to_value(&f32::INFINITY),
        to_value(&Some(f64::NAN)),
        to_value(&(f64::NAN, true)),
        to_value(&Pair(f64::NAN, true)),
        to_value(&Variant::Newtype(f64::NAN)),
        to_value(&Variant::Pair(f64::NAN, true)),
        to_value(&Variant::Record {
            reading: f64::NAN,
            valid: true,
        }),
        to_value(&BTreeMap::from([("reading", f64::NAN)])),
        to_value(&Record {
            name: 'x',
            reading: Some(f64::NAN),
        }),
    ] {
        assert_eq!(
            refused,
            Err(JsonRefusal::NotAFiniteNumber),
            "a nested refusal never becomes null"
        );
    }
}

#[test]
fn refuses_a_serde_map_key_that_has_no_json_member_name_and_keeps_a_custom_refusal() {
    for refused in [
        to_value(&BTreeMap::from([(true, 1)])),
        to_value(&BTreeMap::from([(vec![1, 2], 1)])),
        to_value(&BTreeMap::from([(None::<u8>, 1)])),
    ] {
        assert_eq!(
            refused,
            Err(JsonRefusal::NoJsonValue(
                "a map whose keys are not strings".to_owned()
            )),
            "no member name is invented"
        );
    }

    for refused in [to_value(&Refused), to_value(&vec![Refused])] {
        assert_eq!(
            refused,
            Err(JsonRefusal::NoJsonValue(
                "the reading refuses serialization".to_owned()
            )),
            "the serializer's reason reaches its caller at any depth"
        );
    }
}
