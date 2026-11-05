//! JSON's depth refusal is bounded and escaped names keep their decoded spelling.

use core::time::Duration;

use bytes::Bytes;

use std::collections::BTreeMap;
use std::error::Error as _;

use serde_json::Value;

use crate::payloads::{CodecRefusal, JsonCodec, JsonOf, PayloadCodec};
use crate::testing::Instant;

#[test]
fn refuses_16_mib_of_nested_arrays_within_a_second_building_nothing_past_64() {
    let half = 8 * 1_024 * 1_024;
    let mut bytes = vec![b'['; half];
    bytes.resize(half.saturating_mul(2), b']');
    let bytes = Bytes::from(bytes);
    let started = Instant::now();
    let refused = JsonCodec.decode(&bytes).expect_err("past depth 64");
    assert_eq!(refused.to_string(), "nested past 64");
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn reads_a_name_that_holds_an_escape_as_its_escapes_say_whatever_an_object_of_its_shape_held_before()
 {
    let mut drawn = [0; 8];
    getrandom::fill(&mut drawn).expect("a name drawn per run");
    let first = format!("onTheLedge{}", crate::base64url::encode(&drawn));
    for (suffix, expected) in [
        (r#"1,"q\\":1}"#, "q\\"),
        (r#"2,"q\"":2}"#, "q\""),
        (r#"3,"\u0071\"":3}"#, "q\""),
    ] {
        let text = format!("{{\"{first}\":{suffix}");
        let read = JsonCodec
            .decode(&Bytes::from(text))
            .expect("escaped names read");
        let names = read
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        assert_eq!(names, [first.as_str(), expected]);
    }
}

// the reason a codec refuses to write, and its cause's words, if any
fn refusal_of(written: Result<Bytes, CodecRefusal>) -> (String, Option<String>) {
    let refusal = written.expect_err("refused");

    (
        refusal.reason().to_owned(),
        refusal.source().map(ToString::to_string),
    )
}

// a map whose keys are not strings, which JSON has no value for
fn keyed_by_pairs() -> BTreeMap<(u8, u8), u8> {
    BTreeMap::from([((1, 2), 3)])
}

// TypeScript's TypeError is a refusal to write; a Rust type holds no undefined, no function, no
// bigint, no symbol and no surrogate alone, and serde writes a value of the application's type as
// its type says: what is left is a double that is not finite, and a map JSON has no object for
// spec 17.2
#[test]
fn refuses_what_json_has_no_value_for_each_in_its_own_words_with_a_type_error() {
    assert_eq!(
        refusal_of(JsonOf::<BTreeMap<(u8, u8), u8>>::new().encode(&keyed_by_pairs())),
        (
            "no JSON value".to_owned(),
            Some("no JSON value: a map whose keys are not strings".to_owned())
        )
    );

    for refused in [
        JsonOf::<f64>::new().encode(&f64::NAN),
        JsonOf::<Vec<f64>>::new().encode(&vec![f64::NEG_INFINITY]),
    ] {
        assert_eq!(
            refusal_of(refused),
            ("not a finite number".to_owned(), None)
        );
    }
}

// a value nests as deep as its type does, and holds no cycle
#[test]
fn refuses_a_value_nested_deeper_than_64_a_cycle_among_them() {
    let nested =
        |depth: usize| (0..depth).fold(Value::from(1), |inner, _| Value::Array(vec![inner]));

    assert_eq!(
        refusal_of(JsonCodec.encode(&nested(65))),
        ("nested past 64".to_owned(), None)
    );
    assert!(JsonCodec.encode(&nested(64)).is_ok(), "64 deep, written");
}

// spec 17.2
#[test]
fn refuses_what_does_not_write_within_an_object_one_of_whose_names_may_be_an_array_index() {
    assert_eq!(
        refusal_of(
            JsonOf::<BTreeMap<String, f64>>::new()
                .encode(&BTreeMap::from([("1".to_owned(), f64::NAN)]))
        ),
        ("not a finite number".to_owned(), None)
    );
    assert_eq!(
        refusal_of(
            JsonOf::<BTreeMap<String, BTreeMap<(u8, u8), u8>>>::new()
                .encode(&BTreeMap::from([("1".to_owned(), keyed_by_pairs())]))
        )
        .0,
        "no JSON value"
    );
}
