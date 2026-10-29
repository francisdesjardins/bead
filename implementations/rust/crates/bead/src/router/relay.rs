//! The relay of a server's router (spec 14): the requests that name a destination registered in it go
//! on to that destination's target, and their answers come back, as the router's own.
//!
//! The relay terminates each leg — leg A, from the requester, and leg B, to the target, each with its
//! own call id, limits and session — and passes on the payload's bytes, undecoded, and the answer: a
//! failure of the target's counted one relay more; one of its own with none.

use core::fmt;
use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use core::time::Duration;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use bytes::Bytes;

use crate::constants::{CredentialScheme, FailureScope, ProtocolCode, RouterSide};
use crate::duration::{NEVER, hold};
use crate::envelope::{Credential, Header, RequestHeader, header_bytes_of};
use crate::errors::{CallError, ProgrammerError, ResolverError};
use crate::failure::{Failure, FailureOrigin, ProcedureAddress};
use crate::identity::Procedure;
use crate::jwt_verifier::{audiences_of, read_jwt};
use crate::owner::WeakOwner;
use crate::router::admissions::BeforeRequest;
use crate::router::core::{AdmissionRefusal, AdmissionRequest, AdmitFn, Handler, ResolverProps};
use crate::router::server::{Call, CallHooks, ServerRequest, ServerState, request_on};
use crate::router::types::{
    BoxFuture, ConnectionHandle, Gauges, RequestCredential, ResolvedRequestOptions, RouterAnswer,
    RouterError, RouterLimits,
};
use crate::transport::ServerTransport;

/// How a server's router relays the requests that name a destination.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct RelayOptions {
    /// Whether a request may be relayed, asked on its header and the call's session, before its
    /// destination is looked up. Without it, the relay admits nobody.
    pub before_route: Option<BeforeRequest>,
    /// How long leg B waits for its answer at most, whatever a destination says; [`NEVER`] by
    /// default.
    pub timeout: Duration,
    /// Whether it verifies what it forwards besides (spec 14.3, step 1), with its router's
    /// credentials, before `before_route`.
    pub verifies: bool,
}

impl Default for RelayOptions {
    fn default() -> Self {
        Self {
            before_route: None,
            timeout: NEVER,
            verifies: false,
        }
    }
}

/// A destination's registration, as it is asked.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct DestinationOptions {
    /// The audience it verifies (RFC 8707): a `JWT` goes to it only when its `aud` names it, and an
    /// `ELSEWHERE` only when it has one.
    pub audience: Option<String>,
    /// The destination, from 1 to 2³² − 1; drawn, one not in use, when not given.
    pub destination_id: Option<u32>,
    /// What the application calls it.
    pub label: Option<String>,
    /// The registration this one replaces, the one its destination holds now.
    pub replaces: Option<DestinationRegistration>,
    /// How long leg B waits for its answer, the relay's at most; the relay's if not given.
    pub timeout: Option<Duration>,
}

/// A leg B a relay asks of a router it calls through.
#[non_exhaustive]
pub struct RelayLeg {
    /// The procedure it calls, as leg A named it.
    pub procedure: Procedure,
    /// Its options: its credential, its timeout, leg A's signal.
    pub options: ResolvedRequestOptions,
    /// Hears whether its transport took it.
    pub on_sent: Box<dyn FnMut(bool) + Send>,
}

impl fmt::Debug for RelayLeg {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RelayLeg")
            .field("procedure", &self.procedure)
            .finish_non_exhaustive()
    }
}

/// A router a relay calls through: a client's, to a server behind the relay.
pub trait RelayRouter: Send + Sync + fmt::Debug {
    /// Its limits.
    fn limits(&self) -> RouterLimits;

    /// Makes leg B's call, sent as it is made.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] the call refuses as it is made.
    fn request(&self, payload: Bytes, leg: RelayLeg) -> Result<Call, ProgrammerError>;

    /// Whether its transport carries `credential` beside an envelope.
    fn carries(&self, _credential: &str) -> bool {
        false
    }

    /// Whether its transport stays off the machine's clear.
    fn is_secure(&self) -> bool {
        false
    }
}

/// What a destination names: a connection of the relay's own router, or a router it calls through.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum RelayTarget {
    /// A connection of the relay's own router, which the relay asks as a server asks a client.
    Connection(ConnectionHandle),
    /// A router the relay calls through.
    Router(Arc<dyn RelayRouter>),
}

