//! HTTP/JSON transcoding's parts that hold no socket (spec/transcoding.md, decisions 0037 and
//! 0052): `http.proto`'s templates parsed and matched, a gateway's route table, the problems it
//! answers a failure with, the events a stream's call writes, and the seam, [`MessageForm`], through
//! which a message's JSON form is read and written by a codec of its own, as `bead_protobuf`'s
//! `JsonForm` writes a `proto` message's. No dependency of their own, so they build for
//! `wasm32-unknown-unknown` as the core does.

pub(crate) mod events;
pub(crate) mod form;
pub(crate) mod problems;
pub(crate) mod routes;
pub(crate) mod templates;
