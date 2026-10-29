//! What the core spawns on: the application's tokio runtime, given or current, its time driver
//! checked (decision 0044).
//!
//! The core spawns nowhere else, and reads time through its clock alone (decision 0011), as
//! clippy's `disallowed-methods` and `disallowed-types` hold it: what tokio's calls name is named
//! here, once, so that the core keeps compiling for a browser's WebAssembly as natively.
#![expect(
    clippy::disallowed_methods,
    reason = "the one place the core spawns, finds its runtime and checks its time driver"
)]

use core::future::Future;
use core::time::Duration;

pub(crate) use tokio::runtime::Handle;
pub(crate) use tokio::task::JoinHandle;

use crate::errors::ProgrammerError;

/// The runtime a part of the core runs on: the one given, or the current one, its time driver
/// checked; `subject` names the part in the refusal, `a router` say.
pub(crate) fn runtime_of(
    given: Option<&Handle>,
    subject: &'static str,
) -> Result<Handle, ProgrammerError> {
    let runtime = match given {
        Some(runtime) => runtime.clone(),
        None => Handle::try_current().map_err(|_none| {
            ProgrammerError::new(format!(
                "{subject} is built within a tokio runtime, or given its handle"
            ))
        })?,
    };
    let entered = runtime.enter();
    // ! what tokio panics as a timer is armed on a runtime without its time driver is caught here,
    // once, as the part is built, never inside a later call
    let armed = std::panic::catch_unwind(|| {
        drop(tokio::time::sleep(Duration::ZERO));
    });

    drop(entered);

    if armed.is_err() {
        return Err(ProgrammerError::new(format!(
            "{subject}'s runtime enables tokio's time driver"
        )));
    }

    Ok(runtime)
}

/// Spawns `future` on `runtime`.
#[inline]
pub(crate) fn spawn<F>(runtime: &Handle, future: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    runtime.spawn(future)
}
