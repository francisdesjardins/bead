//! The service manager: a procedure's requester and its resolver over a router, its payloads read
//! and written by their codecs, judged by its rules, and each step of a call traced while someone
//! listens (spec/debugging.md 4).

use core::any::Any;
use core::fmt;
use core::future::Future;
use core::pin::Pin;
use core::sync::atomic::{AtomicBool, Ordering};
use core::task::{Context, Poll};
use core::time::Duration;
use std::error::Error;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::clock::SharedClock;
use crate::constants::{ProtocolCode, RouterSide, SERVER_CONNECTION_HANDLE};
use crate::debug::{DebugDirection, DebugType};
use crate::duration::hold;
use crate::envelope::{FailureRecord, RequestHeader};
use crate::errors::{CallError, ProgrammerError, ResolverError};
use crate::failure::Failure;
use crate::identity::{Procedure, check_declaration};
use crate::managers::notification::NotificationKey;
use crate::metrics::ProcedureSeries;
use crate::payloads::PayloadCodec;
use crate::router::admissions::BeforeRequest;
use crate::router::client::{ClientRequest, NotificationLike, RouterClient};
use crate::router::core::{Answerer, Handler, ResolverProps};
use crate::router::server::{CallHooks, NotifyFilter, RouterServer, ServerRequest};
use crate::router::types::{
    BoxFuture, CallSession, ConnectionHandle, RequestCredential, ResolvedRequestOptions,
    RouterAnswer, RouterError, RouterLimits, SessionIdentifier, Signal,
};
use crate::violations::{Judged, detail_bound_of, is_refused, violations_detail_of};

mod notification;

pub use notification::{
    Notification, NotificationCallback, NotificationDependencies, NotificationRegistration,
    Unsubscribe,
};

// ── Traced values ────────────────────────────────────────────────────────────────────────────

/// A value a step of a trace tells: a payload as its codec read or wrote it, or a failure's
/// record, which a listener may look into by its type.
pub trait TracedValue: Any + fmt::Debug + Send + Sync {
    /// Itself, to look into by its type.
    fn as_any(&self) -> &dyn Any;
}

impl<T: Any + fmt::Debug + Send + Sync> TracedValue for T {
    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// A value a step tells, shared.
pub type Traced = Arc<dyn TracedValue>;

fn traced<T: TracedValue>(value: T) -> Traced {
    Arc::new(value)
}

/// Why a step went wrong, beside it.
pub type TracedError = Arc<dyn Error + Send + Sync>;

/// One step of a call, a request or a notification, as `debug` hears it (spec/debugging.md 4.1).
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct DebugEvent {
    /// The call's id, as its router drew it; none for a notification, or a call refused first.
    pub call_id: Option<u32>,
    /// The connection the call is on: the server's, on a client.
    pub connection_handle: Option<ConnectionHandle>,
    /// Out or in.
    pub direction: DebugDirection,
    /// Once answered, the whole milliseconds from its start, its fraction dropped.
    pub duration: Option<u64>,
    /// The call's options, its credential left out.
    pub options: Option<ResolvedRequestOptions>,
    /// Its procedure's id.
    pub procedure_id: u16,
    /// Its procedure's name.
    pub procedure_name: String,
    /// What came in.
    pub rx: Option<Traced>,
    /// Its service's id.
    pub service_id: u16,
    /// Its service's revision.
    pub service_revision: u32,
    /// Its start, in milliseconds since the epoch.
    pub started_at: i64,
    /// What went out.
    pub tx: Option<Traced>,
    /// A request, a command or a notification.
    pub call_type: DebugType,
}

/// What hears each step: why it went wrong, when it did, and the step.
pub type DebugListener = Arc<dyn Fn(Option<&TracedError>, &DebugEvent) + Send + Sync>;

/// What hears each call of a procedure deprecated.
pub type DeprecatedListener = Arc<dyn Fn(&Procedure) + Send + Sync>;

// ── The router a manager runs over ───────────────────────────────────────────────────────────

/// The router a service manager runs over: a server's, or a client's.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum ServiceRouter {
    /// A server's router.
    Server(RouterServer),
    /// A client's router.
    Client(RouterClient),
}

/// A call the manager asks of its router.
pub(crate) struct RouterCall {
    pub(crate) procedure: Procedure,
    pub(crate) options: ResolvedRequestOptions,
    pub(crate) series: Option<ProcedureSeries>,
    pub(crate) refusal: Option<CallError>,
    pub(crate) on_call_id: Option<Box<dyn FnOnce(u32) + Send>>,
    pub(crate) subscribes: Option<Arc<dyn NotificationLike>>,
}

impl ServiceRouter {
    fn side(&self) -> RouterSide {
        match self {
            Self::Server(_) => RouterSide::Server,
            Self::Client(_) => RouterSide::Client,
        }
    }

    fn limits(&self) -> RouterLimits {
        match self {
            Self::Server(router) => router.limits(),
            Self::Client(router) => router.limits(),
        }
    }

    fn clock(&self) -> SharedClock {
        match self {
            Self::Server(router) => router.clock(),
            Self::Client(router) => router.clock(),
        }
    }

    pub(crate) fn report(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        match self {
            Self::Server(router) => router.report(error, connection_handle),
            Self::Client(router) => router.report(error),
        }
    }

    fn declare_requester(
        &self,
        procedure: &Procedure,
    ) -> Result<Option<ProcedureSeries>, ProgrammerError> {
        match self {
            Self::Server(router) => router.declare_requester(procedure),
            Self::Client(router) => router.declare_requester(procedure),
        }
    }

    fn register_resolver(
        &self,
        (procedure, handler): (&Procedure, Handler),
    ) -> Result<(), ProgrammerError> {
        match self {
            Self::Server(router) => router.register_resolver((procedure, handler)),
            Self::Client(router) => router.register_resolver((procedure, handler)),
        }
    }

    fn request(
        &self,
        payload: Bytes,
        call: RouterCall,
    ) -> Result<crate::router::server::Call, ProgrammerError> {
        match self {
            Self::Server(router) => router.request(
                payload,
                (
                    ServerRequest {
                        procedure: call.procedure.address(),
                        maximum_payload_bytes: call.procedure.maximum_payload_bytes,
                        options: call.options,
                        series: call.series,
                        refusal: call.refusal,
                    },
                    CallHooks {
                        on_call_id: call.on_call_id,
                        on_sent: None,
                    },
                ),
            ),
            Self::Client(router) => router.request(
                payload,
                (
                    ClientRequest {
                        procedure: call.procedure,
                        options: call.options,
                        series: call.series,
                        refusal: call.refusal,
                        subscribes: call.subscribes,
                    },
                    CallHooks {
                        on_call_id: call.on_call_id,
                        on_sent: None,
                    },
                ),
            ),
        }
    }

