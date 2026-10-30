//! `spec/clocks.json` played on the Rust side's test clock, `SteppingClock`: what advance means in
//! every conformance file (decision 0011), with nothing else running on it.

use core::time::Duration;
use std::process::ExitCode;
use std::sync::{Arc, Mutex, PoisonError};

use bead::Clock;
use bead::Schedule;
use bead::testing::{SteppingClock, files, instants};
use libtest_mimic::{Arguments, Failed, Trial};
use serde::Deserialize;

/// A timer armed, and the one its callback arms then.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Arm {
    timer: String,
    due: u64,
    period: Option<u64>,
    then: Option<Box<Self>>,
}

/// A timer that fired, and the monotonic reading its callback read.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fired {
    timer: String,
    at: u64,
}

/// The readings a step checks.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Readings {
    monotonic: Option<u64>,
    wall: Option<String>,
}

/// One step of a case.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Step {
    arm: Option<Arm>,
    advance: Option<u64>,
    fired: Option<Vec<Fired>>,
    wall: Option<i64>,
    readings: Option<Readings>,
}

/// A case, and its steps.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    steps: Vec<Step>,
}

/// The file whole.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Clocks {
    #[serde(rename = "$schema")]
    _schema: String,
    #[serde(rename = "$comment")]
    _comment: Vec<String>,
    #[serde(rename = "specVersion")]
    _spec_version: String,
    wall_clock: String,
    cases: Vec<Case>,
}

type Log = Arc<Mutex<Vec<Fired>>>;

// arms `arm` on `clock`: its callback notes its firing and its reading, then arms its `then`
fn arm(clock: &Arc<SteppingClock>, (arm_it, log): (&Arm, &Log)) {
    let schedule = arm_it.period.map_or_else(
        || Schedule::Once(Duration::from_millis(arm_it.due)),
        |period| Schedule::Every(Duration::from_millis(period)),
    );
    let (timer, then) = (arm_it.timer.clone(), arm_it.then.clone());
    let (on, noted) = (Arc::clone(clock), Arc::clone(log));
    let callback = move || {
        let at = u64::try_from(on.monotonic().as_millis()).unwrap_or(u64::MAX);

        noted
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Fired {
                timer: timer.clone(),
                at,
            });

        if let Some(then) = &then {
            arm(&on, (then, &noted));
        }
    };

    // a periodic timer's first due is its period's, as the cases give them
    let _armed = clock.arm(schedule, Box::new(callback));
}

async fn play(case: &Case, wall_clock: std::time::SystemTime) -> Result<(), Failed> {
    let clock = SteppingClock::new(wall_clock);
    let log: Log = Arc::default();

    for step in &case.steps {
        if let Some(armed) = &step.arm {
            arm(&clock, (armed, &log));
        }

        if let Some(by) = step.advance {
            clock.advance(Duration::from_millis(by)).await;
        }

        if let Some(by) = step.wall {
            clock.wall_by(by);
        }

        if let Some(expected) = &step.fired {
            let fired: Vec<Fired> = log
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .drain(..)
                .collect();

            if &fired != expected {
                return Err(format!("fired {fired:?}").into());
            }
        }

        if let Some(readings) = &step.readings {
            if let Some(monotonic) = readings.monotonic {
                let read = clock.monotonic();

                if read != Duration::from_millis(monotonic) {
                    return Err(format!("read {read:?} on the monotonic clock").into());
                }
            }

            if let Some(wall) = &readings.wall {
                let expected = instants::instant_of(wall).ok_or("an instant")?;
                let read = clock.wall();

                if read != expected {
                    return Err(format!("read {read:?} on the wall clock").into());
                }
            }
        }
    }

    Ok(())
}

fn trials() -> Result<Vec<Trial>, String> {
    let file: Clocks = files::read("clocks.json")?;
    let wall_clock =
        instants::instant_of(&file.wall_clock).ok_or("the wall clock is an instant")?;

    Ok(file
        .cases
        .into_iter()
        .map(|case| {
            let name = case.name.clone();

            Trial::test(name, move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?
                    .block_on(play(&case, wall_clock))
            })
        })
        .collect())
}

fn main() -> ExitCode {
    let arguments = Arguments::from_args();
    let trials = trials()
        .unwrap_or_else(|error| vec![Trial::test("reads clocks.json", move || Err(error.into()))]);

    libtest_mimic::run(&arguments, trials).exit_code()
}
