//! The validators' runtime: the sink's bounds, its paths and its values, and the readings 18.8
//! fixes. The twin of the TypeScript side's `validate.test.ts` and the C# side's `ValidatorsTests`,
//! sentence for sentence, but the verdicts, which `tests/validations.rs` plays through the
//! validators beadc generates. The rules here are written by hand, as beadc writes them: each
//! field judged in spec 18.5's order, each rule a constant site.

use core::cell::Cell;
use std::collections::HashMap;

use bead::{Judged, ValidateOptions, Violation, violations_detail_of};
use serde_json::{Map, Value, json};

use super::{
    MapKey, RuleItems, RuleValue, ViolationRule, ViolationSink, bytes_contain, bytes_end_with,
    bytes_equal, bytes_start_with, code_point_length, entries_by_key, is_unique, judge_rules,
    utf8_length, validator_of,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const EMPTY: ViolationRule = ViolationRule {
    rule_id: "string.min_len",
    message: "must be at least 1 characters",
    bounds: Some(r#"{"min_len":"1"}"#),
    for_key: false,
};

const REQUIRED: ViolationRule = ViolationRule {
    rule_id: "required",
    message: "value is required",
    bounds: None,
    for_key: false,
};

#[expect(
    clippy::disallowed_methods,
    reason = "the test repeats its own string a bounded number of times"
)]
fn repeated(text: &str, count: usize) -> String {
    text.repeat(count)
}

fn options_of(fail_fast: bool, maximum_bytes: Option<usize>) -> ValidateOptions {
    let mut options = ValidateOptions::default();

    options.fail_fast = Some(fail_fast);
    options.maximum_bytes = maximum_bytes;

    options
}

fn whole() -> ValidateOptions {
    options_of(false, None)
}

fn bounds_of(value: &Value) -> Option<Map<String, Value>> {
    value.as_object().cloned()
}

// a violation as the wire carries it: its value left on the side that judged
fn sent(violation: &Violation) -> Violation {
    Violation {
        value: None,
        ..violation.clone()
    }
}

fn judged_of(judged: &Judged) -> (Vec<Violation>, u64, bool) {
    (
        judged.violations.iter().map(sent).collect(),
        judged.more,
        judged.stopped,
    )
}

fn violation_of((rule, field_path): (&ViolationRule, &str)) -> Violation {
    Violation {
        bounds: rule
            .bounds
            .and_then(|bounds| serde_json::from_str(bounds).ok()),
        field_path: Some(field_path.to_owned()),
        for_key: rule.for_key,
        message: Some(rule.message.to_owned()),
        rule_id: rule.rule_id.to_owned(),
        value: None,
    }
}

// ── The messages, as their generated rules read them ──────────────────────────

// fields declared out of their numbers, each breaking its rule, then the message's own
#[derive(Default)]
struct Order {
    late: Option<String>,
    early: Option<i32>,
    inner_name: Option<String>,
    p: Option<String>,
    q: Option<String>,
    choice: Option<String>,
}

