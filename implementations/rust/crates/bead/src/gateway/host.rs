//! A gateway (spec/transcoding.md, decisions 0037 and 0052), as the other sides'
//! `createHTTPGateway` and `HttpGateway` answer it: an HTTP server that answers a service's
//! procedures as routes, each call made through one more Bead client of its application's own
//! server, one in-memory connection an exchange; beside the wire, never in place of it. On its own
//! listener, the HTTP transport's wire (decision 0049); mounted, [`HttpGateway::answer`], which an
//! application's own server hands what it routes to it.

use core::error::Error;
use core::fmt;
use core::time::Duration;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use bytes::Bytes;
use http_body::Body;
use hyper::body::Incoming;
use hyper::{Method, Request, Response, Version};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

use crate::broker::participant::{BODY_GRACE_PERIOD, HEARTBEAT, MINIMUM_BODY_BYTES_PER_SECOND};
use crate::client::{Client, ClientOptions};
use crate::clock::{SharedClock, SystemClock};
use crate::constants::{FailureScope, ProtocolCode};
use crate::duration::{hold, hold_finite};
use crate::errors::{CallError, ProgrammerError, TransportError};
use crate::failure::{Failure, FailureOrigin};
use crate::gateway::body::{
    BodyHead, HttpGatewayBody, OwnBody, Reading, Unread, is_taken_before, read_body,
};
use crate::gateway::pace::{Committed, Field, Head, Outlet, OutletSettings, SLICE_BYTES};
use crate::http::fields::{HTTP_REFUSALS, REFUSAL_HEADER, RESPONSE_FIELDS, Request as Fields};
use crate::http::server::{BODY_BYTES_BUDGET, MAXIMUM_BODY_BYTES, given_once};
use crate::http::wire::{AnswerBody, Answered, Cut, Flow, Malformed, WireOptions, serve};
use crate::http_policy::HttpPolicy;
use crate::identity::Procedure;
use crate::judgement::hosts::{
    TakenOrigins, assert_hosts, assert_origins, credential_of, has_visible_fields,
    is_listed_origin, is_taken_host, is_taken_origin, is_visible_target, own_authority_of,
    request_target_of,
};
use crate::judgement::proxies::{
    ClientAddressOptions, TrustedProxies, client_address_of, trusted_proxies_of,
};
use crate::memory::{
    MemoryTransportClient, MemoryTransportClientConnectOptions, MemoryTransportClientOptions,
    MemoryTransportServer,
};
use crate::net::bounds::{
    HEADERS_TIMEOUT, MINIMUM_SEND_BYTES_PER_SECOND, SEND_GRACE_PERIOD, SendPaceOptions, hold_count,
};
use crate::net::listening::{Acceptance, Bound, Listening, accepting, bind, io_error};
use crate::net::tls::serving_config_of;
use crate::payloads::{CodecRefusal, PayloadCodec, TextCodec};
use crate::platform::{self, Handle};
use crate::router::client::{NotificationLike, Settled};
use crate::router::types::{
    BoxFuture, RequestCredential, ResolvedRequestOptions, RouterError, RouterLimitsOptions,
    RouterRequest,
};
use crate::transcoding::events::{
    EVENT_STREAM_MEDIA_TYPE, EventHeartbeat, EventSink, EventStream, Taken, raw_data_of,
    text_data_of,
};
use crate::transcoding::form::{JsonFormError, MessageFormError, RequestPlace};
use crate::transcoding::problems::{
    Arose, CallFailure, Encoding, OwnFailure, OwnProblemOptions, PROBLEM_MEDIA_TYPE, Problem,
    ProblemField, ProblemOptions, ProblemRoute, problem_of_failure, problem_of_own,
    problem_of_refusal,
};
use crate::transcoding::routes::{HttpMethod, HttpPayload, HttpRoute, HttpRouteTemplate};
use crate::transcoding::templates::{
    RawPath, Template, is_tie, parse_template, raw_path_of, route_index_of, variables_of,
};
use crate::transport::{Listened, ListenerId, TransportServerAddress, TransportServerStartOptions};
use crate::{MAXIMUM_CONNECTIONS, MAXIMUM_CONNECTIONS_PER_ADDRESS, MAXIMUM_UNSENT_BYTES};

#[cfg(test)]
mod tests;

/// Where a gateway serves its document (transcoding 11.1).
pub const DOCUMENT_PATH: &str = "/openapi.json";

/// A call's timeout where a gateway's options give none (transcoding 9.2): 5 seconds.
pub const GATEWAY_TIMEOUT: Duration = Duration::from_secs(5);

/// A stream's window where a gateway's options give none (transcoding 8.8): 16 notifications.
pub const GATEWAY_WINDOW: u64 = 16;

/// The calls under way at once, every caller's, where a gateway's options give none (transcoding
/// 10.3).
pub const MAXIMUM_EXCHANGES: u64 = 10_000;

/// The calls under way at once of one caller's address, where a gateway's options give none
/// (transcoding 10.3).
pub const MAXIMUM_EXCHANGES_PER_ADDRESS: u64 = 256;

// a `JWT` the request's header holds at most, past its fixed part and its block's head (spec 4.4)
const JWT_BYTES: usize = 1_004;

// the methods in the order an `allow` names them (transcoding 3.10)
const METHOD_ORDER: [&str; 6] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

// how long a browser keeps a preflight's answer, in seconds, as the transport's
const PREFLIGHT_MAX_AGE: &str = "7200";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a call presents of a request's `authorization` (transcoding 2.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum GatewayAuthorization {
    /// The field whole, `ELSEWHERE`.
    #[default]
    Elsewhere,
    /// A `Bearer` token, as a `JWT` in the request's `CREDENTIAL` block.
    BearerJwt,
}

/// What hears what a gateway reports (transcoding 7.6).
///
/// Each failure it answers a call with 500 or above but `PROCEDURE_FAILED`, a response it dropped
/// past a bound, and what no gate foresaw; their words never in a problem.
pub type GatewayErrorListener = Arc<dyn Fn(&RouterError) + Send + Sync>;

/// How a gateway is built (transcoding 2.4, 7.6, 8.7, 8.8, 9.2, 10.3, 11.1).
///
/// Its route table and the in-memory transport its connections cross, then its document and its
/// gates and bounds, one by one or as one policy, which the HTTP transport takes too.
#[derive(Clone)]
#[non_exhaustive]
pub struct HttpGatewayOptions {
    /// The in-memory transport its connections cross, which its application's server joined (2.2).
    pub transport: MemoryTransportServer,
    /// Its route table: beadc's `HttpRoutes`.
    pub routes: Vec<HttpRoute>,
    /// What a call presents of a request's `authorization`: [`GatewayAuthorization::Elsewhere`]
    /// when none.
    pub authorization: Option<GatewayAuthorization>,
    /// The challenge a 401 carries: `Bearer` when none (7.6).
    pub challenge: Option<String>,
    /// The clock it runs on, and its exchanges' clients: the platform's when none.
    pub clock: Option<SharedClock>,
    /// The tokio runtime it runs on, its time and IO drivers enabled: the current one when none.
    pub runtime: Option<Handle>,
    /// The document its builder wrote, served at [`DOCUMENT_PATH`] (11.1); none serves none.
    pub document: Option<Bytes>,
    /// How long a quiet stream goes before a comment (8.7): [`HEARTBEAT`] when none;
    /// [`crate::NEVER`] writes none.
    pub heartbeat: Option<Duration>,
    /// The router limits of each exchange's client: their defaults when none.
    pub limits: Option<RouterLimitsOptions>,
    /// The calls under way at once, every caller's (10.3): [`MAXIMUM_EXCHANGES`] when none.
    pub maximum_exchanges: Option<u64>,
    /// The calls under way at once of one caller's address (10.3):
    /// [`MAXIMUM_EXCHANGES_PER_ADDRESS`] when none.
    pub maximum_exchanges_per_address: Option<u64>,
    /// What a response may hold unsent, the slice it would add among it, before it is dropped
    /// (10.2): [`MAXIMUM_UNSENT_BYTES`] when none.
    pub maximum_unsent_bytes: Option<u64>,
    /// The base an application failure's name follows as its problem's type (7.3): `about:blank`
    /// when none.
    pub problem_types: Option<String>,
    /// How long a call waits for its answer (9.2): [`GATEWAY_TIMEOUT`] when none;
    /// [`crate::NEVER`] waits without end.
    pub timeout: Option<Duration>,
    /// The notifications a stream lets come before its response took them (8.8):
    /// [`GATEWAY_WINDOW`] when none; 0 is refused.
    pub window: Option<u64>,
    /// What it judges a request by first, given once to every listener of an application (spec
    /// 15.12): each member it gives is the option of its name, which is then given here no more.
    pub policy: Option<HttpPolicy>,
    /// The bytes of body the exchanges under way may hold together, past which one is refused
    /// 503 `busy`: [`BODY_BYTES_BUDGET`] when none.
    pub body_bytes_budget: Option<u64>,
    /// How long a body comes before its rate is held: [`BODY_GRACE_PERIOD`] when none.
    pub body_grace_period: Option<Duration>,
    /// How long a request's head may take to come whole on its own listener, past which it is
    /// answered 408: [`HEADERS_TIMEOUT`] when none.
    pub headers_timeout: Option<Duration>,
    /// The hosts it takes besides the loopback's and its own (spec 15.12); `*` takes any.
    pub hosts: Option<Vec<String>>,
    /// The largest body it reads, past which it refuses an exchange 413 `too-large`:
    /// [`MAXIMUM_BODY_BYTES`] when none.
    pub maximum_body_bytes: Option<u64>,
    /// The streams under way at once, every caller's (10.3): [`MAXIMUM_CONNECTIONS`] when none.
    pub maximum_connections: Option<u64>,
    /// The streams under way at once of one caller's address (10.3):
    /// [`MAXIMUM_CONNECTIONS_PER_ADDRESS`] when none.
    pub maximum_connections_per_address: Option<u64>,
    /// The slowest, in bytes a second, a body may come once its grace passed, past which it is
    /// refused 408 `too-slow`: [`MINIMUM_BODY_BYTES_PER_SECOND`] when none; 0 holds none.
    pub minimum_body_bytes_per_second: Option<u64>,
    /// The slowest, in bytes a second, its reader may take a response once its grace passed, past
    /// which it is dropped and reported: [`MINIMUM_SEND_BYTES_PER_SECOND`] when none; 0 holds none.
    pub minimum_send_bytes_per_second: Option<u64>,
    /// The origins it answers, and answers CORS to, besides its own (spec 15.12).
    pub origins: Option<Vec<String>>,
    /// The least time a response's slice is given to be taken: [`SEND_GRACE_PERIOD`] when none.
    pub send_grace_period: Option<Duration>,
    /// The proxies whose `X-Forwarded-For` it believes, each an IP address or a network in CIDR
    /// (spec 15.12): none trusts no proxy.
    pub trusted_proxies: Option<Vec<String>>,
    /// The proxies on every path to it that `trusted_proxies` does not name, 8 at most: 0 when
    /// none.
    pub unnamed_proxies: Option<u64>,
    /// The TLS its own listener serves under: HTTP/2, then HTTP/1.1, by ALPN (RFC 7301). In clear
    /// when none, HTTP/1.1 alone.
    pub tls: Option<Arc<rustls::ServerConfig>>,
}