    // spawns `future`, counted as the router's work
    pub(crate) fn cover<F: Future<Output = ()> + Send + 'static>(&self, future: F) {
        match self {
            Self::Server(router) => router.owner().cover(future),
            Self::Client(router) => router.owner().cover(future),
        }
    }
}

// ── Options ──────────────────────────────────────────────────────────────────────────────────

/// The timeout a call takes when it gives none.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

/// What a manager's calls take when they give nothing.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct RequestDefaults {
    /// Whether a call unanswered past its timeout closes its connection.
    pub close_on_timeout: Option<bool>,
    /// A call's timeout: [`DEFAULT_TIMEOUT`] when none.
    pub timeout: Option<Duration>,
}

/// How a service manager is built.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct ServiceManagerOptions {
    /// The clock it runs on: its router's, which one given must be.
    pub clock: Option<SharedClock>,
    /// What closes a connection a call left unanswered past its timeout.
    pub close_connection: Option<CloseConnection>,
    /// What its calls take when they give nothing.
    pub defaults: Option<RequestDefaults>,
}

impl fmt::Debug for ServiceManagerOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServiceManagerOptions")
            .field("defaults", &self.defaults)
            .finish_non_exhaustive()
    }
}

/// A call's own options.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct RequestOptions {
    /// Its timeout: its manager's default when none.
    pub timeout: Option<Duration>,
    /// What it is for behind the peer.
    pub destination_id: Option<u32>,
    /// The connection it goes to, on a server.
    pub connection_handle: Option<ConnectionHandle>,
    /// The credential it presents.
    pub credential: Option<RequestCredential>,
    /// What cancels it.
    pub signal: Option<CancellationToken>,
    /// Whether it closes its connection unanswered past its timeout: its manager's when none.
    pub close_on_timeout: Option<bool>,
}

/// How a manager judges a value by its rules (spec 18.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct ValidateOptions {
    /// Whether it stops at the first violation.
    pub fail_fast: bool,
    /// The bytes a refusal's detail holds at most.
    pub maximum_bytes: usize,
}

/// The rules a value is judged by.
pub type Validate<T> = Arc<dyn Fn(&T, ValidateOptions) -> Judged + Send + Sync>;

/// What a requester reads and writes by, and judges its request by.
pub struct RequestDependencies<Req: PayloadCodec, Res: PayloadCodec> {
    /// The request's codec.
    pub request: Req,
    /// The result's codec.
    pub result: Res,
    /// The rules a request is judged by before it is written.
    pub validate: Option<Validate<Req::Value>>,
    /// Whether its rules stop at the first violation.
    pub fail_fast: bool,
}

impl<Req: PayloadCodec, Res: PayloadCodec> fmt::Debug for RequestDependencies<Req, Res> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RequestDependencies")
            .field("request", &self.request)
            .field("result", &self.result)
            .finish_non_exhaustive()
    }
}

impl<Req: PayloadCodec, Res: PayloadCodec> RequestDependencies<Req, Res> {
    /// A requester's codecs, judged by no rule.
    #[must_use]
    pub fn of(request: Req, result: Res) -> Self {
        Self {
            request,
            result,
            validate: None,
            fail_fast: false,
        }
    }
}

// ── The manager ──────────────────────────────────────────────────────────────────────────────

struct Inner {
    router: ServiceRouter,
    clock: SharedClock,
    close_connection: Option<CloseConnection>,
    timeout: Duration,
    close_on_timeout: Option<bool>,
    debug: Mutex<Vec<DebugListener>>,
    deprecated: Mutex<Vec<DeprecatedListener>>,
    dropped: Mutex<Vec<DroppedListener>>,
    // the notifications this manager made, one per procedure, kept for its life
    notifications: Mutex<std::collections::BTreeMap<(u16, u16), notification::Known>>,
}

/// What hears each subscription of a notification dropped, and the failure that ended it.
pub type DroppedListener = Arc<dyn Fn(&Procedure, Option<&Failure>) + Send + Sync>;

/// A service manager: requesters and resolvers over one router.
#[derive(Clone)]
pub struct ServiceManager {
    inner: Arc<Inner>,
}

impl fmt::Debug for ServiceManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServiceManager")
            .field("router", &self.inner.router)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy)]
struct Started {
    instant: i64,
    timestamp: Duration,
}

fn wall_of(clock: &SharedClock) -> i64 {
    clock
        .wall()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

// a step of a call, before it is told
#[derive(Clone)]
struct Step {
    call_id: Option<u32>,
    connection_handle: Option<ConnectionHandle>,
    direction: DebugDirection,
    error: Option<TracedError>,
    is_answered: bool,
    options: Option<ResolvedRequestOptions>,
    rx: Option<Traced>,
    started: Started,
    tx: Option<Traced>,
    call_type: DebugType,
}

impl Inner {
    fn is_debugging(&self) -> bool {
        !self
            .debug
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
    }

    // now, for a call starting, traced: the wall clock for its start, the monotonic for its
    // duration
    fn started_now(&self) -> Started {
        Started {
            instant: wall_of(&self.clock),
            timestamp: self.clock.monotonic(),
        }
    }

    // now, for a notification sent or heard: one step, which takes no duration
    fn notified_now(&self) -> Started {
        Started {
            instant: wall_of(&self.clock),
            timestamp: Duration::ZERO,
        }
    }

    // tells debug about one step of a call, each listener within a guard: what one panics is
    // reported through the router with the call's connection, and changes nothing of the call
    fn trace(&self, procedure: &Procedure, step: Step) {
        let listeners = self
            .debug
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();

        if listeners.is_empty() {
            return;
        }

        let side = self.router.side();
        let duration = step.is_answered.then(|| {
            u64::try_from(
                self.clock
                    .monotonic()
                    .saturating_sub(step.started.timestamp)
                    .as_millis(),
            )
            .unwrap_or(u64::MAX)
        });
        // ! the credential a call presents stays out of what is told
        let options = step.options.map(|options| ResolvedRequestOptions {
            credential: None,
            ..options
        });
        let event = DebugEvent {
            call_id: step.call_id,
            // a step names its connection with its call, the server on a client, and none without
            connection_handle: step.call_id.and_then(|_| {
                step.connection_handle.clone().or_else(|| {
                    (side == RouterSide::Client).then(|| Arc::from(SERVER_CONNECTION_HANDLE))
                })
            }),
            direction: step.direction,
            duration,
            options,
            procedure_id: procedure.id,
            procedure_name: procedure.name.clone(),
            rx: step.rx,
            service_id: procedure.service_id,
            service_revision: procedure.service_revision,
            started_at: step.started.instant,
            tx: step.tx,
            call_type: step.call_type,
        };

        for listener in listeners {
            let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                listener(step.error.as_ref(), &event);
            }));

            if let Err(panicked) = called {
                self.router.report(
                    &crate::transport::panic_error(&*panicked),
                    step.connection_handle.as_ref(),
                );
            }
        }
    }

    fn deprecated(&self, procedure: &Procedure) {
        let listeners = self
            .deprecated
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();

        for listener in listeners {
            let called =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(procedure)));

            if let Err(panicked) = called {
                self.router
                    .report(&crate::transport::panic_error(&*panicked), None);
            }
        }
    }
}

