//! What a server answers a request at its WebSocket's address that it does not upgrade, judged in
//! the order of spec 15.2, as the other sides' `websocket-handshake.ts` and `WebSocketHandshake.cs`
//! judge it.
//!
//! Each refusal but HTTP's own is marked, never stored nor sniffed, its body empty, and closes its
//! connection; a 426 names `websocket` in its `Upgrade`, and `upgrade` in its `Connection`.

use crate::judgement::hosts::{
    Authority, HOST_REFUSAL, HostRequest, ORIGIN_REFUSAL, TakenOrigins, authority_of,
    has_visible_fields, is_taken_host, is_taken_origin, is_visible_target, origin_of,
    own_authority_of, request_target_of,
};

#[cfg(test)]
mod tests;

/// The refusals of a WebSocket server's own, each its `bead-refusal` (spec 15.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct WebSocketRefusals {
    /// An upgrade the server would take once its stop began, or past its bounds: 503.
    pub busy: &'static str,
    /// A host the server does not take: 403.
    pub host: &'static str,
    /// A handshake the server cannot take: 400.
    pub malformed: &'static str,
    /// A method but `GET` or `HEAD`: 405.
    pub method: &'static str,
    /// An `Origin` neither the server's own nor among those it takes: 403.
    pub origin: &'static str,
    /// A request that asks no WebSocket: 426.
    pub upgrade: &'static str,
    /// A `Sec-WebSocket-Version` but 13, or none: 426.
    pub version: &'static str,
}

/// The refusals of a WebSocket server's own, each its `bead-refusal` (spec 15.6).
pub const WEBSOCKET_REFUSALS: WebSocketRefusals = WebSocketRefusals {
    busy: "busy",
    host: HOST_REFUSAL,
    malformed: "malformed",
    method: "method-refused",
    origin: ORIGIN_REFUSAL,
    upgrade: "upgrade-required",
    version: "version-refused",
};

/// A field of an answer the server writes: its name, and its value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct AnswerField {
    /// Its name, in lower case.
    pub name: &'static str,
    /// Its value.
    pub value: &'static str,
}

/// What a server answers a request it does not upgrade.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct HandshakeRefusal {
    /// Every field of the answer but its `date`, in the order they are written.
    pub fields: Vec<AnswerField>,
    /// Its `bead-refusal`; none for what HTTP refuses of its own.
    pub refusal: Option<&'static str>,
    /// Its status.
    pub status: u16,
}

/// The part of a request at a WebSocket's address the judgement reads: each field as it came.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct HandshakeRequest<'a> {
    /// Its version: `1.1`, `1.0`…
    pub http_version: &'a str,
    /// Its method.
    pub method: Option<&'a str>,
    /// Its fields as they came, each name before its value: what counts a field given twice.
    pub raw_fields: &'a [&'a str],
    /// Its target, which names its authority when it is in absolute-form; `/` when none.
    pub target: Option<&'a str>,
}

impl<'a> HandshakeRequest<'a> {
    /// A request of `http_version` and its fields, of no method and no target yet.
    #[must_use]
    pub const fn new(http_version: &'a str, raw_fields: &'a [&'a str]) -> Self {
        Self {
            http_version,
            method: None,
            raw_fields,
            target: None,
        }
    }
}

/// What a WebSocket server takes a request from: its hosts, and the origins it takes besides its
/// own.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct HandshakeTaken<'a> {
    /// The hosts it takes beside those every server takes; `*` takes any (spec 15.12).
    pub hosts: &'a [String],
    /// The origins it takes beside its own.
    pub origins: &'a [String],
}

impl<'a> HandshakeTaken<'a> {
    /// What a server of `hosts` and `origins` takes.
    #[must_use]
    pub const fn new(hosts: &'a [String], origins: &'a [String]) -> Self {
        Self { hosts, origins }
    }
}

/// What a refusal at a WebSocket's address tells of its request (spec 15.1), as the judgement read
/// it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct HandshakeTold {
    /// Its authority, its port included: none when it names none, or HTTP refuses it.
    pub authority: Option<String>,
    /// Its `Origin`, its lines joined by `, `: none when it sends none.
    pub origin: Option<String>,
}

// the one version the server speaks (RFC 6455 §4.2.2)
const VERSION: &str = "13";

fn field(name: &'static str, value: &'static str) -> AnswerField {
    AnswerField { name, value }
}

