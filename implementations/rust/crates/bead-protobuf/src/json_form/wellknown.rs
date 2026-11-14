//! The well-known types whose JSON is a string of its own form (spec/transcoding.md 5.4.1 to
//! 5.4.3, 5.6.7): a `Timestamp`'s RFC 3339, a `Duration`'s seconds with `s`, a `FieldMask`'s paths
//! in lowerCamelCase; read, each by its words, and written.

// a Timestamp's range, 0001-01-01T00:00:00Z to 9999-12-31T23:59:59.999999999Z, in seconds
pub(crate) const EARLIEST_SECONDS: i64 = -62_135_596_800;
pub(crate) const LATEST_SECONDS: i64 = 253_402_300_799;
// a Duration's, ±315,576,000,000.999999999 seconds
pub(crate) const LONGEST_SECONDS: i64 = 315_576_000_000;
pub(crate) const NANOS_PER_SECOND: i32 = 1_000_000_000;

const SECONDS_PER_DAY: i64 = 86_400;

/// A time's seconds and nanoseconds, as a `Timestamp` and a `Duration` hold them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Instant {
    pub(crate) seconds: i64,
    pub(crate) nanos: i32,
}

// ── Time ──────────────────────────────────────────────────────────────────────

// a day of the proleptic Gregorian calendar
#[derive(Debug, Clone, Copy)]
struct Civil {
    year: i64,
    month: i64,
    day: i64,
}

// * the civil calendar's arithmetic, Howard Hinnant's: every value bounded by a Timestamp's range,
// four digits of a year, so none of it overflows an i64
#[expect(
    clippy::arithmetic_side_effects,
    clippy::integer_division,
    clippy::integer_division_remainder_used,
    reason = "a day of four digits of a year, far within an i64; the calendar's divisions are its own"
)]
fn days_from_civil(civil: Civil) -> i64 {
    let Civil { year, month, day } = civil;
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let year_of_era = shifted - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;

    era * 146_097 + day_of_era - 719_468
}

#[expect(
    clippy::arithmetic_side_effects,
    clippy::integer_division,
    clippy::integer_division_remainder_used,
    reason = "a day within a Timestamp's range, far within an i64; the calendar's divisions are its own"
)]
fn civil_from_days(days: i64) -> Civil {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;

    Civil {
        year: year_of_era + era * 400 + i64::from(month <= 2),
        month,
        day,
    }
}

const fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

const fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

// the digits of `text`, each an ASCII digit, as a number; none otherwise
fn number_of(text: &str) -> Option<i64> {
    (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| text.parse::<i64>().ok())
        .flatten()
}

// up to nine digits of a fraction, as nanoseconds
fn nanos_of(fraction: &str) -> Option<i32> {
    if fraction.is_empty() {
        return Some(0);
    }

    if fraction.len() > 9 || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    format!("{fraction:0<9}").parse::<i32>().ok()
}

/// Nanoseconds as a fraction of 0, 3, 6 or 9 digits, the fewest that hold them (5.6.7).
fn fraction_of(nanos: i32) -> String {
    if nanos == 0 {
        return String::new();
    }

    let digits = format!("{nanos:09}");
    let kept = if nanos % 1_000_000 == 0 {
        3
    } else if nanos % 1000 == 0 {
        6
    } else {
        9
    };

    format!(".{}", digits.get(..kept).unwrap_or_default())
}

/// A `Timestamp`'s seconds and nanoseconds of its RFC 3339 form (5.4.1), its refusal's words.
#[expect(
    clippy::arithmetic_side_effects,
    reason = "each part bounded by its two or four digits, far within an i64"
)]
pub(crate) fn read_timestamp(text: &str) -> Result<Instant, &'static str> {
    const OFF: &str = "a Timestamp off RFC 3339";

    let bytes = text.as_bytes();
    let separators = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];

    if bytes.len() < 20
        || separators
            .iter()
            .any(|&(at, separator)| bytes.get(at) != Some(&separator))
    {
        return Err(OFF);
    }

    let part = |range: core::ops::Range<usize>| text.get(range).and_then(number_of).ok_or(OFF);
    let (year, month, day) = (part(0..4)?, part(5..7)?, part(8..10)?);
    let (hour, minute, second) = (part(11..13)?, part(14..16)?, part(17..19)?);
    let rest = text.get(19..).ok_or(OFF)?;
    let (fraction, offset) = match rest.strip_prefix('.') {
        Some(after) => {
            let digits = after.bytes().take_while(u8::is_ascii_digit).count();

            if digits == 0 || digits > 9 {
                return Err(OFF);
            }

            after.split_at_checked(digits).ok_or(OFF)?
        }
        None => ("", rest),
    };
    let offset_seconds = if offset == "Z" {
        0
    } else {
        let offset_bytes = offset.as_bytes();
        let sign = match offset_bytes.first() {
            Some(b'+') => 1,
            Some(b'-') => -1,
            _ => return Err(OFF),
        };

        if offset_bytes.len() != 6 || offset_bytes.get(3) != Some(&b':') {
            return Err(OFF);
        }

        let hours = offset.get(1..3).and_then(number_of).ok_or(OFF)?;
        let minutes = offset.get(4..6).and_then(number_of).ok_or(OFF)?;

        if hours > 23 || minutes > 59 {
            return Err("a Timestamp of no offset");
        }

        sign * (hours * 3600 + minutes * 60)
    };

    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err("a Timestamp of no instant");
    }

    let seconds = days_from_civil(Civil { year, month, day }) * SECONDS_PER_DAY
        + hour * 3600
        + minute * 60
        + second
        - offset_seconds;

    if !(EARLIEST_SECONDS..=LATEST_SECONDS).contains(&seconds) {
        return Err("a Timestamp past its range");
    }

    Ok(Instant {
        seconds,
        nanos: nanos_of(fraction).ok_or(OFF)?,
    })
}

