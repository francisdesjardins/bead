//! The Rust side's testee of the protovalidate differential (decisions 0035 and 0051), as
//! `tools/protovalidate-differential.mjs` drives one: on the standard input, a case a line,
//! `{"message":"<full name>","payload":"<base64>"}`; on the standard output, a line for each, the
//! violations the validator beadc generates for that message gives, `fail_fast` off and no bound,
//! or `{"refused":true}` where its codec does not read the payload. `src/generated/` is what that
//! tool generates at run time, never committed.

use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use bead::{Descriptor, Judged, PayloadCodec, ValidateOptions, Violation};
use bead_protobuf::ProtoCodec;
use bytes::Bytes;
use serde_json::{Map, Value};

/// The code beadc generates for `spec/validations.proto`, as that tool writes it.
mod generated;

use generated::messages::bead::validations::v1 as messages;
use generated::services::bead::validations::v1::ValidationsProcedures;

// a message's judging: its payload read by its binding's codec, then judged by its rules; none
// where its codec does not read the payload
type Judge = Box<dyn Fn(&Bytes) -> Result<Option<Judged>, String>>;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// bytes from their base64, padded or not
fn bytes_of(text: &str) -> Result<Bytes, String> {
    let mut bytes = Vec::with_capacity(text.len() / 4 * 3);
    let mut group = 0_u32;
    let mut count = 0_u32;

    for character in text.bytes().filter(|character| *character != b'=') {
        let digit = ALPHABET
            .iter()
            .position(|each| *each == character)
            .ok_or_else(|| format!("{text} is no base64"))?;

        group = (group << 6) | u32::try_from(digit).map_err(|error| error.to_string())?;
        count += 1;

        if count == 4 {
            bytes.extend_from_slice(&group.to_be_bytes()[1..]);
            group = 0;
            count = 0;
        }
    }

    match count {
        0 => {}
        2 => bytes.push(u8::try_from(group >> 4).map_err(|error| error.to_string())?),
        3 => bytes.extend_from_slice(&(group >> 2).to_be_bytes()[2..]),
        _ => return Err(format!("{text} is no base64")),
    }

    Ok(Bytes::from(bytes))
}

// the judging of the procedure `descriptor` binds
fn judge_of<M>(descriptor: &'static Descriptor<ProtoCodec<M>, ProtoCodec<messages::Taken>>) -> Judge
where
    ProtoCodec<M>: PayloadCodec<Value = M>,
{
    // * a judging whole: fail_fast off, no bound
    let whole = ValidateOptions::default();

    Box::new(move |payload| {
        let validate = descriptor
            .validate()
            .ok_or_else(|| format!("{} has no rules", descriptor.procedure().procedure_name))?;
        let Ok(request) = descriptor.request().decode(payload) else {
            return Ok(None);
        };

        validate(&request, &whole)
            .map(Some)
            .map_err(|error| error.to_string())
    })
}

// each message, by its full name, and its judging
fn judges() -> Result<Vec<(&'static str, Judge)>, String> {
    let procedures = ValidationsProcedures::get().map_err(|error| error.to_string())?;

    Ok(vec![
        (
            "bead.validations.v1.Numbers",
            judge_of(&procedures.judge_numbers),
        ),
        (
            "bead.validations.v1.Floats",
            judge_of(&procedures.judge_floats),
        ),
        (
            "bead.validations.v1.Strings",
            judge_of(&procedures.judge_strings),
        ),
        (
            "bead.validations.v1.Bytes",
            judge_of(&procedures.judge_bytes),
        ),
        (
            "bead.validations.v1.Enums",
            judge_of(&procedures.judge_enums),
        ),
        (
            "bead.validations.v1.Repeated",
            judge_of(&procedures.judge_repeated),
        ),
        ("bead.validations.v1.Maps", judge_of(&procedures.judge_maps)),
        (
            "bead.validations.v1.Presence",
            judge_of(&procedures.judge_presence),
        ),
        (
            "bead.validations.v1.Wrappers",
            judge_of(&procedures.judge_wrappers),
        ),
        (
            "bead.validations.v1.Oneofs",
            judge_of(&procedures.judge_oneofs),
        ),
        (
            "bead.validations.v1.Nested",
            judge_of(&procedures.judge_nested),
        ),
        (
            "bead.validations.v1.Order",
            judge_of(&procedures.judge_order),
        ),
        (
            "bead.validations.v1.Patterns",
            judge_of(&procedures.judge_patterns),
        ),
    ])
}

// a violation as the wire carries it: its members, the value it broke left on this side
fn sent_of(violation: &Violation) -> Value {
    let mut members = Map::new();

    if let Some(field_path) = &violation.field_path {
        members.insert("fieldPath".to_owned(), Value::String(field_path.clone()));
    }

    members.insert(
        "ruleId".to_owned(),
        Value::String(violation.rule_id.clone()),
    );

    if let Some(bounds) = &violation.bounds {
        members.insert("bounds".to_owned(), Value::Object(bounds.clone()));
    }

    if let Some(message) = &violation.message {
        members.insert("message".to_owned(), Value::String(message.clone()));
    }

    if violation.for_key {
        members.insert("forKey".to_owned(), Value::Bool(true));
    }

    Value::Object(members)
}

fn answer_of(judges: &[(&'static str, Judge)], line: &str) -> Result<Value, String> {
    let case: Value = serde_json::from_str(line).map_err(|error| error.to_string())?;
    let message = case
        .get("message")
        .and_then(Value::as_str)
        .ok_or("a case names its message")?;
    let payload = case
        .get("payload")
        .and_then(Value::as_str)
        .ok_or("a case gives its payload")?;
    // ! a message gone fails the run, rather than passing as refused
    let (_, judge) = judges
        .iter()
        .find(|(name, _)| *name == message)
        .ok_or_else(|| format!("no procedure judges {message}"))?;
    let mut answer = Map::new();

    match judge(&bytes_of(payload)?)? {
        Some(judged) => {
            answer.insert(
                "violations".to_owned(),
                Value::Array(judged.violations.iter().map(sent_of).collect()),
            );
        }
        None => {
            answer.insert("refused".to_owned(), Value::Bool(true));
        }
    }

    Ok(Value::Object(answer))
}

fn run() -> Result<(), String> {
    let judges = judges()?;
    let mut output = io::stdout().lock();

    for line in io::stdin().lock().lines() {
        let line = line.map_err(|error| error.to_string())?;

        if line.is_empty() {
            continue;
        }

        writeln!(output, "{}", answer_of(&judges, &line)?).map_err(|error| error.to_string())?;
    }

    output.flush().map_err(|error| error.to_string())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("protovalidate-differential's testee: {error}");

            ExitCode::FAILURE
        }
    }
}
