//! A gateway's caller (spec/transcoding.md 12, decision 0037), as the other sides' `createHTTPCaller`
//! and `HttpCaller` call it: a procedure called on its default route, its request written and its
//! result read by Bead's JSON mapping or its native encoding, a problem read as the failure it
//! stands for, and a stream read as its result, then its notifications, then the failure that ends
//! it. Over the HTTP transport client's own connector (decision 0049): its addresses raced (RFC
//! 8305), its TLS the platform's verifier's; no redirect followed, no cookie kept.

use core::fmt;
use core::num::NonZeroU16;
use core::pin::Pin;
use core::task::{Context, Poll};
use std::error::Error;
use std::sync::Arc;

use ::http::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use ::http::response::Parts;
use ::http::{HeaderMap, HeaderValue, Method, Request, Uri};
use bytes::Bytes;
use hyper::body::Incoming;
use hyper_util::client::legacy::Client;
use rustls::ClientConfig;
use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::clock::{HyperTimer, SharedClock, SystemClock};
use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::envelope::MAXIMUM_ENVELOPE_BYTES;
use crate::errors::{CallError, ProgrammerError};
use crate::failure::Failure;
use crate::http::client::{Connector, POOL_IDLE_TIMEOUT, Sending, chunk_of};
use crate::http::fields::REFUSAL_HEADER;
use crate::http::server::MAXIMUM_BODY_BYTES;
use crate::http::wire::Spawner;
use crate::json::{self, integer_of};
use crate::judgement::security::is_secure;
use crate::net::bounds::hold_count;
use crate::net::listening::unless_cancelled;
use crate::net::racing::RacingOptions;
use crate::payloads::{PayloadCodec, decoded, encoded, refusal_saying};
use crate::platform::{self, Handle};
use crate::router::types::BoxFuture;
use crate::service::{Descriptor, NotifyingDescriptor};
use crate::transcoding::events::{EVENT_STREAM_MEDIA_TYPE, bytes_of_base64};
use crate::transcoding::problems::PROBLEM_MEDIA_TYPE;
use crate::transcoding::routes::{HttpMethod, HttpPayload, HttpRoute};
use crate::transport::is_field_value;

#[cfg(test)]
mod tests;

const URL_REFUSED: &str =
    "an HTTP client URL uses HTTP or HTTPS without user information, query or fragment";
const DEFAULT_ROUTE: &str =
    "an HTTP client calls a default POST route with a whole body and result";
const OTHER_ORIGIN: &str = "an HTTP route stays on its gateway origin";
const NO_FIELD_VALUE: &str =
    "a credential holds visible ASCII, spaces and tabs alone, none first or last";
const UNDECODABLE: &str = "the HTTP payload cannot be decoded";
const ENDED: &str = "the HTTP body ends before its answer";

// ── Its options ──────────────────────────────────────────────────────────────────────────────

/// What a gateway's caller presents and reads by: its default authorization, its bound, its TLS
/// and its runtime.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct HttpCallerOptions {
    /// The `authorization` field every call presents, unless it gives its own or omits it: none
    /// when none.
    pub authorization: Option<String>,
    /// The bytes a result's body, a problem's or one event of a stream holds at most, past which
    /// its call fails `PAYLOAD_TOO_LARGE`: a gateway's own bound, 16,778,240, when none.
    pub maximum_body_bytes: Option<u64>,
    /// The TLS an `https` gateway is called over, a copy of which offers HTTP/1.1 alone by ALPN:
    /// rustls's over aws-lc-rs, the platform's verifier judging its gateway, when none.
    pub tls: Option<Arc<ClientConfig>>,
    /// The tokio runtime its calls run on, its time and IO drivers enabled: the current one when
    /// none.
    pub runtime: Option<Handle>,
}

/// What one call presents, and what gives it up.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct HttpCallOptions {
    /// The `authorization` field this call presents in place of its caller's: its caller's when
    /// none; an empty one presents none.
    pub authorization: Option<String>,
    /// Whether this call presents no `authorization`, whatever it or its caller gives: `false` when
    /// none.
    pub without_authorization: Option<bool>,
    /// What gives the call up, or its stream: its exchange dropped, and its call ended
    /// [`CallError::Cancelled`].
    pub signal: Option<CancellationToken>,
}

/// One event of a stream: its result, first, then each notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpEvent<R, N> {
    /// The stream's result, its first event.
    Result(R),
    /// A notification, each event after its result.
    Notification(N),
}

// ── The caller ───────────────────────────────────────────────────────────────────────────────

// what a caller's requesters and subscribers share: its connections, its gateway and its bounds
struct Calling {
    runtime: Handle,
    client: Client<Connector, Sending>,
    scheme: String,
    authority: String,
    path: String,
    authorization: Option<String>,
    maximum_body_bytes: u64,
}

/// A gateway's caller, which a generated `<Service>HttpClient` calls its default routes through.
///
/// It refuses a URL of another scheme than HTTP's or HTTPS's, or with user information, a query or
/// a fragment; its path is a prefix each default route is resolved under (transcoding 12.2). Its
/// credential goes over TLS or to the loopback alone (12.3); it follows no redirect and keeps no
/// cookie.
#[derive(Clone)]
pub struct HttpCaller {
    calling: Arc<Calling>,
}

