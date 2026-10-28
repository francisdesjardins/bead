//! A router (spec 9 to 15): the core both sides share, the client's and the server's, each held by
//! one owner task and reached through a handle.

pub(crate) mod admissions;
pub(crate) mod answers;
pub(crate) mod client;
pub(crate) mod core;
pub(crate) mod parts;
pub(crate) mod relay;
pub(crate) mod requester;
pub(crate) mod server;
pub(crate) mod transfer;
pub(crate) mod types;

#[cfg(test)]
mod tests;
