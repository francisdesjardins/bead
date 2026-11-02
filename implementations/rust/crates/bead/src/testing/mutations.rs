//! Seeded mutations of the conformance files' bytes, which the suite's readers are fed.
//!
//! One generator, the same on every side (decision 0006), so a seed draws the same inputs from the
//! same seeds wherever it runs. The TypeScript side's twin is
//! `src/router/shared/__tests__/mutations.ts`, the C# side's `tests/Shared/Mutations.cs`.
//!
//! The seeds are ordered by their SHA-1, which no walk of a JSON object can change; each twin
//! asserts their count, the SHA-256 of their hexadecimal a line each, and the SHA-256 of the first
//! eight inputs a seed of 1 draws, the same values on every side.

use core::fmt::Write as _;

use serde_json::Value;
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::testing::hexadecimal;

/// The bytes a mutation may write, as the other sides' generators hold them.
const INTERESTING: [u8; 9] = [0x00, 0x01, 0x7F, 0x80, 0xFF, 0x10, 0x11, 0x12, 0xA1];

/// A xorshift32 generator: [`below`](Self::below) draws in `[0, count)`, and one seed replays.
#[derive(Debug, Clone)]
pub struct Generator {
    state: u32,
}

impl Generator {
    /// The generator of `seed`, 1 for a seed of 0.
    #[must_use]
    pub fn new(seed: u32) -> Self {
        Self {
            state: if seed == 0 { 1 } else { seed },
        }
    }

    /// The next draw, in `[0, count)`: 0 for a count of 0.
    pub fn below(&mut self, count: usize) -> usize {
        self.state ^= self.state.wrapping_shl(13);
        self.state ^= self.state.wrapping_shr(17);
        self.state ^= self.state.wrapping_shl(5);

        usize::try_from(self.state)
            .unwrap_or(usize::MAX)
            .checked_rem(count)
            .unwrap_or(0)
    }

    // a draw in [0, count) as a byte's: the counts drawn here are 256 at most
    fn byte_below(&mut self, count: usize) -> u8 {
        u8::try_from(self.below(count)).unwrap_or(u8::MAX)
    }

    // an item of `items` drawn
    fn of<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        items.get(self.below(items.len()))
    }
}

/// `source` changed by one to four edits drawn from `generator`.
///
/// Each is a bit flipped, a byte of [`INTERESTING`] put in or written over one, bytes removed, the
/// rest cut, the rest replaced by a tail of another seed of `seeds`, or random bytes put in, each
/// drawn as the other sides' are, in their order.
pub fn mutate(source: &[u8], (generator, seeds): (&mut Generator, &[Vec<u8>])) -> Vec<u8> {
    let mut bytes = source.to_vec();

    for _ in 0..generator.below(4).saturating_add(1) {
        let at = generator.below(bytes.len().saturating_add(1));

        match generator.below(7) {
            // ! a bit and a byte are drawn only where there is a byte, as on the other sides
            0 => {
                if let Some(at) = at.checked_rem(bytes.len()) {
                    let bit = u32::from(generator.byte_below(8));

                    if let Some(byte) = bytes.get_mut(at) {
                        *byte ^= 1_u8.wrapping_shl(bit);
                    }
                }
            }
            1 => {
                let byte = generator.of(&INTERESTING).copied().unwrap_or(0);

                bytes.insert(at, byte);
            }
            2 => {
                let end = at
                    .saturating_add(generator.below(4))
                    .saturating_add(1)
                    .min(bytes.len());

                bytes.drain(at..end);
            }
            3 => bytes.truncate(at),
            4 => {
                let other = generator.of(seeds).cloned().unwrap_or_default();
                let from = generator.below(other.len().saturating_add(1));

                bytes.truncate(at);
                bytes.extend(other.get(from..).unwrap_or_default());
            }
            5 => {
                if let Some(at) = at.checked_rem(bytes.len()) {
                    let byte = generator.of(&INTERESTING).copied().unwrap_or(0);

                    if let Some(written) = bytes.get_mut(at) {
                        *written = byte;
                    }
                }
            }
            _ => {
                let count = generator.below(16).saturating_add(1);
                let random: Vec<u8> = (0..count).map(|_| generator.byte_below(256)).collect();

                bytes.splice(at..at, random);
            }
        }
    }

    bytes
}

/// The bytes a conformance file holds under each `bytes` or `record` key at any depth, its spaces
/// and bars aside, ordered by [`ordered`].
#[must_use]
pub fn seeds_of(file: &Value) -> Vec<Vec<u8>> {
    let mut seeds = Vec::new();

    collect(file, &mut seeds);

    ordered(seeds)
}

fn collect(value: &Value, seeds: &mut Vec<Vec<u8>>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect(item, seeds);
            }
        }
        Value::Object(members) => {
            for (name, inner) in members {
                let bytes = inner
                    .as_str()
                    .filter(|_| name == "bytes" || name == "record")
                    .and_then(|text| {
                        let digits: String = text
                            .chars()
                            .filter(|unit| !unit.is_whitespace() && *unit != '|')
                            .collect();

                        (!digits.is_empty() && digits.chars().all(|unit| unit.is_ascii_hexdigit()))
                            .then(|| hexadecimal::bytes_of(&digits))
                            .flatten()
                    });

                match bytes {
                    Some(bytes) => seeds.push(bytes),
                    None => collect(inner, seeds),
                }
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

/// `seeds` ordered by their SHA-1, its hexadecimal ascending: the order every side draws them in,
/// whatever order its reader of the file walks them in.
#[must_use]
pub fn ordered(seeds: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    let mut keyed: Vec<([u8; 20], Vec<u8>)> = seeds
        .into_iter()
        .map(|seed| (Sha1::digest(&seed).into(), seed))
        .collect();

    keyed.sort();

    keyed.into_iter().map(|(_, seed)| seed).collect()
}

/// The SHA-256, in lowercase hexadecimal, of `inputs`' hexadecimal, lowercase and unspaced, each a
/// line ended by a line feed: what every side's twin asserts of its seeds and of its first inputs.
#[must_use]
pub fn digest_of(inputs: &[Vec<u8>]) -> String {
    let mut hash = Sha256::new();

    for input in inputs {
        hash.update(lower_hex_of(input));
        hash.update(b"\n");
    }

    lower_hex_of(&hash.finalize())
}

/// The first `count` inputs `seed` draws from `seeds`, as each twin draws them: a seed of `seeds`
/// drawn, then mutated.
#[must_use]
pub fn first_inputs(seeds: &[Vec<u8>], (seed, count): (u32, usize)) -> Vec<Vec<u8>> {
    let mut generator = Generator::new(seed);

    (0..count)
        .map(|_| {
            let source = generator.of(seeds).cloned().unwrap_or_default();

            mutate(&source, (&mut generator, seeds))
        })
        .collect()
}

/// `bytes` in lowercase hexadecimal, unspaced.
#[must_use]
pub fn lower_hex_of(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut text, byte| {
        // ! a String's writing never fails
        write!(text, "{byte:02x}").ok();

        text
    })
}