impl fmt::Debug for HttpCaller {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpCaller")
            .field("scheme", &self.calling.scheme)
            .field("authority", &self.calling.authority)
            .field("path", &self.calling.path)
            .finish_non_exhaustive()
    }
}

// a URL's scheme, authority and path, as a base: its path ending in `/`
fn base_of(url: &str) -> Option<(String, String, String)> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();

    if (scheme != "http" && scheme != "https") || rest.contains(['?', '#']) {
        return None;
    }

    let (authority, path) = rest.find('/').map_or((rest, "/"), |at| rest.split_at(at));

    if authority.is_empty() || authority.contains('@') {
        return None;
    }

    // ! the whole URL as http reads it: a host it holds, its characters a URI's
    let uri = Uri::try_from(format!("{scheme}://{authority}{path}")).ok()?;

    uri.host()?;

    let path = if path.ends_with('/') {
        path.to_owned()
    } else {
        format!("{path}/")
    };

    Some((scheme, authority.to_ascii_lowercase(), path))
}

// a path's dot segments removed (RFC 3986 §5.2.4)
fn without_dot_segments(path: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let segments: Vec<&str> = path.split('/').collect();
    let last = segments.len().saturating_sub(1);

    for (at, segment) in segments.iter().enumerate() {
        match *segment {
            "." => {
                if at == last {
                    kept.push("");
                }
            }
            ".." => {
                if kept.len() > 1 {
                    kept.pop();
                }
                if at == last {
                    kept.push("");
                }
            }
            other => kept.push(other),
        }
    }

    let joined = kept.join("/");

    if joined.starts_with('/') {
        joined
    } else {
        format!("/{joined}")
    }
}

// whether a reference begins with a scheme (RFC 3986 §3.1), which makes it a URI of its own
fn has_scheme(reference: &str) -> bool {
    let Some((scheme, _rest)) = reference.split_once(':') else {
        return false;
    };
    let mut letters = scheme.chars();

    !scheme.contains('/')
        && letters
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic())
        && letters.all(|letter| letter.is_ascii_alphanumeric() || "+-.".contains(letter))
}

impl Calling {
    // a default route's template resolved against the caller's base (RFC 3986 §5.2), its leading
    // `/` taken away so that the base's path stays its prefix; none off its origin
    fn target_of(&self, template: &str) -> Result<Uri, ProgrammerError> {
        let reference = template.strip_prefix('/').unwrap_or(template);
        let (authority, path) = if has_scheme(reference) {
            let (scheme, rest) = reference.split_once(':').unwrap_or_default();
            let rest = rest.strip_prefix("//").unwrap_or_default();
            let (authority, path) = rest.find('/').map_or((rest, "/"), |at| rest.split_at(at));

            if !scheme.eq_ignore_ascii_case(&self.scheme) {
                return Err(ProgrammerError::new(OTHER_ORIGIN));
            }

            (authority.to_ascii_lowercase(), without_dot_segments(path))
        } else if let Some(rest) = reference.strip_prefix("//") {
            let (authority, path) = rest.find('/').map_or((rest, "/"), |at| rest.split_at(at));

            (authority.to_ascii_lowercase(), without_dot_segments(path))
        } else if reference.starts_with('/') {
            (self.authority.clone(), without_dot_segments(reference))
        } else {
            (
                self.authority.clone(),
                without_dot_segments(&format!("{}{reference}", self.path)),
            )
        };

        if authority != self.authority {
            return Err(ProgrammerError::new(OTHER_ORIGIN));
        }

        Uri::try_from(format!("{}://{authority}{path}", self.scheme))
            .map_err(|_unwritable| ProgrammerError::new(DEFAULT_ROUTE))
    }

    // `route` held to a default route, its target resolved
    fn bound(self: &Arc<Self>, route: &HttpRoute) -> Result<Bound, ProgrammerError> {
        let template = route
            .routes()
            .first()
            .filter(|template| {
                template.method == HttpMethod::Post
                    && template.body.as_deref() == Some("*")
                    && template.response_body.is_none()
                    && !template.template.contains('{')
            })
            .ok_or_else(|| ProgrammerError::new(DEFAULT_ROUTE))?;
        let target = self.target_of(&template.template)?;
        let is_secured = target.scheme_str() == Some("https");

        Ok(Bound {
            is_secure: is_secure(is_secured, target.host()),
            calling: Arc::clone(self),
            route: route.clone(),
            target,
        })
    }
}

