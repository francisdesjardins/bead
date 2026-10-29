//! `spec/codecs.json` played against the Rust side's codecs: each payload read, and written back or
//! refused, and each value written or refused, through its encoding's codec. The `proto` entries
//! are `bead-protobuf`'s player's, `crates/bead-protobuf/tests/codecs.rs`, since the core never
//! depends on protobuf; an entry whose `differs` excuses Rust is not played.

use std::process::ExitCode;

use bead::json::{self, JsonRefusal};
use bead::testing::files;
use bead::testing::hexadecimal;
use bead::{JsonCodec, PayloadCodec, RawCodec, TextCodec};
use bytes::Bytes;
use libtest_mimic::{Arguments, Failed, Trial};
use serde::Deserialize;
use serde_json::Value;

/// A row of `docs/support.md` an entry crosses, and the language it excuses.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Differs {
    row: String,
    language: String,
}

/// Bytes read in an encoding, and what its reader makes of them.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    name: String,
    encoding: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    bytes: String,
    written: Option<String>,
    refused: Option<String>,
    #[serde(rename = "read")]
    _read: Option<Value>,
    differs: Option<Vec<Differs>>,
}

/// A value given to a writer, in one of eight forms.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Given {
    json: Option<Value>,
    double: Option<String>,
    number: Option<String>,
    text: Option<String>,
    bytes: Option<String>,
    #[serde(rename = "form")]
    _form: Option<String>,
    nested: Option<usize>,
    #[serde(rename = "probe")]
    _probe: Option<Value>,
}

/// A value given to a writer in an encoding, and what it writes.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[expect(
    clippy::struct_field_names,
    reason = "the file's own names, one a member each"
)]
struct Written {
    name: String,
    encoding: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    value: Given,
    written: Option<String>,
    refused: Option<String>,
    differs: Option<Vec<Differs>>,
}

/// The file whole.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Codecs {
    #[serde(rename = "$schema")]
    _schema: String,
    #[serde(rename = "$comment")]
    _comment: Vec<String>,
    #[serde(rename = "specVersion")]
    _spec_version: String,
    payloads: Vec<Payload>,
    values: Vec<Written>,
}

// whether an entry's differs excuses the Rust side
fn is_excused(differs: Option<&Vec<Differs>>) -> bool {
    differs.is_some_and(|differs| {
        differs
            .iter()
            .any(|differs| differs.language == "Rust" && !differs.row.is_empty())
    })
}

fn bytes_of(text: &str) -> Result<Bytes, Failed> {
    hexadecimal::bytes_of(text)
        .map(Bytes::from)
        .ok_or_else(|| format!("{text:?} is no hexadecimal").into())
}

// a payload read, then written back, through its encoding's codec: what it writes, or its refusal
fn round_trip(encoding: &str, bytes: &Bytes) -> Result<Result<(Bytes, Bytes), String>, Failed> {
    let written = |again: &dyn Fn(&Bytes) -> Result<Bytes, String>| {
        again(bytes).and_then(|written| again(&written).map(|twice| (written, twice)))
    };

    Ok(match encoding {
        "raw" => written(&|bytes| {
            let codec = RawCodec;

            codec
                .decode(bytes)
                .and_then(|value| codec.encode(&value))
                .map_err(|refusal| refusal.to_string())
        }),
        "text" => written(&|bytes| {
            let codec = TextCodec;

            codec
                .decode(bytes)
                .and_then(|value| codec.encode(&value))
                .map_err(|refusal| refusal.to_string())
        }),
        "json" => written(&|bytes| {
            let codec = JsonCodec;

            codec
                .decode(bytes)
                .and_then(|value| codec.encode(&value))
                .map_err(|refusal| refusal.to_string())
        }),
        other => return Err(format!("{other} is no encoding this player plays").into()),
    })
}

