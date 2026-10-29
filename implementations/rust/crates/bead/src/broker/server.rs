//! A server's transport over a broker's participant (spec 15.18 to 15.23): it serves its names,
//! judges each OPEN that comes to them in order — a layout to come refused 426, an id that is no
//! token or a receive bound under 1,024 refused 400, past its bounds or once its stop began 503 —
//! and answers any other with an ACCEPT, its connection then half-open, holding its place and
//! telling nothing; it tells its router the connection, drawing its handle
//! `type=…;participant=…;ordinal=…`, once the client's first parcel naming both halves proves it
//! reads its inbox, and forgets one whose third leg did not come within its accept timeout. It
//! hands its router each envelope with its peer participant's id as its address and no port, the
//! credential its DATA carried beside it; it carries none toward its client.

use core::fmt;
use core::sync::atomic::Ordering;
use core::time::Duration;
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use tokio::sync::watch;

use crate::broker::adapter::{BrokerCapabilities, BrokerError, BrokerSubscription};
use crate::broker::client::MAXIMUM_UNSENT_BYTES;
use crate::broker::parcel::{
    LAYOUT, LEAST_BOUND, Parcel, ParcelRead, is_token, kinds, refuse_reason_of,
};
use crate::broker::participant::{
    BrokerParticipant, ConnectionOwner, End, Pair, ParticipantState, Peer, Setup, reported,
};
use crate::broker::sequence::fits;
use crate::clock::{Schedule, SharedClock, Timer};
use crate::duration::hold_finite;
use crate::errors::ProgrammerError;
use crate::router::types::{BoxFuture, ConnectionHandle, Gauges, RouterError, TransportMessage};
use crate::transport::{
    Listeners, ReadyState, Sent, ServerListener, ServerTransport, TransportServerRefusal,
};

/// The connections a server's transport holds at once by default, half-open ones among them
/// (spec 15.12).
pub const MAXIMUM_CONNECTIONS: u64 = 10_000;

/// The connections one participant's id holds at once by default (spec 15.12).
pub const MAXIMUM_CONNECTIONS_PER_ADDRESS: u64 = 64;

/// How long a half-open connection waits for its client's first parcel by default (spec 15.23).
pub const ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How a broker's server transport is built (spec 15.12, 15.18, 15.23).
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct BrokerServerOptions {
    /// The names it serves, each a token, a server's as a host name is (spec 15.16): its clients'
    /// OPENs go to them; one at least.
    pub names: Vec<String>,
    /// Whether it serves its names in a group, its broker handing each OPEN to one of the
    /// participants serving it, as a name served by several needs (spec 15.18); while it holds
    /// `maximum_connections` it then leaves its names, and serves them again once it holds fewer.
    /// False when none.
    pub is_in_group: Option<bool>,
    /// The connections it holds at once, half-open ones among them, past which an OPEN is refused
    /// 503 (spec 15.12): [`MAXIMUM_CONNECTIONS`] when none.
    pub maximum_connections: Option<u64>,
    /// The connections one participant's id holds at once (spec 15.12):
    /// [`MAXIMUM_CONNECTIONS_PER_ADDRESS`] when none.
    pub maximum_connections_per_address: Option<u64>,
    /// What may wait for its broker on a connection (spec 15.23), past which the connection is
    /// lost, a CLOSE of 4000: [`MAXIMUM_UNSENT_BYTES`] when none.
    pub maximum_unsent_bytes: Option<u64>,
    /// How long a half-open connection waits for its client's first parcel naming both halves (spec
    /// 15.23): [`ACCEPT_TIMEOUT`] when none, on its participant's clock; never is refused.
    pub accept_timeout: Option<Duration>,
    /// Whether its own leg is secure, as its application says of what stands in front of it (spec
    /// 15.22); its adapter's word when none.
    pub secure: Option<bool>,
}