impl fmt::Debug for HttpGatewayOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpGatewayOptions")
            .field("routes", &self.routes.len())
            .field("authorization", &self.authorization)
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

impl HttpGatewayOptions {
    /// A gateway's options over `transport`, of `routes`, every other its default.
    #[must_use]
    pub const fn new(transport: MemoryTransportServer, routes: Vec<HttpRoute>) -> Self {
        Self {
            transport,
            routes,
            authorization: None,
            challenge: None,
            clock: None,
            runtime: None,
            document: None,
            heartbeat: None,
            limits: None,
            maximum_exchanges: None,
            maximum_exchanges_per_address: None,
            maximum_unsent_bytes: None,
            problem_types: None,
            timeout: None,
            window: None,
            policy: None,
            body_bytes_budget: None,
            body_grace_period: None,
            headers_timeout: None,
            hosts: None,
            maximum_body_bytes: None,
            maximum_connections: None,
            maximum_connections_per_address: None,
            minimum_body_bytes_per_second: None,
            minimum_send_bytes_per_second: None,
            origins: None,
            send_grace_period: None,
            trusted_proxies: None,
            unnamed_proxies: None,
            tls: None,
        }
    }

    // its policy's members in their places, each given once, there or beside it
    fn with_policy(&self) -> Result<Self, ProgrammerError> {
        let Some(policy) = &self.policy else {
            return Ok(self.clone());
        };

        Ok(Self {
            policy: None,
            body_bytes_budget: given_once(
                "bodyBytesBudget",
                (self.body_bytes_budget.as_ref(), policy.body_bytes_budget()),
            )?,
            body_grace_period: given_once(
                "bodyGracePeriod",
                (self.body_grace_period.as_ref(), policy.body_grace_period()),
            )?,
            headers_timeout: given_once(
                "headersTimeout",
                (self.headers_timeout.as_ref(), policy.headers_timeout()),
            )?,
            hosts: given_once(
                "hosts",
                (self.hosts.as_ref(), policy.hosts().map(<[String]>::to_vec)),
            )?,
            maximum_body_bytes: given_once(
                "maximumBodyBytes",
                (
                    self.maximum_body_bytes.as_ref(),
                    policy.maximum_body_bytes(),
                ),
            )?,
            maximum_connections: given_once(
                "maximumConnections",
                (
                    self.maximum_connections.as_ref(),
                    policy.maximum_connections(),
                ),
            )?,
            maximum_connections_per_address: given_once(
                "maximumConnectionsPerAddress",
                (
                    self.maximum_connections_per_address.as_ref(),
                    policy.maximum_connections_per_address(),
                ),
            )?,
            minimum_body_bytes_per_second: given_once(
                "minimumBodyBytesPerSecond",
                (
                    self.minimum_body_bytes_per_second.as_ref(),
                    policy.minimum_body_bytes_per_second(),
                ),
            )?,
            minimum_send_bytes_per_second: given_once(
                "minimumSendBytesPerSecond",
                (
                    self.minimum_send_bytes_per_second.as_ref(),
                    policy.minimum_send_bytes_per_second(),
                ),
            )?,
            origins: given_once(
                "origins",
                (
                    self.origins.as_ref(),
                    policy.origins().map(<[String]>::to_vec),
                ),
            )?,
            send_grace_period: given_once(
                "sendGracePeriod",
                (self.send_grace_period.as_ref(), policy.send_grace_period()),
            )?,
            trusted_proxies: given_once(
                "trustedProxies",
                (
                    self.trusted_proxies.as_ref(),
                    policy.trusted_proxies().map(<[String]>::to_vec),
                ),
            )?,
            unnamed_proxies: given_once(
                "unnamedProxies",
                (self.unnamed_proxies.as_ref(), policy.unnamed_proxies()),
            )?,
            ..self.clone()
        })
    }
}

/// Where a gateway's own listener listens, as a transport server's start says (spec 15.12).
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct HttpGatewayStartOptions {
    /// An IP address, bare, or `localhost`, both loopbacks: `localhost` when none.
    pub address: Option<String>,
    /// Its port: 80 when none; 0 lets the system pick one.
    pub port: Option<u16>,
    /// Whether it takes any free port instead: false when none.
    pub find_open_port: Option<bool>,
    /// What gives up on the start.
    pub signal: Option<CancellationToken>,
}

// a route of the table, its template parsed
struct Served {
    route: HttpRoute,
    // its template's place among its procedure's routes
    at: usize,
    method: HttpMethod,
    template: Template,
    // whether a navigation from another site may reach it (10.1, step 5)
    is_navigable: bool,
}

impl Served {
    fn template(&self) -> &HttpRouteTemplate {
        self.route.routes().get(self.at).unwrap_or_else(|| {
            // ! its place is one of its procedure's routes, as the table was read
            self.route
                .routes()
                .first()
                .unwrap_or_else(|| unreachable_route())
        })
    }
}

// a route of no template: none is read into the table
fn unreachable_route() -> &'static HttpRouteTemplate {
    static NONE: std::sync::OnceLock<HttpRouteTemplate> = std::sync::OnceLock::new();

    NONE.get_or_init(|| HttpRouteTemplate {
        method: HttpMethod::Get,
        template: String::new(),
        body: None,
        response_body: None,
    })
}

// the document, its bytes and its quoted SHA-256 tag
struct Document {
    bytes: Bytes,
    etag: String,
}

// what it was built with, held
struct Settings {
    transport: MemoryTransportServer,
    served: Vec<Served>,
    authorization: GatewayAuthorization,
    challenge: Option<String>,
    document: Option<Document>,
    heartbeat: Duration,
    limits: Option<RouterLimitsOptions>,
    maximum_exchanges: u64,
    maximum_exchanges_per_address: u64,
    maximum_connections: u64,
    maximum_connections_per_address: u64,
    maximum_unsent_bytes: u64,
    problem_types: Option<String>,
    timeout: Duration,
    window: u64,
    body_bytes_budget: u64,
    body_grace_period: Duration,
    headers_timeout: Duration,
    hosts: Vec<String>,
    origins: Vec<String>,
    maximum_body_bytes: u64,
    minimum_body_bytes_per_second: u64,
    pace: SendPaceOptions,
    proxies: TrustedProxies,
    tls: Option<Arc<rustls::ServerConfig>>,
}

// the calls or the streams under way, every caller's and by address
#[derive(Default)]
struct Counts {
    all: u64,
    by_address: HashMap<String, u64>,
}

#[derive(Default)]
struct GatewayState {
    calls: Counts,
    streams: Counts,
    // every exchange under way, which a stop ends
    live: HashMap<u64, Live>,
    next: u64,
    listening: Vec<Listening>,
    // each socket its own listener serves, until its end
    flows: HashMap<u64, Arc<Flow>>,
    next_flow: u64,
    is_listening: bool,
    is_disposed: bool,
}

// an exchange under way: what ends it, and its response
struct Live {
    ended: CancellationToken,
    outlet: Outlet,
}

struct Inner {
    me: Weak<Self>,
    runtime: Handle,
    // the platform's clock, which its pace and its head's bounds run on
    platform: SharedClock,
    // the clock it runs on, and its exchanges' clients
    clock: SharedClock,
    settings: Settings,
    state: Mutex<GatewayState>,
    listeners: Listened<GatewayErrorListener>,
    // the bytes of body the exchanges under way hold
    budget: Arc<AtomicU64>,
}

/// A gateway of a route table, beadc's (transcoding 1.1).
///
/// Each request is judged in 10.1's order —
/// HTTP's own, its host, its path, its origin, Fetch Metadata, a preflight, its method, its type,
/// its fields and bounds, its body as it comes — then bound, read by its message's JSON form and
/// called through one Bead connection drawn for its exchange across its in-memory transport,
/// closed as its response ends. Its result answers 200 in Bead's proto JSON form, its failure a
/// problem by where it arose, a stream Server-Sent Events.
///
/// It listens on its own listener, [`HttpGateway::start`], over the HTTP transport's wire, or
/// answers what its application's own server hands it, [`HttpGateway::answer`]. Cloned, it is the
/// same gateway.
#[derive(Clone)]
pub struct HttpGateway {
    inner: Arc<Inner>,
}

impl fmt::Debug for HttpGateway {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpGateway")
            .field("routes", &self.inner.settings.served.len())
            .finish_non_exhaustive()
    }
}

// a quoted SHA-256 of `bytes`, in lower-case hexadecimal, as an entity tag
fn etag_of(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut tag = String::with_capacity(66);

    tag.push('"');

    for byte in digest {
        for digit in [byte >> 4, byte & 0x0F] {
            tag.extend(char::from_digit(u32::from(digit), 16));
        }
    }

    tag.push('"');
    tag
}

// the table: each template parsed, a template off http.proto's grammar and two of one method that
// tie refused, naming their routes (3.5)
fn served_of(routes: &[HttpRoute]) -> Result<Vec<Served>, ProgrammerError> {
    let mut served: Vec<Served> = Vec::new();

    for route in routes {
        let name = &route.procedure().procedure().procedure_name;

        for (at, given) in route.routes().iter().enumerate() {
            let template = parse_template(&given.template).map_err(|reason| {
                ProgrammerError::new(format!(
                    "{name}'s route {} {}: {reason}",
                    given.method, given.template
                ))
            })?;

            if let Some(tied) = served
                .iter()
                .find(|other| other.method == given.method && is_tie(&other.template, &template))
            {
                return Err(ProgrammerError::new(format!(
                    "{name}'s route {} {} ties {}'s route {} {}",
                    given.method,
                    given.template,
                    tied.route.procedure().procedure().procedure_name,
                    tied.method,
                    tied.template().template
                )));
            }

            served.push(Served {
                route: route.clone(),
                at,
                method: given.method,
                template,
                is_navigable: given.method == HttpMethod::Get && route.no_side_effects(),
            });
        }
    }

    Ok(served)
}

