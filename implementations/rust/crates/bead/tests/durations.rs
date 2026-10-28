//! Bead's durations played at every place that takes a duration an application gives the Rust
//! side, by every way it takes it (decision 0014): each place built on a stepping clock, given each
//! input the file holds or none, and what it holds read back — an option, the due of the timer it
//! arms — or its refusal, by its reason's code; the words stay Rust's. A trial a place.

use core::time::Duration;
use std::collections::BTreeMap;
use std::process::ExitCode;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use bead::testing::SteppingClock;
use bead::testing::durations::{DurationInput, DurationPlace, Durations, PlaceOutcome};
use bead::{
    BeforeRequest, BoxFuture, Call, CallError, CallHooks, ClientListener, ClientRequest,
    ClientTransport, ConnectionHandle, DebugEvent, DestinationOptions, DurationRefusal, Envelope,
    LIMIT_DEFAULTS, MAXIMUM_DETAIL_BYTES, MemoryClient, MemoryClientOptions, MemoryConnectOptions,
    MemoryServer, MemoryServerOptions, NEVER, Procedure, ProgrammerError, RawCodec, ReadyState,
    ReconnectDelay, ReconnectOptions, Refusal, RelayLeg, RelayOptions, RelayRouter, RelayTarget,
    RequestDefaults, RequestDependencies, RequestHeader, RequestOptions, ResolvedRequestOptions,
    RouterClient, RouterClientOptions, RouterError, RouterLimits, RouterLimitsOptions,
    RouterServer, RouterServerOptions, Sent, Server, ServerListener, ServerOptions,
    ServerTransport, ServiceManager, ServiceManagerOptions, ServiceRouter, SessionManagerOptions,
    SharedClock, TransportError, TransportMessage, limits_of, write_envelope,
};
use bytes::Bytes;
use libtest_mimic::{Arguments, Failed, Trial};

const HANDLE: &str = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";
const OTHER: &str = "type=WS;ip=127.0.0.1;port=50002;ordinal=1";

const MILLISECOND: Duration = Duration::from_millis(1);

// the other timeout of a session a reset plays, armed as it is set
const OTHER_TIMEOUT: Duration = Duration::from_secs(1);

// the places this side plays, by the id the file keys them by; every other is ahead, with the
// stage that brings it: its transports over HTTP and WebSocket, its broker core and bindings, its
// gateway
const PLACES: [&str; 13] = [
    "call.timeout",
    "serviceManager.defaultTimeout",
    "router.reservation",
    "router.transferInactivityTimeout",
    "relay.timeout",
    "sessionManager.connectionInactivityTimeout",
    "sessionManager.sessionInactivityTimeout",
    "session.inactivityTimeouts",
    "sessionManager.resetConnectionInactivityTimeout",
    "sessionManager.resetSessionInactivityTimeout",
    "server.connectionInactivityTimeout",
    "transportClient.connectTimeout",
    "transportClient.reconnectionDelay",
];

// the ways of each place this side has, the others its rows excuse it from
fn ways_of(place: &str) -> &'static [&'static str] {
    match place {
        "call.timeout" => &["serviceManager", "router"],
        "router.transferInactivityTimeout" => &["limits"],
        "serviceManager.defaultTimeout"
        | "sessionManager.connectionInactivityTimeout"
        | "sessionManager.sessionInactivityTimeout"
        | "server.connectionInactivityTimeout" => &["options"],
        "router.reservation" => &["reserve", "cancel"],
        "relay.timeout" => &["relay", "register"],
        "session.inactivityTimeouts" => &[
            "setConnection",
            "setSession",
            "updateConnection",
            "updateSession",
        ],
        "sessionManager.resetConnectionInactivityTimeout"
        | "sessionManager.resetSessionInactivityTimeout" => &["reset"],
        "transportClient.connectTimeout" => &["memory"],
        "transportClient.reconnectionDelay" => &["function", "number"],
        _ => &[],
    }
}

// the ways of a place played that are ahead, each with the stage that brings it: a connect's
// timeout over HTTP and WebSocket with Rust's transports over them, and over a broker with its
// broker core
fn ahead_of(place: &str) -> &'static [&'static str] {
    match place {
        "transportClient.connectTimeout" => &["http", "webSocket", "broker"],
        _ => &[],
    }
}

/// What a place built one way holds of what it was given, or its refusal.
#[derive(Debug)]
enum Observed {
    Held(Duration),
    Refused(ProgrammerError),
}

type Played = Result<Observed, String>;

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn epoch() -> SystemTime {
    SystemTime::UNIX_EPOCH
}

fn shared_of(clock: &Arc<SteppingClock>) -> SharedClock {
    Arc::<SteppingClock>::clone(clock)
}

// ! the due of the one timer armed, never for none: two or more fail, rather than read as never
fn due_of(dues: &[Duration]) -> Result<Duration, String> {
    match dues {
        [] => Ok(NEVER),
        [due] => Ok(*due),
        _ => Err(format!("one timer at most, not {dues:?}")),
    }
}