/// A destination, as its registration names it, and whether its connection closed.
#[derive(Debug, Clone, PartialEq, Eq)]
#[expect(
    clippy::struct_field_names,
    reason = "a destination's id, as every side names it"
)]
pub struct Destination {
    /// Its id.
    pub destination_id: u32,
    /// Whether the connection it names closed, or had as it was registered.
    pub is_closed: bool,
    /// What the application calls it.
    pub label: Option<String>,
}

/// A destination registered: what names it, whether its connection closed, and what takes it out.
#[derive(Clone)]
pub struct DestinationRegistration {
    destination_id: u32,
    label: Option<String>,
    serial: u64,
    closed: Arc<AtomicBool>,
    relay: Weak<Mutex<Inner>>,
}

impl fmt::Debug for DestinationRegistration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DestinationRegistration")
            .field("destination_id", &self.destination_id)
            .field("label", &self.label)
            .finish_non_exhaustive()
    }
}

impl DestinationRegistration {
    /// Its destination.
    #[must_use]
    pub const fn destination_id(&self) -> u32 {
        self.destination_id
    }

    /// What the application calls it.
    #[must_use]
    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }

    /// Whether the connection it names closed, as it is now.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Takes the destination out, unless another took its id since; whether it did.
    #[must_use = "whether it took the destination out"]
    pub fn unregister(&self) -> bool {
        let Some(relay) = self.relay.upgrade() else {
            return false;
        };
        let mut inner = locked(&relay);
        let is_own = inner
            .registrations
            .iter()
            .any(|held| held.destination_id == self.destination_id && held.serial == self.serial);

        if is_own {
            inner
                .registrations
                .retain(|held| held.destination_id != self.destination_id);
        }

        is_own
    }
}

#[derive(Debug, Clone)]
struct Registration {
    audience: Option<String>,
    destination_id: u32,
    serial: u64,
    closed: Arc<AtomicBool>,
    label: Option<String>,
    target: RelayTarget,
    timeout: Duration,
}

impl Registration {
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
}

#[derive(Debug)]
struct Inner {
    // in the order they were registered, a destination replaced keeping its place
    registrations: Vec<Registration>,
    open: BTreeSet<ConnectionHandle>,
}

fn locked(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a server's router relays by: its destinations, shared by its handle and its owner.
#[derive(Debug, Clone)]
pub(crate) struct Relay {
    inner: Arc<Mutex<Inner>>,
    before_route: Option<BeforeRequest>,
    timeout: Duration,
    verifies: bool,
    side: RouterSide,
    limits: RouterLimits,
    serials: Arc<AtomicU64>,
}

impl Relay {
    /// A relay of a router of `side` with `limits`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a refusal that is not an admission's, or a timeout spec 1.4 does
    /// not hold.
    pub(crate) fn new(
        (side, limits): (RouterSide, RouterLimits),
        options: RelayOptions,
    ) -> Result<Self, ProgrammerError> {
        if let Some(refusal) = options
            .before_route
            .as_ref()
            .and_then(BeforeRequest::refusal)
            && !is_admission_failure(refusal, side)
        {
            return Err(ProgrammerError::new(format!(
                "a relay refuses with a failure that is not an admission's of the {}'s table",
                side.as_str()
            )));
        }

        let timeout = hold("a relay's timeout", options.timeout)?;

        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                registrations: Vec::new(),
                open: BTreeSet::new(),
            })),
            before_route: options.before_route,
            timeout,
            verifies: options.verifies,
            side,
            limits,
            serials: Arc::new(AtomicU64::new(1)),
        })
    }
}

// whether `failure` refuses admission: SESSION_REQUIRED or ACCESS_DENIED, of its own side
fn is_admission_failure(failure: &Failure, side: RouterSide) -> bool {
    failure.scope() == FailureScope::Protocol
        && failure.is_protocol_code(&[ProtocolCode::SESSION_REQUIRED, ProtocolCode::ACCESS_DENIED])
        && failure.side() == Some(side)
}

