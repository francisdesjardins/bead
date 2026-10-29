//! What a side tells whoever listens to `debug` (`spec/debugging.md`, decision 0013): each step of
//! a call, each envelope a router sends or takes, and the filter that keeps some of them.

use core::fmt;
use std::sync::{Arc, Mutex, PoisonError};

use crate::constants::{CredentialScheme, EnvelopeKind};
use crate::envelope::{Credential, FailureHeader, Header, RequestHeader, ResultHeader};
use crate::errors::{ProgrammerError, Refusal};
use crate::router::types::ConnectionHandle;

#[cfg(test)]
mod tests;

/// Which way a step or an envelope went: in, or out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum DebugDirection {
    /// In.
    Rx,
    /// Out.
    Tx,
}

/// An envelope a router traces: the connection it went or came on, and its header, which carries
/// its credential's scheme in place of its credential (spec/debugging.md 5.1).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct TracedEnvelope {
    /// The connection it went or came on: the server's, on a client's router.
    pub connection_handle: ConnectionHandle,
    /// Its header, its credential taken out.
    pub header: Header,
    /// Its credential's scheme, in place of its credential.
    pub credential_scheme: Option<CredentialScheme>,
}

impl TracedEnvelope {
    /// The trace of `header`, on `connection_handle`: a session's token, a `JWT` and a scheme to
    /// come's bytes never in it.
    #[must_use]
    pub fn of(connection_handle: &ConnectionHandle, header: &Header) -> Self {
        let credential_scheme = header.credential().map(Credential::scheme);
        let header = match header {
            Header::Request(request) => Header::Request(RequestHeader {
                credential: None,
                ..request.clone()
            }),
            Header::Result(result) => Header::Result(ResultHeader {
                credential: None,
                ..result.clone()
            }),
            Header::Failure(failure) => Header::Failure(FailureHeader {
                credential: None,
                ..failure.clone()
            }),
            Header::Notification(_) | Header::Chunk(_) | Header::Credit(_) | Header::Cancel(_) => {
                header.clone()
            }
        };

        Self {
            connection_handle: Arc::clone(connection_handle),
            header,
            credential_scheme,
        }
    }
}

impl DebugDirection {
    /// The direction as the grammar names it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rx => "rx",
            Self::Tx => "tx",
        }
    }
}

/// What kind of call a step belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum DebugType {
    /// A request a client makes.
    Request,
    /// A command a server makes.
    Command,
    /// A notification.
    Notification,
}

impl DebugType {
    /// The type as the grammar names it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Command => "command",
            Self::Notification => "notification",
        }
    }
}

/// Which `debug` events a listener hears (`spec/debugging.md` 6).
///
/// Those of a direction, a type and a kind among the ones given — any, when none is — whose
/// procedure's name matches one pattern of `include`, when there is one, and none of `exclude`,
/// which wins.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DebugFilter {
    /// The directions kept.
    pub directions: Vec<DebugDirection>,
    /// The call types kept.
    pub types: Vec<DebugType>,
    /// The envelope kinds kept, which a call's listener does not ask.
    pub kinds: Vec<EnvelopeKind>,
    /// The patterns of the procedures kept.
    pub include: Vec<String>,
    /// The patterns of the procedures left out, without their `-`.
    pub exclude: Vec<String>,
}

/// Why a filter is refused (`spec/debugging.md` 6.7), as `spec/debug-filters.json` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum FilterRefusal {
    /// A selector that names no value.
    SelectorEmpty,
    /// A selector with a value left empty.
    ValueEmpty,
    /// A value that names none of its letter's.
    NamesNothing,
    /// A word holding a parenthesis that is no selector.
    HoldsAParenthesis,
}

impl FilterRefusal {
    /// The reason as the file names it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SelectorEmpty => "selector empty",
            Self::ValueEmpty => "value empty",
            Self::NamesNothing => "names nothing",
            Self::HoldsAParenthesis => "holds a parenthesis",
        }
    }
}