/// What closes a connection a call left unanswered past its timeout.
pub type CloseConnection = Arc<dyn Fn(&ConnectionHandle) + Send + Sync>;

/// What a trace tells of a failure: its code, scope and detail.
fn traced_failure_of(error: &CallError) -> Option<Traced> {
    match error {
        CallError::Failure(failure) => Some(Arc::new(failure.record())),
        CallError::Cancelled
        | CallError::Disconnected(_)
        | CallError::TimedOut(_)
        | CallError::Refused(_)
        | CallError::Other(_) => None,
    }
}

impl ServiceManager {
    /// A manager over `router`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a clock given that differs from its router's, or a default timeout
    /// spec 1.4 does not hold.
    pub fn new(
        router: ServiceRouter,
        options: &ServiceManagerOptions,
    ) -> Result<Self, ProgrammerError> {
        let below = router.clock();
        let clock = crate::clock::clock_of(
            (Some(&below), options.clock.as_ref()),
            ("a service manager", "its router"),
        )?
        .unwrap_or(below);
        let defaults = options.defaults.clone().unwrap_or_default();
        // held as the manager is built, rather than refused at each call it would time
        let timeout = hold(
            "a call's default timeout",
            defaults.timeout.unwrap_or(DEFAULT_TIMEOUT),
        )?;

        Ok(Self {
            inner: Arc::new(Inner {
                router,
                clock,
                close_connection: options.close_connection.clone(),
                timeout,
                close_on_timeout: defaults.close_on_timeout,
                debug: Mutex::new(Vec::new()),
                deprecated: Mutex::new(Vec::new()),
                dropped: Mutex::new(Vec::new()),
                notifications: Mutex::new(std::collections::BTreeMap::new()),
            }),
        })
    }

    /// Hears each step of each call from now on.
    pub fn on_debug(&self, listener: DebugListener) {
        self.inner
            .debug
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(listener);
    }

    /// Hears each call of a procedure deprecated from now on.
    pub fn on_deprecated(&self, listener: DeprecatedListener) {
        self.inner
            .deprecated
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(listener);
    }

    /// Hears each subscription of a notification dropped from now on.
    pub fn on_dropped(&self, listener: DroppedListener) {
        self.inner
            .dropped
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(listener);
    }

    /// The notification of `procedure`, one per procedure: asked for again, the same is given.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure off spec section 16, one known with another
    /// declaration or window, a window of 0, or a manager over a server's router, which hears no
    /// notification.
    pub fn get_notification<Req, Res, Not>(
        &self,
        procedure: &Procedure,
        dependencies: NotificationDependencies<Req, Res, Not>,
    ) -> Result<Notification<Req, Res, Not>, ProgrammerError>
    where
        Req: PayloadCodec,
        Res: PayloadCodec,
        Not: PayloadCodec,
        Req::Value: Clone + fmt::Debug + Sync,
        Res::Value: Clone + fmt::Debug + Sync,
        Not::Value: Clone + fmt::Debug + Sync,
    {
        notification::notification_of(self, (procedure, dependencies))
    }

    /// Whether anyone listens to `debug`.
    #[must_use]
    pub fn is_debugging(&self) -> bool {
        self.inner.is_debugging()
    }

    /// The router it runs over.
    #[must_use]
    pub fn router(&self) -> &ServiceRouter {
        &self.inner.router
    }

    /// A requester of `procedure`, declared to its router as it is made.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure its router refuses to declare.
    pub fn get_request<Req, Res>(
        &self,
        procedure: &Procedure,
        dependencies: RequestDependencies<Req, Res>,
    ) -> Result<Request<Req, Res>, ProgrammerError>
    where
        Req: PayloadCodec,
        Res: PayloadCodec,
        Req::Value: Clone + fmt::Debug + Sync,
        Res::Value: Clone + fmt::Debug + Sync,
    {
        self.requester_of(procedure, (dependencies, DebugType::Request))
    }

    /// A requester of the command `procedure`, declared to its router as it is made.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure its router refuses to declare.
    pub fn get_command<Req, Res>(
        &self,
        procedure: &Procedure,
        dependencies: RequestDependencies<Req, Res>,
    ) -> Result<Request<Req, Res>, ProgrammerError>
    where
        Req: PayloadCodec,
        Res: PayloadCodec,
        Req::Value: Clone + fmt::Debug + Sync,
        Res::Value: Clone + fmt::Debug + Sync,
    {
        self.requester_of(procedure, (dependencies, DebugType::Command))
    }

    fn requester_of<Req, Res>(
        &self,
        procedure: &Procedure,
        (dependencies, call_type): (RequestDependencies<Req, Res>, DebugType),
    ) -> Result<Request<Req, Res>, ProgrammerError>
    where
        Req: PayloadCodec,
        Res: PayloadCodec,
    {
        let series = self.inner.router.declare_requester(procedure)?;

        Ok(Request {
            shared: Arc::new(RequestShared {
                manager: Arc::clone(&self.inner),
                procedure: procedure.clone(),
                dependencies,
                series,
                call_type,
            }),
        })
    }

    // a refusal is checked once, as the resolver is asked for, after the procedure's identity
    fn assert_refusal(
        &self,
        (procedure, before_request): (&Procedure, Option<&BeforeRequest>),
    ) -> Result<(), ProgrammerError> {
        check_declaration(procedure)?;

        let side = self.inner.router.side();

        if let Some(refusal) = before_request.and_then(BeforeRequest::refusal)
            && !(refusal
                .is_protocol_code(&[ProtocolCode::SESSION_REQUIRED, ProtocolCode::ACCESS_DENIED])
                && refusal.side() == Some(side))
        {
            return Err(ProgrammerError::new(format!(
                "{} refuses with a failure that is not an admission's of the {}'s table",
                procedure.name,
                side.as_str()
            )));
        }

        Ok(())
    }