fn hold<S: FnOnce() -> String>(holds: bool, said: S) -> Result<(), String> {
    if holds { Ok(()) } else { Err(said()) }
}

// ── The transports ───────────────────────────────────────────────────────────────────────────

// a client's transport, open, which records what it sends
#[derive(Debug, Default)]
struct Recording {
    sent: Mutex<Vec<Bytes>>,
}

impl ClientTransport for Recording {
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError> {
        locked(&self.sent).push(message.data);

        Ok(Sent::Done)
    }

    fn listen(&self, _listener: Arc<dyn ClientListener>) {}

    fn unlisten(&self, _listener: &Arc<dyn ClientListener>) {}

    fn ready_state(&self) -> ReadyState {
        ReadyState::Open
    }

    fn is_secure(&self) -> bool {
        true
    }
}

// a server's transport of the connections it is told, which records what it closes
#[derive(Default)]
struct Pipe {
    listeners: Mutex<Vec<Arc<dyn ServerListener>>>,
    closed: Mutex<Vec<ConnectionHandle>>,
}

impl core::fmt::Debug for Pipe {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.debug_struct("Pipe").finish_non_exhaustive()
    }
}

impl Pipe {
    fn open(&self, handle: &str) {
        let handle: ConnectionHandle = Arc::from(handle);

        let listeners = locked(&self.listeners).clone();

        for listener in listeners {
            listener.on_connection(&handle);
        }
    }

    fn message(&self, (handle, data): (&str, Bytes)) {
        let handle: ConnectionHandle = Arc::from(handle);

        let listeners = locked(&self.listeners).clone();

        for listener in listeners {
            listener.on_message(
                TransportMessage {
                    data: data.clone(),
                    ..TransportMessage::default()
                },
                &handle,
            );
        }
    }
}

impl ServerTransport for Pipe {
    fn send(
        &self,
        _message: TransportMessage,
        _connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        Ok(Sent::Done)
    }

