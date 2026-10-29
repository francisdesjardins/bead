//! A client's transport over a broker's participant (spec 15.18 to 15.22): one connection at a
//! time, opened by an OPEN to a server's name, its sequence 1, naming its half, its participant's
//! id, incarnation and receive bound; it takes the first ACCEPT naming its half, its connection then
//! named by both halves, and sends at once a PING of sequence 2 naming them, the third leg; its
//! participant resets any other ACCEPT naming its half, of a second acceptor or once its connect
//! ended. It carries the credential a request presents beside it, any field value, on the first
//! part of its DATA, and takes none from its server, closing with 1002 a connection whose server's
//! DATA carries one (spec 15.22). It is secure while its own leg and its server's are, as its ACCEPT
//! said.

use core::fmt;
use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::broker::adapter::BrokerPublished;
use crate::broker::parcel::{Parcel, flags, is_token, kinds, write_parcel};
use crate::broker::participant::{
    BrokerParticipant, BrokerRefusedError, ConnectionOwner, End, Pair, ParticipantState, Peer,
    PendingConnect, Setup,
};
use crate::broker::sequence::fits;
use crate::clock::{Schedule, SharedClock, Timer};
use crate::duration::{NEVER, hold};
use crate::errors::{ConnectError, ProgrammerError, ReadyStateError, TransportError};
use crate::router::types::{BoxFuture, ConnectionHandle, RouterError, TransportMessage};
use crate::transport::{
    CONNECT_TIMEOUT, ClientListener, ClientTransport, Connect, DisconnectOptions, Listeners,
    RECONNECTION_CANCELLED, ReadyState, ReconnectOptions, Sent, attempting, first_of,
    is_field_value,
};

/// What may wait on a connection for its broker, by default: a WebSocket's own bound, since a
/// broker carries the same router's envelopes (spec 15.12).
pub const MAXIMUM_UNSENT_BYTES: u64 = 184_551_424;

const DISPOSED: &str = "the transport client was disposed as it connected";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How a broker's client transport is built.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct BrokerClientOptions {
    /// What may wait for its broker on its connection (spec 15.23), past which the connection is
    /// lost, a CLOSE of 4000: [`MAXIMUM_UNSENT_BYTES`] when none.
    pub maximum_unsent_bytes: Option<u64>,
}

/// Where a broker's client connects — a server's name — and how long it waits.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct BrokerConnectOptions {
    /// The server's name its OPEN goes to, a token (spec 15.16).
    pub server: String,
    /// What cancels it.
    pub signal: Option<CancellationToken>,
    /// How long the connect may take, a link down waited for among it (spec 15.15):
    /// [`CONNECT_TIMEOUT`] when none, or [`NEVER`].
    pub timeout: Option<Duration>,
}

impl BrokerConnectOptions {
    /// A connect through the name `server`, within [`CONNECT_TIMEOUT`].
    #[must_use]
    pub fn of<S: Into<String>>(server: S) -> Self {
        Self {
            server: server.into(),
            signal: None,
            timeout: None,
        }
    }
}

// the connection a connect's ACCEPT opened
#[derive(Debug, Clone, Copy)]
struct Held {
    pair: Pair,
    is_peer_secure: bool,
    room: u64,
}

// a connect under way, settled once
struct Attempt {
    reply: Mutex<Option<oneshot::Sender<Result<(), TransportError>>>>,
    given_up: CancellationToken,
    timer: Mutex<Option<Arc<dyn Timer>>>,
    opener: Mutex<Option<u64>>,
    pair: Mutex<Option<Pair>>,
}

struct ClientState {
    ready: ReadyState,
    // the open connection, or the one its connect's ACCEPT opened; one this side let go of is none,
    // and its end tells nothing
    held: Option<Held>,
    // what came on it before its connect returned, told once it has, in order
    early: Option<Vec<TransportMessage>>,
    connecting: Option<Arc<Attempt>>,
    // the options of the last connect let through, which a reconnection connects with
    last_connect: Option<BrokerConnectOptions>,
    is_attempting: bool,
}

pub(crate) struct ClientInner {
    participant: BrokerParticipant,
    maximum_unsent: u64,
    state: Mutex<ClientState>,
    listeners: Listeners<dyn ClientListener>,
}

/// A client's transport over a broker's participant, one connection at a time through a server's
/// name.
#[derive(Clone)]
pub struct BrokerClient {
    inner: Arc<ClientInner>,
}

