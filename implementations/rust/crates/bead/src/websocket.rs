//! The WebSocket transport (RFC 6455), a feature of the core (decision 0049): its server, which reads
//! its one head itself, judges it as spec 15.2 orders, and hands its socket to tungstenite, and the
//! connection either end runs.

pub(crate) mod connection;
pub(crate) mod server;
