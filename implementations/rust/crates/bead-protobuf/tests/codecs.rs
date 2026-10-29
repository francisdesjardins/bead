//! `spec/codecs.json`'s `proto` entries played against the Rust side's codecs of `Probe`, a trial
//! each: each payload read, or refused, through the typed codec over the code Buffa generated and
//! through the dynamic codec by `Probe`'s descriptor, what each read held to the entry's; each
//! value written, or refused, through the typed codec where a `Probe` holds it and through the
//! dynamic codec always. `needs set to no field` and `needs with a shade its enum does not declare`
//! no `Probe` holds, as the row `A proto value that leaves a required field unset or holds a closed
//! enum's undeclared number, given to a typed writer` says: the dynamic codec alone is given them.
//! The core's player, `bead/tests/codecs.rs`, plays the other encodings.

use std::process::ExitCode;
use std::sync::Arc;

use bead::PayloadCodec;
use bead::testing::{files, hexadecimal};
use bead_protobuf::testing::codecs::descriptor_pool;
use bead_protobuf::testing::codecs::{Needs, Probe, Shade};
use bead_protobuf::{DynamicCodec, ProtoCodec};
use buffa::{Enumeration, MessageField};
use buffa_descriptor::reflect::{DynamicMessage, ReflectMessageMut, Value as Field};
use bytes::Bytes;
use libtest_mimic::{Arguments, Failed, Trial};
use serde::Deserialize;
use serde_json::{Map, Value, json};

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
    #[serde(rename = "written")]
    _written: Option<String>,
    refused: Option<String>,
    read: Option<Value>,
    differs: Option<Vec<Differs>>,
}

/// A `Needs` given to a writer, each of its required fields where it is given.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
struct NeedsGiven {
    must: Option<u32>,
    shade: Option<i32>,
}

/// A `Probe` given to a writer, one field set or none: its text as UTF-16 code units.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeGiven {
    text: Option<String>,
    number: Option<u32>,
    child: Option<Map<String, Value>>,
    needs: Option<NeedsGiven>,
}