    /// A resolver of `procedure`, to register with its callback.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure off spec section 16, or a refusal that is not an
    /// admission's.
    pub fn get_request_resolver<Req, Res>(
        &self,
        procedure: &Procedure,
        dependencies: ResolverDependencies<Req, Res>,
    ) -> Result<ResolverOf<Req, Res>, ProgrammerError>
    where
        Req: PayloadCodec,
        Res: PayloadCodec,
    {
        self.assert_refusal((procedure, dependencies.before_request.as_ref()))?;

        Ok(ResolverOf {
            manager: self.clone(),
            procedure: procedure.clone(),
            dependencies,
            call_type: DebugType::Request,
        })
    }

    /// A resolver of the command `procedure`, on a client, to register with its callback.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure off spec section 16, or a refusal that is not an
    /// admission's.
    pub fn get_command_resolver<Req, Res>(
        &self,
        procedure: &Procedure,
        dependencies: ResolverDependencies<Req, Res>,
    ) -> Result<ResolverOf<Req, Res>, ProgrammerError>
    where
        Req: PayloadCodec,
        Res: PayloadCodec,
    {
        self.assert_refusal((procedure, dependencies.before_request.as_ref()))?;

        Ok(ResolverOf {
            manager: self.clone(),
            procedure: procedure.clone(),
            dependencies,
            call_type: DebugType::Command,
        })
    }

    /// A resolver of `procedure` that notifies, to register with its callback.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure off spec section 16, or a refusal that is not an
    /// admission's.
    pub fn get_notification_resolver<Req, Res, Not>(
        &self,
        procedure: &Procedure,
        (dependencies, notification): (ResolverDependencies<Req, Res>, Not),
    ) -> Result<NotificationResolverOf<Req, Res, Not>, ProgrammerError>
    where
        Req: PayloadCodec,
        Res: PayloadCodec,
        Not: PayloadCodec,
    {
        self.assert_refusal((procedure, dependencies.before_request.as_ref()))?;

        Ok(NotificationResolverOf {
            resolver: ResolverOf {
                manager: self.clone(),
                procedure: procedure.clone(),
                dependencies,
                call_type: DebugType::Request,
            },
            notification,
        })
    }
}

// ── Requesters ───────────────────────────────────────────────────────────────────────────────

struct RequestShared<Req: PayloadCodec, Res: PayloadCodec> {
    manager: Arc<Inner>,
    procedure: Procedure,
    dependencies: RequestDependencies<Req, Res>,
    series: Option<ProcedureSeries>,
    call_type: DebugType,
}

/// A requester of one procedure.
pub struct Request<Req: PayloadCodec, Res: PayloadCodec> {
    shared: Arc<RequestShared<Req, Res>>,
}

impl<Req: PayloadCodec, Res: PayloadCodec> Clone for Request<Req, Res> {
    fn clone(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
        }
    }
}

impl<Req: PayloadCodec, Res: PayloadCodec> fmt::Debug for Request<Req, Res> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Request")
            .field("procedure", &self.shared.procedure)
            .finish_non_exhaustive()
    }
}

/// A call's outcome, to wait for: the call went when it was made.
#[must_use = "the call is sent already; its future only waits for its answer"]
pub struct ServiceCall<T> {
    outcome: oneshot::Receiver<Result<(u32, T), CallError>>,
}

impl<T> fmt::Debug for ServiceCall<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServiceCall")
            .finish_non_exhaustive()
    }
}

impl<T> ServiceCall<T> {
    // its outcome, with the call id its router drew
    pub(crate) async fn with_call_id(self) -> Result<(u32, T), CallError> {
        self.outcome.await.unwrap_or_else(|_dropped| {
            Err(CallError::Disconnected(
                crate::router::core::DISPOSED.to_owned(),
            ))
        })
    }

    fn failed(error: CallError) -> Self {
        let (reply, outcome) = oneshot::channel();

        drop(reply.send(Err(error)));

        Self { outcome }
    }
}

impl<T> Future for ServiceCall<T> {
    type Output = Result<T, CallError>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.outcome).poll(context).map(|outcome| {
            outcome
                .unwrap_or_else(|_dropped| {
                    Err(CallError::Disconnected(
                        crate::router::core::DISPOSED.to_owned(),
                    ))
                })
                .map(|(_, value)| value)
        })
    }
}

