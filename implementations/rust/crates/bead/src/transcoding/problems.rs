//! What a gateway answers a failure with (spec/transcoding.md 7): a problem of RFC 9457 in section
//! 17.7's canonical form, its status keyed by where its code arose, and `PAYLOAD_INVALID`'s
//! violations as `errors`, each a `pointer` or a `parameter`.

use core::num::NonZeroU16;

use serde_json::{Map, Value};

use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::failure::Failure;
use crate::json;
use crate::service::ListedFailure;
use crate::transcoding::form::{MessageForm, RequestPlace};
use crate::transcoding::routes::HttpRouteTemplate;
use crate::transcoding::templates::parse_template;
use crate::violations::{Violation, violations_of};

#[cfg(test)]
mod tests;

/// The media type of a problem (RFC 9457 §3).
pub const PROBLEM_MEDIA_TYPE: &str = "application/problem+json";

/// A protocol code's problem type is this, followed by its name, or its number (7.3).
pub const PROTOCOL_TYPES: &str = "tag:francisdesjardins.ca,2026:bead/";

/// The challenge a 401 carries where the gateway is given none (7.6).
pub const DEFAULT_CHALLENGE: &str = "Bearer";

const ABOUT_BLANK: &str = "about:blank";

/// Where a failure arose (7.5).
///
/// Its server answered it of the request; its client raised it before the call went; its client raised it of a result or a notification; the gateway's own reading of
/// the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arose {
    /// Its client raised it of a result or a notification.
    Answer,
    /// Its client raised it before the call went.
    Client,
    /// The gateway's own reading of the request.
    Gateway,
    /// Its server answered it of the request.
    Server,
}

/// A payload's encoding, as a binding names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    /// Bead's `json`.
    Json,
    /// A message's, through its JSON form.
    Proto,
    /// Bead's `raw`.
    Raw,
    /// Bead's `text`.
    Text,
}

/// A failure of the gateway's own (7.6), each its status: `Failed`, what no gate foresaw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum OwnFailure {
    /// Its connection closed before its result: 502.
    Closed,
    /// What no gate foresaw: 500.
    Failed,
    /// A `JWT` its block cannot hold: 431.
    Jwt,
    /// An auth-scheme but `Bearer` under `BearerJwt`: 401.
    Scheme,
    /// Its call's timeout: 504.
    Timeout,
    /// A result it cannot write: 500.
    Unwritable,
}

/// What a problem of the gateway's own is written with besides its failure and its detail.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct OwnProblemOptions {
    /// The gateway's challenge, which an auth-scheme but `Bearer` answers; `Bearer` by default.
    pub challenge: Option<String>,
}

/// A call's failure, as the gateway's client read it, and where it arose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallFailure {
    /// Where it arose.
    pub arose: Arose,
    /// Its code.
    pub code: NonZeroU16,
    /// Its scope.
    pub scope: FailureScope,
    /// Its detail, empty where it has none.
    pub detail: String,
    /// Whether its call presented a credential, which a 401 tells as `invalid_token`.
    pub credential: bool,
    /// The encoding of the request its server could not read.
    pub encoding: Encoding,
    /// Where the gateway's reading met what it refuses, as 7.4 places one.
    pub place: Option<RequestPlace>,
}

/// Where a request's fields came from, so a violation says where its field lies (7.4).
#[derive(Debug, Clone, Copy)]
pub struct ProblemRoute<'a> {
    /// The request's message's form, which maps 18.4's proto names to JSON names.
    pub form: &'a dyn MessageForm,
    /// The route the request was bound by.
    pub route: &'a HttpRouteTemplate,
}

/// What a problem is written with besides its failure.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct ProblemOptions<'a> {
    /// The service's catalogue, each failure's code by its name.
    pub catalogue: Option<&'a [ListedFailure]>,
    /// The gateway's challenge, `Bearer` by default.
    pub challenge: Option<&'a str>,
    /// The base of an application failure's type; none, `about:blank`.
    pub problem_types: Option<&'a str>,
    /// Where its request's fields came from, for `PAYLOAD_INVALID`'s violations.
    pub route: Option<ProblemRoute<'a>>,
}

