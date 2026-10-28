//! `spec/validations.json` played against the Rust side's detail's writer and reader: each detail
//! written of what a validator gave, and each read back (spec 18.6, 18.7). Its verdicts, a
//! validator beadc generates, are ahead with `Rust's beadc target`.

use std::process::ExitCode;

use bead::testing::validations;
use bead::{FailureScope, Judged, ProtocolCode, Violation, violations_detail_of, violations_of};
use libtest_mimic::{Arguments, Failed, Trial};
use serde::Deserialize;
use serde_json::{Map, Value};

/// A violation as the file writes it.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Written {
    bounds: Option<Map<String, Value>>,
    field_path: Option<String>,
    for_key: Option<bool>,
    message: Option<String>,
    rule_id: String,
}

/// What a validator gave, and the bound its detail is written under.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Write {
    violations: Vec<Written>,
    more: Option<u64>,
    stopped: Option<bool>,
    maximum_bytes: usize,
}

/// What a reader reads of a detail.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    violations: Vec<Written>,
    more: Option<u64>,
    stopped: Option<bool>,
}

/// A detail written, or one read.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[expect(
    clippy::struct_field_names,
    reason = "the file's own names, one a member each"
)]
struct Detail {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    detail: String,
    write: Option<Write>,
    read: Option<Read>,
}

fn violation_of(written: &Written) -> Violation {
    Violation {
        bounds: written.bounds.clone(),
        field_path: written.field_path.clone(),
        for_key: written.for_key.unwrap_or(false),
        message: written.message.clone(),
        rule_id: written.rule_id.clone(),
        value: None,
    }
}

fn play(entry: &Detail) -> Result<(), Failed> {
    if let Some(write) = &entry.write {
        let judged = Judged {
            violations: write.violations.iter().map(violation_of).collect(),
            more: write.more.unwrap_or(0),
            stopped: write.stopped.unwrap_or(false),
        };
        let detail = violations_detail_of(&judged, write.maximum_bytes);

        if detail != entry.detail {
            return Err(format!("wrote {detail:?}").into());
        }
    }

    if let Some(read) = &entry.read {
        let got = violations_of(
            (ProtocolCode::PAYLOAD_INVALID.get(), FailureScope::Protocol),
            &entry.detail,
        );
        let violations: Vec<Violation> = read.violations.iter().map(violation_of).collect();

        if got.violations != violations
            || got.more != read.more
            || got.stopped != read.stopped.unwrap_or(false)
        {
            return Err(format!("read {got:?}").into());
        }
    }

    Ok(())
}

fn trials() -> Result<Vec<Trial>, String> {
    let details: Vec<Detail> = validations::of("details")?;

    Ok(details
        .into_iter()
        .map(|entry| {
            let name = entry.name.clone();

            Trial::test(name, move || play(&entry)).with_kind("details")
        })
        .collect())
}

fn main() -> ExitCode {
    let arguments = Arguments::from_args();
    let trials = trials()
        .unwrap_or_else(|error| vec![Trial::test("reads its details", move || Err(error.into()))]);

    libtest_mimic::run(&arguments, trials).exit_code()
}