// what it is built with, each option held as the other sides hold it, a policy's members in their
// places
fn settings_of(given: &HttpGatewayOptions) -> Result<Settings, ProgrammerError> {
    let options = given.with_policy()?;
    let hosts = options.hosts.clone().unwrap_or_default();
    let origins = options.origins.clone().unwrap_or_default();

    assert_hosts(&hosts)?;
    assert_origins(&origins)?;

    Ok(Settings {
        transport: options.transport.clone(),
        served: served_of(&options.routes)?,
        authorization: options.authorization.unwrap_or_default(),
        challenge: options.challenge.clone(),
        document: options.document.clone().map(|bytes| Document {
            etag: etag_of(&bytes),
            bytes,
        }),
        heartbeat: hold("heartbeat", options.heartbeat.unwrap_or(HEARTBEAT))?,
        limits: options.limits.clone(),
        maximum_exchanges: hold_count(
            "maximumExchanges",
            options.maximum_exchanges.unwrap_or(MAXIMUM_EXCHANGES),
        )?,
        maximum_exchanges_per_address: hold_count(
            "maximumExchangesPerAddress",
            options
                .maximum_exchanges_per_address
                .unwrap_or(MAXIMUM_EXCHANGES_PER_ADDRESS),
        )?,
        maximum_connections: hold_count(
            "maximumConnections",
            options.maximum_connections.unwrap_or(MAXIMUM_CONNECTIONS),
        )?,
        maximum_connections_per_address: hold_count(
            "maximumConnectionsPerAddress",
            options
                .maximum_connections_per_address
                .unwrap_or(MAXIMUM_CONNECTIONS_PER_ADDRESS),
        )?,
        maximum_unsent_bytes: hold_count(
            "maximumUnsentBytes",
            options.maximum_unsent_bytes.unwrap_or(MAXIMUM_UNSENT_BYTES),
        )?,
        problem_types: options.problem_types.clone(),
        timeout: hold("timeout", options.timeout.unwrap_or(GATEWAY_TIMEOUT))?,
        window: hold_count("window", options.window.unwrap_or(GATEWAY_WINDOW))?,
        body_bytes_budget: hold_count(
            "bodyBytesBudget",
            options.body_bytes_budget.unwrap_or(BODY_BYTES_BUDGET),
        )?,
        body_grace_period: hold_finite(
            "bodyGracePeriod",
            options.body_grace_period.unwrap_or(BODY_GRACE_PERIOD),
        )?,
        headers_timeout: hold_finite(
            "headersTimeout",
            options.headers_timeout.unwrap_or(HEADERS_TIMEOUT),
        )?,
        maximum_body_bytes: hold_count(
            "maximumBodyBytes",
            options.maximum_body_bytes.unwrap_or(MAXIMUM_BODY_BYTES),
        )?,
        minimum_body_bytes_per_second: options
            .minimum_body_bytes_per_second
            .unwrap_or(MINIMUM_BODY_BYTES_PER_SECOND),
        pace: SendPaceOptions {
            minimum_send_bytes_per_second: options
                .minimum_send_bytes_per_second
                .unwrap_or(MINIMUM_SEND_BYTES_PER_SECOND),
            send_grace_period: hold_finite(
                "sendGracePeriod",
                options.send_grace_period.unwrap_or(SEND_GRACE_PERIOD),
            )?,
        },
        proxies: trusted_proxies_of(
            options.trusted_proxies.as_deref().unwrap_or_default(),
            options.unnamed_proxies,
        )?,
        tls: options.tls.as_ref().map(serving_config_of),
        hosts,
        origins,
    })
}

// ── Reading a request ─────────────────────────────────────────────────────────────────────────

fn encoding_of(payload: &HttpPayload) -> Encoding {
    match payload {
        HttpPayload::Json => Encoding::Json,
        HttpPayload::Text => Encoding::Text,
        HttpPayload::Raw => Encoding::Raw,
        HttpPayload::Message(_) => Encoding::Proto,
    }
}

// the media type a body of `encoding` is sent as (5.1)
const fn media_type_of(encoding: Encoding) -> &'static str {
    match encoding {
        Encoding::Json | Encoding::Proto => "application/json",
        Encoding::Raw => "application/octet-stream",
        Encoding::Text => "text/plain",
    }
}

// the media type a result of `encoding` is answered as (5.1)
const fn result_media_type_of(encoding: Encoding) -> &'static str {
    match encoding {
        Encoding::Json | Encoding::Proto => "application/json",
        Encoding::Raw => "application/octet-stream",
        Encoding::Text => "text/plain;charset=utf-8",
    }
}

// a weight as RFC 9110 §12.4.2's qvalue writes it
fn qvalue_of(text: &str) -> Option<f64> {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let is_held = fraction.len() <= 3
        && fraction.bytes().all(|byte| byte.is_ascii_digit())
        && match whole {
            "0" => true,
            "1" => fraction.bytes().all(|byte| byte == b'0'),
            _ => false,
        };

    is_held.then(|| text.parse::<f64>().ok()).flatten()
}

// the weight `accept` gives a media type, by its most specific range; 0 where none names it
fn weight_of(accept: &str, (media_type, is_exact): (&str, bool)) -> f64 {
    let major = media_type.split('/').next().unwrap_or_default();
    let mut best: Option<(u8, f64)> = None;

    for range in accept.split(',') {
        let mut parts = range
            .split(';')
            .map(|part| part.trim().to_ascii_lowercase());
        let name = parts.next().unwrap_or_default();
        let rank = if name == media_type {
            3
        } else if name == format!("{major}/*") {
            2
        } else {
            u8::from(name == "*/*")
        };

        if rank == 0 || (is_exact && rank != 3) {
            continue;
        }

        // * a weight off the qvalue grammar is as none given, 1; of two it reads, the last stands
        let mut weight = 1.0;

        for parameter in parts {
            if let Some((key, value)) = parameter.split_once('=')
                && key.trim() == "q"
                && let Some(read) = qvalue_of(value.trim())
            {
                weight = read;
            }
        }

        if best.is_none_or(|(held, _)| rank > held) {
            best = Some((rank, weight));
        }
    }

    best.map_or(0.0, |(_, weight)| weight)
}

// whether a request asks for a stream (8.1): its `accept` names `text/event-stream` itself, of a
// weight above 0 and at least the weight it gives `application/json`; never through a wildcard
fn asks_stream(fields: &Fields<'_>) -> bool {
    let accept = fields.lines_of("accept").join(", ");
    let stream = weight_of(&accept, (EVENT_STREAM_MEDIA_TYPE, true));

    stream > 0.0 && stream >= weight_of(&accept, ("application/json", false))
}

// whether a body's `content-type` is its route's (5.1): one field, its type compared
// case-insensitively, no parameter but `charset=utf-8`; its `content-encoding` none or `identity`
fn is_taken_type(fields: &Fields<'_>, encoding: Encoding) -> bool {
    if fields
        .header_of("content-encoding")
        .is_some_and(|coding| !coding.trim().eq_ignore_ascii_case("identity"))
    {
        return false;
    }

    // ! each line is counted where it stands: two content-type fields are refused
    let [line] = fields.lines_of("content-type")[..] else {
        return false;
    };
    let mut parts = line.split(';');
    let media_type = parts.next().unwrap_or_default().trim().to_ascii_lowercase();

    media_type == media_type_of(encoding)
        && parts.all(|parameter| {
            parameter.split_once('=').is_some_and(|(key, value)| {
                let value = value.trim().to_ascii_lowercase();

                key.trim().eq_ignore_ascii_case("charset")
                    && (value == "utf-8" || value == "\"utf-8\"")
            })
        })
}

// whether a request carries content: a length past 0, or a transfer coding (4.4, 10.1 step 8)
fn carries_content(fields: &Fields<'_>) -> bool {
    fields
        .header_of("content-length")
        .and_then(|length| length.trim().parse::<u64>().ok())
        .is_some_and(|length| length > 0)
        || fields.headers.contains_key("transfer-encoding")
}

// whether an `if-none-match` holds `etag`, weakly compared, or `*` (RFC 9110 §13.1.2)
fn matches_tag(fields: &Fields<'_>, etag: &str) -> bool {
    fields
        .lines_of("if-none-match")
        .join(",")
        .split(',')
        .any(|tag| {
            let trimmed = tag.trim();

            trimmed == "*" || trimmed.strip_prefix("W/").unwrap_or(trimmed) == etag
        })
}

// a `Bearer` token of an `authorization`'s value, as RFC 6750 §2.1 writes it
fn bearer_of(value: &str) -> Option<&str> {
    let scheme = value.get(..6)?;
    let rest = value.get(6..)?;

    if !scheme.eq_ignore_ascii_case("bearer") || !rest.starts_with([' ', '\t']) {
        return None;
    }

    let token = rest.trim_start_matches([' ', '\t']);

    (!token.is_empty()).then(|| token.trim())
}

// ── An exchange ───────────────────────────────────────────────────────────────────────────────

// what an exchange is judged and answered by, as its request's head said
struct Exchange {
    address: String,
    port: Option<u16>,
    is_http1: bool,
    is_head: bool,
    // whether its request carries content
    has_body: bool,
    // whether its body was read whole, so an answer leaves no rest of it to drop
    is_body_read: AtomicBool,
    // the origin `origins` names, which every answer once judged names
    listed: Mutex<Option<String>>,
    flow: Option<Arc<Flow>>,
    outlet: Outlet,
    ended: CancellationToken,
}

// what an exchange answers, before its head is asked for
enum Answer {
    Head { head: Head, body: HttpGatewayBody },
    // what HTTP refuses of its own: 400 unmarked, or over HTTP/2 a reset
    Malformed,
    // nothing written
    Cut,
}

// a whole answer: its status, its fields, its body, its mark
struct Reply {
    status: u16,
    fields: Vec<Field>,
    body: Option<Bytes>,
    reason: Option<&'static str>,
    // whether it writes none of a call's fields: the document's
    is_plain: bool,
}

impl Reply {
    const fn of(status: u16) -> Self {
        Self {
            status,
            fields: Vec::new(),
            body: None,
            reason: None,
            is_plain: false,
        }
    }
}

// a refusal of the gateway's own (7.7): its status, its mark, its words, its fields
struct Refusal {
    status: u16,
    reason: &'static str,
    detail: String,
    fields: Vec<ProblemField>,
}

impl Refusal {
    fn of(status: u16, (reason, detail): (&'static str, &str)) -> Self {
        Self {
            status,
            reason,
            detail: detail.to_owned(),
            fields: Vec::new(),
        }
    }

    fn retrying(mut self) -> Self {
        self.fields.push(ProblemField {
            name: "retry-after",
            value: "1".to_owned(),
        });
        self
    }

    fn allowing(mut self, methods: String) -> Self {
        self.fields.push(ProblemField {
            name: "allow",
            value: methods,
        });
        self
    }
}

// a route chosen for an exchange, and what its call is made of
struct Chosen<B> {
    index: usize,
    path: RawPath,
    query: Option<String>,
    body: B,
    // what a mounted gateway judges its body by
    judged: Option<BodyHead>,
    headers: ::http::HeaderMap,
}

// what a call ended with that is no result
enum Ended {
    Call(CallError),
    Form(MessageFormError),
    Text(CodecRefusal),
}

// what a call is answered by: its route, and what its problem says of its request
struct CallContext {
    gateway: Weak<Inner>,
    index: usize,
    credential: bool,
    encoding: Encoding,
    is_handed: AtomicBool,
}

// a result's body: its JSON text, or a native payload's bytes
enum Written {
    Text(String),
    Bytes(Bytes),
}

// a call or a stream held against its bounds, given back once
struct Admitted {
    gateway: Weak<Inner>,
    address: String,
    is_stream: bool,
    is_released: AtomicBool,
}

impl Admitted {
    fn release(&self) {
        if self.is_released.swap(true, Ordering::SeqCst) {
            return;
        }

        if let Some(inner) = self.gateway.upgrade() {
            let mut state = locked(&inner.state);
            let counts = if self.is_stream {
                &mut state.streams
            } else {
                &mut state.calls
            };

            counts.all = counts.all.saturating_sub(1);

            if let Some(held) = counts.by_address.get_mut(&self.address) {
                *held = held.saturating_sub(1);

                if *held == 0 {
                    counts.by_address.remove(&self.address);
                }
            }
        }
    }
}

// an exchange's connection: its client and its transport, closed once
struct Connection {
    client: Client,
    transport: MemoryTransportClient,
    ended: CancellationToken,
    is_closed: AtomicBool,
    runtime: Handle,
}

impl Connection {
    fn close(&self) {
        if self.is_closed.swap(true, Ordering::SeqCst) {
            return;
        }

        self.ended.cancel();
        drop(self.client.dispose());
        self.transport.close();
    }

