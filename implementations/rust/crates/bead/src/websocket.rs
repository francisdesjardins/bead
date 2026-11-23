//! The WebSocket transport (RFC 6455), a feature of the core (decision 0049): its server, which reads
//! its one head itself, judges it as spec 15.2 orders, and hands its socket to tungstenite; its
//! client, which races its host's addresses and speaks TLS under `wss`; the connection either end
//! runs; the frame meter below tungstenite on either end, and the budget and the rate a server
//! holds its messages partway to (decision 0056); and the server and client an application starts
//! from, built over them.

pub(crate) mod budget;
pub(crate) mod client;
pub(crate) mod connection;
pub(crate) mod facade;
pub(crate) mod heartbeat;
pub(crate) mod meter;
pub(crate) mod server;
