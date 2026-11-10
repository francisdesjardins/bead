//! The transport over HTTP (spec 15.6, 15.9, 15.10, 15.12, decision 0049): its server, on hyper's
//! HTTP/1.1 and its HTTP/2 under TLS; its client, on hyper's pooled HTTP/1.1; and the server and
//! client an application starts from, built over them.

pub(crate) mod client;
pub(crate) mod exchange;
pub(crate) mod facade;
pub(crate) mod fields;
#[cfg(test)]
pub(crate) mod peer;
pub(crate) mod server;
pub(crate) mod wire;