    fn close(&self, connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        locked(&self.closed).push(Arc::clone(connection_handle));

        Box::pin(async { true })
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        locked(&self.listeners).push(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        locked(&self.listeners).retain(|held| !Arc::ptr_eq(held, listener));
    }

    fn is_secure(&self, _connection_handle: &ConnectionHandle) -> bool {
        true
    }

    fn start(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> BoxFuture<()> {
        Box::pin(async {})
    }
}

fn echo() -> Procedure {
    Procedure {
        service_id: 2,
        id: 1,
        service_revision: 3,
        name: "echo".to_owned(),
        kind: None,
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

// ── call.timeout and serviceManager.defaultTimeout ───────────────────────────────────────────

struct Calling {
    clock: Arc<SteppingClock>,
    transport: Arc<Recording>,
    router: RouterClient,
}

fn calling() -> Result<Calling, String> {
    let clock = SteppingClock::new(epoch());
    let transport = Arc::new(Recording::default());
    let mut options = RouterClientOptions::default();

    options.clock = Some(shared_of(&clock));

    let router = RouterClient::new(Arc::<Recording>::clone(&transport), &options)
        .map_err(|error| error.to_string())?;

    Ok(Calling {
        clock,
        transport,
        router,
    })
}

// the timeout a call a manager makes is traced with, as its router is handed it: none traced and
// nothing sent where it is refused
async fn traced_call(
    calling: &Calling,
    (manager, given): (&ServiceManager, Option<Duration>),
) -> Played {
    let seen: Arc<Mutex<Vec<DebugEvent>>> = Arc::default();
    let seeing = Arc::clone(&seen);

    manager.on_debug(Arc::new(move |_error, event: &DebugEvent| {
        locked(&seeing).push(event.clone());
    }));

    let request = manager
        .get_request(&echo(), RequestDependencies::of(RawCodec, RawCodec))
        .map_err(|error| error.to_string())?;
    let mut options = RequestOptions::default();

    options.timeout = given;

    match request.call(Bytes::from_static(&[1]), options) {
        Err(refused) => {
            calling.clock.settle().await;
            hold(
                locked(&seen).is_empty() && locked(&calling.transport.sent).is_empty(),
                || "a refused call traced or sent something".to_owned(),
            )?;

            Ok(Observed::Refused(refused))
        }
        Ok(call) => {
            drop(call);
            calling.clock.settle().await;

            let seen = locked(&seen).clone();
            let traced = seen
                .first()
                .and_then(|event| event.options.as_ref())
                .map(|options| options.timeout)
                .ok_or("a call traced with its options")?;
            let due = due_of(&calling.clock.dues())?;

            hold(due == traced, || {
                format!("traced {traced:?}, its router's timer due {due:?}")
            })?;

            Ok(Observed::Held(traced))
        }
    }
}

async fn call_by_service_manager(given: Option<Duration>) -> Played {
    let calling = calling()?;
    let manager = ServiceManager::new(
        ServiceRouter::Client(calling.router.clone()),
        &ServiceManagerOptions::default(),
    )
    .map_err(|error| error.to_string())?;

    traced_call(&calling, (&manager, given)).await
}

async fn default_timeout_by_options(given: Option<Duration>) -> Played {
    let calling = calling()?;
    let mut options = ServiceManagerOptions::default();
    let mut defaults = RequestDefaults::default();

    defaults.timeout = given;
    options.defaults = Some(defaults);

    match ServiceManager::new(ServiceRouter::Client(calling.router.clone()), &options) {
        Err(refused) => Ok(Observed::Refused(refused)),
        Ok(manager) => traced_call(&calling, (&manager, None)).await,
    }
}

fn resolved(timeout: Duration) -> ResolvedRequestOptions {
    ResolvedRequestOptions {
        timeout,
        destination_id: None,
        connection_handle: None,
        credential: None,
        signal: None,
        close_on_timeout: false,
    }
}

// the options its router's request is given: no answer a millisecond short of what it holds, and
// the call ended at it; never, waiting on past the ceiling; refused, nothing sent
async fn call_by_router(given: Option<Duration>) -> Played {
    let given = given.ok_or("the router's way takes its timeout")?;
    let calling = calling()?;
    let call = calling
        .router
        .request(
            Bytes::from_static(&[1]),
            (
                ClientRequest::of(echo(), resolved(given)),
                CallHooks::default(),
            ),
        )
        .map_err(|error| error.to_string())?;
    let waiting = tokio::spawn(call);

    calling.clock.settle().await;

    if waiting.is_finished() {
        return match waiting.await.map_err(|error| error.to_string())? {
            Err(CallError::Refused(refused)) => {
                hold(locked(&calling.transport.sent).is_empty(), || {
                    "a refused call sent something".to_owned()
                })?;

                Ok(Observed::Refused(refused))
            }
            other => Err(format!("ended at once with {other:?}")),
        };
    }

    hold(locked(&calling.transport.sent).len() == 1, || {
        "the request sent".to_owned()
    })?;

    let due = due_of(&calling.clock.dues())?;

    if due == NEVER {
        calling.clock.advance(bead::LONGEST_TIMER).await;
        hold(!waiting.is_finished(), || {
            "a call without end ended".to_owned()
        })?;
        waiting.abort();

        return Ok(Observed::Held(NEVER));
    }

    calling.clock.advance(due.saturating_sub(MILLISECOND)).await;
    hold(!waiting.is_finished(), || {
        "ended a millisecond short".to_owned()
    })?;
    calling.clock.advance(MILLISECOND).await;

    match waiting.await.map_err(|error| error.to_string())? {
        Err(CallError::TimedOut(timeout)) if timeout == due => Ok(Observed::Held(due)),
        other => Err(format!("ended with {other:?} at {due:?}")),
    }
}

// ── router.reservation ───────────────────────────────────────────────────────────────────────

// how long a call id stays reserved: the due of its timer, reserved a millisecond short of it, free
// at it
async fn reserved_for(calling: &Calling, call_id: u32) -> Played {
    calling.clock.settle().await;

    let due = due_of(&calling.clock.dues())?;

    calling.clock.advance(due.saturating_sub(MILLISECOND)).await;
    hold(calling.router.is_reserved(call_id).await, || {
        "free a millisecond short".to_owned()
    })?;
    calling.clock.advance(MILLISECOND).await;
    hold(!calling.router.is_reserved(call_id).await, || {
        "reserved past its due".to_owned()
    })?;

    Ok(Observed::Held(due))
}

async fn reservation_by_reserve(given: Option<Duration>) -> Played {
    let calling = calling()?;

    match calling.router.reserve((1, given)) {
        Err(refused) => {
            calling.clock.settle().await;
            hold(!calling.router.is_reserved(1).await, || {
                "reserved, where it is refused".to_owned()
            })?;

            Ok(Observed::Refused(refused))
        }
        Ok(reserving) => {
            reserving.await;

            reserved_for(&calling, 1).await
        }
    }
}

async fn reservation_by_cancel(given: Option<Duration>) -> Played {
    let calling = calling()?;

    match calling.router.cancel((3, given)) {
        Err(refused) => {
            calling.clock.settle().await;
            hold(
                !calling.router.is_reserved(3).await && locked(&calling.transport.sent).is_empty(),
                || "reserved or sent, where it is refused".to_owned(),
            )?;

            Ok(Observed::Refused(refused))
        }
        Ok(cancelling) => {
            cancelling.await;
            calling.clock.settle().await;
            hold(locked(&calling.transport.sent).len() == 1, || {
                "its cancel sent".to_owned()
            })?;

            reserved_for(&calling, 3).await
        }
    }
}

// ── router.transferInactivityTimeout ─────────────────────────────────────────────────────────

#[expect(clippy::unused_async, reason = "every way is played alike, awaited")]
async fn transfer_inactivity_by_limits(given: Option<Duration>) -> Played {
    let mut options = RouterLimitsOptions::default();

    options.transfer_inactivity_timeout = given;

    Ok(match limits_of(&options) {
        Ok(limits) => Observed::Held(limits.transfer_inactivity_timeout),
        Err(refused) => Observed::Refused(refused),
    })
}

// ── relay.timeout ────────────────────────────────────────────────────────────────────────────

// a router behind the relay, which records the timeout each leg B is asked with
#[derive(Debug, Default)]
struct Target {
    asked: Mutex<Vec<Duration>>,
}

impl RelayRouter for Target {
    fn limits(&self) -> RouterLimits {
        LIMIT_DEFAULTS
    }

    fn request(&self, _payload: Bytes, leg: RelayLeg) -> Result<Call, ProgrammerError> {
        locked(&self.asked).push(leg.options.timeout);

        Ok(Call::refused(CallError::Cancelled))
    }
}

fn admitting() -> RelayOptions {
    let mut relay = RelayOptions::default();

    relay.before_route = Some(BeforeRequest::new(|_request| true, None));

    relay
}

// a request to destination 7, on its connection
fn relayed() -> Result<Bytes, String> {
    write_envelope(
        &Envelope::Request {
            header: RequestHeader {
                call_id: 1,
                service_id: 2,
                procedure_id: 1,
                destination_id: Some(7),
                opens_subscription: false,
                paced: false,
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(&[1, 2, 3]),
        },
        MAXIMUM_DETAIL_BYTES,
    )
    .map_err(|error| error.to_string())
}

struct Relaying {
    clock: Arc<SteppingClock>,
    pipe: Arc<Pipe>,
    router: RouterServer,
}

fn relaying(relay: RelayOptions) -> Result<Relaying, ProgrammerError> {
    let clock = SteppingClock::new(epoch());
    let pipe = Arc::new(Pipe::default());
    let mut options = RouterServerOptions::default();

    options.clock = Some(shared_of(&clock));
    options.relay = Some(relay);

    RouterServer::new(Arc::<Pipe>::clone(&pipe), &options).map(|router| Relaying {
        clock,
        pipe,
        router,
    })
}

// the timeout leg B is asked with, of a request to destination 7
async fn leg_b_of((relaying, target): (&Relaying, &Target)) -> Played {
    relaying.pipe.open(HANDLE);
    relaying.pipe.message((HANDLE, relayed()?));
    relaying.clock.settle().await;

    let asked = locked(&target.asked).clone();

    match asked.as_slice() {
        [timeout] => Ok(Observed::Held(*timeout)),
        _ => Err(format!("leg B asked {asked:?}")),
    }
}

async fn relay_timeout_by_relay(given: Option<Duration>) -> Played {
    let mut relay = admitting();

    if let Some(given) = given {
        relay.timeout = given;
    }

    let relaying = match relaying(relay) {
        Ok(relaying) => relaying,
        Err(refused) => return Ok(Observed::Refused(refused)),
    };
    let target = Arc::new(Target::default());
    let mut destination = DestinationOptions::default();

    destination.destination_id = Some(7);
    relaying
        .router
        .register_destination((
            RelayTarget::Router(Arc::<Target>::clone(&target)),
            destination,
        ))
        .map_err(|error| error.to_string())?;

    leg_b_of((&relaying, &target)).await
}

async fn relay_timeout_by_register(given: Option<Duration>) -> Played {
    let relaying = relaying(admitting()).map_err(|error| error.to_string())?;
    let target = Arc::new(Target::default());
    let mut destination = DestinationOptions::default();

    destination.destination_id = Some(7);
    destination.timeout = given;

    match relaying.router.register_destination((
        RelayTarget::Router(Arc::<Target>::clone(&target)),
        destination,
    )) {
        Err(refused) => {
            hold(relaying.router.destinations().is_empty(), || {
                "registered, where it is refused".to_owned()
            })?;

            Ok(Observed::Refused(refused))
        }
        Ok(_) => leg_b_of((&relaying, &target)).await,
    }
}

// ── The sessions ─────────────────────────────────────────────────────────────────────────────

struct Serving {
    clock: Arc<SteppingClock>,
    pipe: Arc<Pipe>,
    server: Server,
}

fn serving(options: ServerOptions) -> Result<Serving, ProgrammerError> {
    let clock = SteppingClock::new(epoch());
    let pipe = Arc::new(Pipe::default());
    let mut options = options;

    options.clock = Some(shared_of(&clock));

    Server::new(Arc::<Pipe>::clone(&pipe), &options).map(|server| Serving {
        clock,
        pipe,
        server,
    })
}

fn sorted(mut dues: Vec<Duration>) -> Vec<Duration> {
    dues.sort_unstable();

    dues
}

// the manager's options, as it is built: the timeout a session set with that one left out holds,
// its timer armed for it, and none for never
async fn manager_default_of((is_connection, given): (bool, Option<Duration>)) -> Played {
    let mut sessions = SessionManagerOptions::default();

    if is_connection {
        sessions.connection_inactivity_timeout = given;
    } else {
        sessions.session_inactivity_timeout = given;
    }

    let mut options = ServerOptions::default();

    options.sessions = Some(sessions);

    let serving = match serving(options) {
        Ok(serving) => serving,
        Err(refused) => return Ok(Observed::Refused(refused)),
    };
    let sessions = serving.server.sessions();

    serving.pipe.open(HANDLE);
    serving.clock.settle().await;

    let mut created = sessions.create(Arc::from(HANDLE));

    if is_connection {
        created.connection_inactivity_timeout = None;
    } else {
        created.session_inactivity_timeout = None;
    }

    let stored = sessions
        .set(created)
        .await
        .map_err(|error| error.to_string())?;
    let held = if is_connection {
        stored.connection_inactivity_timeout
    } else {
        stored.session_inactivity_timeout
    }
    .ok_or("a session stored holds both its timeouts")?;

    serving.clock.settle().await;
    hold(
        serving.clock.dues()
            == if held == NEVER {
                Vec::new()
            } else {
                vec![held]
            },
        || format!("armed {:?} for {held:?}", serving.clock.dues()),
    )?;

    Ok(Observed::Held(held))
}

async fn connection_default_by_options(given: Option<Duration>) -> Played {
    manager_default_of((true, given)).await
}

async fn session_default_by_options(given: Option<Duration>) -> Played {
    manager_default_of((false, given)).await
}

// what a way does with a session stored on its connection, both its timers armed
#[derive(Clone, Copy)]
enum SessionWay {
    SetConnection,
    SetSession,
    UpdateConnection,
    UpdateSession,
}

// a session stored, both its timers armed, under a manager given none of its defaults; then the
// timeout the way gives back, its timer armed for it beside the others, in place of the one it
// replaced where it updates one, and none for never
async fn session_timeout_of((way, given): (SessionWay, Option<Duration>)) -> Played {
    let serving = serving(ServerOptions::default()).map_err(|error| error.to_string())?;
    let sessions = serving.server.sessions();

    serving.pipe.open(HANDLE);
    serving.pipe.open(OTHER);
    serving.clock.settle().await;

    let mut created = sessions.create(Arc::from(HANDLE));

    created.connection_inactivity_timeout = Some(OTHER_TIMEOUT);
    created.session_inactivity_timeout = Some(OTHER_TIMEOUT.saturating_mul(2));

    let session = sessions
        .set(created)
        .await
        .map_err(|error| error.to_string())?;

    serving.clock.settle().await;

    let armed = serving.clock.dues();
    let (outcome, replaced) = match way {
        SessionWay::SetConnection | SessionWay::SetSession => {
            let mut other = sessions.create(Arc::from(OTHER));

            if matches!(way, SessionWay::SetConnection) {
                other.connection_inactivity_timeout = given;
            } else {
                other.session_inactivity_timeout = given;
            }

            let stored = match sessions.set(other).await {
                Ok(stored) => Ok(stored),
                Err(CallError::Refused(refused)) => Err(refused),
                Err(error) => return Err(error.to_string()),
            };

            (
                stored.map(|stored| {
                    if matches!(way, SessionWay::SetConnection) {
                        stored.connection_inactivity_timeout
                    } else {
                        stored.session_inactivity_timeout
                    }
                }),
                None,
            )
        }
        SessionWay::UpdateConnection => (
            match sessions.update_connection_inactivity_timeout((Arc::from(HANDLE), given)) {
                Ok(updating) => Ok(updating
                    .await
                    .and_then(|updated| updated.connection_inactivity_timeout)),
                Err(refused) => Err(refused),
            },
            Some(OTHER_TIMEOUT),
        ),
        SessionWay::UpdateSession => (
            match sessions.update_session_inactivity_timeout((Arc::from(HANDLE), given)) {
                Ok(updating) => Ok(updating
                    .await
                    .and_then(|updated| updated.session_inactivity_timeout)),
                Err(refused) => Err(refused),
            },
            Some(OTHER_TIMEOUT.saturating_mul(2)),
        ),
    };

    serving.clock.settle().await;

    let held = match outcome {
        Err(refused) => {
            hold(
                !sessions.has(Arc::from(OTHER)).await
                    && sessions.get(Arc::from(HANDLE)).await.as_ref() == Some(&session)
                    && serving.clock.dues() == armed,
                || "a refusal stored something".to_owned(),
            )?;

            return Ok(Observed::Refused(refused));
        }
        Ok(held) => held.ok_or("a session holds its timeout")?,
    };
    let mut expected = armed;

    if let Some(timeout) = replaced {
        let at = expected
            .iter()
            .position(|due| *due == timeout)
            .ok_or("the timer it replaced")?;

        expected.remove(at);
    }

    if held != NEVER {
        expected.push(held);
    }

    hold(
        sorted(expected.clone()) == sorted(serving.clock.dues()),
        || format!("armed {:?}, not {expected:?}", serving.clock.dues()),
    )?;

    Ok(Observed::Held(held))
}

async fn session_timeout_by_set_connection(given: Option<Duration>) -> Played {
    session_timeout_of((SessionWay::SetConnection, given)).await
}

async fn session_timeout_by_set_session(given: Option<Duration>) -> Played {
    session_timeout_of((SessionWay::SetSession, given)).await
}

async fn session_timeout_by_update_connection(given: Option<Duration>) -> Played {
    session_timeout_of((SessionWay::UpdateConnection, given)).await
}

async fn session_timeout_by_update_session(given: Option<Duration>) -> Played {
    session_timeout_of((SessionWay::UpdateSession, given)).await
}

// the reset's argument, on a session whose other timeout runs: the due of the timer it arms beside
// the other's; never, none armed; refused, the timers as they were
async fn reset_of((is_connection, given): (bool, Option<Duration>)) -> Played {
    let given = given.ok_or("a reset takes its timeout")?;
    let serving = serving(ServerOptions::default()).map_err(|error| error.to_string())?;
    let sessions = serving.server.sessions();

    serving.pipe.open(HANDLE);
    serving.clock.settle().await;

    let mut created = sessions.create(Arc::from(HANDLE));

    if is_connection {
        created.session_inactivity_timeout = Some(OTHER_TIMEOUT);
    } else {
        created.connection_inactivity_timeout = Some(OTHER_TIMEOUT);
    }

    sessions
        .set(created)
        .await
        .map_err(|error| error.to_string())?;
    serving.clock.settle().await;
    hold(serving.clock.dues() == vec![OTHER_TIMEOUT], || {
        format!("armed {:?}", serving.clock.dues())
    })?;

    let reset = if is_connection {
        sessions.reset_connection_inactivity_timeout((Arc::from(HANDLE), given))
    } else {
        sessions.reset_session_inactivity_timeout((Arc::from(HANDLE), given))
    };

    match reset {
        Err(refused) => {
            serving.clock.settle().await;
            hold(serving.clock.dues() == vec![OTHER_TIMEOUT], || {
                "a refusal armed something".to_owned()
            })?;

            Ok(Observed::Refused(refused))
        }
        Ok(resetting) => {
            resetting.await;
            serving.clock.settle().await;

            let mut dues = serving.clock.dues();
            let at = dues
                .iter()
                .position(|due| *due == OTHER_TIMEOUT)
                .ok_or("the other timer still armed")?;

            dues.remove(at);

            Ok(Observed::Held(due_of(&dues)?))
        }
    }
}

async fn connection_reset_by_reset(given: Option<Duration>) -> Played {
    reset_of((true, given)).await
}

async fn session_reset_by_reset(given: Option<Duration>) -> Played {
    reset_of((false, given)).await
}

// ── server.connectionInactivityTimeout ───────────────────────────────────────────────────────

// a silent connection open a millisecond short of what it holds, closed at it; never, open past
// the ceiling
async fn server_inactivity_by_options(given: Option<Duration>) -> Played {
    let mut options = ServerOptions::default();

    options.connection_inactivity_timeout = given;

    let serving = match serving(options) {
        Ok(serving) => serving,
        Err(refused) => return Ok(Observed::Refused(refused)),
    };

    serving.pipe.open(HANDLE);
    serving.clock.settle().await;

    let due = due_of(&serving.clock.dues())?;

    if due == NEVER {
        serving.clock.advance(bead::LONGEST_TIMER).await;
        hold(locked(&serving.pipe.closed).is_empty(), || {
            "closed, without end".to_owned()
        })?;

        return Ok(Observed::Held(NEVER));
    }

    serving.clock.advance(due.saturating_sub(MILLISECOND)).await;
    hold(locked(&serving.pipe.closed).is_empty(), || {
        "closed a millisecond short".to_owned()
    })?;
    serving.clock.advance(MILLISECOND).await;
    hold(
        locked(&serving.pipe.closed).as_slice() == [Arc::<str>::from(HANDLE)],
        || "not closed at its due".to_owned(),
    )?;

    Ok(Observed::Held(due))
}

// ── transportClient.connectTimeout and transportClient.reconnectionDelay ─────────────────────

fn memory_of(clock: &Arc<SteppingClock>) -> Result<(MemoryServer, MemoryClient), String> {
    let mut server_options = MemoryServerOptions::default();

    server_options.clock = Some(shared_of(clock));

    let server = MemoryServer::new(&server_options).map_err(|error| error.to_string())?;
    let mut options = MemoryClientOptions::of(server.clone());

    options.clock = Some(shared_of(clock));

    let client = MemoryClient::new(&options).map_err(|error| error.to_string())?;

    Ok((server, client))
}

fn refused_of(error: TransportError) -> Result<ProgrammerError, String> {
    match error {
        TransportError::Refused(refused) => Ok(refused),
        other @ (TransportError::Cancelled(_)
        | TransportError::TimedOut(_)
        | TransportError::Connect(_)
        | TransportError::ReadyState(_)
        | TransportError::Reconnect(_)
        | _) => Err(format!("ended with {other:?}")),
    }
}

// the connect's options: the due of the timer it arms as it is made; never, none; refused, at once
async fn connect_timeout_by_memory(given: Option<Duration>) -> Played {
    let clock = SteppingClock::new(epoch());
    let (_server, client) = memory_of(&clock)?;
    let mut options = MemoryConnectOptions::default();

    options.timeout = given;

    let connecting = client.connect(options);
    let dues = clock.dues();

    match connecting.await {
        Err(TransportError::Refused(refused)) => {
            hold(dues.is_empty(), || {
                "a refused connect armed a timer".to_owned()
            })?;

            Ok(Observed::Refused(refused))
        }
        // its server never started: the connect fails, its timer armed as it was made
        _ => Ok(Observed::Held(due_of(&dues)?)),
    }
}

// a reconnection whose first attempt fails: the delay its tap hears; refused, its reconnection
// refused with it
async fn reconnection_delay_of(delay: ReconnectDelay) -> Played {
    let clock = SteppingClock::new(epoch());
    let (_server, client) = memory_of(&clock)?;
    let tapped: Arc<Mutex<Vec<Duration>>> = Arc::default();
    let tapping = Arc::clone(&tapped);

    // its server never started: the connect fails, and is kept for the reconnection
    drop(client.connect(MemoryConnectOptions::default()).await);

    let mut options = ReconnectOptions::default();

    options.delay = Some(delay);
    options.maximum_attempts = Some(2);
    options.tap = Some(Arc::new(move |delay: Duration, _attempt: u32| {
        locked(&tapping).push(delay);
    }));

    let reconnecting = client
        .reconnect(options)
        .map_err(|error| error.to_string())?;
    let reconnected = tokio::spawn(reconnecting);

    clock.settle().await;

    let heard = locked(&tapped).clone();

    if let [delay] = heard.as_slice() {
        reconnected.abort();

        return Ok(Observed::Held(*delay));
    }

    hold(heard.is_empty(), || format!("tapped {heard:?}"))?;

    let outcome = reconnected.await.map_err(|error| error.to_string())?;

    match outcome {
        Err(error) => Ok(Observed::Refused(refused_of(error)?)),
        Ok(()) => Err("reconnected with a server never started".to_owned()),
    }
}

async fn reconnection_delay_by_function(given: Option<Duration>) -> Played {
    let given = given.ok_or("a delay's function gives one")?;

    reconnection_delay_of(ReconnectDelay::Computed(Arc::new(
        move |_previous, _attempt| given,
    )))
    .await
}

async fn reconnection_delay_by_number(given: Option<Duration>) -> Played {
    let given = given.ok_or("a delay's number is given")?;

    reconnection_delay_of(ReconnectDelay::Fixed(given)).await
}

// ── The table ────────────────────────────────────────────────────────────────────────────────

async fn play_way((place, way): (&str, &str), given: Option<Duration>) -> Played {
    match (place, way) {
        ("call.timeout", "serviceManager") => call_by_service_manager(given).await,
        ("call.timeout", "router") => call_by_router(given).await,
        ("serviceManager.defaultTimeout", "options") => default_timeout_by_options(given).await,
        ("router.reservation", "reserve") => reservation_by_reserve(given).await,
        ("router.reservation", "cancel") => reservation_by_cancel(given).await,
        ("router.transferInactivityTimeout", "limits") => {
            transfer_inactivity_by_limits(given).await
        }
        ("relay.timeout", "relay") => relay_timeout_by_relay(given).await,
        ("relay.timeout", "register") => relay_timeout_by_register(given).await,
        ("sessionManager.connectionInactivityTimeout", "options") => {
            connection_default_by_options(given).await
        }
        ("sessionManager.sessionInactivityTimeout", "options") => {
            session_default_by_options(given).await
        }
        ("session.inactivityTimeouts", "setConnection") => {
            session_timeout_by_set_connection(given).await
        }
        ("session.inactivityTimeouts", "setSession") => session_timeout_by_set_session(given).await,
        ("session.inactivityTimeouts", "updateConnection") => {
            session_timeout_by_update_connection(given).await
        }
        ("session.inactivityTimeouts", "updateSession") => {
            session_timeout_by_update_session(given).await
        }
        ("sessionManager.resetConnectionInactivityTimeout", "reset") => {
            connection_reset_by_reset(given).await
        }
        ("sessionManager.resetSessionInactivityTimeout", "reset") => {
            session_reset_by_reset(given).await
        }
        ("server.connectionInactivityTimeout", "options") => {
            server_inactivity_by_options(given).await
        }
        ("transportClient.connectTimeout", "memory") => connect_timeout_by_memory(given).await,
        ("transportClient.reconnectionDelay", "function") => {
            reconnection_delay_by_function(given).await
        }
        ("transportClient.reconnectionDelay", "number") => {
            reconnection_delay_by_number(given).await
        }
        _ => Err(format!("{place} has no way {way} here")),
    }
}

fn reason_of(reason: &str) -> Option<DurationRefusal> {
    [
        DurationRefusal::UnderTheFloor,
        DurationRefusal::PastTheCeiling,
        DurationRefusal::ZeroRefused,
        DurationRefusal::NeverRefused,
        DurationRefusal::NotANumber,
    ]
    .into_iter()
    .find(|refusal| refusal.as_str() == reason)
}

// what the file says a place holds of an input: at once as zero, never as Duration::MAX
fn held_of(outcome: &PlaceOutcome) -> Option<Duration> {
    match outcome.outcome.as_str() {
        "at once" => Some(Duration::ZERO),
        "never" => Some(NEVER),
        _ => outcome.held,
    }
}

fn check(
    (way, input, outcome): (&str, &DurationInput, &PlaceOutcome),
    observed: &Observed,
) -> Result<(), String> {
    let at = format!("{way}, {}", input.name);

    if outcome.outcome == "refused" {
        let reason = outcome
            .reason
            .as_deref()
            .and_then(reason_of)
            .ok_or("a refusal's reason")?;

        return match observed {
            Observed::Refused(refused) if refused.reason() == Some(Refusal::Duration(reason)) => {
                Ok(())
            }
            other @ (Observed::Refused(_) | Observed::Held(_)) => {
                Err(format!("{at}: {other:?}, not refused for {reason}"))
            }
        };
    }

    match observed {
        Observed::Held(held) if Some(*held) == held_of(outcome) => Ok(()),
        other @ (Observed::Held(_) | Observed::Refused(_)) => {
            Err(format!("{at}: {other:?}, not {:?}", held_of(outcome)))
        }
    }
}

async fn plays(durations: &Durations, place: &DurationPlace) -> Result<(), String> {
    let ways = ways_of(&place.id);

    for way in place
        .ways
        .iter()
        .filter(|way| !way.is_excused && !ahead_of(&place.id).contains(&way.id.as_str()))
    {
        hold(ways.contains(&way.id.as_str()), || {
            format!("no way {} here", way.id)
        })?;

        for (input, outcome) in durations.played(place) {
            let observed = play_way((&place.id, &way.id), input.given).await?;

            check((&way.id, &input, &outcome), &observed)?;
        }

        // a default a clause states, read by each way built with nothing given
        if let Some(stated) = &place.default
            && stated.ways.contains(&way.id)
        {
            match play_way((&place.id, &way.id), None).await? {
                Observed::Held(held) if held == stated.held => {}
                other @ (Observed::Held(_) | Observed::Refused(_)) => {
                    return Err(format!(
                        "{}, nothing given: {other:?}, not {:?}",
                        way.id, stated.held
                    ));
                }
            }
        }
    }

    Ok(())
}

fn runtime() -> Result<tokio::runtime::Runtime, Failed> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string().into())
}

fn trials() -> Result<Vec<Trial>, String> {
    let durations = Arc::new(Durations::read()?);
    let mut trials = Vec::new();
    let table = Arc::clone(&durations);

    // this side lacks the ways a row excuses it from, and the places ahead, and has every other
    trials.push(Trial::test(
        "its table plays every place of the file not ahead, each by every way the file gives it and no other",
        move || {
            let mut played: BTreeMap<&str, Vec<&str>> = BTreeMap::new();

            for id in PLACES {
                let place = table.place_of(id).ok_or_else(|| format!("no place {id}"))?;
                let mut ways: Vec<&str> = place
                    .ways
                    .iter()
                    .filter(|way| !way.is_excused && !ahead_of(id).contains(&way.id.as_str()))
                    .map(|way| way.id.as_str())
                    .collect();
                let mut own = ways_of(id).to_vec();

                ways.sort_unstable();
                own.sort_unstable();

                if ways != own {
                    return Err(format!("{id}: the file's ways {ways:?}, the table's {own:?}").into());
                }

                played.insert(id, ways);
            }

            if played.len() == PLACES.len() {
                Ok(())
            } else {
                Err("a place twice".into())
            }
        },
    ));

    for id in PLACES {
        let durations = Arc::clone(&durations);

        trials.push(Trial::test(id, move || {
            let place = durations
                .place_of(id)
                .ok_or_else(|| format!("no place {id}"))?
                .clone();

            runtime()?
                .block_on(plays(&durations, &place))
                .map_err(Failed::from)
        }));
    }

    Ok(trials)
}

fn main() -> ExitCode {
    let arguments = Arguments::from_args();
    let trials = trials().unwrap_or_else(|error| {
        vec![Trial::test(
            "reads its durations",
            move || Err(error.into()),
        )]
    });

    libtest_mimic::run(&arguments, trials).exit_code()
}
