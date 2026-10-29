//! What a side resolves a request's `JWT` and `ELSEWHERE` with (spec 9.2, step 6; 13.8 to 13.11):
//! a `JWT`'s keys, its audience and the key set it asks for an issuer's keys; an `ELSEWHERE`'s
//! verifier. It verifies on the clock its side runs on.

use core::fmt;
use core::time::Duration;
use std::collections::BTreeMap;
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::SystemTime;

use bytes::Bytes;
use serde_json::{Map, Value};
use tokio::runtime::Handle;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::clock::{Schedule, SharedClock, Timer};
use crate::constants::CredentialScheme;
use crate::envelope::Credential;
use crate::errors::{CapacityError, ProgrammerError};
use crate::jwt_verifier::{
    JwtAgainst, JwtAlgorithm, JwtKey, JwtRefusal, JwtSessionIdentifier, JwtVerdict, assert_jwt_key,
    read_jwt, verify_jwt,
};
use crate::router::core::{Resolved, Unresolved};
use crate::router::types::{BoxFuture, CallSession, RouterLimits, SessionIdentifier};

#[cfg(test)]
mod tests;

/// The least chunk and envelope, in bytes, of a side that takes or presents a `JWT` (spec 12.2).
pub const JWT_LIMIT_BYTES: u64 = 1_024;

// how long one ask of a key set keeps another from going for its issuer, its deadline
const KEY_SET_INTERVAL: Duration = Duration::from_secs(60);

// how long the keys a key set answered serve, from its answer
const KEY_SET_HOLD: Duration = Duration::from_secs(600);

// the most calls that wait for one issuer's deadline at once: when its key set does not say, and ever
const KEY_SET_WAITING_CALLS: u64 = 64;
const MOST_WAITING_CALLS: u64 = 2_147_483_647;

/// A key a key set answers for the issuer it was asked for: a JWK, and its one algorithm.
#[derive(Clone, PartialEq, Eq)]
pub struct JwtSetKey {
    /// Its one algorithm.
    pub algorithm: JwtAlgorithm,
    /// Its JWK.
    pub jwk: Map<String, Value>,
}

impl fmt::Debug for JwtSetKey {
    // ! its algorithm alone: an HS256 key's secret is written in no string
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JwtSetKey")
            .field("algorithm", &self.algorithm)
            .finish_non_exhaustive()
    }
}

/// What a key set's ask settles with: its keys, or its error.
pub type KeySetAnswer = Result<Vec<JwtSetKey>, Box<dyn Error + Send + Sync>>;

/// A key set's ask: given an issuer it names and a signal its deadline cancels, that issuer's keys.
pub type KeySetAsk =
    Arc<dyn Fn(String, CancellationToken) -> BoxFuture<KeySetAnswer> + Send + Sync>;

/// A key set (RFC 7517 §5), the application's to fetch, given with the issuers it answers for.
#[derive(Clone)]
pub struct JwtKeySet {
    /// Asked for one of its issuers, with a signal, that issuer's keys, which it may wait for.
    pub ask: KeySetAsk,
    /// The issuers it answers for, one at least.
    pub issuers: Vec<String>,
    /// The most calls that wait for one issuer's deadline at once, each issuer's apart: 64 when
    /// none, from 1 to 2³¹ − 1.
    pub maximum_waiting_calls: Option<u64>,
}

impl fmt::Debug for JwtKeySet {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JwtKeySet")
            .field("issuers", &self.issuers)
            .field("maximum_waiting_calls", &self.maximum_waiting_calls)
            .finish_non_exhaustive()
    }
}

/// What an `ELSEWHERE`'s verifier settles with for a credential that holds (spec 13.11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElsewhereSession {
    /// Its id, which names its session with the scheme.
    pub id: String,
    /// Its data, which the call carries.
    pub data: Option<Value>,
    /// Its end, in milliseconds since the epoch; none for a session without one.
    pub end: Option<i64>,
}

/// What an `ELSEWHERE`'s verifier settles with: a session, none for a credential that does not
/// hold, or its error.
pub type ElsewhereVerdict = Result<Option<ElsewhereSession>, Box<dyn Error + Send + Sync>>;