    // closed from a turn of its own: what a stream's response tells runs under its stream's lock
    fn close_later(self: &Arc<Self>) {
        let connection = Arc::clone(self);

        drop(platform::spawn(&self.runtime, async move {
            connection.close();
        }));
    }
}

// what a head becomes, once its exchange gives it
struct Awaiting {
    outlet: Outlet,
    is_taken: bool,
}

impl Drop for Awaiting {
    fn drop(&mut self) {
        // * a response never asked for, or cut before its head: its exchange is over
        if !self.is_taken {
            self.outlet.shared().gone();
        }
    }
}

impl Inner {
    // what it reports, each listener within a guard: a panic is dropped (spec 15.1)
    fn report(&self, error: &RouterError) {
        for listener in self.listeners.all() {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(error))).ok();
        }
    }

    fn report_words(&self, words: &str) {
        self.report(&RouterError::Other(Arc::new(std::io::Error::other(
            words.to_owned(),
        ))));
    }

    // the client's address: its peer's, behind the proxies it names and counts, or `local`
    fn address_of(&self, (fields, peer): (&Fields<'_>, Option<SocketAddr>)) -> String {
        let Some(peer) = peer else {
            return "local".to_owned();
        };
        let forwarded = fields.lines_of("x-forwarded-for").join(", ");

        client_address_of(
            &peer.ip().to_string(),
            &ClientAddressOptions {
                forwarded: (!forwarded.is_empty()).then_some(forwarded.as_str()),
                trusted_proxies: Some(&self.settings.proxies),
            },
        )
    }

    // the routes whose templates match `path`, and the methods they take in 3.10's order
    fn routes_of(&self, path: Option<&RawPath>) -> (bool, Vec<&'static str>) {
        let Some(path) = path else {
            return (false, Vec::new());
        };
        let mut taken: Vec<&str> = Vec::new();
        let mut matches = false;

        for served in &self.settings.served {
            if route_index_of([&served.template], path).is_some() {
                matches = true;
                taken.push(served.method.as_str());

                if served.method == HttpMethod::Get {
                    taken.push("HEAD");
                }
            }
        }

        (
            matches,
            METHOD_ORDER
                .into_iter()
                .filter(|method| taken.contains(method))
                .collect(),
        )
    }

    // the route of `method` that answers `path` by 3.5's precedence, `HEAD` as its `GET`
    fn chosen_of(&self, (path, method): (&RawPath, &str)) -> Option<usize> {
        let asked = if method == "HEAD" { "GET" } else { method };
        let of_method: Vec<usize> = self
            .settings
            .served
            .iter()
            .enumerate()
            .filter(|(_, served)| served.method.as_str() == asked)
            .map(|(index, _)| index)
            .collect();
        let templates = of_method
            .iter()
            .filter_map(|index| self.settings.served.get(*index))
            .map(|served| &served.template);

        route_index_of(templates, path).and_then(|found| of_method.get(found).copied())
    }

    // a response's outlet, held to the gateway's bounds, its socket's flow on its own listener
    fn outlet_of(
        &self,
        flow: Option<&Arc<Flow>>,
    ) -> (Outlet, tokio::sync::oneshot::Receiver<Committed>) {
        let reporting = Weak::clone(&self.me);

        Outlet::new(OutletSettings {
            maximum_unsent_bytes: self.settings.maximum_unsent_bytes,
            pace: self.settings.pace,
            platform: Arc::clone(&self.platform),
            flow: flow.cloned(),
            report: Arc::new(move |error| {
                if let Some(inner) = reporting.upgrade() {
                    inner.report(&error);
                }
            }),
        })
    }

    // ── Writing ───────────────────────────────────────────────────────────────────────────────

    // a head of `status`: the fields every answer carries, or the document's, then `fields`, then
    // the origin `origins` names
    fn head_of(exchange: &Exchange, (status, fields): (u16, Vec<Field>)) -> Head {
        let mut head: Vec<Field> = RESPONSE_FIELDS
            .iter()
            .map(|(name, value)| Field::of(*name, (*value).to_owned()))
            .collect();

        head.extend(fields);

        let listed = locked(&exchange.listed).clone();

        if let Some(listed) = listed {
            head.push(Field::of("access-control-allow-origin", listed));
            head.push(Field::of("access-control-expose-headers", "*".to_owned()));
        }

        Head {
            status,
            fields: head,
        }
    }

    // writes an exchange's whole answer: its fields, and its body unless it answers a `HEAD`;
    // over HTTP/1, a body it did not read whole closes its socket, lest its rest read as the next
    // request
    fn reply(&self, (exchange, reply): (&Exchange, Reply)) {
        let mut fields = reply.fields;

        if let Some(body) = &reply.body {
            fields.push(Field::of("content-length", body.len().to_string()));
        }

        if let Some(reason) = reply.reason {
            fields.push(Field::of(REFUSAL_HEADER, reason.to_owned()));
        }

        if exchange.is_http1 && exchange.has_body && !exchange.is_body_read.load(Ordering::SeqCst) {
            if let Some(flow) = &exchange.flow {
                flow.linger();
            }

            fields.push(Field::of("connection", "close".to_owned()));
        }

        let mut head = Self::head_of(exchange, (reply.status, fields));

        if reply.is_plain {
            head.fields
                .retain(|field| !(field.name == "cache-control" && field.value == "no-store"));
        }

        let outlet = exchange.outlet.clone();

        outlet.head(head);

        let Some(body) = reply
            .body
            .filter(|body| !body.is_empty() && !exchange.is_head)
        else {
            outlet.end();

            return;
        };

        if body.len() <= SLICE_BYTES {
            drop(outlet.write(body));
            outlet.end();

            return;
        }

        // * one slice after the one before it was taken, each its own deadline (10.2)
        drop(platform::spawn(&self.runtime, async move {
            let mut rest = body;

            while !rest.is_empty() {
                let length = rest.len().min(SLICE_BYTES);
                let slice = rest.split_to(length);

                if !outlet.write(slice).await {
                    return;
                }
            }

            outlet.end();
        }));
    }

    // answers a problem: a call's failure, or a refusal of the gateway's own, marked by its reason
    fn answer_problem(
        &self,
        (exchange, problem): (&Exchange, Problem),
        reason: Option<&'static str>,
    ) {
        let mut fields: Vec<Field> = problem
            .fields
            .into_iter()
            .map(|field| Field::of(field.name, field.value))
            .collect();

        fields.push(Field::of("content-type", PROBLEM_MEDIA_TYPE.to_owned()));
        self.reply((
            exchange,
            Reply {
                status: problem.status,
                fields,
                body: Some(Bytes::from(problem.body)),
                reason,
                is_plain: false,
            },
        ));
    }

    // refuses an exchange as one of the gateway's own (7.7), `about:blank`, its words its detail
    fn refuse(&self, exchange: &Exchange, refusal: Refusal) {
        let mut problem = problem_of_refusal(refusal.status, &refusal.detail);

        problem.fields = refusal.fields;
        self.answer_problem((exchange, problem), Some(refusal.reason));
    }

    fn own_problem(&self, own: OwnFailure, detail: &str) -> Problem {
        problem_of_own(
            own,
            detail,
            &OwnProblemOptions {
                challenge: self.settings.challenge.clone(),
            },
        )
    }

    // ── The gates ─────────────────────────────────────────────────────────────────────────────

    // an exchange of `request` from `peer`, judged in 10.1's order, then served; what its head
    // comes to
    fn exchange<B>(
        self: &Arc<Self>,
        request: Request<B>,
        (peer, flow): (Option<SocketAddr>, Option<Arc<Flow>>),
    ) -> BoxFuture<Answer>
    where
        B: Body<Data = Bytes> + Send + 'static,
        B::Error: Into<Box<dyn Error + Send + Sync>>,
    {
        let (parts, body) = request.into_parts();
        let fields = Fields {
            is_http1: parts.version < Version::HTTP_2,
            is_http11: parts.version == Version::HTTP_11,
            method: &parts.method,
            uri: &parts.uri,
            headers: &parts.headers,
        };
        let target = fields.target();

        // 1: what HTTP refuses of its own, unmarked: a field or a target past visible ASCII
        let is_visible = fields
            .raw_fields()
            .is_some_and(|raw| has_visible_fields(&raw))
            && is_visible_target(Some(&target));
        let authority = is_visible.then(|| fields.authority(&target)).flatten();
        let named = request_target_of(Some(&target));
        let (Some(authority), Some(named)) = (authority, named) else {
            return Box::pin(async { Answer::Malformed });
        };
        let authority = authority.authority.map(str::to_owned);
        let (outlet, committed) = self.outlet_of(flow.as_ref());
        let ended = CancellationToken::new();
        let id = {
            let mut state = locked(&self.state);

            state.next = state.next.saturating_add(1);

            let id = state.next;

            state.live.insert(
                id,
                Live {
                    ended: ended.clone(),
                    outlet: outlet.clone(),
                },
            );
            id
        };
        let gone = Weak::clone(&self.me);
        let ending = ended.clone();

        outlet.on_gone(Box::new(move || {
            ending.cancel();

            if let Some(inner) = gone.upgrade() {
                locked(&inner.state).live.remove(&id);
            }
        }));

        let exchange = Arc::new(Exchange {
            address: self.address_of((&fields, peer)),
            port: peer.map(|peer| peer.port()),
            is_http1: fields.is_http1,
            is_head: parts.method == Method::HEAD,
            has_body: carries_content(&fields),
            is_body_read: AtomicBool::new(false),
            listed: Mutex::new(None),
            flow,
            outlet: outlet.clone(),
            ended,
        });
        let awaiting = Awaiting {
            outlet,
            is_taken: false,
        };
        let query = target.contains('?').then(|| named.query.to_owned());
        let path_text = named.path.to_owned();

        if let Some((index, path, query)) = self.judge(
            (&exchange, &fields),
            (authority.as_deref(), (path_text, query)),
        ) {
            let judged = flow_judged(&exchange, &fields);
            let chosen = Chosen {
                index,
                path,
                query,
                body,
                judged,
                headers: parts.headers.clone(),
            };
            let inner = Arc::clone(self);
            let served = Arc::clone(&exchange);

            drop(platform::spawn(&self.runtime, async move {
                inner.serve((served, chosen)).await;
            }));
        }

        Box::pin(async move {
            let mut awaiting = awaiting;
            let answer = match committed.await {
                Ok(Committed::Head(head)) => {
                    awaiting.is_taken = true;

                    Answer::Head {
                        head,
                        body: HttpGatewayBody::over(awaiting.outlet.shared()),
                    }
                }
                Ok(Committed::Cut) | Err(_) => Answer::Cut,
            };

            drop(awaiting);
            answer
        })
    }

    // 10.1's steps 2 to 7: each refusal answered here, and the route chosen given
    #[expect(
        clippy::too_many_lines,
        reason = "10.1's gates in their order, as the other sides judge them"
    )]
    fn judge(
        &self,
        (exchange, fields): (&Exchange, &Fields<'_>),
        (authority, (path_text, query)): (Option<&str>, (String, Option<String>)),
    ) -> Option<ChosenRoute> {
        let hosts = &self.settings.hosts;
        let is_document = self.settings.document.is_some() && path_text == DOCUMENT_PATH;
        let path = raw_path_of(&path_text);
        let (matches, methods) = if is_document {
            (true, vec!["GET", "HEAD"])
        } else {
            self.routes_of(path.as_ref())
        };

        // 2: its host
        if !is_taken_host(authority, hosts) {
            self.refuse(
                exchange,
                Refusal::of(403, (HTTP_REFUSALS.host, "a host it does not take")),
            );

            return None;
        }

        // 3: its path
        if !matches {
            self.refuse(
                exchange,
                Refusal::of(404, (HTTP_REFUSALS.path, "a path no route matches")),
            );

            return None;
        }

        // 4: its origin
        let origin = fields.header_of("origin");
        let origins = &self.settings.origins;

        if !is_taken_origin(
            origin,
            &TakenOrigins::new(own_authority_of(authority, hosts), origins),
        ) {
            self.refuse(
                exchange,
                Refusal::of(
                    403,
                    (HTTP_REFUSALS.origin, "an origin neither its own nor listed"),
                ),
            );

            return None;
        }

        if is_listed_origin(origin, origins) {
            *locked(&exchange.listed) = origin.map(str::to_owned);
        }

        let method = fields.method.as_str();

        // 5: a request of no origin from another site, but a GET navigation no `object` or
        // `embed` makes, to what reads alone (web.dev's resource isolation policy)
        let site = fields.header_of("sec-fetch-site");

        if origin.is_none() && matches!(site, Some("same-site" | "cross-site")) {
            let destination = fields.header_of("sec-fetch-dest");
            let is_navigation = fields.header_of("sec-fetch-mode") == Some("navigate")
                && method == "GET"
                && !matches!(destination, Some("object" | "embed"));
            let is_navigable = is_document
                || (is_navigation
                    && path
                        .as_ref()
                        .and_then(|path| self.chosen_of((path, "GET")))
                        .and_then(|index| self.settings.served.get(index))
                        .is_some_and(|served| served.is_navigable));

            if !is_navigation || !is_navigable {
                self.refuse(
                    exchange,
                    Refusal::of(
                        403,
                        (
                            HTTP_REFUSALS.origin,
                            "a request from a page of another site that shows no origin",
                        ),
                    ),
                );

                return None;
            }
        }

        // 6: a preflight from an origin `origins` names
        if method == "OPTIONS"
            && fields.header_of("access-control-request-method").is_some()
            && is_listed_origin(origin, origins)
        {
            let asked = fields.lines_of("access-control-request-headers").join(", ");
            let mut allowed = vec!["authorization"];

            if !asked.is_empty() {
                allowed.push(&asked);
            }

            allowed.push("*");

            let mut reply = Reply::of(204);

            reply.fields = vec![
                Field::of("access-control-allow-headers", allowed.join(", ")),
                Field::of("access-control-allow-methods", methods.join(", ")),
                Field::of("access-control-max-age", PREFLIGHT_MAX_AGE.to_owned()),
            ];
            self.reply((exchange, reply));

            return None;
        }

        // 7: its method
        if is_document {
            self.serve_document((exchange, fields), method);

            return None;
        }

        let chosen = path
            .as_ref()
            .and_then(|path| self.chosen_of((path, method)));

        let (Some(index), Some(path)) = (chosen, path) else {
            self.refuse(
                exchange,
                Refusal::of(
                    405,
                    (HTTP_REFUSALS.method, "a method no route of its path takes"),
                )
                .allowing(methods.join(", ")),
            );

            return None;
        };

        Some((index, path, query))
    }

    // serves the document (11.1): `GET` and `HEAD`, its tag, and a 304 to a request that holds it
    fn serve_document(&self, (exchange, fields): (&Exchange, &Fields<'_>), method: &str) {
        let Some(document) = &self.settings.document else {
            return;
        };

        if method != "GET" && method != "HEAD" {
            self.refuse(
                exchange,
                Refusal::of(
                    405,
                    (HTTP_REFUSALS.method, "a method the document takes none of"),
                )
                .allowing("GET, HEAD".to_owned()),
            );

            return;
        }

        if exchange.has_body {
            self.refuse(
                exchange,
                Refusal::of(400, (HTTP_REFUSALS.malformed, "content to the document")),
            );

            return;
        }

        exchange.is_body_read.store(true, Ordering::SeqCst);

        let mut fields_of = vec![
            Field::of("cache-control", "no-cache".to_owned()),
            Field::of("etag", document.etag.clone()),
        ];

        if matches_tag(fields, &document.etag) {
            let mut reply = Reply::of(304);

            reply.fields = fields_of;
            reply.is_plain = true;
            self.reply((exchange, reply));

            return;
        }

        fields_of.push(Field::of("content-type", "application/json".to_owned()));
        self.reply((
            exchange,
            Reply {
                status: 200,
                fields: fields_of,
                body: Some(document.bytes.clone()),
                reason: None,
                is_plain: true,
            },
        ));
    }

    // a call or a stream held against its bounds (10.3): its place, or the words of the bound it
    // is past
    fn admit(&self, (address, is_stream): (&str, bool)) -> Result<Admitted, &'static str> {
        let settings = &self.settings;
        let (most, most_per_address) = if is_stream {
            (
                settings.maximum_connections,
                settings.maximum_connections_per_address,
            )
        } else {
            (
                settings.maximum_exchanges,
                settings.maximum_exchanges_per_address,
            )
        };
        let mut state = locked(&self.state);
        let counts = if is_stream {
            &mut state.streams
        } else {
            &mut state.calls
        };
        let held = counts.by_address.get(address).copied().unwrap_or(0);

        if counts.all >= most {
            return Err(if is_stream {
                "the streams under way hold maximumConnections"
            } else {
                "the calls under way hold maximumExchanges"
            });
        }

        if held >= most_per_address {
            return Err(if is_stream {
                "the streams of its address hold maximumConnectionsPerAddress"
            } else {
                "the calls of its address hold maximumExchangesPerAddress"
            });
        }

        counts.all = counts.all.saturating_add(1);
        counts
            .by_address
            .insert(address.to_owned(), held.saturating_add(1));

        Ok(Admitted {
            gateway: Weak::clone(&self.me),
            address: address.to_owned(),
            is_stream,
            is_released: AtomicBool::new(false),
        })
    }

    // the credential a call presents of a request's `authorization` (2.4), or the refusal it is
    fn credential_from(&self, fields: &Fields<'_>) -> Result<Option<RequestCredential>, Problem> {
        let lines = fields.lines_of("authorization");
        let Some(value) = credential_of(&lines) else {
            return Ok(None);
        };

        if self.settings.authorization == GatewayAuthorization::Elsewhere {
            return Ok(Some(RequestCredential::Elsewhere(value.to_owned())));
        }

        let Some(token) = bearer_of(value) else {
            return Err(self.own_problem(OwnFailure::Scheme, "an auth-scheme but Bearer"));
        };

        if token.len() > JWT_BYTES {
            return Err(
                self.own_problem(OwnFailure::Jwt, &format!("a token past {JWT_BYTES} bytes"))
            );
        }

        Ok(Some(RequestCredential::Jwt(token.to_owned())))
    }

    // the taken body's answer (7.6.27): a failure of its own, its words reported, never in its
    // problem; over HTTP/1 its connection closed, since what is left of the body is never read
    fn refuse_taken(&self, exchange: &Exchange) {
        self.report_words("a body read before the gateway took its request");
        exchange.is_body_read.store(false, Ordering::SeqCst);
        self.answer_problem((exchange, self.own_problem(OwnFailure::Failed, "")), None);
    }

    // serves an exchange its routes take, past the gates of 10.1's steps 8 to 11
    #[expect(
        clippy::too_many_lines,
        reason = "10.1's steps 8 to 11 and the call, in their order, as the other sides serve them"
    )]
    async fn serve<B>(self: Arc<Self>, (exchange, chosen): (Arc<Exchange>, Chosen<B>))
    where
        B: Body<Data = Bytes> + Send + 'static,
        B::Error: Into<Box<dyn Error + Send + Sync>>,
    {
        let Chosen {
            index,
            path,
            query,
            body,
            judged,
            headers,
        } = chosen;
        let Some(served) = self.settings.served.get(index) else {
            return;
        };
        let template = served.template();
        let route = &served.route;
        let method = Method::GET;
        let uri = ::http::Uri::default();
        let fields = Fields {
            is_http1: exchange.is_http1,
            is_http11: exchange.is_http1,
            method: &method,
            uri: &uri,
            headers: &headers,
        };
        let encoding = encoding_of(route.request());
        let takes_body = template.body.is_some();

        // 8: its type, or content where its route takes none
        if takes_body && !is_taken_type(&fields, encoding) {
            return self.refuse(
                &exchange,
                Refusal::of(
                    415,
                    (
                        HTTP_REFUSALS.type_refused,
                        &format!(
                            "this route's body is {}, unencoded",
                            media_type_of(encoding)
                        ),
                    ),
                ),
            );
        }

        if !takes_body && exchange.has_body {
            return self.refuse(
                &exchange,
                Refusal::of(
                    400,
                    (
                        HTTP_REFUSALS.malformed,
                        "content to a route that takes none",
                    ),
                ),
            );
        }

        // 9: its fields and its bounds
        if fields.lines_of("authorization").len() > 1 {
            return self.refuse(
                &exchange,
                Refusal::of(400, (HTTP_REFUSALS.malformed, "two authorization fields")),
            );
        }

        let maximum = self.settings.maximum_body_bytes;

        if fields
            .header_of("content-length")
            .and_then(|length| length.trim().parse::<u64>().ok())
            .is_some_and(|declared| declared > maximum)
        {
            return self.refuse(
                &exchange,
                Refusal::of(
                    413,
                    (
                        HTTP_REFUSALS.too_large,
                        &format!("a body declared past maximumBodyBytes {maximum}"),
                    ),
                ),
            );
        }

        let is_stream = route.notification().is_some() && asks_stream(&fields);
        let admitted = match self.admit((&exchange.address, is_stream)) {
            Ok(admitted) => Arc::new(admitted),
            Err(words) => {
                return self.refuse(
                    &exchange,
                    Refusal::of(503, (HTTP_REFUSALS.busy, words)).retrying(),
                );
            }
        };
        let releasing = Arc::clone(&admitted);

        exchange
            .outlet
            .on_gone(Box::new(move || releasing.release()));

        if is_stream && fields.header_of("last-event-id").is_some() {
            admitted.release();

            return self.reply((&exchange, Reply::of(204)));
        }

        // 10: its body as it comes, none of it read before by the server it is mounted on, judged
        // before its first byte is awaited
        if takes_body
            && judged
                .as_ref()
                .is_some_and(|head| is_taken_before(&body, head))
        {
            return self.refuse_taken(&exchange);
        }

        let read = if takes_body {
            let reading = Reading {
                maximum_body_bytes: maximum,
                body_bytes_budget: self.settings.body_bytes_budget,
                budget: Arc::clone(&self.budget),
                minimum_body_bytes_per_second: self.settings.minimum_body_bytes_per_second,
                body_grace_period: self.settings.body_grace_period,
                clock: Arc::clone(&self.clock),
                ended: exchange.ended.clone(),
                judged,
            };

            match read_body(body, &reading).await {
                Ok(read) => Some(read),
                Err(unread) => return self.unread(&exchange, &unread),
            }
        } else {
            drop(body);

            None
        };

        exchange.is_body_read.store(true, Ordering::SeqCst);

        let credential = match self.credential_from(&fields) {
            Ok(credential) => credential,
            Err(problem) => return self.answer_problem((&exchange, problem), None),
        };

        // 11: its binding and its reading
        let payload = match bound_of(served, (&path, (query.as_deref(), read.as_ref()))) {
            Ok(payload) => payload,
            Err(MessageFormError::Form(refused)) => {
                // * the mapping's own words of the client's own request, and where the request
                // carried what it refuses, cut, never in its words (7.4)
                let problem = problem_of_failure(
                    &CallFailure {
                        arose: Arose::Gateway,
                        code: ProtocolCode::PAYLOAD_UNDECODABLE.get(),
                        scope: FailureScope::Protocol,
                        // ! a detail of the side's own words: the mapping's own, fixed in
                        // transcoding.json
                        detail: refused.reason().to_owned(),
                        credential: false,
                        encoding,
                        place: refused.place().cloned(),
                    },
                    &ProblemOptions {
                        challenge: self.settings.challenge.as_deref(),
                        ..ProblemOptions::default()
                    },
                );

                return self.answer_problem((&exchange, problem), None);
            }
            Err(other) => {
                // ! what no gate foresaw, a variable that names no field of its message or a
                // message its stock library does not encode: its words are reported, never the
                // gateway's
                self.report(&RouterError::Other(Arc::new(other)));

                let problem = self.own_problem(OwnFailure::Failed, "");

                return self.answer_problem((&exchange, problem), None);
            }
        };

        let context = Arc::new(CallContext {
            gateway: Weak::clone(&self.me),
            index,
            credential: credential.is_some(),
            encoding,
            is_handed: AtomicBool::new(false),
        });

        self.call(
            (&exchange, &context),
            ((payload, credential), (is_stream, admitted)),
        )
        .await;
    }

    // a body that read no whole, answered by why
    fn unread(&self, exchange: &Exchange, unread: &Unread) {
        match unread {
            Unread::TooLarge => self.refuse(
                exchange,
                Refusal::of(
                    413,
                    (
                        HTTP_REFUSALS.too_large,
                        &format!(
                            "a body past maximumBodyBytes {}",
                            self.settings.maximum_body_bytes
                        ),
                    ),
                ),
            ),
            Unread::Busy => self.refuse(
                exchange,
                Refusal::of(
                    503,
                    (
                        HTTP_REFUSALS.busy,
                        "the bodies under way hold bodyBytesBudget",
                    ),
                )
                .retrying(),
            ),
            Unread::TooSlow => self.refuse(
                exchange,
                Refusal::of(
                    408,
                    (
                        HTTP_REFUSALS.too_slow,
                        "a body slower than minimumBodyBytesPerSecond",
                    ),
                ),
            ),
            Unread::Taken => self.refuse_taken(exchange),
            Unread::Gone => exchange.outlet.cut(None),
            // * what HTTP cannot frame, answered as HTTP answers it, unmarked, its socket closed,
            // as the HTTP transport answers a malformed chunk
            Unread::Malformed => {
                if let Some(flow) = &exchange.flow {
                    flow.linger();
                }

                exchange.outlet.head(Head {
                    status: 400,
                    fields: malformed_fields().into(),
                });
                exchange.outlet.end();
            }
        }
    }

    // one Bead connection for this exchange, closed as its response ends (2.1); its client
    // declares no resolver: a command its server sends is answered SERVICE_UNKNOWN (2.6)
    async fn connected(&self, exchange: &Exchange) -> Result<Arc<Connection>, Option<Problem>> {
        let transport_options = MemoryTransportClientOptions {
            clock: Some(Arc::clone(&self.clock)),
        };

        let failed = |error: &dyn fmt::Display| {
            self.report_words(&error.to_string());

            Some(self.own_problem(OwnFailure::Failed, ""))
        };
        let transport =
            MemoryTransportClient::new(&transport_options).map_err(|error| failed(&error))?;
        let client_options = ClientOptions {
            runtime: Some(self.runtime.clone()),
            limits: self.settings.limits.clone(),
            ..ClientOptions::default()
        };

        let client = Client::new(Arc::new(transport.clone()), &client_options)
            .map_err(|error| failed(&error))?;
        let connection = Arc::new(Connection {
            client,
            transport: transport.clone(),
            ended: exchange.ended.child_token(),
            is_closed: AtomicBool::new(false),
            runtime: self.runtime.clone(),
        });
        let closing = Arc::clone(&connection);

        exchange.outlet.on_gone(Box::new(move || closing.close()));

        let mut connect = MemoryTransportClientConnectOptions::new(self.settings.transport.clone());

        connect.address = Some(exchange.address.clone());
        connect.port = exchange.port;
        connect.signal = Some(exchange.ended.child_token());

        match transport.connect(&connect).await {
            Ok(()) => Ok(connection),
            Err(_) if exchange.ended.is_cancelled() => {
                connection.close();

                Err(None)
            }
            Err(error) => {
                connection.close();

                // ! the in-memory transport's words tell of the gateway's inside, never its
                // client's request
                self.report(&RouterError::Other(Arc::new(error.clone())));

                // * a connection its server would not draw, in time or at all, is 503; anything
                // else, what no gate foresaw
                Err(Some(
                    if matches!(
                        error,
                        TransportError::Connect(_) | TransportError::TimedOut(_)
                    ) {
                        problem_of_failure(
                            &CallFailure {
                                arose: Arose::Client,
                                code: ProtocolCode::DESTINATION_UNREACHABLE.get(),
                                scope: FailureScope::Protocol,
                                detail: String::new(),
                                credential: false,
                                encoding: Encoding::Proto,
                                place: None,
                            },
                            &ProblemOptions {
                                challenge: self.settings.challenge.as_deref(),
                                ..ProblemOptions::default()
                            },
                        )
                    } else {
                        self.own_problem(OwnFailure::Failed, "")
                    },
                ))
            }
        }
    }

    // the call itself, and its answer: a result's body, a stream's events, or a problem
    #[expect(
        clippy::too_many_lines,
        reason = "a call and its stream, as the other sides make them"
    )]
    async fn call(
        &self,
        (exchange, context): (&Arc<Exchange>, &Arc<CallContext>),
        ((payload, credential), (is_stream, admitted)): (
            (Bytes, Option<RequestCredential>),
            (bool, Arc<Admitted>),
        ),
    ) {
        let connection = match self.connected(exchange).await {
            Ok(connection) => connection,
            Err(problem) => {
                if let Some(problem) = problem {
                    self.answer_problem((exchange, problem), None);
                }

                return;
            }
        };
        let Some(served) = self.settings.served.get(context.index) else {
            return;
        };
        let route = &served.route;
        let procedure = route.procedure().procedure().clone();
        let subscribed: Option<Arc<Subscribed>> = if is_stream {
            let sink = Sink {
                gateway: Weak::clone(&self.me),
                exchange: Arc::clone(exchange),
                connection: Arc::clone(&connection),
                admitted: Arc::clone(&admitted),
                is_gone: Arc::new(AtomicBool::new(false)),
            };
            let stream = EventStream::new(
                Box::new(sink),
                EventHeartbeat {
                    clock: Arc::clone(&self.clock),
                    every: self.settings.heartbeat,
                },
            );
            let closing = stream.clone();

            exchange.outlet.on_gone(Box::new(move || closing.close()));

            let notification = Arc::new(Subscribed {
                procedure: procedure.clone(),
                window: self.settings.window,
                stream,
                context: Arc::clone(context),
                ending: Mutex::new(Ending::default()),
            });
            let held: Arc<Subscribed> = Arc::clone(&notification);
            let registered: Arc<dyn NotificationLike> = held;

            if let Err(error) = connection.client.router().register_notification(registered) {
                self.report(&RouterError::Other(Arc::new(error)));
                self.answer_problem((exchange, self.own_problem(OwnFailure::Failed, "")), None);
                connection.close();

                return;
            }

            Some(notification)
        } else {
            None
        };

        let mut options = ResolvedRequestOptions::new(self.settings.timeout);

        options.credential = credential;
        options.signal = Some(connection.ended.child_token());

        let mut request = RouterRequest::new(procedure, &options);
        let handed = Arc::clone(context);

        request.on_sent = Some(Box::new(move |is_handed| {
            handed.is_handed.store(is_handed, Ordering::SeqCst);
        }));
        request.subscribes = subscribed
            .as_ref()
            .map(|notification| -> Arc<dyn NotificationLike> {
                let held: Arc<Subscribed> = Arc::clone(notification);

                held
            });

        let outcome = match connection.client.router().request(payload, request) {
            Ok(call) => call.await,
            Err(error) => Err(CallError::Refused(error)),
        };
        let written = outcome
            .map_err(Ended::Call)
            .and_then(|result| context.written_of((&result.payload, false)));

        match (written, &subscribed) {
            (Err(ended), None) => {
                if let Some(problem) = context.problem_of(&ended) {
                    self.answer_problem((exchange, problem), None);
                }

                connection.close();
            }
            (Err(ended), Some(notification)) => {
                if let Some(problem) = context.problem_of(&ended) {
                    notification.stream.failure(problem);
                }

                notification.settle();
                connection.close();
            }
            (Ok(written), Some(notification)) => {
                let data = match written {
                    Written::Text(text) => Ok(text),
                    Written::Bytes(bytes) => context.data_of_native((&bytes, false)),
                };

                match data {
                    Ok(data) => {
                        // * a stream its client ended takes no result; the end held, after it
                        if !notification.stream.is_ended() {
                            notification.stream.result(data).ok();
                        }
                    }
                    Err(ended) => {
                        if let Some(problem) = context.problem_of(&ended) {
                            notification.stream.failure(problem);
                        }
                    }
                }

                notification.settle();

                // * a HEAD ends at its head, its subscription with it (8.1)
                if exchange.is_head {
                    notification.stream.close();
                    connection.close();
                }
            }
            (Ok(written), None) => {
                let result_encoding = encoding_of(route.result());
                let body = match written {
                    Written::Text(text) => Bytes::from(text),
                    Written::Bytes(bytes) => bytes,
                };

                self.reply((
                    exchange,
                    Reply {
                        status: 200,
                        fields: vec![Field::of(
                            "content-type",
                            result_media_type_of(result_encoding).to_owned(),
                        )],
                        body: Some(body),
                        reason: None,
                        is_plain: false,
                    },
                ));
                connection.close();
            }
        }
    }

    // an exchange on its own listener, its answer the wire's: its body handed to hyper as it
    // comes, its flow settled as hyper lets it go
    fn own(
        self: &Arc<Self>,
        (request, flow): (Request<Incoming>, Arc<Flow>),
        peer: SocketAddr,
    ) -> Answered {
        let answered = self.exchange(request, (Some(peer), Some(Arc::clone(&flow))));

        Box::pin(async move {
            match answered.await {
                Answer::Head { head, body } => {
                    let given = AnswerBody::given(Box::pin(OwnBody(body))).settling(&flow);
                    let mut response = Response::new(given);

                    *response.status_mut() = ::http::StatusCode::from_u16(head.status)
                        .unwrap_or(::http::StatusCode::INTERNAL_SERVER_ERROR);
                    fields_into(&mut response, &head.fields);
                    flow.answer_begun();

                    Ok(response)
                }
                Answer::Malformed => {
                    let mut response = Response::new(AnswerBody::whole(None).settling(&flow));

                    *response.status_mut() = ::http::StatusCode::BAD_REQUEST;
                    fields_into(&mut response, &malformed_fields());
                    response.extensions_mut().insert(Malformed);

                    Ok(response)
                }
                Answer::Cut => Err(Cut),
            }
        })
    }

    // serves one socket accepted, each of its requests an exchange, until it ends
    async fn serve_socket(self: Arc<Self>, (socket, peer): (TcpStream, SocketAddr)) {
        let flow = Arc::new(Flow::default());
        let key = {
            let mut state = locked(&self.state);

            state.next_flow = state.next_flow.saturating_add(1);

            let key = state.next_flow;

            state.flows.insert(key, Arc::clone(&flow));

            let is_listening = state.is_listening;

            drop(state);

            // ! a socket accepted as its stop began is let go with the others
            if !is_listening {
                flow.stop();
            }

            key
        };
        let gateway = Weak::clone(&self.me);
        let options = WireOptions {
            runtime: self.runtime.clone(),
            platform: Arc::clone(&self.platform),
            headers_timeout: self.settings.headers_timeout,
            tls: self.settings.tls.clone(),
        };

        serve(
            (socket, flow),
            (
                options,
                move |request: Request<Incoming>, flow: &Arc<Flow>| match gateway.upgrade() {
                    Some(inner) => inner.own((request, Arc::clone(flow)), peer),
                    None => Box::pin(async { Err(Cut) }),
                },
            ),
        )
        .await;

        locked(&self.state).flows.remove(&key);
    }

    // binds where `options` says, and serves what comes there
    fn listen(
        self: &Arc<Self>,
        options: &TransportServerStartOptions,
    ) -> Result<TransportServerAddress, RouterError> {
        let Bound { listeners, address } = bind(&self.runtime, options)?;
        let listening: Vec<Listening> = listeners
            .into_iter()
            .map(|listener| {
                let gateway = Weak::clone(&self.me);
                let reporting = Weak::clone(&self.me);

                accepting(
                    &self.runtime,
                    Acceptance {
                        listener,
                        take: move |accepted, _serving: &Arc<AtomicBool>| {
                            let Some(inner) = gateway.upgrade() else {
                                return false;
                            };
                            let runtime = inner.runtime.clone();

                            drop(platform::spawn(&runtime, inner.serve_socket(accepted)));

                            true
                        },
                        platform: Arc::clone(&self.platform),
                        report: Box::new(move |error| {
                            if let Some(inner) = reporting.upgrade() {
                                inner.report(&io_error(error));
                            }
                        }),
                    },
                )
            })
            .collect();

        locked(&self.state).listening.extend(listening);

        Ok(address)
    }

    // its stop's body: no listener from now, every exchange under way ended, each socket ended
    // once what it answers went
    fn stopping(&self) -> BoxFuture<Result<(), RouterError>> {
        let mut state = locked(&self.state);

        state.is_listening = false;

        let listening: Vec<Listening> = core::mem::take(&mut state.listening);
        let live: Vec<Live> = state.live.drain().map(|(_, live)| live).collect();
        let flows: Vec<Arc<Flow>> = state.flows.values().cloned().collect();

        drop(state);

        for listener in &listening {
            listener.let_go();
        }

        for each in live {
            each.ended.cancel();
            each.outlet.cut(None);
        }

        for flow in &flows {
            flow.stop();
        }

        Box::pin(async move {
            for listener in listening {
                listener.ended().await;
            }

            Ok(())
        })
    }
}

