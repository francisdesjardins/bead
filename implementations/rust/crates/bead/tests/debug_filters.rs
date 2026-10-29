//! `spec/debug-filters.json` played against the Rust side's filter: what each filter reads as,
//! which calls and envelopes it keeps, or why it is refused, and what a filter given as a function
//! does from event to event (`spec/debugging.md` 6).

use std::process::ExitCode;
use std::sync::{Arc, Mutex, PoisonError};

use bead::testing::files;
use bead::{
    CallAsked, DebugDirection, DebugFilterSource, DebugType, EnvelopeAsked, EnvelopeKind,
    FilterGiven, FilterKeeper, GivenFilter, Refusal, parse_debug_filter,
};
use libtest_mimic::{Arguments, Failed, Trial};
use serde::Deserialize;

/// A call's step a filter is asked of.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[expect(
    clippy::struct_field_names,
    reason = "the file's own names, one a member each"
)]
struct Call {
    direction: String,
    #[serde(rename = "type")]
    call_type: String,
    procedure_name: String,
}

/// An envelope a filter is asked of.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    direction: String,
    kind: String,
}

/// What a filter reads as.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Parsed {
    directions: Vec<String>,
    types: Vec<String>,
    kinds: Vec<String>,
    include: Vec<String>,
    exclude: Vec<String>,
}

/// What a filter's listeners hear, by the fixtures' indexes.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Keeps {
    calls: Vec<usize>,
    envelopes: Vec<usize>,
}

/// Why a filter is refused.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Refused {
    reason: String,
    written: String,
}

/// A filter as written, and what it reads as, keeps, or why it is refused.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[expect(
    clippy::struct_field_names,
    reason = "the file's own names, one a member each"
)]
struct Filter {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    filter: String,
    parsed: Option<Parsed>,
    keeps: Option<Keeps>,
    refused: Option<Refused>,
}

/// One step of a function giving a filter.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Step {
    #[serde(default, deserialize_with = "given")]
    gives: Option<Given>,
    throws: Option<bool>,
    made: Option<bool>,
    event: Option<usize>,
    heard: Option<bool>,
}

// what a step gives: a filter, or null for none
#[derive(Debug, Clone)]
enum Given {
    Nothing,
    Filter(String),
}

// a step's `gives`, present as null where it gives none
fn given<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Given>, D::Error> {
    Option::<String>::deserialize(deserializer)
        .map(|given| Some(given.map_or(Given::Nothing, Given::Filter)))
}

/// A filter given as a function, and its steps.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    listener: String,
    steps: Vec<Step>,
}

/// The file whole.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DebugFilters {
    #[serde(rename = "$schema")]
    _schema: String,
    #[serde(rename = "$comment")]
    _comment: Vec<String>,
    #[serde(rename = "debuggingVersion")]
    _debugging_version: String,
    calls: Vec<Call>,
    envelopes: Vec<Envelope>,
    filters: Vec<Filter>,
    sources: Vec<Source>,
}

fn direction_of(direction: &str) -> Result<DebugDirection, Failed> {
    match direction {
        "rx" => Ok(DebugDirection::Rx),
        "tx" => Ok(DebugDirection::Tx),
        _ => Err(format!("{direction} is no direction").into()),
    }
}

fn type_of(call_type: &str) -> Result<DebugType, Failed> {
    match call_type {
        "request" => Ok(DebugType::Request),
        "command" => Ok(DebugType::Command),
        "notification" => Ok(DebugType::Notification),
        _ => Err(format!("{call_type} is no type").into()),
    }
}

fn kind_of(kind: &str) -> Result<EnvelopeKind, Failed> {
    EnvelopeKind::ALL
        .into_iter()
        .find(|known| kind_name(*known) == kind)
        .ok_or_else(|| format!("{kind} is no kind").into())
}

fn kind_name(kind: EnvelopeKind) -> &'static str {
    match kind {
        EnvelopeKind::Request => "request",
        EnvelopeKind::Result => "result",
        EnvelopeKind::Failure => "failure",
        EnvelopeKind::Notification => "notification",
        EnvelopeKind::Chunk => "chunk",
        EnvelopeKind::Credit => "credit",
        EnvelopeKind::Cancel => "cancel",
        _ => "",
    }
}

// what a keeper's listeners hear of every fixture, by their indexes
fn heard(
    keeper: &FilterKeeper,
    (calls, envelopes): (&[Call], &[Envelope]),
) -> Result<(Vec<usize>, Vec<usize>), Failed> {
    let mut kept_calls = Vec::new();
    let mut kept_envelopes = Vec::new();

    for (index, call) in calls.iter().enumerate() {
        let asked = CallAsked {
            direction: direction_of(&call.direction)?,
            call_type: type_of(&call.call_type)?,
            procedure_name: &call.procedure_name,
        };

        if keeper.keeps_call(&asked) {
            kept_calls.push(index);
        }
    }

    for (index, envelope) in envelopes.iter().enumerate() {
        let asked = EnvelopeAsked {
            direction: direction_of(&envelope.direction)?,
            kind: kind_of(&envelope.kind)?,
        };

        if keeper.keeps_envelope(asked) {
            kept_envelopes.push(index);
        }
    }

    Ok((kept_calls, kept_envelopes))
}

// the value a refusal names, quoted at the end of its words
fn written_of(message: &str) -> Option<String> {
    let at = message.rfind(", not \"")?;

    serde_json::from_str(message.get(at.saturating_add(6)..)?).ok()
}

