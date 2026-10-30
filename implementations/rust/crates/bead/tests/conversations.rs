//! Bead's conversations, `spec/conversations.json`, played against the Rust side's server of the
//! interop service: what its clients send, on one connection or on each a conversation opens, what
//! the server sends back on each and reports; a trial each through a scripted transport, and each a
//! pair of the in-memory transport stands for, through one (spec 15.13), and through a broker pair
//! over the in-memory broker (spec 15.16 to 15.24).

#[path = "players/conversation.rs"]
mod conversation;

use std::process::ExitCode;
use std::sync::Arc;

use bead::testing::{files, instants};
use libtest_mimic::{Arguments, Failed, Trial};
use serde_json::Value;

use conversation::{PlayOptions, is_played_in_memory, play};

// a runtime of its own for each trial, its time driver on, as a router asks
fn played(
    conversation: &Value,
    ((in_memory, over_broker), wall_clock): ((bool, bool), std::time::SystemTime),
) -> Result<(), Failed> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;

    runtime
        .block_on(play(
            conversation,
            PlayOptions {
                in_memory,
                over_broker,
                metrics_registry: None,
                wall_clock,
            },
        ))
        .map_err(Failed::from)
}

fn trials() -> Result<Vec<Trial>, String> {
    let file: Value = files::read("conversations.json")?;
    let wall_clock = file
        .get("wallClock")
        .and_then(Value::as_str)
        .and_then(instants::instant_of)
        .ok_or("conversations.json starts its cases at an instant")?;
    let conversations: Vec<Arc<Value>> = file
        .get("conversations")
        .and_then(Value::as_array)
        .ok_or("conversations.json holds its conversations")?
        .iter()
        .cloned()
        .map(Arc::new)
        .collect();
    let mut trials = Vec::new();

    for conversation in &conversations {
        let name = conversation
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let scripted = Arc::clone(conversation);

        trials.push(
            Trial::test(name.clone(), move || {
                played(&scripted, ((false, false), wall_clock))
            })
            .with_kind("scripted"),
        );

        // spec 15.13: each conversation whose connections a pair of it stands for, through a real one
        if is_played_in_memory(conversation) {
            let in_memory = Arc::clone(conversation);
            let over_broker = Arc::clone(conversation);

            trials.push(
                Trial::test(name.clone(), move || {
                    played(&in_memory, ((true, false), wall_clock))
                })
                .with_kind("in memory"),
            );

            // spec 15.16 to 15.24: the same through a broker pair over the in-memory broker, whose
            // connection is secure and two-way and carries nothing toward its client, as an
            // in-memory one
            trials.push(
                Trial::test(name, move || {
                    played(&over_broker, ((false, true), wall_clock))
                })
                .with_kind("over a broker"),
            );
        }
    }

    Ok(trials)
}

fn main() -> ExitCode {
    let arguments = Arguments::from_args();

    match trials() {
        Ok(trials) => libtest_mimic::run(&arguments, trials).exit_code(),
        Err(reason) => {
            let trial = Trial::test("spec/conversations.json reads", move || Err(reason.into()));

            libtest_mimic::run(&arguments, vec![trial]).exit_code()
        }
    }
}
