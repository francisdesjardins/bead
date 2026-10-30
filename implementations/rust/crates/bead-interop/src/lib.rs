//! Bead's interop service on the Rust side: its API `spec/interop-blueprint.json`, its descriptors
//! written by hand until beadc's Rust target generates them, and its behaviour
//! `spec/interop-service.json`, as Bead's Rust side answers it: what a client of any side calls, and
//! what `spec/conversations.json` plays against.

mod credentials;
mod descriptors;
mod handlers;

pub use credentials::{INTEROP_SERVICE, interop_credentials_of, interop_verifier_of};
pub use descriptors::{
    InteropDescriptor, InteropProcedures, ON_PURPOSE, REGISTERED_ALREADY, SERVICE_ID, SERVICE_NAME,
    SERVICE_REVISION, interop_failures, interop_procedures,
};
pub use handlers::{identifier_of, issuer_of, judge_checked, offer_interop};
