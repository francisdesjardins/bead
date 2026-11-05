//! Rule words come from their templates and the bounds the rule takes.

use serde_json::{Value, json};

use crate::violations::{Violation, words_of};

fn words(rule_id: &str, bounds: Value) -> Option<String> {
    words_of(&Violation {
        rule_id: rule_id.to_owned(),
        bounds: match bounds {
            Value::Object(bounds) => Some(bounds),
            Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::String(_)
            | Value::Array(_) => None,
        },
        ..Violation::default()
    })
}

#[test]
fn gives_a_rules_words_from_its_id_and_its_bounds_and_none_where_they_depend_on_what_was_judged() {
    for (rule, bounds, expected) in [
        (
            "int32.gte_lte",
            json!({"gte": 0, "lte": 10}),
            "must be greater than or equal to 0 and less than or equal to 10",
        ),
        (
            "double.gt_lt_exclusive",
            json!({"gt": 10, "lt": 5}),
            "must be greater than 10 or less than 5",
        ),
        (
            "string.in",
            json!({"in": ["a", "b"]}),
            "must be in list [a, b]",
        ),
        (
            "bytes.prefix",
            json!({"prefix": "iVBORw=="}),
            "does not have prefix 89504e47",
        ),
        (
            "enum.defined_only",
            Value::Null,
            "value must be one of the defined enum values",
        ),
    ] {
        assert_eq!(words(rule, bounds).as_deref(), Some(expected), "{rule}");
    }
    for (rule, bounds) in [
        ("required", Value::Null),
        ("message.oneof", json!({"fields": ["x", "y"]})),
        ("int32.lte", json!({})),
    ] {
        assert_eq!(words(rule, bounds), None, "{rule}");
    }
}

#[test]
fn gives_every_violation_of_the_verdicts_the_words_of_its_rule_and_its_bounds_and_none_where_they_depend_on_what_was_judged()
 {
    let vectors: Value =
        serde_json::from_str(include_str!("../../../../../../../spec/validations.json"))
            .expect("validation vectors");
    let violations = vectors["verdicts"]
        .as_array()
        .expect("verdicts")
        .iter()
        .flat_map(|verdict| verdict["violations"].as_array().expect("violations"))
        .collect::<Vec<_>>();
    assert_ne!(violations.len(), 0);
    for violation in violations {
        let rule = violation["ruleId"].as_str().expect("a rule");
        let expected = if matches!(rule, "required" | "message.oneof") {
            None
        } else {
            violation["message"].as_str()
        };
        assert_eq!(
            words(rule, violation["bounds"].clone()).as_deref(),
            expected,
            "{rule}"
        );
    }
}

#[test]
fn gives_no_words_where_the_bounds_lack_what_its_rule_needs_or_its_rule_is_none_it_renders() {
    for rule in [
        "string.const",
        "string.min_len",
        "string.prefix",
        "string.in",
        "bytes.const",
        "bytes.max_len",
        "bool.const",
        "enum.in",
        "int32.const",
        "int32.gt",
        "int32.not_in",
        "repeated.min_items",
        "map.max_pairs",
        "bool.in",
        "enum.lt",
    ] {
        assert_eq!(words(rule, json!({})), None, "{rule}");
    }
    for (rule, bounds) in [
        ("int32.gte_lte", json!({"gte": 0})),
        ("double.gt_lt_exclusive", json!({"lt": 5})),
        ("int32.in", json!({"in": [1, {}]})),
        ("string.not_in", json!({"not_in": [null]})),
        ("bytes.prefix", json!({"prefix": "!!!"})),
        ("bytes.const", json!({"const": "!!!"})),
        ("uint64.lte", json!({"lte": null})),
        ("string.const", json!({"const": {"value": 1}})),
        ("string.email", json!({"email": true})),
        ("bytes.ip", json!({"ip": true})),
        ("repeated.items", json!({"items": {"min_len": "1"}})),
        ("map.keys", json!({"keys": {"min_len": "1"}})),
        ("int32.finite", json!({"finite": true})),
        ("int32.lt_gt", json!({"lt": 1, "gt": 2})),
        ("duration.gt", json!({"gt": "1s"})),
        ("timestamp.lt_now", json!({"lt_now": true})),
        ("oneof", json!({"fields": ["x"]})),
    ] {
        assert_eq!(words(rule, bounds), None, "{rule}");
    }
    assert_eq!(
        words("int32.lte", json!({"lte": true})).as_deref(),
        Some("must be less than or equal to true")
    );
    assert_eq!(
        words("bool.const", json!({"const": false})).as_deref(),
        Some("must equal false")
    );
}

#[test]
fn gives_words_to_the_rules_beadc_compiles_alone_by_their_templates() {
    assert_eq!(
        words("string.pattern", json!({"pattern": "^a$"})).as_deref(),
        Some("does not match regex pattern `^a$`")
    );
    assert_eq!(
        words("repeated.min_items", json!({"min_items": "2"})).as_deref(),
        Some("must contain at least 2 item(s)")
    );
    assert_eq!(
        words("float.finite", Value::Null).as_deref(),
        Some("must be finite")
    );
    for (rule, bounds) in [
        ("bytes.pattern", json!({"pattern": "^a$"})),
        ("bytes.in", json!({"in": ["AQI="]})),
        ("bytes.not_in", json!({"not_in": ["AQI="]})),
        ("bool.in", json!({"in": [true]})),
        ("enum.gt_lt", json!({"gt": 1, "lt": 3})),
        ("repeated.const", json!({"const": 1})),
        ("", json!({"lte": 1})),
        ("constructor", json!({"lte": 1})),
    ] {
        assert_eq!(words(rule, bounds), None, "{rule}");
    }
}

#[test]
fn takes_a_list_for_in_and_not_in_alone_and_a_scalar_for_every_other_member() {
    assert_eq!(
        words("int32.in", json!({"in": [1, "a", true]})).as_deref(),
        Some("must be in list [1, a, true]")
    );
    assert_eq!(
        words("string.not_in", json!({"not_in": []})).as_deref(),
        Some("must not be in list []")
    );
    for bounds in [
        json!({"in": 1}),
        json!({"in": [[1]]}),
        json!({"in": [1, [2]]}),
        json!({"in": "a"}),
    ] {
        assert_eq!(words("int32.in", bounds), None);
    }
    for bounds in [
        json!({"lte": [1]}),
        json!({"lte": {}}),
        json!({"lte": null}),
    ] {
        assert_eq!(words("int32.lte", bounds), None);
    }
}

#[test]
fn takes_bytes_in_base64_as_rfc_4648_writes_it_alone_padded_of_its_standard_alphabet() {
    for (rule, bounds, expected) in [
        ("bytes.const", json!({"const": "AP8="}), "must be 00ff"),
        (
            "bytes.suffix",
            json!({"suffix": "AQ=="}),
            "does not have suffix 01",
        ),
        (
            "bytes.contains",
            json!({"contains": "AQID"}),
            "does not contain 010203",
        ),
        ("bytes.const", json!({"const": "AR=="}), "must be 01"),
    ] {
        assert_eq!(words(rule, bounds).as_deref(), Some(expected));
    }
    for text in [
        "AP8", "-_8=", "AP 8=", "AP8=\n", "A===", "AP8=AP8=", "!!!!", "AQ=",
    ] {
        assert_eq!(words("bytes.const", json!({"const": text})), None, "{text}");
    }
}
