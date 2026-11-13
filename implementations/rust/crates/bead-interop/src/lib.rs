//! Bead's interop service on the Rust side: its API `spec/interop-blueprint.json`, its descriptors
//! and its classes, which beadc generates into `generated` (decision 0051), and its behaviour
//! `spec/interop-service.json`, as Bead's Rust side answers it: what a client of any side calls, and
//! what `spec/conversations.json` plays against.
#![expect(
    clippy::disallowed_methods,
    reason = "the interop's own turn, outside the core"
)]

mod credentials;
#[expect(
    clippy::mod_module_files,
    reason = "beadc writes its tree's root as mod.rs, Buffa's name for a checked-in tree"
)]
pub mod generated;
mod handlers;

pub use credentials::{INTEROP_SERVICE, interop_credentials_of, interop_verifier_of};
pub use generated::services::{InteropFailures, InteropProcedures};
pub use handlers::{
    InteropDescriptor, OfferedInterop, identifier_of, issuer_of, offer_interop,
    offer_interop_client,
};
