//! `spec/metrics.json` played against the Rust side's registry: each exposition, a registry played
//! on its own, written byte for byte; and each exit, a conversation of the interop service's server,
//! counted step by step (`spec/debugging.md` 7 to 12).

#[expect(
    dead_code,
    reason = "the exits play through the scripted transport alone"
)]
#[path = "players/conversation.rs"]
mod conversation;

use std::collections::HashMap;
use std::process::ExitCode;
use std::sync::Arc;

use bead::testing::{files, instants};
use bead::{
    CallEnding, MetricsRegistry, MetricsRegistryOptions, NotificationSeries, Procedure,
    ProcedureSeries, ProtocolCode, RouterMetrics, RouterSide,
};
use libtest_mimic::{Arguments, Failed, Trial};
use serde::Deserialize;
use serde_json::Value;

/// A declaration made to a registry.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Declaration {
    router: usize,
    #[serde(rename = "as")]
    declared_as: String,
    service_id: u16,
    procedure_id: u16,
    procedure_name: String,
    service_revision: Option<u32>,
    notifies: Option<bool>,
    refused: Option<String>,
}

/// A count made on a router.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Count {
    router: usize,
    call: Option<String>,
    notification: Option<String>,
    dropped: Option<String>,
    service_id: Option<u16>,
    procedure_id: Option<u16>,
    outcome: Option<String>,
    code: Option<String>,
    microseconds: Option<u64>,
}

/// A registry played on its own.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[expect(
    clippy::struct_field_names,
    reason = "the file's own names, one a member each"
)]
struct Exposition {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    maximum_procedures: Option<usize>,
    routers: Vec<String>,
    declarations: Vec<Declaration>,
    counts: Vec<Count>,
    exposition: Vec<String>,
}

/// The file whole.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Metrics {
    #[serde(rename = "$schema")]
    _schema: String,
    #[serde(rename = "$comment")]
    _comment: Vec<String>,
    #[serde(rename = "debuggingVersion")]
    _debugging_version: String,
    media_type: String,
    wall_clock: String,
    expositions: Vec<Exposition>,
    exits: Vec<Value>,
}

// the series each declaration gave, by its router and its address
#[derive(Default)]
struct Declared {
    answered: HashMap<(usize, u16, u16), ProcedureSeries>,
    made: HashMap<(usize, u16, u16), ProcedureSeries>,
    notifications: HashMap<(usize, u16, u16), NotificationSeries>,
}

fn ending_of(outcome: &str, code: Option<&str>) -> Result<CallEnding, Failed> {
    Ok(match (outcome, code) {
        ("result", _) => CallEnding::Result,
        ("timeout", _) => CallEnding::Timeout,
        ("cancelled", _) => CallEnding::Cancelled,
        ("closed", _) => CallEnding::Closed,
        ("error", _) => CallEnding::Error,
        ("failure", Some("application")) => CallEnding::Application,
        ("failure", Some("_OTHER")) => CallEnding::Other,
        ("failure", Some(name)) => CallEnding::Failure(
            ProtocolCode::named()
                .into_iter()
                .find(|code| code.name() == Some(name))
                .ok_or_else(|| format!("{name} is no code"))?,
        ),
        _ => return Err(format!("{outcome} is no ending").into()),
    })
}

// a dropped subscription's failure, by its code's name
fn failure_of(
    code: Option<&str>,
) -> Result<Option<(core::num::NonZeroU16, bead::FailureScope)>, Failed> {
    Ok(match code {
        None => None,
        Some("application") => {
            core::num::NonZeroU16::new(1).map(|code| (code, bead::FailureScope::Application))
        }
        Some("_OTHER") => {
            core::num::NonZeroU16::new(999).map(|code| (code, bead::FailureScope::Protocol))
        }
        Some(name) => Some((
            ProtocolCode::named()
                .into_iter()
                .find(|code| code.name() == Some(name))
                .ok_or_else(|| format!("{name} is no code"))?
                .get(),
            bead::FailureScope::Protocol,
        )),
    })
}

fn declare(
    declaration: &Declaration,
    (routers, declared): (&[RouterMetrics], &mut Declared),
) -> Result<(), Failed> {
    let router = routers
        .get(declaration.router)
        .ok_or("a router the entry gives")?;
    let procedure = Procedure {
        service_id: declaration.service_id,
        id: declaration.procedure_id,
        service_revision: declaration.service_revision.unwrap_or(1),
        name: declaration.procedure_name.clone(),
        kind: None,
        maximum_payload_bytes: None,
        deprecation: None,
    };
    let key = (
        declaration.router,
        declaration.service_id,
        declaration.procedure_id,
    );
    let outcome = match declaration.declared_as.as_str() {
        "resolver" => router
            .declare_resolver(&procedure, declaration.notifies.unwrap_or(false))
            .map(|series| {
                declared.answered.insert(key, series.calls);

                if let Some(notifying) = series.notifying {
                    declared.notifications.insert(key, notifying);
                }
            }),
        "requester" => router.declare_requester(&procedure).map(|series| {
            declared.made.insert(key, series);
        }),
        "notification" => router.declare_notification(&procedure).map(|series| {
            declared.notifications.insert(key, series);
        }),
        other => return Err(format!("{other} is no way to declare").into()),
    };

    match (&declaration.refused, outcome) {
        (None, Ok(())) | (Some(_), Err(_)) => Ok(()),
        (Some(reason), Ok(())) => Err(format!("declared, where it is refused: {reason}").into()),
        (None, Err(error)) => Err(format!("refused: {error}").into()),
    }
}