impl BrokerServerOptions {
    /// A server transport serving `names`.
    #[must_use]
    pub fn of<N: Into<String>, I: IntoIterator<Item = N>>(names: I) -> Self {
        Self {
            names: names.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }
}

// a connection held, half-open or told
struct HeldConnection {
    peer_id: String,
    opener: u64,
    is_peer_secure: bool,
    room: u64,
    handle: Option<ConnectionHandle>,
    accepting: Option<Arc<dyn Timer>>,
    arrival: u64,
    last_activity: Option<i64>,
}

struct ServerState {
    ready: ReadyState,
    // every connection held, half-open ones among them, by its pair
    held: HashMap<Pair, HeldConnection>,
    // those its router was told of, by their handle
    handles: HashMap<ConnectionHandle, Pair>,
    // the names its broker holds a subscription to, from its SUBACK to its UNSUBACK
    subscribed: BTreeSet<String>,
    // whether it left its names while it holds its bound, served in a group
    is_full: bool,
    arrivals: u64,
    stopped: Option<watch::Receiver<bool>>,
}

pub(crate) struct ServerInner {
    // itself, for what it sets going from its connections' ends
    me: Weak<Self>,
    participant: BrokerParticipant,
    names: Vec<String>,
    is_in_group: bool,
    maximum_connections: u64,
    maximum_per_address: u64,
    maximum_unsent: u64,
    accept_timeout: Duration,
    is_secure: bool,
    state: Mutex<ServerState>,
    listeners: Listeners<dyn ServerListener>,
}

/// A server's transport over a broker's participant, serving the names it is given.
#[derive(Clone)]
pub struct BrokerServer {
    inner: Arc<ServerInner>,
}

impl fmt::Debug for BrokerServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BrokerServer")
            .field("names", &self.inner.names)
            .finish_non_exhaustive()
    }
}

/// Refuses an OPEN with `status`, to the inbox it names: what names no inbox, nor a half, is
/// answered nowhere; an empty id names one, as its id.
pub(crate) fn refuse_open(state: &ParticipantState, (open, status): (&Parcel, u16)) {
    let Some(id) = &open.id else {
        return;
    };

    if open.opener == 0 {
        return;
    }

    let mut refuse = Parcel::of(kinds::REFUSE);

    refuse.opener = open.opener;
    refuse.sequence = 1;
    refuse.status = Some(status);
    refuse.layouts = (status == 426).then(|| vec![LAYOUT]);
    state.quietly((state.config.inbox_of(id), &refuse));
}

