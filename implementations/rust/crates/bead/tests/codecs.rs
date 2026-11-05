//! `spec/codecs.json` played against the Rust side's codecs: each payload read, and written back or
//! refused, and each value written or refused, through its encoding's codec. The `proto` entries
//! are `bead-protobuf`'s player's, `crates/bead-protobuf/tests/codecs.rs`, since the core never
//! depends on protobuf; an entry whose `differs` excuses Rust is not played. Every refusal is a
//! [`CodecRefusal`], the codec trait's error, as the other sides' players hold theirs to its type,
//! its reason the entry's, exactly (spec 17.2): a codec that panics refuses nothing, and fails its
//! trial.

use std::process::ExitCode;

use bead::json::{self, JsonRefusal};
use bead::testing::{Difference, files, hexadecimal, is_excused};
use bead::{CodecRefusal, JsonCodec, JsonOf, PayloadCodec, RawCodec, TextCodec};
use bytes::Bytes;
use libtest_mimic::{Arguments, Failed, Trial};
use serde::Deserialize;
use serde_json::Value;

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
    differs: Option<Vec<Difference>>,
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
    form: Option<String>,
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
    differs: Option<Vec<Difference>>,
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

fn bytes_of(text: &str) -> Result<Bytes, Failed> {
    hexadecimal::bytes_of(text)
        .map(Bytes::from)
        .ok_or_else(|| format!("{text:?} is no hexadecimal").into())
}

// a payload read, then written back, through `codec`: what it writes, twice, or its refusal
fn written_by<C: PayloadCodec>(codec: &C, bytes: &Bytes) -> Result<(Bytes, Bytes), CodecRefusal> {
    let again = |bytes: &Bytes| codec.decode(bytes).and_then(|value| codec.encode(&value));

    again(bytes).and_then(|written| again(&written).map(|twice| (written, twice)))
}

// a payload read, then written back, through its encoding's codec: what it writes, or its refusal
fn round_trip(
    encoding: &str,
    bytes: &Bytes,
) -> Result<Result<(Bytes, Bytes), CodecRefusal>, Failed> {
    Ok(match encoding {
        "raw" => written_by(&RawCodec, bytes),
        "text" => written_by(&TextCodec, bytes),
        "json" => written_by(&JsonCodec, bytes),
        other => return Err(format!("{other} is no encoding this player plays").into()),
    })
}

fn play_payload(payload: &Payload) -> Result<(), Failed> {
    let bytes = bytes_of(&payload.bytes)?;
    let outcome = round_trip(&payload.encoding, &bytes)?;

    match (&payload.refused, &payload.written, outcome) {
        // * a refusal, a CodecRefusal, its reason the entry's (spec 17.2)
        (Some(reason), _, Err(refusal)) if refusal.reason() == reason => Ok(()),
        (Some(reason), _, Err(refusal)) => {
            Err(format!("refused, saying {refusal:?}, where it says {reason:?}").into())
        }
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
    // * each value written through a codec: a double through a codec of the application's own type
    let written: Result<Bytes, CodecRefusal> = match entry.encoding.as_str() {
        "json" => {
            if let Some(bits) = &given.double {
                let bits = u64::from_str_radix(bits, 16).map_err(|error| error.to_string())?;

                JsonOf::<f64>::new().encode(&f64::from_bits(bits))
            } else {
                let value = if let Some(value) = &given.json {
                    value.clone()
                } else if let Some(digits) = &given.number {
                    number_of(digits).map_err(|refusal| refusal.to_string())?
                } else if let Some(depth) = given.nested {
                    nested_of(depth)
                } else {
                    return Err(format!("{given:?} is no form a json writer is given here").into());
                };

                JsonCodec.encode(&value)
            }
        }
        "text" => {
            let text = given.text.clone().ok_or("a text writer is given a text")?;

            TextCodec.encode(&text)
        }
        "raw" => {
            let bytes = bytes_of(
                given
                    .bytes
                    .as_deref()
                    .ok_or("a raw writer is given bytes")?,
            )?;

            RawCodec.encode(&bytes)
        }
        other => return Err(format!("{other} is no encoding this player plays").into()),
    };

    match (&entry.refused, &entry.written, written) {
        // * a refusal, a CodecRefusal, its reason the entry's (spec 17.2)
        (Some(reason), _, Err(refusal)) if refusal.reason() == reason => Ok(()),
        (Some(reason), _, Err(refusal)) => {
            Err(format!("refused, saying {refusal:?}, where it says {reason:?}").into())
        }
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
    let skipped: Vec<_> = codecs
        .values
        .iter()
        .filter(|entry| is_excused(entry.differs.as_deref().unwrap_or_default()))
        .map(|entry| {
            let rows: Vec<_> = entry
                .differs
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|difference| difference.language == "Rust")
                .map(|difference| difference.row.clone())
                .collect();
            (
                entry.name.clone(),
                entry.encoding.clone(),
                entry.value.form.clone(),
                rows,
            )
        })
        .collect();

    trials.push(Trial::test(
        "pins each value its type cannot hold and its reason",
        move || {
            let expected: Vec<_> = [
                ("a surrogate alone", "json", "loneSurrogate"),
                ("a surrogate alone in a name", "json", "loneSurrogateName"),
                ("an object naming a member twice", "json", "nameTwice"),
                ("undefined", "json", "undefined"),
                ("a surrogate alone in a text", "text", "loneSurrogate"),
            ]
            .into_iter()
            .map(|(name, encoding, form)| {
                (
                    name.to_owned(),
                    encoding.to_owned(),
                    Some(form.to_owned()),
                    vec!["A value a side's type cannot hold".to_owned()],
                )
            })
            .collect();

            if skipped != expected {
                return Err(format!("excused values: {skipped:?}, expected {expected:?}").into());
            }

            for text in [r#""\ud800""#, r#"{"\ud800":0}"#, "undefined"] {
                if serde_json::from_str::<Value>(text).is_ok() {
                    return Err(format!("{text} built as a JSON value").into());
                }
            }
            let twice: Value = serde_json::from_str(r#"{"name":1,"name":2}"#)?;
            if twice.as_object().map(serde_json::Map::len) != Some(1) {
                return Err("a JSON object holds each name once".into());
            }

            Ok(())
        },
    ));

    for payload in codecs.payloads {
        if payload.encoding == "proto" || is_excused(payload.differs.as_deref().unwrap_or_default())
        {
            continue;
        }

        let name = format!("reads {}", payload.name);

        trials.push(Trial::test(name, move || play_payload(&payload)).with_kind("payloads"));
    }

    for entry in codecs.values {
        if entry.encoding == "proto" || is_excused(entry.differs.as_deref().unwrap_or_default()) {
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