impl<Req, Res> Request<Req, Res>
where
    Req: PayloadCodec,
    Res: PayloadCodec,
    Req::Value: Clone + fmt::Debug + Sync,
    Res::Value: Clone + fmt::Debug + Sync,
{
    /// Its procedure.
    #[must_use]
    pub fn procedure(&self) -> &Procedure {
        &self.shared.procedure
    }

    /// Calls its procedure with `payload`, sent as it is made.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a timeout spec 1.4 does not hold, or a call its router refuses as
    /// it is made.
    pub fn call(
        &self,
        payload: Req::Value,
        options: RequestOptions,
    ) -> Result<ServiceCall<Res::Value>, ProgrammerError> {
        self.call_with(payload, (options, None))
    }

    // a call, subscribing the notification `subscribes` names when it does
    #[expect(
        clippy::too_many_lines,
        reason = "a call made, then its steps told in their order, as the other sides tell them"
    )]
    pub(crate) fn call_with(
        &self,
        payload: Req::Value,
        (options, subscribes): (RequestOptions, Option<Arc<dyn NotificationLike>>),
    ) -> Result<ServiceCall<Res::Value>, ProgrammerError> {
        let shared = &self.shared;
        let manager = &shared.manager;
        let procedure = &shared.procedure;
        let resolved = ResolvedRequestOptions {
            timeout: hold(
                "a call's timeout",
                options.timeout.unwrap_or(manager.timeout),
            )?,
            destination_id: options.destination_id,
            connection_handle: options.connection_handle.clone(),
            credential: options.credential,
            signal: options.signal,
            close_on_timeout: options
                .close_on_timeout
                .or(manager.close_on_timeout)
                .unwrap_or(false),
        };
        // * judged before it is written: PAYLOAD_INVALID, its detail under this side's bound
        let refusal = refusal_of(shared, (&payload, resolved.destination_id));
        let encoded = match &refusal {
            Some(_) => Bytes::new(),
            None => match shared.dependencies.request.encode(&payload) {
                Ok(encoded) => encoded,
                // a value that does not write fails before anything goes: nothing requested,
                // traced or deprecated
                Err(refused) => {
                    return Ok(ServiceCall::failed(CallError::Other(Arc::new(refused))));
                }
            },
        };
        // * the one check a call makes while nobody listens: no clock is read, no step is built
        let traced = manager.is_debugging().then(|| Step {
            call_id: None,
            connection_handle: options.connection_handle.clone(),
            direction: DebugDirection::Tx,
            error: None,
            is_answered: false,
            options: Some(resolved.clone()),
            rx: None,
            started: manager.started_now(),
            tx: Some(traced(payload.clone())),
            call_type: shared.call_type,
        });

        if procedure.deprecation.is_some() {
            manager.deprecated(procedure);
        }

        let (on_call_id, call_id) = oneshot::channel::<u32>();
        let close_on_timeout = resolved.close_on_timeout;
        let requested = manager.router.request(
            encoded,
            RouterCall {
                procedure: procedure.clone(),
                options: resolved,
                series: shared.series.clone(),
                refusal,
                on_call_id: Some(Box::new(move |call_id: u32| {
                    on_call_id.send(call_id).ok();
                })),
                subscribes,
            },
        )?;
        let (reply, outcome) = oneshot::channel();
        let shared = Arc::clone(&self.shared);
        let connection_handle = options.connection_handle;

        manager.router.cover(async move {
            let manager = &shared.manager;
            let procedure = &shared.procedure;
            // the call's id, once its router drew it; none for a call refused first
            let mut call_id = match traced {
                Some(_) => call_id.await.ok(),
                None => None,
            };

            if let Some(step) = &traced {
                manager.trace(
                    procedure,
                    Step {
                        call_id,
                        ..step.clone()
                    },
                );
            }

            let answered = requested.await;
            let outcome = match answered {
                Err(reason) => {
                    // a connection that let it go unanswered is closed, when the call or the
                    // manager says so
                    if matches!(reason, CallError::TimedOut(_))
                        && close_on_timeout
                        && let Some(handle) = &connection_handle
                        && let Some(close) = &manager.close_connection
                    {
                        close(handle);
                    }

                    if let Some(step) = &traced {
                        manager.trace(
                            procedure,
                            Step {
                                call_id,
                                direction: DebugDirection::Rx,
                                error: Some(Arc::new(reason.clone())),
                                is_answered: true,
                                rx: traced_failure_of(&reason),
                                ..step.clone()
                            },
                        );
                    }

                    Err(reason)
                }
                Ok(result) => {
                    call_id = Some(result.header.call_id);

                    match shared.dependencies.result.decode(&result.payload) {
                        // an answer that does not decode fails here, with the result's header
                        Err(refused) => {
                            let failure = Failure::protocol(
                                ProtocolCode::PAYLOAD_UNDECODABLE,
                                manager.router.side(),
                            )
                            .saying(refused.reason().to_owned())
                            .about(&crate::envelope::Header::Result(result.header.clone()))
                            .of_call(Some(procedure.address()), None)
                            .caused_by(Arc::new(refused));
                            let reason = CallError::Failure(failure);

                            if let Some(step) = &traced {
                                manager.trace(
                                    procedure,
                                    Step {
                                        call_id,
                                        direction: DebugDirection::Rx,
                                        error: Some(Arc::new(reason.clone())),
                                        is_answered: true,
                                        rx: traced_failure_of(&reason),
                                        ..step.clone()
                                    },
                                );
                            }

                            Err(reason)
                        }
                        Ok(value) => {
                            if let Some(step) = &traced {
                                manager.trace(
                                    procedure,
                                    Step {
                                        call_id,
                                        direction: DebugDirection::Rx,
                                        is_answered: true,
                                        rx: Some(Arc::new(value.clone())),
                                        ..step.clone()
                                    },
                                );
                            }

                            Ok((result.header.call_id, value))
                        }
                    }
                }
            };

            drop(reply.send(outcome));
        });

        Ok(ServiceCall { outcome })
    }
}

fn refusal_of<Req: PayloadCodec, Res: PayloadCodec>(
    shared: &RequestShared<Req, Res>,
    (payload, destination_id): (&Req::Value, Option<u32>),
) -> Option<CallError> {
    let validate = shared.dependencies.validate.as_ref()?;
    let limits = shared.manager.router.limits();
    let maximum_bytes = detail_bound_of(
        usize::try_from(limits.maximum_detail_bytes).unwrap_or(usize::MAX),
        usize::try_from(limits.maximum_envelope_bytes).unwrap_or(usize::MAX),
    );
    let judged = validate(
        payload,
        ValidateOptions {
            fail_fast: shared.dependencies.fail_fast,
            maximum_bytes,
        },
    );

    is_refused(&judged).then(|| {
        CallError::Failure(
            Failure::protocol(ProtocolCode::PAYLOAD_INVALID, shared.manager.router.side())
                .saying(violations_detail_of(&judged, maximum_bytes))
                .of_call(Some(shared.procedure.address()), destination_id),
        )
    })
}

// ── Resolvers ────────────────────────────────────────────────────────────────────────────────

/// What a resolver reads and writes by, admits by, and judges a request by.
pub struct ResolverDependencies<Req: PayloadCodec, Res: PayloadCodec> {
    /// The request's codec.
    pub request: Req,
    /// The result's codec.
    pub result: Res,
    /// Whether a request may reach the callback, on its header and its call's session.
    pub before_request: Option<BeforeRequest>,
    /// The rules a request is judged by before the callback.
    pub validate: Option<Validate<Req::Value>>,
    /// Whether its rules stop at the first violation.
    pub fail_fast: bool,
}

impl<Req: PayloadCodec, Res: PayloadCodec> fmt::Debug for ResolverDependencies<Req, Res> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolverDependencies")
            .field("request", &self.request)
            .field("result", &self.result)
            .finish_non_exhaustive()
    }
}

impl<Req: PayloadCodec, Res: PayloadCodec> ResolverDependencies<Req, Res> {
    /// A resolver's codecs, admitting every request, judged by no rule.
    #[must_use]
    pub fn of(request: Req, result: Res) -> Self {
        Self {
            request,
            result,
            before_request: None,
            validate: None,
            fail_fast: false,
        }
    }
}