/// A field a problem carries beside its body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProblemField {
    /// Its name, lower case.
    pub name: &'static str,
    /// Its value.
    pub value: String,
}

/// A problem as a gateway answers it: its status, the fields beside it, and its body's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    /// Its status.
    pub status: u16,
    /// The fields beside it, in their order.
    pub fields: Vec<ProblemField>,
    /// Its body, one JSON text.
    pub body: String,
}

/// The phrase RFC 9110 gives each status a gateway answers, an `about:blank` problem's title.
#[must_use]
pub const fn phrase_of(status: u16) -> Option<&'static str> {
    Some(match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => return None,
    })
}

// a challenge with `error=` after it: after a space, or after `, ` where it holds parameters
fn challenge_of(challenge: &str, error: &str) -> String {
    let between = if challenge.trim().contains(' ') {
        ", "
    } else {
        " "
    };

    format!("{challenge}{between}error=\"{error}\"")
}

fn retry() -> Vec<ProblemField> {
    vec![ProblemField {
        name: "retry-after",
        value: "1".to_owned(),
    }]
}

// a protocol code's status by where it arose, and the fields beside it (7.6)
fn protocol_status_of(failure: &CallFailure, challenge: &str) -> (u16, Vec<ProblemField>) {
    let code = ProtocolCode::new(failure.code);

    if code == ProtocolCode::ENVELOPE_MALFORMED {
        (500, vec![])
    } else if code == ProtocolCode::LAYOUT_UNSUPPORTED
        || code == ProtocolCode::KIND_UNSUPPORTED
        || code == ProtocolCode::DESTINATION_LOST
    {
        (502, vec![])
    } else if code == ProtocolCode::ENVELOPE_TOO_LARGE || code == ProtocolCode::PAYLOAD_TOO_LARGE {
        (
            if failure.arose == Arose::Answer {
                502
            } else {
                413
            },
            vec![],
        )
    } else if code == ProtocolCode::DESTINATION_UNREACHABLE {
        (503, retry())
    } else if code == ProtocolCode::SERVICE_UNKNOWN || code == ProtocolCode::PROCEDURE_UNKNOWN {
        (501, vec![])
    } else if code == ProtocolCode::SESSION_REQUIRED {
        let value = if failure.credential {
            challenge_of(challenge, "invalid_token")
        } else {
            challenge.to_owned()
        };

        (
            401,
            vec![ProblemField {
                name: "www-authenticate",
                value,
            }],
        )
    } else if code == ProtocolCode::ACCESS_DENIED {
        (403, vec![])
    } else if code == ProtocolCode::CAPACITY_EXCEEDED {
        (429, retry())
    } else if code == ProtocolCode::PAYLOAD_UNDECODABLE {
        let is_callers = matches!(failure.arose, Arose::Gateway | Arose::Client)
            || (failure.arose == Arose::Server && failure.encoding != Encoding::Proto);

        (if is_callers { 400 } else { 502 }, vec![])
    } else if code == ProtocolCode::TRANSFER_STALLED {
        (504, vec![])
    } else if code == ProtocolCode::PAYLOAD_INVALID {
        (422, vec![])
    } else {
        (500, vec![])
    }
}

/// A place's member, as a problem or one of its errors carries it.
pub fn place_into(members: &mut Map<String, Value>, place: &RequestPlace) {
    match place {
        RequestPlace::Pointer(pointer) => {
            members.insert("pointer".to_owned(), Value::from(pointer.as_str()));
        }
        RequestPlace::Parameter(parameter) => {
            members.insert("parameter".to_owned(), Value::from(parameter.as_str()));
        }
    }
}

/// A JSON Pointer's reference token, `~` and `/` escaped (RFC 6901 §4).
#[must_use]
pub fn pointer_token_of(text: &str) -> String {
    text.replace('~', "~0").replace('/', "~1")
}

