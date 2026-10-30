//! The violations of a request's rules: whether a judging refuses, the detail it writes within its
//! bound, and that detail read back.

use core::num::NonZeroU16;

use super::{
    CLOSING_BYTES, Judged, Violation, detail_bound_of, is_refused, violations_detail_of,
    violations_of,
};
use crate::constants::{FailureScope, ProtocolCode};

fn violation(rule_id: &str) -> Violation {
    Violation {
        field_path: Some("names".to_owned()),
        message: Some("value is required".to_owned()),
        rule_id: rule_id.to_owned(),
        ..Violation::default()
    }
}

#[test]
fn refuses_a_request_with_a_violation_held_or_one_counted_past_its_bound() {
    assert!(!is_refused(&Judged::default()), "none");
    assert!(
        is_refused(&Judged {
            violations: vec![violation("required")],
            ..Judged::default()
        }),
        "one held"
    );
    assert!(
        is_refused(&Judged {
            more: 1,
            ..Judged::default()
        }),
        "one counted"
    );
}

#[test]
fn bounds_a_detail_by_the_router_s_limits() {
    assert_eq!(detail_bound_of(1_024, 16_778_240), 1_024, "its own bound");
    assert_eq!(
        detail_bound_of(1_024, 64),
        32,
        "an envelope's room beside the rest"
    );
    assert_eq!(CLOSING_BYTES, 26, "the closing line at its longest");
}

#[test]
fn writes_each_violation_a_line_then_its_count_and_reads_them_back() {
    let judged = Judged {
        violations: vec![violation("required"), violation("string.min_len")],
        more: 3,
        stopped: false,
    };
    let detail = violations_detail_of(&judged, 1_024);
    let invalid = ProtocolCode::PAYLOAD_INVALID.get();
    let read = violations_of((invalid, FailureScope::Protocol), &detail);

    assert_eq!(
        detail.lines().count(),
        3,
        "two lines, then its closing: {detail}"
    );
    assert_eq!(read.violations.len(), 2, "both read back");
    assert_eq!(
        read.violations
            .iter()
            .map(|read| read.rule_id.as_str())
            .collect::<Vec<_>>(),
        ["required", "string.min_len"],
        "in their order"
    );
    assert_eq!(read.more, Some(3), "its count");

    // a failure of another code gives none
    let other = NonZeroU16::new(64).expect("64 is no zero");

    assert!(
        violations_of((other, FailureScope::Protocol), &detail)
            .violations
            .is_empty(),
        "none of another code"
    );

    // too narrow a bound holds none, and counts them all
    let narrow = violations_detail_of(&judged, CLOSING_BYTES);

    assert_eq!(
        violations_of((invalid, FailureScope::Protocol), &narrow).more,
        Some(5),
        "every one counted: {narrow}"
    );
}
