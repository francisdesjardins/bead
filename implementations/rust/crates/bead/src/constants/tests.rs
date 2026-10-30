//! The constants' tests: the codes in their blocks, the limits' defaults.

use super::{ProtocolCode, RouterSide};
use crate::envelope::FailureRecord;
use crate::failure::Failure;
use crate::router::types::LIMIT_DEFAULTS;

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