/// A text as a URI's fragment holds it (RFC 3986 §3.5): each octet of UTF-8 but its unreserved
/// characters, its sub-delims, `:`, `@`, `/` and `?` percent-encoded, in upper case.
#[must_use]
pub fn fragment_of(text: &str) -> String {
    let mut fragment = String::with_capacity(text.len());

    for character in text.chars() {
        if character.is_ascii_alphanumeric() || "-._~!$&'()*+,;=:@/?".contains(character) {
            fragment.push(character);
        } else {
            let mut buffer = [0_u8; 4];

            for byte in character.encode_utf8(&mut buffer).bytes() {
                fragment.push('%');

                for digit in [byte >> 4, byte & 0x0F] {
                    fragment.extend(
                        char::from_digit(u32::from(digit), 16).map(|hex| hex.to_ascii_uppercase()),
                    );
                }
            }
        }
    }

    fragment
}

// an element of 18.4's field path: its name, and its subscript read, a cut key told apart
struct Element {
    name: String,
    subscript: Option<(String, bool)>,
}

// a subscript of 18.4's grammar at the start of `inside`, after its `[`: an integer, a boolean, or
// a JSON string, `...` after it where it was cut; its text, and what follows its `]`
fn subscript_of(inside: &str) -> Option<((String, bool), &str)> {
    if let Some(quoted) = inside.strip_prefix('"') {
        let mut escaped = false;
        let close = quoted.char_indices().find_map(|(index, character)| {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                return Some(index);
            }

            None
        })?;
        let (string, after) = quoted.split_at_checked(close)?;
        let text = serde_json::from_str::<String>(&format!("\"{string}\"")).ok()?;
        let after = after.strip_prefix('"')?;
        let (after, is_cut) = after
            .strip_prefix("...")
            .map_or((after, false), |after| (after, true));

        return after.strip_prefix(']').map(|after| ((text, is_cut), after));
    }

    let (text, after) = inside.split_once(']')?;
    let digits = text.strip_prefix('-').unwrap_or(text);
    let is_number = !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit());

    (is_number || text == "true" || text == "false").then(|| ((text.to_owned(), false), after))
}

// 18.4's field path read into its elements; none for one off its grammar
fn elements_of(field_path: &str) -> Option<Vec<Element>> {
    let mut elements = vec![];
    let mut rest = field_path;

    loop {
        let length = rest
            .char_indices()
            .find(|&(index, character)| {
                !(character == '_'
                    || character.is_ascii_alphabetic()
                    || (index > 0 && character.is_ascii_digit()))
            })
            .map_or(rest.len(), |(index, _)| index);

        if length == 0 {
            return None;
        }

        let (name, after) = rest.split_at_checked(length)?;

        rest = after;

        let subscript = match rest.strip_prefix('[') {
            Some(inside) => {
                let (subscript, after) = subscript_of(inside)?;

                rest = after;
                Some(subscript)
            }
            None => None,
        };

        elements.push(Element {
            name: name.to_owned(),
            subscript,
        });

        if rest.is_empty() {
            return Some(elements);
        }

        rest = rest.strip_prefix('.')?;
    }
}

/// A violation's field path, and the route its request was bound by.
#[derive(Debug, Clone, Copy)]
pub struct RoutedFieldPath<'a> {
    /// Its field path, 18.4's.
    pub field_path: &'a str,
    /// The route its request was bound by.
    pub route: &'a HttpRouteTemplate,
}

/// Where a violation's field path lies in a request bound by `route` (7.4), each field named by
/// `field`: a message form's `place_of`, by the JSON names it holds.
///
/// `field` is asked each element's proto name in turn, walking the request from its root, and
/// answers its JSON name, or none where the message it stands at holds no such field or a scalar
/// came before it. A variable's field path, or one of the query, is a `parameter` of JSON names; one
/// in the body a `pointer`, a subscript a token of it, a key cut at 64 bytes ending it; a field path
/// off 18.4's grammar the body whole where the body is the request whole, and nowhere otherwise.
pub fn place_by(
    path: &RoutedFieldPath<'_>,
    field: &mut dyn FnMut(&str) -> Option<String>,
) -> Option<RequestPlace> {
    let &RoutedFieldPath { field_path, route } = path;
    let is_whole = route.body.as_deref() == Some("*");
    let Some(elements) = elements_of(field_path) else {
        return is_whole.then(|| RequestPlace::Pointer("#".to_owned()));
    };
    let names = elements
        .iter()
        .map(|element| element.name.as_str())
        .collect::<Vec<_>>()
        .join(".");
    let is_variable = parse_template(&route.template).is_ok_and(|template| {
        template
            .variables
            .iter()
            .any(|variable| variable.field_path == names)
    });

    if is_variable {
        return Some(RequestPlace::Parameter(names));
    }

    let in_body = is_whole
        || route
            .body
            .as_deref()
            .is_some_and(|body| elements.first().is_some_and(|first| first.name == body));
    // * each element's field, by its JSON name, a oneof's name standing for the message that holds it
    let mut tokens = vec![];
    let mut json_names = vec![];

    for (index, element) in elements.iter().enumerate() {
        let Some(json_name) = field(&element.name) else {
            break;
        };

        // the body a `body` field makes has that field as its root
        if is_whole || index > 0 {
            tokens.push(pointer_token_of(&json_name));
        }

        json_names.push(json_name);

        match &element.subscript {
            Some((_, true)) => break,
            Some((text, false)) => tokens.push(pointer_token_of(text)),
            None => {}
        }
    }

    if !in_body {
        return (!json_names.is_empty()).then(|| RequestPlace::Parameter(json_names.join(".")));
    }

    let mut pointer = "#".to_owned();

    for token in tokens {
        pointer.push('/');
        pointer.push_str(&fragment_of(&token));
    }

    Some(RequestPlace::Pointer(pointer))
}

