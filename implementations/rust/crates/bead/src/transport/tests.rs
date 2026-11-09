//! The transports' shared parts: what a credential beside an envelope may be, where a transport
//! stands, how a reconnection waits by default, and how a server's listeners are told within its
//! guard.

use std::sync::{Arc, Mutex, PoisonError};

use super::{
    Listeners, RECONNECT_DEFAULTS, ReadyState, ServerListener, TransportClientReconnectDelay,
    TransportServerRefusal, is_field_value, tell_server,
};
use crate::router::types::{ConnectionHandle, RouterError};

mod reconnection;

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
        RECONNECT_DEFAULTS.maximum_attempts,
        Some(5),
        "its attempts by default"
    );
    assert!(
        matches!(
            RECONNECT_DEFAULTS.delay,
            Some(TransportClientReconnectDelay::Fixed(delay))
                if delay == core::time::Duration::from_secs(1)
        ),
        "its delay by default"
    );
    assert!(
        RECONNECT_DEFAULTS.signal.is_none() && RECONNECT_DEFAULTS.tap.is_none(),
        "nothing else by default"
    );
}

// a server transport's gauges are none unless it says otherwise: the trait's own, which a transport
// that counts overrides
#[test]
fn a_transport_counts_nothing_unless_it_says_so() {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use super::ServerTransport;
    use crate::router::types::Gauges;
    use crate::testing::SteppingClock;
    use crate::testing::clockless::Clockless;
    use crate::testing::scripted::ScriptedServer;

    let counting = ScriptedServer::new(SteppingClock::new(crate::testing::instants::new_year()));
    let counted = Gauges::new(BTreeMap::from([("held", 1)]), []);
    counting.count_as(Some(counted.clone()));
    assert_eq!(counting.gauges(), Some(counted));
    assert_eq!(Clockless(Arc::clone(&counting)).gauges(), None);
}

// what a server's listener hears, each told as a line
struct Hearing {
    told: Arc<Mutex<Vec<String>>>,
}

impl ServerListener for Hearing {
    fn on_refusal(&self, refusal: &TransportServerRefusal) {
        self.told
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(format!("refused {} {}", refusal.status, refusal.reason));
    }

    fn on_error(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        self.told
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(format!("error {error} on {connection_handle:?}"));
    }
}

// a listener of refusals that panics
struct Refusing;

impl ServerListener for Refusing {
    fn on_refusal(&self, _refusal: &TransportServerRefusal) {
        panic!("a refusal listener that throws");
    }
}

#[test]
fn reports_a_throw_of_a_listener_told_no_connection_with_the_empty_handle() {
    let listeners: Listeners<dyn ServerListener> = Listeners::default();
    let told = Arc::new(Mutex::new(Vec::new()));
    let mut refusal = TransportServerRefusal::new(403, "host-refused");

    refusal.address = Some("127.0.0.1".to_owned());
    refusal.authority = Some("rebind.example:8080".to_owned());
    refusal.port = Some(50_000);
    listeners.add(Arc::new(Refusing));
    listeners.add(Arc::new(Hearing {
        told: Arc::clone(&told),
    }));

    // a refusal names no connection: its listener's panic is reported with none, and the listeners
    // after it are told all the same
    tell_server(
        &listeners,
        (
            |listener: &dyn ServerListener| listener.on_refusal(&refusal),
            None,
        ),
    );

    assert_eq!(
        *told.lock().unwrap_or_else(PoisonError::into_inner),
        [
            "error a listener panicked: a refusal listener that throws on None",
            "refused 403 host-refused",
        ],
        "the panic reported with no connection, and the refusal told after it"
    );
}
