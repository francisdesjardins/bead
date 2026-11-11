//! What an HTTP transport server reads of a request's fields and writes of its own (spec 15.6,
//! 15.9, 15.12), as the other sides' `http-server-fields.ts` and `HttpTransportServer.ServerFields`
//! read and write them: a field by its first line or all of them, a count and a listen as RFC
//! 9651's Items, a body's length and coding, a request's authority and target, a preflight's
//! answer, and the end of an exchange the transport writes itself.

use ::http::header::HeaderMap;
use ::http::uri::Uri;

use crate::judgement::hosts::{
    Authority, HOST_REFUSAL, HostRequest, ORIGIN_REFUSAL, RequestTarget, authority_of,
    is_authority, request_target_of,
};
use crate::judgement::items::{BareItem, parse_item};

#[cfg(test)]
mod tests;

/// The media type of one envelope, a `POST`'s body and an answer's (spec 15.6).
pub(crate) const BEAD_MEDIA_TYPE: &str = "application/prs.bead";

/// The media type of what a listen brings back, each envelope after its length (spec 15.9).
pub(crate) const BEAD_BATCH_MEDIA_TYPE: &str = "application/prs.bead-batch";

/// The field a listen acknowledges by, the number of the last envelope its client heard whole.
pub(crate) const AFTER_HEADER: &str = "bead-after";

/// The field a listen says how long it waits in, in milliseconds.
pub(crate) const WAIT_HEADER: &str = "bead-wait";

/// The field a batch numbers its first envelope in.
pub(crate) const SEQUENCE_HEADER: &str = "bead-sequence";

/// The field a connection's token goes in, each exchange after its connect presenting it.
pub(crate) const CONNECTION_TOKEN_HEADER: &str = "bead-connection-token";

/// The field a connect says its client listens in, and the 201 says back (spec 15.9).
pub(crate) const LISTEN_HEADER: &str = "bead-listen";

/// The field a refusal of the transport's own is marked in (spec 15.6).
pub(crate) const REFUSAL_HEADER: &str = "bead-refusal";

/// What the transport reads of an envelope, and nothing else (decision 0020), in the prefix 0001
/// lays out and every layout from 0xA1 to 0xAF keeps: the layout in its first byte, the kind in its
/// second, the call id in its fifth to eighth.
pub(crate) const ENVELOPE_PREFIX_BYTES: usize = 8;

/// The first layout of the prefix the transport reads.
pub(crate) const FIRST_LAYOUT: u8 = 0xA1;

/// The last layout of the prefix the transport reads.
pub(crate) const LAST_LAYOUT: u8 = 0xAF;

/// The kinds the transport tells apart: a request waits for its answer; a cancel ends one.
pub(crate) const REQUEST: u8 = 0x10;
/// An answer's kind: a result.
pub(crate) const RESULT: u8 = 0x11;
/// An answer's kind: a failure.
pub(crate) const FAILURE: u8 = 0x12;
/// A cancel's kind.
pub(crate) const CANCEL: u8 = 0x16;

/// The refusals of an HTTP transport server's own, each its `bead-refusal` (spec 15.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct HttpRefusals {
    /// A connect once its stop began, or past its bounds, 503; an exchange past what its connection
    /// has under way, or its requests waiting, 429; a body past the bytes every exchange holds, 503.
    pub busy: &'static str,
    /// A request on a call id already waiting: 409.
    pub call_waiting: &'static str,
    /// An exchange on a connection gone, or unknown: 404.
    pub connection_unknown: &'static str,
    /// A host the server does not take: 403.
    pub host: &'static str,
    /// A listen on a connection whose client did not say it listens: 409.
    pub listen_undeclared: &'static str,
    /// An exchange the transport cannot read: 400.
    pub malformed: &'static str,
    /// A method but `GET`, `POST` and `DELETE`: 405.
    pub method: &'static str,
    /// An `Origin` neither the server's own nor among those it takes: 403.
    pub origin: &'static str,
    /// A path but the transport's: 404.
    pub path: &'static str,
    /// A body past its bound: 413.
    pub too_large: &'static str,
    /// A body slower than its rate once its grace passed: 408.
    pub too_slow: &'static str,
    /// A body of another media type, or encoded: 415.
    pub type_refused: &'static str,
}

