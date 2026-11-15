//! Header and failure inputs held by Rust's records before a writer sees them.

use core::num::NonZeroU16;

use super::super::{EnvelopeHeader, FailureRecord, RequestHeader, write_failure, write_header};
use crate::constants::FailureScope;
use crate::testing::surface::Consumer;

#[test]
fn refuses_a_destination_on_an_answer_which_names_its_call_alone() {
    let consumer = Consumer::new();
    for name in ["ResultHeader", "FailureHeader"] {
        consumer.accepts(&format!(
            "pub fn check() {{ let _ = bead::{name} {{ call_id: 1, credential: None, {} }}; }}",
            if name == "ResultHeader" {
                "total: None"
            } else {
                ""
            }
        ));
        consumer.refuses(
            &format!(
                "pub fn check(mut header: bead::{name}) {{ header.destination_id = Some(1); }}"
            ),
            ("E0609", "no field `destination_id`"),
        );
    }
}

#[test]
fn refuses_a_chunk_that_does_not_say_whether_it_is_the_last_and_a_total_on_another_kind() {
    let consumer = Consumer::new();
    consumer.accepts(
        "pub fn check() { let _ = bead::ChunkHeader { call_id: 1, offset: 0, is_last: true }; }",
    );
    consumer.refuses(
        "pub fn check() { let _ = bead::ChunkHeader { call_id: 1, offset: 0 }; }",
        ("E0063", "missing field `is_last`"),
    );
    for name in [
        "FailureHeader",
        "NotificationHeader",
        "ChunkHeader",
        "CreditHeader",
        "CancelHeader",
    ] {
        consumer.refuses(
            &format!("pub fn check(mut header: bead::{name}) {{ header.total = Some(8); }}"),
            ("E0609", "no field `total`"),
        );
    }
}

#[test]
fn opens_a_subscription_on_a_request_alone() {
    let consumer = Consumer::new();
    consumer.accepts(
        "pub fn check(mut header: bead::RequestHeader) { header.opens_subscription = true; }",
    );
    for name in [
        "ResultHeader",
        "FailureHeader",
        "NotificationHeader",
        "CancelHeader",
    ] {
        consumer.refuses(
            &format!(
                "pub fn check(mut header: bead::{name}) {{ header.opens_subscription = true; }}"
            ),
            ("E0609", "no field `opens_subscription`"),
        );
    }
}

#[test]
fn paces_a_request_that_opens_a_subscription_and_a_credit_alone() {
    let consumer = Consumer::new();
    consumer.accepts("pub fn check(mut header: bead::RequestHeader, mut credit: bead::CreditHeader) { header.paced = true; credit.paced = true; }");
    for name in [
        "ResultHeader",
        "FailureHeader",
        "NotificationHeader",
        "ChunkHeader",
        "CancelHeader",
    ] {
        consumer.refuses(
            &format!("pub fn check(mut header: bead::{name}) {{ header.paced = true; }}"),
            ("E0609", "no field `paced`"),
        );
    }
    let mut bytes = Vec::new();
    let header = EnvelopeHeader::Request(RequestHeader {
        call_id: 1,
        service_id: 1,
        procedure_id: 1,
        paced: true,
        ..super::request(None)
    });
    assert_eq!(
        write_header(&header, &mut bytes)
            .expect_err("no subscription to pace")
            .message(),
        "a 0x10 header paces nothing: a request that opens a subscription does, or a credit"
    );
    assert_eq!(bytes, Vec::<u8>::new());
}

fn failure_code_and_scope() {
    let consumer = Consumer::new();
    assert!(NonZeroU16::new(0).is_none());
    for value in ["0", "65536", "1.5", "-1", "f64::NAN"] {
        consumer.refuses(
            &format!("pub fn check(mut record: bead::FailureRecord) {{ record.code = {value}; }}"),
            ("E0308", "mismatched types"),
        );
    }
    consumer.refuses(
        "pub fn check(mut record: bead::FailureRecord) { record.scope = 2; }",
        ("E0308", "mismatched types"),
    );
    for (code, scope, expected) in [
        (0x1000, FailureScope::Application, [0x10, 0, 0, 1]),
        (0xffff, FailureScope::Protocol, [0xff, 0xff, 0, 0]),
    ] {
        assert_eq!(
            write_failure(
                &FailureRecord {
                    code: NonZeroU16::new(code).expect("a nonzero code"),
                    scope,
                    relays: 0,
                    detail: String::new(),
                },
                1_024
            ),
            expected
        );
    }
}

#[test]
fn refuses_a_code_that_is_not_an_integer_from_1_to_65535_or_a_scope_that_is_neither() {
    failure_code_and_scope();
}

#[test]
fn refuses_to_write_a_failure_of_code_0_or_of_no_scope() {
    failure_code_and_scope();
}

#[test]
fn writes_the_relays_a_failure_crossed_from_0_to_255_and_refuses_any_other_count() {
    super::twins::writes_the_relays_and_the_scope_of_an_application_failure_scenario();
    let consumer = Consumer::new();
    for value in ["256", "-1", "1.5", "f64::NAN"] {
        let compiled = consumer
            .compiled(&format!(
                "pub fn check(mut record: bead::FailureRecord) {{ record.relays = {value}; }}"
            ))
            .expect("the compiler runs");
        assert!(!compiled.succeeded, "{value}: {}", compiled.stderr);
        assert!(
            compiled.stderr.contains(if value == "256" {
                "literal out of range"
            } else if value == "-1" {
                "cannot apply unary operator"
            } else {
                "mismatched types"
            }),
            "{value}: {}",
            compiled.stderr
        );
    }
}