impl HttpCaller {
    /// A caller of the gateway at `url`, its options held.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a URL of another scheme than HTTP's or HTTPS's, or with user
    /// information, a query or a fragment; for a bound of 0; outside a tokio runtime, given none, or
    /// on one without its time or its IO driver.
    pub fn new(url: &str, options: &HttpCallerOptions) -> Result<Self, ProgrammerError> {
        let (scheme, authority, path) =
            base_of(url).ok_or_else(|| ProgrammerError::new(URL_REFUSED))?;
        let maximum_body_bytes = hold_count(
            "maximumBodyBytes",
            options.maximum_body_bytes.unwrap_or(MAXIMUM_BODY_BYTES),
        )?;
        let runtime = platform::socket_runtime_of(options.runtime.as_ref(), "an HTTP caller")?;
        let clock: SharedClock = Arc::new(SystemClock::on(runtime.clone()));
        let connector = Connector::new(options.tls.clone(), &RacingOptions::on(clock));
        // * HTTP/1.1, a pooled connection let go once idle on Bead's timer, its executor Bead's;
        // hyper follows no redirect and keeps no cookie
        let client = Client::builder(Spawner::on(runtime.clone()))
            .pool_timer(HyperTimer::on(runtime.clone()))
            .pool_idle_timeout(POOL_IDLE_TIMEOUT)
            .retry_canceled_requests(true)
            .set_host(true)
            .build(connector);

        Ok(Self {
            calling: Arc::new(Calling {
                runtime,
                client,
                scheme,
                authority,
                path,
                authorization: options.authorization.clone(),
                maximum_body_bytes,
            }),
        })
    }

    /// The requester of `descriptor`'s procedure on `route`, its default one.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a route of another procedure, one whose first is no default
    /// route — a `POST` of its request whole, its result whole, no variable in its template — or
    /// one resolved off its gateway's origin.
    pub fn requester_of<Req: PayloadCodec, Res: PayloadCodec>(
        &self,
        route: &HttpRoute,
        descriptor: &Descriptor<Req, Res>,
    ) -> Result<HttpRequester<Req, Res>, ProgrammerError> {
        held_to(route, descriptor)?;

        Ok(HttpRequester {
            bound: self.calling.bound(route)?,
            descriptor: descriptor.clone(),
        })
    }

    /// The subscriber of `descriptor`'s procedure, which notifies, on `route`, its default one.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] as [`HttpCaller::requester_of`] refuses, or for a route that carries
    /// no notification.
    pub fn subscriber_of<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec>(
        &self,
        route: &HttpRoute,
        descriptor: &NotifyingDescriptor<Req, Res, Not>,
    ) -> Result<HttpSubscriber<Req, Res, Not>, ProgrammerError> {
        held_to(route, descriptor.descriptor())?;

        if route.notification().is_none() {
            return Err(ProgrammerError::new(
                "only a notifying HTTP procedure opens a stream",
            ));
        }

        Ok(HttpSubscriber {
            bound: self.calling.bound(route)?,
            descriptor: descriptor.clone(),
        })
    }
}

// `route` held to `descriptor`'s procedure
fn held_to<Req: PayloadCodec, Res: PayloadCodec>(
    route: &HttpRoute,
    descriptor: &Descriptor<Req, Res>,
) -> Result<(), ProgrammerError> {
    let (routed, described) = (route.procedure().procedure(), descriptor.procedure());

    if routed.service_id != described.service_id || routed.procedure_id != described.procedure_id {
        return Err(ProgrammerError::new(format!(
            "{}'s route is another procedure's, {}",
            described.procedure_name, routed.procedure_name
        )));
    }

    Ok(())
}

// ── A call ───────────────────────────────────────────────────────────────────────────────────

// a default route of a caller's, its target resolved
#[derive(Clone)]
struct Bound {
    calling: Arc<Calling>,
    route: HttpRoute,
    target: Uri,
    is_secure: bool,
}

impl fmt::Debug for Bound {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Bound")
            .field("target", &self.target)
            .finish_non_exhaustive()
    }
}

// a request ready to go, and what gives it up
struct Prepared {
    request: Request<Sending>,
    signal: Option<CancellationToken>,
}

// a payload's media type, its body's on either side
const fn media_type_of(payload: &HttpPayload) -> &'static str {
    match payload {
        HttpPayload::Raw => "application/octet-stream",
        HttpPayload::Text => "text/plain",
        HttpPayload::Json | HttpPayload::Message(_) => "application/json",
    }
}

// a failure raised here, on the client's side
fn local_failure(code: ProtocolCode, detail: &str) -> Failure {
    Failure::protocol(code, RouterSide::Client).saying(detail)
}

// a payload this side does not read, `cause` its reason
fn undecodable(detail: &str, cause: Option<Arc<dyn Error + Send + Sync>>) -> CallError {
    let failure = local_failure(ProtocolCode::PAYLOAD_UNDECODABLE, detail);

    CallError::Failure(match cause {
        Some(cause) => failure.caused_by(cause),
        None => failure,
    })
}

