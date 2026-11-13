//! `spec/validations.json`'s verdicts played against the validators beadc generates for
//! `spec/validations.proto`, `generated/` here, which the root's `tools/check-validations.mjs`
//! holds to its generator: each verdict's payload read as a server reads a request, through the
//! codec of the procedure that binds its message, then judged as it judges one (spec 18.2), a trial
//! a verdict named by the verdict's own name. The TypeScript side's `validate.test.ts` and the C#
//! side's `ValidatorsTests` play the same file.

use std::process::ExitCode;

use bead::testing::{hexadecimal, validations};
use bead::{Descriptor, Judged, PayloadCodec, ValidateOptions, Violation};
use bead_protobuf::ProtoCodec;
use bytes::Bytes;
use libtest_mimic::{Arguments, Failed, Trial};
use serde::Deserialize;
use serde_json::{Map, Value};

// the code beadc generates for spec/validations.proto, its messages Buffa's: public, so that rustc's
// unnameable_types finds its messages named by their path; its doc its own
pub mod generated;

use generated::messages::bead::validations::v1 as messages;
use generated::services::bead::validations::v1::ValidationsProcedures;

// ── The file ──────────────────────────────────────────────────────────────────

/// Bytes repeated, end to end, for a payload too long to write out.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Run {
    bytes: String,
    times: usize,
}

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

/// A payload judged, and what its validator gives.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Verdict {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    message: String,
    payload: Option<String>,
    runs: Option<Vec<Run>>,
    fail_fast: Option<bool>,
    maximum_bytes: Option<usize>,
    violations: Vec<Written>,
    more: Option<u64>,
    stopped: Option<bool>,
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

// a verdict's payload: its bytes, or its runs end to end
fn payload_of(verdict: &Verdict) -> Result<Bytes, String> {
    if let Some(payload) = &verdict.payload {
        return hexadecimal::bytes_of(payload)
            .map(Bytes::from)
            .ok_or_else(|| format!("{payload} is no hexadecimal"));
    }

    let mut joined = Vec::new();

    for run in verdict.runs.iter().flatten() {
        let bytes = hexadecimal::bytes_of(&run.bytes)
            .ok_or_else(|| format!("{} is no hexadecimal", run.bytes))?;

        for _ in 0..run.times {
            joined.extend_from_slice(&bytes);
        }
    }

    Ok(Bytes::from(joined))
}

// a violation as its line compares it: its bounds in section 17.7's form, where the file writes a
// double's whole number as 0.0 and a rule's site as 0, one number
fn compared(violation: &Violation) -> Violation {
    Violation {
        bounds: violation.bounds.as_ref().map(|bounds| {
            bead::json::write(&Value::Object(bounds.clone()))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_else(|| bounds.clone())
        }),
        value: None,
        ..violation.clone()
    }
}

// ── The judgings ──────────────────────────────────────────────────────────────

// a message's judging: its payload read by its binding's codec, then judged by its rules
type Judge = Box<dyn Fn(&Bytes, &ValidateOptions) -> Result<Judged, String> + Send + Sync>;

// the judging of the procedure `descriptor` binds
fn judge_of<M>(descriptor: &'static Descriptor<ProtoCodec<M>, ProtoCodec<messages::Taken>>) -> Judge
where
    ProtoCodec<M>: PayloadCodec<Value = M>,
{
    Box::new(move |payload, options| {
        let validate = descriptor
            .validate()
            .ok_or_else(|| format!("{} has no rules", descriptor.procedure().procedure_name))?;
        let request = descriptor
            .request()
            .decode(payload)
            .map_err(|refusal| format!("read: {refusal}"))?;

        validate(&request, options).map_err(|error| format!("judged: {error}"))
    })
}

// the procedure that binds `message`, a full name, as the generated service names it
fn judging_of(message: &str) -> Result<Judge, String> {
    let procedures = ValidationsProcedures::get().map_err(|error| error.to_string())?;

    Ok(match message {
        "bead.validations.v1.Numbers" => judge_of(&procedures.judge_numbers),
        "bead.validations.v1.Floats" => judge_of(&procedures.judge_floats),
        "bead.validations.v1.Strings" => judge_of(&procedures.judge_strings),
        "bead.validations.v1.Bytes" => judge_of(&procedures.judge_bytes),
        "bead.validations.v1.Enums" => judge_of(&procedures.judge_enums),
        "bead.validations.v1.Repeated" => judge_of(&procedures.judge_repeated),
        "bead.validations.v1.Maps" => judge_of(&procedures.judge_maps),
        "bead.validations.v1.Presence" => judge_of(&procedures.judge_presence),
        "bead.validations.v1.Wrappers" => judge_of(&procedures.judge_wrappers),
        "bead.validations.v1.Oneofs" => judge_of(&procedures.judge_oneofs),
        "bead.validations.v1.Nested" => judge_of(&procedures.judge_nested),
        "bead.validations.v1.Order" => judge_of(&procedures.judge_order),
        "bead.validations.v1.Patterns" => judge_of(&procedures.judge_patterns),
        other => return Err(format!("no procedure judges {other}")),
    })
}

// ── The trials ────────────────────────────────────────────────────────────────

fn play(verdict: &Verdict) -> Result<(), Failed> {
    let judge = judging_of(&verdict.message)?;
    let mut options = ValidateOptions::default();

    options.fail_fast = Some(verdict.fail_fast.unwrap_or(false));
    options.maximum_bytes = verdict.maximum_bytes;

    // * read as a server reads a request, then judged as it judges one (spec 18.2)
    let judged = judge(&payload_of(verdict)?, &options)?;
    let sent: Vec<Violation> = judged.violations.iter().map(compared).collect();
    let expected: Vec<Violation> = verdict
        .violations
        .iter()
        .map(|written| compared(&violation_of(written)))
        .collect();

    if sent != expected
        || judged.more != verdict.more.unwrap_or(0)
        || judged.stopped != verdict.stopped.unwrap_or(false)
    {
        return Err(format!(
            "judged {sent:?}, {} more, stopped {}",
            judged.more, judged.stopped
        )
        .into());
    }

    Ok(())
}

fn trials() -> Result<Vec<Trial>, String> {
    let verdicts: Vec<Verdict> = validations::of("verdicts")?;

    Ok(verdicts
        .into_iter()
        .map(|verdict| {
            let name = verdict.name.clone();

            Trial::test(name, move || play(&verdict)).with_kind("verdicts")
        })
        .collect())
}

fn main() -> ExitCode {
    let arguments = Arguments::from_args();
    let trials = trials()
        .unwrap_or_else(|error| vec![Trial::test("reads its verdicts", move || Err(error.into()))]);

    libtest_mimic::run(&arguments, trials).exit_code()
}