impl fmt::Debug for BrokerClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BrokerClient")
            .field("participant", &self.inner.participant.id())
            .finish_non_exhaustive()
    }
}

impl ClientInner {
    fn tell<C: Fn(&dyn ClientListener)>(&self, call: C) {
        let listeners = self.listeners.all();

        self.listeners.each((
            |listener: &(dyn ClientListener + 'static)| call(listener),
            |error: RouterError| {
                for heard in &listeners {
                    // ! a listener of errors that panics would loop: its panic is dropped
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        heard.on_error(&error);
                    }))
                    .ok();
                }
            },
        ));
    }

    fn report(&self, error: &RouterError) {
        for listener in self.listeners.all() {
            // ! a listener of errors that panics would loop: its panic is dropped
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener.on_error(error)))
                .ok();
        }
    }

    // the connect settles, once: a failure lets go of what it drew, its half and its connection
    fn settle(self: &Arc<Self>, (attempt, outcome): (&Arc<Attempt>, Result<(), TransportError>)) {
        let Some(reply) = locked(&attempt.reply).take() else {
            return;
        };

        let timer = locked(&attempt.timer).take();

        if let Some(timer) = timer {
            timer.cancel();
        }

        attempt.given_up.cancel();

        if outcome.is_err() {
            {
                let mut state = locked(&self.state);
                let is_current = state
                    .connecting
                    .as_ref()
                    .is_some_and(|held| Arc::ptr_eq(held, attempt));

                if is_current {
                    state.connecting = None;
                    state.early = None;

                    if state.held.as_ref().map(|held| held.pair) == *locked(&attempt.pair) {
                        state.held = None;
                    }

                    if state.ready != ReadyState::Reconnecting {
                        state.ready = ReadyState::Closed;
                    }
                }
            }

            // ! what the connect drew as it ended is let go: a later ACCEPT is reset, one taken is
            let releasing = Arc::clone(attempt);

            self.participant.post(move |state: &mut ParticipantState| {
                let opener = *locked(&releasing.opener);
                let pair = *locked(&releasing.pair);

                if let Some(opener) = opener {
                    state.give_up(opener);
                }

                if let Some(pair) = pair {
                    state.reset(pair);
                }
            });
        }

        reply.send(outcome).ok();
    }

    // in its participant's turn: the first ACCEPT naming its half taken, its connection held and
    // opened, its third leg sent at once
    fn accepted(
        self: &Arc<Self>,
        (attempt, state, accept): (&Arc<Attempt>, &mut ParticipantState, &Parcel),
    ) -> Pair {
        let pair = (accept.opener, accept.acceptor);
        let peer = Peer::of(accept);
        let is_peer_secure = peer.is_secure;
        let owner: Arc<dyn ConnectionOwner> = Arc::<Self>::clone(self);

        state.hold(Setup {
            owner,
            pair,
            peer,
            sent: 1,
            maximum_unsent: self.maximum_unsent,
            is_half_open: false,
        });
        state.open(pair);
        *locked(&attempt.pair) = Some(pair);

        {
            let mut held = locked(&self.state);
            let is_current = held
                .connecting
                .as_ref()
                .is_some_and(|connecting| Arc::ptr_eq(connecting, attempt));

            if is_current {
                held.held = Some(Held {
                    pair,
                    is_peer_secure,
                    room: state.room_of(pair).unwrap_or(0),
                });
                held.early = Some(Vec::new());
            }
        }

        state.ping(pair);

        pair
    }
}

impl ConnectionOwner for ClientInner {
    fn is_opener(&self) -> bool {
        true
    }

    // a client's connection opens at its ACCEPT: it awaits no third leg of its own
    fn opened(&self, _opened: (Pair, &Peer)) -> Option<ConnectionHandle> {
        None
    }

    fn delivered(&self, pair: Pair, message: TransportMessage) {
        let message = TransportMessage {
            address: None,
            port: None,
            ..message
        };
        let is_told = {
            let mut state = locked(&self.state);
            let is_held = state.held.is_some_and(|held| held.pair == pair);
            let is_open = state.ready == ReadyState::Open;

            state
                .early
                .as_mut()
                .filter(|_| is_held)
                .map_or(is_held && is_open, |early| {
                    early.push(message.clone());

                    false
                })
        };

        if is_told {
            self.tell(|listener: &dyn ClientListener| listener.on_message(message.clone()));
        }
    }

