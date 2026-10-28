//! An instant as the conformance files write one: RFC 3339's, in UTC, `2026-10-03T12:01:00.000Z`.

use core::time::Duration;
use std::time::SystemTime;

// the days from 1970-01-01 to `year`-`month`-`day`, by the proleptic Gregorian calendar
fn days_of(year: i64, (month, day): (i64, i64)) -> i64 {
    let shifted = if month <= 2 {
        year.saturating_sub(1)
    } else {
        year
    };
    let era = shifted.div_euclid(400);
    let of_era = shifted.rem_euclid(400);
    let month_from_march = (month.saturating_add(9)).rem_euclid(12);
    let of_year = (month_from_march.saturating_mul(153).saturating_add(2))
        .div_euclid(5)
        .saturating_add(day)
        .saturating_sub(1);
    let of_cycle = of_era
        .saturating_mul(365)
        .saturating_add(of_era.div_euclid(4))
        .saturating_sub(of_era.div_euclid(100))
        .saturating_add(of_year);

    era.saturating_mul(146_097)
        .saturating_add(of_cycle)
        .saturating_sub(719_468)
}

/// The first instant of 2026, in UTC: where the unit tests' clocks start.
#[must_use]
pub fn new_year() -> SystemTime {
    instant_of("2026-01-01T00:00:00.000Z").unwrap_or(SystemTime::UNIX_EPOCH)
}

/// The instant `text` writes, in UTC; none for any other text.
#[must_use]
pub fn instant_of(text: &str) -> Option<SystemTime> {
    let text = text.strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let mut date = date.split('-').map(str::parse::<i64>);
    let (year, month, day) = (date.next()?.ok()?, date.next()?.ok()?, date.next()?.ok()?);
    let (clock, fraction) = time.split_once('.').unwrap_or((time, "0"));
    let mut clock = clock.split(':').map(str::parse::<i64>);
    let (hour, minute, second) = (
        clock.next()?.ok()?,
        clock.next()?.ok()?,
        clock.next()?.ok()?,
    );
    let milliseconds: i64 = format!("{fraction:0<3}").get(..3)?.parse().ok()?;
    let seconds = days_of(year, (month, day))
        .saturating_mul(86_400)
        .saturating_add(hour.saturating_mul(3_600))
        .saturating_add(minute.saturating_mul(60))
        .saturating_add(second);
    let since = Duration::from_secs(u64::try_from(seconds).ok()?)
        .saturating_add(Duration::from_millis(u64::try_from(milliseconds).ok()?));

    SystemTime::UNIX_EPOCH.checked_add(since)
}
