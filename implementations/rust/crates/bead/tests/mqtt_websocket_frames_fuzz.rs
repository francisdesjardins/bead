//! The MQTT 5 client's reader of its WebSocket's frames fed seeded mutations of the frames a server
//! sends it (spec 15.25, decision 0050), with the `mqtt-websocket-frames` fuzz target's properties:
//! the reader gives an event, the want of more bytes or a refusal, never panics and never takes over
//! a second; it gives the same events, a binary message's pieces joined, and the same refusal,
//! whether its input comes whole or cut where the input's first byte says; and once it wants more
//! bytes, what it holds is less than a whole frame head, or a control frame's head and less than its
//! payload. The generator is `bead::testing::mutations`, the other sides' own; the reader and its
//! target are the Rust side's alone, its client Bead's own (decision 0050).

use std::panic::{self, AssertUnwindSafe};
use std::sync::LazyLock;
use std::time::Duration;

use bead::internal::{MqttFrameEvent, MqttFrameReader, MqttFrameRefusal};
use bead::testing::mutations::{Generator, digest_of, lower_hex_of, mutate, ordered};
use bead::testing::{Instant, hexadecimal};
use bytes::BytesMut;

// how many inputs a seed draws: BEAD_FUZZ_INPUTS raises it for a longer run
fn inputs() -> usize {
    std::env::var("BEAD_FUZZ_INPUTS")
        .ok()
        .and_then(|inputs| inputs.parse().ok())
        .unwrap_or(20_000)
}

// the bytes a frame's head takes at most, and a control frame's payload (RFC 6455 §5.2, §5.5)
const HEAD_BYTES: usize = 14;
const CONTROL_BYTES: usize = 125;

// the frames a server sends a client of MQTT 5 over a WebSocket: a binary frame whole, its CONNACK;
// one fragmented with a ping between; a pong; a close; a head of a 64-bit length
const FRAMES: [&str; 5] = [
    "82 05 20 03 00 00 00",
    "02 02 20 03 89 04 62 65 61 74 80 03 00 00 00",
    "8A 00",
    "88 02 03 E8",
    "82 7F 00 00 00 00 00 01 00 00 30 00",
];

// the seeds, the bytes of every frame, ordered by their SHA-1
static SEEDS: LazyLock<Result<Vec<Vec<u8>>, String>> = LazyLock::new(|| {
    FRAMES
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

// what a read gives, a binary message's pieces joined, a ping's payload, and the refusal that ended
// them
#[derive(Debug, Default, PartialEq, Eq)]
struct Read {
    events: Vec<(&'static str, Vec<u8>)>,
    refusal: Option<MqttFrameRefusal>,
}

impl Read {
    fn push(&mut self, event: MqttFrameEvent) {
        let (kind, bytes) = match event {
            MqttFrameEvent::Bytes(bytes) => ("bytes", bytes.to_vec()),
            MqttFrameEvent::Ping(payload) => ("ping", payload.to_vec()),
            MqttFrameEvent::Pong => ("pong", Vec::new()),
            MqttFrameEvent::Close => ("close", Vec::new()),
        };

        match self.events.last_mut() {
            Some(("bytes", joined)) if kind == "bytes" => joined.extend_from_slice(&bytes),
            _ => self.events.push((kind, bytes)),
        }
    }
}

// each piece of `pieces` given to one reader in turn, read until it wants more or refuses; what it
// gave, or the break of its invariant
fn read_of(pieces: &[&[u8]]) -> Result<Read, String> {
    let mut reader = MqttFrameReader::new();
    let mut buffer = BytesMut::new();
    let mut read = Read::default();

    for piece in pieces {
        buffer.extend_from_slice(piece);

        loop {
            match reader.read(&mut buffer) {
                Ok(Some(event)) => read.push(event),
                Ok(None) => break,
                Err(refusal) => {
                    read.refusal = Some(refusal);

                    return Ok(read);
                }
            }
        }

        // * nothing reserved at a frame's head: less than a head held, or a control frame's head
        // and less than its payload
        let is_control = buffer.first().is_some_and(|first| first & 0x08 != 0);

        if buffer.len() >= HEAD_BYTES
            && !(is_control && buffer.len() < HEAD_BYTES.saturating_add(CONTROL_BYTES))
        {
            return Err(format!(
                "{} bytes held once it wanted more: {}",
                buffer.len(),
                lower_hex_of(&buffer)
            ));
        }
    }

    Ok(read)
}

// what the frames `input` reads as breaks of the target's properties, none where it holds them
fn broken(input: &[u8]) -> Option<String> {
    let whole = match read_of(&[input]) {
        Ok(whole) => whole,
        Err(broken) => return Some(broken),
    };
    let at = input.first().map_or(0, |first| {
        usize::from(*first)
            .checked_rem(input.len().saturating_add(1))
            .unwrap_or(0)
    });
    let pieces: [&[u8]; 2] = input.split_at(at.min(input.len())).into();
    let cut = match read_of(&pieces) {
        Ok(cut) => cut,
        Err(broken) => return Some(broken),
    };

    (whole != cut).then(|| format!("read whole as {whole:?}, cut at {at} as {cut:?}"))
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

fn reads_or_refuses_every_mutation_of_a_server_s_frames(seed: u32) -> Result<(), String> {
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
fn reads_every_seed_unrefused() -> Result<(), String> {
    let seeds = seeds()?;

    for seed in seeds {
        match read_of(&[seed]) {
            Ok(read) if read.refusal.is_none() && !read.events.is_empty() => {}
            read => return Err(format!("{} read as {read:?}", lower_hex_of(seed))),
        }
    }

    assert_eq!(seeds.len(), FRAMES.len(), "a seed a frame");
    assert_eq!(
        digest_of(seeds),
        "ce9d8aa9e4f964ff50a345e9445a83b1609d25150cf0ae337bdcbe52ed63a2ab",
        "the seeds in their order, as tools/fuzz.mjs holds them"
    );

    Ok(())
}

#[test]
fn reads_or_refuses_every_mutation_of_a_server_s_frames_seed_1() -> Result<(), String> {
    reads_or_refuses_every_mutation_of_a_server_s_frames(1)
}

#[test]
fn reads_or_refuses_every_mutation_of_a_server_s_frames_seed_2() -> Result<(), String> {
    reads_or_refuses_every_mutation_of_a_server_s_frames(2)
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