/// The refusals of an HTTP transport server's own, each its `bead-refusal` (spec 15.6).
pub const HTTP_REFUSALS: HttpRefusals = HttpRefusals {
    busy: "busy",
    call_waiting: "call-waiting",
    connection_unknown: "connection-unknown",
    host: HOST_REFUSAL,
    listen_undeclared: "listen-undeclared",
    malformed: "malformed",
    method: "method-refused",
    origin: ORIGIN_REFUSAL,
    path: "path-unknown",
    too_large: "too-large",
    too_slow: "too-slow",
    type_refused: "type-refused",
};

/// What every response on the path carries: never stored, never sniffed, and which one a request
/// gets turns on its `Origin`; HTTP's own 400 carries none of these.
pub(crate) const RESPONSE_FIELDS: [(&str, &str); 3] = [
    ("cache-control", "no-store"),
    ("vary", "Origin"),
    ("x-content-type-options", "nosniff"),
];

// the methods the transport's path takes, which its preflight's answer names (spec 15.12)
const TRANSPORT_METHODS: &str = "GET, POST, DELETE";

// how long a browser keeps a preflight's answer, in seconds: what every one of them carries
const PREFLIGHT_MAX_AGE: &str = "7200";

/// How an exchange ends, when the transport ends it: its status, its reason, its fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct End {
    pub(crate) status: u16,
    /// The reason a refusal of the transport's own is marked with; none for a 201 or a 204.
    pub(crate) reason: Option<&'static str>,
    pub(crate) fields: Vec<(&'static str, String)>,
}

impl End {
    /// An end of `status`, unmarked, with no field of its own.
    pub(crate) const fn of(status: u16) -> Self {
        Self {
            status,
            reason: None,
            fields: Vec::new(),
        }
    }

    /// A refusal of `status`, marked `reason`.
    pub(crate) const fn refused(status: u16, reason: &'static str) -> Self {
        Self {
            status,
            reason: Some(reason),
            fields: Vec::new(),
        }
    }

    /// Itself, carrying the field `name` besides.
    pub(crate) fn with(mut self, (name, value): (&'static str, String)) -> Self {
        self.fields.push((name, value));
        self
    }
}

/// The 404 that tells a client its connection is gone.
pub(crate) const fn unknown_connection() -> End {
    End::refused(404, HTTP_REFUSALS.connection_unknown)
}

/// Busy, told when to come back, which Bead's client waits for before it sends a non-request
/// again (spec 15.6).
pub(crate) fn busy(status: u16) -> End {
    End::refused(status, HTTP_REFUSALS.busy).with(("retry-after", "1".to_owned()))
}

/// What a request carries, as the transport reads it: its version, its method, its target and its
/// fields, each line as it came.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Request<'a> {
    pub(crate) is_http1: bool,
    pub(crate) is_http11: bool,
    pub(crate) method: &'a ::http::Method,
    pub(crate) uri: &'a Uri,
    pub(crate) headers: &'a HeaderMap,
}