/// A `Timestamp`'s JSON, in UTC, with `Z` (5.6.7); one outside its range refused (5.7).
#[expect(
    clippy::integer_division,
    clippy::integer_division_remainder_used,
    reason = "seconds within a Timestamp's range, checked first: a day's hours, minutes and seconds"
)]
pub(crate) fn timestamp_json(instant: Instant) -> Result<String, &'static str> {
    let Instant { seconds, nanos } = instant;

    if !(EARLIEST_SECONDS..=LATEST_SECONDS).contains(&seconds)
        || !(0..NANOS_PER_SECOND).contains(&nanos)
    {
        return Err("a Timestamp outside its range");
    }

    let days = seconds.div_euclid(SECONDS_PER_DAY);
    let in_day = seconds.rem_euclid(SECONDS_PER_DAY);
    let Civil { year, month, day } = civil_from_days(days);

    Ok(format!(
        "\"{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}{}Z\"",
        in_day / 3600,
        in_day / 60 % 60,
        in_day % 60,
        fraction_of(nanos)
    ))
}

/// A `Duration`'s seconds and nanoseconds of its form, both of its sign (5.4.2).
pub(crate) fn read_duration(text: &str) -> Result<Instant, &'static str> {
    const OFF: &str = "a Duration off its form";

    let (is_negative, unsigned) = text
        .strip_prefix('-')
        .map_or((false, text), |rest| (true, rest));
    let number = unsigned.strip_suffix('s').ok_or(OFF)?;
    let (whole, fraction) = match number.split_once('.') {
        Some((whole, fraction)) if !fraction.is_empty() => (whole, fraction),
        Some(_) => return Err(OFF),
        None => (number, ""),
    };
    let is_whole = whole == "0"
        || matches!(whole.as_bytes(), [b'1'..=b'9', rest @ ..] if rest.iter().all(u8::is_ascii_digit));

    if !is_whole {
        return Err(OFF);
    }

    let nanos = nanos_of(fraction).ok_or(OFF)?;
    let seconds = whole.parse::<i64>().unwrap_or(i64::MAX);

    if seconds > LONGEST_SECONDS {
        return Err("a Duration past its range");
    }

    Ok(if is_negative {
        Instant {
            seconds: seconds.saturating_neg(),
            nanos: nanos.saturating_neg(),
        }
    } else {
        Instant { seconds, nanos }
    })
}

/// A `Duration`'s JSON, with `s` (5.6.7); one outside its range, or whose signs part, refused (5.7).
pub(crate) fn duration_json(instant: Instant) -> Result<String, &'static str> {
    let Instant { seconds, nanos } = instant;

    if !(-LONGEST_SECONDS..=LONGEST_SECONDS).contains(&seconds)
        || nanos >= NANOS_PER_SECOND
        || nanos <= -NANOS_PER_SECOND
        || (seconds > 0 && nanos < 0)
        || (seconds < 0 && nanos > 0)
    {
        return Err("a Duration outside its range");
    }

    let sign = if seconds < 0 || nanos < 0 { "-" } else { "" };

    Ok(format!(
        "\"{sign}{}{}s\"",
        seconds.unsigned_abs(),
        fraction_of(nanos.saturating_abs())
    ))
}

// ── Field masks ───────────────────────────────────────────────────────────────

// a segment of lowerCamelCase: a lower-case letter, then letters and digits
fn is_camel_segment(segment: &str) -> bool {
    matches!(segment.as_bytes(), [b'a'..=b'z', rest @ ..] if rest.iter().all(u8::is_ascii_alphanumeric))
}

/// A snake-case path's lowerCamelCase: each `_` and the lower-case letter after it, that letter
/// upper-case.
pub(crate) fn camel_of(path: &str) -> String {
    let mut camel = String::with_capacity(path.len());
    let mut characters = path.chars().peekable();

    while let Some(character) = characters.next() {
        if character == '_'
            && let Some(next) = characters.next_if(char::is_ascii_lowercase)
        {
            camel.push(next.to_ascii_uppercase());
        } else {
            camel.push(character);
        }
    }

    camel
}

// a lowerCamelCase path's snake case: each upper-case letter `_` and that letter lower-case
fn snake_of(path: &str) -> String {
    let mut snake = String::with_capacity(path.len());

    for character in path.chars() {
        if character.is_ascii_uppercase() {
            snake.push('_');
            snake.push(character.to_ascii_lowercase());
        } else {
            snake.push(character);
        }
    }

    snake
}

/// A `FieldMask`'s paths of its form, each read to snake case and held to reverse (5.4.3).
pub(crate) fn read_field_mask(text: &str) -> Result<Vec<String>, &'static str> {
    if text.is_empty() {
        return Ok(vec![]);
    }

    text.split(',')
        .map(|path| {
            if path.is_empty() {
                return Err("a FieldMask of an empty path");
            }

            let snake = snake_of(path);

            if !path.split('.').all(is_camel_segment) || camel_of(&snake) != path {
                return Err("a FieldMask path off lowerCamelCase");
            }

            Ok(snake)
        })
        .collect()
}

/// A `FieldMask`'s JSON, its paths in lowerCamelCase by `,`, each held to read back (5.6.7, 5.7).
pub(crate) fn field_mask_json(paths: &[String]) -> Result<String, &'static str> {
    let camel = paths
        .iter()
        .map(|path| {
            let written = camel_of(path);

            if !written.split('.').all(is_camel_segment) || snake_of(&written) != *path {
                return Err("a FieldMask path whose lowerCamelCase does not read back");
            }

            Ok(written)
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(super::text::string_json(&camel.join(",")))
}
