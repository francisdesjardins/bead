//! A consumer of the goldens' `deprecations` output, compiled with them as one crate by
//! `tests/consumer.rs`: each use of what beadc marks deprecated, the line after a `// reported:`
//! comment that says what rustc reports of it, and the uses of what it does not mark. The output's
//! own uses of its marks are not reported: its `services` module allows them. Never run.

#![warn(deprecated)]

#[path = "GOLDENS/deprecations/mod.rs"]
pub mod generated;

use generated::services::{InteropFailures, InteropProcedures};

/// Each descriptor and failure the consumer names, deprecated or not.
pub fn uses(procedures: &InteropProcedures) -> Vec<&'static str> {
    let _ = &procedures.echo;
    // reported: use of deprecated field `generated::services::InteropProcedures::clock`: No replacement is named.
    let _ = &procedures.clock;
    // reported: use of deprecated field `generated::services::InteropProcedures::ticks`: Use tick.
    let _ = &procedures.ticks;
    let _ = &procedures.tick;

    vec![
        InteropFailures::REGISTERED_ALREADY.name(),
        // reported: use of deprecated associated constant `generated::services::InteropFailures::ON_PURPOSE`: No replacement is named.
        InteropFailures::ON_PURPOSE.name(),
    ]
}