    fn ended(&self, (pair, _handle): (Pair, Option<ConnectionHandle>), (is_clean, reported): End) {
        {
            let mut state = locked(&self.state);

            if state.held.is_none_or(|held| held.pair != pair) {
                return;
            }

            state.held = None;

            // * one its connect has not returned yet tells nothing: the connect fails instead
            if state.ready != ReadyState::Open {
                return;
            }

            state.ready = ReadyState::Closed;
            state.early = None;
        }

        if let Some(reported) = reported {
            self.report(&reported);
        }

        self.tell(|listener: &dyn ClientListener| listener.on_close(is_clean, false));
    }
}

// its OPEN, once its link is up, to the server's name, living in its broker the connect's time
// left, none when it is without end (spec 15.18); its connection once the first ACCEPT naming its
// half came, failed as its link goes down before its answer
#[expect(
    clippy::too_many_lines,
    reason = "a connect's legs in their order, its link, its OPEN, its answer and its opening, as the other sides take them"
)]
async fn opening(
    (client, attempt): (Arc<ClientInner>, Arc<Attempt>),
    (server, timeout, started): (String, Duration, Duration),
) {
    let participant = client.participant.clone();

    // * its link up first, within its time (spec 15.15)
    if let Err(error) = participant.linked(Some(attempt.given_up.clone())).await {
        return client.settle((&attempt, Err(error)));
    }

    let (answered, answer) = oneshot::channel();
    let asking = Arc::clone(&client);
    let asked = Arc::clone(&attempt);
    let opened = participant
        .run(move |state: &mut ParticipantState| {
            // ! given up as its link came up: no OPEN goes
            if asked.given_up.is_cancelled() {
                return None;
            }

            let opener = state.draw_half()?;
            let config = Arc::clone(&state.config);
            let accepting = Arc::clone(&asking);
            let accepted = Arc::clone(&asked);

            *locked(&asked.opener) = Some(opener);
            state.await_answer((
                opener,
                PendingConnect {
                    accept: Box::new(move |state: &mut ParticipantState, accept: &Parcel| {
                        accepting.accepted((&accepted, state, accept))
                    }),
                    settled: answered,
                },
            ));

            let mut open = Parcel::of(kinds::OPEN);

            open.flags = Some(if config.adapter.is_secure() {
                flags::SECURE
            } else {
                0
            });
            open.opener = opener;
            open.sequence = 1;
            open.id = Some(config.id.clone());
            open.incarnation = Some(config.incarnation());
            open.bound = Some(config.receive_bound);

            // * its time from its start: its OPEN lives in its broker what is left of it
            let left = (timeout != NEVER).then(|| {
                timeout
                    .saturating_sub(config.clock.monotonic().saturating_sub(started))
                    .max(Duration::from_millis(1))
            });
            let payload = write_parcel(&open).ok()?;

            Some(config.publish((config.name_of(&server), payload, left)))
        })
        .await;
    let Ok(Some(published)) = opened else {
        return client.settle((
            &attempt,
            Err(TransportError::Connect(ConnectError::new(DISPOSED))),
        ));
    };

    // * a broker that says nothing serves the name fails the connect at once (spec 15.18)
    match published.await {
        Ok(BrokerPublished::NoSubscriber) => {
            return client.settle((
                &attempt,
                Err(
                    BrokerRefusedError::new(BrokerRefusedError::NO_SUBSCRIBER, (None, None))
                        .connect_error(),
                ),
            ));
        }
        Err(error) => {
            return client.settle((
                &attempt,
                Err(TransportError::Connect(ConnectError::new(
                    error.to_string(),
                ))),
            ));
        }
        Ok(_) => {}
    }

    let pair = match answer.await {
        Ok(Ok(pair)) => pair,
        Ok(Err(error)) => return client.settle((&attempt, Err(error))),
        Err(_dropped) => {
            return client.settle((
                &attempt,
                Err(TransportError::Connect(ConnectError::new(DISPOSED))),
            ));
        }
    };
    let opening = Arc::clone(&client);
    let current = Arc::clone(&attempt);
    // ! settled in a turn of its participant's, after every parcel taken before it: a CLOSE that
    // came with its ACCEPT is the connection's end as it opened
    let outcome = participant
        .run_behind(move |state: &mut ParticipantState| {
            let is_open = state.is_open(pair);
            let early = {
                let mut held = locked(&opening.state);
                let is_current = held
                    .connecting
                    .as_ref()
                    .is_some_and(|connecting| Arc::ptr_eq(connecting, &current));

                if !is_current || !is_open {
                    return (false, is_open);
                }

                held.connecting = None;
                held.ready = ReadyState::Open;
                held.early.take().unwrap_or_default()
            };

            // * after what came before its connect returned, in order, then each as it comes
            for message in early {
                opening.delivered(pair, message);
            }

            (true, is_open)
        })
        .await;

    match outcome {
        Ok((true, _)) => client.settle((&attempt, Ok(()))),
        Ok((false, false)) => client.settle((
            &attempt,
            Err(TransportError::Connect(ConnectError::new(
                "the server closed the connection as it opened",
            ))),
        )),
        Ok((false, true)) | Err(_) => client.settle((
            &attempt,
            Err(TransportError::Connect(ConnectError::new(DISPOSED))),
        )),
    }
}