// a mounted gateway's body head, which it judges a body read before it by; none on its own
// listener, where no reader comes before it
fn flow_judged(exchange: &Exchange, fields: &Fields<'_>) -> Option<BodyHead> {
    exchange.flow.is_none().then(|| BodyHead {
        declared: fields
            .header_of("content-length")
            .and_then(|length| length.trim().parse::<u64>().ok()),
        is_coded: fields.headers.contains_key("transfer-encoding"),
        is_http2: !fields.is_http1,
    })
}

// what a route chosen gives its serving: its place in the table, its path, its query
type ChosenRoute = (usize, RawPath, Option<String>);

// ── Serving ───────────────────────────────────────────────────────────────────────────────────

// a request's payload, bound from its route (11): a message's by its form, a native one its body
// whole, a query beside it refused
fn bound_of(
    served: &Served,
    (path, (query, body)): (&RawPath, (Option<&str>, Option<&Bytes>)),
) -> Result<Bytes, MessageFormError> {
    let variables = variables_of(&served.template, path).map_err(|refusal| {
        MessageFormError::Form(
            JsonFormError::new(refusal.reason).at(RequestPlace::Parameter(refusal.field_path)),
        )
    })?;
    let template = served.template();

    if let Some(form) = served.route.request().form() {
        let mut options = crate::transcoding::form::BindingOptions::new(&variables);

        options.body = body.map(Bytes::as_ref);
        options.is_patch = Some(template.method == HttpMethod::Patch);
        options.query = query;
        options.route_body = template.body.as_deref();

        return form.bind(&options);
    }

    // * a query of empty sequences alone, `?&`, carries no parameter, as a message's binds none
    if query.is_some_and(|query| query.split('&').any(|sequence| !sequence.is_empty())) {
        return Err(MessageFormError::Form(JsonFormError::new(
            "a query beside a body of the whole request",
        )));
    }

    Ok(body.cloned().unwrap_or_default())
}

