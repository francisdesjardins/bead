//! JSON's depth refusal is bounded and escaped names keep their decoded spelling.

use core::time::Duration;

use bytes::Bytes;

use crate::payloads::{JsonCodec, PayloadCodec};
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