// where a violation's field lies (7.4): a rule of the message itself at the body whole where it is
// the request whole, nowhere otherwise; a field where its route's form places it
fn place_of(violation: &Violation, route: &ProblemRoute<'_>) -> Option<RequestPlace> {
    violation.field_path.as_ref().map_or_else(
        || {
            (route.route.body.as_deref() == Some("*"))
                .then(|| RequestPlace::Pointer("#".to_owned()))
        },
        |field_path| route.form.place_of(field_path, route.route),
    )
}

// `PAYLOAD_INVALID`'s members: its violations as `errors`, its closing line's `more` or `stopped`
fn invalid_members_into(
    members: &mut Map<String, Value>,
    (failure, route): (&CallFailure, Option<&ProblemRoute<'_>>),
) {
    let read = violations_of(
        &Failure::protocol(ProtocolCode::new(failure.code), RouterSide::Server)
            .saying(failure.detail.as_str()),
    );
    let errors = read
        .violations
        .iter()
        .map(|violation| {
            let mut error = Map::new();

            if let Some(bounds) = &violation.bounds {
                error.insert("bounds".to_owned(), Value::Object(bounds.clone()));
            }

            if let Some(message) = &violation.message {
                error.insert("detail".to_owned(), Value::from(message.as_str()));
            }

            if let Some(field_path) = &violation.field_path {
                error.insert("fieldPath".to_owned(), Value::from(field_path.as_str()));
            }

            if violation.for_key {
                error.insert("forKey".to_owned(), Value::Bool(true));
            }

            error.insert("ruleId".to_owned(), Value::from(violation.rule_id.as_str()));

            if let Some(place) = route.and_then(|route| place_of(violation, route)) {
                place_into(&mut error, &place);
            }

            Value::Object(error)
        })
        .collect();

    members.insert("errors".to_owned(), Value::Array(errors));

    if let Some(more) = read.more.filter(|more| *more != 0) {
        members.insert("more".to_owned(), Value::from(more));
    }

    if read.stopped {
        members.insert("stopped".to_owned(), Value::Bool(true));
    }
}

/// A problem's text, its members in section 17.7's canonical form (7.2).
#[must_use]
pub fn text_of(members: Map<String, Value>) -> String {
    json::write(&Value::Object(members))
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

/// The problem a gateway answers a call's failure with (transcoding 7).
///
/// Its status by its code and where it arose, the fields beside it — `retry-after`, a 401's `www-authenticate` — and its body,
/// `type`, `title`, `status`, `detail`, `code` and `scope`, and for `PAYLOAD_INVALID` its
/// violations as `errors`, each its `pointer` or its `parameter` where `options.route` says where
/// its request's fields came from.
#[must_use]
pub fn problem_of_failure(failure: &CallFailure, options: &ProblemOptions<'_>) -> Problem {
    let challenge = options.challenge.unwrap_or(DEFAULT_CHALLENGE);
    let code = failure.code.get();
    let mut members = Map::new();

    members.insert("code".to_owned(), Value::from(code));

    if failure.scope == FailureScope::Application {
        let identity = options
            .catalogue
            .unwrap_or_default()
            .iter()
            .find(|listed| listed.code() == code)
            .map_or_else(|| code.to_string(), |listed| listed.name().to_owned());

        if !failure.detail.is_empty() {
            members.insert("detail".to_owned(), Value::from(failure.detail.as_str()));
        }

        members.insert("scope".to_owned(), Value::from("application"));
        members.insert("status".to_owned(), Value::from(400));

        let (title, kind) = options.problem_types.map_or_else(
            || ("Bad Request".to_owned(), ABOUT_BLANK.to_owned()),
            |types| (identity.clone(), format!("{types}{identity}")),
        );

        members.insert("title".to_owned(), Value::from(title));
        members.insert("type".to_owned(), Value::from(kind));

        return Problem {
            status: 400,
            fields: vec![],
            body: text_of(members),
        };
    }

    let (status, fields) = protocol_status_of(failure, challenge);
    let protocol = ProtocolCode::new(failure.code);
    let identity = protocol
        .name()
        .map_or_else(|| code.to_string(), ToOwned::to_owned);
    let is_invalid = protocol == ProtocolCode::PAYLOAD_INVALID;
    // * the gateway's own error between it and its server: its code alone (spec 9.0)
    let is_code_alone = is_invalid || protocol == ProtocolCode::DESTINATION_UNREACHABLE;

    if !failure.detail.is_empty() && !is_code_alone {
        members.insert("detail".to_owned(), Value::from(failure.detail.as_str()));
    }

    if is_invalid {
        invalid_members_into(&mut members, (failure, options.route.as_ref()));
    }

    if failure.arose == Arose::Gateway
        && let Some(place) = &failure.place
    {
        place_into(&mut members, place);
    }

    members.insert("scope".to_owned(), Value::from("protocol"));
    members.insert("status".to_owned(), Value::from(status));
    members.insert("title".to_owned(), Value::from(identity.as_str()));
    members.insert(
        "type".to_owned(),
        Value::from(format!("{PROTOCOL_TYPES}{identity}")),
    );

    Problem {
        status,
        fields,
        body: text_of(members),
    }
}

/// The status of a failure of the gateway's own (7.6).
#[must_use]
pub const fn own_status_of(own: OwnFailure) -> u16 {
    match own {
        OwnFailure::Closed => 502,
        OwnFailure::Failed | OwnFailure::Unwritable => 500,
        OwnFailure::Jwt => 431,
        OwnFailure::Scheme => 401,
        OwnFailure::Timeout => 504,
    }
}

/// The problem of a failure of the gateway's own (7.6).
///
/// Its call's timeout, 504; its connection
/// closed, 502; a result it cannot write, 500; a `JWT` its block cannot hold, 431; an auth-scheme
/// but `Bearer` under `BearerJwt`, 401; what no gate foresaw, 500 — `about:blank`, its detail its
/// words, none for what no gate foresaw.
#[must_use]
pub fn problem_of_own(own: OwnFailure, detail: &str, options: &OwnProblemOptions) -> Problem {
    let mut problem = problem_of_refusal(own_status_of(own), detail);

    if own == OwnFailure::Scheme {
        let challenge = options.challenge.as_deref().unwrap_or(DEFAULT_CHALLENGE);

        problem.fields.push(ProblemField {
            name: "www-authenticate",
            value: challenge_of(challenge, "invalid_request"),
        });
    }

    problem
}

/// The problem of a refusal of the gateway's own (7.7), `about:blank`, its title its status's
/// phrase, its detail its words.
#[must_use]
pub fn problem_of_refusal(status: u16, detail: &str) -> Problem {
    let mut members = Map::new();

    if !detail.is_empty() {
        members.insert("detail".to_owned(), Value::from(detail));
    }

    members.insert("status".to_owned(), Value::from(status));
    members.insert(
        "title".to_owned(),
        Value::from(phrase_of(status).map_or_else(|| status.to_string(), ToOwned::to_owned)),
    );
    members.insert("type".to_owned(), Value::from(ABOUT_BLANK));

    Problem {
        status,
        fields: vec![],
        body: text_of(members),
    }
}