impl CallContext {
    fn served<'a>(&self, inner: &'a Inner) -> Option<&'a Served> {
        inner.settings.served.get(self.index)
    }

    // a payload's JSON, or its bytes, as a result's body or a notification's (5.1, 5.6, 5.8)
    fn written_of(&self, (bytes, is_notification): (&Bytes, bool)) -> Result<Written, Ended> {
        let Some(inner) = self.gateway.upgrade() else {
            return Err(Ended::Call(CallError::Disconnected(
                "the gateway is gone".to_owned(),
            )));
        };
        let Some(served) = self.served(&inner) else {
            return Err(Ended::Call(CallError::Disconnected(
                "the gateway is gone".to_owned(),
            )));
        };
        let payload = if is_notification {
            served.route.notification()
        } else {
            Some(served.route.result())
        };

        match payload {
            // * a text one read as spec 17.4 reads it: what refuses it is the answer's
            Some(HttpPayload::Text) => {
                TextCodec.decode(bytes).map_err(Ended::Text)?;

                Ok(Written::Bytes(bytes.clone()))
            }
            Some(HttpPayload::Message(form)) => {
                let field = if is_notification {
                    None
                } else {
                    served.template().response_body.as_deref()
                };

                form.write(bytes, field)
                    .map(Written::Text)
                    .map_err(Ended::Form)
            }
            _ => Ok(Written::Bytes(bytes.clone())),
        }
    }

    // a `json`, `text` or `raw` payload as an event's data (8.4)
    fn data_of_native(&self, (bytes, is_notification): (&Bytes, bool)) -> Result<String, Ended> {
        let payload = self.gateway.upgrade().and_then(|inner| {
            self.served(&inner).map(|served| {
                if is_notification {
                    served.route.notification().cloned()
                } else {
                    Some(served.route.result().clone())
                }
            })
        });

        match payload.flatten() {
            Some(HttpPayload::Text) => {
                text_data_of(bytes).ok_or_else(|| Ended::Text(CodecRefusal::new("not UTF-8")))
            }
            Some(HttpPayload::Raw) => Ok(raw_data_of(bytes)),
            _ => Ok(String::from_utf8_lossy(bytes).into_owned()),
        }
    }

    // a failure the call came to, as its problem: by its code and where it arose, or the
    // gateway's own; none for a call its exchange ended
    fn problem_of(&self, ended: &Ended) -> Option<Problem> {
        let inner = self.gateway.upgrade()?;
        let served = self.served(&inner)?;
        let challenge = inner.settings.challenge.as_deref();

        match ended {
            Ended::Call(CallError::Failure(failure)) => {
                Some(self.problem_of_failure((&inner, served), failure))
            }
            Ended::Call(CallError::TimedOut(timeout)) => {
                inner.report(&RouterError::Other(Arc::new(CallError::TimedOut(*timeout))));

                Some(inner.own_problem(
                    OwnFailure::Timeout,
                    &format!("no answer within {} ms", inner.settings.timeout.as_millis()),
                ))
            }
            Ended::Call(CallError::Cancelled(_)) => None,
            Ended::Call(CallError::Disconnected(reason)) => {
                inner.report(&RouterError::Disconnected(reason.clone()));

                Some(inner.own_problem(OwnFailure::Closed, "the connection closed"))
            }
            Ended::Call(other) => {
                // ! what no gate foresaw: its words are reported, never the gateway's
                inner.report(&RouterError::Other(Arc::new(other.clone())));

                Some(inner.own_problem(OwnFailure::Failed, ""))
            }
            // * the mapping's own words of the result it holds no form of
            Ended::Form(MessageFormError::Form(error)) => {
                inner.report(&RouterError::Other(Arc::new(error.clone())));

                // ! a detail of the side's own words: the mapping's own, fixed in transcoding.json
                Some(inner.own_problem(OwnFailure::Unwritable, error.reason()))
            }
            // the stock library's refusal of a result, or a notification, the server answered:
            // its words are never the gateway's, reported, and its code alone answers (9.0)
            Ended::Form(MessageFormError::Undecodable(refusal)) | Ended::Text(refusal) => {
                inner.report(&RouterError::Other(Arc::new(refusal.clone())));

                Some(problem_of_failure(
                    &CallFailure {
                        arose: Arose::Answer,
                        code: ProtocolCode::PAYLOAD_UNDECODABLE.get(),
                        scope: FailureScope::Protocol,
                        detail: String::new(),
                        credential: false,
                        encoding: Encoding::Proto,
                        place: None,
                    },
                    &ProblemOptions {
                        challenge,
                        ..ProblemOptions::default()
                    },
                ))
            }
            Ended::Form(other) => {
                inner.report(&RouterError::Other(Arc::new(other.clone())));

                Some(inner.own_problem(OwnFailure::Failed, ""))
            }
        }
    }

    // a failure answered or raised, as its problem by where it arose (7.5)
    fn problem_of_failure(&self, (inner, served): (&Inner, &Served), failure: &Failure) -> Problem {
        let arose = match failure.origin() {
            FailureOrigin::Local if self.is_handed.load(Ordering::SeqCst) => Arose::Answer,
            FailureOrigin::Local => Arose::Client,
            FailureOrigin::Peer | FailureOrigin::Relayed => Arose::Server,
        };
        let is_protocol = failure.scope() == FailureScope::Protocol;
        let is_scheme =
            is_protocol && failure.protocol_code() == Some(ProtocolCode::CREDENTIAL_UNSUPPORTED);

        if is_scheme {
            inner.report_words(&format!(
                "the server takes none of the scheme this gateway presents: {}",
                failure.detail()
            ));
        }

        let template = served.template();
        let form = served.route.request().form();
        let problem = problem_of_failure(
            &CallFailure {
                arose,
                code: failure.code(),
                scope: failure.scope(),
                detail: failure.detail().to_owned(),
                credential: self.credential,
                encoding: self.encoding,
                place: None,
            },
            &ProblemOptions {
                catalogue: Some(served.route.failures()),
                challenge: inner.settings.challenge.as_deref(),
                problem_types: inner.settings.problem_types.as_deref(),
                route: form.map(|form| ProblemRoute {
                    form: form.as_ref(),
                    route: template,
                }),
            },
        );

        // * every failure it answers 500 or above is reported but PROCEDURE_FAILED, its server's
        // report of its application's (7.6)
        if problem.status >= 500
            && !is_scheme
            && !(is_protocol && failure.protocol_code() == Some(ProtocolCode::PROCEDURE_FAILED))
        {
            inner.report(&RouterError::Failure(failure.clone()));
        }

        problem
    }
}