/// A request as a resolver's callback is handed it: decoded, with its call's session.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct RequestProps<T> {
    /// The connection it came on.
    pub connection_handle: ConnectionHandle,
    /// Its header, its bearer credential said by its scheme alone.
    pub header: RequestHeader,
    /// Its payload, decoded.
    pub payload: T,
    /// Its call's session.
    pub session: Option<CallSession>,
    /// What tells its call ended before its answer.
    pub signal: Signal,
}

struct ResponseShared<Res: PayloadCodec> {
    manager: Arc<Inner>,
    procedure: Procedure,
    codec: Arc<Res>,
    answerer: Arc<dyn Answerer>,
    is_answered: AtomicBool,
    connection_handle: ConnectionHandle,
    call_id: u32,
    signal: Signal,
    // the step a traced request told as it came
    step: Option<Step>,
    // the failures it lists, beside those of admission
    listed: Option<Arc<[u16]>>,
}

/// What answers a request: its result, or a failure, once.
pub struct Response<Res: PayloadCodec> {
    shared: Arc<ResponseShared<Res>>,
}

impl<Res: PayloadCodec> Clone for Response<Res> {
    fn clone(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
        }
    }
}

impl<Res: PayloadCodec> fmt::Debug for Response<Res> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Response")
            .field("call_id", &self.shared.call_id)
            .finish_non_exhaustive()
    }
}

// a failure a resolver answers: one of its own, or a refusal of admission of its side's table
fn resolver_failure_of(
    failure: &Failure,
    side: RouterSide,
) -> Result<FailureRecord, ProgrammerError> {
    if failure.is_application()
        || (failure
            .is_protocol_code(&[ProtocolCode::SESSION_REQUIRED, ProtocolCode::ACCESS_DENIED])
            && failure.side().is_none_or(|of| of == side))
    {
        return Ok(failure.record());
    }

    Err(ProgrammerError::new(format!(
        "a resolver answers a failure of its own, from 1 to 65535, or a refusal of admission from the {}'s table, not {}",
        side.as_str(),
        failure.code()
    )))
}

impl<Res> Response<Res>
where
    Res: PayloadCodec,
    Res::Value: Clone + fmt::Debug + Sync,
{
    /// Answers its request with `value`.
    pub fn result(&self, value: Res::Value) -> BoxFuture<Result<(), ResolverError>> {
        let told = traced(value.clone());
        let encoded = self
            .shared
            .codec
            .encode(&value)
            .map(RouterAnswer::Result)
            .map_err(ResolverError::other);

        self.answer((encoded, told))
    }

    /// Answers its request with `failure`: one of its own, or a refusal of admission.
    pub fn failure(&self, failure: &Failure) -> BoxFuture<Result<(), ResolverError>> {
        let shared = &self.shared;

        // a failure it does not list is reported, and answered all the same
        if let Some(listed) = &shared.listed
            && failure.is_application()
            && !listed.contains(&failure.code().get())
        {
            shared.manager.router.report(
                &RouterError::Other(Arc::new(ProgrammerError::new(format!(
                    "{} answers failure {}, which it does not list",
                    shared.procedure.name,
                    failure.code()
                )))),
                Some(&shared.connection_handle),
            );
        }

        let told = traced(failure.record());
        let answer = resolver_failure_of(failure, shared.manager.router.side())
            .map(RouterAnswer::Failure)
            .map_err(ResolverError::other);

        self.answer((answer, told))
    }

    // what fails before the answer goes out leaves the request unanswered, to be answered as failed
    fn answer(
        &self,
        (answer, told): (Result<RouterAnswer, ResolverError>, Traced),
    ) -> BoxFuture<Result<(), ResolverError>> {
        let shared = Arc::clone(&self.shared);

        Box::pin(async move {
            if shared.is_answered.load(Ordering::Acquire) {
                return Err(ResolverError::other(ProgrammerError::new(format!(
                    "{} has answered this request already",
                    shared.procedure.name
                ))));
            }

            let answer = answer?;

            shared.is_answered.store(true, Ordering::Release);

            // a request its router answered in its place takes this answer nowhere: its step is
            // told once, with the failure its router answered
            let answered = shared.answerer.answered().await;
            let step = shared.step.clone().map(|step| Step {
                direction: DebugDirection::Tx,
                is_answered: true,
                tx: Some(Arc::clone(&told)),
                ..step
            });

            if let Some(step) = &step {
                shared.manager.trace(
                    &shared.procedure,
                    answered.as_ref().map_or_else(
                        || step.clone(),
                        |record| Step {
                            error: Some(Arc::new(CallError::Failure(Failure::received(
                                record,
                                shared.manager.router.side(),
                            )))),
                            ..step.clone()
                        },
                    ),
                );
            }

            if answered.is_some() {
                return Ok(());
            }

            if let Err(reason) = shared.answerer.respond(answer).await {
                // an answer the router could not send is told again at its start with why, and
                // answered as failed; a call no longer answered takes neither
                if let Some(step) = &step
                    && !shared.signal.is_aborted()
                {
                    shared.manager.trace(
                        &shared.procedure,
                        Step {
                            error: Some(Arc::new(reason.clone())),
                            ..step.clone()
                        },
                    );
                }

                let failed =
                    Failure::protocol(ProtocolCode::PROCEDURE_FAILED, shared.manager.router.side())
                        .record();

                drop(shared.answerer.respond(RouterAnswer::Failure(failed)).await);

                return Err(ResolverError::other(reason));
            }

            Ok(())
        })
    }

    /// Subscribes its requester to its procedure, before it answers.
    pub fn register_notification(&self) -> BoxFuture<Result<u32, CallError>> {
        if self.shared.is_answered.load(Ordering::Acquire) {
            let error = ProgrammerError::new(format!(
                "{} subscribes before it answers",
                self.shared.procedure.name
            ));

            return Box::pin(async move { Err(CallError::Refused(error)) });
        }

        self.shared.answerer.subscribe()
    }
}

/// What a resolver's callback is: handed a request and what answers it.
pub type ResolverCallback<Req, Res> = Arc<
    dyn Fn(
            RequestProps<<Req as PayloadCodec>::Value>,
            Response<Res>,
        ) -> BoxFuture<Result<(), ResolverError>>
        + Send
        + Sync,
>;

/// A resolver of one procedure, its callback to come.
pub struct ResolverOf<Req: PayloadCodec, Res: PayloadCodec> {
    manager: ServiceManager,
    procedure: Procedure,
    dependencies: ResolverDependencies<Req, Res>,
    call_type: DebugType,
}

impl<Req: PayloadCodec, Res: PayloadCodec> fmt::Debug for ResolverOf<Req, Res> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolverOf")
            .field("procedure", &self.procedure)
            .finish_non_exhaustive()
    }
}

