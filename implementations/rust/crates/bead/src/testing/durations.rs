//! The durations' helper: the one place that reads `spec/durations.json` (decision 0014).
//!
//! For the harness and for the twins of its assertion: its inputs, each as a `Duration` is given
//! it, and its places, typed; what this side is excused from.

use core::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::duration::NEVER;
use crate::testing::files;

// the language a differs names to excuse this side
const LANGUAGE: &str = "Rust";

/// A row of the support matrix that excuses a side from an entry.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Difference {
    /// The row.
    pub row: String,
    /// The side it excuses.
    pub language: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileInput {
    name: String,
    milliseconds: Option<f64>,
    seconds: Option<f64>,
    never: Option<bool>,
    nan: Option<bool>,
    json: Option<Value>,
    differs: Option<Vec<Difference>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileWay {
    id: String,
    #[serde(rename = "name")]
    _name: String,
    required: Option<bool>,
    differs: Option<Vec<Difference>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileDefault {
    milliseconds: Option<u64>,
    #[serde(rename = "never")]
    _never: Option<bool>,
    #[serde(rename = "clause")]
    _clause: String,
    ways: Vec<String>,
    #[serde(rename = "state")]
    _state: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileOutcome {
    input: String,
    outcome: String,
    held: Option<u64>,
    reason: Option<String>,
    differs: Option<Vec<Difference>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FilePlace {
    id: String,
    #[serde(rename = "name")]
    _name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    kind: String,
    never: String,
    #[serde(rename = "neverClause")]
    _never_clause: Option<String>,
    ways: Vec<FileWay>,
    default: Option<FileDefault>,
    observed: String,
    outcomes: Vec<FileOutcome>,
    ahead: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(rename = "$schema")]
    _schema: String,
    #[serde(rename = "$comment")]
    _comment: Vec<String>,
    #[serde(rename = "specVersion")]
    _spec_version: String,
    inputs: Vec<FileInput>,
    places: Vec<FilePlace>,
}

/// An input of the file, as this side is given it: a `Duration`, or none where a `Duration` cannot
/// hold it at all; and whether a row of the support matrix excuses this side from it.
#[derive(Debug, Clone)]
pub struct DurationInput {
    /// Its name.
    pub name: String,
    /// What this side is given: `Duration::from_secs_f64` of its milliseconds or its seconds,
    /// [`NEVER`] for never; none for NaN, a value no number is, or one under zero.
    pub given: Option<Duration>,
    /// Whether a row excuses this side from it.
    pub is_excused: bool,
}

/// A way a place takes its duration.
#[derive(Debug, Clone)]
pub struct DurationWay {
    /// Its id, stable in its place.
    pub id: String,
    /// Whether its duration cannot be left out.
    pub is_required: bool,
    /// Whether this side lacks it.
    pub is_excused: bool,
}

/// The default a clause states for a place: what it holds, [`NEVER`] for never, and the ways built
/// with nothing given to read it.
#[derive(Debug, Clone)]
pub struct DurationDefault {
    /// What it holds.
    pub held: Duration,
    /// The ways that read it.
    pub ways: Vec<String>,
}

/// What a place makes of an input: held, at once, never, default, taken or refused; what it holds,
/// where it holds one; the reason of a refusal; and whether a row excuses this side from it.
#[derive(Debug, Clone)]
pub struct PlaceOutcome {
    /// The input's name.
    pub input: String,
    /// What the place makes of it.
    pub outcome: String,
    /// What it holds, where it holds one.
    pub held: Option<Duration>,
    /// Why it is refused, where it is.
    pub reason: Option<String>,
    /// Whether a row excuses this side from it.
    pub is_excused: bool,
}

/// A place that takes a duration an application gives a side.
#[derive(Debug, Clone)]
pub struct DurationPlace {
    /// Its id.
    pub id: String,
    /// A delay or a timeout.
    pub kind: String,
    /// What it makes of never: taken, refused or its default.
    pub never: String,
    /// Its ways.
    pub ways: Vec<DurationWay>,
    /// Its default, when a clause states one.
    pub default: Option<DurationDefault>,
    /// What of it is observed: held, or its refusal alone.
    pub observed: String,
    /// Its outcome for each input, in the inputs' order.
    pub outcomes: Vec<PlaceOutcome>,
    /// Whether it is ahead: a stage this side has not reached.
    pub is_ahead: bool,
}

fn is_excused(differs: Option<&Vec<Difference>>) -> bool {
    differs.is_some_and(|differs| {
        differs
            .iter()
            .any(|difference| difference.language == LANGUAGE)
    })
}

// an input as a Duration is given it: from_secs_f64 of its milliseconds over 1,000, or its seconds,
// never as Duration::MAX; NaN, a value no number is, and one under zero, none
fn given_of(input: &FileInput) -> Option<Duration> {
    if input.never == Some(true) {
        return Some(NEVER);
    }

    if input.nan.is_some() || input.json.is_some() {
        return None;
    }

    let seconds = input
        .milliseconds
        .map(|milliseconds| milliseconds / 1_000.0)
        .or(input.seconds)?;

    Duration::try_from_secs_f64(seconds).ok()
}

/// Bead's durations, read whole: its inputs and its places.
#[derive(Debug, Clone)]
pub struct Durations {
    /// Its inputs, in its order.
    pub inputs: Vec<DurationInput>,
    /// Its places, in its order.
    pub places: Vec<DurationPlace>,
}

impl Durations {
    /// The file, read.
    ///
    /// # Errors
    ///
    /// What reading it or its form refuses.
    pub fn read() -> Result<Self, String> {
        let file: File = files::read("durations.json")?;
        let inputs = file
            .inputs
            .iter()
            .map(|input| DurationInput {
                name: input.name.clone(),
                given: given_of(input),
                is_excused: is_excused(input.differs.as_ref()),
            })
            .collect();
        let places = file
            .places
            .into_iter()
            .map(|place| DurationPlace {
                is_ahead: place.ahead.is_some(),
                id: place.id,
                kind: place.kind,
                never: place.never,
                ways: place
                    .ways
                    .into_iter()
                    .map(|way| DurationWay {
                        is_required: way.required == Some(true),
                        is_excused: is_excused(way.differs.as_ref()),
                        id: way.id,
                    })
                    .collect(),
                default: place.default.map(|stated| DurationDefault {
                    held: stated.milliseconds.map_or(NEVER, Duration::from_millis),
                    ways: stated.ways,
                }),
                observed: place.observed,
                outcomes: place
                    .outcomes
                    .into_iter()
                    .map(|outcome| PlaceOutcome {
                        is_excused: is_excused(outcome.differs.as_ref()),
                        input: outcome.input,
                        outcome: outcome.outcome,
                        held: outcome.held.map(Duration::from_millis),
                        reason: outcome.reason,
                    })
                    .collect(),
            })
            .collect();

        Ok(Self { inputs, places })
    }

    /// The place of `id`.
    #[must_use]
    pub fn place_of(&self, id: &str) -> Option<&DurationPlace> {
        self.places.iter().find(|place| place.id == id)
    }

    /// What this side plays of a place: each input it is given, with the place's outcome for it,
    /// but those a row excuses it from, on the input or on the place's outcome for it.
    #[must_use]
    pub fn played(&self, place: &DurationPlace) -> Vec<(DurationInput, PlaceOutcome)> {
        self.inputs
            .iter()
            .cloned()
            .zip(place.outcomes.iter().cloned())
            .filter(|(input, outcome)| {
                !input.is_excused && !outcome.is_excused && input.given.is_some()
            })
            .collect()
    }
}