fn wall_of(clock: &SharedClock) -> i64 {
    clock
        .wall()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

impl ServerInner {
    fn tell<C: Fn(&dyn ServerListener)>(
        &self,
        (call, connection_handle): (C, Option<&ConnectionHandle>),
    ) {
        let listeners = self.listeners.all();

        self.listeners.each((
            |listener: &(dyn ServerListener + 'static)| call(listener),
            |error: RouterError| {
                for heard in &listeners {
                    // ! a listener of errors that panics would loop: its panic is dropped
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        heard.on_error(&error, connection_handle);
                    }))
                    .ok();
                }
            },
        ));
    }

    /// What it reports of its own, with the connection it came on, or none.
    pub(crate) fn report(
        &self,
        (error, connection_handle): (&RouterError, Option<&ConnectionHandle>),
    ) {
        for listener in self.listeners.all() {
            // ! a listener of errors that panics would loop: its panic is dropped
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                listener.on_error(error, connection_handle);
            }))
            .ok();
        }
    }

    fn ready(&self) -> ReadyState {
        locked(&self.state).ready
    }

    /// In its participant's turn: an OPEN, or what came to `name`, one of its names, judged in the
    /// order spec 15.18 states; no parcel, or an OPEN that does not read, dropped and reported.
    pub(crate) fn take_open(
        self: &Arc<Self>,
        state: &mut ParticipantState,
        (name, read): (&str, ParcelRead),
    ) {
        let open = match read {
            ParcelRead::NoParcel(why) => {
                let error = reported(format!("a message to the name {name} is no parcel: {why}"));

                state.config.report(&error);

                return;
            }
            ParcelRead::DoesNotRead(prefix, why) => {
                if prefix.kind == kinds::OPEN {
                    let error = reported(format!(
                        "an OPEN to the name {name} does not read, dropped: {why}"
                    ));

                    state.config.report(&error);
                }

                return;
            }
            ParcelRead::Parcel(open) if open.kind == kinds::OPEN => open,
            ParcelRead::Parcel(_) => return,
        };

        if open.layout != LAYOUT {
            self.refuse(state, (&open, 426));

            return;
        }

        let id = open.id.clone().unwrap_or_default();

        if !is_token(&id) || open.bound.unwrap_or(0) < LEAST_BOUND {
            self.refuse(state, (&open, 400));

            return;
        }

        let is_busy = {
            let held = locked(&self.state);

            // ! an OPEN whose id and half name a connection held is a copy, dropped in silence
            if held
                .held
                .values()
                .any(|connection| connection.peer_id == id && connection.opener == open.opener)
            {
                return;
            }

            let of_id = held
                .held
                .values()
                .filter(|connection| connection.peer_id == id)
                .count();

            held.ready != ReadyState::Open
                || u64::try_from(held.held.len()).unwrap_or(u64::MAX) >= self.maximum_connections
                || u64::try_from(of_id).unwrap_or(u64::MAX) >= self.maximum_per_address
        };

        if is_busy {
            self.refuse(state, (&open, 503));

            return;
        }

        self.accept(state, &open);
    }

    // an OPEN refused, to the inbox it names, and told (spec 15.1)
    fn refuse(&self, state: &ParticipantState, (open, status): (&Parcel, u16)) {
        let Some(id) = open.id.clone() else {
            return;
        };

        if open.opener == 0 {
            return;
        }

        refuse_open(state, (open, status));

        let refusal = TransportServerRefusal::of(
            (status, refuse_reason_of(status).unwrap_or("busy")),
            Some(id),
        );

        self.tell((
            |listener: &dyn ServerListener| listener.on_refusal(&refusal),
            None,
        ));
    }

    // an OPEN answered with an ACCEPT, its connection half-open, holding its place, its accept
    // timeout armed on the clock given
    fn accept(self: &Arc<Self>, state: &mut ParticipantState, open: &Parcel) {
        let Some(acceptor) = state.draw_half() else {
            self.refuse(state, (open, 503));

            return;
        };
        let pair = (open.opener, acceptor);
        let peer = Peer::of(open);
        let owner: Arc<dyn ConnectionOwner> = Arc::<Self>::clone(self);
        let peer_id = peer.id.clone();
        let is_peer_secure = peer.is_secure;

        state.hold(Setup {
            owner,
            pair,
            peer,
            sent: 0,
            maximum_unsent: self.maximum_unsent,
            is_half_open: true,
        });

        let room = state.room_of(pair).unwrap_or(0);
        let participant = self.participant.clone();
        // * forgotten, nothing told and nothing sent (spec 15.18)
        let accepting = self.participant.clock().arm(
            Schedule::Once(self.accept_timeout),
            Box::new(move || {
                participant.post(move |state: &mut ParticipantState| {
                    if state.is_half_open(pair) {
                        state.drop_connection(pair);
                    }
                });
            }),
        );

        {
            let mut held = locked(&self.state);

            held.held.insert(
                pair,
                HeldConnection {
                    peer_id,
                    opener: open.opener,
                    is_peer_secure,
                    room,
                    handle: None,
                    accepting: Some(accepting),
                    arrival: 0,
                    last_activity: None,
                },
            );
        }

        // * its first parcel, as each of its connection's: held to what may wait for its broker
        state.accept_on((pair, self.is_secure));
        self.leave();
    }

    /// Its names subscribed, as it starts, a name refused failing its start, and as its
    /// participant's link connects again, a name refused then reported and left unheld until its
    /// participant's next link.
    pub(crate) fn relink(self: &Arc<Self>) -> BoxFuture<Result<(), BrokerError>> {
        let state = locked(&self.state);

        if !matches!(state.ready, ReadyState::Open | ReadyState::Connecting) || state.is_full {
            return Box::pin(async { Ok(()) });
        }

        drop(state);
        self.join()
    }

    /// Its link lost, its names held no more.
    pub(crate) fn unlinked(&self) {
        locked(&self.state).subscribed.clear();
    }

    // its names subscribed, alone or in its group, all asked at once, each counted once its broker
    // holds it; refused as it starts, its start fails, and at a link anew or a rejoin, it is
    // reported and left unheld, the gauge saying so
    fn join(self: &Arc<Self>) -> BoxFuture<Result<(), BrokerError>> {
        // * one its broker holds already, its participant's link having joined it, is asked once
        let asked: Vec<String> = {
            let state = locked(&self.state);

            self.names
                .iter()
                .filter(|name| !state.subscribed.contains(*name))
                .cloned()
                .collect()
        };
        let joining: Vec<BoxFuture<Result<(), BrokerError>>> =
            asked.into_iter().map(|name| self.join_one(name)).collect();

        Box::pin(async move {
            for each in joining {
                each.await?;
            }

            Ok(())
        })
    }

    // one name subscribed, counted once its broker holds it
    fn join_one(self: &Arc<Self>, name: String) -> BoxFuture<Result<(), BrokerError>> {
        let config = self.participant.config();
        let subscription = BrokerSubscription {
            group: self.is_in_group.then(|| name.clone()),
            ..BrokerSubscription::default()
        };

        let subscribing = config
            .adapter
            .subscribe(&config.name_of(&name), subscription);
        let server = Arc::clone(self);

        Box::pin(async move {
            match subscribing.await {
                Ok(()) => {
                    locked(&server.state).subscribed.insert(name);

                    Ok(())
                }
                Err(reason)
                    if server.ready() == ReadyState::Open
                        && !server.participant.config().is_down_as_it_links() =>
                {
                    let error = reported(format!(
                        "the name {name} is not served: its broker refused its subscription, {reason}"
                    ));

                    server.report((&error, None));

                    Ok(())
                }
                Err(reason) => Err(reason),
            }
        })
    }

    // * served in a group: its names left while it holds its bound, so its capacity is its
    // broker's placement (spec 15.18)
    fn leave(self: &Arc<Self>) {
        {
            let mut state = locked(&self.state);

            if !self.is_in_group
                || state.is_full
                || u64::try_from(state.held.len()).unwrap_or(u64::MAX) < self.maximum_connections
            {
                return;
            }

            state.is_full = true;
        }

        let config = Arc::clone(self.participant.config());

        for name in &self.names {
            // * counted until its UNSUBACK came
            let leaving = config.adapter.unsubscribe(&config.name_of(name));
            let server = Arc::clone(self);
            let name = name.clone();

            self.participant.cover(async move {
                let left = leaving.await;
                let posted = Arc::clone(&server);

                server
                    .participant
                    .post(move |_state: &mut ParticipantState| posted.left((name, left)));
            });
        }
    }

    // a name it left, held no more once its UNSUBACK came; one its broker refused to let go
    // reported; and one served again meanwhile, which its rejoin found still held and asked nothing
    // of, asked anew
    fn left(self: &Arc<Self>, (name, left): (String, Result<(), BrokerError>)) {
        let config = Arc::clone(self.participant.config());

        if let Err(reason) = left
            && !matches!(reason, BrokerError::Refused(_))
            && config.is_linked()
            && !config.is_down_as_it_links()
        {
            config.report(&RouterError::Other(Arc::new(reason)));
        }

        let is_asked_anew = {
            let mut state = locked(&self.state);

            state.subscribed.remove(&name);

            !state.is_full && state.ready == ReadyState::Open && config.is_linked()
        };

        if is_asked_anew {
            let joining = self.join_one(name);

            self.participant.cover(async move {
                joining.await.ok();
            });
        }
    }

    // served in a group: its names served again once it holds fewer than its bound
    fn rejoin(self: &Arc<Self>) {
        let is_served = {
            let mut state = locked(&self.state);

            if !state.is_full
                || u64::try_from(state.held.len()).unwrap_or(u64::MAX) >= self.maximum_connections
            {
                return;
            }

            state.is_full = false;

            state.ready == ReadyState::Open
        };

        if is_served && self.participant.is_linked() {
            let joining = self.join();

            self.participant.cover(async move {
                joining.await.ok();
            });
        }
    }

    // one name let go as it stops, counted until its UNSUBACK came; one its broker refused to let
    // go is reported, and its stop settles all the same
    fn leave_one(self: &Arc<Self>, name: String) -> BoxFuture<()> {
        let config = Arc::clone(self.participant.config());
        let leaving = config.adapter.unsubscribe(&config.name_of(&name));
        let server = Arc::clone(self);

        Box::pin(async move {
            if let Err(reason) = leaving.await
                && !matches!(reason, BrokerError::Refused(_))
                && config.is_linked()
                && !config.is_down_as_it_links()
            {
                config.report(&RouterError::Other(Arc::new(reason)));
            }

            locked(&server.state).subscribed.remove(&name);
        })
    }
}