// ── A stream ──────────────────────────────────────────────────────────────────────────────────

// where a stream's events go: its exchange's response
struct Sink {
    gateway: Weak<Inner>,
    exchange: Arc<Exchange>,
    connection: Arc<Connection>,
    admitted: Arc<Admitted>,
    // a HEAD's stream, ended at its head: nothing more is written
    is_gone: Arc<AtomicBool>,
}

impl EventSink for Sink {
    fn answer(&mut self, problem: Problem) {
        if self.exchange.is_head {
            self.admitted.release();
        }

        if let Some(inner) = self.gateway.upgrade() {
            inner.answer_problem((&self.exchange, problem), None);
        }

        self.connection.close_later();
    }

    fn end(&mut self) {
        self.exchange.outlet.end();
        self.connection.close_later();
    }

    fn open(&mut self) {
        // * its head goes with its first write, so that a drop past its bound writes nothing
        self.exchange.outlet.head(Inner::head_of(
            &self.exchange,
            (
                200,
                vec![Field::of(
                    "content-type",
                    EVENT_STREAM_MEDIA_TYPE.to_owned(),
                )],
            ),
        ));

        // * a HEAD is answered as its GET begins, and ends at its head, its subscription with it
        // (8.1): its place freed before its head goes, where its caller may ask again
        if self.exchange.is_head {
            self.is_gone.store(true, Ordering::SeqCst);
            self.admitted.release();
            self.connection.close_later();
            self.exchange.outlet.end();
        }
    }