// a refusal of the transport's own, marked, never stored nor sniffed, its body empty, its
// connection closed
fn refused(status: u16, (refusal, fields): (&'static str, &[AnswerField])) -> HandshakeRefusal {
    let upgrades = fields.iter().any(|field| field.name == "upgrade");
    let mut written = vec![
        field("bead-refusal", refusal),
        field("cache-control", "no-store"),
        field("x-content-type-options", "nosniff"),
    ];

    written.extend_from_slice(fields);
    written.push(field("content-length", "0"));
    written.push(field(
        "connection",
        if upgrades { "upgrade, close" } else { "close" },
    ));

    HandshakeRefusal {
        fields: written,
        refusal: Some(refusal),
        status,
    }
}

/// A handshake the server cannot take, refused 400 `malformed`.
#[must_use]
pub fn malformed_handshake() -> HandshakeRefusal {
    refused(400, (WEBSOCKET_REFUSALS.malformed, &[]))
}

/// An upgrade the server would take once its stop began, refused 503 `busy`, told when to come
/// back (RFC 9110 §15.6.4, §10.2.3; spec 15.2.8).
#[must_use]
pub fn busy_handshake() -> HandshakeRefusal {
    refused(503, (WEBSOCKET_REFUSALS.busy, &[field("retry-after", "1")]))
}

/// What HTTP refuses of its own (RFC 9112 §3.2, §3.2.2; RFC 9110 §5.5), unmarked.
#[must_use]
pub fn host_malformed() -> HandshakeRefusal {
    HandshakeRefusal {
        fields: vec![field("content-length", "0"), field("connection", "close")],
        refusal: None,
        status: 400,
    }
}

// a field's value without the spaces and tabs around it (RFC 9110 §5.5)
fn trimmed(value: &str) -> &str {
    value.trim_matches(|character| character == ' ' || character == '\t')
}

// the values of each line of the field `name`, as they came but for the whitespace around them,
// counted where each stands
fn lines_of<'a>(request: &HandshakeRequest<'a>, name: &str) -> Vec<&'a str> {
    request
        .raw_fields
        .as_chunks::<2>()
        .0
        .iter()
        .filter(|[field, _]| field.eq_ignore_ascii_case(name))
        .map(|[_, value]| trimmed(value))
        .collect()
}

// the elements of a list across its lines (RFC 9110 §5.6.1), the empty ones kept
fn elements_of<'a>(lines: &[&'a str]) -> Vec<&'a str> {
    lines
        .iter()
        .flat_map(|line| line.split(',').map(trimmed))
        .collect()
}

// whether a list holds `token` in any ASCII case
fn has_token(lines: &[&str], token: &str) -> bool {
    elements_of(lines)
        .iter()
        .any(|element| element.to_ascii_lowercase() == token)
}

// a `token` (RFC 9110 §5.6.2)
fn is_token(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}

// 16 bytes in base64 (RFC 6455 §4.2.1 item 5)
fn is_key(text: &str) -> bool {
    text.len() == 24
        && text.strip_suffix("==").is_some_and(|key| {
            key.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
        })
}

// whether a list of subprotocols is of distinct tokens (RFC 6455 §4.1 item 10), none empty
fn is_protocol_list(lines: &[&str]) -> bool {
    let elements = elements_of(lines);

    elements.iter().all(|element| is_token(element))
        && elements
            .iter()
            .enumerate()
            .all(|(index, element)| !elements.iter().take(index).any(|other| other == element))
}

// a version 13 upgrade's form beside its version: one key, its subprotocols, an `Authorization`
// at most, which is no list to combine (RFC 9110 §5.3), and no content
fn is_well_formed(request: &HandshakeRequest<'_>) -> bool {
    let protocols = lines_of(request, "sec-websocket-protocol");

    matches!(lines_of(request, "sec-websocket-key").as_slice(), [key] if is_key(key))
        && (protocols.is_empty() || is_protocol_list(&protocols))
        && lines_of(request, "authorization").len() <= 1
        && lines_of(request, "content-length")
            .iter()
            .all(|length| !length.is_empty() && length.bytes().all(|byte| byte == b'0'))
        && lines_of(request, "transfer-encoding").is_empty()
}

// a request's authority (spec 15.12), as the judgement reads it; none for what HTTP refuses
fn authority_named_by<'a>(request: &HandshakeRequest<'a>) -> Option<Authority<'a>> {
    authority_of(
        &lines_of(request, "host"),
        &HostRequest::new(
            request.http_version == "1.1",
            request_target_of(request.target),
        ),
    )
}