impl ConnectionOwner for ServerInner {
    fn is_opener(&self) -> bool {
        false
    }

    // * the handle drawn at the third leg, by the proven id and the rank it came at, never given
    // twice (spec 15.1, decision 0025)
    fn opened(&self, (pair, peer): (Pair, &Peer)) -> Option<ConnectionHandle> {
        let handle: ConnectionHandle = {
            let mut state = locked(&self.state);

            state.arrivals = state.arrivals.saturating_add(1);

            let arrival = state.arrivals;
            let handle: ConnectionHandle = Arc::from(format!(
                "type={};participant={};ordinal={arrival}",
                self.participant.config().adapter.transport_type(),
                peer.id
            ));
            let held = state.held.get_mut(&pair)?;

            if let Some(timer) = held.accepting.take() {
                timer.cancel();
            }

            held.handle = Some(Arc::clone(&handle));
            held.arrival = arrival;
            state.handles.insert(Arc::clone(&handle), pair);

            handle
        };

        self.tell((
            |listener: &dyn ServerListener| listener.on_connection(&handle),
            Some(&handle),
        ));

        Some(handle)
    }

    fn delivered(&self, pair: Pair, message: TransportMessage) {
        let now = wall_of(&self.participant.clock());
        let handle = {
            let mut state = locked(&self.state);
            let Some(held) = state.held.get_mut(&pair) else {
                return;
            };

            held.last_activity = Some(now);

            let handle = held.handle.clone();

            drop(state);

            handle
        };
        let Some(handle) = handle else {
            return;
        };

        self.tell((
            |listener: &dyn ServerListener| listener.on_message(message.clone(), &handle),
            Some(&handle),
        ));
    }

