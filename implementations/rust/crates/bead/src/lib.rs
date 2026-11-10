//! Bead, a binary wire protocol, on the Rust side: its core â€” the envelope's codec, the routers
//! and their service layer, sessions and credentials, the clock and the durations, debugging and
//! metrics, the in-memory transport, the broker's core over an in-memory broker, and the joined
//! transport (decision 0044).
//!
//! Every operation takes effect as it is made, and its future only waits: a call is sent in the
//! order it is made, whatever order it is awaited in, and dropping its future cancels nothing.

mod base64url;
mod broker;
mod call_session;
mod client;
mod clock;
mod constants;
mod credentials;
mod debug;
mod duration;
mod envelope;
mod errors;
mod failure;
#[cfg(feature = "http")]
mod http;
mod http_policy;
mod identity;
mod joined;
pub mod json;
mod judgement;
mod jwt_verifier;
mod life;
mod managers;
mod memory;
mod metrics;
#[cfg(any(feature = "websocket", feature = "http"))]
mod net;
mod ordered;
mod owner;
mod payloads;
mod platform;
mod router;
mod server;
mod service;
mod session_token;
mod transport;
mod violations;
#[cfg(feature = "websocket")]
mod websocket;

/// The TLS a socket transport speaks, re-exported so that the config an application gives one is
/// of the version Bead builds on.
#[cfg(any(feature = "websocket", feature = "http"))]
pub use rustls;
/// The runtime handle accepted by Bead's runtime options.
pub use tokio::runtime::Handle;
/// The cancellation token accepted and handed by Bead's operations.
pub use tokio_util::sync::CancellationToken;

