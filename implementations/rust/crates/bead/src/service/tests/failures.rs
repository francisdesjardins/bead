//! A catalogue recognizes only its own service's application failures.

use core::num::NonZeroU16;

use super::{CallError, Failure, ListedFailure, failures_of};
use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::envelope::FailureRecord;
use crate::errors::ProgrammerError;
use crate::failure::ProcedureAddress;

#[test]
fn tells_a_failure_of_its_service_by_its_name_and_none_of_another_service() {
    let nobody = ListedFailure::new(
        "NOBODY_TO_GREET",
        NonZeroU16::new(1).expect("a failure code"),
    );
    let loud = ListedFailure::new("TOO_LOUD", NonZeroU16::new(2).expect("a failure code"));
    let catalogue = failures_of(7, &[nobody, loud]).expect("the greeter's catalogue");
    let received = Failure::received(
        &FailureRecord {
            code: NonZeroU16::new(1).expect("a failure code"),
            detail: "a name is needed".to_owned(),
            scope: FailureScope::Application,
            relays: 0,
        },
        RouterSide::Client,
    );
    let greeter = CallError::Failure(received.clone().of_call(
        Some(ProcedureAddress {
            service_id: 7,
            procedure_id: 1,
        }),
        None,
    ));
    let other = CallError::Failure(received.clone().of_call(
        Some(ProcedureAddress {
            service_id: 8,
            procedure_id: 1,
        }),
        None,
    ));
    let protocol = CallError::Failure(
        Failure::protocol(ProtocolCode::ENVELOPE_MALFORMED, RouterSide::Server).of_call(
            Some(ProcedureAddress {
                service_id: 7,
                procedure_id: 1,
            }),
            None,
        ),
    );
    assert!(catalogue.is(&greeter, &nobody));
    assert!(!catalogue.is(&greeter, &loud));
    assert!(!catalogue.is(&other, &nobody));
    assert!(!catalogue.is(&protocol, &nobody));
    assert!(!catalogue.is(&CallError::Failure(received), &nobody));
    assert!(!catalogue.is(
        &CallError::Other(std::sync::Arc::new(ProgrammerError::new("code 1"))),
        &nobody
    ));
}

// every id a u16 holds: 0 refused, 65535 taken; 65536, -1, 1.5 and NaN, which the other sides
// refuse too, are no u16
#[test]
fn refuses_a_service_outside_1_to_65535() {
    failures_of(0, &[]).expect_err("a catalogue has no service of id 0");
    assert_eq!(
        failures_of(u16::MAX, &[])
            .expect("the largest service id")
            .service_id(),
        65_535
    );
}

// a failure is made of its listed value, by which a name is told, never of a name looked up: a name
// the catalogue lacks is no value of it
#[test]
fn makes_a_failure_of_a_name_its_code_and_its_detail() {
    let nobody = ListedFailure::new(
        "NOBODY_TO_GREET",
        NonZeroU16::new(1).expect("a failure code"),
    );
    let loud = ListedFailure::new("TOO_LOUD", NonZeroU16::new(2).expect("a failure code"));
    let catalogue = failures_of(7, &[nobody, loud]).expect("the greeter's catalogue");

    let quieter = loud.of("quieter");
    assert!(quieter.is_application());
    assert_eq!(
        (quieter.code().get(), quieter.detail(), loud.name()),
        (2, "quieter", "TOO_LOUD")
    );
    let bare = nobody.of("");
    assert_eq!(
        (bare.code().get(), bare.detail(), nobody.name()),
        (1, "", "NOBODY_TO_GREET")
    );
    assert_eq!(catalogue.failures(), [nobody, loud]);
}

// a code is a NonZeroU16: 0 is none, and 65536, -1, 1.5 and NaN are no u16
#[test]
fn refuses_a_code_outside_1_to_65535_and_two_names_of_one_code() {
    assert_eq!(NonZeroU16::new(0), None);
    let first = ListedFailure::new("FIRST", NonZeroU16::new(3).expect("a failure code"));
    let second = ListedFailure::new("SECOND", NonZeroU16::new(3).expect("a failure code"));
    assert_eq!(
        failures_of(7, &[first, second])
            .expect_err("two names of one code")
            .message(),
        "SECOND and FIRST are both failure 3"
    );
    let last = ListedFailure::new("LAST", NonZeroU16::MAX);
    assert_eq!(
        failures_of(7, &[last])
            .expect("the largest code")
            .failures()[0]
            .code(),
        65_535
    );
}
