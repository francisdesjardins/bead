//! A router's limits: the rules they hold together by, each refused by its own words, and the
//! limits of a transport that carries each envelope whole.

use core::time::Duration;

use crate::router::types::{
    LIMIT_DEFAULTS, RouterLimitsOptions, limits_of, whole_envelope_limits_of,
};

// the words that open each refusal of limits that do not hold together
const HOLD: &str = "the router's limits do not hold together:";

#[test]
fn holds_the_limits_given_over_the_defaults_frozen_and_refuses_limits_that_do_not_hold_together() {
    use crate::router::types::RouterLimits;

    let given = RouterLimitsOptions {
        buffered_bytes_budget: Some(1_024),
        chunk_bytes: Some(64),
        maximum_envelope_bytes: Some(64),
        maximum_payload_bytes: Some(1_024),
        window_bytes: Some(128),
        ..RouterLimitsOptions::default()
    };
    let held = limits_of(&given).expect("the fixture's limits hold");
    assert_eq!(
        limits_of(&RouterLimitsOptions::default()),
        Ok(LIMIT_DEFAULTS)
    );
    assert_eq!(
        held,
        RouterLimits {
            buffered_bytes_budget: 1_024,
            chunk_bytes: 64,
            maximum_envelope_bytes: 64,
            maximum_payload_bytes: 1_024,
            window_bytes: 128,
            ..LIMIT_DEFAULTS
        }
    );
    // A held value is immutable through a shared reference; a caller may change its own copy.
    crate::testing::surface::Consumer::new().refuses(
        "pub fn check(held: &bead::RouterLimits) { held.window_bytes = 64; }",
        ("E0594", "cannot assign"),
    );
    assert_eq!(
        refusal_of(&RouterLimitsOptions {
            window_bytes: Some(64),
            ..given
        }),
        format!(
            "{HOLD} a window holds two chunks at least, so a sender waits for no credit it is owed"
        )
    );
}

fn refusal_of(limits: &RouterLimitsOptions) -> String {
    limits_of(limits).map_or_else(|error| error.to_string(), |_| String::new())
}

// spec 12.2
#[tokio::test]
async fn take_the_defaults_where_they_say_nothing_and_let_the_transfers_and_the_detail_be_none() {
    let limits = RouterLimitsOptions {
        maximum_detail_bytes: Some(0),
        maximum_transfers: Some(0),
        ..RouterLimitsOptions::default()
    };
    let held = limits_of(&limits).expect("zero transfers and detail bytes hold");
    assert_eq!(held.chunk_bytes, LIMIT_DEFAULTS.chunk_bytes);
    assert_eq!(held.maximum_detail_bytes, 0);
    assert_eq!(held.maximum_transfers, 0);
    let peer = crate::testing::core_port::Peer::new(crate::constants::RouterSide::Server, &limits);
    peer.owner
        .run(|state| {
            assert_eq!(state.core.limits.chunk_bytes, LIMIT_DEFAULTS.chunk_bytes);
            assert_eq!(state.core.limits.maximum_transfers, 0);
            assert_eq!(state.core.limits.maximum_detail_bytes, 0);
            crate::router::core::dispose(state);
        })
        .await
        .expect("the router constructs and disposes");
}

// spec 12.2
#[test]
fn takes_the_edges_of_each_rule_and_0_where_0_means_none() {
    let edges = RouterLimitsOptions {
        buffered_bytes_budget: Some(LIMIT_DEFAULTS.maximum_payload_bytes),
        chunk_bytes: Some(64),
        maximum_detail_bytes: Some(0),
        maximum_envelope_bytes: Some(64),
        maximum_transfers: Some(0),
        transfer_inactivity_timeout: Some(Duration::from_millis(2_147_483_647)),
        window_bytes: Some(128),
        ..RouterLimitsOptions::default()
    };
    let held = limits_of(&edges).expect("the edges hold together");
    assert_eq!(
        held.buffered_bytes_budget,
        LIMIT_DEFAULTS.maximum_payload_bytes
    );
    assert_eq!(held.chunk_bytes, 64);
    assert_eq!(held.maximum_detail_bytes, 0);
    assert_eq!(held.maximum_envelope_bytes, 64);
    assert_eq!(held.maximum_transfers, 0);
    assert_eq!(
        held.transfer_inactivity_timeout,
        Duration::from_millis(2_147_483_647)
    );
    assert_eq!(held.window_bytes, 128);
    let shortest = limits_of(&RouterLimitsOptions {
        transfer_inactivity_timeout: Some(Duration::from_millis(1)),
        ..RouterLimitsOptions::default()
    })
    .expect("the shortest inactivity holds");
    assert_eq!(
        shortest.transfer_inactivity_timeout,
        Duration::from_millis(1)
    );
}

// spec 15.1
#[tokio::test]
async fn gives_limits_a_router_holds_together_and_refuses_a_transfer_asked_for() {
    use crate::router::server::{RouterServer, RouterServerOptions};
    use crate::testing::scripted::ScriptedServer;
    use std::sync::Arc;

    let limits = whole_envelope_limits_of(&RouterLimitsOptions {
        maximum_envelope_bytes: Some(4_096),
        ..RouterLimitsOptions::default()
    })
    .expect("whole envelope limits");
    let clock = crate::testing::SteppingClock::new(crate::testing::instants::new_year());
    let transport = ScriptedServer::new(clock);
    let router = RouterServer::new(
        Arc::<ScriptedServer>::clone(&transport),
        &RouterServerOptions {
            limits: Some(limits),
            ..RouterServerOptions::default()
        },
    )
    .expect("the router holds these limits");
    router.dispose().await;
    assert_eq!(transport.listener_count(), 0);
    assert_eq!(
        whole_envelope_limits_of(&RouterLimitsOptions {
            maximum_transfers: Some(4),
            ..RouterLimitsOptions::default()
        })
        .expect_err("whole envelopes refuse transfers")
        .to_string(),
        "a transport of whole envelopes carries no transfer: maximumTransfers is 0, not 4"
    );
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