    fn write(&mut self, text: String) -> Taken {
        if self.is_gone.load(Ordering::SeqCst) {
            return Box::pin(async { false });
        }

        // ! a reader past what it may hold unsent is dropped before the write that would pass it
        // goes (10.2)
        self.exchange.outlet.write(Bytes::from(text))
    }
}

// the end its router tells, or a notification's failure, held until its call settles: a drop comes
// right behind the result, before the exchange wrote that result; the first of two ends stands
#[derive(Default)]
struct Ending {
    is_settled: bool,
    held: Option<Problem>,
}

// a stream's subscription, as its client's router hears it
struct Subscribed {
    procedure: Procedure,
    window: u64,
    stream: EventStream,
    context: Arc<CallContext>,
    ending: Mutex<Ending>,
}

impl fmt::Debug for Subscribed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Subscribed")
            .field("procedure", &self.procedure)
            .finish_non_exhaustive()
    }
}

impl Subscribed {
    fn end(&self, problem: Problem) {
        let mut ending = locked(&self.ending);

        if ending.is_settled {
            drop(ending);
            self.stream.failure(problem);
        } else if ending.held.is_none() {
            ending.held = Some(problem);
        }
    }

    // its call settled, its result handed to its stream or its failure answered: its end follows
    fn settle(&self) {
        let held = {
            let mut ending = locked(&self.ending);

            ending.is_settled = true;
            ending.held.take()
        };

        if let Some(problem) = held {
            self.stream.failure(problem);
        }
    }

    fn is_ending(&self) -> bool {
        locked(&self.ending).held.is_some()
    }
}

impl NotificationLike for Subscribed {
    fn procedure(&self) -> &Procedure {
        &self.procedure
    }

    fn window(&self) -> Option<u64> {
        Some(self.window)
    }

    fn drop_with(&self, failure: Option<&Failure>) {
        let Some(inner) = self.context.gateway.upgrade() else {
            return;
        };
        let problem = match failure {
            None => inner.own_problem(OwnFailure::Closed, "the connection closed"),
            Some(failure) => {
                let Some(served) = self.context.served(&inner) else {
                    return;
                };

                problem_of_failure(
                    &CallFailure {
                        arose: Arose::Server,
                        code: failure.code(),
                        scope: failure.scope(),
                        detail: failure.detail().to_owned(),
                        credential: false,
                        encoding: Encoding::Proto,
                        place: None,
                    },
                    &ProblemOptions {
                        catalogue: Some(served.route.failures()),
                        challenge: inner.settings.challenge.as_deref(),
                        problem_types: inner.settings.problem_types.as_deref(),
                        route: None,
                    },
                )
            }
        };

        self.end(problem);
    }

    fn trigger(&self, payload: Bytes) -> Result<BoxFuture<Settled>, RouterError> {
        // * a stream its failure or its client ended, or whose end is held, writes nothing more
        if self.stream.is_ended() || self.is_ending() {
            return Ok(Box::pin(async { Vec::new() }));
        }

        let data = self
            .context
            .written_of((&payload, true))
            .and_then(|written| match written {
                Written::Text(text) => Ok(text),
                Written::Bytes(bytes) => self.context.data_of_native((&bytes, true)),
            });

        match data {
            Ok(data) => {
                let taken = self.stream.notification(data).ok();

                Ok(Box::pin(async move {
                    if let Some(taken) = taken {
                        taken.await;
                    }

                    Vec::new()
                }))
            }
            Err(ended) => {
                let problem = self.context.problem_of(&ended).or_else(|| {
                    self.context
                        .gateway
                        .upgrade()
                        .map(|inner| inner.own_problem(OwnFailure::Closed, "the connection closed"))
                });

                if let Some(problem) = problem {
                    self.end(problem);
                }

                Ok(Box::pin(async { Vec::new() }))
            }
        }
    }
}

// ── Its own listener, and mounted ─────────────────────────────────────────────────────────────

// a head's fields on `response`, in their order
fn fields_into<T>(response: &mut Response<T>, fields: &[Field]) {
    for field in fields {
        if let (Ok(name), Ok(value)) = (
            ::http::header::HeaderName::from_bytes(field.name.as_bytes()),
            ::http::HeaderValue::from_str(&field.value),
        ) {
            response.headers_mut().append(name, value);
        }
    }
}

// what HTTP refuses of its own, as HTTP answers it: 400, unmarked, its socket closed
fn malformed_fields() -> [Field; 2] {
    [
        Field::of("connection", "close".to_owned()),
        Field::of("content-length", "0".to_owned()),
    ]
}

impl HttpGateway {
    /// A gateway of `options.routes`, beadc's route table (transcoding 1.1), whose calls cross
    /// `options.transport`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] outside a tokio runtime, given none, or on one without its time or its
    /// IO driver; for a member given both in its policy and beside it; a duration spec 1.4 does not
    /// hold; a bound of 0, the window's among them, but the rates; a hosts entry with a port; an
    /// origins entry that is `*` or `null`; a route whose template is off `http.proto`'s grammar,
    /// and two routes of one method that tie, each naming its route.
    pub fn new(options: &HttpGatewayOptions) -> Result<Self, ProgrammerError> {
        let runtime = platform::socket_runtime_of(options.runtime.as_ref(), "an HTTP gateway")?;
        let platform: SharedClock = Arc::new(SystemClock::on(runtime.clone()));
        let settings = settings_of(options)?;
        let clock = options
            .clock
            .clone()
            .unwrap_or_else(|| Arc::clone(&platform));

        Ok(Self {
            inner: Arc::new_cyclic(|me| Inner {
                me: Weak::clone(me),
                runtime,
                platform,
                clock,
                settings,
                state: Mutex::new(GatewayState::default()),
                listeners: Listened::default(),
                budget: Arc::new(AtomicU64::new(0)),
            }),
        })
    }

    /// Listens on its own listener, once until it stops, over the HTTP transport's wire (decision
    /// 0049), and gives where: the address it bound, and its port.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] once it is disposed; a second start while it listens; an address that
    /// is no bare IP address nor `localhost`; a start its signal gave up; what the platform refuses
    /// the bind with. Each but the first two leaves it ready to start again.
    pub fn start(
        &self,
        options: &HttpGatewayStartOptions,
    ) -> BoxFuture<Result<TransportServerAddress, RouterError>> {
        let refused = |words: &str| -> BoxFuture<Result<TransportServerAddress, RouterError>> {
            let error = RouterError::Other(Arc::new(ProgrammerError::new(words)));

            Box::pin(async move { Err(error) })
        };

        {
            let mut state = locked(&self.inner.state);

            if state.is_disposed {
                return refused("the gateway is disposed");
            }

            if state.is_listening {
                return refused("a gateway listens once");
            }

            state.is_listening = true;
        }

        let mut start = TransportServerStartOptions::default();

        start.address.clone_from(&options.address);
        start.port = options.port;
        start.find_open_port = options.find_open_port;
        start.signal.clone_from(&options.signal);

        let listened = self.inner.listen(&start);

        // * a listen that failed listens on none, and may be tried again
        if listened.is_err() {
            locked(&self.inner.state).is_listening = false;
        }

        Box::pin(async move { listened })
    }

    /// Closes its own listener, and ends every exchange under way, each connection closed.
    ///
    /// # Errors
    ///
    /// None it gives today: a stop settles once its listeners let go.
    pub fn stop(&self) -> BoxFuture<Result<(), RouterError>> {
        self.inner.stopping()
    }

    /// Stops it, then ends it for good: a start after it is its application's misuse.
    ///
    /// # Errors
    ///
    /// What its stop gives.
    pub fn dispose(&self) -> BoxFuture<Result<(), RouterError>> {
        locked(&self.inner.state).is_disposed = true;

        self.inner.stopping()
    }

    /// Answers `request`, which its application routed to it, from `peer`, the caller's address and
    /// port; none where its host knows none, read as local (transcoding 2.3).
    ///
    /// A path no route matches is answered 404 `path-unknown`, as any refusal of its own. It keeps
    /// every gate of 10.1, a field or a target past visible ASCII answered 400 unmarked, its
    /// problems, its pace and its bounds; it leaves its host its head's bounds and timeouts and its
    /// socket's write deadline. A body its host read before it is judged by hyper's hints before
    /// its first byte and by its count at its end, refused 500, its call never made (7.6.27).
    pub fn answer<B>(
        &self,
        request: ::http::Request<B>,
        peer: Option<SocketAddr>,
    ) -> BoxFuture<::http::Response<HttpGatewayBody>>
    where
        B: Body<Data = Bytes> + Send + 'static,
        B::Error: Into<Box<dyn Error + Send + Sync>>,
    {
        let answered = self.inner.exchange(request, (peer, None));

        Box::pin(async move {
            let (head, body) = match answered.await {
                Answer::Head { head, body } => (head, body),
                Answer::Malformed => (
                    Head {
                        status: 400,
                        fields: malformed_fields().into(),
                    },
                    HttpGatewayBody::ended(),
                ),
                Answer::Cut => (
                    Head {
                        status: 500,
                        fields: Vec::new(),
                    },
                    HttpGatewayBody::cut(),
                ),
            };
            let mut response = ::http::Response::new(body);

            *response.status_mut() = ::http::StatusCode::from_u16(head.status)
                .unwrap_or(::http::StatusCode::INTERNAL_SERVER_ERROR);
            fields_into(&mut response, &head.fields);

            response
        })
    }

    /// Calls `listener` on each failure it reports, until it is taken off; what it panics with goes
    /// no further, and the exchange answers on (spec 15.1).
    pub fn on_error(&self, listener: GatewayErrorListener) -> ListenerId {
        self.inner.listeners.add(listener)
    }

    /// Takes the listener `id` names off.
    pub fn off(&self, id: ListenerId) {
        self.inner.listeners.off(id);
    }
}
