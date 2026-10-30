//! A router's limits: the rules they hold together by, each refused by its own words, and the
//! limits of a transport that carries each envelope whole.

use core::time::Duration;

use crate::router::types::{
    LIMIT_DEFAULTS, RouterLimitsOptions, limits_of, whole_envelope_limits_of,
};

// the words that open each refusal of limits that do not hold together
const HOLD: &str = "the router's limits do not hold together:";

fn refusal_of(limits: &RouterLimitsOptions) -> String {
    limits_of(limits).map_or_else(|error| error.to_string(), |_| String::new())
}

// a u64 holds no negative: a count of transfers or of a detail's bytes below 0, refused by the
// other sides by its words, is refused here by its type
// spec 12.2
#[test]
fn refuses_limits_that_do_not_hold_together_each_by_its_own_rule() {
    for (limits, words) in [
        (
            RouterLimitsOptions {
                window_bytes: Some(0),
                ..RouterLimitsOptions::default()
            },
            "windowBytes is a whole number above 0, not 0".to_owned(),
        ),
        (
            RouterLimitsOptions {
                chunk_bytes: Some(63),
                maximum_envelope_bytes: Some(63),
                ..RouterLimitsOptions::default()
            },
            format!("{HOLD} an envelope is 64 bytes at least"),
        ),
        (
            RouterLimitsOptions {
                chunk_bytes: Some(63),
                ..RouterLimitsOptions::default()
            },
            format!("{HOLD} a chunk's envelope is 64 bytes at least, and an envelope at most"),
        ),
        (
            RouterLimitsOptions {
                chunk_bytes: Some(1_024),
                maximum_envelope_bytes: Some(1_023),
                ..RouterLimitsOptions::default()
            },
            format!("{HOLD} a chunk's envelope is 64 bytes at least, and an envelope at most"),
        ),
        (
            RouterLimitsOptions {
                chunk_bytes: Some(2_049),
                maximum_envelope_bytes: Some(2_048),
                ..RouterLimitsOptions::default()
            },
            format!("{HOLD} a chunk's envelope is 64 bytes at least, and an envelope at most"),
        ),
        (
            RouterLimitsOptions {
                window_bytes: Some(2 * 1_048_576 - 1),
                ..RouterLimitsOptions::default()
            },
            format!(
                "{HOLD} a window holds two chunks at least, so a sender waits for no credit it is owed"
            ),
        ),
        (
            RouterLimitsOptions {
                buffered_bytes_budget: Some(LIMIT_DEFAULTS.maximum_payload_bytes - 1),
                ..RouterLimitsOptions::default()
            },
            format!("{HOLD} a payload fits in the budget of the transfers received"),
        ),
        (
            RouterLimitsOptions {
                maximum_payload_bytes: Some(268_435_457),
                ..RouterLimitsOptions::default()
            },
            format!("{HOLD} a payload fits in the budget of the transfers received"),
        ),
    ] {
        assert_eq!(refusal_of(&limits), words, "{limits:?}");
    }

    // the edges hold, a transfer's inactivity of a millisecond among them
    let edges = RouterLimitsOptions {
        chunk_bytes: Some(64),
        maximum_envelope_bytes: Some(64),
        maximum_payload_bytes: Some(268_435_456),
        transfer_inactivity_timeout: Some(Duration::from_millis(2_147_483_647)),
        window_bytes: Some(128),
        ..RouterLimitsOptions::default()
    };
    let without_transfers = RouterLimitsOptions {
        buffered_bytes_budget: Some(LIMIT_DEFAULTS.maximum_payload_bytes),
        maximum_detail_bytes: Some(0),
        maximum_payload_bytes: Some(LIMIT_DEFAULTS.maximum_payload_bytes),
        maximum_transfers: Some(0),
        ..edges
    };
    let shortest = RouterLimitsOptions {
        transfer_inactivity_timeout: Some(Duration::from_millis(1)),
        ..RouterLimitsOptions::default()
    };

    for limits in [edges, without_transfers, shortest] {
        assert!(limits_of(&limits).is_ok(), "{limits:?} holds");
    }
}

// a u64 holds no negative, no fraction, no NaN: 0 alone is refused by its words
// spec 9.2
#[test]
fn refuses_a_maximum_answering_calls_that_is_not_a_whole_number_above_0() {
    assert_eq!(
        refusal_of(&RouterLimitsOptions {
            maximum_answering_calls: Some(0),
            ..RouterLimitsOptions::default()
        }),
        "maximumAnsweringCalls is a whole number above 0, not 0"
    );

    // a call at once holds, and the default is 64
    assert_eq!(
        limits_of(&RouterLimitsOptions {
            maximum_answering_calls: Some(1),
            ..RouterLimitsOptions::default()
        })
        .map(|limits| limits.maximum_answering_calls)
        .ok(),
        Some(1),
        "one at once"
    );
    assert_eq!(LIMIT_DEFAULTS.maximum_answering_calls, 64, "the default");
}

// spec 15.1
#[test]
fn whole_envelope_limits_take_no_transfer_and_size_the_chunk_and_the_window_on_the_envelope_the_rest_as_given()
 {
    assert_eq!(
        whole_envelope_limits_of(&RouterLimitsOptions::default()).ok(),
        Some(RouterLimitsOptions {
            chunk_bytes: Some(LIMIT_DEFAULTS.maximum_envelope_bytes),
            maximum_envelope_bytes: Some(LIMIT_DEFAULTS.maximum_envelope_bytes),
            maximum_transfers: Some(0),
            window_bytes: Some(2 * LIMIT_DEFAULTS.maximum_envelope_bytes),
            ..RouterLimitsOptions::default()
        }),
        "the defaults"
    );
    assert_eq!(
        whole_envelope_limits_of(&RouterLimitsOptions {
            chunk_bytes: Some(64),
            maximum_envelope_bytes: Some(1_024),
            maximum_payload_bytes: Some(512),
            maximum_transfers: Some(0),
            ..RouterLimitsOptions::default()
        })
        .ok(),
        Some(RouterLimitsOptions {
            chunk_bytes: Some(1_024),
            maximum_envelope_bytes: Some(1_024),
            maximum_payload_bytes: Some(512),
            maximum_transfers: Some(0),
            window_bytes: Some(2_048),
            ..RouterLimitsOptions::default()
        }),
        "the rest as given"
    );
}