impl fmt::Display for FilterRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

// a refusal of a filter, naming what it refuses as it was written, quoted as JSON writes a string
fn refused(reason: FilterRefusal, (words, written): (&str, &str)) -> ProgrammerError {
    let quoted = serde_json::to_string(written).unwrap_or_default();

    ProgrammerError::refused(Refusal::Filter(reason), format!("{words}, not {quoted}"))
}

// ! a separator is a comma or one of the six characters C's isspace reads as white space in the C
// locale: nothing outside ASCII parts two words (spec/debugging.md 6.2)
fn is_separator(character: char) -> bool {
    matches!(
        character,
        ',' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' '
    )
}

// each kind, by its name in section 3.1, in lower case
fn kind_named(name: &str) -> Option<EnvelopeKind> {
    match name {
        "request" => Some(EnvelopeKind::Request),
        "result" => Some(EnvelopeKind::Result),
        "failure" => Some(EnvelopeKind::Failure),
        "notification" => Some(EnvelopeKind::Notification),
        "chunk" => Some(EnvelopeKind::Chunk),
        "credit" => Some(EnvelopeKind::Credit),
        "cancel" => Some(EnvelopeKind::Cancel),
        _ => None,
    }
}

fn direction_named(name: &str) -> Option<DebugDirection> {
    match name {
        "rx" => Some(DebugDirection::Rx),
        "tx" => Some(DebugDirection::Tx),
        _ => None,
    }
}

fn type_named(name: &str) -> Option<DebugType> {
    match name {
        "request" | "r" => Some(DebugType::Request),
        "command" | "c" => Some(DebugType::Command),
        "notification" | "n" => Some(DebugType::Notification),
        _ => None,
    }
}

// one selector's values, each read in ASCII case: the first left empty, or that names none of its
// letter's, refuses the filter
fn selected_of<T, N: Fn(&str) -> Option<T>>(
    (values, word): (&[&str], &str),
    (named, taken): (N, &str),
) -> Result<Vec<T>, ProgrammerError> {
    values
        .iter()
        .map(|&value| {
            if value.is_empty() {
                return Err(refused(
                    FilterRefusal::ValueEmpty,
                    ("a debug filter's selector leaves no value empty", word),
                ));
            }

            named(&value.to_ascii_lowercase()).ok_or_else(|| {
                refused(
                    FilterRefusal::NamesNothing,
                    (&format!("a debug filter takes a {taken}"), value),
                )
            })
        })
        .collect()
}

/// A `debug` filter, from its spec, as `spec/debugging.md` states it (section 6).
///
/// Words parted by commas or ASCII white space: `d(rx)`, `t(r|c)`, `e(failure)` select by
/// direction, type and kind; `-name` leaves a procedure out; any other word is a procedure to keep,
/// `*` any run of characters.
///
/// # Errors
///
/// A [`ProgrammerError`] for the first word that does not hold, its reason a [`FilterRefusal`].
pub fn parse_debug_filter(spec: &str) -> Result<DebugFilter, ProgrammerError> {
    let mut filter = DebugFilter::default();

    for word in spec.split(is_separator) {
        if word.is_empty() {
            continue;
        }

        let mut characters = word.chars();
        let letter = characters.next().map(|letter| letter.to_ascii_lowercase());
        let is_selector = characters.next() == Some('(')
            && word.ends_with(')')
            && matches!(letter, Some('d' | 'e' | 't'));

        if is_selector {
            let within = word
                .get(2..word.len().saturating_sub(1))
                .unwrap_or_default();

            if within.is_empty() {
                return Err(refused(
                    FilterRefusal::SelectorEmpty,
                    ("a debug filter's selector names a value", word),
                ));
            }

            let values: Vec<&str> = within.split('|').collect();

            match letter {
                Some('d') => filter.directions.extend(selected_of(
                    (&values, word),
                    (direction_named, "direction among rx, tx"),
                )?),
                Some('t') => filter.types.extend(selected_of(
                    (&values, word),
                    (
                        type_named,
                        "type among request, command, notification, r, c, n",
                    ),
                )?),
                _ => filter.kinds.extend(selected_of(
                    (&values, word),
                    (
                        kind_named,
                        "kind among request, result, failure, notification, chunk, credit, cancel",
                    ),
                )?),
            }
        } else if word.contains(['(', ')']) {
            return Err(refused(
                FilterRefusal::HoldsAParenthesis,
                (
                    "a debug filter holds a parenthesis in a selector alone, d(…), t(…) or e(…)",
                    word,
                ),
            ));
        } else if let Some(left_out) = word.strip_prefix('-') {
            filter.exclude.push(left_out.to_owned());
        } else {
            filter.include.push(word.to_owned());
        }
    }

    Ok(filter)
}

