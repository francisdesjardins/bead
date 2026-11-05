//! Payload-codec twins keep each exact input, the canonical bytes and the refusal's reason.

use bytes::Bytes;
use serde_json::json;

use crate::payloads::{JsonCodec, JsonOf, PayloadCodec, RawCodec, TextCodec};

#[test]
fn refuses_a_string_never_closed_as_not_json_its_scan_bounded_by_the_text() {
    let mut text = vec![b'"'];
    text.resize(1_001, b'x');
    assert_eq!(
        JsonCodec
            .decode(&text.into())
            .expect_err("an unterminated string")
            .reason(),
        "not JSON"
    );
}

#[test]
fn writes_each_objects_names_sorted_by_their_utf_16_code_units_an_array_indexs_among_them() {
    for (value, expected) in [
        (
            json!({"b": 1, "10": 2, "9": 3, "1a": 4}),
            r#"{"10":2,"1a":4,"9":3,"b":1}"#,
        ),
        (
            json!({"z": [{"b": 1, "a": 2}], "a": null}),
            r#"{"a":null,"z":[{"a":2,"b":1}]}"#,
        ),
    ] {
        assert_eq!(
            JsonCodec.encode(&value).expect("written").as_ref(),
            expected.as_bytes()
        );
    }
}

#[test]
fn reads_utf_8_strictly_a_leading_u_feff_kept_and_writes_a_string() {
    assert_eq!(
        TextCodec
            .decode(&Bytes::from_static(&[0xc3]))
            .expect_err("cut UTF-8")
            .reason(),
        "not UTF-8"
    );
    assert_eq!(
        TextCodec
            .decode(&Bytes::from_static(&[0xef, 0xbb, 0xbf, 0x31]))
            .expect("a byte order mark kept"),
        "\u{feff}1"
    );
    assert_eq!(
        TextCodec
            .encode(&"ok".to_owned())
            .expect("written")
            .as_ref(),
        [0x6f, 0x6b]
    );
}

#[test]
fn reads_and_writes_its_bytes_as_they_are() {
    let bytes = Bytes::from(vec![0xff, 0x00]);
    let read = RawCodec.decode(&bytes).expect("read");
    let written = RawCodec.encode(&bytes).expect("written");
    for result in [read, written] {
        assert_eq!(result, bytes);
        assert_eq!(result.as_ptr(), bytes.as_ptr());
    }
}

#[test]
fn tells_whether_each_object_names_each_member_once_by_a_well_formed_name_its_escapes_read() {
    for (text, held) in [
        (r#"[{"a":1},{"a":{"a":2}},"a","a"]"#, true),
        (r#"{"a":1,"b":{"c":1,"c":2}}"#, false),
        (r#"{"a":1,"\u0061":2}"#, false),
        (r#"{"\ud800":1}"#, false),
    ] {
        assert_eq!(
            JsonCodec
                .decode(&Bytes::from_static(text.as_bytes()))
                .is_ok(),
            held,
            "{text}"
        );
    }
}

#[test]
fn gives_spec_17_s_codecs_by_their_encoding_s_name() {
    let raw = RawCodec
        .decode(&Bytes::from_static(&[1, 2]))
        .expect("raw read");
    assert_eq!(RawCodec.encode(&raw).expect("raw written").as_ref(), [1, 2]);
    assert_eq!(
        TextCodec
            .decode(&Bytes::from_static("Josée".as_bytes()))
            .expect("text read"),
        "Josée"
    );
    TextCodec
        .decode(&Bytes::from_static(&[0xff]))
        .expect_err("not UTF-8");
    let json = JsonCodec
        .decode(&Bytes::from_static(br#"{"b":2,"a":1}"#))
        .expect("JSON read");
    assert_eq!(
        JsonCodec.encode(&json).expect("JSON written").as_ref(),
        br#"{"a":1,"b":2}"#
    );
    JsonCodec
        .decode(&Bytes::from_static(br#"{"a":1,"a":2}"#))
        .expect_err("a name twice");
}

#[test]
fn refuses_what_a_json_payload_does_not_read_in_its_own_words() {
    for (bytes, reason) in [
        (Bytes::from_static(b"\"\xff\""), "not UTF-8"),
        (Bytes::from_static(b"\xef\xbb\xbf1"), "a byte order mark"),
        (Bytes::new(), "not JSON"),
        (Bytes::from_static(b"[1,]"), "not JSON"),
        (Bytes::from_static(br#"{"a":1,"a":2}"#), "a name twice"),
        (Bytes::from_static(b"\"abc"), "not JSON"),
        (Bytes::from_static(br#""\ud800""#), "a surrogate alone"),
        (Bytes::from_static(br#"{"\udc00":1}"#), "a surrogate alone"),
        (Bytes::from_static(b"1E400"), "a number past a double"),
        (
            Bytes::from([vec![b'['; 65], vec![b']'; 65]].concat()),
            "nested past 64",
        ),
    ] {
        assert_eq!(
            JsonCodec
                .decode(&bytes)
                .expect_err("a refused JSON input")
                .reason(),
            reason,
            "{bytes:?}"
        );
    }
}

#[test]
fn writes_an_integer_past_2_to_the_53_from_its_digits_as_the_double_nearest_them() {
    assert_eq!(
        JsonOf::<i64>::new()
            .encode(&9_007_199_254_740_993)
            .expect("an integer written")
            .as_ref(),
        b"9007199254740992"
    );
}