/// What a refusal at a WebSocket's address tells of its request (spec 15.1), as the judgement read
/// it.
///
/// Its authority, its port included, and its `Origin`, its lines joined by `, `; each none when it
/// names none.
#[must_use]
pub fn told_of_handshake(request: &HandshakeRequest<'_>) -> HandshakeTold {
    HandshakeTold {
        authority: authority_named_by(request)
            .and_then(|named| named.authority)
            .map(str::to_owned),
        origin: origin_of(&lines_of(request, "origin")),
    }
}

/// What a server answers a request at its WebSocket's address that it does not upgrade, judged in
/// the order of spec 15.2, the first that applies answering; none for an upgrade it takes.
///
/// 1. what HTTP refuses of its own, a field value holding a control character but a tab or an
///    octet past ASCII (RFC 9110 §5.5), a target refused by spec 15.12's rule, a `Host` missing,
///    repeated or no host, or a target in absolute-form that names none or another scheme (RFC
///    9112 §3.2, §3.2.2), 400 unmarked;
/// 2. a request whose authority — its absolute-form target's, else its `Host` — names a host it
///    does not take (spec 15.12), or none, whatever else the request holds, 403 `host-refused`;
/// 3. a method but `GET` or `HEAD`, 405 `method-refused`, its `Allow` naming both;
/// 4. a request that asks no WebSocket — a `HEAD`, an `HTTP/1.0` request, an `Upgrade` listing no
///    `websocket` or a `Connection` listing no `upgrade`, in any ASCII case — 426
///    `upgrade-required`;
/// 5. a `Sec-WebSocket-Version` in two lines, 400 `malformed`; any but 13, or none, 426
///    `version-refused`, naming 13;
/// 6. a key not one line of 16 bytes in base64, subprotocols no list of distinct tokens, more than
///    one `Authorization` line, which is no list to combine (RFC 9110 §5.3), or content, 400
///    `malformed`;
/// 7. an `Origin` neither the server's own, by the request's authority, nor among the origins it
///    takes, 403 `origin-refused`.
#[must_use]
pub fn refusal_of_handshake(
    request: &HandshakeRequest<'_>,
    taken: &HandshakeTaken<'_>,
) -> Option<HandshakeRefusal> {
    // * before anything else: what HTTP refuses of its own
    if !has_visible_fields(request.raw_fields) || !is_visible_target(request.target) {
        return Some(host_malformed());
    }

    let Some(Authority { authority, .. }) = authority_named_by(request) else {
        return Some(host_malformed());
    };

    if !is_taken_host(authority, taken.hosts) {
        return Some(refused(403, (WEBSOCKET_REFUSALS.host, &[])));
    }

    let method = request.method.unwrap_or_default();

    if method != "GET" && method != "HEAD" {
        return Some(refused(
            405,
            (WEBSOCKET_REFUSALS.method, &[field("allow", "GET, HEAD")]),
        ));
    }

    // ! a `HEAD` cannot switch, and an `HTTP/1.0` request's `Upgrade` is ignored (RFC 9110 §7.8)
    if method == "HEAD"
        || request.http_version != "1.1"
        || !has_token(&lines_of(request, "upgrade"), "websocket")
        || !has_token(&lines_of(request, "connection"), "upgrade")
    {
        return Some(refused(
            426,
            (WEBSOCKET_REFUSALS.upgrade, &[field("upgrade", "websocket")]),
        ));
    }

    match lines_of(request, "sec-websocket-version").as_slice() {
        [VERSION] => {}
        [_, _, ..] => return Some(malformed_handshake()),
        [] | [_] => {
            return Some(refused(
                426,
                (
                    WEBSOCKET_REFUSALS.version,
                    &[
                        field("upgrade", "websocket"),
                        field("sec-websocket-version", VERSION),
                    ],
                ),
            ));
        }
    }

    if !is_well_formed(request) {
        return Some(malformed_handshake());
    }

    let own = own_authority_of(authority, taken.hosts);
    let origin = origin_of(&lines_of(request, "origin"));

    if !is_taken_origin(origin.as_deref(), &TakenOrigins::new(own, taken.origins)) {
        return Some(refused(403, (WEBSOCKET_REFUSALS.origin, &[])));
    }

    None
}