const ORDER_INNER_NAME: ViolationRule = EMPTY;
const ORDER_EARLY: ViolationRule = ViolationRule {
    rule_id: "int32.gt",
    message: "must be greater than 1",
    bounds: Some(r#"{"gt":1}"#),
    for_key: false,
};
const ORDER_LATE: ViolationRule = EMPTY;
const ORDER_ONEOF: ViolationRule = ViolationRule {
    rule_id: "message.oneof",
    message: "one of p, q must be set",
    bounds: None,
    for_key: false,
};
const ORDER_CHOICE: ViolationRule = REQUIRED;

fn rules_of_order(order: &Order, sink: &mut dyn ViolationSink) -> bool {
    if let Some(name) = &order.inner_name {
        sink.enter("inner");
        sink.enter("name");

        if code_point_length(name) < 1 && sink.add(&ORDER_INNER_NAME, RuleValue::Text(name)) {
            return true;
        }

        sink.leave();
        sink.leave();
    }

    if let Some(early) = order.early {
        sink.enter("early");

        if early <= 1 && sink.add(&ORDER_EARLY, RuleValue::Signed(i64::from(early))) {
            return true;
        }

        sink.leave();
    }

    if let Some(late) = &order.late {
        sink.enter("late");

        if code_point_length(late) < 1 && sink.add(&ORDER_LATE, RuleValue::Text(late)) {
            return true;
        }

        sink.leave();
    }

    if order.p.is_none() && order.q.is_none() && sink.add(&ORDER_ONEOF, RuleValue::Absent) {
        return true;
    }

    if order.choice.is_none() {
        sink.enter("choice");

        if sink.add(&ORDER_CHOICE, RuleValue::Absent) {
            return true;
        }

        sink.leave();
    }

    false
}

// numbers, each optional
#[derive(Default)]
struct Numbers {
    at_most_ten: Option<i32>,
    above_zero: Option<i32>,
}

const NUMBERS_AT_MOST_TEN: ViolationRule = ViolationRule {
    rule_id: "int32.lte",
    message: "must be less than or equal to 10",
    bounds: Some(r#"{"lte":10}"#),
    for_key: false,
};
const NUMBERS_ABOVE_ZERO: ViolationRule = ViolationRule {
    rule_id: "int32.gt",
    message: "must be greater than 0",
    bounds: Some(r#"{"gt":0}"#),
    for_key: false,
};

fn rules_of_numbers(numbers: &Numbers, sink: &mut dyn ViolationSink) -> bool {
    if let Some(value) = numbers.at_most_ten {
        sink.enter("at_most_ten");

        if value > 10 && sink.add(&NUMBERS_AT_MOST_TEN, RuleValue::Signed(i64::from(value))) {
            return true;
        }

        sink.leave();
    }

    if let Some(value) = numbers.above_zero {
        sink.enter("above_zero");

        if value <= 0 && sink.add(&NUMBERS_ABOVE_ZERO, RuleValue::Signed(i64::from(value))) {
            return true;
        }

        sink.leave();
    }

    false
}

// a list of names, each of 1 character or more, and at most 50 of them
#[derive(Default)]
struct Repeated {
    many: Vec<String>,
    names: Vec<String>,
}

const REPEATED_NAMES: ViolationRule = ViolationRule {
    rule_id: "repeated.max_items",
    message: "must contain no more than 50 item(s)",
    bounds: Some(r#"{"max_items":"50"}"#),
    for_key: false,
};

fn rules_of_repeated(repeated: &Repeated, sink: &mut dyn ViolationSink) -> bool {
    sink.enter("names");

    if repeated.names.len() > 50 && sink.add(&REPEATED_NAMES, RuleValue::Items(&repeated.names)) {
        return true;
    }

    sink.leave();

    for (index, item) in repeated.many.iter().enumerate() {
        sink.enter_index("many", index);

        if code_point_length(item) < 1 && sink.add(&EMPTY, RuleValue::Text(item)) {
            return true;
        }

        sink.leave();
    }

    false
}

// wrappers, each a message set or not, its value judged once set
#[derive(Default)]
struct Wrappers {
    count: Option<i32>,
    title: Option<String>,
    port: Option<u32>,
}

const WRAPPERS_COUNT: ViolationRule = NUMBERS_ABOVE_ZERO;
const WRAPPERS_PORT: ViolationRule = ViolationRule {
    rule_id: "uint32.lte",
    message: "must be less than or equal to 65535",
    bounds: Some(r#"{"lte":65535}"#),
    for_key: false,
};

fn rules_of_wrappers(wrappers: &Wrappers, sink: &mut dyn ViolationSink) -> bool {
    if let Some(count) = wrappers.count {
        sink.enter("count");

        if count <= 0 && sink.add(&WRAPPERS_COUNT, RuleValue::Signed(i64::from(count))) {
            return true;
        }

        sink.leave();
    }

    sink.enter("title");

    match &wrappers.title {
        None => {
            if sink.add(&REQUIRED, RuleValue::Absent) {
                return true;
            }
        }
        Some(title) => {
            if code_point_length(title) < 1 && sink.add(&EMPTY, RuleValue::Text(title)) {
                return true;
            }
        }
    }

    sink.leave();

    if let Some(port) = wrappers.port {
        sink.enter("port");

        if port > 65_535 && sink.add(&WRAPPERS_PORT, RuleValue::Unsigned(u64::from(port))) {
            return true;
        }

        sink.leave();
    }

    false
}

// a list that counts how often a sink reads it whole
struct Counted {
    items: Vec<String>,
    reads: Cell<usize>,
}

impl RuleItems for Counted {
    fn each<'a>(&'a self, visit: &mut dyn FnMut(Option<MapKey<'a>>, RuleValue<'a>)) {
        self.reads.set(self.reads.get().saturating_add(1));

        for item in &self.items {
            visit(None, RuleValue::Text(item));
        }
    }
}

// ── validator_of ──────────────────────────────────────────────────────────────

#[test]
fn stops_at_the_first_violation_with_fail_fast_the_first_of_its_order() {
    let validate = validator_of(rules_of_order);
    let request = Order {
        early: Some(1),
        inner_name: Some(String::new()),
        late: Some(String::new()),
        ..Order::default()
    };
    let every = validate(&request, &whole()).expect("judged");
    let first = validate(&request, &options_of(true, None)).expect("judged");

    assert_eq!(
        every
            .violations
            .iter()
            .map(|violation| format!(
                "{} {}",
                violation.field_path.as_deref().unwrap_or_default(),
                violation.rule_id
            ))
            .collect::<Vec<_>>(),
        [
            "inner.name string.min_len",
            "early int32.gt",
            "late string.min_len",
            " message.oneof",
            "choice required",
        ],
        "every violation, in its order"
    );
    assert!(!every.stopped, "not stopped");
    assert_eq!(
        judged_of(&first),
        (judged_of(&every).0.into_iter().take(1).collect(), 0, true),
        "the first alone, stopped"
    );
    assert!(
        violations_detail_of(&first, 1_024).ends_with("\n{\"stopped\":true}"),
        "its detail closes stopped"
    );
}

#[test]
fn judges_a_request_that_breaks_nothing_and_allocates_no_path() {
    let validate = validator_of(rules_of_numbers);
    let ten = validate(
        &Numbers {
            at_most_ten: Some(10),
            ..Numbers::default()
        },
        &whole(),
    )
    .expect("judged");
    let one = validate(
        &Numbers {
            at_most_ten: Some(1),
            above_zero: Some(3),
        },
        &whole(),
    )
    .expect("judged");

    // * one judging for every request that breaks nothing: no violation is made
    assert_eq!(ten, Judged::default(), "nothing broken");
    assert_eq!(one, Judged::default(), "nothing broken");
    assert_eq!(ten.violations.capacity(), 0, "no violation allocated");

    // a step that breaks nothing renders no subscript
    let stepped = judge_rules(
        |sink| {
            sink.enter_key("labels", MapKey::Text(&repeated("k", 1_000)));
            sink.enter_index("items", 7);
            sink.leave();
            sink.leave();

            false
        },
        &whole(),
    )
    .expect("judged");

    assert_eq!(stepped, Judged::default(), "nothing broken");
    assert_eq!(stepped.violations.capacity(), 0, "no violation allocated");
}

#[test]
fn holds_no_more_than_its_bound_of_a_request_that_breaks_every_item_and_counts_the_rest() {
    let validate = validator_of(rules_of_repeated);
    let request = Repeated {
        many: vec![String::new(); 100_000],
        names: vec!["a".to_owned()],
    };
    let judged = validate(&request, &options_of(false, Some(1_024))).expect("judged");
    let detail = violations_detail_of(&judged, 1_024);
    let held = u64::try_from(judged.violations.len()).expect("a count");

    assert!(!judged.violations.is_empty(), "some held");
    assert!(
        judged.violations.len() <= 10,
        "no more than the bound holds"
    );
    assert_eq!(held + judged.more, 100_000, "the rest counted");
    assert!(
        !detail.is_empty() && detail.len() <= 1_024,
        "its detail within its bound"
    );
    assert!(
        detail.ends_with(&format!("\n{{\"more\":{}}}", judged.more)),
        "its detail closes on the count"
    );
    // unbounded, it holds every one
    assert_eq!(
        validate(&request, &whole())
            .expect("judged")
            .violations
            .len(),
        100_000,
        "every one held"
    );

    // * no value is made past the bound: a list read whole for a violation held alone
    let counted = Counted {
        items: vec!["a".to_owned(); 3],
        reads: Cell::new(0),
    };
    let every = judge_rules(
        |sink| {
            for index in 0..100_000 {
                sink.enter_index("lists", index);

                if sink.add(&REPEATED_NAMES, RuleValue::Items(&counted)) {
                    return true;
                }

                sink.leave();
            }

            false
        },
        &options_of(false, Some(1_024)),
    )
    .expect("judged");

    assert!(!every.violations.is_empty(), "some held");
    assert_eq!(
        counted.reads.get(),
        every.violations.len(),
        "a list read for each violation held, and for none past the bound"
    );
    assert_eq!(
        every
            .violations
            .first()
            .and_then(|violation| violation.value.clone()),
        Some(json!(["a", "a", "a"])),
        "the list kept whole"
    );
}

#[test]
fn judges_a_wrapper_s_value_once_set_and_its_required_while_unset() {
    let validate = validator_of(rules_of_wrappers);

    assert_eq!(
        judged_of(&validate(&Wrappers::default(), &whole()).expect("judged")),
        (vec![violation_of((&REQUIRED, "title"))], 0, false),
        "its required while unset"
    );
    // * its path the field's alone, never its value's
    assert_eq!(
        judged_of(
            &validate(
                &Wrappers {
                    count: Some(0),
                    port: Some(65_536),
                    title: Some(String::new()),
                },
                &whole()
            )
            .expect("judged")
        )
        .0,
        [
            violation_of((&WRAPPERS_COUNT, "count")),
            violation_of((&EMPTY, "title")),
            violation_of((&WRAPPERS_PORT, "port")),
        ],
        "each value judged once set"
    );
    assert_eq!(
        validate(
            &Wrappers {
                count: Some(1),
                title: Some("a".to_owned()),
                ..Wrappers::default()
            },
            &whole()
        )
        .expect("judged"),
        Judged::default(),
        "nothing broken"
    );
}

#[test]
fn keeps_the_value_a_violation_broke_on_the_side_that_judged() {
    let validate = validator_of(rules_of_numbers);

    assert_eq!(
        validate(
            &Numbers {
                at_most_ten: Some(11),
                ..Numbers::default()
            },
            &whole()
        )
        .expect("judged")
        .violations,
        [Violation {
            bounds: bounds_of(&json!({ "lte": 10 })),
            field_path: Some("at_most_ten".to_owned()),
            for_key: false,
            message: Some("must be less than or equal to 10".to_owned()),
            rule_id: "int32.lte".to_owned(),
            value: Some(json!(11)),
        }],
        "its value kept"
    );

    // * each kind as protobuf's JSON mapping writes it: bytes as their base64, a float that is no
    // number by its name, a map by its keys
    let labels = HashMap::from([("k".to_owned(), 1_i32)]);
    let values = [
        (RuleValue::Bytes(&[0xFB, 0xFF]), json!("+/8=")),
        (RuleValue::Bytes(b"abc"), json!("YWJj")),
        (RuleValue::Float(f64::NAN), json!("NaN")),
        (RuleValue::Float(f64::NEG_INFINITY), json!("-Infinity")),
        (RuleValue::Float(0.5), json!(0.5)),
        (RuleValue::Unsigned(u64::MAX), json!(u64::MAX)),
        (RuleValue::Bool(true), json!(true)),
        (RuleValue::Items(&labels), json!({ "k": 1 })),
    ];

    for (value, expected) in values {
        let judged = judge_rules(|sink| sink.add(&EMPTY, value), &whole()).expect("judged");

        assert_eq!(
            judged
                .violations
                .first()
                .and_then(|violation| violation.value.clone()),
            Some(expected),
            "{value:?}"
        );
    }

    let absent = judge_rules(|sink| sink.add(&EMPTY, RuleValue::Absent), &whole()).expect("judged");

    assert_eq!(
        absent
            .violations
            .first()
            .map(|violation| violation.value.clone()),
        Some(None),
        "a message's value kept absent"
    );
}

// ── judge_rules ───────────────────────────────────────────────────────────────

#[test]
fn holds_every_violation_without_a_bound_and_stops_where_its_rules_say_so_under_fail_fast() {
    let rules = |sink: &mut dyn ViolationSink| {
        for index in 0..3 {
            sink.enter_index("names", index);

            if sink.add(&EMPTY, RuleValue::Text("")) {
                return true;
            }

            sink.leave();
        }

        false
    };

    assert_eq!(
        judge_rules(rules, &whole())
            .expect("judged")
            .violations
            .iter()
            .map(|violation| violation.field_path.clone().unwrap_or_default())
            .collect::<Vec<_>>(),
        ["names[0]", "names[1]", "names[2]"],
        "every one held"
    );
    assert_eq!(
        judged_of(&judge_rules(rules, &options_of(true, None)).expect("judged")),
        (vec![violation_of((&EMPTY, "names[0]"))], 0, true),
        "the first, stopped"
    );
    // a bound that holds no line of it: counted, and stopped all the same
    assert_eq!(
        judged_of(&judge_rules(rules, &options_of(true, Some(0))).expect("judged")),
        (Vec::new(), 1, true),
        "counted, stopped"
    );
}

#[test]
fn renders_a_key_as_spec_18_4_does_whole_within_64_bytes_else_cut_on_a_character_and_marked() {
    let path_of = |key: MapKey<'_>| {
        judge_rules(
            |sink| {
                sink.enter_key("keyed", key);

                sink.add(&EMPTY, RuleValue::Absent)
            },
            &whole(),
        )
        .expect("judged")
        .violations
        .first()
        .and_then(|violation| violation.field_path.clone())
    };
    let long = format!("{}é", repeated("k", 63));

    assert_eq!(
        path_of(MapKey::Text("a\tb\u{1}")).as_deref(),
        Some(r#"keyed["a\tb\u0001"]"#),
        "a string in section 17.7's form"
    );
    assert_eq!(
        path_of(MapKey::Signed(-1)).as_deref(),
        Some("keyed[-1]"),
        "signed"
    );
    assert_eq!(
        path_of(MapKey::Unsigned(u64::MAX)).as_deref(),
        Some("keyed[18446744073709551615]"),
        "unsigned"
    );
    assert_eq!(
        path_of(MapKey::Bool(true)).as_deref(),
        Some("keyed[true]"),
        "a boolean"
    );
    assert_eq!(
        path_of(MapKey::Text(&long)),
        Some(format!("keyed[\"{}\"...]", repeated("k", 63))),
        "cut back to a character's start, and marked"
    );
    assert_eq!(
        path_of(MapKey::Text(&repeated("k", 64))),
        Some(format!("keyed[\"{}\"]", repeated("k", 64))),
        "64 bytes whole"
    );
    // ! a Rust string holds no surrogate: the reader refuses its UTF-8, where the other sides read
    // it as U+FFFD
    assert_eq!(
        path_of(MapKey::Text("\u{FFFD}")).as_deref(),
        Some("keyed[\"\u{FFFD}\"]"),
        "U+FFFD as it is"
    );
}

// ── The readings ──────────────────────────────────────────────────────────────

#[test]
fn counts_a_string_in_code_points_and_in_utf_8_bytes() {
    assert_eq!(code_point_length("😀ab"), 3, "code points");
    assert_eq!(utf8_length("😀ab"), 6, "UTF-8 bytes");
}

#[test]
fn holds_items_unique_as_equals_compares_them_0_and_minus_0_one_two_nan_two_bytes_by_their_bytes() {
    assert!(!is_unique(&vec![0.0_f64, -0.0]), "0 and -0 one");
    assert!(is_unique(&vec![f64::NAN, f64::NAN]), "two NaN two");
    assert!(
        !is_unique(&vec![f64::NAN, f64::NAN, 1.0, 1.0]),
        "1 twice, whatever the NaN"
    );
    assert!(!is_unique(&vec![1_i64, 1]), "an integer twice");
    assert!(
        !is_unique(&vec![vec![1_u8], vec![1]]),
        "bytes by their bytes"
    );
    assert!(is_unique(&vec![vec![1_u8], vec![2]]), "two byte strings");
}

#[test]
fn orders_a_map_s_entries_by_key_integers_ascending_false_before_true_strings_by_code_points() {
    fn keys_of<K: Ord + Clone>(map: &HashMap<K, i32>) -> Vec<K> {
        entries_by_key(map)
            .into_iter()
            .map(|entry| entry.key.clone())
            .collect()
    }

    assert_eq!(
        keys_of(&HashMap::from([(10_i64, 0), (3, 0), (-1, 0)])),
        [-1, 3, 10],
        "integers ascending"
    );
    assert_eq!(
        keys_of(&HashMap::from([(true, 0), (false, 0)])),
        [false, true],
        "false before true"
    );
    assert_eq!(
        keys_of(&HashMap::from([
            ("\u{E000}".to_owned(), 0),
            ("😀".to_owned(), 0),
            ("zz".to_owned(), 0),
            ("a".to_owned(), 0),
        ])),
        ["a", "zz", "\u{E000}", "😀"],
        "strings by code points"
    );
    assert!(
        keys_of(&HashMap::<String, i32>::new()).is_empty(),
        "none of none"
    );
}

#[test]
fn orders_string_map_keys_by_code_points_with_each_prefix_before_its_extensions() {
    let expected = [
        ("", "empty"),
        ("a", "prefix"),
        ("ab", "ascii extension"),
        ("a\u{E000}", "BMP extension"),
        ("a😀", "astral extension"),
        ("\u{E000}", "BMP"),
        ("😀", "astral"),
        ("😀a", "astral prefix"),
    ];

    for reversed in [false, true] {
        let mut entries = expected.to_vec();

        if reversed {
            entries.reverse();
        }

        let map: HashMap<String, String> = entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
            .collect();
        let ordered: Vec<(&str, &str)> = entries_by_key(&map)
            .into_iter()
            .map(|entry| (entry.key.as_str(), entry.value.as_str()))
            .collect();

        assert_eq!(ordered, expected, "by code points");
    }
}

#[test]
fn orders_both_boolean_map_keys_with_their_values_in_either_insertion_order() {
    for map in [
        HashMap::from([(true, "yes"), (false, "no")]),
        HashMap::from([(false, "no"), (true, "yes")]),
    ] {
        let ordered: Vec<(bool, &str)> = entries_by_key(&map)
            .into_iter()
            .map(|entry| (*entry.key, *entry.value))
            .collect();

        assert_eq!(ordered, [(false, "no"), (true, "yes")], "false first");
    }
}

#[test]
fn compares_byte_strings_at_their_exact_boundaries_and_finds_nonempty_parts() {
    let bytes = [1_u8, 2, 1, 3];
    let cases: [(&[u8], [bool; 4]); 7] = [
        (&[], [false, true, true, true]),
        (&[1, 2, 1, 3], [true, true, true, true]),
        (&[1, 2], [false, true, false, true]),
        (&[1, 3], [false, false, true, true]),
        (&[2, 1], [false, false, false, true]),
        (&[1, 1], [false, false, false, false]),
        (&[1, 2, 1, 3, 4], [false, false, false, false]),
    ];

    for (part, expected) in cases {
        assert_eq!(
            [
                bytes_equal(&bytes, part),
                bytes_start_with(&bytes, part),
                bytes_end_with(&bytes, part),
                bytes_contain(&bytes, part),
            ],
            expected,
            "{part:?}"
        );
    }
}
