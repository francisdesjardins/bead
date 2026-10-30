//! The broker's core (spec 15.16 to 15.24): a participant, one link of a side to a broker through
//! its adapter, and the client's and the server's transports over it; the parcel each message of a
//! broker is, the sequence and the parts each direction of a connection keeps, and its heartbeat;
//! and the in-memory broker every side's core holds.

pub(crate) mod adapter;
pub(crate) mod client;
pub(crate) mod heartbeat;
pub(crate) mod memory;
pub(crate) mod parcel;
pub(crate) mod participant;
pub(crate) mod sequence;
pub(crate) mod server;

#[cfg(test)]
mod tests;
