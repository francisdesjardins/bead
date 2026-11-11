//! The WebSocket server and client an application starts from, end to end over the loopback: what
//! each builds, the message bound it gives its transport, and its layers together — transfers, a
//! relay, sessions, commands, subscriptions and cancels.

mod client;
mod server;

use core::time::Duration;
use std::sync::{Mutex, MutexGuard, PoisonError};

use sha2::{Digest, Sha256};

use super::{WebSocketClient, WebSocketClientOptions, WebSocketServer, WebSocketServerOptions};
use crate::constants::ProcedureKind;
use crate::errors::CallError;
use crate::identity::Procedure;
use crate::managers::service::ServiceCall;
use crate::server::{HealthStatus, ServerOptions};
use crate::testing::{patience, rest};
use crate::transport::TransportServerStartOptions;
use crate::websocket::client::WebSocketTransportClientConnectOptions;

const PATIENCE: Duration = Duration::from_secs(10);

// bytes by the tens of megabytes, on a machine that may be slow: the clock is no part of it
const GENEROUS: Duration = Duration::from_secs(30);

const MEBIBYTE: usize = 1_048_576;

// what a registration keeps on purpose, whether its connection stands or not
const KEPT: [&str; 2] = ["closedDestinations", "destinations"];

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// one more on `count`
fn add_one(count: &Mutex<u32>) {
    let mut held = locked(count);

    *held = held.saturating_add(1);
}

fn procedure(id: u16, (name, kind): (&str, Option<ProcedureKind>)) -> Procedure {
    Procedure {
        service_id: 1,
        procedure_id: id,
        procedure_name: name.to_owned(),
        service_revision: 1,
        procedure_kind: kind,
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

fn open_session() -> Procedure {
    procedure(1, ("openSession", Some(ProcedureKind::Request)))
}

fn echo() -> Procedure {
    procedure(2, ("echo", Some(ProcedureKind::Request)))
}

fn ping() -> Procedure {
    procedure(3, ("ping", Some(ProcedureKind::Command)))
}

fn news() -> Procedure {
    procedure(4, ("news", Some(ProcedureKind::Notifies)))
}

fn unsubscribe() -> Procedure {
    procedure(5, ("unsubscribe", Some(ProcedureKind::Request)))
}

fn whoami() -> Procedure {
    procedure(6, ("whoami", Some(ProcedureKind::Request)))
}

// `length` bytes of a pattern that tells an offset from another
fn pattern_of(length: usize) -> bytes::Bytes {
    (0..length)
        .map(|index| u8::try_from(index.wrapping_mul(7).wrapping_add(3) & 0xFF).unwrap())
        .collect()
}

// what tells a payload apart, however large, without printing it: its length and its SHA-256
fn digest_of(bytes: &[u8]) -> String {
    format!(
        "{} {}",
        bytes.len(),
        crate::testing::hexadecimal::text_of(&Sha256::digest(bytes))
    )
}

// whether it comes to hold within the patience, asked again and again
async fn eventually<F: FnMut() -> bool>(mut holds: F) -> bool {
    let started = crate::testing::Instant::now();

    while !holds() {
        if started.elapsed() > PATIENCE {
            return false;
        }

        rest(Duration::from_millis(10)).await;
    }

    true
}

// a call's outcome, within `within`
async fn outcome_of<T>(call: ServiceCall<T>, within: Duration) -> Result<T, CallError> {
    patience(within, call).await.expect("settled in time")
}

fn loopback() -> TransportServerStartOptions {
    TransportServerStartOptions {
        address: Some("127.0.0.1".to_owned()),
        find_open_port: Some(true),
        ..TransportServerStartOptions::default()
    }
}

fn server_with(server: &ServerOptions) -> WebSocketServer {
    WebSocketServer::new(&WebSocketServerOptions {
        server: Some(server.clone()),
        ..WebSocketServerOptions::default()
    })
    .expect("a server")
}

// starts `server` on the IPv4 loopback, and gives its port
async fn port_of(server: &WebSocketServer) -> u16 {
    patience(PATIENCE, server.transport().start(&loopback()))
        .await
        .expect("started in time")
        .expect("started")
        .port
}

// a client under `limits`, the defaults' where they say nothing
fn client_with(limits: &crate::router::types::RouterLimitsOptions) -> WebSocketClient {
    WebSocketClient::new(&WebSocketClientOptions {
        client: Some(crate::client::ClientOptions {
            limits: Some(limits.clone()),
            ..crate::client::ClientOptions::default()
        }),
        ..WebSocketClientOptions::default()
    })
    .expect("a client")
}

async fn connect(client: &WebSocketClient, port: u16) {
    patience(
        PATIENCE,
        client.connect(&WebSocketTransportClientConnectOptions::new(
            "127.0.0.1",
            port,
        )),
    )
    .await
    .expect("connected in time")
    .expect("connected");
}

// what each layer still keeps, each as `layer:count value`, a registration's destinations aside
async fn kept_of(server: &WebSocketServer) -> Vec<String> {
    let gauges = server.gauges().await.expect("its gauges");

    [
        ("router", gauges.router),
        ("server", gauges.server),
        ("sessions", gauges.sessions),
        ("transport", gauges.transport),
    ]
    .into_iter()
    .flat_map(|(layer, gauges)| {
        gauges
            .counts
            .into_iter()
            .filter(|(name, count)| *count != 0 && !KEPT.contains(name))
            .map(move |(name, count)| format!("{layer}:{name} {count}"))
    })
    .collect()
}

// waits until each layer keeps nothing, then expects its health to pass: a leak fails it
async fn at_rest(server: &WebSocketServer) {
    let started = crate::testing::Instant::now();

    while !kept_of(server).await.is_empty() && started.elapsed() < PATIENCE {
        rest(Duration::from_millis(10)).await;
    }

    assert_eq!(kept_of(server).await, Vec::<String>::new(), "nothing kept");
    assert_eq!(
        server.health().await.expect("its health").status,
        HealthStatus::Pass,
        "its health"
    );
}
