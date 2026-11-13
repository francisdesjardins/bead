//! `hello`, `HelloService`'s Rust server and client, as the TypeScript and C# halves run them.
//!
//! Its messages are the ones beadc wrote with protoc-gen-buffa, under `src/generated/generate`.
//! `serve`, on any free port, `serve <port>`, on the port given, and `call <port>`, a port its
//! digits alone, at most 65535; any other arguments, the usage, and exit 2.
//!
//! `cargo run --locked -- serve`

use std::process::ExitCode;

// what beadc wrote for this output: the messages under `messages`, the service under `services`,
// and the procedures each transport of its server takes
#[path = "generated/generate/mod.rs"]
pub mod generated;

mod calling;
mod resolvers;
mod run;
mod serving;

fn main() -> ExitCode {
    run::run()
}
