//! The frame meter of the WebSocket transport fed seeded mutations of the frames a client sends
//! (spec 15.3, decision 0056), with the `websocket-frames` fuzz target's properties, which
//! `bead::testing::websocket_frames` holds for both: the meter and tungstenite, which reads the
//! same bytes from a cursor, agree on the bounds of each frame, on the end of each message, and on
//! whether the stream fails, and at which frame; the meter hands the same bytes whether its input
//! comes whole or cut where the input's first byte says, never panics and never takes over a
//! second. The generator is `bead::testing::mutations`, the other sides' own.

use std::panic::{self, AssertUnwindSafe};
use std::sync::LazyLock;
use std::time::Duration;

use bead::testing::Instant;
use bead::testing::mutations::{Generator, lower_hex_of, mutate, ordered};
use bead::testing::websocket_frames::broken;
use bead::testing::wire::Frame;

// how many inputs a seed draws: BEAD_FUZZ_INPUTS raises it for a longer run
fn inputs() -> usize {
    std::env::var("BEAD_FUZZ_INPUTS")
        .ok()
        .and_then(|inputs| inputs.parse().ok())
        .unwrap_or(20_000)
}

fn frame_of(opcode: u8, (payload, fin): (&[u8], bool)) -> Vec<u8> {
    Frame {
        fin,
        opcode,
        payload: payload.to_vec(),
        length: None,
    }
    .masked()
}

// the frames a client sends a server, after the byte that has a server read them cut in two after
// their fifth byte: a text message whole; a binary one in fragments, a ping, an empty frame and a
// pong between them; a length of 16 bits; one of 64 bits in its longest form; a close
static SEEDS: LazyLock<Vec<Vec<u8>>> = LazyLock::new(|| {
    let mut fragments = frame_of(0x2, (&[1, 2, 3], false));

    fragments.extend(frame_of(0x9, (b"beat", true)));
    fragments.extend(frame_of(0x0, (&[], false)));
    fragments.extend(frame_of(0xA, (&[], true)));
    fragments.extend(frame_of(0x0, (&[4], true)));

    let mut longest = vec![0x82, 0xFF, 0, 0, 0, 0, 0, 0, 0, 3, 0x37, 0xFA, 0x21, 0x3D];

    longest.extend([0x36, 0xF8, 0x22]);

    ordered(
        [
            frame_of(0x1, (b"bead", true)),
            fragments,
            frame_of(0x2, (&[0x5A; 200], true)),
            longest,
            frame_of(0x8, (&1_000_u16.to_be_bytes(), true)),
        ]
        .into_iter()
        .map(|frames| [&[0x0A][..], &frames].concat())
        .collect(),
    )
});

// what `input` gives that breaks a property, with the input: a break, a panic, or a check past a
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

fn meters_every_mutation_of_a_client_s_frames_as_tungstenite_reads_them(
    seed: u32,
) -> Result<(), String> {
    let seeds = SEEDS.as_slice();
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
fn meters_every_seed_as_tungstenite_reads_it() -> Result<(), String> {
    for seed in SEEDS.iter() {
        if let Some(broken) = broken(seed) {
            return Err(format!("{broken}; seed {}", lower_hex_of(seed)));
        }
    }

    assert_eq!(SEEDS.len(), 5, "a seed a frame or a message in frames");

    Ok(())
}

#[test]
fn meters_every_mutation_of_a_client_s_frames_as_tungstenite_reads_them_seed_1()
-> Result<(), String> {
    meters_every_mutation_of_a_client_s_frames_as_tungstenite_reads_them(1)
}

#[test]
fn meters_every_mutation_of_a_client_s_frames_as_tungstenite_reads_them_seed_2()
-> Result<(), String> {
    meters_every_mutation_of_a_client_s_frames_as_tungstenite_reads_them(2)
}