impl BrokerClient {
    /// A client transport over `participant`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a bound under 1.
    pub fn new(
        participant: &BrokerParticipant,
        options: &BrokerClientOptions,
    ) -> Result<Self, ProgrammerError> {
        if options.maximum_unsent_bytes == Some(0) {
            return Err(ProgrammerError::new(
                "maximumUnsentBytes is a whole number above 0, not 0",
            ));
        }

        Ok(Self {
            inner: Arc::new(ClientInner {
                participant: participant.clone(),
                maximum_unsent: options.maximum_unsent_bytes.unwrap_or(MAXIMUM_UNSENT_BYTES),
                state: Mutex::new(ClientState {
                    ready: ReadyState::Uninitialized,
                    held: None,
                    early: None,
                    connecting: None,
                    last_connect: None,
                    is_attempting: false,
                }),
                listeners: Listeners::default(),
            }),
        })
    }

    /// Connects through a server's name, started as it is called: open once the first ACCEPT naming
    /// its half came, its third leg sent. It fails naming the REFUSE it read, or `no-subscriber`
    /// when its broker says nothing serves the name, or a dispose that gave up on it; past its
    /// timeout; once its signal is cancelled; each ending closed.
    pub fn connect(&self, options: BrokerConnectOptions) -> Connect {
        match self.start_connect(options) {
            Ok(outcome) => Connect::of(outcome),
            Err(error) => Connect::refused(error),
        }
    }

    fn start_connect(
        &self,
        options: BrokerConnectOptions,
    ) -> Result<oneshot::Receiver<Result<(), TransportError>>, TransportError> {
        let inner = &self.inner;

        if !is_token(&options.server) {
            return Err(TransportError::Refused(ProgrammerError::new(format!(
                "a server's name is a token of base64url's alphabet, 1 to 64 characters, not \"{}\"",
                options.server
            ))));
        }

        // held here, before anything moves or is kept for a reconnection
        let timeout = hold(
            "a connect's timeout",
            options.timeout.unwrap_or(CONNECT_TIMEOUT),
        )?;
        let (attempt, reply) = {
            let mut state = locked(&inner.state);
            let is_refused = if state.is_attempting {
                state.ready != ReadyState::Reconnecting
            } else {
                !matches!(state.ready, ReadyState::Uninitialized | ReadyState::Closed)
            };

            if is_refused {
                return Err(TransportError::Refused(ProgrammerError::new(format!(
                    "the transport client is already {}",
                    state.ready.said()
                ))));
            }

            // without its signal: a reconnection brings its own
            state.last_connect = Some(BrokerConnectOptions {
                signal: None,
                ..options.clone()
            });

            if options
                .signal
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
            {
                return Err(TransportError::Cancelled(
                    "the connect was cancelled".to_owned(),
                ));
            }

            if !state.is_attempting {
                state.ready = ReadyState::Connecting;
            }

            let (reply, outcome) = oneshot::channel();
            let attempt = Arc::new(Attempt {
                reply: Mutex::new(Some(reply)),
                given_up: CancellationToken::new(),
                timer: Mutex::new(None),
                opener: Mutex::new(None),
                pair: Mutex::new(None),
            });

            state.connecting = Some(Arc::clone(&attempt));
            drop(state);

            (attempt, outcome)
        };
        let clock: SharedClock = inner.participant.clock();
        let started = clock.monotonic();

        // its timeout, on its participant's clock, armed as it is made; none for never
        if timeout != NEVER {
            let client = Arc::downgrade(inner);
            let timing = Arc::clone(&attempt);
            let timer = clock.arm(
                Schedule::Once(timeout),
                Box::new(move || {
                    if let Some(client) = client.upgrade() {
                        client.settle((&timing, Err(TransportError::TimedOut(timeout))));
                    }
                }),
            );

            *locked(&attempt.timer) = Some(timer);
        }

        // its signal: cancelled, the connect gives up
        if let Some(signal) = options.signal {
            let client = Arc::downgrade(inner);
            let cancelled = Arc::clone(&attempt);

            inner.participant.cover(async move {
                let is_cancelled =
                    first_of((signal.cancelled(), cancelled.given_up.cancelled())).await;

                if is_cancelled && let Some(client) = client.upgrade() {
                    client.settle((
                        &cancelled,
                        Err(TransportError::Cancelled(
                            "the connect was cancelled".to_owned(),
                        )),
                    ));
                }
            });
        }

        inner.participant.cover(opening(
            (Arc::clone(inner), attempt),
            (options.server, timeout, started),
        ));

        Ok(reply)
    }

