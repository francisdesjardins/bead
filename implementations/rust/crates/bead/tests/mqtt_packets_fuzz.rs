//! The MQTT 5 client's packet reader fed seeded mutations of the packets a broker sends it (spec
//! 15.29, decision 0050), with the `mqtt-packets` fuzz target's properties: the reader gives a
//! packet, the want of more bytes or a refusal, never panics and never takes over a second; a packet
//! it reads takes no more bytes than it was given, and is refused past a bound one byte short of
//! it; a PUBLISH it reads is written again in exactly the bytes spec 15.30 counts, which read as
//! the same PUBLISH. The generator is `bead::testing::mutations`, the other sides' own; the reader
//! and its target are the Rust side's alone, its client Bead's own (decision 0050).

use std::panic::{self, AssertUnwindSafe};
use std::sync::LazyLock;
use std::time::Duration;

use bead::internal::{
    LARGEST_PACKET_SIZE, MqttPacket, MqttPublishShapeOptions, MqttReading, MqttRefusal,
    publish_bytes, read_packet, write_publish,
};
use bead::testing::mutations::{Generator, digest_of, lower_hex_of, mutate, ordered};
use bead::testing::{Instant, hexadecimal};

// how many inputs a seed draws: BEAD_FUZZ_INPUTS raises it for a longer run
fn inputs() -> usize {
    std::env::var("BEAD_FUZZ_INPUTS")
        .ok()
        .and_then(|inputs| inputs.parse().ok())
        .unwrap_or(20_000)
}

// the packets a broker sends a client, each in a shape MQTT 5.0 allows: a CONNACK bare, one of every
// property a client keeps, and one that refuses; a PUBLISH of QoS 0 and 1, a life and a retain
// among them; each acknowledgement, its code left out or given; a PINGRESP; a DISCONNECT bare and
// of 0x8E
const PACKETS: [&str; 14] = [
    "20 03 00 00 00",
    "20 1C 00 00 19 21 00 02 2A 00 27 00 00 04 00 26 00 01 6B 00 01 76 24 01 13 00 01 22 00 0A",
    "20 08 00 86 05 1F 00 02 6E 6F",
    "30 0E 00 0A 62 65 61 64 2F 69 2F 61 64 61 00 09",
    "33 15 00 0A 62 65 61 64 2F 69 2F 61 64 61 00 07 05 02 00 00 00 3C 09",
    "3A 13 00 0A 62 65 61 64 2F 64 2F 62 6F 62 00 01 02 01 01 01 FF",
    "40 02 00 05",
    "40 03 00 05 10",
    "40 09 00 05 87 05 1F 00 02 6E 6F",
    "90 04 00 01 00 01",
    "B0 04 00 02 00 11",
    "D0 00",
    "E0 00",
    "E0 07 8E 05 1F 00 02 6E 6F",
];