/// The `ELSEWHERE` verifier: given what its call's transport carried, whole, and its call's signal.
pub type ElsewhereVerifier =
    Arc<dyn Fn(String, CancellationToken) -> BoxFuture<ElsewhereVerdict> + Send + Sync>;

/// What a side resolves a request's `JWT` and `ELSEWHERE` with.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct Credentials {
    /// The audience a `JWT` names for this side (RFC 7519 §4.1.3).
    pub audience: Option<String>,
    /// The keys a `JWT` is verified with (spec 13.8), held for good.
    pub keys: Vec<JwtKey>,
    /// The key set the side asks for the keys of the issuers it names (spec 13.9).
    pub key_set: Option<JwtKeySet>,
    /// The `ELSEWHERE` verifier.
    pub verify: Option<ElsewhereVerifier>,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Credentials")
            .field("audience", &self.audience)
            .field("keys", &self.keys.len())
            .field("key_set", &self.key_set)
            .field("verify", &self.verify.is_some())
            .finish()
    }
}

/// Refuses limits that do not hold a `JWT`'s header (spec 12.2).
///
/// # Errors
///
/// A [`ProgrammerError`] for a chunk or an envelope under 1,024 bytes.
pub fn assert_limits_hold_jwt(limits: &RouterLimits) -> Result<(), ProgrammerError> {
    if limits.chunk_bytes < JWT_LIMIT_BYTES || limits.maximum_envelope_bytes < JWT_LIMIT_BYTES {
        return Err(ProgrammerError::new(
            "the router's limits do not hold together: a side that takes or presents a JWT holds a chunk's envelope and an envelope of 1,024 bytes at least",
        ));
    }

    Ok(())
}

// a call that waits for its issuer's keys: on an ask, uncounted, or for the deadline, where it holds
// its place among those its key set lets wait
struct Waiter {
    id: u64,
    has_kid: bool,
    kid: Option<String>,
    is_after: bool,
    released: Option<oneshot::Sender<Result<(), Unresolved>>>,
}

impl Waiter {
    fn release(&mut self, outcome: Result<(), Unresolved>) {
        if let Some(released) = self.released.take() {
            drop(released.send(outcome));
        }
    }
}

// one ask of a key set for an issuer, and the calls that wait on it
struct KeySetAskState {
    id: u64,
    signal: CancellationToken,
    waiters: Vec<Waiter>,
}

// what a side holds of an issuer its key set names
struct IssuerKeys {
    issuer: String,
    answered: Option<Duration>,
    asking: Option<KeySetAskState>,
    deadline: Option<Duration>,
    held: Vec<JwtKey>,
    next: Vec<Waiter>,
    timer: Option<Arc<dyn Timer>>,
}

// what an ask settled to: its keys, or why it failed, which fails each call on it
enum AskOutcome {
    Keys(Vec<JwtKey>),
    Failure(Unresolved),
}

struct KeySetState {
    issuers: BTreeMap<String, IssuerKeys>,
    next_id: u64,
}

struct Inner {
    audience: Option<String>,
    keys: Vec<JwtKey>,
    ask: Option<KeySetAsk>,
    maximum_waiting_calls: u64,
    verify: Option<ElsewhereVerifier>,
    clock: SharedClock,
    runtime: Handle,
    state: Mutex<KeySetState>,
}

/// The resolver of a side's `JWT`s and `ELSEWHERE`s, from its credentials, on its clock.
#[derive(Clone)]
pub(crate) struct CredentialResolver {
    inner: Arc<Inner>,
}

impl fmt::Debug for CredentialResolver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialResolver")
            .finish_non_exhaustive()
    }
}

/// A request whose credential a side resolves: what it presents, what its transport carried, and
/// the audience a `JWT` is held to, the side's own when none.
#[derive(Debug, Clone)]
pub(crate) struct CredentialRequest {
    pub(crate) audiences: Option<Vec<String>>,
    pub(crate) credential: Credential,
    pub(crate) transport_credential: Option<String>,
}