// whether `name` matches `pattern` whole, both by code point: `*` any run, none included; an ASCII
// letter itself in either case; any other code point itself alone
fn matches_whole(pattern: &[char], name: &[char]) -> bool {
    let same = |wanted: char, given: char| {
        wanted == given || (wanted.is_ascii_alphabetic() && wanted.eq_ignore_ascii_case(&given))
    };
    let (mut at, mut of) = (0_usize, 0_usize);
    let mut star: Option<usize> = None;
    let mut reached = 0_usize;

    while let Some(&given) = name.get(of) {
        match pattern.get(at) {
            Some(&wanted) if wanted != '*' && same(wanted, given) => {
                at = at.saturating_add(1);
                of = of.saturating_add(1);
            }
            Some('*') => {
                star = Some(at);
                at = at.saturating_add(1);
                reached = of;
            }
            Some(_) | None => {
                let Some(last) = star else {
                    return false;
                };

                // the last star takes one character more, and the pattern after it is tried again
                at = last.saturating_add(1);
                reached = reached.saturating_add(1);
                of = reached;
            }
        }
    }

    while pattern.get(at) == Some(&'*') {
        at = at.saturating_add(1);
    }

    at == pattern.len()
}

/// A call's step as a filter asks it: its direction, its type and its procedure's name.
#[derive(Debug, Clone, Copy)]
pub struct CallAsked<'name> {
    /// Its direction.
    pub direction: DebugDirection,
    /// Its call's type.
    pub call_type: DebugType,
    /// Its procedure's name.
    pub procedure_name: &'name str,
}

/// An envelope as a filter asks it: its direction and its kind.
#[derive(Debug, Clone, Copy)]
pub struct EnvelopeAsked {
    /// Its direction.
    pub direction: DebugDirection,
    /// Its kind.
    pub kind: EnvelopeKind,
}

// a filter compiled: its patterns by code point
#[derive(Debug, Clone)]
struct Compiled {
    filter: DebugFilter,
    include: Vec<Vec<char>>,
    exclude: Vec<Vec<char>>,
}

impl Compiled {
    fn of(filter: DebugFilter) -> Self {
        let chars = |patterns: &[String]| -> Vec<Vec<char>> {
            patterns
                .iter()
                .map(|pattern| pattern.chars().collect())
                .collect()
        };

        Self {
            include: chars(&filter.include),
            exclude: chars(&filter.exclude),
            filter,
        }
    }

    fn keeps_call(&self, asked: &CallAsked<'_>) -> bool {
        let name: Vec<char> = asked.procedure_name.chars().collect();
        let filter = &self.filter;

        (filter.directions.is_empty() || filter.directions.contains(&asked.direction))
            && (filter.types.is_empty() || filter.types.contains(&asked.call_type))
            && (self.include.is_empty()
                || self
                    .include
                    .iter()
                    .any(|pattern| matches_whole(pattern, &name)))
            && !self
                .exclude
                .iter()
                .any(|pattern| matches_whole(pattern, &name))
    }

