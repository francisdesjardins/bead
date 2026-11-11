//! The constants' tests: the codes in their blocks, the limits' defaults.

use super::{ProtocolCode, RouterSide};
use crate::envelope::FailureRecord;
use crate::failure::Failure;
use crate::router::types::LIMIT_DEFAULTS;

#[test]
fn give_each_side_a_call_id_range_of_its_own_parity() {
    use crate::router::parts::PendingCalls;

    for (side, (first, last)) in [
        (RouterSide::Client, (1, 0xffff_ffff)),
        (RouterSide::Server, (2, 0xffff_fffe)),
    ] {
        assert_eq!(side.call_ids(), (first, last));
        let mut sequence = PendingCalls::bounded(side, last).expect("a side's valid range");
        let handle = std::sync::Arc::from("a connection");
        assert_eq!(sequence.draw((&handle, |_id| false)), Some(first));
        assert_eq!(sequence.draw((&handle, |_id| false)), Some(first + 2));
    }
}

#[test]
fn holds_23_codes_each_once_and_leaves_out_the_ones_to_come() {
    let codes = ProtocolCode::named();
    assert_eq!(codes.len(), 23);
    assert_eq!(
        codes
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        23
    );
    for later in [23, 37, 53, 66] {
        assert!(!codes.iter().any(|code| code.get().get() == later));
    }
}

#[test]
fn are_the_layout_the_kinds_the_flags_and_the_scopes_of_the_envelope() {
    use super::{CredentialScheme, EnvelopeFlag, EnvelopeKind, EnvelopeLayout, FailureScope};

    assert_eq!(EnvelopeLayout::First.byte(), 0xa1);
    assert_eq!(
        EnvelopeKind::ALL.map(EnvelopeKind::byte),
        [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16]
    );
    assert_eq!(
        [
            EnvelopeFlag::DESTINATION,
            EnvelopeFlag::TRANSFER,
            EnvelopeFlag::CREDENTIAL,
            EnvelopeFlag::SUBSCRIPTION,
            EnvelopeFlag::PACED,
            EnvelopeFlag::MORE,
        ]
        .map(EnvelopeFlag::bits),
        [0x02, 0x04, 0x08, 0x10, 0x20, 0x40]
    );
    assert_eq!(
        [
            CredentialScheme::NONE,
            CredentialScheme::OPAQUE,
            CredentialScheme::JWT,
            CredentialScheme::ELSEWHERE
        ]
        .map(CredentialScheme::get),
        [0, 1, 2, 3]
    );
    assert_eq!(
        [FailureScope::Protocol, FailureScope::Application].map(FailureScope::number),
        [0, 1]
    );
    assert_eq!(super::SESSION_TOKEN_BYTES, 16);
}

// spec 8.1
#[test]
fn puts_each_code_in_the_block_of_the_stage_that_raises_it() {
    let blocks = [
        ("ENVELOPE_MALFORMED", 0),
        ("LAYOUT_UNSUPPORTED", 0),
        ("KIND_UNSUPPORTED", 0),
        ("ENVELOPE_TOO_LARGE", 0),
        ("DESTINATION_UNKNOWN", 1),
        ("DESTINATION_UNREACHABLE", 1),
        ("SERVICE_UNKNOWN", 1),
        ("PROCEDURE_UNKNOWN", 1),
        ("CALL_UNKNOWN", 1),
        ("SUBSCRIPTION_UNKNOWN", 1),
        ("SUBSCRIPTION_UNSUPPORTED", 1),
        ("SESSION_REQUIRED", 2),
        ("ACCESS_DENIED", 2),
        ("PAYLOAD_TOO_LARGE", 2),
        ("CAPACITY_EXCEEDED", 2),
        ("CREDENTIAL_UNSUPPORTED", 2),
        ("CHUNK_INVALID", 3),
        ("CREDIT_EXCEEDED", 3),
        ("PAYLOAD_UNDECODABLE", 3),
        ("TRANSFER_STALLED", 3),
        ("PAYLOAD_INVALID", 3),
        ("PROCEDURE_FAILED", 4),
        ("DESTINATION_LOST", 4),
    ];
    let named: Vec<(&str, u16)> = ProtocolCode::named()
        .into_iter()
        .map(|code| (code.name().unwrap_or_default(), code.get().get()))
        .collect();

    assert_eq!(
        named.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
        blocks.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
        "every code, in the order the spec lists them"
    );

    for ((name, code), (_, block)) in named.iter().zip(blocks) {
        assert_eq!(code / 16, block, "{name} is in block {block}");
    }
}