impl Bound {
    // the request of `value`, written by `codec` then by its route's payload, judged before it
    // goes: its credential, then whether it may go in the clear, then its encoding
    fn prepared<C: PayloadCodec>(
        &self,
        (codec, value): (&C, &C::Value),
        (options, is_stream): (&HttpCallOptions, bool),
    ) -> Result<Prepared, CallError> {
        let credential = if options.without_authorization == Some(true) {
            None
        } else {
            options
                .authorization
                .as_ref()
                .or(self.calling.authorization.as_ref())
        };

        if credential.is_some_and(|credential| !is_field_value(credential)) {
            return Err(CallError::Refused(ProgrammerError::new(NO_FIELD_VALUE)));
        }

        let credential = credential.filter(|credential| !credential.is_empty());

        // * a credential goes over TLS or to the loopback alone, refused before anything is
        // written (transcoding 12.3)
        if credential.is_some() && !self.is_secure {
            return Err(CallError::Failure(Failure::protocol(
                ProtocolCode::DESTINATION_UNREACHABLE,
                RouterSide::Client,
            )));
        }

        // a value that does not write fails before anything goes, with its codec's refusal
        let payload =
            encoded(codec, value).map_err(|refused| CallError::Other(Arc::new(refused)))?;
        let body = match self.route.request() {
            HttpPayload::Message(form) => Bytes::from(
                form.write(&payload, None)
                    .map_err(|refused| CallError::Other(Arc::new(refused)))?,
            ),
            HttpPayload::Json | HttpPayload::Text | HttpPayload::Raw => payload,
        };

        if options
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(CallError::Cancelled(None));
        }

        let accept = if is_stream {
            EVENT_STREAM_MEDIA_TYPE
        } else {
            media_type_of(self.route.result())
        };
        let mut request = Request::new(Sending(Some(body)));

        *request.method_mut() = Method::POST;
        *request.uri_mut() = self.target.clone();

        let headers = request.headers_mut();

        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static(media_type_of(self.route.request())),
        );
        headers.insert(ACCEPT, HeaderValue::from_static(accept));

        if let Some(credential) = credential {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(credential).map_err(|_unwritable| {
                    CallError::Refused(ProgrammerError::new(NO_FIELD_VALUE))
                })?,
            );
        }

        Ok(Prepared {
            request,
            signal: options.signal.clone(),
        })
    }

    // a stream read to its end, each event handed to `sender`: its error what ended it, or none
    // where its reader let it go
    async fn streamed<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec>(
        &self,
        (descriptor, prepared): (&NotifyingDescriptor<Req, Res, Not>, Prepared),
        sender: &Events<Res::Value, Not::Value>,
    ) -> Result<(), CallError> {
        let (head, mut body, signal) = answered(&self.calling, prepared).await?;
        let notification = self
            .route
            .notification()
            .ok_or_else(|| CallError::Refused(ProgrammerError::new(DEFAULT_ROUTE)))?;

        if media_type_in(&head.headers).as_deref() != Some(EVENT_STREAM_MEDIA_TYPE) {
            return Err(undecodable(
                "the HTTP subscription answers no event stream",
                None,
            ));
        }

        let mut framing = Framing::new(self.calling.maximum_body_bytes);
        let mut has_result = false;

        loop {
            let read = match &signal {
                Some(signal) => unless_cancelled(signal, chunk_of(&mut body))
                    .await
                    .ok_or(CallError::Cancelled(None))?,
                None => chunk_of(&mut body).await,
            };
            let chunk = match read {
                Ok(Some(chunk)) => chunk,
                Ok(None) => return Err(framing.end()),
                Err(error) => {
                    return Err(CallError::Failure(
                        local_failure(ProtocolCode::DESTINATION_LOST, ENDED)
                            .caused_by(Arc::new(error)),
                    ));
                }
            };
            let mut framed = Vec::new();
            let fed = framing.feed((&chunk, &mut framed));

            for Framed { name, data } in framed {
                if name == "failure" {
                    return Err(failure_of(data.as_bytes(), None));
                }

                if (!has_result && name != "result")
                    || (has_result && !name.is_empty() && name != "message")
                {
                    return Err(undecodable(
                        "the HTTP event stream holds one result then notifications",
                        None,
                    ));
                }

                let event = if has_result {
                    HttpEvent::Notification(event_value_of(
                        descriptor.notification(),
                        (notification, data),
                    )?)
                } else {
                    HttpEvent::Result(event_value_of(
                        descriptor.descriptor().result(),
                        (self.route.result(), data),
                    )?)
                };

                has_result = true;

                if sender.send(Ok(event)).await.is_err() {
                    return Ok(());
                }
            }

            fed?;
        }
    }
}

// the field `name` holds, its lines joined as the Fetch Standard's `get` joins them
fn field_of(headers: &HeaderMap, name: &str) -> Option<String> {
    let lines: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .collect();

    (!lines.is_empty()).then(|| lines.join(", "))
}

// a response's media type, its parameters aside, in lower case
fn media_type_in(headers: &HeaderMap) -> Option<String> {
    let value = field_of(headers, CONTENT_TYPE.as_str())?;

    value
        .split(';')
        .next()
        .map(|media_type| media_type.trim().to_ascii_lowercase())
}

// what an answer of a status, unmarked or a gateway's own problem, says beside it
struct Answered {
    refusal: Option<String>,
    retry: Option<String>,
    detail: Option<String>,
    is_problem: bool,
}