/// The audiences its destinations were registered with, each once.
pub(crate) fn audiences(relay: &Relay) -> Vec<String> {
    let given: Vec<String> = locked(&relay.inner)
        .registrations
        .iter()
        .filter_map(|held| held.audience.clone())
        .collect();
    let mut audiences: Vec<String> = Vec::new();

    for audience in given {
        if !audiences.contains(&audience) {
            audiences.push(audience);
        }
    }

    audiences
}

/// A connection of the relay's own router, open.
pub(crate) fn opened(relay: &Relay, connection_handle: &ConnectionHandle) {
    locked(&relay.inner)
        .open
        .insert(Arc::clone(connection_handle));
}

/// Marks the destinations on a connection that closed: each is unreachable until registered anew.
pub(crate) fn close_connection(relay: &Relay, connection_handle: &ConnectionHandle) {
    let mut inner = locked(&relay.inner);

    inner.open.remove(connection_handle);

    for registration in &inner.registrations {
        if matches!(&registration.target, RelayTarget::Connection(held) if held == connection_handle)
        {
            registration.closed.store(true, Ordering::Release);
        }
    }
}

/// The destinations registered.
pub(crate) fn destinations(relay: &Relay) -> Vec<Destination> {
    locked(&relay.inner)
        .registrations
        .iter()
        .map(|held| Destination {
            destination_id: held.destination_id,
            is_closed: held.is_closed(),
            label: held.label.clone(),
        })
        .collect()
}

/// Its destinations, counted, those whose connection closed among them.
pub(crate) fn gauges(relay: &Relay) -> Gauges {
    let inner = locked(&relay.inner);
    let closed = inner
        .registrations
        .iter()
        .filter(|held| held.is_closed())
        .count();
    let mut gauges = Gauges::default();

    gauges.counts.insert(
        "closedDestinations",
        u64::try_from(closed).unwrap_or(u64::MAX),
    );
    gauges.counts.insert(
        "destinations",
        u64::try_from(inner.registrations.len()).unwrap_or(u64::MAX),
    );

    gauges
}

fn draw_destination_id(is_in_use: &dyn Fn(u32) -> bool) -> u32 {
    loop {
        let mut bytes = [0_u8; 4];

        if getrandom::fill(&mut bytes).is_err() {
            continue;
        }

        let destination_id = u32::from_be_bytes(bytes);

        if destination_id != 0 && !is_in_use(destination_id) {
            return destination_id;
        }
    }
}

/// Registers a destination.
///
/// # Errors
///
/// A [`ProgrammerError`] for an id in use, a registration replaced that its destination does not
/// hold, or a timeout spec 1.4 does not hold.
pub(crate) fn register(
    relay: &Relay,
    (target, options): (RelayTarget, DestinationOptions),
) -> Result<DestinationRegistration, ProgrammerError> {
    let DestinationOptions {
        audience,
        destination_id,
        label,
        replaces,
        timeout,
    } = options;
    let given =
        destination_id.or_else(|| replaces.as_ref().map(|replaced| replaced.destination_id));
    let timeout = hold("a relay's timeout", timeout.unwrap_or(NEVER))?;

    if given == Some(0) {
        return Err(ProgrammerError::new(
            "a destination is an integer from 1 to 4294967295, not 0",
        ));
    }

    let mut inner = locked(&relay.inner);

    if let Some(replaced) = &replaces {
        if Some(replaced.destination_id) != given {
            return Err(ProgrammerError::new(format!(
                "a registration replaces the one of its own destination, {}, not {}",
                given.unwrap_or_default(),
                replaced.destination_id
            )));
        }

        // ! the registration replaced is the one that holds its id now: a caller holding one taken
        // out, or replaced already, would take a destination it does not hold
        let holds = inner.registrations.iter().any(|held| {
            held.destination_id == replaced.destination_id && held.serial == replaced.serial
        });

        if !holds {
            return Err(ProgrammerError::new(format!(
                "destination {} is not registered by the registration it replaces",
                replaced.destination_id
            )));
        }
    } else if let Some(given) = given
        && inner
            .registrations
            .iter()
            .any(|held| held.destination_id == given)
    {
        return Err(ProgrammerError::new(format!(
            "destination {given} is registered already"
        )));
    }

    let destination_id = given.unwrap_or_else(|| {
        draw_destination_id(&|candidate| {
            inner
                .registrations
                .iter()
                .any(|held| held.destination_id == candidate)
        })
    });
    // a connection its router no longer holds closed before it was registered: it is unreachable
    // from now on (spec 14.4)
    let is_closed =
        matches!(&target, RelayTarget::Connection(handle) if !inner.open.contains(handle));
    let registration = Registration {
        audience,
        destination_id,
        serial: relay.serials.fetch_add(1, Ordering::Relaxed),
        closed: Arc::new(AtomicBool::new(is_closed)),
        label: label.clone(),
        target,
        // the relay's timeout is the longest any leg B waits
        timeout: timeout.min(relay.timeout),
    };
    let handed = DestinationRegistration {
        destination_id,
        label,
        serial: registration.serial,
        closed: Arc::clone(&registration.closed),
        relay: Arc::downgrade(&relay.inner),
    };

    // * one replaced gives its place at once: a request in between finds the destination, never
    // DESTINATION_UNKNOWN, and a call bound to the one replaced finishes with it
    match inner
        .registrations
        .iter_mut()
        .find(|held| held.destination_id == destination_id)
    {
        Some(held) => *held = registration,
        None => inner.registrations.push(registration),
    }

    drop(inner);

    Ok(handed)
}

