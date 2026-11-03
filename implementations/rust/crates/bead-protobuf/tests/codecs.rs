//! `spec/codecs.json`'s `proto` entries played against the Rust side's codecs of `Probe`, a trial
//! each: each payload read, or refused, through the typed codec over the code Buffa generated and
//! through the dynamic codec by `Probe`'s descriptor, what each read held to the entry's; each
//! value written, or refused, through the typed codec where a `Probe` holds it and through the
//! dynamic codec always. `needs set to no field` and `needs with a shade its enum does not declare`
//! no `Probe` holds, as the row `A proto value that leaves a required field unset or holds a closed
//! enum's undeclared number, given to a typed writer` says: the dynamic codec alone is given them.
//! A chain, `nested`, `entries` or `delimited`, is built from its deepest `Probe` up, in both forms.
//! The core's player, `bead/tests/codecs.rs`, plays the other encodings. Every refusal is a
//! [`CodecRefusal`], the codec trait's error, as the other sides' players hold theirs to its type,
//! its reason the entry's, exactly (spec 17.2): a codec that panics refuses nothing, and fails its
//! trial.

use std::process::ExitCode;
use std::sync::Arc;

use bead::testing::{Difference, files, hexadecimal, is_excused};
use bead::{CodecRefusal, PayloadCodec};
use bead_protobuf::testing::codecs::descriptor_pool;
use bead_protobuf::testing::codecs::{Needs, Probe, Shade};
use bead_protobuf::{DynamicCodec, ProtoCodec};
use buffa::{Enumeration, MessageField};
use buffa_descriptor::reflect::{DynamicMessage, MapKey, ReflectMessageMut, Value as Field};
use bytes::Bytes;
use libtest_mimic::{Arguments, Failed, Trial};
use serde::Deserialize;
use serde_json::{Map, Value, json};

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
    differs: Option<Vec<Difference>>,
}

/// A `Needs` given to a writer, each of its required fields where it is given.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
struct NeedsGiven {
    must: Option<u32>,
    shade: Option<i32>,
}

/// A `Probe` given to a writer, one field set or none, its text as UTF-16 code units; or a chain of
/// that many `Probe`s below it, through `child`, `children` or `delimited`, the deepest tallied
/// where it says so.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProbeGiven {
    text: Option<String>,
    number: Option<u32>,
    child: Option<Map<String, Value>>,
    needs: Option<NeedsGiven>,
    nested: Option<usize>,
    entries: Option<usize>,
    delimited: Option<usize>,
    tallied: Option<bool>,
}

/// How a chain holds the next `Probe`.
#[derive(Debug, Clone, Copy)]
enum Link {
    Child,
    Entry,
    Group,
}

impl ProbeGiven {
    // the chain it gives, how it links and how many below the top; none for a Probe of one field
    fn chain(&self) -> Option<(Link, usize)> {
        self.nested
            .map(|count| (Link::Child, count))
            .or_else(|| self.entries.map(|count| (Link::Entry, count)))
            .or_else(|| self.delimited.map(|count| (Link::Group, count)))
    }
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

// how deep messages nest below a Probe: a child and a group one each, a map's entry and its value two,
// a scalar map's entry one
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

    let tallies = (!probe.tallies.is_empty()).then_some(1);

