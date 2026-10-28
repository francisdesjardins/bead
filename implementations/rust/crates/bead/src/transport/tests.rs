//! The transports' shared parts: what a credential beside an envelope may be, where a transport
//! stands, and how a reconnection waits by default.

use super::{RECONNECT_ATTEMPTS, RECONNECT_DELAY, ReadyState, is_field_value};

#[test]
fn takes_a_field_s_value_as_a_credential_visible_ascii_spaces_and_tabs_alone_none_first_or_last() {
    for value in [
        "",
        "Interop sub=ada",
        "Bearer mF_9.B5f-4.1JqM",
        "a\tb",
        "~!",
    ] {
        assert!(is_field_value(value), "{value:?} a field's value");
    }

    for value in [
        " Bearer x",
        "x ",
        "\tx",
        "Interop\nsub=ada",
        "caf\u{e9}",
        "a\u{7f}b",
    ] {
        assert!(!is_field_value(value), "{value:?} no field's value");
    }
}

#[test]
fn names_where_it_stands_as_the_other_sides_do() {
    assert_eq!(
        [
            ReadyState::Connecting,
            ReadyState::Open,
            ReadyState::Closing,
            ReadyState::Closed,
            ReadyState::Uninitialized,
            ReadyState::Reconnecting,
        ]
        .map(|state| (state.name(), state.said())),
        [
            ("CONNECTING", "connecting"),
            ("OPEN", "open"),
            ("CLOSING", "closing"),
            ("CLOSED", "closed"),
            ("UNINITIALIZED", "uninitialized"),
            ("RECONNECTING", "reconnecting"),
        ],
        "each by its name, and in a sentence"
    );
}

#[test]
fn reconnects_five_times_a_second_apart_by_default() {
    assert_eq!(
        (RECONNECT_ATTEMPTS, RECONNECT_DELAY),
        (5, core::time::Duration::from_secs(1)),
        "its defaults"
    );
}