// ── Leg B ────────────────────────────────────────────────────────────────────────────────────

// what leg B presents of what leg A does (spec 14.2): a JWT, its same bytes; an ELSEWHERE, its
// scheme; none for none or OPAQUE, which run in leg B's session
fn forwarded_of(credential: Option<&Credential>) -> Option<Credential> {
    credential
        .filter(|credential| {
            matches!(
                credential.scheme(),
                CredentialScheme::JWT | CredentialScheme::ELSEWHERE
            )
        })
        .cloned()
}

// a request's header on leg B, counted with its credential (spec 14.3, step 6)
fn leg_header_bytes_of(credential: Option<&Credential>) -> u64 {
    let header = Header::Request(RequestHeader {
        call_id: 1,
        service_id: 1,
        procedure_id: 1,
        destination_id: None,
        opens_subscription: false,
        paced: false,
        total: None,
        credential: forwarded_of(credential),
    });

    header_bytes_of(&header).map_or(u64::MAX, |bytes| u64::try_from(bytes).unwrap_or(u64::MAX))
}

// what binds a request to its destination, in the owner's turn
struct Route {
    relay: Relay,
    owner: WeakOwner<ServerState>,
    registration: Registration,
    // what leg B's transport carries, asked as the request came
    carriage: Carriage,
}

// what leg B's transport carries beside a request: a connection's, as the relay's transport says
// as the request came; a router's, as the transport it calls through says
#[derive(Debug, Clone)]
enum Carriage {
    Connection {
        carries_credential: bool,
        is_secure: bool,
        is_two_way: bool,
    },
    Router(Arc<dyn RelayRouter>),
}

impl Carriage {
    fn carries(&self, credential: &str) -> bool {
        match self {
            Self::Connection {
                carries_credential, ..
            } => *carries_credential,
            Self::Router(router) => router.carries(credential),
        }
    }

    fn is_secure(&self) -> bool {
        match self {
            Self::Connection { is_secure, .. } => *is_secure,
            Self::Router(router) => router.is_secure(),
        }
    }

    const fn is_two_way(&self) -> bool {
        match self {
            Self::Connection { is_two_way, .. } => *is_two_way,
            Self::Router(_) => true,
        }
    }
}

fn carriage_of(state: &ServerState, target: &RelayTarget) -> Carriage {
    match target {
        // a transport gone, or one that panics as it is asked, carries nothing
        RelayTarget::Connection(handle) => Carriage::Connection {
            carries_credential: state.asked((handle, |transport: &dyn ServerTransport| {
                transport.carries_credential(handle)
            })),
            is_secure: state.asked((handle, |transport: &dyn ServerTransport| {
                transport.is_secure(handle)
            })),
            is_two_way: state.asked((handle, |transport: &dyn ServerTransport| {
                transport.is_two_way(handle)
            })),
        },
        RelayTarget::Router(router) => Carriage::Router(Arc::clone(router)),
    }
}

