//! A procedure's identity: its name's form, one name whatever its ASCII case, its declaration
//! within its ranges and its kind.

use super::{
    DeclarationWay, IdentityRefusal, Procedure, are_one_name, check_declaration,
    check_procedure_kind, is_procedure_name,
};
use crate::constants::ProcedureKind;
use crate::errors::Refusal;
use crate::testing::pair::echo;

#[test]
fn names_a_procedure_by_a_lower_case_letter_then_letters_and_digits_63_at_most() {
    let longest = "a".repeat(63);
    let past = "a".repeat(64);

    for name in ["echo", "endSessionsOf", "a1", longest.as_str()] {
        assert!(is_procedure_name(name), "{name} a name");
    }

    for name in ["", "Echo", "1a", "end_session", "caf\u{e9}", past.as_str()] {
        assert!(!is_procedure_name(name), "{name} no name");
    }
}

#[test]
fn folds_ascii_letters_alone_as_it_compares_names() {
    assert!(are_one_name("echo", "eCHO"), "ASCII folded");
    assert!(
        !are_one_name("caf\u{e9}", "caf\u{c9}"),
        "a name outside ASCII its own"
    );
    assert!(!are_one_name("echo", "echos"), "another name");
}

#[test]
fn refuses_a_declaration_out_of_its_range_then_off_its_form_then_against_its_kind() {
    let reason_of = |procedure: &Procedure| {
        check_declaration(procedure)
            .err()
            .and_then(|refused| refused.reason())
    };

    assert_eq!(reason_of(&echo()), None, "echo holds");
    assert_eq!(
        reason_of(&Procedure {
            service_id: 0,
            name: "Off".to_owned(),
            ..echo()
        }),
        Some(Refusal::Identity(IdentityRefusal::OutOfItsRange)),
        "its range first"
    );
    assert_eq!(
        reason_of(&Procedure {
            name: "Off".to_owned(),
            ..echo()
        }),
        Some(Refusal::Identity(IdentityRefusal::OffItsForm)),
        "then its form"
    );

    let command = Procedure {
        kind: Some(ProcedureKind::Command),
        ..echo()
    };

    assert!(
        check_procedure_kind(&command, DeclarationWay::ClientResolver).is_ok(),
        "a command a client resolves"
    );
    assert_eq!(
        check_procedure_kind(&command, DeclarationWay::ClientRequester)
            .err()
            .and_then(|refused| refused.reason()),
        Some(Refusal::Identity(IdentityRefusal::AgainstItsKind)),
        "a command a client never asks"
    );
    assert!(
        check_procedure_kind(
            &Procedure {
                kind: None,
                ..echo()
            },
            DeclarationWay::ClientRequester
        )
        .is_ok(),
        "no kind taken every way"
    );
}