    fn ended(&self, (pair, _handle): (Pair, Option<ConnectionHandle>), (is_clean, reported): End) {
        let handle = {
            let mut state = locked(&self.state);
            let Some(mut held) = state.held.remove(&pair) else {
                return;
            };

            if let Some(timer) = held.accepting.take() {
                timer.cancel();
            }

            if let Some(handle) = &held.handle {
                state.handles.remove(handle);
            }

            drop(state);

            held.handle
        };

        // a half-open connection lost is reported with no handle, as its router was never told it
        if let Some(reported) = reported {
            self.report((&reported, handle.as_ref()));
        }

        if let Some(handle) = &handle {
            self.tell((
                |listener: &dyn ServerListener| listener.on_close(is_clean, handle),
                Some(handle),
            ));
        }

        if let Some(me) = self.me.upgrade() {
            me.rejoin();
        }
    }
}

// what it holds of a connection told, its pair and what the gauges count
impl BrokerServer {
    /// A server transport over `participant`, serving its options' names.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for no name, a name that is no token, one another of its participant's
    /// server transports serves, a group its adapter does not offer, a bound under 1, or an accept
    /// timeout spec 1.4 does not hold.
    pub fn new(
        participant: &BrokerParticipant,
        options: &BrokerServerOptions,
    ) -> Result<Self, ProgrammerError> {
        if options.names.is_empty() || options.names.iter().any(|name| !is_token(name)) {
            return Err(ProgrammerError::new(
                "a broker's server transport serves one name at least, each a token of base64url's alphabet, 1 to 64 characters",
            ));
        }

        let is_in_group = options.is_in_group.unwrap_or(false);
        let adapter = participant.adapter();

        if is_in_group && !adapter.capabilities().contains(BrokerCapabilities::GROUPS) {
            return Err(ProgrammerError::new(format!(
                "a name served in a group needs an adapter that offers groups, and the adapter of {} does not",
                participant.id()
            )));
        }

        for (name, bound) in [
            ("maximumConnections", options.maximum_connections),
            (
                "maximumConnectionsPerAddress",
                options.maximum_connections_per_address,
            ),
            ("maximumUnsentBytes", options.maximum_unsent_bytes),
        ] {
            if bound == Some(0) {
                return Err(ProgrammerError::new(format!(
                    "{name} is a whole number above 0, not 0"
                )));
            }
        }

        // ! never without end: a half-open place held for ever is a place taken (spec 15.23)
        let accept_timeout = hold_finite(
            "acceptTimeout",
            options.accept_timeout.unwrap_or(ACCEPT_TIMEOUT),
        )?;
        let mut names: Vec<String> = Vec::new();

        for name in &options.names {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }

        let inner = Arc::new_cyclic(|me| ServerInner {
            me: Weak::clone(me),
            participant: participant.clone(),
            names,
            is_in_group,
            maximum_connections: options.maximum_connections.unwrap_or(MAXIMUM_CONNECTIONS),
            maximum_per_address: options
                .maximum_connections_per_address
                .unwrap_or(MAXIMUM_CONNECTIONS_PER_ADDRESS),
            maximum_unsent: options.maximum_unsent_bytes.unwrap_or(MAXIMUM_UNSENT_BYTES),
            accept_timeout,
            is_secure: options.secure.unwrap_or_else(|| adapter.is_secure()),
            state: Mutex::new(ServerState {
                ready: ReadyState::Uninitialized,
                held: HashMap::new(),
                handles: HashMap::new(),
                subscribed: BTreeSet::new(),
                is_full: false,
                arrivals: 0,
                stopped: None,
            }),
            listeners: Listeners::default(),
        });

        participant.reserve((&inner.names, &inner))?;

        Ok(Self { inner })
    }