impl Route {
    // the largest payload a target takes: its router's limit, or what one envelope holds behind
    // leg B's header when it takes no transfer; the relay's own where that one is smaller
    fn payload_limit_of(&self, credential: Option<&Credential>) -> u64 {
        let limits = match &self.registration.target {
            RelayTarget::Connection(_) => self.relay.limits,
            RelayTarget::Router(router) => router.limits(),
        };
        let limit = if limits.maximum_transfers == 0 {
            limits.maximum_payload_bytes.min(
                limits
                    .chunk_bytes
                    .min(limits.maximum_envelope_bytes)
                    .saturating_sub(leg_header_bytes_of(credential)),
            )
        } else {
            limits.maximum_payload_bytes
        };

        limit.min(self.relay.limits.maximum_payload_bytes)
    }

    fn unreachable_of(&self, why: &str) -> Failure {
        Failure::protocol(ProtocolCode::DESTINATION_UNREACHABLE, self.relay.side).saying(format!(
            "destination {} is unreachable: {why}",
            self.registration.destination_id
        ))
    }

    fn too_large_of(&self, (length, credential): (u64, Option<&Credential>)) -> Option<Failure> {
        let limit = self.payload_limit_of(credential);

        (length > limit).then(|| {
            Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, self.relay.side)
                .saying(format!("a payload is {limit} bytes at most, not {length}"))
        })
    }

    // a call leg B cannot carry, as section 14.3's step 5 lists them: ! an ELSEWHERE goes only
    // where leg B carries the very bytes leg A's transport carried
    fn uncarried_of(&self, request: &AdmissionRequest) -> Option<Failure> {
        let credential = request.header.credential.as_ref();
        let transport_credential = request
            .carried
            .as_ref()
            .and_then(|carried| carried.transport_credential.as_deref());
        let audience = self.registration.audience.as_deref();

        match credential {
            Some(Credential::Jwt(token)) => {
                // read as a token's aud is read, verified or not: a token that does not read names none
                let claims = read_jwt(token).map(|(_, claims)| claims);
                let audiences = audiences_of(claims.as_ref().and_then(|claims| claims.get("aud")));

                if audience.is_none_or(|audience| !audiences.iter().any(|named| named == audience))
                {
                    return Some(self.unreachable_of(
                        "it verifies another audience than the one the token names, or none",
                    ));
                }
            }
            Some(Credential::Elsewhere) => {
                if audience.is_none() {
                    return Some(self.unreachable_of("it was registered with no audience"));
                }

                if transport_credential.is_none_or(|carried| !self.carriage.carries(carried)) {
                    return Some(self.unreachable_of(
                        "its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another",
                    ));
                }
            }
            _ => return None,
        }

        (!self.carriage.is_secure()).then(|| {
            self.unreachable_of(
                "its transport leaves the machine in the clear, which a bearer credential never crosses",
            )
        })
    }

    // what refuses an admitted request to this destination: nothing, for one that goes on
    fn refusal_of_route(&self, request: &AdmissionRequest) -> Option<Failure> {
        let header = &request.header;

        if header.opens_subscription {
            return Some(
                Failure::protocol(ProtocolCode::SUBSCRIPTION_UNSUPPORTED, self.relay.side)
                    .saying("this relay carries no subscription"),
            );
        }

        if self.registration.is_closed() {
            return Some(self.unreachable_of("its connection closed"));
        }

        if !self.carriage.is_two_way() {
            return Some(self.unreachable_of("its connection carries no request"));
        }

        // a transfer's total is held before any credit; a payload that came whole, as it comes
        self.uncarried_of(request).or_else(|| {
            header
                .total
                .and_then(|total| self.too_large_of((total, header.credential.as_ref())))
        })
    }
}

// what leg B presents: a JWT, as leg A does; an ELSEWHERE, with what leg A's transport carried;
// none, said so, for none or OPAQUE
fn leg_credential_of(props: &ResolverProps) -> RequestCredential {
    match &props.header.credential {
        Some(Credential::Jwt(token)) => {
            RequestCredential::Jwt(String::from_utf8_lossy(token).into_owned())
        }
        Some(Credential::Elsewhere) => props
            .carried
            .as_ref()
            .and_then(|carried| carried.transport_credential.clone())
            .map_or(RequestCredential::None, RequestCredential::Elsewhere),
        _ => RequestCredential::None,
    }
}