    fn keeps_envelope(&self, asked: EnvelopeAsked) -> bool {
        let filter = &self.filter;

        (filter.directions.is_empty() || filter.directions.contains(&asked.direction))
            && (filter.kinds.is_empty() || filter.kinds.contains(&asked.kind))
    }
}

/// A filter as a source gives it: its spec, or the filter whole.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum GivenFilter {
    /// Its spec, read by [`parse_debug_filter`].
    Spec(String),
    /// The filter whole.
    Filter(DebugFilter),
}

/// What a function giving a filter gives: a filter, none, which keeps every event, or its error.
pub type FilterGiven = Result<Option<GivenFilter>, Box<dyn std::error::Error + Send + Sync>>;

/// Where a listener's filter comes from: given once, or by a function asked at each event.
#[derive(Clone)]
#[non_exhaustive]
pub enum DebugFilterSource {
    /// A filter given once.
    Given(GivenFilter),
    /// A function asked at each event (`spec/debugging.md` 6.9).
    Function(Arc<dyn Fn() -> FilterGiven + Send + Sync>),
}

impl fmt::Debug for DebugFilterSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Given(given) => formatter.debug_tuple("Given").field(given).finish(),
            Self::Function(_) => formatter.write_str("Function"),
        }
    }
}

// what a filter's source gives now, as a filter compiled
fn resolve(given: Option<&GivenFilter>) -> Result<Compiled, ProgrammerError> {
    match given {
        None => Ok(Compiled::of(DebugFilter::default())),
        Some(GivenFilter::Spec(spec)) => parse_debug_filter(spec).map(Compiled::of),
        Some(GivenFilter::Filter(filter)) => Ok(Compiled::of(filter.clone())),
    }
}

#[derive(Debug)]
struct Kept {
    given: Option<GivenFilter>,
    compiled: Compiled,
}

/// Whether an event passes the filter a source gives: asked again at each event when a function,
/// compiled again only when it gives another, and left as it was when that no longer holds.
pub struct FilterKeeper {
    source: DebugFilterSource,
    kept: Mutex<Kept>,
}

impl fmt::Debug for FilterKeeper {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FilterKeeper")
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

impl FilterKeeper {
    /// The keeper of `source`'s filter: the first it gives must hold.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a first filter that does not hold, or a function that fails as it
    /// is first asked.
    pub fn new(source: DebugFilterSource) -> Result<Self, ProgrammerError> {
        let given = match &source {
            DebugFilterSource::Given(given) => Some(given.clone()),
            DebugFilterSource::Function(function) => function().map_err(|error| {
                ProgrammerError::new(format!("a debug filter's function failed: {error}"))
            })?,
        };
        let compiled = resolve(given.as_ref())?;

        Ok(Self {
            source,
            kept: Mutex::new(Kept { given, compiled }),
        })
    }

    // the filter compiled now: a function asked again, its filter compiled again when it gives
    // another that holds, the last that held kept otherwise
    fn now(&self) -> Compiled {
        let mut kept = self.kept.lock().unwrap_or_else(PoisonError::into_inner);

        if let DebugFilterSource::Function(function) = &self.source
            && let Ok(next) = function()
            && next != kept.given
        {
            // * a filter that stops holding leaves the last that held, asked again at the next event
            if let Ok(compiled) = resolve(next.as_ref()) {
                kept.compiled = compiled;
                kept.given = next;
            }
        }

        let compiled = kept.compiled.clone();

        drop(kept);

        compiled
    }

    /// Whether a call's step passes.
    pub fn keeps_call(&self, asked: &CallAsked<'_>) -> bool {
        self.now().keeps_call(asked)
    }

    /// Whether an envelope passes.
    pub fn keeps_envelope(&self, asked: EnvelopeAsked) -> bool {
        self.now().keeps_envelope(asked)
    }
}