impl<Req, Res> ResolverOf<Req, Res>
where
    Req: PayloadCodec,
    Res: PayloadCodec,
    Req::Value: Clone + fmt::Debug + Sync,
    Res::Value: Clone + fmt::Debug + Sync,
{
    /// Registers it with `callback`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] its router refuses it with: a second resolver of its procedure, say.
    pub fn on(self, callback: ResolverCallback<Req, Res>) -> Result<(), ProgrammerError> {
        self.register((callback, None), false)
    }

    pub(crate) fn register(
        self,
        (callback, listed): (ResolverCallback<Req, Res>, Option<Arc<[u16]>>),
        notifies: bool,
    ) -> Result<(), ProgrammerError> {
        let Self {
            manager,
            procedure,
            dependencies,
            call_type,
        } = self;
        let side = manager.inner.router.side();
        let admit = dependencies
            .before_request
            .as_ref()
            .map(|before_request| before_request.admission(side));
        let resolving = Arc::new(Resolving {
            manager: Arc::clone(&manager.inner),
            procedure: procedure.clone(),
            request: dependencies.request,
            result: Arc::new(dependencies.result),
            validate: dependencies.validate,
            fail_fast: dependencies.fail_fast,
            callback,
            call_type,
            listed,
        });
        let handler = Handler {
            resolve: Arc::new(move |props: ResolverProps| {
                let resolving = Arc::clone(&resolving);

                Box::pin(async move { resolving.resolve(props).await })
            }),
            admit,
            maximum_payload_bytes: procedure.maximum_payload_bytes,
            forwards_credentials: false,
            notifies,
        };

        manager
            .inner
            .router
            .register_resolver((&procedure, handler))
    }
}

struct Resolving<Req: PayloadCodec, Res: PayloadCodec> {
    manager: Arc<Inner>,
    procedure: Procedure,
    request: Req,
    result: Arc<Res>,
    validate: Option<Validate<Req::Value>>,
    fail_fast: bool,
    callback: ResolverCallback<Req, Res>,
    call_type: DebugType,
    listed: Option<Arc<[u16]>>,
}

impl<Req, Res> Resolving<Req, Res>
where
    Req: PayloadCodec,
    Res: PayloadCodec,
    Req::Value: Clone + fmt::Debug + Sync,
    Res::Value: Clone + fmt::Debug + Sync,
{
    fn failure(&self, code: ProtocolCode) -> FailureRecord {
        Failure::protocol(code, self.manager.router.side()).record()
    }

    #[expect(
        clippy::too_many_lines,
        reason = "a request decoded, judged, handed and answered, its steps told in their order"
    )]
    async fn resolve(&self, props: ResolverProps) -> Result<(), ResolverError> {
        let ResolverProps {
            connection_handle,
            header,
            payload,
            session,
            signal,
            answerer,
            ..
        } = props;
        let manager = &self.manager;
        // * the one check a request makes while nobody listens; traced, the call starts as it
        // arrives, its decoding counting in its duration
        let started = manager.is_debugging().then(|| manager.started_now());
        // a payload that does not decode never reaches the callback
        let Ok(value) = self.request.decode(&payload) else {
            return answerer
                .respond(RouterAnswer::Failure(
                    self.failure(ProtocolCode::PAYLOAD_UNDECODABLE),
                ))
                .await
                .map_err(ResolverError::other);
        };
        let step = started.map(|started| Step {
            call_id: Some(header.call_id),
            connection_handle: Some(Arc::clone(&connection_handle)),
            direction: DebugDirection::Rx,
            error: None,
            is_answered: false,
            options: None,
            rx: Some(traced(value.clone())),
            started,
            tx: None,
            call_type: self.call_type,
        });

        if let Some(step) = &step {
            manager.trace(&self.procedure, step.clone());
        }

        // * a payload that reads is judged by its rules before the callback (spec 18.2)
        if let Some(validate) = &self.validate {
            let limits = manager.router.limits();
            let maximum_bytes = detail_bound_of(
                usize::try_from(limits.maximum_detail_bytes).unwrap_or(usize::MAX),
                usize::try_from(limits.maximum_envelope_bytes).unwrap_or(usize::MAX),
            );
            let judging = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                validate(
                    &value,
                    ValidateOptions {
                        fail_fast: self.fail_fast,
                        maximum_bytes,
                    },
                )
            }));
            let judged = match judging {
                Ok(judged) => judged,
                // a rule that fails to judge is its side's own error, answered as a resolver's
                Err(panicked) => {
                    let error = crate::transport::panic_error(&*panicked);

                    if let Some(step) = &step
                        && !signal.is_aborted()
                    {
                        manager.trace(
                            &self.procedure,
                            Step {
                                direction: DebugDirection::Tx,
                                error: Some(Arc::new(error.clone())),
                                is_answered: true,
                                ..step.clone()
                            },
                        );
                    }

                    drop(
                        answerer
                            .respond(RouterAnswer::Failure(
                                self.failure(ProtocolCode::PROCEDURE_FAILED),
                            ))
                            .await,
                    );

                    return Err(ResolverError::other(error));
                }
            };

            if is_refused(&judged) {
                let failure =
                    Failure::protocol(ProtocolCode::PAYLOAD_INVALID, manager.router.side())
                        .saying(violations_detail_of(&judged, maximum_bytes))
                        .record();

                if let Some(step) = &step {
                    manager.trace(
                        &self.procedure,
                        Step {
                            direction: DebugDirection::Tx,
                            is_answered: true,
                            tx: Some(Arc::new(failure.clone())),
                            ..step.clone()
                        },
                    );
                }

                return answerer
                    .respond(RouterAnswer::Failure(failure))
                    .await
                    .map_err(ResolverError::other);
            }
        }

        let response = Response {
            shared: Arc::new(ResponseShared {
                manager: Arc::clone(manager),
                procedure: self.procedure.clone(),
                codec: Arc::clone(&self.result),
                answerer: Arc::clone(&answerer),
                is_answered: AtomicBool::new(false),
                connection_handle: Arc::clone(&connection_handle),
                call_id: header.call_id,
                signal: signal.clone(),
                step: step.clone(),
                listed: self.listed.clone(),
            }),
        };
        let request = RequestProps {
            connection_handle,
            header,
            payload: value,
            session,
            signal: signal.clone(),
        };
        let outcome = (self.callback)(request, response.clone()).await;

        if let Err(reason) = outcome {
            // a resolver that failed before it answered still answers, told with why beside it; a
            // call no longer answered takes neither
            if !response.shared.is_answered.swap(true, Ordering::AcqRel) {
                if let Some(step) = &step
                    && !signal.is_aborted()
                {
                    manager.trace(
                        &self.procedure,
                        Step {
                            direction: DebugDirection::Tx,
                            error: Some(Arc::new(ResolverFailed(reason.to_string()))),
                            is_answered: true,
                            ..step.clone()
                        },
                    );
                }

                drop(
                    answerer
                        .respond(RouterAnswer::Failure(
                            self.failure(ProtocolCode::PROCEDURE_FAILED),
                        ))
                        .await,
                );
            }

            return Err(reason);
        }

        Ok(())
    }
}