// what leg A answers when leg B fails: the target's failure, one relay more; before the relay's
// transport had the request, a limit of leg B's as the relay's own, or unreachable; lost after
fn failure_of(
    route: &Route,
    ((reason, is_sent), report): ((CallError, bool), &dyn Fn(RouterError)),
) -> Failure {
    let side = route.relay.side;
    let destination_id = route.registration.destination_id;

    if let CallError::Failure(failure) = &reason {
        if failure.origin() != FailureOrigin::Local {
            let mut record = failure.record();

            record.relays = record.relays.saturating_add(1);

            return Failure::received(&record, side);
        }

        if !is_sent && failure.scope() == FailureScope::Protocol {
            if failure.is_protocol_code(&[ProtocolCode::PAYLOAD_TOO_LARGE]) {
                return Failure::protocol(ProtocolCode::PAYLOAD_TOO_LARGE, side)
                    .saying(failure.detail().to_owned());
            }

            if failure.is_protocol_code(&[ProtocolCode::CAPACITY_EXCEEDED]) {
                return Failure::protocol(ProtocolCode::CAPACITY_EXCEEDED, side).saying(format!(
                    "destination {destination_id} takes no more calls at once"
                ));
            }
        }
    }

    report(crate::router::core::reported_call(reason));

    if is_sent {
        Failure::protocol(ProtocolCode::DESTINATION_LOST, side).saying(format!(
            "destination {destination_id} was lost once handed the request: the procedure may have run"
        ))
    } else {
        route.unreachable_of("nothing was tried")
    }
}

// leg B: the same service and procedure, the payload's bytes, leg A's signal; its answer, or none
// once leg A ended
async fn answer_of(route: &Route, props: &ResolverProps) -> Option<RouterAnswer> {
    let header = &props.header;
    let destination_id = route.registration.destination_id;
    let procedure = Procedure {
        service_id: header.service_id,
        id: header.procedure_id,
        service_revision: 0,
        name: format!(
            "{}/{} to {destination_id}",
            header.service_id, header.procedure_id
        ),
        kind: None,
        maximum_payload_bytes: Some(route.payload_limit_of(header.credential.as_ref())),
        deprecation: None,
    };
    let is_sent = Arc::new(AtomicBool::new(false));
    let on_sent: Box<dyn FnMut(bool) + Send> = {
        let is_sent = Arc::clone(&is_sent);

        Box::new(move |is_handed: bool| is_sent.store(is_handed, Ordering::Release))
    };
    let options = ResolvedRequestOptions {
        timeout: route.registration.timeout,
        destination_id: None,
        connection_handle: None,
        credential: Some(leg_credential_of(props)),
        signal: Some(props.signal.token().clone()),
        close_on_timeout: false,
    };
    let made = match &route.registration.target {
        RelayTarget::Connection(handle) => request_on(
            &route.owner,
            (
                props.payload.clone(),
                ServerRequest {
                    procedure: ProcedureAddress {
                        service_id: procedure.service_id,
                        procedure_id: procedure.id,
                    },
                    maximum_payload_bytes: procedure.maximum_payload_bytes,
                    options: ResolvedRequestOptions {
                        connection_handle: Some(Arc::clone(handle)),
                        ..options
                    },
                    series: None,
                    refusal: None,
                },
                CallHooks {
                    on_call_id: None,
                    on_sent: Some(on_sent),
                },
            ),
        ),
        RelayTarget::Router(router) => router.request(
            props.payload.clone(),
            RelayLeg {
                procedure,
                options,
                on_sent,
            },
        ),
    };
    let outcome = match made {
        Ok(call) => call.await,
        Err(refused) => Err(CallError::Refused(refused)),
    };

    match outcome {
        Ok(result) => Some(RouterAnswer::Result(result.payload)),
        // leg A ended — cancelled, or gone with its connection: its answer would go nowhere
        Err(_) if props.signal.is_aborted() => None,
        Err(reason) => {
            let owner = route.owner.clone();
            let handle = Arc::clone(&props.connection_handle);
            let report = move |error: RouterError| {
                let handle = Arc::clone(&handle);
                owner.offer(Box::new(move |state: &mut ServerState| {
                    state.listeners.report(&error, Some(&handle));
                }));
            };

            Some(RouterAnswer::Failure(
                failure_of(route, ((reason, is_sent.load(Ordering::Acquire)), &report)).record(),
            ))
        }
    }
}

