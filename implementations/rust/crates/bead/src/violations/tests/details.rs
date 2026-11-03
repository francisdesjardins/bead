//! Violation details keep complete lines, bounded counts and the members the wire carries.

use serde_json::json;

use crate::constants::{FailureScope, ProtocolCode};
use crate::violations::{
    Judged, ReadViolations, Violation, ViolationHolder, detail_bound_of, is_refused,
    violations_detail_of, violations_of,
};

fn from() -> Violation {
    Violation {
        bounds: Some(json!({"lte": 10}).as_object().expect("bounds").clone()),
        field_path: Some("from".to_owned()),
        message: Some("must be less than or equal to 10".to_owned()),
        rule_id: "int32.lte".to_owned(),
        ..Violation::default()
    }
}

fn name() -> Violation {
    Violation {
        bounds: Some(json!({"min_len": "1"}).as_object().expect("bounds").clone()),
        field_path: Some("names[0]".to_owned()),
        message: Some("must be at least 1 characters".to_owned()),
        rule_id: "string.min_len".to_owned(),
        ..Violation::default()
    }
}

fn read(detail: &str) -> ReadViolations {
    violations_of(&super::failure_of(
        (ProtocolCode::PAYLOAD_INVALID.get(), FailureScope::Protocol),
        detail,
    ))
}

fn shown(violations: Vec<Violation>, more: Option<u64>) -> ReadViolations {
    ReadViolations {
        violations,
        more,
        stopped: false,
    }
}

fn detail(violations: Vec<Violation>, more: u64) -> String {
    violations_detail_of(
        &Judged {
            violations,
            more,
            stopped: false,
        },
        1_024,
    )
}

#[test]
fn keeps_a_full_violation_detail_closed_to_smaller_violations_after_the_first_refusal() {
    let small = Violation {
        bounds: Some(serde_json::Map::new()),
        field_path: Some("a".to_owned()),
        message: Some(String::new()),
        rule_id: "required".to_owned(),
        ..Violation::default()
    };
    let large = Violation {
        field_path: Some("a".repeat(200)),
        ..small.clone()
    };
    let first = r#"{"fieldPath":"a","ruleId":"required"}"#;
    let mut holder = ViolationHolder::new(80);
    assert!(holder.hold(&small));
    assert_eq!(holder.lines(), [first]);
    assert!(!holder.hold(&large));
    assert!(!holder.hold(&small));
    assert_eq!(holder.lines(), [first]);
    for (violations, more) in [
        (vec![small.clone()], 0),
        (vec![small.clone(), large.clone()], 1),
        (vec![small.clone(), large, small], 2),
    ] {
        assert_eq!(
            violations_detail_of(
                &Judged {
                    violations,
                    ..Judged::default()
                },
                80
            ),
            format!("{first}\n{{\"more\":{more}}}")
        );
    }
}

#[test]
fn plays_each_entry_as_a_writer_or_as_a_reader_never_both() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../../../spec/validations.json"))
            .expect("validation vectors");
    let details = vectors["details"].as_array().expect("details");
    assert_ne!(details.len(), 0);
    for entry in details {
        assert_ne!(
            entry.get("read").is_some(),
            entry.get("write").is_some(),
            "{}",
            entry["name"]
        );
    }
}

#[test]
fn keeps_the_whole_lines_of_a_detail_its_reader_cut() {
    let detail = detail(vec![from(), name()], 3);
    let first = detail.find('\n').expect("two violations");
    assert_eq!(read(&detail), shown(vec![from(), name()], Some(3)));
    for end in [first.saturating_add(20), first.saturating_add(1), first] {
        assert_eq!(
            read(detail.get(..end).expect("an ASCII detail cut")),
            shown(vec![from()], None)
        );
    }
    let closing = detail.rfind('\n').expect("a closing line");
    assert_eq!(
        read(
            detail
                .get(..closing)
                .expect("the closing line begins in ASCII")
        ),
        shown(vec![from(), name()], None)
    );
}

#[test]
fn reads_no_violations_from_a_detail_empty_cut_or_of_another_form() {
    let whole = detail(vec![from()], 0);
    for malformed in [
        "",
        r#"{"bounds":{"lte""#,
        "the request is invalid",
        whole.get(..10).expect("an ASCII prefix"),
        &format!("{{\"error\":\"invalid\"}}\n{whole}"),
        "{\"error\":\"invalid\"}\n{\"more\":0}",
        "{\"error\":\"invalid\"}\n{\"ruleId\":\"required\"}\n{\"more\":0}",
        "[1,2,3]",
        "{\"fieldPath\":\"from\"}\n{\"more\":0}",
        "{\"bounds\":[10],\"ruleId\":\"int32.lte\"}\n{\"more\":0}",
        "{\"message\":10,\"ruleId\":\"int32.lte\"}\n{\"more\":0}",
        "{\"forKey\":\"true\",\"ruleId\":\"required\"}\n{\"more\":0}",
        r#"{"stopped":false}"#,
        "\u{feff}{\"ruleId\":\"required\"}",
    ] {
        assert_eq!(read(malformed), ReadViolations::default(), "{malformed}");
    }
    let valid = "{\"ruleId\":\"required\"}\n{\"more\":0}";
    for (code, scope) in [
        (ProtocolCode::PROCEDURE_FAILED, FailureScope::Protocol),
        (ProtocolCode::PAYLOAD_UNDECODABLE, FailureScope::Protocol),
        (ProtocolCode::PAYLOAD_INVALID, FailureScope::Application),
    ] {
        assert_eq!(
            violations_of(&super::failure_of((code.get(), scope), valid)),
            ReadViolations::default()
        );
    }
    assert_eq!(
        read(valid),
        shown(
            vec![Violation {
                rule_id: "required".to_owned(),
                ..Violation::default()
            }],
            Some(0)
        )
    );
    assert_eq!(read(&whole), shown(vec![from()], Some(0)));
}