// the protocol's code a status stands for: a gateway's own problem read by its own table backwards,
// an intermediary's leaving the outcome unknown
fn code_of_status(status: u16, is_problem: bool) -> ProtocolCode {
    match (status, is_problem) {
        (400 | 415, true) => ProtocolCode::PAYLOAD_UNDECODABLE,
        (405 | 408, true) | (404 | 503, _) => ProtocolCode::DESTINATION_UNREACHABLE,
        (422, true) => ProtocolCode::PAYLOAD_INVALID,
        (431, true) | (413, _) => ProtocolCode::PAYLOAD_TOO_LARGE,
        (501, true) => ProtocolCode::PROCEDURE_UNKNOWN,
        (401, _) => ProtocolCode::SESSION_REQUIRED,
        (403, _) => ProtocolCode::ACCESS_DENIED,
        (429, _) => ProtocolCode::CAPACITY_EXCEEDED,
        _ => ProtocolCode::DESTINATION_LOST,
    }
}

// the failure an answer of `status` stands for: by its refusal first, then by its status
// (transcoding 12.4.2, 12.4.3)
fn status_failure(status: u16, answered: &Answered) -> CallError {
    let code = match answered.refusal.as_deref() {
        Some("busy") => ProtocolCode::CAPACITY_EXCEEDED,
        Some("host-refused" | "origin-refused") => ProtocolCode::ACCESS_DENIED,
        Some("path-unknown" | "method-refused") => ProtocolCode::DESTINATION_UNREACHABLE,
        Some("too-large") => ProtocolCode::PAYLOAD_TOO_LARGE,
        Some("malformed" | "type-refused") => ProtocolCode::PAYLOAD_UNDECODABLE,
        Some(_) | None => code_of_status(status, answered.is_problem),
    };
    let mut detail = format!("the HTTP call answers {status}");

    if let Some(retry) = &answered.retry {
        detail.push_str("; Retry-After: ");
        detail.push_str(retry);
    }
    if let Some(said) = answered.detail.as_deref().filter(|said| !said.is_empty()) {
        detail.push_str("; ");
        detail.push_str(said);
    }

    CallError::Failure(
        Failure::answered_over_http(code.get(), FailureScope::Protocol).saying(detail),
    )
}

// a JSON number's whole value within `range`, however it is written
fn whole_of(value: &Value, (least, most): (i64, i64)) -> Option<i64> {
    value
        .as_f64()
        .and_then(integer_of)
        .filter(|whole| (least..=most).contains(whole))
}

// the failure a problem stands for: a gateway's own by its status, its refusal and its detail; a
// Bead failure by its code, its scope and its detail (transcoding 12.4); a stream's `failure`
// event, of no response, by its own status
fn failure_of(bytes: &[u8], head: Option<&Parts>) -> CallError {
    let problem = match json::read(bytes) {
        Ok(problem) => problem,
        Err(refused) => return undecodable(UNDECODABLE, Some(Arc::new(refused))),
    };
    let empty = Map::new();
    let members = problem.as_object();
    let object = members.unwrap_or(&empty);
    let detail = object.get("detail");

    if members.is_some()
        && !object.contains_key("code")
        && !object.contains_key("scope")
        && detail.is_none_or(Value::is_string)
    {
        let status = head.map_or_else(
            || {
                object
                    .get("status")
                    .and_then(|status| whole_of(status, (100, 599)))
                    .and_then(|status| u16::try_from(status).ok())
            },
            |head| Some(head.status.as_u16()),
        );

        if let Some(status) = status.filter(|status| (100..=599).contains(status)) {
            return status_failure(
                status,
                &Answered {
                    refusal: head.and_then(|head| field_of(&head.headers, REFUSAL_HEADER)),
                    retry: head.and_then(|head| field_of(&head.headers, RETRY_AFTER.as_str())),
                    detail: detail.and_then(Value::as_str).map(str::to_owned),
                    is_problem: true,
                },
            );
        }
    }

    let code = object
        .get("code")
        .and_then(|code| whole_of(code, (1, 65_535)))
        .and_then(|code| u16::try_from(code).ok())
        .and_then(NonZeroU16::new);
    let scope = match object.get("scope").and_then(Value::as_str) {
        Some("application") => Some(FailureScope::Application),
        Some("protocol") => Some(FailureScope::Protocol),
        Some(_) | None => None,
    };

    match (code, scope, detail) {
        (Some(code), Some(scope), None) => {
            CallError::Failure(Failure::answered_over_http(code, scope))
        }
        (Some(code), Some(scope), Some(Value::String(detail))) => {
            CallError::Failure(Failure::answered_over_http(code, scope).saying(detail.clone()))
        }
        _ => undecodable("the HTTP problem holds no Bead failure", None),
    }
}

