//! The envelope readers fed seeded mutations of `spec/vectors.json`'s bytes (decision 0006): each
//! read returns or refuses with its [`Failure`], never panics and never takes over a second. The
//! generator is `bead::testing::mutations`, the other sides' own, so a seed draws the same inputs
//! on every side, which the seeds' count and digests prove; the TypeScript side's
//! `envelope-fuzz.test.ts` and the C# side's `EnvelopeFuzzTests` are its twins. A panic is the Rust
//! side's exception that is no failure.

use std::panic::{self, AssertUnwindSafe};
use std::sync::LazyLock;
use std::time::Duration;

use bead::internal::{ReadEnvelopeOptions, read_envelope, read_failure};
use bead::testing::mutations::{self, Generator, digest_of, first_inputs, lower_hex_of, mutate};
use bead::testing::{Instant, files};
use bead::{Failure, RouterSide};
use bytes::Bytes;
use serde_json::Value;

// how many inputs a seed draws: BEAD_FUZZ_INPUTS raises it for a longer run, as on the other sides
fn inputs() -> usize {
    std::env::var("BEAD_FUZZ_INPUTS")
        .ok()
        .and_then(|inputs| inputs.parse().ok())
        .unwrap_or(20_000)
}

// the seeds, every bytes and record of the vectors, ordered by their SHA-1
static SEEDS: LazyLock<Result<Vec<Vec<u8>>, String>> = LazyLock::new(|| {
    files::read::<Value>("vectors.json").map(|vectors| mutations::seeds_of(&vectors))
});

fn seeds() -> Result<&'static [Vec<u8>], String> {
    SEEDS.as_deref().map_err(Clone::clone)
}

// what `read` gives that is no failure, with the input: a panic, or a read past a second
fn defect_of<T>(read: impl FnOnce() -> Result<T, Failure>, input: &[u8]) -> Option<String> {
    let started = Instant::now();
    let read = panic::catch_unwind(AssertUnwindSafe(read));

    match read {
        Err(panicked) => {
            let said = panicked
                .downcast_ref::<&str>()
                .map(ToString::to_string)
                .or_else(|| panicked.downcast_ref::<String>().cloned())
                .unwrap_or_default();

            Some(format!("a panic: {said}; input {}", lower_hex_of(input)))
        }
        Ok(_) if started.elapsed() > Duration::from_secs(1) => {
            Some(format!("over a second; input {}", lower_hex_of(input)))
        }
        Ok(_) => None,
    }
}

fn reads_or_refuses_with_a_failure_every_mutation_of_a_vector(seed: u32) -> Result<(), String> {
    let seeds = seeds()?;
    let mut generator = Generator::new(seed);
    let mut options = ReadEnvelopeOptions::default();

    options.maximum_envelope_bytes = Some(16_778_240);
    options.maximum_detail_bytes = Some(1_024);
    let mut defects = Vec::new();

    for _ in 0..inputs() {
        let source = seeds.get(generator.below(seeds.len())).ok_or("no seed")?;
        let input = mutate(source, (&mut generator, seeds));
        let bytes = Bytes::copy_from_slice(&input);

        for side in [RouterSide::Server, RouterSide::Client] {
            defects.extend(defect_of(|| read_envelope(&bytes, side, &options), &input));
            defects.extend(defect_of(|| read_failure(&input, (side, 1_024)), &input));
        }
    }

    if defects.is_empty() {
        Ok(())
    } else {
        Err(format!("{defects:#?}"))
    }
}

#[test]
fn finds_the_vectors_bytes() -> Result<(), String> {
    let seeds = seeds()?;

    assert_eq!(seeds.len(), 264, "the vectors' bytes");
    assert_eq!(
        digest_of(seeds),
        "4d0885103f89b5753c2204b02affcb89106c9e8d2300b8262c6d6b8a577e1c48",
        "the seeds in their order, as every side holds them"
    );

    Ok(())
}

#[test]
fn draws_what_the_other_sides_draw_for_a_seed() -> Result<(), String> {
    let mut generator = Generator::new(1);

    assert_eq!(
        (0..8).map(|_| generator.below(1_000)).collect::<Vec<_>>(),
        [369, 689, 461, 695, 233, 504, 482, 210],
        "the draws of a seed of 1"
    );
    assert_eq!(
        digest_of(&first_inputs(seeds()?, (1, 8))),
        "59e97d7f4c6b6dbd434bf66b5b848289e8903f415a5d075b848ef843c8d2fe28",
        "the first eight inputs of a seed of 1, as every side draws them"
    );

    Ok(())
}

#[test]
fn reads_or_refuses_with_a_failure_every_mutation_of_a_vector_seed_1() -> Result<(), String> {
    reads_or_refuses_with_a_failure_every_mutation_of_a_vector(1)
}

#[test]
fn reads_or_refuses_with_a_failure_every_mutation_of_a_vector_seed_2() -> Result<(), String> {
    reads_or_refuses_with_a_failure_every_mutation_of_a_vector(2)
}

#[test]
fn reports_an_exception_that_is_no_failure() {
    let defect = defect_of::<()>(|| panic!("boom"), &[0x01]);

    assert_eq!(
        defect.as_deref(),
        Some("a panic: boom; input 01"),
        "reported"
    );
}
