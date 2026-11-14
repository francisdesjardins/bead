//! beadc's Rust goldens, `builder/test/golden/rust`, compiled as an application mounts them
//! (decision 0051): each output's `mod.rs` whole and once, under the workspace's whole lint table,
//! so that its clippy and its doc runs hold what beadc writes; the twin of the C# side's
//! `Bead.Goldens`. The builder's tests write the goldens and hold them to beadc's output; this crate
//! holds them to the compiler. An output of `messages: external` takes its messages from the build
//! script, as its application's build writes them. A root mounted by its path is no `mod.rs` to
//! clippy's `mod_module_files`, which an application's `mod generated;` expects.

#[path = "../../../../../builder/test/golden/rust/comments/mod.rs"]
pub mod comments;

#[path = "../../../../../builder/test/golden/rust/deprecations/mod.rs"]
pub mod deprecations;

#[path = "../../../../../builder/test/golden/rust/keywords/mod.rs"]
pub mod keywords;

#[path = "../../../../../builder/test/golden/rust/messages/mod.rs"]
pub mod messages;

#[path = "../../../../../builder/test/golden/rust/subsets/mod.rs"]
pub mod subsets;

#[path = "../../../../../builder/test/golden/rust/transcoding/mod.rs"]
pub mod transcoding;

#[path = "../../../../../builder/test/golden/rust/validations/mod.rs"]
pub mod validations;