fn play_filter(entry: &Filter, (calls, envelopes): (&[Call], &[Envelope])) -> Result<(), Failed> {
    let parsed = parse_debug_filter(&entry.filter);

    match (&entry.refused, parsed) {
        (Some(refused), Err(error)) => {
            let reason = match error.reason() {
                Some(Refusal::Filter(reason)) => reason.as_str(),
                _ => "",
            };
            let written = written_of(error.message()).unwrap_or_default();

            if (reason, written.as_str()) != (refused.reason.as_str(), refused.written.as_str()) {
                return Err(format!("refused {reason} of {written:?}: {error}").into());
            }

            // refused as a listener's filter too, as it is made
            if FilterKeeper::new(DebugFilterSource::Given(GivenFilter::Spec(
                entry.filter.clone(),
            )))
            .is_ok()
            {
                return Err("a listener was made of a filter refused".into());
            }

            Ok(())
        }
        (Some(_), Ok(filter)) => Err(format!("read {filter:?}").into()),
        (None, Err(error)) => Err(format!("refused: {error}").into()),
        (None, Ok(filter)) => {
            let parsed = entry
                .parsed
                .as_ref()
                .ok_or("a filter that reads says what it reads as")?;
            let got = (
                filter
                    .directions
                    .iter()
                    .map(|direction| direction.as_str().to_owned())
                    .collect::<Vec<_>>(),
                filter
                    .types
                    .iter()
                    .map(|call_type| call_type.as_str().to_owned())
                    .collect::<Vec<_>>(),
                filter
                    .kinds
                    .iter()
                    .map(|kind| kind_name(*kind).to_owned())
                    .collect::<Vec<_>>(),
            );

            if got
                != (
                    parsed.directions.clone(),
                    parsed.types.clone(),
                    parsed.kinds.clone(),
                )
                || filter.include != parsed.include
                || filter.exclude != parsed.exclude
            {
                return Err(format!("read {filter:?}").into());
            }

            let keeps = entry
                .keeps
                .as_ref()
                .ok_or("a filter that reads says what it keeps")?;
            let keeper = FilterKeeper::new(DebugFilterSource::Given(GivenFilter::Spec(
                entry.filter.clone(),
            )))?;
            let (kept_calls, kept_envelopes) = heard(&keeper, (calls, envelopes))?;

            if kept_calls != keeps.calls || kept_envelopes != keeps.envelopes {
                return Err(format!("kept {kept_calls:?} and {kept_envelopes:?}").into());
            }

            Ok(())
        }
    }
}

// what a function gives from one step to the next: a filter, none, or a throw
#[derive(Debug, Clone)]
enum Gives {
    Filter(Option<String>),
    Throws,
}

fn play_source(source: &Source, (calls, envelopes): (&[Call], &[Envelope])) -> Result<(), Failed> {
    let gives = Arc::new(Mutex::new(Gives::Filter(None)));
    let mut keeper: Option<FilterKeeper> = None;

    for step in &source.steps {
        if let Some(given) = &step.gives {
            let filter = match given {
                Given::Nothing => None,
                Given::Filter(filter) => Some(filter.clone()),
            };

            *gives.lock().unwrap_or_else(PoisonError::into_inner) = Gives::Filter(filter);
        }

        if step.throws == Some(true) {
            *gives.lock().unwrap_or_else(PoisonError::into_inner) = Gives::Throws;
        }

        if let Some(made) = step.made {
            let function_gives = Arc::clone(&gives);
            let function = move || -> FilterGiven {
                let gives = function_gives
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .clone();

                match gives {
                    Gives::Filter(filter) => Ok(filter.map(GivenFilter::Spec)),
                    Gives::Throws => Err("the function throws".into()),
                }
            };

            keeper = FilterKeeper::new(DebugFilterSource::Function(Arc::new(function))).ok();

            if keeper.is_some() != made {
                return Err(format!("made {}, not {made}", keeper.is_some()).into());
            }
        }

        if let (Some(event), Some(expected)) = (step.event, step.heard) {
            let keeper = keeper
                .as_ref()
                .ok_or("an event goes through a listener made")?;
            let was_heard = if source.listener == "envelope" {
                let envelope = envelopes.get(event).ok_or("an envelope the file holds")?;

                keeper.keeps_envelope(EnvelopeAsked {
                    direction: direction_of(&envelope.direction)?,
                    kind: kind_of(&envelope.kind)?,
                })
            } else {
                let call = calls.get(event).ok_or("a call the file holds")?;

                keeper.keeps_call(&CallAsked {
                    direction: direction_of(&call.direction)?,
                    call_type: type_of(&call.call_type)?,
                    procedure_name: &call.procedure_name,
                })
            };

            if was_heard != expected {
                return Err(format!("event {event} heard {was_heard}, not {expected}").into());
            }
        }
    }

    Ok(())
}

fn trials() -> Result<Vec<Trial>, String> {
    let file: DebugFilters = files::read("debug-filters.json")?;
    let calls: Arc<Vec<Call>> = Arc::new(file.calls);
    let envelopes: Arc<Vec<Envelope>> = Arc::new(file.envelopes);
    let mut trials = Vec::new();

    for entry in file.filters {
        let (calls, envelopes) = (Arc::clone(&calls), Arc::clone(&envelopes));
        let name = entry.name.clone();

        trials.push(
            Trial::test(name, move || play_filter(&entry, (&calls, &envelopes)))
                .with_kind("filters"),
        );
    }

    for source in file.sources {
        let (calls, envelopes) = (Arc::clone(&calls), Arc::clone(&envelopes));
        let name = source.name.clone();

        trials.push(
            Trial::test(name, move || play_source(&source, (&calls, &envelopes)))
                .with_kind("sources"),
        );
    }

    Ok(trials)
}

fn main() -> ExitCode {
    let arguments = Arguments::from_args();
    let trials = trials().unwrap_or_else(|error| {
        vec![Trial::test("reads debug-filters.json", move || {
            Err(error.into())
        })]
    });

    libtest_mimic::run(&arguments, trials).exit_code()
}