// spec 8.1
#[test]
fn keeps_a_protocol_code_no_name_has_as_a_number() {
    let record = FailureRecord {
        code: core::num::NonZeroU16::new(77).expect("77 is no zero"),
        scope: crate::constants::FailureScope::Protocol,
        detail: String::new(),
        relays: 0,
    };
    // received by a server: its client raised it
    let failure = Failure::received(&record, RouterSide::Server);

    assert_eq!(failure.code().get(), 77, "the code as it came");
    assert_eq!(
        failure.protocol_code().and_then(ProtocolCode::name),
        None,
        "no name has it"
    );
    assert_eq!(
        failure.to_string(),
        "client protocol failure 77",
        "said by its number"
    );
}

// spec 12.2.2, 12.2.3, 12.2.4, 12.2.5, 12.2.7, 12.2.9
#[test]
fn holds_by_the_defaults_both_ends_set_alike() {
    let limits = LIMIT_DEFAULTS;

    assert_eq!(
        (
            limits.buffered_bytes_budget,
            limits.chunk_bytes,
            limits.maximum_answering_calls,
            limits.maximum_chunk_runs,
            limits.maximum_detail_bytes,
            limits.maximum_envelope_bytes,
            limits.maximum_payload_bytes,
            limits.maximum_transfers,
            limits.transfer_inactivity_timeout,
            limits.window_bytes,
        ),
        (
            268_435_456,
            1_048_576,
            64,
            1_024,
            1_024,
            16_778_240,
            16_777_216,
            4,
            core::time::Duration::from_secs(30),
            4_194_304,
        ),
        "every side's defaults"
    );
    // a peer that splits nothing sends a whole payload in one envelope, the longest header before it
    assert!(
        limits.maximum_envelope_bytes - limits.maximum_payload_bytes >= 1_020,
        "room for a full header"
    );
    // a chunk fits in an envelope, and a window holds two, so a sender waits on no credit it is owed
    assert!(
        limits.chunk_bytes <= limits.maximum_envelope_bytes,
        "a chunk in an envelope"
    );
    assert!(
        limits.window_bytes >= 2 * limits.chunk_bytes,
        "two chunks in a window"
    );
    assert!(
        limits.maximum_payload_bytes <= limits.buffered_bytes_budget,
        "a payload within the budget"
    );
}

// spec 3.5
#[test]
fn is_the_client_for_an_odd_call_id_and_the_server_for_an_even_one() {
    for call_id in [1, 3, (1 << 31) + 1, u32::MAX] {
        assert_eq!(
            RouterSide::of_call_id(call_id),
            Some(RouterSide::Client),
            "{call_id}"
        );
    }

    for call_id in [2, 1 << 31, u32::MAX - 1] {
        assert_eq!(
            RouterSide::of_call_id(call_id),
            Some(RouterSide::Server),
            "{call_id}"
        );
    }
}

// a u32 holds no negative, no fraction, nothing past 2³² − 1: 0 alone is no call id
// spec 3.5
#[test]
fn is_no_side_for_0_which_is_no_call_id() {
    assert_eq!(RouterSide::of_call_id(0), None, "no side");
}

// The Rust surface's typed conversions keep the wire's open numeric spaces.
#[test]
fn converts_open_numeric_codes_without_losing_unknown_values_and_names_procedure_kinds() {
    use core::num::NonZeroU16;

    use super::{CredentialScheme, ProcedureKind};

    for number in [0, 1, 2, 3, 4, u16::MAX] {
        assert_eq!(
            CredentialScheme::from(number).get(),
            number,
            "a scheme keeps its whole u16"
        );
    }

    for (number, expected) in [(64, "PROCEDURE_FAILED"), (77, "77"), (u16::MAX, "65535")] {
        let code = ProtocolCode::from(NonZeroU16::new(number).unwrap());

        assert_eq!(code.get().get(), number, "a protocol code keeps its number");
        assert_eq!(
            code.to_string(),
            expected,
            "a known code has its name, an unknown its number"
        );
    }

    for (name, kind) in [
        ("command", ProcedureKind::Command),
        ("notifies", ProcedureKind::Notifies),
        ("request", ProcedureKind::Request),
    ] {
        assert_eq!(
            ProcedureKind::named(name),
            Some(kind),
            "the kind reads by its blueprint name"
        );
        assert_eq!(kind.as_str(), name, "the name round trips");
    }

    for unknown in ["", "Request", "notification", "request "] {
        assert_eq!(
            ProcedureKind::named(unknown),
            None,
            "{unknown:?} names no kind"
        );
    }
}