#[test]
fn reads_for_key_on_the_violation_of_a_map_key_its_other_members_beside_it() {
    let key = Violation {
        bounds: Some(json!({"min_len": "2"}).as_object().expect("bounds").clone()),
        field_path: Some("labels[\"a\"]".to_owned()),
        for_key: true,
        message: Some("must be at least 2 characters".to_owned()),
        rule_id: "string.min_len".to_owned(),
        ..Violation::default()
    };
    assert_eq!(
        read(&detail(vec![key.clone()], 0)),
        shown(vec![key.clone()], Some(0))
    );
    assert_eq!(
        read(
            r#"{"bounds":{"min_len":"2"},"fieldPath":"labels[\"a\"]","forKey":true,"ruleId":"string.min_len"}"#
        ),
        shown(vec![key], None)
    );
}

#[test]
fn takes_a_member_empty_as_absent_its_line_kept_and_an_empty_rule_id_as_an_id() {
    assert_eq!(
        read(
            "{\"bounds\":{},\"fieldPath\":\"\",\"forKey\":false,\"message\":\"\",\"ruleId\":\"required\"}\n{\"more\":0}"
        ),
        shown(
            vec![Violation {
                rule_id: "required".to_owned(),
                ..Violation::default()
            }],
            Some(0)
        )
    );
    assert_eq!(
        read(r#"{"bounds":{"lte":10},"fieldPath":"from","message":"","ruleId":"int32.lte"}"#),
        shown(vec![from()], None)
    );
    assert_eq!(
        read("{\"ruleId\":\"\"}\n{\"message\":\"must be even\",\"ruleId\":\"\"}\n{\"more\":1}"),
        shown(
            vec![
                Violation::default(),
                Violation {
                    message: Some("must be even".to_owned()),
                    ..Violation::default()
                }
            ],
            Some(1)
        )
    );
}

#[test]
fn reads_a_closing_count_from_0_to_the_largest_integer_i_json_holds_and_none_past_it_nor_of_a_fraction()
 {
    let line = r#"{"bounds":{"lte":10},"fieldPath":"from","message":"must be less than or equal to 10","ruleId":"int32.lte"}"#;
    for (number, count) in [
        ("0", 0),
        ("9007199254740991", 9_007_199_254_740_991),
        ("1e2", 100),
    ] {
        assert_eq!(
            read(&format!("{line}\n{{\"more\":{number}}}")),
            shown(vec![from()], Some(count))
        );
    }
    for number in [
        "9007199254740992",
        "1e300",
        "1.5",
        "-1",
        "\"3\"",
        "true",
        "null",
    ] {
        assert_eq!(
            read(&format!("{line}\n{{\"more\":{number}}}")),
            shown(vec![from()], None),
            "{number}"
        );
    }
}

#[test]
fn writes_no_member_empty_and_a_count_past_the_largest_integer_i_json_holds_as_it() {
    let empty = Violation {
        bounds: Some(serde_json::Map::new()),
        field_path: Some(String::new()),
        message: Some(String::new()),
        rule_id: "required".to_owned(),
        ..Violation::default()
    };
    assert_eq!(
        detail(vec![empty], 0),
        "{\"ruleId\":\"required\"}\n{\"more\":0}"
    );
    assert_eq!(detail(vec![], 1 << 60), r#"{"more":9007199254740991}"#);
}

#[test]
fn leaves_the_value_a_violation_broke_on_the_side_that_judged() {
    let violation = Violation {
        value: Some(json!(11)),
        ..from()
    };
    assert_eq!(
        detail(vec![violation], 0),
        "{\"bounds\":{\"lte\":10},\"fieldPath\":\"from\",\"message\":\"must be less than or equal to 10\",\"ruleId\":\"int32.lte\"}\n{\"more\":0}"
    );
}

#[test]
fn bounds_a_detail_by_maximum_detail_bytes_and_by_an_envelope_less_its_32_bytes_beside_it() {
    assert_eq!(detail_bound_of(1_024, 16_778_240), 1_024);
    assert_eq!(detail_bound_of(1_024, 100), 68);
    assert_eq!(detail_bound_of(0, 64), 0);
}

#[test]
fn refuses_a_request_a_violation_is_held_or_counted_of_and_takes_one_of_none() {
    assert!(!is_refused(&Judged::default()));
    assert!(is_refused(&Judged {
        more: 1,
        stopped: true,
        ..Judged::default()
    }));
    assert!(is_refused(&Judged {
        violations: vec![from()],
        ..Judged::default()
    }));
}