pub use broker::adapter::{
    BrokerAdapter, BrokerCapabilities, BrokerDelivery, BrokerDown, BrokerError, BrokerListener,
    BrokerMessage, BrokerMessageOptions, BrokerPublication, BrokerPublished, BrokerStart,
    BrokerSubscription, Settle,
};
pub use broker::client::{
    BrokerTransportClient, BrokerTransportClientConnectOptions, BrokerTransportClientOptions,
    MAXIMUM_UNSENT_BYTES,
};
pub use broker::memory::{
    MemoryBroker, MemoryBrokerAdapter, MemoryBrokerAdapterOptions, MemoryBrokerFault,
    MemoryBrokerFaultOptions, MemoryBrokerOptions, TRANSPORT_BROKER,
};
pub use broker::participant::{
    BODY_GRACE_PERIOD, BrokerParticipant, BrokerParticipantOptions, BrokerRefusal,
    BrokerRefusedError, HEARTBEAT, MAXIMUM_ENVELOPE_PARTS_BYTES, MINIMUM_BODY_BYTES_PER_SECOND,
    ParticipantErrorListener, ROOT,
};
pub use broker::server::{
    ACCEPT_TIMEOUT, BrokerTransportServer, BrokerTransportServerOptions, MAXIMUM_CONNECTIONS,
    MAXIMUM_CONNECTIONS_PER_ADDRESS,
};
pub use client::{Client, ClientOptions};
pub use clock::{
    Clock, Schedule, SharedClock, SystemClock, SystemClockOptions, Timer, TimerCallback,
};
pub use constants::{
    CredentialScheme, EnvelopeFlag, EnvelopeKind, EnvelopeLayout, FailureScope, ProcedureKind,
    ProtocolCode, RouterSide, SERVER_CONNECTION_HANDLE, SESSION_TOKEN_BYTES,
};
pub use credentials::{
    Credentials, ElsewhereSession, ElsewhereVerdict, ElsewhereVerifier, JwtKeySet, JwtSetKey,
    KeySetAnswer, KeySetAsk,
};
pub use debug::participant::{ParcelVerdict, ParticipantDebugEvent, ParticipantDebugListener};
pub use debug::{
    CallAsked, DebugDirection, DebugFilter, DebugFilterSource, DebugType, EnvelopeAsked,
    FilterGiven, FilterKeeper, FilterRefusal, GivenFilter, TracedEnvelope, filter_debug,
    parse_debug_filter,
};
pub use duration::{DurationRefusal, LONGEST_TIMER, NEVER};
pub use envelope::{
    CancelHeader, ChunkHeader, Credential, CreditHeader, EnvelopeHeader, FailureHeader,
    FailureRecord, NotificationHeader, RequestHeader, ResultHeader,
};
pub use errors::{
    CallError, CapacityError, ConnectError, Disposed, ProgrammerError, ReadyStateError,
    ReconnectError, Refusal, ResolverError, TransportError,
};
pub use failure::{Failure, FailureOrigin, ProcedureAddress};
#[cfg(feature = "http")]
pub use http::client::{
    HttpTransportClient, HttpTransportClientConnectOptions, HttpTransportClientOptions,
};
#[cfg(feature = "http")]
pub use http::fields::{HTTP_REFUSALS, HttpRefusals};
#[cfg(feature = "http")]
pub use http::server::{
    BODY_BYTES_BUDGET, EXCHANGE_TIMEOUT, HttpTransportServer, HttpTransportServerOptions,
    INACTIVITY_TIMEOUT, MAXIMUM_BODY_BYTES, MAXIMUM_OUTBOX_BYTES, MAXIMUM_WAIT,
    MAXIMUM_WAITING_EXCHANGES, PATHNAME, TRANSPORT_HTTP,
};
pub use http_policy::{HttpPolicy, HttpPolicyOptions};
pub use identity::{DeclarationWay, Deprecation, IdentityRefusal, Procedure};
pub use joined::JoinedServerTransport;
pub use judgement::handshake::{WEBSOCKET_REFUSALS, WebSocketRefusals};
pub use jwt_verifier::{
    JwtAgainst, JwtAlgorithm, JwtKey, JwtRefusal, JwtSessionIdentifier, JwtVerdict,
};
pub use managers::notification::{
    NotificationKey, PACING_DEFAULTS, PacingLimits, PacingLimitsOptions,
};
pub use managers::service::{
    CloseConnection, Command, CommandOptions, DebugEvent, DebugListener, DeprecatedListener,
    DroppedListener, Notification, NotificationCallback, NotificationDependencies,
    NotificationRegistration, NotificationResolverDependencies, NotificationResolverOf, Notifier,
    NotifyOptions, REQUEST_DEFAULTS, RegistrationOptions, Request, RequestDefaults,
    RequestDependencies, RequestOptions, RequestProps, RequestResolverDependencies,
    ResolverCallback, ResolverOf, Response, ServiceCall, ServiceManager, ServiceManagerClient,
    ServiceManagerOptions, ServiceManagerServer, ServiceRouter, Subscriber, SubscriberFilter,
    Traced, TracedError, TracedValue, Unsubscribe, Validate, ValidateOptions,
};
pub use managers::sessions::{Session, SessionEvent, SessionManagerOptions};
pub use memory::{
    MEMORY_ADDRESS, MemoryTransportClient, MemoryTransportClientConnectOptions,
    MemoryTransportClientOptions, MemoryTransportServer, MemoryTransportServerOptions,
    TRANSPORT_MEMORY,
};
pub use metrics::{
    CallEnding, METRICS_CONTENT_TYPE, METRICS_REGISTRY_DEFAULTS, MetricsExposition,
    MetricsRegistry, MetricsRegistryOptions, NotificationSeries, ProcedureSeries, ResolverSeries,
    RouterMetrics,
};
#[cfg(any(feature = "websocket", feature = "http"))]
pub use net::bounds::{HEADERS_TIMEOUT, MINIMUM_SEND_BYTES_PER_SECOND, SEND_GRACE_PERIOD};
pub use payloads::{CodecRefusal, JsonCodec, JsonOf, PayloadCodec, RawCodec, TextCodec};
pub use router::admissions::{
    BeforeRequest, require_credential, require_session, share_leg_b_session,
};
pub use router::client::{
    ClientActivityListener, ClientEnvelopeListener, ClientErrorListener, NotificationLike,
    RouterClient, RouterClientOptions, Settled, UnregisterNotificationOptions, WithdrawnListener,
};
pub use router::core::{
    AdmissionRefusal, AdmissionRequest, AdmitFn, Answerer, RequestResolverProps,
};
pub use router::relay::{
    Destination, DestinationOptions, DestinationRegistration, RelayLeg, RelayOptions, RelayRouter,
    RelayTarget,
};
pub use router::server::{
    ActivityListener, Call, EnvelopeListener, ErrorListener, NotifyFilter, RefusalListener,
    RouterServer, RouterServerOptions, SessionOf, SessionRequest, SessionTokenProvider,
};
pub use router::types::{
    AccessRefusal, AccessRefusalStage, BoxFuture, CallAddress, CallSession, ConnectionHandle,
    Gauges, INTAKE_DEFAULTS, IntakeLimits, IntakeLimitsOptions, LIMIT_DEFAULTS, NotifyRequest,
    RequestCredential, ResolvedRequestOptions, RouterActivity, RouterAnswer, RouterError,
    RouterLimits, RouterLimitsOptions, RouterRequest, RouterResult, SessionIdentifier, Signal,
    SignalReason, TransportMessage,
};
pub use server::{
    Health, HealthCheck, HealthStatus, LayerGauges, Server, ServerGauges, ServerOptions,
    SessionListener, SessionManager, WARNING_RATIO,
};
pub use service::{
    AdmissionHook, AdmissionRule, Descriptor, DescriptorInit, FailureCatalogue, ListedFailure,
    NotifyingDescriptor, ServiceClient, ServiceClientOptions, ServiceProcedure, ServiceServer,
    ServiceServerOptions, command_of, failures_of, notifying_of, request_of,
};
pub use session_token::{SessionToken, SessionTokenDrawError};
pub use transport::{
    CONNECT_TIMEOUT, ClientListener, Connect, ListenerId, RECONNECT_DEFAULTS, ReadyState,
    RouterClientTransport, Sent, ServerListener, ServerTransport, TransportClientDisconnectOptions,
    TransportClientReconnectDelay, TransportClientReconnectDelayResolver,
    TransportClientReconnectOptions, TransportServerAddress, TransportServerClient,
    TransportServerRefusal, TransportServerStartOptions, is_field_value,
};
pub use violations::{
    CLOSING_BYTES, Judged, ReadViolations, Violation, ViolationHolder, detail_bound_of,
    violations_detail_of, violations_of, words_of,
};
#[cfg(feature = "websocket")]
pub use websocket::client::{
    CredentialProvider, CredentialProviderError, WebSocketTransportClient,
    WebSocketTransportClientConnectOptions, WebSocketTransportClientOptions,
};
#[cfg(feature = "websocket")]
pub use websocket::connection::{CLOSE_TIMEOUT, MAXIMUM_MESSAGE_BYTES};
#[cfg(feature = "websocket")]
pub use websocket::facade::{
    WebSocketClient, WebSocketClientOptions, WebSocketServer, WebSocketServerOptions,
};
#[cfg(feature = "websocket")]
pub use websocket::server::{
    TRANSPORT_WEBSOCKET, WebSocketTransportServer, WebSocketTransportServerOptions,
};

/// What the workspace's own members â€” the interop service, the bench, the conformance players and
/// the fuzz targets â€” reach that the API does not offer: outside SemVer, and no road for another
/// crate. The envelope's codec is here, internal on every side as a router's core is (decision
/// 0047), as the C# side's members reach theirs by `InternalsVisibleTo`.
#[doc(hidden)]
pub mod internal {
    pub use crate::credentials::JWT_LIMIT_BYTES;
    pub use crate::duration::{hold, hold_finite};
    pub use crate::envelope::{
        Envelope, MAXIMUM_DETAIL_BYTES, Prefix, ReadEnvelopeOptions, ReadHeader, header_bytes_of,
        read_envelope, read_failure, read_header, read_prefix, write_envelope, write_header,
    };
    pub use crate::identity::{are_one_name, is_procedure_name};
    pub use crate::judgement::{handshake, head, hosts, items, proxies, security, url_host};
    pub use crate::jwt_verifier::{ReadJwt, read_jwt, verify_jwt};
    pub use crate::router::types::{limits_of, session_key_of};
}

#[cfg(any(test, feature = "testing"))]
#[doc(hidden)]
pub mod testing;