    /// Closes the connection with a CLOSE of 1000, or by a RESET, at once, where its options say it
    /// is not clean, and tells its close as they say.
    ///
    /// # Errors
    ///
    /// A [`TransportError`] when it is not open.
    pub fn disconnect(&self, options: DisconnectOptions) -> Result<(), TransportError> {
        let inner = &self.inner;
        let is_clean = options.is_clean.unwrap_or(true);
        let is_quick = options.is_quick.unwrap_or(false);
        let held = {
            let mut state = locked(&inner.state);
            let held = state.held.filter(|_| state.ready == ReadyState::Open);

            let Some(held) = held else {
                return Err(TransportError::ReadyState(ReadyStateError::new(
                    state.ready.name(),
                    ReadyState::Open.name(),
                )));
            };

            state.held = None;
            state.ready = ReadyState::Closed;

            held
        };

        inner.participant.post(move |state: &mut ParticipantState| {
            if is_clean {
                state.close(held.pair, (crate::broker::parcel::codes::NORMAL, true));
            } else {
                state.reset(held.pair);
            }
        });
        inner.tell(|listener: &dyn ClientListener| listener.on_close(is_clean, is_quick));

        Ok(())
    }

    /// Lets go of what it holds, telling nothing: a connect under way fails, and a connection held
    /// is reset.
    pub fn dispose(&self) {
        let inner = &self.inner;
        let (connecting, held) = {
            let mut state = locked(&inner.state);
            let held = state.held.take();

            if state.ready == ReadyState::Open {
                state.ready = ReadyState::Closed;
            }

            (state.connecting.clone(), held)
        };

        if let Some(attempt) = connecting {
            inner.settle((
                &attempt,
                Err(TransportError::Connect(ConnectError::new(DISPOSED))),
            ));
        }

        if let Some(held) = held {
            inner
                .participant
                .post(move |state: &mut ParticipantState| state.reset(held.pair));
        }
    }

    /// Closes its connection cleanly when it is open, then lets go of everything.
    pub fn close(&self) {
        if self.ready_state() == ReadyState::Open {
            drop(self.disconnect(DisconnectOptions::default()));
        }

        self.dispose();
    }

