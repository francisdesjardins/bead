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