impl Request<'_> {
    /// The value of the first line of the field `name`, when it carries one; none for one that is
    /// not visible ASCII, which the transport refused before.
    pub(crate) fn header_of(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    /// The values of every line of the field `name`, as they came, in their order.
    pub(crate) fn lines_of(&self, name: &str) -> Vec<&str> {
        self.headers
            .get_all(name)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect()
    }

    /// Its fields, each name then its value, as `has_visible_fields` reads them; none when a value
    /// holds an octet that is not visible ASCII, SP or HTAB.
    pub(crate) fn raw_fields(&self) -> Option<Vec<&str>> {
        let mut raw = Vec::new();

        for (name, value) in self.headers {
            raw.push(name.as_str());
            raw.push(value.to_str().ok()?);
        }

        Some(raw)
    }

    /// Its target as hyper keeps it, its `#` and what follows cut, its scheme in lower case: over
    /// HTTP/1, an absolute-form's scheme, `://` and authority, then its path and query; `*` as it
    /// came. Over HTTP/2, its `:path` alone, its authority `:authority`'s.
    pub(crate) fn target(&self) -> String {
        // ! hyper's Uri drops a # and what follows before this runs: a target that holds one is
        // served cut here, where spec 15.12 refuses it, the row "A # in a target" of
        // docs/support.md
        let path = self
            .uri
            .path_and_query()
            .map_or_else(|| self.uri.path().to_owned(), ToString::to_string);

        match (self.uri.scheme_str(), self.uri.authority()) {
            (Some(scheme), Some(authority)) if self.is_http1 => {
                format!("{scheme}://{}{path}", authority.as_str())
            }
            _ => path,
        }
    }

    /// Whether it says it has a body: a length above 0, as RFC 9110 §8.6 reads its digits, or a
    /// transfer coding.
    pub(crate) fn has_body(&self) -> bool {
        self.header_of("content-length")
            .is_some_and(|length| length.trim().parse::<u64>().map_or(true, |count| count > 0))
            || self.headers.contains_key("transfer-encoding")
    }

    /// The length its `Content-Length` declares, when it declares one.
    pub(crate) fn declared_length(&self) -> Option<u64> {
        self.header_of("content-length")
            .and_then(|length| length.trim().parse::<u64>().ok())
    }

    /// Whether its body is of Bead's media type, parameters aside, sent as it is.
    pub(crate) fn is_bead_body(&self) -> bool {
        let media_type = self
            .header_of("content-type")
            .map(|value| {
                value
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase()
            })
            .unwrap_or_default();
        let encoding = self
            .header_of("content-encoding")
            .map(|value| value.trim().to_ascii_lowercase());

        media_type == BEAD_MEDIA_TYPE
            && encoding
                .as_deref()
                .is_none_or(|coding| coding == "identity")
    }

    /// Its authority (spec 15.12): over HTTP/1, as `authority_of` reads its `Host` and `target`;
    /// over HTTP/2, its `:authority`, a `host` beside it ignored, or its `host` where it has none
    /// (RFC 9113 §8.3.1), of spec 15.12's grammar. None for what HTTP refuses of its own, over HTTP/2
    /// a request that names no authority among it.
    pub(crate) fn authority<'t>(&'t self, target: &'t str) -> Option<Authority<'t>> {
        if !self.is_http1 {
            return self
                .uri
                .authority()
                .map(::http::uri::Authority::as_str)
                .or_else(|| self.header_of("host"))
                .filter(|authority| is_authority(authority))
                .map(|authority| Authority {
                    authority: Some(authority),
                });
        }

        authority_of(
            &self.lines_of("host"),
            &HostRequest::new(self.is_http11, request_target_of(Some(target))),
        )
    }

    /// A field read as an Item of RFC 9651, its lines joined by `, ` first (§4.2, RFC 9110 §5.3):
    /// its bare item, its parameters ignored (§2.3); `Absent` when it carries none, `Unread` when it
    /// does not parse.
    fn bare_item_of(&self, name: &str) -> Field {
        let lines = self.lines_of(name);

        if lines.is_empty() {
            return Field::Absent;
        }

        parse_item(&lines.join(", ")).map_or(Field::Unread, |item| Field::Read(item.bare_item))
    }

    /// A count a listen gives (spec 15.9): an Integer of 0 or more, anything else none; left out, 0,
    /// or none where it `is_required`.
    pub(crate) fn count_of(&self, (name, is_required): (&str, bool)) -> Option<u64> {
        match self.bare_item_of(name) {
            Field::Absent => (!is_required).then_some(0),
            Field::Read(BareItem::Integer(value)) => u64::try_from(value).ok(),
            Field::Read(_) | Field::Unread => None,
        }
    }

    /// Whether a connect says its client listens: a Boolean, absent being false; anything else is
    /// none.
    pub(crate) fn listening(&self) -> Option<bool> {
        match self.bare_item_of(LISTEN_HEADER) {
            Field::Absent => Some(false),
            Field::Read(BareItem::Boolean(value)) => Some(value),
            Field::Read(_) | Field::Unread => None,
        }
    }

    /// A preflight's answer (spec 15.12): the methods its path takes; `authorization`, which no
    /// wildcard covers (Fetch §4.8); the names asked, for a browser that caches names and no
    /// wildcard; then `*`. No `Vary`: no cache stores an answer to `OPTIONS` (RFC 9110 §9.3.7).
    pub(crate) fn preflight(&self) -> End {
        let asked = self.lines_of("access-control-request-headers").join(", ");
        let mut allowed = vec!["authorization"];

        if !asked.is_empty() {
            allowed.push(&asked);
        }

        allowed.push("*");

        End::of(204)
            .with(("access-control-allow-headers", allowed.join(", ")))
            .with(("access-control-allow-methods", TRANSPORT_METHODS.to_owned()))
            .with(("access-control-max-age", PREFLIGHT_MAX_AGE.to_owned()))
    }
}

// a field, as an Item reads it
enum Field {
    Absent,
    Unread,
    Read(BareItem),
}

/// The path a target names, an absolute-form one's among them, its query read by no exchange;
/// none for a target HTTP refuses.
pub(crate) fn path_of(target: &str) -> Option<&str> {
    request_target_of(Some(target)).map(|RequestTarget { path, .. }| path)
}
