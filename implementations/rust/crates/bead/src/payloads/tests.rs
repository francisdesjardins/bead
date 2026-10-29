//! The payloads' codecs: raw bytes as they are, text in UTF-8 read strictly, a JSON value in its
//! canonical form, and a type of the application's own through it.

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{JsonCodec, JsonOf, PayloadCodec, RawCodec, TextCodec};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Reading {
    name: String,
    value: f64,
}

#[test]
fn names_each_codec_by_its_encoding() {
    assert_eq!(
        [
            RawCodec.encoding(),
            TextCodec.encoding(),
            JsonCodec.encoding(),
            JsonOf::<Reading>::new().encoding()
        ],
        ["raw", "text", "json", "json"],
        "each by its encoding"
    );
}

#[test]
fn carries_raw_bytes_as_they_are_and_text_in_utf_8_read_strictly_its_byte_order_mark_kept() {
    let bytes = Bytes::from_static(&[0, 255, 7]);

    assert_eq!(
        RawCodec.decode(&bytes).ok(),
        Some(bytes.clone()),
        "raw read as it is"
    );
    assert_eq!(
        RawCodec.encode(&bytes).ok(),
        Some(bytes),
        "raw written as it is"
    );
    assert_eq!(
        TextCodec
            .decode(&Bytes::from_static("\u{feff}h\u{e9}".as_bytes()))
            .ok(),
        Some("\u{feff}h\u{e9}".to_owned()),
        "its byte order mark kept"
    );
    assert!(
        TextCodec
            .decode(&Bytes::from_static(&[0x68, 0xC3]))
            .is_err(),
        "a sequence cut short refused"
    );
    assert!(
        TextCodec
            .decode(&Bytes::from_static(&[0xED, 0xA0, 0x80]))
            .is_err(),
        "a surrogate refused"
    );
}

#[test]
fn writes_a_json_value_in_its_canonical_form_and_a_type_through_it() {
    let written = JsonCodec
        .encode(&json!({ "b": 1.0, "a": [true, null, "x"] }))
        .expect("written");

    assert_eq!(
        written.as_ref(),
        br#"{"a":[true,null,"x"],"b":1}"#,
        "its canonical form"
    );
    assert_eq!(
        JsonCodec.decode(&written).ok(),
        Some(json!({ "a": [true, null, "x"], "b": 1 })),
        "read again"
    );

    let codec = JsonOf::<Reading>::new();
    let reading = Reading {
        name: "t".to_owned(),
        value: 0.5,
    };
    let encoded = codec.encode(&reading).expect("written");

    assert_eq!(
        encoded.as_ref(),
        br#"{"name":"t","value":0.5}"#,
        "a type's value"
    );
    assert_eq!(
        codec.decode(&encoded).ok(),
        Some(reading),
        "read back as its type"
    );
    assert!(
        codec
            .encode(&Reading {
                name: "t".to_owned(),
                value: f64::NAN,
            })
            .is_err(),
        "a double that is not finite refused"
    );
    assert!(
        codec.decode(&Bytes::from_static(br#"{"name":1}"#)).is_err(),
        "a value not of its type refused"
    );
}