fn count(entry: &Count, (routers, declared): (&[RouterMetrics], &Declared)) -> Result<(), Failed> {
    let router = routers
        .get(entry.router)
        .ok_or("a router the entry gives")?;
    let key = entry
        .service_id
        .zip(entry.procedure_id)
        .map(|(service, procedure)| (entry.router, service, procedure));

    if let Some(call) = &entry.call {
        let series = match (call.as_str(), key) {
            ("answered", Some(key)) => declared.answered.get(&key).ok_or("a resolver declared")?,
            ("made", Some(key)) => declared.made.get(&key).ok_or("a requester declared")?,
            ("answered", None) => router.other_server(),
            ("made", None) => router.other_client(),
            _ => return Err(format!("{call} is no call").into()),
        };

        series.start();

        if let Some(outcome) = &entry.outcome {
            series.end(
                ending_of(outcome, entry.code.as_deref())?,
                entry.microseconds.unwrap_or(0),
            );
        }

        return Ok(());
    }

    let series = declared
        .notifications
        .get(&key.ok_or("a notification's count names its procedure")?)
        .ok_or("a notification declared")?;

    match (entry.notification.as_deref(), entry.dropped.as_deref()) {
        (Some("sent"), _) => series.sent(),
        (Some("failed"), _) => series.failed(),
        (Some("heard"), _) => series.heard(),
        (_, Some(_)) => series.dropped(failure_of(entry.code.as_deref())?),
        _ => return Err("a count is of a call, a notification or a subscription dropped".into()),
    }

    Ok(())
}

fn play(entry: &Exposition) -> Result<(), Failed> {
    let mut options = MetricsRegistryOptions::default();

    options.maximum_procedures = entry.maximum_procedures;

    let registry = MetricsRegistry::new(&options)?;
    let routers = entry
        .routers
        .iter()
        .map(|side| match side.as_str() {
            "client" => Ok(registry.attach(RouterSide::Client)),
            "server" => Ok(registry.attach(RouterSide::Server)),
            _ => Err(format!("{side} is no side")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut declared = Declared::default();

    for declaration in &entry.declarations {
        declare(declaration, (&routers, &mut declared))?;
    }

    for counted in &entry.counts {
        count(counted, (&routers, &declared))?;
    }

    let written = registry.exposition().text;
    let expected: String = entry
        .exposition
        .iter()
        .fold(String::new(), |mut text, line| {
            text.push_str(line);
            text.push('\n');
            text
        });

    if written == expected {
        Ok(())
    } else {
        Err(format!("wrote:\n{written}").into())
    }
}

// an exit, played as a conversation of a server given a registry of its own, each counted step
// reading its exposition
fn exited(exit: &Value, wall_clock: std::time::SystemTime) -> Result<(), Failed> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let registry = MetricsRegistry::new(&MetricsRegistryOptions::default())?;

    runtime
        .block_on(conversation::play(
            exit,
            conversation::PlayOptions {
                in_memory: false,
                over_broker: false,
                metrics_registry: Some(registry),
                wall_clock,
            },
        ))
        .map_err(Failed::from)
}

fn trials() -> Result<Vec<Trial>, String> {
    let file: Metrics = files::read("metrics.json")?;
    let mut trials = Vec::new();

    if file.media_type != bead::METRICS_CONTENT_TYPE {
        return Err(format!(
            "{} is not the registry's media type",
            file.media_type
        ));
    }

    for entry in file.expositions {
        let name = entry.name.clone();

        trials.push(Trial::test(name, move || play(&entry)).with_kind("expositions"));
    }

    let wall_clock = instants::instant_of(&file.wall_clock)
        .ok_or("metrics.json starts its cases at an instant")?;

    for exit in file.exits {
        let name = exit
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let exit = Arc::new(exit);

        trials.push(Trial::test(name, move || exited(&exit, wall_clock)).with_kind("exits"));
    }

    Ok(trials)
}

fn main() -> ExitCode {
    let arguments = Arguments::from_args();
    let trials = trials()
        .unwrap_or_else(|error| vec![Trial::test("reads metrics.json", move || Err(error.into()))]);

    libtest_mimic::run(&arguments, trials).exit_code()
}