    child
        .into_iter()
        .chain(delimited)
        .chain(children)
        .chain(tallies)
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

// what each codec reads of a payload, or its refusal: the dynamic message read as a Probe
fn reads_of(bytes: &Bytes) -> Result<[Result<Value, CodecRefusal>; 2], Failed> {
    let by_type = typed().decode(bytes).map(|probe| read_of(&probe));
    let by_descriptor = match dynamic()?.decode(bytes) {
        Ok(message) => Ok(read_of(
            &message
                .to_message::<Probe>()
                .map_err(|error| error.to_string())?,
        )),
        Err(refusal) => Err(refusal),
    };

    Ok([by_type, by_descriptor])
}

fn play_payload(payload: &Payload) -> Result<(), Failed> {
    let bytes = bytes_of(&payload.bytes)?;

    for (codec, read) in ["typed", "dynamic"].into_iter().zip(reads_of(&bytes)?) {
        match (&payload.refused, &payload.read, read) {
            // * a refusal, a CodecRefusal, its reason the entry's
            (Some(reason), _, Err(refusal)) if refusal.reason() == reason => {}
            (Some(reason), _, Err(refusal)) => {
                return Err(format!(
                    "the {codec} codec refused it, saying {refusal:?}, where it says {reason:?}"
                )
                .into());
            }
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

// a chain's top Probe, `count` below it linked as `link` says, the deepest tallied where `tallied`
fn typed_chain((link, count): (Link, usize), tallied: bool) -> Probe {
    let mut probe = Probe::default();

    if tallied {
        probe.tallies.insert("a".to_owned(), 1);
    }

    for _ in 0..count {
        let mut above = Probe::default();

        match link {
            Link::Child => above.child = MessageField::some(probe),
            Link::Entry => {
                above.children.insert(String::new(), probe);
            }
            Link::Group => above.delimited = MessageField::some(probe),
        }

        probe = above;
    }

    probe
}

// the Probe the typed form holds of a value, where it holds it: a Needs's every required field
// given, and a shade its enum declares
fn probe_of(given: &ProbeGiven) -> Result<Option<Probe>, Failed> {
    if let Some(chain) = given.chain() {
        return Ok(Some(typed_chain(chain, given.tallied.unwrap_or(false))));
    }

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

// a chain's top Probe as a dynamic message, as typed_chain builds it
fn dynamic_chain(
    ((link, count), tallied): ((Link, usize), bool),
    codec: &DynamicCodec,
) -> Result<DynamicMessage, Failed> {
    let pool = codec.schema().pool();
    let probe = pool.message(codec.schema().message());
    let field = |name: &str| {
        probe
            .field_by_name(name)
            .ok_or_else(|| format!("no Probe.{name}"))
    };
    let empty = || DynamicMessage::new(Arc::clone(pool), codec.schema().message());
    let mut message = empty();

    if tallied {
        message.set(
            field("tallies")?,
            Field::Map(core::iter::once((MapKey::String("a".to_owned()), Field::U32(1))).collect()),
        );
    }

    for _ in 0..count {
        let mut above = empty();

        match link {
            Link::Child => above.set(field("child")?, Field::Message(message)),
            Link::Entry => above.set(
                field("children")?,
                Field::Map(
                    core::iter::once((MapKey::String(String::new()), Field::Message(message)))
                        .collect(),
                ),
            ),
            Link::Group => above.set(field("delimited")?, Field::Message(message)),
        }

        message = above;
    }

    Ok(message)
}

// the dynamic message of a value, by Probe's descriptor: each field given set, and none other
fn message_of(given: &ProbeGiven, codec: &DynamicCodec) -> Result<DynamicMessage, Failed> {
    if let Some(chain) = given.chain() {
        return dynamic_chain((chain, given.tallied.unwrap_or(false)), codec);
    }

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
    let mut written: Vec<(&str, Result<Bytes, CodecRefusal>)> =
        vec![("dynamic", codec.encode(&message_of(given, &codec)?))];

    if let Some(probe) = probe_of(given)? {
        written.push(("typed", typed().encode(&probe)));
    } else if entry.refused.is_none() {
        return Err("a value the typed form cannot hold, which is written".into());
    }

    for (codec, written) in written {
        match (&entry.refused, &entry.written, written) {
            // * a refusal, a CodecRefusal, its reason the entry's
            (Some(reason), _, Err(refusal)) if refusal.reason() == reason => {}
            (Some(reason), _, Err(refusal)) => {
                return Err(format!(
                    "the {codec} codec refused it, saying {refusal:?}, where it says {reason:?}"
                )
                .into());
            }
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

// a matrix row: the empty key and the value 0 written, as the TypeScript side writes them, where
// Google.Protobuf leaves each out as any field at its default
fn a_proto_map_s_entry_its_key_or_its_value_at_its_default_as_buffa_writes_it() -> Result<(), Failed>
{
    let mut keyed = Probe::default();
    let mut valued = Probe::default();

    keyed.children.insert(String::new(), Probe::default());
    valued.tallies.insert("a".to_owned(), 0);

    for (probe, expected) in [
        (keyed, "62 04 0A 00 12 00"),
        (valued, "82 01 05 0A 01 61 10 00"),
    ] {
        let written = typed()
            .encode(&probe)
            .map_err(|refusal| refusal.to_string())?;

        if written != bytes_of(expected)? {
            return Err(format!("wrote {written:02X?}, where {expected} is Buffa's form").into());
        }
    }

    Ok(())
}

// a matrix row: the entries read back, order aside, since hashbrown writes them in an order of its
// own on each run, where the TypeScript side writes integer keys first and the C# side the order
// read; each written entry one of those given, none twice
fn a_proto_map_s_entries_in_the_order_its_library_writes_them() -> Result<(), Failed> {
    // * tallies keyed b, 1, a, 0, in that order, each entry of 8 bytes
    let entries = [
        "82 01 05 0A 01 62 10 01",
        "82 01 05 0A 01 31 10 02",
        "82 01 05 0A 01 61 10 03",
        "82 01 05 0A 01 30 10 04",
    ];
    let read = typed()
        .decode(&bytes_of(&entries.join(" "))?)
        .map_err(|refusal| refusal.to_string())?;
    let written = typed()
        .encode(&read)
        .map_err(|refusal| refusal.to_string())?;
    let mut left = entries
        .iter()
        .map(|entry| bytes_of(entry))
        .collect::<Result<Vec<Bytes>, Failed>>()?;
    let mut rest: &[u8] = &written;

    while let Some((entry, after)) = rest.split_at_checked(8) {
        let Some(at) = left.iter().position(|each| each.as_ref() == entry) else {
            return Err(format!("wrote {written:02X?}, an entry not given among them").into());
        };

        left.remove(at);
        rest = after;
    }

    if !rest.is_empty() || !left.is_empty() {
        return Err(format!("wrote {written:02X?}, not the entries given").into());
    }

    let again = typed()
        .decode(&written)
        .map_err(|refusal| refusal.to_string())?;

    if again.tallies != read.tallies {
        return Err("read back other entries".into());
    }

    Ok(())
}

fn trials() -> Result<Vec<Trial>, String> {
    // * read by Bead's own reader, as the core's player reads it
    let codecs: Codecs = files::read_by_bead("codecs.json")?;
    let mut trials = vec![
        Trial::test(
            "a_proto_map_s_entry_its_key_or_its_value_at_its_default_as_buffa_writes_it",
            a_proto_map_s_entry_its_key_or_its_value_at_its_default_as_buffa_writes_it,
        ),
        Trial::test(
            "a_proto_map_s_entries_in_the_order_its_library_writes_them",
            a_proto_map_s_entries_in_the_order_its_library_writes_them,
        ),
    ];

    for payload in codecs.payloads {
        if payload.encoding != "proto" || is_excused(payload.differs.as_deref().unwrap_or_default())
        {
            continue;
        }

        let name = format!("reads {}", payload.name);

        trials.push(Trial::test(name, move || play_payload(&payload)).with_kind("payloads"));
    }

    for entry in codecs.values {
        if entry.encoding != "proto" || is_excused(entry.differs.as_deref().unwrap_or_default()) {
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