// leg B, then leg A's answer; a connection that closed while the payload came takes nothing, and a
// payload that came whole past what leg B takes goes nowhere
async fn forward(route: Route, props: ResolverProps) -> Result<(), ResolverError> {
    let length = u64::try_from(props.payload.len()).unwrap_or(u64::MAX);
    let too_large = route.too_large_of((length, props.header.credential.as_ref()));
    let answer = if route.registration.is_closed() {
        Some(RouterAnswer::Failure(
            route.unreachable_of("its connection closed").record(),
        ))
    } else if let Some(too_large) = too_large {
        Some(RouterAnswer::Failure(too_large.record()))
    } else {
        answer_of(&route, &props).await
    };
    let Some(answer) = answer else {
        return Ok(());
    };

    if let Err(error) = props.answerer.respond(answer).await {
        // ! an answer leg A cannot carry is answered PROCEDURE_FAILED, no detail, whatever refused
        // it; why is reported (spec 9.0, 14.5)
        let failed = Failure::protocol(ProtocolCode::PROCEDURE_FAILED, route.relay.side).record();
        let again = props.answerer.respond(RouterAnswer::Failure(failed)).await;

        drop(again);

        return Err(ResolverError::other(error));
    }

    Ok(())
}

// the relay's admission: its before_route's, or, without one, nobody's
fn admission_of(relay: &Relay) -> AdmitFn {
    let side = relay.side;

    relay.before_route.as_ref().map_or_else(
        || -> AdmitFn {
            Arc::new(move |_request: &AdmissionRequest| {
                Ok(Some(AdmissionRefusal {
                    failure: Failure::protocol(ProtocolCode::ACCESS_DENIED, side)
                        .saying("this relay admits nobody: it has no beforeRoute"),
                    by: Some("no-before-route".to_owned()),
                }))
            })
        },
        |before_route| before_route.admission(side),
    )
}

/// The handler of a request to `destination_id`, bound to the destination as it is now; none while
/// none is registered at all: this router relays nothing.
pub(crate) fn handler_of(state: &ServerState, destination_id: u32) -> Option<Arc<Handler>> {
    let relay = state.relay.clone();
    let registration = {
        let inner = locked(&relay.inner);

        if inner.registrations.is_empty() {
            return None;
        }

        inner
            .registrations
            .iter()
            .find(|held| held.destination_id == destination_id)
            .cloned()
    };
    let admission = admission_of(&relay);
    let side = relay.side;

    let Some(registration) = registration else {
        // a destination none registered: admitted, it is unknown
        let admit: AdmitFn = Arc::new(move |request: &AdmissionRequest| {
            Ok(Some(admission(request)?.unwrap_or_else(|| {
                AdmissionRefusal {
                    failure: Failure::protocol(ProtocolCode::DESTINATION_UNKNOWN, side)
                        .saying(format!("no destination {destination_id} behind this relay")),
                    by: None,
                }
            })))
        });

        return Some(Arc::new(Handler {
            resolve: Arc::new(
                |_props: ResolverProps| -> BoxFuture<Result<(), ResolverError>> {
                    Box::pin(async { Ok(()) })
                },
            ),
            admit: Some(admit),
            maximum_payload_bytes: None,
            forwards_credentials: !relay.verifies,
            notifies: false,
        }));
    };
    let carriage = carriage_of(state, &registration.target);
    let route = Arc::new(Route {
        relay: relay.clone(),
        owner: state.core.owner.clone(),
        registration,
        carriage,
    });
    let admit: AdmitFn = {
        let route = Arc::clone(&route);

        Arc::new(move |request: &AdmissionRequest| {
            if let Some(refused) = admission(request)? {
                return Ok(Some(refused));
            }

            Ok(route
                .refusal_of_route(request)
                .map(|failure| AdmissionRefusal { failure, by: None }))
        })
    };
    let maximum_payload_bytes = route.payload_limit_of(None);

    Some(Arc::new(Handler {
        resolve: Arc::new(
            move |props: ResolverProps| -> BoxFuture<Result<(), ResolverError>> {
                let route = Route {
                    relay: route.relay.clone(),
                    owner: route.owner.clone(),
                    registration: route.registration.clone(),
                    carriage: route.carriage.clone(),
                };

                Box::pin(forward(route, props))
            },
        ),
        admit: Some(admit),
        maximum_payload_bytes: Some(maximum_payload_bytes),
        forwards_credentials: !relay.verifies,
        notifies: false,
    }))
}
