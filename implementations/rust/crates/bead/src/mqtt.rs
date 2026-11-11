//! The MQTT 5 binding (spec 15.25 to 15.31; decisions 0041, 0050): a broker adapter of Bead's own,
//! its packets written and read here, over the core's sockets — TCP, TLS, or a WebSocket of
//! subprotocol `mqtt` — its link one task's, which owns its socket, its quota, its filters and
//! its acknowledgements.

pub(crate) mod adapter;
pub(crate) mod link;
pub(crate) mod packets;
pub(crate) mod quota;
pub(crate) mod websocket;

#[cfg(test)]
mod tests;