// the seeds, the bytes of every packet, ordered by their SHA-1
static SEEDS: LazyLock<Result<Vec<Vec<u8>>, String>> = LazyLock::new(|| {
    PACKETS
        .iter()
        .map(|text| {
            hexadecimal::bytes_of(text).ok_or_else(|| format!("{text:?} is no hexadecimal"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(ordered)
});

fn seeds() -> Result<&'static [Vec<u8>], String> {
    SEEDS.as_deref().map_err(Clone::clone)
}

// what the packet `input` reads as breaks of the target's properties, none where it holds them
fn broken(input: &[u8]) -> Option<String> {
    let (packet, length) = match read_packet(input, LARGEST_PACKET_SIZE) {
        Ok(MqttReading::Packet { packet, length }) => (packet, length),
        Ok(MqttReading::Partial) | Err(MqttRefusal::Malformed(_)) => return None,
        Err(refused @ MqttRefusal::PastMaximum { .. }) => {
            return Some(format!("refused past the largest packet: {refused}"));
        }
    };

    if length > input.len() {
        return Some(format!("took {length} bytes of {}", input.len()));
    }

    // * one byte short of its size, it is refused as soon as its Remaining Length is read
    let short = u32::try_from(length.saturating_sub(1)).unwrap_or(u32::MAX);

    if !matches!(
        read_packet(input, short),
        Err(MqttRefusal::PastMaximum { .. })
    ) {
        return Some(format!("read within {short} bytes: {packet:?}"));
    }

    let MqttPacket::Publish(publish) = packet else {
        return None;
    };
    let mut shape = MqttPublishShapeOptions::default();

    shape.is_at_most_once = Some(publish.packet_identifier.is_none());
    shape.has_life = Some(publish.message_expiry_interval.is_some());

    let counted = publish_bytes(
        u64::try_from(publish.topic.len()).unwrap_or(u64::MAX),
        u64::try_from(publish.payload.len()).unwrap_or(u64::MAX),
        &shape,
    );

    match write_publish(&publish) {
        Err(refused) => Some(format!("not written again, {refused}: {publish:?}")),
        Ok(written) if u64::try_from(written.len()).ok() != Some(counted) => Some(format!(
            "written in {} bytes, counted {counted}: {publish:?}",
            written.len()
        )),
        Ok(written) => match read_packet(&written, LARGEST_PACKET_SIZE) {
            Ok(MqttReading::Packet {
                packet: MqttPacket::Publish(again),
                length,
            }) if again == publish && length == written.len() => None,
            again => Some(format!("what it wrote reads as {again:?}: {publish:?}")),
        },
    }
}

// what `input` gives that breaks a property, with the input: a break, a panic, or a read past a
// second
fn defect_of(check: impl FnOnce() -> Option<String>, input: &[u8]) -> Option<String> {
    let started = Instant::now();
    let checked = panic::catch_unwind(AssertUnwindSafe(check));
    let hex = lower_hex_of(input);

    match checked {
        Err(panicked) => {
            let said = panicked
                .downcast_ref::<&str>()
                .map(ToString::to_string)
                .or_else(|| panicked.downcast_ref::<String>().cloned())
                .unwrap_or_default();

            Some(format!("a panic: {said}; input {hex}"))
        }
        Ok(Some(broken)) => Some(format!("{broken}; input {hex}")),
        Ok(None) if started.elapsed() > Duration::from_secs(1) => {
            Some(format!("over a second; input {hex}"))
        }
        Ok(None) => None,
    }
}

fn reads_or_refuses_every_mutation_of_a_brokers_packet(seed: u32) -> Result<(), String> {
    let seeds = seeds()?;
    let mut generator = Generator::new(seed);
    let mut defects = Vec::new();

    for _ in 0..inputs() {
        let source = seeds.get(generator.below(seeds.len())).ok_or("no seed")?;
        let input = mutate(source, (&mut generator, seeds));

        defects.extend(defect_of(|| broken(&input), &input));
    }

    if defects.is_empty() {
        Ok(())
    } else {
        Err(format!("{defects:#?}"))
    }
}

#[test]
fn reads_every_seed_whole() -> Result<(), String> {
    let seeds = seeds()?;

    for seed in seeds {
        match read_packet(seed, LARGEST_PACKET_SIZE) {
            Ok(MqttReading::Packet { length, .. }) if length == seed.len() => {}
            read => return Err(format!("{} read as {read:?}", lower_hex_of(seed))),
        }
    }

    assert_eq!(seeds.len(), PACKETS.len(), "a seed a packet");
    assert_eq!(
        digest_of(seeds),
        "5aefa6a26a2fb2c54568282055a1c6fbc81423f0ebf2708bd154a6a265b1246e",
        "the seeds in their order, as tools/fuzz.mjs holds them"
    );

    Ok(())
}

#[test]
fn reads_or_refuses_every_mutation_of_a_brokers_packet_seed_1() -> Result<(), String> {
    reads_or_refuses_every_mutation_of_a_brokers_packet(1)
}

#[test]
fn reads_or_refuses_every_mutation_of_a_brokers_packet_seed_2() -> Result<(), String> {
    reads_or_refuses_every_mutation_of_a_brokers_packet(2)
}

#[test]
fn reports_an_exception_that_is_no_refusal() {
    let defect = defect_of(|| panic!("boom"), &[0x01]);

    assert_eq!(
        defect.as_deref(),
        Some("a panic: boom; input 01"),
        "reported, with its input"
    );
}