/// Why a resolver's callback failed, as its trace tells it.
#[derive(Debug, Clone)]
struct ResolverFailed(String);

impl fmt::Display for ResolverFailed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for ResolverFailed {}

// ── Notifications, sent ──────────────────────────────────────────────────────────────────────

/// Who a notification goes to: a subscription's connection, and its session's identifier.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Subscriber {
    /// Its connection.
    pub connection_handle: ConnectionHandle,
    /// Its credential's session's identifier; none for its connection's.
    pub identifier: Option<SessionIdentifier>,
}

/// Which subscriptions a notification goes to: each it keeps.
pub type SubscriberFilter = Arc<dyn Fn(&Subscriber) -> bool + Send + Sync>;

/// How a notification is sent.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct NotifyOptions {
    /// A connection it does not go to.
    pub exclude: Option<ConnectionHandle>,
    /// The subscriptions it goes to: each it keeps.
    pub filter: Option<SubscriberFilter>,
    /// What a paced subscription's queue keeps the last of.
    pub key: Option<NotificationKey>,
}

impl fmt::Debug for NotifyOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotifyOptions")
            .field("exclude", &self.exclude)
            .field("key", &self.key)
            .finish_non_exhaustive()
    }
}

fn filter_of(options: &NotifyOptions) -> Option<NotifyFilter> {
    if options.exclude.is_none() && options.filter.is_none() {
        return None;
    }

    let exclude = options.exclude.clone();
    let filter = options.filter.clone();

    Some(Arc::new(
        move |handle: &ConnectionHandle, identifier: Option<&SessionIdentifier>| {
            exclude.as_ref().is_none_or(|excluded| excluded != handle)
                && filter.as_ref().is_none_or(|filter| {
                    filter(&Subscriber {
                        connection_handle: Arc::clone(handle),
                        identifier: identifier.cloned(),
                    })
                })
        },
    ))
}

/// A resolver that notifies, its callback to come.
pub struct NotificationResolverOf<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> {
    resolver: ResolverOf<Req, Res>,
    notification: Not,
}

impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> fmt::Debug
    for NotificationResolverOf<Req, Res, Not>
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotificationResolverOf")
            .field("resolver", &self.resolver)
            .finish_non_exhaustive()
    }
}

impl<Req, Res, Not> NotificationResolverOf<Req, Res, Not>
where
    Req: PayloadCodec,
    Res: PayloadCodec,
    Not: PayloadCodec,
    Req::Value: Clone + fmt::Debug + Sync,
    Res::Value: Clone + fmt::Debug + Sync,
    Not::Value: Clone + fmt::Debug + Sync,
{
    /// Registers it with `callback`, and gives what notifies its subscriptions.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] its router refuses it with.
    pub fn on(
        self,
        callback: ResolverCallback<Req, Res>,
    ) -> Result<Notifier<Not>, ProgrammerError> {
        self.register((callback, None))
    }

    pub(crate) fn register(
        self,
        (callback, listed): (ResolverCallback<Req, Res>, Option<Arc<[u16]>>),
    ) -> Result<Notifier<Not>, ProgrammerError> {
        let manager = Arc::clone(&self.resolver.manager.inner);
        let procedure = self.resolver.procedure.clone();

        self.resolver.register((callback, listed), true)?;

        Ok(Notifier {
            shared: Arc::new(NotifierShared {
                manager,
                procedure,
                codec: self.notification,
            }),
        })
    }
}

struct NotifierShared<Not: PayloadCodec> {
    manager: Arc<Inner>,
    procedure: Procedure,
    codec: Not,
}

/// What notifies the subscriptions of one procedure.
pub struct Notifier<Not: PayloadCodec> {
    shared: Arc<NotifierShared<Not>>,
}

impl<Not: PayloadCodec> Clone for Notifier<Not> {
    fn clone(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
        }
    }
}

impl<Not: PayloadCodec> fmt::Debug for Notifier<Not> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Notifier")
            .field("procedure", &self.shared.procedure)
            .finish_non_exhaustive()
    }
}

impl<Not> Notifier<Not>
where
    Not: PayloadCodec,
    Not::Value: Clone + fmt::Debug + Sync,
{
    /// Sends `notification` to each subscription `options` keeps, sent as it is called.
    pub fn notify(&self, notification: Not::Value, options: &NotifyOptions) -> BoxFuture<()> {
        let shared = &self.shared;
        let manager = &shared.manager;
        // * the one check a notification makes while nobody listens
        let step = manager.is_debugging().then(|| Step {
            call_id: None,
            connection_handle: None,
            direction: DebugDirection::Tx,
            error: None,
            is_answered: false,
            options: None,
            rx: None,
            started: manager.notified_now(),
            tx: Some(traced(notification.clone())),
            call_type: DebugType::Notification,
        });

        if let Some(step) = &step {
            manager.trace(&shared.procedure, step.clone());
        }

        // a value that does not write goes to the router in its payload's place, for it to count
        // failed at each subscription it was for and report (spec 17.2, item 6)
        let payload = shared
            .codec
            .encode(&notification)
            .map_err(|refused| RouterError::Other(Arc::new(refused)));
        let failure = payload.as_ref().err().cloned();
        let notified = match &manager.router {
            ServiceRouter::Server(router) => router.notify(
                payload,
                (
                    shared.procedure.address(),
                    filter_of(options),
                    options.key.clone(),
                ),
            ),
            // * only a server notifies; a client asks with a request
            ServiceRouter::Client(_) => Box::pin(async {}),
        };
        let shared = Arc::clone(&self.shared);

        Box::pin(async move {
            notified.await;

            // what keeps it from going out is told at the start it was sent with
            if let (Some(failure), Some(step)) = (failure, step) {
                shared.manager.trace(
                    &shared.procedure,
                    Step {
                        error: Some(Arc::new(failure)),
                        ..step
                    },
                );
            }
        })
    }
}
