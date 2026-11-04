//! Every duration this side skips is named, excused, and outside its type.

use super::{Durations, given_of, input_of, read_file};
use crate::testing::is_excused;

#[test]
fn pins_each_duration_its_type_cannot_hold_and_its_reason() {
    let file = read_file().expect("the durations read");
    let skipped: Vec<_> = file
        .inputs
        .iter()
        .filter(|input| is_excused(input.differs.as_deref().unwrap_or_default()))
        .map(|input| {
            assert_eq!(given_of(input), None, "{} cannot be built", input.name);
            let rows: Vec<_> = input
                .differs
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|difference| difference.language == "Rust")
                .map(|difference| difference.row.as_str())
                .collect();
            (input.name.as_str(), rows)
        })
        .collect();

    assert_eq!(
        skipped,
        [
            ("-2 ms", vec!["A duration under zero"]),
            ("-1 ms", vec!["A duration under zero"]),
            ("NaN", vec!["A duration that is not a number"]),
            ("\"1000\"", vec!["A duration that is not a number"]),
            ("true", vec!["A duration that is not a number"]),
        ],
        "every skipped duration has its named reason"
    );
}

#[test]
fn plays_an_unexcused_input_even_when_its_type_cannot_hold_it() {
    let mut file = read_file().expect("the durations read");
    let unexcused = file
        .inputs
        .iter_mut()
        .find(|input| input.name == "-2 ms")
        .expect("the negative input");

    unexcused.differs = None;

    assert_eq!(
        input_of(unexcused).expect_err("an excuse is required"),
        "-2 ms has no Rust duration and no excuse"
    );

    let mut durations = Durations::read().expect("the durations read");
    let input = durations
        .inputs
        .iter_mut()
        .find(|input| input.name == "-2 ms")
        .expect("the negative input");

    input.is_excused = false;

    let place = durations.places.first().expect("a place");
    let played = durations.played(place);

    assert!(
        played
            .iter()
            .any(|(input, _)| input.name == "-2 ms" && input.given.is_none()),
        "an unexcused input reaches the trial, which requires its duration"
    );
}
