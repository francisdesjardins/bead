//! The `json` payload's tests: a double that is not finite refused at any depth, a number read as
//! an integer or the nearest double, and what `serde_json` gives a value.

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::{JsonRefusal, read, to_bytes, to_value};

// what serde_json writes as null, at the top and nested
#[derive(Serialize)]
struct Reading {
    name: &'static str,
    values: Vec<f64>,
    within: Option<Box<Self>>,
}

#[test]
fn refuses_a_double_that_is_not_finite_at_any_depth_where_serde_json_writes_null() {
    let nested = Reading {
        name: "outer",
        values: vec![1.5],
        within: Some(Box::new(Reading {
            name: "inner",
            values: vec![2.0, f64::NEG_INFINITY],
            within: None,
        })),
    };

    // * serde_json's own road writes each as null
    assert_eq!(
        serde_json::to_value(f64::NAN).ok(),
        Some(Value::Null),
        "serde_json writes null"
    );

    for refused in [
        to_value(&f64::NAN),
        to_value(&vec![1.0, f64::INFINITY]),
        to_value(&nested),
    ] {
        assert!(
            matches!(refused, Err(JsonRefusal::NotAFiniteNumber)),
            "refused at any depth: {refused:?}"
        );
    }

    assert!(
        matches!(to_bytes(&[f64::NAN]), Err(JsonRefusal::NotAFiniteNumber)),
        "refused on its way to bytes"
    );
    let finite = to_value(&Reading {
        name: "whole",
        values: vec![1.0, 0.5],
        within: None,
    })
    .expect("finite doubles kept");

    assert_eq!(
        String::from_utf8(super::write(&finite).expect("written"))
            .ok()
            .as_deref(),
        Some(r#"{"name":"whole","values":[1,0.5],"within":null}"#),
        "a finite double kept, a whole one written as an integer"
    );
}

#[test]
fn reads_a_whole_number_as_an_integer_and_any_other_as_the_nearest_double() {
    let read_of = |text: &str| read(text.as_bytes()).expect("a number");

    for (text, integer) in [
        ("1", 1_i64),
        ("-7", -7),
        ("1.0", 1),
        ("1e2", 100),
        ("9007199254740991", 9_007_199_254_740_991),
    ] {
        assert_eq!(read_of(text).as_i64(), Some(integer), "{text} an integer");
    }

    assert_eq!(
        read_of("18446744073709551615").as_u64(),
        Some(u64::MAX),
        "a whole number within 64 bits"
    );

    for (text, double) in [("0.1", 0.1_f64), ("1.5e-3", 0.0015), ("1e300", 1e300)] {
        let value = read_of(text);

        assert!(value.as_i64().is_none(), "{text} no integer");
        assert_eq!(value.as_f64(), Some(double), "{text} the nearest double");
    }

    // past 64 bits, whole yet no integer: the nearest double
    assert_eq!(
        read_of("18446744073709551616").as_f64(),
        Some(2.0_f64.powi(64)),
        "past 64 bits"
    );

    // -0 keeps its sign as a double
    assert!(
        read_of("-0").as_f64().is_some_and(f64::is_sign_negative),
        "-0 a double"
    );
    assert!(
        matches!(read(b"1e400"), Err(JsonRefusal::NumberPastADouble)),
        "past a double refused"
    );
}

// a platform's shape: what the other sides' readers refuse, a surrogate alone and a name twice, no
// serde_json value holds: a String is UTF-8, and a Map keeps one value a name
#[test]
fn is_given_by_serde_json_no_surrogate_alone_and_no_name_twice() {
    assert!(
        matches!(read(br#""\ud800""#), Err(JsonRefusal::SurrogateAlone)),
        "a surrogate alone refused"
    );
    assert!(
        matches!(read(br#"{"a":1,"a":2}"#), Err(JsonRefusal::NameTwice)),
        "a name twice refused"
    );

    let mut members = Map::new();

    members.insert("a".to_owned(), json!(1));
    members.insert("a".to_owned(), json!(2));

    assert_eq!(members.len(), 1, "a map holds a name once");
    assert_eq!(
        String::from_utf16_lossy(&[0xD800]),
        "\u{FFFD}",
        "a string holds no surrogate alone"
    );
}