    /// The names it serves.
    #[must_use]
    pub fn names(&self) -> &[String] {
        &self.inner.names
    }

    /// Where it stands.
    #[must_use]
    pub fn ready_state(&self) -> ReadyState {
        self.inner.ready()
    }

    /// The connections its router was told of, in the order they came: each its handle, its peer
    /// participant's id as its address, no port, and when it last delivered an envelope.
    #[must_use]
    pub fn clients(&self) -> Vec<(ConnectionHandle, String, Option<u16>, Option<i64>)> {
        let mut told: Vec<_> = locked(&self.inner.state)
            .held
            .values()
            .filter_map(|held| {
                held.handle.as_ref().map(|handle| {
                    (
                        held.arrival,
                        Arc::clone(handle),
                        held.peer_id.clone(),
                        None,
                        held.last_activity,
                    )
                })
            })
            .collect();

        told.sort_by_key(|(arrival, ..)| *arrival);
        told.into_iter()
            .map(|(_, handle, address, port, last_activity)| (handle, address, port, last_activity))
            .collect()
    }
}

impl ServerTransport for BrokerServer {
    // a credential given here is not carried: the router fails a command that presents one its
    // transport cannot carry before it goes (spec 15.22)
    fn send(
        &self,
        message: TransportMessage,
        connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        let held = {
            let state = locked(&self.inner.state);

            state
                .handles
                .get(connection_handle)
                .and_then(|pair| state.held.get(pair).map(|held| (*pair, held.room)))
        };
        let Some((pair, room)) = held else {
            return Ok(Sent::Done);
        };

        // refused before it goes, the connection kept: a parcel toward its client that leaves no
        // byte of the envelope (spec 15.20)
        if !fits((room, None)) {
            return Err(RouterError::Other(Arc::new(ProgrammerError::new(format!(
                "a parcel of {room} bytes leaves no byte of an envelope beside its credential"
            )))));
        }

        let message = TransportMessage {
            data: message.data,
            ..TransportMessage::default()
        };

        self.inner
            .participant
            .post(move |state: &mut ParticipantState| state.send_on(pair, &message));

        Ok(Sent::Done)
    }

