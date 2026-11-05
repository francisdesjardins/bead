//! A broker's parcel reader fed seeded mutations of `spec/vectors.json`'s parcels (spec 15.17,
//! decision 0006), with the `broker-parcel` fuzz target's properties: the reader gives a parcel,
//! no parcel or a parcel that does not read, never panics and never takes over a second; a parcel
//! that reads is written again, its writer refusing exactly those it refuses by design (15.18) and
//! never with its read-back refusal; what it writes reads as the same parcel and writes again to
//! the same bytes. The generator is `bead::testing::mutations`, the other sides' own, so a seed
//! draws the same inputs on every side, which the seeds' count and digests prove; the TypeScript
//! side's `broker-parcel-fuzz.test.ts` and the C# side's `BrokerParcelFuzzTests` are its twins.

use std::panic::{self, AssertUnwindSafe};
use std::sync::LazyLock;
use std::time::Duration;

use bead::testing::mutations::{Generator, digest_of, first_inputs, lower_hex_of, mutate, ordered};
use bead::testing::parcels::{
    ParcelReading, ParcelRefusalVector, ParcelVector, is_refused_by_design, read, write,
};
use bead::testing::{Instant, files, hexadecimal};
use serde::Deserialize;

// how many inputs a seed draws: BEAD_FUZZ_INPUTS raises it for a longer run, as on the other sides
fn inputs() -> usize {
    std::env::var("BEAD_FUZZ_INPUTS")
        .ok()
        .and_then(|inputs| inputs.parse().ok())
        .unwrap_or(20_000)
}

/// The parcels of `spec/vectors.json`, and the messages refused as none.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Parcels {
    parcels: Vec<ParcelVector>,
    parcel_refusals: Vec<ParcelRefusalVector>,
}

// the seeds, the bytes of every parcel and every message refused, ordered by their SHA-1
static SEEDS: LazyLock<Result<Vec<Vec<u8>>, String>> = LazyLock::new(|| {
    let vectors: Parcels = files::read("vectors.json")?;
    let bytes = vectors
        .parcels
        .iter()
        .map(|parcel| &parcel.bytes)
        .chain(vectors.parcel_refusals.iter().map(|refusal| &refusal.bytes));

    bytes
        .map(|text| {
            hexadecimal::bytes_of(text).ok_or_else(|| format!("{text:?} is no hexadecimal"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(ordered)
});

fn seeds() -> Result<&'static [Vec<u8>], String> {
    SEEDS.as_deref().map_err(Clone::clone)
}

// the read-back refusal, which a parcel the writer is given whole never meets
const READ_BACK: &str = "a parcel this side refuses is never written";

// what the parcel `input` reads as breaks of the target's properties, none where it holds them
fn broken(input: &[u8]) -> Option<String> {
    let ParcelReading::Parcel(fields) = read(input) else {
        return None;
    };
    let written = write(&fields);

    match written {
        Err(refused) if refused.starts_with(READ_BACK) => Some(format!("{refused}: {fields:?}")),
        Err(_) if is_refused_by_design(&fields) => None,
        Err(refused) => Some(format!("refused, not by design, {refused}: {fields:?}")),
        Ok(_) if is_refused_by_design(&fields) => Some(format!(
            "written, where it is refused by design: {fields:?}"
        )),
        Ok(bytes) => match read(&bytes) {
            ParcelReading::Parcel(again) if again == fields => match write(&again) {
                Ok(twice) if twice == bytes => None,
                twice => Some(format!("written again as {twice:?}: {fields:?}")),
            },
            again @ (ParcelReading::Parcel(_)
            | ParcelReading::NoParcel(_)
            | ParcelReading::DoesNotRead(..)) => {
                Some(format!("what it wrote reads as {again:?}: {fields:?}"))
            }
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

fn reads_writes_back_or_refuses_as_designed_every_mutation_of_a_parcel(
    seed: u32,
) -> Result<(), String> {
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
fn finds_the_parcels_bytes() -> Result<(), String> {
    let seeds = seeds()?;

    assert_eq!(seeds.len(), 72, "the parcels' bytes");
    assert_eq!(
        digest_of(seeds),
        "654a2c65cf1911a21e201cd09d3f1cb59af1688e318e7ddf1f2f0d3c73984d45",
        "the seeds in their order, as every side holds them"
    );

    Ok(())
}

#[test]
fn draws_what_the_other_sides_draw_for_a_seed() -> Result<(), String> {
    assert_eq!(
        digest_of(&first_inputs(seeds()?, (1, 8))),
        "3c513c8adf6e27cc4fbb1042b4f0dcaf9d6279e50b20ef52831433284c2c1e88",
        "the first eight inputs of a seed of 1, as every side draws them"
    );

    Ok(())
}

#[test]
fn reads_writes_back_or_refuses_as_designed_every_mutation_of_a_parcel_seed_1() -> Result<(), String>
{
    reads_writes_back_or_refuses_as_designed_every_mutation_of_a_parcel(1)
}

#[test]
fn reads_writes_back_or_refuses_as_designed_every_mutation_of_a_parcel_seed_2() -> Result<(), String>
{
    reads_writes_back_or_refuses_as_designed_every_mutation_of_a_parcel(2)
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