/// A value given to a writer: a `Probe` alone is a `proto` one.
#[derive(Debug, Deserialize)]
struct Given {
    probe: Option<ProbeGiven>,
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

// a string's UTF-16 code units, as the file writes text: four capital digits each, a space between
fn units_of(text: &str) -> String {
    text.encode_utf16()
        .map(|unit| format!("{unit:04X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

// the string of code units as the file writes them
fn string_of(units: &str) -> Result<String, Failed> {
    let units = units
        .split_whitespace()
        .map(|unit| u16::from_str_radix(unit, 16))
        .collect::<Result<Vec<u16>, _>>()
        .map_err(|error| error.to_string())?;

    String::from_utf16(&units).map_err(|error| error.to_string().into())
}

// ── What was read, as the file writes it ──────────────────────────────────────

// how deep messages nest below a Probe: a child and a group one each, a map's entry and its value two
fn nested_of(probe: &Probe) -> u64 {
    let child = probe
        .child
        .as_option()
        .map(|child| nested_of(child).saturating_add(1));
    let delimited = probe
        .delimited
        .as_option()
        .map(|delimited| nested_of(delimited).saturating_add(1));
    let children = probe
        .children
        .values()
        .map(|value| nested_of(value).saturating_add(2));

    child
        .into_iter()
        .chain(delimited)
        .chain(children)
        .max()
        .unwrap_or(0)
}

// what a read of a Probe below the top one gives: its text, its number, how deep below it
fn held_of(probe: &Probe) -> Value {
    json!({ "text": units_of(&probe.text), "number": probe.number, "nested": nested_of(probe) })
}

// what a read of the top Probe gives: each field it holds any of, beside its own
fn read_of(probe: &Probe) -> Value {
    let mut read = held_of(probe);

    if let Some(read) = read.as_object_mut() {
        if !probe.counts.is_empty() {
            read.insert("counts".to_owned(), json!(probe.counts));
        }

        if !probe.stamps.is_empty() {
            read.insert("stamps".to_owned(), json!(probe.stamps));
        }

        if !probe.children.is_empty() {
            let children: Map<String, Value> = probe
                .children
                .iter()
                .map(|(key, value)| (units_of(key), held_of(value)))
                .collect();

            read.insert("children".to_owned(), Value::Object(children));
        }

        if let Some(delimited) = probe.delimited.as_option() {
            read.insert("delimited".to_owned(), held_of(delimited));
        }

        // * a field of explicit presence: only its presence tells a record set it
        if let Some(shade) = probe.shade {
            read.insert("shade".to_owned(), json!(shade.to_i32()));
        }
    }

    read
}

// ── The codecs ────────────────────────────────────────────────────────────────

fn typed() -> ProtoCodec<Probe> {
    ProtoCodec::new()
}

// Probe's dynamic codec, by the pool its generated code embeds
fn dynamic() -> Result<DynamicCodec, Failed> {
    let pool = descriptor_pool();
    let index = pool
        .message_index("bead.codecs.v1.Probe")
        .ok_or("no Probe in its pool")?;

    Ok(DynamicCodec::new(Arc::clone(pool), index))
}

// what each codec reads of a payload, or why it refuses it: the dynamic message read as a Probe
fn reads_of(bytes: &Bytes) -> Result<[Result<Value, String>; 2], Failed> {
    let by_type = typed()
        .decode(bytes)
        .map(|probe| read_of(&probe))
        .map_err(|refusal| refusal.to_string());
    let by_descriptor = dynamic()?
        .decode(bytes)
        .map_err(|refusal| refusal.to_string())
        .and_then(|message| {
            message
                .to_message::<Probe>()
                .map(|probe| read_of(&probe))
                .map_err(|error| error.to_string())
        });

    Ok([by_type, by_descriptor])
}

fn play_payload(payload: &Payload) -> Result<(), Failed> {
    let bytes = bytes_of(&payload.bytes)?;

    for (codec, read) in ["typed", "dynamic"].into_iter().zip(reads_of(&bytes)?) {
        match (&payload.refused, &payload.read, read) {
            (Some(_), _, Err(_)) => {}
            (Some(reason), _, Ok(read)) => {
                return Err(format!(
                    "the {codec} codec read {read}, where it is refused: {reason}"
                )
                .into());
            }
            (None, Some(expected), Ok(read)) if read == *expected => {}
            (None, Some(_), Ok(read)) => {
                return Err(format!("the {codec} codec read {read}").into());
            }
            (None, _, Err(reason)) => {
                return Err(format!("the {codec} codec refused it: {reason}").into());
            }
            (None, None, Ok(_)) => {
                return Err("an entry says what it reads or why it is refused".into());
            }
        }
    }

    Ok(())
}

// the Probe the typed form holds of a value, where it holds it: a Needs's every required field
// given, and a shade its enum declares
fn probe_of(given: &ProbeGiven) -> Result<Option<Probe>, Failed> {
    let mut probe = Probe::default();

    if let Some(text) = &given.text {
        probe.text = string_of(text)?;
    }

    if let Some(number) = given.number {
        probe.number = number;
    }

    if given.child.is_some() {
        probe.child = MessageField::some(Probe::default());
    }

    if let Some(needs) = given.needs {
        let (Some(must), Some(shade)) = (needs.must, needs.shade) else {
            return Ok(None);
        };
        let Some(shade) = Shade::from_i32(shade) else {
            return Ok(None);
        };

        probe.needs = MessageField::some(Needs {
            must,
            shade,
            ..Needs::default()
        });
    }

    Ok(Some(probe))
}

// the dynamic message of a value, by Probe's descriptor: each field given set, and none other
fn message_of(given: &ProbeGiven, codec: &DynamicCodec) -> Result<DynamicMessage, Failed> {
    let pool = codec.schema().pool();
    let probe = pool.message(codec.schema().message());
    let field = |name: &str| {
        probe
            .field_by_name(name)
            .ok_or_else(|| format!("no Probe.{name}"))
    };
    let mut message = DynamicMessage::new(Arc::clone(pool), codec.schema().message());

    if let Some(text) = &given.text {
        message.set(field("text")?, Field::String(string_of(text)?));
    }

    if let Some(number) = given.number {
        message.set(field("number")?, Field::U32(number));
    }

    if given.child.is_some() {
        message.set(
            field("child")?,
            Field::Message(DynamicMessage::new(
                Arc::clone(pool),
                codec.schema().message(),
            )),
        );
    }

    if let Some(given) = given.needs {
        let index = pool
            .message_index("bead.codecs.v1.Needs")
            .ok_or("no Needs in its pool")?;
        let descriptor = pool.message(index);
        let mut needs = DynamicMessage::new(Arc::clone(pool), index);

        if let Some(must) = given.must {
            needs.set(
                descriptor.field_by_name("must").ok_or("no Needs.must")?,
                Field::U32(must),
            );
        }

        // * a dynamic message holds any number of a closed enum, which the walk then judges
        if let Some(shade) = given.shade {
            needs
                .try_set(
                    descriptor.field_by_name("shade").ok_or("no Needs.shade")?,
                    Field::EnumNumber(shade),
                )
                .map_err(|error| error.to_string())?;
        }

        message.set(field("needs")?, Field::Message(needs));
    }

    Ok(message)
}

fn play_value(entry: &Written) -> Result<(), Failed> {
    let given = entry
        .value
        .probe
        .as_ref()
        .ok_or("a proto writer is given a Probe")?;
    let codec = dynamic()?;
    let mut written = vec![(
        "dynamic",
        codec
            .encode(&message_of(given, &codec)?)
            .map_err(|refusal| refusal.to_string()),
    )];

    if let Some(probe) = probe_of(given)? {
        written.push((
            "typed",
            typed()
                .encode(&probe)
                .map_err(|refusal| refusal.to_string()),
        ));
    } else if entry.refused.is_none() {
        return Err("a value the typed form cannot hold, which is written".into());
    }

    for (codec, written) in written {
        match (&entry.refused, &entry.written, written) {
            (Some(_), _, Err(_)) => {}
            (Some(reason), _, Ok(written)) => {
                return Err(format!(
                    "the {codec} codec wrote {written:02X?}, where it is refused: {reason}"
                )
                .into());
            }
            (None, Some(expected), Ok(written)) if written == bytes_of(expected)? => {}
            (None, Some(_), Ok(written)) => {
                return Err(format!("the {codec} codec wrote {written:02X?}").into());
            }
            (None, _, Err(reason)) => {
                return Err(format!("the {codec} codec refused it: {reason}").into());
            }
            (None, None, Ok(_)) => {
                return Err("an entry says what it writes or why it is refused".into());
            }
        }
    }

    Ok(())
}

// ── Buffa's own forms, where Bead states no rule ──────────────────────────────

// a matrix row: the empty key written, as the TypeScript side writes it, where Google.Protobuf
// leaves it out as any field at its default
fn a_proto_map_s_entry_its_key_at_its_default_as_buffa_writes_it() -> Result<(), Failed> {
    let mut probe = Probe::default();

    probe.children.insert(String::new(), Probe::default());

    let written = typed()
        .encode(&probe)
        .map_err(|refusal| refusal.to_string())?;

    if written != bytes_of("62 04 0A 00 12 00")? {
        return Err(format!("wrote {written:02X?}").into());
    }

    Ok(())
}

fn trials() -> Result<Vec<Trial>, String> {
    // * read by Bead's own reader, as the core's player reads it
    let codecs: Codecs = files::read_by_bead("codecs.json")?;
    let mut trials = vec![Trial::test(
        "a_proto_map_s_entry_its_key_at_its_default_as_buffa_writes_it",
        a_proto_map_s_entry_its_key_at_its_default_as_buffa_writes_it,
    )];

    for payload in codecs.payloads {
        if payload.encoding != "proto" || is_excused(payload.differs.as_ref()) {
            continue;
        }

        let name = format!("reads {}", payload.name);

        trials.push(Trial::test(name, move || play_payload(&payload)).with_kind("payloads"));
    }

    for entry in codecs.values {
        if entry.encoding != "proto" || is_excused(entry.differs.as_ref()) {
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