    /// Connects again through the name of the last connect let through, a pair drawn anew,
    /// replacing an open connection without a close, started as it is called.
    ///
    /// # Errors
    ///
    /// A [`TransportError`] for a reconnection under way, a client never connected, one connecting
    /// or closing, or a signal cancelled already.
    pub fn reconnect(
        &self,
        options: ReconnectOptions,
    ) -> Result<BoxFuture<Result<(), TransportError>>, TransportError> {
        let inner = &self.inner;
        let (target, replaced) = {
            let mut state = locked(&inner.state);

            if state.ready == ReadyState::Reconnecting {
                return Err(TransportError::Refused(ProgrammerError::new(
                    "the transport client is already reconnecting",
                )));
            }

            let Some(target) = state.last_connect.clone() else {
                return Err(TransportError::Refused(ProgrammerError::new(
                    "the transport client was never connected",
                )));
            };

            if matches!(state.ready, ReadyState::Connecting | ReadyState::Closing) {
                return Err(TransportError::Refused(ProgrammerError::new(format!(
                    "the transport client cannot reconnect while {}",
                    state.ready.said()
                ))));
            }

            if options
                .signal
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
            {
                return Err(TransportError::Cancelled(RECONNECTION_CANCELLED.to_owned()));
            }

            let replaced = state.held.take();

            state.ready = ReadyState::Reconnecting;
            drop(state);

            (target, replaced)
        };

        inner.tell(|listener: &dyn ClientListener| listener.on_reconnect());

        if let Some(replaced) = replaced {
            inner
                .participant
                .post(move |state: &mut ParticipantState| state.reset(replaced.pair));
        }

        let (reply, outcome) = oneshot::channel();
        let client = self.clone();

        inner.participant.cover(async move {
            let reconnected = client.reconnecting((target, options)).await;

            if reconnected.is_err() {
                locked(&client.inner.state).ready = ReadyState::Closed;
            }

            reply.send(reconnected).ok();
        });

        Ok(Box::pin(async move {
            outcome.await.unwrap_or_else(|_dropped| {
                Err(TransportError::Cancelled(RECONNECTION_CANCELLED.to_owned()))
            })
        }))
    }

    async fn reconnecting(
        &self,
        (target, options): (BrokerConnectOptions, ReconnectOptions),
    ) -> Result<(), TransportError> {
        let inner = &self.inner;
        let clock = inner.participant.clock();

        attempting((&clock, &options), |signal| {
            locked(&inner.state).is_attempting = true;

            let connecting = self.connect(BrokerConnectOptions {
                signal,
                ..target.clone()
            });

            locked(&inner.state).is_attempting = false;

            connecting
        })
        .await?;

        if options
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            drop(self.disconnect(DisconnectOptions::default()));

            return Err(TransportError::Cancelled(RECONNECTION_CANCELLED.to_owned()));
        }

        Ok(())
    }

    /// The pair its open connection is named by; none while it holds none.
    #[cfg(test)]
    pub(crate) fn pair(&self) -> Option<Pair> {
        let state = locked(&self.inner.state);

        state
            .held
            .filter(|_| state.ready == ReadyState::Open)
            .map(|held| held.pair)
    }
}

impl ClientTransport for BrokerClient {
    // * copied as it is sent: the sender's buffer stays its own
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError> {
        let held = {
            let state = locked(&self.inner.state);

            match (state.held, state.ready) {
                (Some(held), ReadyState::Open) => held,
                (_, ready) => {
                    return Err(RouterError::Other(Arc::new(ReadyStateError::new(
                        ready.name(),
                        ReadyState::Open.name(),
                    ))));
                }
            }
        };

        // refused before it goes, the connection kept: a field could not carry it as it is
        if let Some(credential) = &message.credential
            && !is_field_value(credential)
        {
            return Err(RouterError::Other(Arc::new(ProgrammerError::new(
                "a credential holds visible ASCII, spaces and tabs alone, none first or last",
            ))));
        }

        let credential = message
            .credential
            .as_ref()
            .filter(|credential| !credential.is_empty())
            .map(String::len);

        // refused before it goes, the connection kept: a parcel toward its server that leaves no
        // byte of the envelope beside its credential (spec 15.20)
        if !fits((held.room, credential)) {
            return Err(RouterError::Other(Arc::new(ProgrammerError::new(format!(
                "a parcel of {} bytes leaves no byte of an envelope beside its credential",
                held.room
            )))));
        }

        self.inner
            .participant
            .post(move |state: &mut ParticipantState| state.send_on(held.pair, &message));

        Ok(Sent::Done)
    }

    fn listen(&self, listener: Arc<dyn ClientListener>) {
        self.inner.listeners.add(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ClientListener>) {
        self.inner.listeners.remove(listener);
    }

    fn clock(&self) -> Option<SharedClock> {
        self.inner.participant.config().given.clone()
    }

    // its own leg, and its server's as its ACCEPT said, read per call (spec 15.22)
    fn is_secure(&self) -> bool {
        let state = locked(&self.inner.state);

        self.inner.participant.config().adapter.is_secure()
            && state.ready == ReadyState::Open
            && state.held.is_some_and(|held| held.is_peer_secure)
    }

    // any credential a field can hold beside an envelope (spec 15.22)
    fn carries(&self, credential: &str) -> bool {
        is_field_value(credential)
    }

    fn ready_state(&self) -> ReadyState {
        locked(&self.inner.state).ready
    }
}
