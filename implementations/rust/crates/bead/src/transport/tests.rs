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

// These are the Rust traits' defaults for a transport supplied by the application.
#[test]
fn a_transport_offers_no_security_or_carried_credential_unless_it_says_so() {
    use super::{RouterClientTransport, ServerTransport};
    use crate::testing::SteppingClock;
    use crate::testing::clockless::Clockless;
    use crate::testing::scripted::{ScriptedClient, ScriptedServer, handle_of};

    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let client = Clockless(ScriptedClient::new(Arc::<SteppingClock>::clone(&clock)));
    let server = Clockless(ScriptedServer::new(clock));
    let handle = handle_of(1);

    assert!(
        !client.is_secure(),
        "a custom client claims no secure leg by default"
    );
    assert!(
        !client.carries("Bearer secret"),
        "a custom client promises to carry no credential"
    );
    assert!(
        !server.is_secure(&handle),
        "a custom server claims no secure leg by default"
    );
    assert!(
        !server.carries_credential(&handle),
        "a custom server promises to carry no credential"
    );
    assert!(
        server.is_two_way(&handle),
        "a custom server carries both directions by default"
    );
    assert_eq!(
        server.transport_type(),
        None,
        "a custom server draws no type name by default"
    );
    assert!(
        !server.names_procedures(),
        "a custom server holds no procedure selection by default"
    );

    for address in [
        crate::failure::ProcedureAddress {
            service_id: 1,
            procedure_id: 1,
        },
        crate::failure::ProcedureAddress {
            service_id: u16::MAX,
            procedure_id: u16::MAX,
        },
    ] {
        assert!(
            server.takes_procedure(&handle, address),
            "a custom server takes any procedure by default"
        );
    }
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

// spec 15.1: an error listener's panic is dropped, so telling an error cannot recurse.
#[test]
fn tell_error_tells_error_to_each_listener_within_a_guard_dropping_what_one_throws() {
    struct Report {
        reason: RouterError,
        connection_handle: Option<ConnectionHandle>,
    }

    struct HearingErrors {
        told: Arc<Mutex<Vec<Report>>>,
    }

    impl ServerListener for HearingErrors {
        fn on_error(&self, reason: &RouterError, connection_handle: Option<&ConnectionHandle>) {
            self.told
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(Report {
                    reason: reason.clone(),
                    connection_handle: connection_handle.cloned(),
                });
        }
    }

    struct Panicking;

    impl ServerListener for Panicking {
        fn on_error(&self, _: &RouterError, _: Option<&ConnectionHandle>) {
            panic!("an error listener that throws");
        }
    }

    let listeners: Listeners<dyn ServerListener> = Listeners::default();
    let told = Arc::new(Mutex::new(Vec::new()));
    let error: Arc<dyn std::error::Error + Send + Sync> =
        Arc::new(crate::errors::ProgrammerError::new("told"));
    let reason = RouterError::Other(Arc::clone(&error));
    let handle = crate::testing::scripted::handle_of(1);
    let tell =
        |listener: &(dyn ServerListener + 'static)| listener.on_error(&reason, Some(&handle));

    // nobody listening: nothing told and nothing thrown
    listeners.each((tell, |_| {}));
    listeners.add(Arc::new(Panicking));
    listeners.add(Arc::new(HearingErrors {
        told: Arc::clone(&told),
    }));
    listeners.each((tell, |_| {}));

    let told = told.lock().unwrap_or_else(PoisonError::into_inner);

    assert_eq!(told.len(), 1, "the panic reaches nobody");
    assert_eq!(told[0].connection_handle.as_ref(), Some(&handle));
    assert!(
        matches!(&told[0].reason, RouterError::Other(heard) if Arc::ptr_eq(heard, &error)),
        "the error given reaches the listener after the one that panics"
    );
    drop(told);
}