    // closed with a CLOSE of 1000, its close told clean; false when it held none by that handle
    fn close(&self, connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        let server = Arc::clone(&self.inner);
        let handle = Arc::clone(connection_handle);
        let closing = self
            .inner
            .participant
            .run(move |state: &mut ParticipantState| {
                let pair = locked(&server.state).handles.get(&handle).copied();

                pair.is_some_and(|pair| {
                    state.close(pair, (crate::broker::parcel::codes::NORMAL, true));

                    true
                })
            });

        Box::pin(async move { closing.await.unwrap_or(false) })
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        self.inner.listeners.add(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        self.inner.listeners.remove(listener);
    }

    fn clock(&self) -> Option<SharedClock> {
        self.inner.participant.config().given.clone()
    }

    // its own leg, and its peer's, as its OPEN said (spec 15.22)
    fn is_secure(&self, connection_handle: &ConnectionHandle) -> bool {
        let state = locked(&self.inner.state);

        self.inner.is_secure
            && state
                .handles
                .get(connection_handle)
                .and_then(|pair| state.held.get(pair))
                .is_some_and(|held| held.is_peer_secure)
    }

    // nothing is carried toward a client (spec 15.22)
    fn carries_credential(&self, _connection_handle: &ConnectionHandle) -> bool {
        false
    }

    // its participant started where it was not, or linked anew where its link was taken over, and
    // its names served, each subscribed; settles once its broker holds each, failing on a name its
    // broker refused
    fn start(&self) -> BoxFuture<Result<(), RouterError>> {
        let refused = {
            let mut state = locked(&self.inner.state);

            if matches!(state.ready, ReadyState::Uninitialized | ReadyState::Closed) {
                state.ready = ReadyState::Connecting;

                None
            } else {
                Some(state.ready)
            }
        };

        if let Some(ready) = refused {
            return Box::pin(async move {
                Err(RouterError::Other(Arc::new(ProgrammerError::new(format!(
                    "the transport server is already {}",
                    ready.said()
                )))))
            });
        }

        let server = Arc::clone(&self.inner);
        let starting = self.inner.participant.start();
        let (reply, started) = tokio::sync::oneshot::channel();

        self.inner.participant.cover(async move {
            let outcome = match starting.await {
                Ok(()) => server.relink().await,
                Err(error) => Err(error),
            };

            locked(&server.state).ready = if outcome.is_ok() {
                ReadyState::Open
            } else {
                ReadyState::Closed
            };
            reply.send(outcome).ok();
        });

        Box::pin(async move {
            started
                .await
                .unwrap_or_else(|_dropped| Err(BrokerError::failed("the participant is gone")))
                .map_err(|error| RouterError::Other(Arc::new(error)))
        })
    }

    // no OPEN taken from now, one that comes refused 503; each connection closed with a CLOSE of
    // 1001, its close told unclean, and its names let go; its participant's link kept (spec 15.21)
    fn stop(&self) -> BoxFuture<()> {
        let (stopping, stopped) = {
            let mut state = locked(&self.inner.state);

            if let Some(stopped) = &state.stopped {
                let mut stopped = stopped.clone();

                return Box::pin(async move {
                    stopped.wait_for(|is_stopped| *is_stopped).await.ok();
                });
            }

            if matches!(
                state.ready,
                ReadyState::Uninitialized | ReadyState::Closed | ReadyState::Connecting
            ) {
                return Box::pin(async {});
            }

            state.ready = ReadyState::Closing;

            let (stopping, stopped) = watch::channel(false);

            state.stopped = Some(stopped.clone());
            drop(state);

            (stopping, stopped)
        };
        let server = Arc::clone(&self.inner);
        let closing = self
            .inner
            .participant
            .run(move |state: &mut ParticipantState| {
                let held: Vec<Pair> = locked(&server.state).held.keys().copied().collect();

                for pair in held {
                    state.close(pair, (crate::broker::parcel::codes::GOING_AWAY, false));
                }

                // * all let go at once, a name counted until its UNSUBACK came: its broker's word
                let names = locked(&server.state).subscribed.clone();

                names
                    .into_iter()
                    .map(|name| server.leave_one(name))
                    .collect::<Vec<_>>()
            });
        let server = Arc::clone(&self.inner);

        self.inner.participant.cover(async move {
            if let Ok(leaving) = closing.await {
                for left in leaving {
                    left.await;
                }
            }

            {
                let mut state = locked(&server.state);

                state.ready = ReadyState::Closed;
                state.stopped = None;
            }

            stopping.send_replace(true);
        });

        let mut stopped = stopped;

        Box::pin(async move {
            stopped.wait_for(|is_stopped| *is_stopped).await.ok();
        })
    }

    fn gauges(&self) -> Option<Gauges> {
        let config = self.inner.participant.config();
        let (pairs, handles, names) = {
            let state = locked(&self.inner.state);

            (
                state.held.keys().copied().collect::<Vec<Pair>>(),
                state
                    .handles
                    .keys()
                    .cloned()
                    .collect::<Vec<ConnectionHandle>>(),
                state.subscribed.len(),
            )
        };
        let counted = config.counted_of(&pairs);
        let half_open = counted
            .iter()
            .filter(|counters| !counters.is_open.load(Ordering::SeqCst))
            .count();
        let mut gauges = Gauges::default();

        gauges.counts.insert(
            "connections",
            u64::try_from(handles.len()).unwrap_or(u64::MAX),
        );
        gauges.counts.insert("departures", config.departures());
        gauges
            .counts
            .insert("halfOpen", u64::try_from(half_open).unwrap_or(u64::MAX));
        gauges.counts.insert(
            "largestPartsBytes",
            counted
                .iter()
                .map(|counters| counters.parts.load(Ordering::SeqCst))
                .max()
                .unwrap_or(0),
        );
        gauges.counts.insert(
            "largestUnsentBytes",
            counted
                .iter()
                .map(|counters| counters.unsent.load(Ordering::SeqCst))
                .max()
                .unwrap_or(0),
        );
        gauges
            .counts
            .insert("names", u64::try_from(names).unwrap_or(u64::MAX));
        gauges
            .counts
            .insert("partsBytes", config.parts_bounds.budget.held());
        gauges.counts.insert(
            "unsentBytes",
            counted
                .iter()
                .map(|counters| counters.unsent.load(Ordering::SeqCst))
                .fold(0_u64, u64::saturating_add),
        );
        gauges
            .ceilings
            .insert("connections", self.inner.maximum_connections);
        gauges
            .ceilings
            .insert("halfOpen", self.inner.maximum_connections);
        gauges.ceilings.insert(
            "largestPartsBytes",
            config.parts_bounds.maximum_envelope_parts_bytes,
        );
        gauges
            .ceilings
            .insert("largestUnsentBytes", self.inner.maximum_unsent);
        gauges
            .ceilings
            .insert("partsBytes", config.parts_bounds.budget.budget());
        gauges.connection_handles.extend(handles);

        Some(gauges)
    }

    fn transport_type(&self) -> Option<&str> {
        Some(self.inner.participant.config().adapter.transport_type())
    }
}
