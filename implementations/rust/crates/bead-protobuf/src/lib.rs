//! Bead's `proto` payload on the Rust side (spec 17.9, decisions 0028, 0042 and 0044), over Buffa:
//! the twin of the C# side's `Bead.Protobuf` and the TypeScript side's
//! `@francisdesjardins/bead/proto`, apart from the core, which never depends on protobuf.
//!
//! A payload is read in four steps, each the spec's:
//!
//! 1. its records checked against its message's schema before Buffa reads them (17.9.1 to 17.9.6,
//!    [`check_records`]), which refuses what protobuf refuses where Buffa reads on: a tag of more
//!    than 5 bytes, a map's entry with a field it does not declare, a message nested past the
//!    bound through a map's entries;
//! 2. Buffa's view of it, decoded within the bound of 17.9.3, 100 messages below the top one,
//!    which sets a singular closed enum's undeclared number aside among the unknown fields, its
//!    last declared number kept (17.9.8);
//! 3. the walk of its fields protobuf requires over the view (17.9.7, [`check_required`]), whose
//!    presence is the wire's: an owned message holds such a field bare, its value no witness of
//!    whether it was given;
//! 4. the owned message the view gives the application.
//!
//! [`ProtoCodec`] reads and writes a message Buffa generated, set as `bead_protobuf_build` sets
//! its generator; [`DynamicCodec`] reads and writes a [`DynamicMessage`] by its descriptor alone,
//! the one form that holds a required field unset, so the one through which a writer's refusal of
//! it is reached on the Rust side. Both are payload codecs of `bead`, of the encoding `proto`.
//!
//! [`DynamicMessage`]: buffa_descriptor::reflect::DynamicMessage

mod codec;
mod records;
mod required;

pub use codec::{DynamicCodec, ENCODING, ProtoCodec};
pub use records::{ProtoSchema, check_records};
pub use required::{Place, Unset, UnsetStep, check_required, unset_of};

#[cfg(feature = "testing")]
#[doc(hidden)]
pub mod testing;
