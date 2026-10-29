//! Bead, a binary wire protocol, on the Rust side: its core — the envelope's codec, the routers
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
mod identity;
mod joined;
pub mod json;
mod jwt_verifier;
mod managers;
mod memory;
mod metrics;
mod ordered;
mod owner;
mod payloads;
mod router;
mod server;
mod service;
mod session_token;
mod transport;
mod violations;

pub use broker::adapter::{
    BrokerAdapter, BrokerCapabilities, BrokerDelivery, BrokerDown, BrokerError, BrokerListener,
    BrokerMessage, BrokerMessageOptions, BrokerPublication, BrokerPublished, BrokerStart,
    BrokerSubscription, Settle,
};
pub use broker::client::{
    BrokerClient, BrokerClientOptions, BrokerConnectOptions, MAXIMUM_UNSENT_BYTES,
};
pub use broker::memory::{
    MemoryBroker, MemoryBrokerAdapter, MemoryBrokerAdapterOptions, MemoryBrokerFault,
    MemoryBrokerFaultOptions, MemoryBrokerOptions, TRANSPORT_BROKER,
};
pub use broker::participant::{
    BODY_GRACE_PERIOD, BrokerParticipant, BrokerParticipantOptions, BrokerRefusedError, HEARTBEAT,
    HELD_BYTES_BUDGET, MAXIMUM_ENVELOPE_PARTS_BYTES, MINIMUM_BODY_BYTES_PER_SECOND,
    ParticipantErrorListener, ROOT,
};
pub use broker::server::{
    ACCEPT_TIMEOUT, BrokerServer, BrokerServerOptions, MAXIMUM_CONNECTIONS,
    MAXIMUM_CONNECTIONS_PER_ADDRESS,
};
pub use call_session::{
    Carriage, Presented, connection_session_of, presented_credential_of, uncarried_of,
};
pub use client::{Client, ClientOptions};
pub use clock::{Clock, Schedule, SharedClock, SystemClock, Timer, TimerCallback, clock_of};
pub use constants::{
    CredentialScheme, EnvelopeFlag, EnvelopeKind, EnvelopeLayout, FailureScope, ProcedureKind,
    ProtocolCode, RESERVATION, RouterSide, SERVER_CONNECTION_HANDLE, SESSION_TOKEN_BYTES,
};
pub use credentials::{
    Credentials, ElsewhereSession, ElsewhereVerdict, ElsewhereVerifier, JWT_LIMIT_BYTES, JwtKeySet,
    JwtSetKey, KeySetAnswer, KeySetAsk, assert_limits_hold_jwt,
};
pub use debug::participant::{ParcelVerdict, ParticipantDebugEvent, ParticipantDebugListener};
pub use debug::{
    CallAsked, DebugDirection, DebugFilter, DebugFilterSource, DebugType, EnvelopeAsked,
    FilterGiven, FilterKeeper, FilterRefusal, GivenFilter, TracedEnvelope, parse_debug_filter,
};
pub use duration::{DurationRefusal, LONGEST_TIMER, NEVER, hold, hold_delay, hold_finite};
pub use envelope::{
    CancelHeader, ChunkHeader, Credential, CreditHeader, Envelope, FailureHeader, FailureRecord,
    Header, LARGEST_64_BIT_FIELD, MAXIMUM_DETAIL_BYTES, MAXIMUM_ENVELOPE_BYTES,
    MAXIMUM_HEADER_BYTES, NotificationHeader, Prefix, ReadEnvelopeOptions, ReadHeader,
    RequestHeader, ResultHeader, header_bytes_of, read_envelope, read_failure, read_header,
    read_prefix, unbounded_header_bytes_of, write_envelope, write_failure, write_header,
};
pub use errors::{
    CallError, CapacityError, ConnectError, Disposed, ProgrammerError, ReadyStateError,
    ReconnectError, Refusal, ResolverError, TransportError,
};
pub use failure::{Failure, FailureOrigin, ProcedureAddress};
pub use identity::{
    DeclarationWay, Deprecation, IdentityRefusal, Procedure, are_one_name, check_declaration,
    check_procedure_kind, is_procedure_name,
};
pub use joined::JoinedServerTransport;
pub use jwt_verifier::{
    JWT_LEEWAY, JwtAgainst, JwtAlgorithm, JwtKey, JwtRefusal, JwtSessionIdentifier, JwtVerdict,
    assert_jwt_key, audiences_of, read_jwt, verify_jwt,
};
pub use managers::notification::{
    NotificationKey, PACING_DEFAULTS, PacingLimits, PacingLimitsOptions, pacing_limits_of,
};
pub use managers::service::{
    CloseConnection, DEFAULT_TIMEOUT, DebugEvent, DebugListener, DeprecatedListener,
    DroppedListener, Notification, NotificationCallback, NotificationDependencies,
    NotificationRegistration, NotificationResolverOf, Notifier, NotifyOptions, Request,
    RequestDefaults, RequestDependencies, RequestOptions, RequestProps, ResolverCallback,
    ResolverDependencies, ResolverOf, Response, ServiceCall, ServiceManager, ServiceManagerOptions,
    ServiceRouter, Subscriber, SubscriberFilter, Traced, TracedError, TracedValue, Unsubscribe,
    Validate, ValidateOptions,
};
pub use managers::sessions::{Session, SessionEvent, SessionManagerOptions};
pub use memory::{
    MEMORY_ADDRESS, MemoryClient, MemoryClientOptions, MemoryConnectOptions, MemoryServer,
    MemoryServerOptions, TRANSPORT_MEMORY,
};
pub use metrics::{
    CallEnding, MAXIMUM_PROCEDURES, METRICS_CONTENT_TYPE, MetricsExposition, MetricsRegistry,
    MetricsRegistryOptions, NotificationSeries, ProcedureSeries, ResolverSeries, RouterMetrics,
};
pub use payloads::{CodecRefusal, JsonCodec, JsonOf, PayloadCodec, RawCodec, TextCodec};
pub use router::admissions::{
    BeforeRequest, require_credential, require_session, share_leg_b_session,
};
pub use router::client::{
    ClientActivityListener, ClientEnvelopeListener, ClientErrorListener, ClientRequest,
    NotificationLike, RouterClient, RouterClientOptions, Settled, WithdrawnListener,
};
pub use router::core::{
    AdmissionRefusal, AdmissionRequest, AdmitFn, Answerer, ResolverProps,
    credential_schemes_detail_of,
};
pub use router::relay::{
    Destination, DestinationOptions, DestinationRegistration, RelayLeg, RelayOptions, RelayRouter,
    RelayTarget,
};
pub use router::server::{
    ActivityListener, Call, CallHooks, EnvelopeListener, ErrorListener, NotifyFilter,
    RefusalListener, RouterServer, RouterServerOptions, ServerRequest,
};
pub use router::types::{
    AccessRefusal, AccessRefusalStage, BoxFuture, CallAddress, CallSession, ConnectionHandle,
    Gauges, LIMIT_DEFAULTS, RequestCredential, ResolvedRequestOptions, RouterActivity,
    RouterAnswer, RouterError, RouterLimits, RouterLimitsOptions, RouterResult, SessionIdentifier,
    Signal, SignalReason, TransportMessage, limits_of, session_key_of, whole_envelope_limits_of,
};
pub use server::{
    Health, HealthCheck, HealthStatus, LayerGauges, Server, ServerGauges, ServerOptions,
    SessionListener, Sessions, WARNING_RATIO, health_of, layer_gauges_of,
};
pub use service::{
    AdmissionHook, AdmissionRule, Descriptor, DescriptorInit, FailureCatalogue, ListedFailure,
    NotifyingDescriptor, ServiceProcedure, ServiceServer, ServiceServerOptions, command_of,
    failures_of, listed_failure_of, notifying_of, request_of,
};
pub use session_token::SessionToken;
pub use transport::{
    CONNECT_TIMEOUT, ClientListener, ClientTransport, Connect, DisconnectOptions,
    RECONNECT_ATTEMPTS, RECONNECT_DELAY, ReadyState, ReconnectDelay, ReconnectOptions, Sent,
    ServerListener, ServerTransport, TransportServerRefusal, is_field_value,
};
pub use violations::{
    CLOSING_BYTES, Judged, ReadViolations, Violation, ViolationHolder, detail_bound_of, is_refused,
    violations_detail_of, violations_of, words_of,
};

#[cfg(any(test, feature = "testing"))]
#[doc(hidden)]
pub mod testing;