// a body read whole, within `limit` bytes, unless `signal` gives it up first
async fn whole_body(
    body: &mut Incoming,
    (limit, signal): (u64, Option<&CancellationToken>),
) -> Result<Bytes, CallError> {
    let mut whole = Vec::new();

    loop {
        let read = match signal {
            Some(signal) => unless_cancelled(signal, chunk_of(body))
                .await
                .ok_or(CallError::Cancelled(None))?,
            None => chunk_of(body).await,
        };

        match read {
            Ok(Some(chunk)) => {
                whole.extend_from_slice(&chunk);

                if u64::try_from(whole.len()).unwrap_or(u64::MAX) > limit {
                    return Err(CallError::Failure(local_failure(
                        ProtocolCode::PAYLOAD_TOO_LARGE,
                        "the HTTP body passes maximumBodyBytes",
                    )));
                }
            }
            Ok(None) => return Ok(Bytes::from(whole)),
            Err(error) => {
                return Err(CallError::Failure(
                    local_failure(ProtocolCode::DESTINATION_LOST, ENDED).caused_by(Arc::new(error)),
                ));
            }
        }
    }
}

// the request sent and its answer's head judged: a redirect refused unfollowed, a problem read as
// its failure, any other status but 200 by its status
async fn answered(
    calling: &Calling,
    prepared: Prepared,
) -> Result<(Parts, Incoming, Option<CancellationToken>), CallError> {
    let Prepared { request, signal } = prepared;
    let sent = match &signal {
        Some(signal) => unless_cancelled(signal, calling.client.request(request))
            .await
            .ok_or(CallError::Cancelled(None))?,
        None => calling.client.request(request).await,
    };
    let (head, mut body) = sent
        .map_err(|error| CallError::Other(Arc::new(error)))?
        .into_parts();
    let status = head.status.as_u16();
    let unmarked = || Answered {
        refusal: None,
        retry: field_of(&head.headers, RETRY_AFTER.as_str()),
        detail: None,
        is_problem: false,
    };

    if head.status.is_redirection() {
        return Err(status_failure(status, &unmarked()));
    }

    if status != 200 {
        if media_type_in(&head.headers).as_deref() == Some(PROBLEM_MEDIA_TYPE) {
            let bytes =
                whole_body(&mut body, (calling.maximum_body_bytes, signal.as_ref())).await?;

            return Err(failure_of(&bytes, Some(&head)));
        }

        return Err(status_failure(status, &unmarked()));
    }

    Ok((head, body, signal))
}

// a payload's value: its bytes read by its route's payload, then by `codec`, its message within
// the envelope's bound
fn value_of<C: PayloadCodec>(
    codec: &C,
    (payload, bytes): (&HttpPayload, Bytes),
) -> Result<C::Value, CallError> {
    let binary = match payload {
        HttpPayload::Message(form) => form
            .read(&bytes)
            .map_err(|refused| undecodable(UNDECODABLE, Some(Arc::new(refused))))?,
        HttpPayload::Json | HttpPayload::Text | HttpPayload::Raw => bytes,
    };
    let value = decoded(codec, &binary)
        .unwrap_or_else(|panicked| Err(refusal_saying(&panicked)))
        .map_err(|refused| undecodable(UNDECODABLE, Some(Arc::new(refused))))?;
    // a JSON payload's bound is that of the text its codec writes of it, as a call would carry it
    let length = match payload {
        HttpPayload::Json => encoded(codec, &value).map_or(binary.len(), |written| written.len()),
        HttpPayload::Message(_) | HttpPayload::Text | HttpPayload::Raw => binary.len(),
    };

    if length > MAXIMUM_ENVELOPE_BYTES {
        return Err(CallError::Failure(local_failure(
            ProtocolCode::PAYLOAD_TOO_LARGE,
            "the HTTP payload passes maximumEnvelopeBytes",
        )));
    }

    Ok(value)
}

// whether `text` is base64 a forgiving reader takes (the HTML Standard's forgiving-base64 decode),
// though not in its standard padded form
fn is_forgiving_base64(text: &str) -> bool {
    let mut kept: Vec<u8> = text
        .bytes()
        .filter(|byte| !matches!(byte, b'\t' | b'\n' | b'\x0c' | b'\r' | b' '))
        .collect();

    if kept.len().is_multiple_of(4) {
        for _ in 0..2 {
            if kept.last() == Some(&b'=') {
                kept.pop();
            }
        }
    }

    kept.len() % 4 != 1
        && kept
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
}

// an event's value: a `text` or `raw` payload's data one JSON string, its text or its bytes in
// base64; any other's its JSON text (transcoding 12.5)
fn event_value_of<C: PayloadCodec>(
    codec: &C,
    (payload, data): (&HttpPayload, String),
) -> Result<C::Value, CallError> {
    match payload {
        HttpPayload::Text | HttpPayload::Raw => {
            let value = json::read(data.as_bytes())
                .map_err(|refused| undecodable(UNDECODABLE, Some(Arc::new(refused))))?;
            let Value::String(text) = value else {
                return Err(undecodable(
                    "an HTTP text or raw event holds a JSON string",
                    None,
                ));
            };

            if matches!(payload, HttpPayload::Text) {
                return value_of(codec, (payload, Bytes::from(text)));
            }

            match bytes_of_base64(&text) {
                Some(raw) => value_of(codec, (payload, Bytes::from(raw))),
                None if is_forgiving_base64(&text) => Err(undecodable(
                    "an HTTP raw event holds standard padded base64",
                    None,
                )),
                None => Err(undecodable(UNDECODABLE, None)),
            }
        }
        HttpPayload::Json | HttpPayload::Message(_) => {
            value_of(codec, (payload, Bytes::from(data)))
        }
    }
}

