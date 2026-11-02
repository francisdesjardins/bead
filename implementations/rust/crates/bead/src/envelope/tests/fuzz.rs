//! The envelope and failure readers fed the same seeded mutations as both other sides.

use core::fmt;
use core::time::Duration;

use bytes::Bytes;
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};

use crate::constants::RouterSide;
use crate::envelope::{ReadEnvelopeOptions, read_envelope, read_failure};
use crate::failure::Failure;
use crate::testing::{Instant, files, hexadecimal};

const INTERESTING: [u8; 9] = [0, 1, 0x7f, 0x80, 0xff, 0x10, 0x11, 0x12, 0xa1];

// The visitor walks members in the file's order, as JavaScript and .NET do. A Value's sorted map
// would draw a different corpus for the same seed.
struct Collect<'a> {
    seeds: &'a mut Vec<Vec<u8>>,
    is_seed: bool,
}

impl<'de> DeserializeSeed<'de> for Collect<'_> {
    type Value = ();

    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Collect<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a vector's JSON value")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<(), M::Error> {
        while let Some(key) = map.next_key::<String>()? {
            map.next_value_seed(Collect {
                seeds: self.seeds,
                is_seed: key == "bytes" || key == "record",
            })?;
        }
        Ok(())
    }

    fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> Result<(), S::Error> {
        while seq
            .next_element_seed(Collect {
                seeds: self.seeds,
                is_seed: false,
            })?
            .is_some()
        {}
        Ok(())
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<(), E> {
        if self.is_seed
            && let Some(bytes) = hexadecimal::bytes_of(value).filter(|bytes| !bytes.is_empty())
        {
            self.seeds.push(bytes);
        }
        Ok(())
    }

    fn visit_bool<E: serde::de::Error>(self, _value: bool) -> Result<(), E> {
        Ok(())
    }
    fn visit_i64<E: serde::de::Error>(self, _value: i64) -> Result<(), E> {
        Ok(())
    }
    fn visit_u64<E: serde::de::Error>(self, _value: u64) -> Result<(), E> {
        Ok(())
    }
    fn visit_f64<E: serde::de::Error>(self, _value: f64) -> Result<(), E> {
        Ok(())
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<(), E> {
        Ok(())
    }
}

fn seeds() -> Vec<Vec<u8>> {
    let text = files::text_of("vectors.json").expect("vectors");
    let mut seeds = Vec::new();
    let mut reader = serde_json::Deserializer::from_str(&text);
    Collect {
        seeds: &mut seeds,
        is_seed: false,
    }
    .deserialize(&mut reader)
    .expect("collected in file order");
    reader.end().expect("the whole file");
    seeds
}

struct Generator(u32);

impl Generator {
    const fn new(seed: u32) -> Self {
        Self(if seed == 0 { 1 } else { seed })
    }

    fn below(&mut self, count: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        usize::try_from(self.0)
            .expect("a u32 fits usize")
            .checked_rem(count)
            .expect("a positive count")
    }

    fn mutate(&mut self, source: &[u8], seeds: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = source.to_vec();
        for _ in 0..=self.below(4) {
            let at = self.below(bytes.len().saturating_add(1));
            match self.below(7) {
                0 if !bytes.is_empty() => {
                    let index = at.checked_rem(bytes.len()).expect("a nonempty input");
                    bytes[index] ^= 1 << self.below(8);
                }
                1 => bytes.insert(at, INTERESTING[self.below(INTERESTING.len())]),
                2 => {
                    bytes.drain(
                        at..(at.saturating_add(1).saturating_add(self.below(4))).min(bytes.len()),
                    );
                }
                3 => bytes.truncate(at),
                4 => {
                    let other = &seeds[self.below(seeds.len())];
                    bytes.truncate(at);
                    bytes.extend_from_slice(&other[self.below(other.len().saturating_add(1))..]);
                }
                5 if !bytes.is_empty() => {
                    let index = at.checked_rem(bytes.len()).expect("a nonempty input");
                    bytes[index] = INTERESTING[self.below(INTERESTING.len())];
                }
                6 => {
                    let inserted = (0..=self.below(16))
                        .map(|_| u8::try_from(self.below(256)).expect("a byte"))
                        .collect::<Vec<_>>();
                    bytes.splice(at..at, inserted);
                }
                0 | 5 => {}
                _ => panic!("below seven"),
            }
        }
        bytes
    }
}

fn defect<T>(read: impl FnOnce() -> Result<T, Failure>, input: &[u8]) -> Option<String> {
    let started = Instant::now();
    if let Err(panicked) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(read)) {
        let words = panicked
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| panicked.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("a non-string panic");
        return Some(format!(
            "panic: {words}; input {}",
            hexadecimal::text_of(input)
        ));
    }
    (started.elapsed() > Duration::from_secs(1))
        .then(|| format!("over a second; input {}", hexadecimal::text_of(input)))
}

#[test]
fn find_the_vectors_bytes() {
    assert!(seeds().len() > 100);
}

#[test]
fn draws_what_the_c_side_draws_for_a_seed() {
    let mut generator = Generator::new(1);
    assert_eq!(
        (0..8).map(|_| generator.below(1_000)).collect::<Vec<_>>(),
        [369, 689, 461, 695, 233, 504, 482, 210]
    );
}

#[test]
fn reads_or_refuses_with_a_failure_every_mutation_of_a_vector() {
    let seeds = seeds();
    let inputs = std::env::var("BEAD_FUZZ_INPUTS")
        .ok()
        .map_or(20_000, |count| {
            count.parse::<usize>().expect("BEAD_FUZZ_INPUTS is a count")
        });
    let options = ReadEnvelopeOptions {
        maximum_envelope_bytes: Some(16_778_240),
        maximum_detail_bytes: Some(1_024),
        ..ReadEnvelopeOptions::default()
    };
    for seed in [1, 2] {
        let mut generator = Generator::new(seed);
        for index in 0..inputs {
            let source = &seeds[generator.below(seeds.len())];
            let input = generator.mutate(source, &seeds);
            let bytes = Bytes::copy_from_slice(&input);
            for side in [RouterSide::Server, RouterSide::Client] {
                assert_eq!(
                    defect(|| read_envelope(&bytes, side, &options), &input),
                    None,
                    "seed {seed}, input {index}, {side:?}, envelope"
                );
                assert_eq!(
                    defect(|| read_failure(&input, (side, 1_024)), &input),
                    None,
                    "seed {seed}, input {index}, {side:?}, failure record"
                );
            }
        }
    }
}

#[test]
fn reports_an_exception_that_is_no_failure() {
    assert_eq!(
        defect::<()>(|| panic!("boom"), &[1]).as_deref(),
        Some("panic: boom; input 01")
    );
}
