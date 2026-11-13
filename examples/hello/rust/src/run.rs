//! The arguments, read as the C# side's list patterns and the TypeScript side's `run` read them.

use std::env;
use std::ffi::OsString;
use std::io::{self, Write};
use std::process::ExitCode;

use crate::{calling, serving};

// what a run given other arguments exits with, as the other halves exit
const USAGE_EXIT: u8 = 2;

// a port, its digits alone, at most 65535, as the C# side's `ushort.TryParse` reads one: `u16`'s
// own reading takes a sign, which the other halves refuse
fn port_of(text: &str) -> Option<u16> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    text.parse().ok()
}

fn usage() -> ExitCode {
    // LF, as the other halves write it, on every platform
    io::stderr()
        .lock()
        .write_all(b"usage: hello serve [port] | hello call <port>\n")
        .ok();

    ExitCode::from(USAGE_EXIT)
}

// a run that failed: what failed, on the standard error, and exit 1
fn exit_of(outcome: Result<(), String>) -> ExitCode {
    outcome.map_or_else(
        |reason| {
            writeln!(io::stderr().lock(), "hello: {reason}").ok();

            ExitCode::FAILURE
        },
        |()| ExitCode::SUCCESS,
    )
}

/// The verb read with the count of its arguments: `serve`, `serve <port>` or `call <port>`; any
/// other arguments, one that is no Unicode among them, the usage, and exit 2.
pub(crate) fn run() -> ExitCode {
    let given: Vec<OsString> = env::args_os().skip(1).collect();
    let arguments: Option<Vec<&str>> = given.iter().map(|argument| argument.to_str()).collect();

    match arguments.as_deref() {
        Some(["serve"]) => exit_of(serving::serve(0)),
        Some(["serve", port]) => {
            port_of(port).map_or_else(usage, |port| exit_of(serving::serve(port)))
        }
        Some(["call", port]) => {
            port_of(port).map_or_else(usage, |port| exit_of(calling::call(port)))
        }
        _ => usage(),
    }
}