// ── A requester ──────────────────────────────────────────────────────────────────────────────

/// A procedure's requester on its default route, which a generated `<Service>HttpClient` calls.
///
/// Its request is written by its descriptor's codec, then by its route's payload; its result is
/// read the other way.
pub struct HttpRequester<Req: PayloadCodec, Res: PayloadCodec> {
    bound: Bound,
    descriptor: Descriptor<Req, Res>,
}

impl<Req: PayloadCodec, Res: PayloadCodec> Clone for HttpRequester<Req, Res> {
    fn clone(&self) -> Self {
        Self {
            bound: self.bound.clone(),
            descriptor: self.descriptor.clone(),
        }
    }
}

impl<Req: PayloadCodec, Res: PayloadCodec> fmt::Debug for HttpRequester<Req, Res> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpRequester")
            .field("route", &self.bound)
            .field("descriptor", &self.descriptor)
            .finish_non_exhaustive()
    }
}

impl<Req: PayloadCodec, Res: PayloadCodec> HttpRequester<Req, Res> {
    /// Calls its procedure with `request`, started as it is called; dropping its future gives
    /// nothing up, its `signal` does.
    ///
    /// # Errors
    ///
    /// [`CallError::Failure`]: a problem's failure, the peer's, or one of this side's — a
    /// credential refused in the clear, `DESTINATION_UNREACHABLE`; a body or a payload past its
    /// bound, `PAYLOAD_TOO_LARGE`; one that does not read, `PAYLOAD_UNDECODABLE`; a body cut,
    /// `DESTINATION_LOST`. [`CallError::Refused`] for a credential that is no field value,
    /// [`CallError::Cancelled`] once its signal gives it up, and [`CallError::Other`] for a value
    /// its codec refuses, or what its exchange failed with.
    pub fn call(
        &self,
        request: &Req::Value,
        options: &HttpCallOptions,
    ) -> BoxFuture<Result<Res::Value, CallError>> {
        let prepared = match self
            .bound
            .prepared((self.descriptor.request(), request), (options, false))
        {
            Ok(prepared) => prepared,
            Err(refused) => return Box::pin(async move { Err(refused) }),
        };
        let (bound, descriptor) = (self.bound.clone(), self.descriptor.clone());
        let calling = Arc::clone(&bound.calling);
        let task = platform::spawn(&calling.runtime, async move {
            let (head, mut body, signal) = answered(&bound.calling, prepared).await?;

            if media_type_in(&head.headers).as_deref() != Some(media_type_of(bound.route.result()))
            {
                return Err(undecodable("the HTTP result has another media type", None));
            }

            let bytes = whole_body(
                &mut body,
                (bound.calling.maximum_body_bytes, signal.as_ref()),
            )
            .await?;

            value_of(descriptor.result(), (bound.route.result(), bytes))
        });

        Box::pin(joined(task))
    }
}

// a task's output, or what ended it
async fn joined<T>(task: JoinHandle<Result<T, CallError>>) -> Result<T, CallError> {
    task.await
        .unwrap_or_else(|ended| Err(CallError::Other(Arc::new(ended))))
}

// ── A subscriber ─────────────────────────────────────────────────────────────────────────────

/// A notifying procedure's subscriber on its default route: its stream read as its result, then
/// each notification, then the failure that ends it (transcoding 12.5); it never reconnects.
pub struct HttpSubscriber<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> {
    bound: Bound,
    descriptor: NotifyingDescriptor<Req, Res, Not>,
}

impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> Clone
    for HttpSubscriber<Req, Res, Not>
{
    fn clone(&self) -> Self {
        Self {
            bound: self.bound.clone(),
            descriptor: self.descriptor.clone(),
        }
    }
}

impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> fmt::Debug
    for HttpSubscriber<Req, Res, Not>
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpSubscriber")
            .field("route", &self.bound)
            .field("descriptor", &self.descriptor)
            .finish_non_exhaustive()
    }
}

impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> HttpSubscriber<Req, Res, Not> {
    /// Opens its procedure's stream with `request`, started as it is called: its subscription
    /// gives its events as they come, then the failure that ends them, an error, then nothing.
    /// Dropping it lets its stream go; its `signal` ends it [`CallError::Cancelled`].
    pub fn call(
        &self,
        request: &Req::Value,
        options: &HttpCallOptions,
    ) -> HttpSubscription<Res::Value, Not::Value> {
        // ! one event held at a time: the stream is read no further than its reader takes
        let (sender, events) = mpsc::channel(1);
        let prepared = self.bound.prepared(
            (self.descriptor.descriptor().request(), request),
            (options, true),
        );
        let (bound, descriptor) = (self.bound.clone(), self.descriptor.clone());
        let runtime = bound.calling.runtime.clone();
        let task = platform::spawn(&runtime, async move {
            let ended = match prepared {
                Ok(prepared) => bound.streamed((&descriptor, prepared), &sender).await,
                Err(refused) => Err(refused),
            };

            if let Err(ended) = ended {
                drop(sender.send(Err(ended)).await);
            }
        });

        HttpSubscription {
            events,
            task: Some(task),
        }
    }
}

