//! `hello-external`, `HelloService`'s Rust server and client, `hello`'s twin.
//!
//! Its messages are the ones the build script writes through `bead_protobuf_build::config_of`, over
//! the set buf builds from the `.proto`, which `src/generated/external` mounts. The same arguments,
//! the same resolvers, the same calls.
//!
//! `cargo run --locked --features external --bin hello-external -- serve`

use std::process::ExitCode;

// what beadc wrote for this output: the service under `services`, beside the messages the build
// script wrote, the procedures each transport of its server takes, and its routes under `bead_http`
#[path = "generated/external/mod.rs"]
pub mod generated;

mod calling;
mod resolvers;
mod run;
mod serving;

fn main() -> ExitCode {
    run::run()
}