fn play_payload(payload: &Payload) -> Result<(), Failed> {
    let bytes = bytes_of(&payload.bytes)?;
    let outcome = round_trip(&payload.encoding, &bytes)?;

    match (&payload.refused, &payload.written, outcome) {
        (Some(_), _, Err(_)) => Ok(()),
        (Some(reason), _, Ok((written, _))) => {
            Err(format!("read and wrote {written:02X?}, where it is refused: {reason}").into())
        }
        (None, Some(expected), Ok((written, twice))) => {
            let expected = bytes_of(expected)?;

            if written != expected {
                return Err(format!("wrote {written:02X?}").into());
            }

            // * the value read of what it wrote is the value read of what it was given
            if twice != written {
                return Err(format!("wrote {twice:02X?} of what it wrote").into());
            }

            Ok(())
        }
        (None, _, Err(reason)) => Err(format!("refused: {reason}").into()),
        (None, None, Ok(_)) => Err("an entry says what it writes or why it is refused".into()),
    }
}

// the value of a given number's digits, as Bead's own reader reads them
fn number_of(digits: &str) -> Result<Value, JsonRefusal> {
    json::read(digits.as_bytes())
}

// that many arrays, one in another, the innermost empty
fn nested_of(depth: usize) -> Value {
    (1..depth).fold(Value::Array(Vec::new()), |inner, _| {
        Value::Array(vec![inner])
    })
}

fn play_value(entry: &Written) -> Result<(), Failed> {
    let given = &entry.value;
    let written: Result<Bytes, String> = match entry.encoding.as_str() {
        "json" => {
            let value = if let Some(value) = &given.json {
                Ok(value.clone())
            } else if let Some(bits) = &given.double {
                let bits = u64::from_str_radix(bits, 16).map_err(|error| error.to_string())?;

                json::to_value(&f64::from_bits(bits))
            } else if let Some(digits) = &given.number {
                number_of(digits)
            } else if let Some(depth) = given.nested {
                Ok(nested_of(depth))
            } else {
                return Err(format!("{given:?} is no form a json writer is given here").into());
            };

            value
                .and_then(|value| json::write(&value))
                .map(Bytes::from)
                .map_err(|refusal| refusal.to_string())
        }
        "text" => {
            let text = given.text.clone().ok_or("a text writer is given a text")?;

            TextCodec
                .encode(&text)
                .map_err(|refusal| refusal.to_string())
        }
        "raw" => {
            let bytes = bytes_of(
                given
                    .bytes
                    .as_deref()
                    .ok_or("a raw writer is given bytes")?,
            )?;

            RawCodec
                .encode(&bytes)
                .map_err(|refusal| refusal.to_string())
        }
        other => return Err(format!("{other} is no encoding this player plays").into()),
    };

    match (&entry.refused, &entry.written, written) {
        (Some(_), _, Err(_)) => Ok(()),
        (Some(reason), _, Ok(written)) => {
            Err(format!("wrote {written:02X?}, where it is refused: {reason}").into())
        }
        (None, Some(expected), Ok(written)) => {
            if written == bytes_of(expected)? {
                Ok(())
            } else {
                Err(format!("wrote {written:02X?}").into())
            }
        }
        (None, _, Err(reason)) => Err(format!("refused: {reason}").into()),
        (None, None, Ok(_)) => Err("an entry says what it writes or why it is refused".into()),
    }
}

fn trials() -> Result<Vec<Trial>, String> {
    // * read by Bead's own reader, so a value's numbers keep the form the file writes them in
    let codecs: Codecs = files::read_by_bead("codecs.json")?;
    let mut trials = Vec::new();

    for payload in codecs.payloads {
        if payload.encoding == "proto" || is_excused(payload.differs.as_ref()) {
            continue;
        }

        let name = format!("reads {}", payload.name);

        trials.push(Trial::test(name, move || play_payload(&payload)).with_kind("payloads"));
    }

    for entry in codecs.values {
        if entry.encoding == "proto" || is_excused(entry.differs.as_ref()) {
            continue;
        }

        let name = format!("writes {}", entry.name);

        trials.push(Trial::test(name, move || play_value(&entry)).with_kind("values"));
    }

    Ok(trials)
}

fn main() -> ExitCode {
    let arguments = Arguments::from_args();
    let trials = trials()
        .unwrap_or_else(|error| vec![Trial::test("reads codecs.json", move || Err(error.into()))]);

    libtest_mimic::run(&arguments, trials).exit_code()
}