// one event of a stream, its name and its data
struct Framed {
    name: String,
    data: String,
}

// an event stream read as the HTML Standard frames it (§9.2.6): its lines ended by CR, LF or CRLF,
// each strict UTF-8, a leading BOM taken away; one event held within the caller's bound, its
// comments aside
struct Framing {
    line: Vec<u8>,
    is_first_line: bool,
    skips_lf: bool,
    name: String,
    data: Vec<String>,
    size: u64,
    maximum: u64,
}

impl Framing {
    fn new(maximum: u64) -> Self {
        Self {
            line: Vec::new(),
            is_first_line: true,
            skips_lf: false,
            name: String::new(),
            data: Vec::new(),
            size: 0,
            maximum,
        }
    }

    // a line's text, strict UTF-8
    fn text_of(line: Vec<u8>) -> Result<String, CallError> {
        String::from_utf8(line).map_err(|refused| undecodable(UNDECODABLE, Some(Arc::new(refused))))
    }

    // the events `chunk` ends, into `framed`, until what it holds fails
    fn feed(&mut self, (chunk, framed): (&[u8], &mut Vec<Framed>)) -> Result<(), CallError> {
        for octet in chunk {
            if self.skips_lf {
                self.skips_lf = false;

                if *octet == b'\n' {
                    continue;
                }
            }

            if *octet != b'\n' && *octet != b'\r' {
                self.size = self.size.saturating_add(1);

                if self.size > self.maximum {
                    return Err(CallError::Failure(local_failure(
                        ProtocolCode::PAYLOAD_TOO_LARGE,
                        "the HTTP event passes maximumBodyBytes",
                    )));
                }

                self.line.push(*octet);
                continue;
            }

            self.skips_lf = *octet == b'\r';

            let length = u64::try_from(self.line.len()).unwrap_or(u64::MAX);
            let text = Self::text_of(core::mem::take(&mut self.line))?;
            // a leading BOM taken away, as the HTML Standard's UTF-8 decode takes it
            let text = if self.is_first_line {
                text.strip_prefix('\u{feff}').unwrap_or(&text)
            } else {
                &text
            };

            self.is_first_line = false;
            self.take(text, (length, framed));
        }

        Ok(())
    }

    // a whole line taken: an event dispatched at a blank one, a field kept, a comment let go
    fn take(&mut self, text: &str, (length, framed): (u64, &mut Vec<Framed>)) {
        let field = |name: &str| {
            text.strip_prefix(name)
                .map(|value| value.strip_prefix(' ').unwrap_or(value).to_owned())
        };

        if text.is_empty() {
            if !self.data.is_empty() {
                framed.push(Framed {
                    name: core::mem::take(&mut self.name),
                    data: self.data.join("\n"),
                });
            }

            self.data.clear();
            self.name.clear();
            self.size = 0;
        } else if let Some(name) = field("event:") {
            self.name = name;
        } else if let Some(data) = field("data:") {
            self.data.push(data);
        } else if text.starts_with(':') {
            self.size = self.size.saturating_sub(length);
        }
    }

    // the stream's end, which a failure event did not come before
    fn end(self) -> CallError {
        if let Err(refused) = Self::text_of(self.line) {
            return refused;
        }

        CallError::Failure(local_failure(
            ProtocolCode::DESTINATION_LOST,
            "the HTTP event stream ends without a failure",
        ))
    }
}

// what a stream's task hands its subscription
type Events<R, N> = mpsc::Sender<Result<HttpEvent<R, N>, CallError>>;

/// A stream's events, as a subscriber reads them: its result, then each notification, then the
/// error that ended it, then nothing. Dropped, it lets its stream go.
pub struct HttpSubscription<R, N> {
    events: mpsc::Receiver<Result<HttpEvent<R, N>, CallError>>,
    task: Option<JoinHandle<()>>,
}

impl<R, N> fmt::Debug for HttpSubscription<R, N> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpSubscription")
            .field("is_ended", &self.task.is_none())
            .finish_non_exhaustive()
    }
}

impl<R, N> futures_util::Stream for HttpSubscription<R, N> {
    type Item = Result<HttpEvent<R, N>, CallError>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();

        if this.task.is_none() {
            return Poll::Ready(None);
        }

        match this.events.poll_recv(context) {
            Poll::Ready(Some(Ok(event))) => Poll::Ready(Some(Ok(event))),
            // * an error ends the stream: nothing comes after it
            Poll::Ready(Some(Err(ended))) => {
                this.task = None;

                Poll::Ready(Some(Err(ended)))
            }
            Poll::Ready(None) => {
                this.task = None;

                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<R, N> Drop for HttpSubscription<R, N> {
    fn drop(&mut self) {
        // ! its reader gone, its stream is let go: its response dropped, its connection with it
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
