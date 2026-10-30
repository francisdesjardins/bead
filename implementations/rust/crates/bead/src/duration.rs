//! Every duration an application gives a side, held as spec 1.4 holds it: a whole number of
//! milliseconds from 1 to [`LONGEST_TIMER`], rounded to the nearest, a half up, from the
//! nanoseconds; [`NEVER`] where never is taken; 0 for a delay at once. Any other is refused by a
//! [`ProgrammerError`] whose reason is a [`DurationRefusal`] (decision 0014).

use core::fmt;
use core::time::Duration;

use crate::errors::{ProgrammerError, Refusal};

#[cfg(test)]
mod tests;

/// The longest a timer waits: 2³¹ − 1 milliseconds, JavaScript's, past which its `setTimeout`
/// fires at once, as `Clocks.LongestTimer` is the C# side's.
pub const LONGEST_TIMER: Duration = Duration::from_millis(2_147_483_647);

/// Never: [`Duration::MAX`], past every ceiling, which arms nothing where a place takes it, as
/// `Infinity` and `Timeout.InfiniteTimeSpan` are each other side's.
pub const NEVER: Duration = Duration::MAX;

// a millisecond, the floor a duration is held from
const MILLISECOND: Duration = Duration::from_millis(1);

/// Why a duration is refused (spec 1.4), as `spec/durations.json` derives its reasons: the codes a
/// side that reports a refusal by a code checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum DurationRefusal {
    /// Under a millisecond, read as given, before rounding.
    UnderTheFloor,
    /// Past 2³¹ − 1 milliseconds, read as given, before rounding.
    PastTheCeiling,
    /// 0 where a timeout, never at once, is asked.
    ZeroRefused,
    /// Never where the place has no meaning for it.
    NeverRefused,
    /// What is not a number: never raised on the Rust side, whose `Duration` is always one.
    NotANumber,
}

impl DurationRefusal {
    /// The reason as `spec/durations.json` derives it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnderTheFloor => "under the floor",
            Self::PastTheCeiling => "past the ceiling",
            Self::ZeroRefused => "0 refused",
            Self::NeverRefused => "never refused",
            Self::NotANumber => "not a number",
        }
    }
}

impl fmt::Display for DurationRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

// what a place takes besides a duration from 1 to the ceiling
#[derive(Clone, Copy)]
struct Offered {
    never: bool,
    zero: bool,
}

// the one refusal of a duration, which offers what its place takes besides
fn refusal_of(
    name: &str,
    (duration, (reason, offered)): (Duration, (DurationRefusal, Offered)),
) -> ProgrammerError {
    let zero = if offered.zero {
        "0 for at once, or "
    } else {
        ""
    };
    let never = if offered.never {
        ", or Duration::MAX for never"
    } else {
        ""
    };
    let written = if duration == NEVER {
        "Duration::MAX".to_owned()
    } else {
        format!("{duration:?}")
    };

    ProgrammerError::refused(
        Refusal::Duration(reason),
        format!(
            "{name} is {zero}a duration of whole milliseconds from 1 to {}{never}, not {written}",
            LONGEST_TIMER.as_millis()
        ),
    )
}

// `duration` rounded to the nearest whole millisecond, a half up, from 1 ms to the ceiling, both
// read as given before rounding; the reason it is not otherwise
fn held_of(duration: Duration) -> Result<Duration, DurationRefusal> {
    if duration < MILLISECOND {
        return Err(DurationRefusal::UnderTheFloor);
    }

    if duration > LONGEST_TIMER {
        return Err(DurationRefusal::PastTheCeiling);
    }

    let nanoseconds = duration.as_nanos();
    let milliseconds = nanoseconds.saturating_add(500_000) / 1_000_000;

    Ok(Duration::from_millis(
        u64::try_from(milliseconds).unwrap_or(u64::MAX),
    ))
}

/// `duration` held as spec 1.4 holds it where never is taken: [`NEVER`] as itself, any other from
/// 1 ms to [`LONGEST_TIMER`] rounded to the nearest whole millisecond.
///
/// # Errors
///
/// A [`ProgrammerError`] naming the duration `name`, its reason under the floor, past the ceiling,
/// or 0 refused.
pub fn hold(name: &str, duration: Duration) -> Result<Duration, ProgrammerError> {
    let offered = Offered {
        never: true,
        zero: false,
    };

    if duration == NEVER {
        return Ok(NEVER);
    }

    if duration.is_zero() {
        return Err(refusal_of(
            name,
            (duration, (DurationRefusal::ZeroRefused, offered)),
        ));
    }

    held_of(duration).map_err(|reason| refusal_of(name, (duration, (reason, offered))))
}

/// As [`hold`], where never has no meaning: [`NEVER`] is refused too.
///
/// # Errors
///
/// A [`ProgrammerError`] naming the duration `name`, its reason under the floor, past the ceiling,
/// 0 refused, or never refused.
pub fn hold_finite(name: &str, duration: Duration) -> Result<Duration, ProgrammerError> {
    let offered = Offered {
        never: false,
        zero: false,
    };

    if duration == NEVER {
        return Err(refusal_of(
            name,
            (duration, (DurationRefusal::NeverRefused, offered)),
        ));
    }

    if duration.is_zero() {
        return Err(refusal_of(
            name,
            (duration, (DurationRefusal::ZeroRefused, offered)),
        ));
    }

    held_of(duration).map_err(|reason| refusal_of(name, (duration, (reason, offered))))
}

/// As [`hold_finite`], for a delay: 0 is at once, held as 0, for which no timer is armed; never is
/// refused, since a delay of never would never end.
///
/// # Errors
///
/// A [`ProgrammerError`] naming the duration `name`, its reason under the floor, past the ceiling,
/// or never refused.
pub fn hold_delay(name: &str, duration: Duration) -> Result<Duration, ProgrammerError> {
    let offered = Offered {
        never: false,
        zero: true,
    };

    if duration.is_zero() {
        return Ok(Duration::ZERO);
    }

    if duration == NEVER {
        return Err(refusal_of(
            name,
            (duration, (DurationRefusal::NeverRefused, offered)),
        ));
    }

    held_of(duration).map_err(|reason| refusal_of(name, (duration, (reason, offered))))
}