fn locked(inner: &Inner) -> MutexGuard<'_, KeySetState> {
    inner.state.lock().unwrap_or_else(PoisonError::into_inner)
}

fn failure_of(message: String) -> Unresolved {
    Unresolved::Other(Arc::new(KeySetError(message)))
}

/// A key set's failure, as the calls that waited on it are failed.
#[derive(Debug, Clone)]
struct KeySetError(String);

impl fmt::Display for KeySetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for KeySetError {}

fn string_of<'a>(object: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    object.get(name).and_then(Value::as_str)
}

// whether a token's key does not serve among `serving`, its issuer's keys, so that it waits for
// them: its kid names none of them; without a kid, there are none
fn needs(serving: &[JwtKey], (has_kid, kid): (bool, Option<&str>)) -> bool {
    if !has_kid {
        return serving.is_empty();
    }

    kid.is_some_and(|kid| {
        !serving
            .iter()
            .any(|key| string_of(&key.jwk, "kid") == Some(kid))
    })
}

fn milliseconds_since_epoch(at: SystemTime) -> i64 {
    at.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

impl CredentialResolver {
    /// The resolver of `credentials`, on `clock` and `runtime`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a key not shaped for its algorithm, a key set without an issuer
    /// or with a `maximum_waiting_calls` out of its bounds, or keys without an audience.
    pub(crate) fn new(
        credentials: &Credentials,
        (clock, runtime): (SharedClock, Handle),
    ) -> Result<Self, ProgrammerError> {
        for key in &credentials.keys {
            assert_jwt_key(key)?;
        }

        let mut issuers = BTreeMap::new();
        let mut maximum_waiting_calls = KEY_SET_WAITING_CALLS;

        if let Some(key_set) = &credentials.key_set {
            if key_set.issuers.is_empty() {
                return Err(ProgrammerError::new(
                    "a key set is given with its ask and the issuers it answers for, one at least, each a string",
                ));
            }

            maximum_waiting_calls = key_set
                .maximum_waiting_calls
                .unwrap_or(KEY_SET_WAITING_CALLS);

            if !(1..=MOST_WAITING_CALLS).contains(&maximum_waiting_calls) {
                return Err(ProgrammerError::new(format!(
                    "a key set's maximumWaitingCalls is a whole number from 1 to {MOST_WAITING_CALLS}, not {maximum_waiting_calls}"
                )));
            }

            for issuer in &key_set.issuers {
                issuers.insert(
                    issuer.clone(),
                    IssuerKeys {
                        issuer: issuer.clone(),
                        answered: None,
                        asking: None,
                        deadline: None,
                        held: Vec::new(),
                        next: Vec::new(),
                        timer: None,
                    },
                );
            }
        }

        let takes_jwt = !credentials.keys.is_empty() || credentials.key_set.is_some();

        // ! keys held to no audience would refuse every JWT SESSION_REQUIRED: the application's
        // fault, told as the side is built, never charged to a token
        if takes_jwt && credentials.audience.is_none() {
            return Err(ProgrammerError::new(
                "a side given a JWT's keys or a key set is given its audience too",
            ));
        }

        Ok(Self {
            inner: Arc::new(Inner {
                audience: credentials.audience.clone(),
                keys: credentials.keys.clone(),
                ask: credentials
                    .key_set
                    .as_ref()
                    .map(|key_set| Arc::clone(&key_set.ask)),
                maximum_waiting_calls,
                verify: credentials.verify.clone(),
                clock,
                runtime,
                state: Mutex::new(KeySetState {
                    issuers,
                    next_id: 1,
                }),
            }),
        })
    }

    /// Whether it takes a `JWT`: its limits must hold one (spec 12.2).
    pub(crate) fn takes_jwt(&self) -> bool {
        !self.inner.keys.is_empty() || self.inner.ask.is_some()
    }

    /// The credential schemes it takes besides `OPAQUE`.
    pub(crate) fn schemes(&self) -> Vec<CredentialScheme> {
        let mut schemes = Vec::new();

        if self.takes_jwt() {
            schemes.push(CredentialScheme::JWT);
        }

        if self.inner.verify.is_some() {
            schemes.push(CredentialScheme::ELSEWHERE);
        }

        schemes
    }

    /// The credential's session a request presenting a `JWT` or an `ELSEWHERE` resolves to.
    pub(crate) fn resolve(
        &self,
        (request, signal): (CredentialRequest, CancellationToken),
    ) -> BoxFuture<Result<Resolved, Unresolved>> {
        let inner = Arc::clone(&self.inner);

        match request.credential {
            Credential::Jwt(token) => {
                let audiences = request
                    .audiences
                    .or_else(|| inner.audience.clone().map(|audience| vec![audience]))
                    .unwrap_or_default();

                Box::pin(async move { resolve_jwt(&inner, (token, audiences, signal)).await })
            }
            Credential::Elsewhere => match request.transport_credential {
                Some(carried) => {
                    Box::pin(async move { resolve_elsewhere(&inner, (carried, signal)).await })
                }
                None => Box::pin(async { Ok(Resolved::None) }),
            },
            Credential::None | Credential::Opaque(_) | Credential::ToCome { .. } => {
                Box::pin(async { Ok(Resolved::None) })
            }
        }
    }
}

// the wall clock's reading, in milliseconds since the epoch, a fraction dropped
fn wall_now(inner: &Inner) -> SystemTime {
    inner.clock.wall()
}

// whether the keys an issuer's key set answered serve still: ten minutes from its answer
fn is_serving(inner: &Inner, entry: &IssuerKeys) -> bool {
    entry
        .answered
        .is_some_and(|answered| inner.clock.monotonic() < answered.saturating_add(KEY_SET_HOLD))
}

// the keys that serve, in the order 13.8's step 4 searches (13.9.4): the application's, then those
// each issuer's key set answered, for their ten minutes
fn keys_serving(inner: &Inner) -> Vec<JwtKey> {
    let state = locked(inner);
    let mut keys = inner.keys.clone();

    for entry in state.issuers.values() {
        if is_serving(inner, entry) {
            keys.extend(entry.held.iter().cloned());
        }
    }

    drop(state);

    keys
}

// the keys of an issuer that serve
fn issuer_keys_of(inner: &Inner, entry: &IssuerKeys) -> Vec<JwtKey> {
    let mut keys: Vec<JwtKey> = inner
        .keys
        .iter()
        .filter(|key| key.issuer == entry.issuer)
        .cloned()
        .collect();

    if is_serving(inner, entry) {
        keys.extend(entry.held.iter().cloned());
    }

    keys
}

fn refusal_of(inner: &Inner, entry: &IssuerKeys) -> Option<Unresolved> {
    (u64::try_from(entry.next.len()).unwrap_or(u64::MAX) >= inner.maximum_waiting_calls).then(
        || {
            Unresolved::Capacity(CapacityError::new(format!(
                "as many calls as its key set lets wait for the deadline of {} wait already",
                entry.issuer
            )))
        },
    )
}

fn disarm(entry: &mut IssuerKeys) {
    if let Some(timer) = entry.timer.take() {
        timer.cancel();
    }
}

// an ask settled: its answer replaces the keys held; its failure replaces none, and fails every call
// on it; otherwise each is judged again once its key serves or the ask went after it came, else
// moves onto the deadline, refused once it is full
fn settle(inner: &Inner, (entry, outcome): (&mut IssuerKeys, AskOutcome)) {
    let Some(ask) = entry.asking.take() else {
        return;
    };

    if let AskOutcome::Keys(keys) = &outcome {
        entry.held.clone_from(keys);
        entry.answered = Some(inner.clock.monotonic());
    }

    for mut waiter in ask.waiters {
        match &outcome {
            AskOutcome::Failure(failure) => waiter.release(Err(failure.clone())),
            AskOutcome::Keys(_) => {
                let serving = issuer_keys_of(inner, entry);

                if waiter.is_after || !needs(&serving, (waiter.has_kid, waiter.kid.as_deref())) {
                    waiter.release(Ok(()));
                } else if let Some(refused) = refusal_of(inner, entry) {
                    waiter.release(Err(refused));
                } else {
                    entry.next.push(waiter);
                }
            }
        }
    }

    if entry.next.is_empty() {
        disarm(entry);
    }
}

// one ask of the key set for the issuer, at once, for the calls that waited for its deadline and
// `joining`; its deadline a minute past `now`
fn ask_now(
    inner: &Arc<Inner>,
    (state, issuer, joining, now): (&mut KeySetState, &str, Option<Waiter>, Duration),
) -> Option<u64> {
    let id = state.next_id;

    state.next_id = state.next_id.saturating_add(1);

    let entry = state.issuers.get_mut(issuer)?;
    let mut waiters = core::mem::take(&mut entry.next);

    if let Some(joining) = joining {
        waiters.push(joining);
    }

    for waiter in &mut waiters {
        waiter.is_after = true;
    }

    let signal = CancellationToken::new();

    disarm(entry);
    entry.asking = Some(KeySetAskState {
        id,
        signal: signal.clone(),
        waiters,
    });
    entry.deadline = Some(now.saturating_add(KEY_SET_INTERVAL));
    arm(inner, entry);

    let weak = Arc::downgrade(inner);
    let issuer = issuer.to_owned();

    if let Some(ask) = inner.ask.clone() {
        let asking = ask(issuer.clone(), signal);

        crate::owner::spawn_counted((&inner.runtime, &inner.clock), async move {
            let answered = asking.await;

            answer(&weak, (&issuer, id, answered));
        });
    }

    Some(id)
}

// an ask answered: settled with the answer, unless a deadline that answer reached settled it first
fn answer(weak: &Weak<Inner>, (issuer, id, answered): (&str, u64, KeySetAnswer)) {
    let Some(inner) = weak.upgrade() else {
        return;
    };
    let outcome = match answered {
        Ok(keys) => {
            let held: Result<Vec<JwtKey>, ProgrammerError> = keys
                .into_iter()
                .map(|key| {
                    let key = JwtKey {
                        algorithm: key.algorithm,
                        issuer: issuer.to_owned(),
                        jwk: key.jwk,
                    };

                    assert_jwt_key(&key).map(|()| key)
                })
                .collect();

            held.map_or_else(
                |error| {
                    AskOutcome::Failure(failure_of(format!(
                        "the key set's ask for {issuer} failed: {error}"
                    )))
                },
                AskOutcome::Keys,
            )
        }
        Err(error) => AskOutcome::Failure(failure_of(format!(
            "the key set's ask for {issuer} failed: {error}"
        ))),
    };
    let now = inner.clock.monotonic();
    let mut state = locked(&inner);

    // ! an answer at its deadline or past it is dropped: its ask failed there, its keys never held
    reach(&inner, (&mut state, issuer, now));

    if let Some(entry) = state.issuers.get_mut(issuer)
        && entry.asking.as_ref().is_some_and(|ask| ask.id == id)
    {
        settle(&inner, (entry, outcome));
    }

    drop(state);
}

// the issuer's deadline, once the reading `now` is at it or past it: an ask unsettled then has
// failed, and the calls that waited for it have the next ask go, which it gives
fn reach(
    inner: &Arc<Inner>,
    (state, issuer, now): (&mut KeySetState, &str, Duration),
) -> Option<u64> {
    let entry = state.issuers.get_mut(issuer)?;

    if entry.deadline.is_none_or(|deadline| now < deadline) {
        return None;
    }

    if let Some(signal) = entry.asking.as_ref().map(|ask| ask.signal.clone()) {
        let failure = failure_of(format!(
            "the key set's ask for {issuer} was unsettled as its deadline was reached"
        ));

        settle(inner, (entry, AskOutcome::Failure(failure)));
        signal.cancel();
    }

    if entry.next.is_empty() {
        return None;
    }

    ask_now(inner, (state, issuer, None, now))
}

// * the deadline's timer only makes sure the deadline is reached when nothing else reads it
fn arm(inner: &Arc<Inner>, entry: &mut IssuerKeys) {
    if entry.timer.is_some() {
        return;
    }

    let now = inner.clock.monotonic();
    let left = entry
        .deadline
        .map_or(Duration::ZERO, |deadline| deadline.saturating_sub(now));
    let milliseconds = left.as_nanos().div_ceil(1_000_000).max(1);
    let delay = Duration::from_millis(u64::try_from(milliseconds).unwrap_or(u64::MAX))
        .min(crate::duration::LONGEST_TIMER);
    let weak = Arc::downgrade(inner);
    let issuer = entry.issuer.clone();

    entry.timer = Some(inner.clock.arm(
        Schedule::Once(delay),
        Box::new(move || {
            let Some(inner) = weak.upgrade() else {
                return;
            };
            let now = inner.clock.monotonic();
            let mut state = locked(&inner);

            if let Some(entry) = state.issuers.get_mut(&issuer) {
                entry.timer = None;
            }

            reach(&inner, (&mut state, &issuer, now));

            let is_waiting = state
                .issuers
                .get(&issuer)
                .is_some_and(|entry| entry.asking.is_some() || !entry.next.is_empty());

            if is_waiting && let Some(entry) = state.issuers.get_mut(&issuer) {
                arm(&inner, entry);
            }

            drop(state);
        }),
    ));
}

// a call that leaves its wait by its own signal reaches nothing: it frees its place
fn leave((state, issuer, id): (&mut KeySetState, &str, u64)) {
    let Some(entry) = state.issuers.get_mut(issuer) else {
        return;
    };

    if let Some(ask) = &mut entry.asking {
        ask.waiters.retain(|waiter| waiter.id != id);
    }

    let was = entry.next.len();

    entry.next.retain(|waiter| waiter.id != id);

    if was != entry.next.len() && entry.next.is_empty() && entry.asking.is_none() {
        disarm(entry);
    }
}

// a wait on an issuer's deadline: its issuer, its id, and what settles it
type Wait = (String, u64, oneshot::Receiver<Result<(), Unresolved>>);

// the wait of a token of an issuer the key set names, in the order 13.9.5 takes: a deadline the
// reading reached, then whether its key serves, then the bound
fn wait_of(
    inner: &Arc<Inner>,
    (token, judged, signal): (&[u8], &[JwtKey], &CancellationToken),
) -> Result<Option<Wait>, Unresolved> {
    let Some((header, claims)) = read_jwt(token) else {
        return Ok(None);
    };
    let Some(issuer) = string_of(&claims, "iss").map(str::to_owned) else {
        return Ok(None);
    };
    let mut state = locked(inner);

    if !state.issuers.contains_key(&issuer) {
        return Ok(None);
    }

    if signal.is_cancelled() {
        return Err(failure_of("the call was cancelled as it waited".to_owned()));
    }

    let now = inner.clock.monotonic();
    let let_go = reach(inner, (&mut state, &issuer, now));
    let has_kid = header.contains_key("kid");
    let kid = string_of(&header, "kid").map(str::to_owned);
    let id = state.next_id;

    state.next_id = state.next_id.saturating_add(1);

    let Some(entry) = state.issuers.get_mut(&issuer) else {
        return Ok(None);
    };

    // ! a key that came to serve as it was judged, an answer settling meanwhile: it is judged again
    if !needs(&issuer_keys_of(inner, entry), (has_kid, kid.as_deref())) {
        let served: Vec<JwtKey> = judged
            .iter()
            .filter(|key| key.issuer == entry.issuer)
            .cloned()
            .collect();
        let (released, receiver) = oneshot::channel();

        drop(state);

        if needs(&served, (has_kid, kid.as_deref())) {
            drop(released.send(Ok(())));

            return Ok(Some((issuer, id, receiver)));
        }

        return Ok(None);
    }

    let (released, receiver) = oneshot::channel();
    let mut waiter = Waiter {
        id,
        has_kid,
        kid,
        is_after: false,
        released: Some(released),
    };

    if let Some(ask) = &mut entry.asking {
        waiter.is_after = Some(ask.id) == let_go;
        ask.waiters.push(waiter);
    } else if entry.deadline.is_some_and(|deadline| now < deadline) {
        if let Some(refused) = refusal_of(inner, entry) {
            return Err(refused);
        }

        entry.next.push(waiter);
        arm(inner, entry);
    } else {
        ask_now(inner, (&mut state, &issuer, Some(waiter), now));
    }

    drop(state);

    Ok(Some((issuer, id, receiver)))
}

// a token's verdict against the keys that serve; one refused at its key or past it waits for its
// issuer's keys while its key does not serve, and is judged again, its last word
async fn verdict_of(
    inner: &Arc<Inner>,
    (token, audiences, signal): (&Bytes, &[String], &CancellationToken),
) -> Result<JwtVerdict, Unresolved> {
    let now = || wall_now(inner);
    let judge = |keys: &[JwtKey]| {
        verify_jwt(
            token,
            &JwtAgainst {
                audiences,
                keys,
                now: &now,
            },
        )
        .map_err(|error| Unresolved::Other(Arc::new(error)))
    };
    let judged = keys_serving(inner);
    let verdict = judge(&judged)?;
    let is_before_key = matches!(
        verdict,
        JwtVerdict::Refused(JwtRefusal::Token | JwtRefusal::Crit | JwtRefusal::Typ)
    );

    if matches!(verdict, JwtVerdict::Holds { .. }) || is_before_key {
        return Ok(verdict);
    }

    let Some((issuer, id, released)) = wait_of(inner, (token, &judged, signal))? else {
        return Ok(verdict);
    };
    let waited = signal.run_until_cancelled(released).await;

    match waited {
        None => {
            let mut state = locked(inner);

            leave((&mut state, &issuer, id));
            drop(state);

            return Err(failure_of("the call was cancelled as it waited".to_owned()));
        }
        Some(Err(_dropped)) => return Err(failure_of("the key set was dropped".to_owned())),
        Some(Ok(Err(failure))) => return Err(failure),
        Some(Ok(Ok(()))) => {}
    }

    judge(&keys_serving(inner))
}

async fn resolve_jwt(
    inner: &Arc<Inner>,
    (token, audiences, signal): (Bytes, Vec<String>, CancellationToken),
) -> Result<Resolved, Unresolved> {
    let verdict = verdict_of(inner, (&token, &audiences, &signal)).await?;

    Ok(match verdict {
        JwtVerdict::Holds {
            claims,
            end,
            identifier,
        } => Resolved::Session(CallSession {
            data: Some(Value::Object(claims)),
            end: Some(end),
            identifier: Some(match identifier {
                JwtSessionIdentifier::Sid { issuer, sid } => {
                    SessionIdentifier::JwtSid { issuer, sid }
                }
                JwtSessionIdentifier::Sub { issuer, sub } => {
                    SessionIdentifier::JwtSub { issuer, sub }
                }
            }),
        }),
        // refused by the step of section 13.8 that refused it, which an access refused tells
        JwtVerdict::Refused(reason) => Resolved::Refused(reason.as_str().to_owned()),
    })
}

async fn resolve_elsewhere(
    inner: &Arc<Inner>,
    (carried, signal): (String, CancellationToken),
) -> Result<Resolved, Unresolved> {
    let Some(verify) = inner.verify.clone() else {
        return Ok(Resolved::None);
    };
    let session = verify(carried, signal)
        .await
        .map_err(|error| Unresolved::Other(Arc::from(error)))?;
    let Some(session) = session else {
        return Ok(Resolved::Refused("verifier".to_owned()));
    };

    // the wall clock read as the verifier settles: a session whose end it reached does not hold
    if let Some(end) = session.end
        && milliseconds_since_epoch(wall_now(inner)) >= end
    {
        return Ok(Resolved::Refused("end".to_owned()));
    }

    Ok(Resolved::Session(CallSession {
        data: session.data,
        end: session.end,
        identifier: Some(SessionIdentifier::Elsewhere { id: session.id }),
    }))
}
