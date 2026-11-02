//! Transports a test scripts, as the other sides' scripted ones are.
//!
//! What a router sends on one is recorded and read back as envelopes, what the test delivers
//! reaches the router as its transport's message, and a send is taken, refused as it is handed
//! over, or refused later, as the test says. Each keeps its router's pause (spec 15.12, decision
//! 0046): it records each call, and holds what the test delivers while paused, or while it holds
//! anything, handing it on once resumed, in order, from a task of its own its clock counts.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use bytes::Bytes;
use tokio::runtime::Handle;

use crate::clock::SharedClock;
use crate::constants::{EnvelopeKind, RouterSide};
use crate::envelope::{Envelope, ReadEnvelopeOptions, read_envelope, write_envelope};
use crate::router::types::{BoxFuture, ConnectionHandle, RouterError, TransportMessage};
use crate::transport::{
    ClientListener, ClientTransport, ReadyState, Sent, ServerListener, ServerTransport,
};

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// one connection's pause as its router set it, what it holds meanwhile, in order, and whether a
// task of its own hands that on now
#[derive(Debug, Default)]
struct Paced {
    is_paused: bool,
    is_handing: bool,
    held: VecDeque<TransportMessage>,
}

impl Paced {
    // whether what comes waits: paused, handing, or holding anything
    fn holds(&self) -> bool {
        self.is_paused || self.is_handing || !self.held.is_empty()
    }

    // resumed: whether a task of its own is to hand what it holds, marked handing if so
    fn resumed(&mut self) -> bool {
        self.is_paused = false;

        let is_to_hand = !self.is_handing && !self.held.is_empty();

        if is_to_hand {
            self.is_handing = true;
        }

        is_to_hand
    }

    // the next it holds to hand, or none, its hand then over: paused again, or nothing held
    fn next(&mut self) -> Option<TransportMessage> {
        let next = if self.is_paused {
            None
        } else {
            self.held.pop_front()
        };

        if next.is_none() {
            self.is_handing = false;
        }

        next
    }
}

// the runtime a scripted transport hands on from: the one it was built on, or the current one
fn runtime_of(built: Option<&Handle>) -> Option<Handle> {
    built
        .cloned()
        .or_else(|| crate::platform::runtime_of(None, "a scripted transport").ok())
}

/// How a scripted transport answers a send.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub enum Sending {
    /// Taken, and done.
    #[default]
    Taken,
    /// Refused as it is handed over, saying why.
    Thrown(String),
    /// Refused as it is handed over, with this error object.
    Error(RouterError),
    /// Taken, then refused, saying why.
    Rejected(String),
    /// Panicking as it is handed over, saying why: an application's transport that breaks.
    Panicked(String),
    /// Taken, then panicking as its sending is awaited, saying why.
    PanickedLater(String),
    /// Taken, then settled with `outcome` once `released` is cancelled.
    Waiting {
        /// What releases the send's settlement.
        released: tokio_util::sync::CancellationToken,
        /// What the send settles with once released.
        outcome: Result<(), RouterError>,
    },
}

#[expect(
    clippy::panic,
    reason = "a test's transport that breaks, on purpose, as an application's might"
)]
fn sent_of(sending: &Sending) -> Result<Sent, RouterError> {
    match sending {
        Sending::Taken => Ok(Sent::Done),
        Sending::Error(error) => Err(error.clone()),
        Sending::Thrown(message) => Err(RouterError::Other(Arc::new(std::io::Error::other(
            message.clone(),
        )))),
        Sending::Rejected(message) => {
            let error = RouterError::Other(Arc::new(std::io::Error::other(message.clone())));

            Ok(Sent::Later(Box::pin(async move { Err(error) })))
        }
        Sending::Panicked(message) => panic!("{message}"),
        Sending::PanickedLater(message) => {
            let message = message.clone();

            Ok(Sent::Later(Box::pin(async move { panic!("{message}") })))
        }
        Sending::Waiting { released, outcome } => {
            let released = released.clone();
            let outcome = outcome.clone();
            Ok(Sent::Later(Box::pin(async move {
                released.cancelled().await;
                outcome
            })))
        }
    }
}

/// The bytes of `envelope`, a failure's detail held to its default bound.
///
/// # Panics
///
/// For an envelope its writer refuses.
#[must_use]
#[expect(
    clippy::expect_used,
    reason = "a test's helper: an envelope a test writes is one"
)]
pub fn bytes_of(envelope: &Envelope) -> Bytes {
    write_envelope(envelope, 1_024).expect("an envelope a test writes")
}

/// The envelope `bytes` hold, as a router of `side` reads them.
///
/// # Panics
///
/// For bytes that are no envelope.
#[must_use]
#[expect(
    clippy::expect_used,
    reason = "a test's helper: what a router wrote is an envelope"
)]
pub fn envelope_of(bytes: &Bytes, side: RouterSide) -> Envelope {
    read_envelope(bytes, side, &ReadEnvelopeOptions::default())
        .expect("an envelope a router wrote")
        .expect("an envelope of a kind it reads")
}

/// A client's transport a test scripts: what its router sends, read as a server reads it, and what
/// the test delivers as its server.
pub struct ScriptedClient {
    me: Weak<Self>,
    clock: SharedClock,
    runtime: Option<Handle>,
    sent: Mutex<Vec<TransportMessage>>,
    listeners: Mutex<Vec<Arc<dyn ClientListener>>>,
    sending: Mutex<Sending>,
    carrying: AtomicBool,
    secure: AtomicBool,
    paced: Mutex<Paced>,
    pauses: Mutex<Vec<bool>>,
}

impl core::fmt::Debug for ScriptedClient {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("ScriptedClient")
            .finish_non_exhaustive()
    }
}

impl ScriptedClient {
    /// A transport on `clock`, which takes every send.
    #[must_use]
    pub fn new(clock: SharedClock) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: Weak::clone(me),
            clock,
            runtime: runtime_of(None),
            sent: Mutex::default(),
            listeners: Mutex::default(),
            sending: Mutex::default(),
            carrying: AtomicBool::new(true),
            secure: AtomicBool::new(true),
            paced: Mutex::default(),
            pauses: Mutex::default(),
        })
    }

    fn tell<C: Fn(&dyn ClientListener)>(&self, call: C) {
        let listeners = locked(&self.listeners).clone();

        for listener in listeners {
            call(listener.as_ref());
        }
    }

    /// Answers each send from now on as `sending` says.
    pub fn send_as(&self, sending: Sending) {
        *locked(&self.sending) = sending;
    }

    /// Carries a credential beside an envelope from now on, or none when `carrying` is false.
    pub fn carry(&self, carrying: bool) {
        self.carrying.store(carrying, Ordering::SeqCst);
    }

    /// Reports whether this connection protects the credentials it carries.
    pub fn secure(&self, secure: bool) {
        self.secure.store(secure, Ordering::SeqCst);
    }

    /// Hands its router `envelope`, as its server sent it.
    pub fn deliver(&self, envelope: &Envelope) {
        self.deliver_message(&TransportMessage {
            data: bytes_of(envelope),
            ..TransportMessage::default()
        });
    }

    /// Hands its router `message`; or holds it, in order, while its router paused it or it holds
    /// anything.
    pub fn deliver_message(&self, message: &TransportMessage) {
        {
            let mut paced = locked(&self.paced);

            if paced.holds() {
                paced.held.push_back(message.clone());

                return;
            }

            drop(paced);
        }

        self.tell(|listener| listener.on_message(message.clone()));
    }

    /// Tells its router its connection closed, what it held dropped with it.
    pub fn close_connection(&self) {
        locked(&self.paced).held.clear();
        self.tell(|listener| listener.on_close(false, false));
    }

    /// Tells its router its connection was replaced, as a reconnection starts, what it held
    /// dropped with it.
    pub fn replace(&self) {
        locked(&self.paced).held.clear();
        self.tell(|listener| listener.on_reconnect());
    }

    /// Whether its router holds it paused.
    #[must_use]
    pub fn is_paused(&self) -> bool {
        locked(&self.paced).is_paused
    }

    /// How many messages it holds for its router.
    #[must_use]
    pub fn held(&self) -> usize {
        locked(&self.paced).held.len()
    }

    /// Each pause and resume its router asked, in order: true for a pause.
    #[must_use]
    pub fn pauses(&self) -> Vec<bool> {
        locked(&self.pauses).clone()
    }

    // in a task of its own: what it holds handed on, in order, until its router pauses it again
    fn release(&self) {
        loop {
            let Some(message) = locked(&self.paced).next() else {
                return;
            };

            self.tell(|listener| listener.on_message(message.clone()));
        }
    }

    /// Each message its router handed it.
    #[must_use]
    pub fn sent(&self) -> Vec<TransportMessage> {
        locked(&self.sent).clone()
    }

    /// How many listeners hold this transport.
    #[must_use]
    pub fn listener_count(&self) -> usize {
        locked(&self.listeners).len()
    }

    /// Each envelope its router handed it, as a server reads it.
    #[must_use]
    pub fn envelopes(&self) -> Vec<Envelope> {
        self.sent()
            .iter()
            .map(|message| envelope_of(&message.data, RouterSide::Server))
            .collect()
    }

    /// Each envelope's kind and call id.
    #[must_use]
    pub fn calls(&self) -> Vec<(EnvelopeKind, u32)> {
        self.envelopes()
            .iter()
            .map(|envelope| (envelope.kind(), envelope.call_id()))
            .collect()
    }

    /// The end of each credit of a subscription's notifications.
    #[must_use]
    pub fn credits(&self) -> Vec<u64> {
        self.envelopes()
            .iter()
            .filter_map(|envelope| match envelope {
                Envelope::Credit { header } if header.paced => Some(header.credit_end),
                Envelope::Request { .. }
                | Envelope::Result { .. }
                | Envelope::Failure { .. }
                | Envelope::Notification { .. }
                | Envelope::Chunk { .. }
                | Envelope::Credit { .. }
                | Envelope::Cancel { .. } => None,
            })
            .collect()
    }
}

impl ClientTransport for ScriptedClient {
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError> {
        let sending = locked(&self.sending).clone();

        // handed over, whatever it then says
        locked(&self.sent).push(message);

        sent_of(&sending)
    }

    fn listen(&self, listener: Arc<dyn ClientListener>) {
        locked(&self.listeners).push(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ClientListener>) {
        locked(&self.listeners).retain(|held| !Arc::ptr_eq(held, listener));
    }

    // ! its own locks alone, which it never holds as it tells a listener
    fn pause(&self) {
        locked(&self.pauses).push(true);
        locked(&self.paced).is_paused = true;
    }

    // ! as `pause`: what it holds handed on by a task of its own, never within this call
    fn resume(&self) {
        locked(&self.pauses).push(false);

        let is_to_hand = locked(&self.paced).resumed();

        if is_to_hand
            && let Some(me) = self.me.upgrade()
            && let Some(runtime) = runtime_of(self.runtime.as_ref())
        {
            crate::owner::spawn_counted((&runtime, &self.clock), async move {
                me.release();
            });
        }
    }

    fn clock(&self) -> Option<SharedClock> {
        Some(Arc::clone(&self.clock))
    }

    fn is_secure(&self) -> bool {
        self.secure.load(Ordering::SeqCst)
    }

    fn carries(&self, _credential: &str) -> bool {
        self.carrying.load(Ordering::SeqCst)
    }

    fn ready_state(&self) -> ReadyState {
        ReadyState::Open
    }
}

/// A server's transport a test scripts: the connections it opens, what its router sends on each,
/// read as a client reads it, and what the test delivers on each as its client.
pub struct ScriptedServer {
    me: Weak<Self>,
    clock: SharedClock,
    runtime: Option<Handle>,
    sent: Mutex<Vec<(ConnectionHandle, TransportMessage)>>,
    listeners: Mutex<Vec<Arc<dyn ServerListener>>>,
    sending: Mutex<HashMap<ConnectionHandle, Sending>>,
    one_way: Mutex<BTreeSet<ConnectionHandle>>,
    secure: Mutex<BTreeSet<ConnectionHandle>>,
    carrying: Mutex<BTreeSet<ConnectionHandle>>,
    paced: Mutex<HashMap<ConnectionHandle, Paced>>,
    pauses: Mutex<Vec<(bool, ConnectionHandle)>>,
    is_pacing_broken: AtomicBool,
}

impl core::fmt::Debug for ScriptedServer {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("ScriptedServer")
            .finish_non_exhaustive()
    }
}

/// The handle of the scripted connection `ordinal`, from `127.0.0.1` and a port of its own.
#[must_use]
pub fn handle_of(ordinal: u16) -> ConnectionHandle {
    Arc::from(format!(
        "type=WS;ip=127.0.0.1;port={};ordinal=1",
        50_000_u16.saturating_add(ordinal)
    ))
}

impl ScriptedServer {
    /// A transport on `clock`, which takes every send.
    #[must_use]
    pub fn new(clock: SharedClock) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: Weak::clone(me),
            clock,
            runtime: runtime_of(None),
            sent: Mutex::default(),
            listeners: Mutex::default(),
            sending: Mutex::default(),
            one_way: Mutex::default(),
            secure: Mutex::default(),
            carrying: Mutex::default(),
            paced: Mutex::default(),
            pauses: Mutex::default(),
            is_pacing_broken: AtomicBool::new(false),
        })
    }

    fn tell<C: Fn(&dyn ServerListener)>(&self, call: C) {
        let listeners = locked(&self.listeners).clone();

        for listener in listeners {
            call(listener.as_ref());
        }
    }

    /// Answers each send on `connection_handle` from now on as `sending` says.
    pub fn send_as(&self, (connection_handle, sending): (&ConnectionHandle, Sending)) {
        locked(&self.sending).insert(Arc::clone(connection_handle), sending);
    }

    /// Marks `connection_handle` secure, or in the clear when `secure` is false.
    pub fn secure(&self, connection_handle: &ConnectionHandle, secure: bool) {
        let mut handles = locked(&self.secure);
        if secure {
            handles.insert(Arc::clone(connection_handle));
        } else {
            handles.remove(connection_handle);
        }
    }

    /// Carries a credential beside an envelope on this connection, or none when false.
    pub fn carry(&self, connection_handle: &ConnectionHandle, carrying: bool) {
        let mut handles = locked(&self.carrying);
        if carrying {
            handles.insert(Arc::clone(connection_handle));
        } else {
            handles.remove(connection_handle);
        }
    }

    /// Each message its router handed it, with its connection.
    #[must_use]
    pub fn sent(&self) -> Vec<(ConnectionHandle, TransportMessage)> {
        locked(&self.sent).clone()
    }

    /// How many listeners hold this transport.
    #[must_use]
    pub fn listener_count(&self) -> usize {
        locked(&self.listeners).len()
    }

    /// Opens the connection `connection_handle`, two-way unless `is_two_way` is false.
    pub fn open(&self, connection_handle: &ConnectionHandle, is_two_way: bool) {
        if !is_two_way {
            locked(&self.one_way).insert(Arc::clone(connection_handle));
        }

        self.tell(|listener| listener.on_connection(connection_handle));
    }

    /// Hands its router `envelope` on `connection_handle`, as its client sent it; or holds it, as
    /// [`ScriptedServer::deliver_message`] does.
    pub fn deliver(&self, envelope: &Envelope, connection_handle: &ConnectionHandle) {
        self.deliver_message(
            &TransportMessage {
                data: bytes_of(envelope),
                ..TransportMessage::default()
            },
            connection_handle,
        );
    }

    /// Hands its router `message` on `connection_handle`; or holds it, in order, while its router
    /// paused that connection or it holds anything of it.
    pub fn deliver_message(
        &self,
        message: &TransportMessage,
        connection_handle: &ConnectionHandle,
    ) {
        {
            let mut paced = locked(&self.paced);

            if let Some(held) = paced.get_mut(connection_handle).filter(|held| held.holds()) {
                held.held.push_back(message.clone());

                return;
            }
        }

        self.tell(|listener| listener.on_message(message.clone(), connection_handle));
    }

    /// Tells its router `connection_handle` closed, what it held of it dropped with it.
    pub fn close_connection(&self, connection_handle: &ConnectionHandle) {
        locked(&self.paced).remove(connection_handle);
        self.tell(|listener| listener.on_close(false, connection_handle));
    }

    /// Whether each pause and resume its router asks panics, once it is done: an application's
    /// transport that breaks.
    pub fn set_pacing_broken(&self, is_broken: bool) {
        self.is_pacing_broken.store(is_broken, Ordering::SeqCst);
    }

    /// Whether its router holds `connection_handle` paused.
    #[must_use]
    pub fn is_paused(&self, connection_handle: &ConnectionHandle) -> bool {
        locked(&self.paced)
            .get(connection_handle)
            .is_some_and(|held| held.is_paused)
    }

    /// How many messages it holds of `connection_handle` for its router.
    #[must_use]
    pub fn held(&self, connection_handle: &ConnectionHandle) -> usize {
        locked(&self.paced)
            .get(connection_handle)
            .map_or(0, |held| held.held.len())
    }

    /// Each pause and resume its router asked, in order, with its connection: true for a pause.
    #[must_use]
    pub fn pauses(&self) -> Vec<(bool, ConnectionHandle)> {
        locked(&self.pauses).clone()
    }

    // in a task of its own: what it holds of a connection handed on, in order, until its router
    // pauses it again
    fn release(&self, connection_handle: &ConnectionHandle) {
        loop {
            let next = locked(&self.paced)
                .get_mut(connection_handle)
                .and_then(Paced::next);
            let Some(message) = next else {
                return;
            };

            self.tell(|listener| listener.on_message(message.clone(), connection_handle));
        }
    }

    /// Each envelope its router sent on `connection_handle`, as a client reads it.
    #[must_use]
    pub fn envelopes(&self, connection_handle: &ConnectionHandle) -> Vec<Envelope> {
        locked(&self.sent)
            .iter()
            .filter(|(handle, _)| handle == connection_handle)
            .map(|(_, message)| envelope_of(&message.data, RouterSide::Client))
            .collect()
    }

    /// Each envelope its router sent since the last take, on each connection, in the order sent,
    /// as a client reads it.
    pub fn take(&self) -> Vec<(ConnectionHandle, Envelope)> {
        core::mem::take(&mut *locked(&self.sent))
            .into_iter()
            .map(|(handle, message)| (handle, envelope_of(&message.data, RouterSide::Client)))
            .collect()
    }

    /// Each envelope's kind and call id, on `connection_handle`.
    #[must_use]
    pub fn calls(&self, connection_handle: &ConnectionHandle) -> Vec<(EnvelopeKind, u32)> {
        self.envelopes(connection_handle)
            .iter()
            .map(|envelope| (envelope.kind(), envelope.call_id()))
            .collect()
    }
}

impl ServerTransport for ScriptedServer {
    fn send(
        &self,
        message: TransportMessage,
        connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        let sending = locked(&self.sending)
            .get(connection_handle)
            .cloned()
            .unwrap_or_default();

        // handed over, whatever it then says
        locked(&self.sent).push((Arc::clone(connection_handle), message));

        sent_of(&sending)
    }

    fn close(&self, _connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        Box::pin(async { false })
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        locked(&self.listeners).push(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        locked(&self.listeners).retain(|held| !Arc::ptr_eq(held, listener));
    }

    // ! its own locks alone, which it never holds as it tells a listener
    fn pause(&self, connection_handle: &ConnectionHandle) {
        locked(&self.pauses).push((true, Arc::clone(connection_handle)));
        locked(&self.paced)
            .entry(Arc::clone(connection_handle))
            .or_default()
            .is_paused = true;

        // a transport that breaks, on purpose, as an application's might
        assert!(!self.is_pacing_broken.load(Ordering::SeqCst), "no pause");
    }

    // ! as `pause`: what it holds handed on by a task of its own, never within this call
    fn resume(&self, connection_handle: &ConnectionHandle) {
        locked(&self.pauses).push((false, Arc::clone(connection_handle)));

        let is_to_hand = locked(&self.paced)
            .get_mut(connection_handle)
            .is_some_and(Paced::resumed);

        if is_to_hand
            && let Some(me) = self.me.upgrade()
            && let Some(runtime) = runtime_of(self.runtime.as_ref())
        {
            let handle = Arc::clone(connection_handle);

            crate::owner::spawn_counted((&runtime, &self.clock), async move {
                me.release(&handle);
            });
        }

        // a transport that breaks, on purpose, as an application's might
        assert!(!self.is_pacing_broken.load(Ordering::SeqCst), "no resume");
    }

    fn clock(&self) -> Option<SharedClock> {
        Some(Arc::clone(&self.clock))
    }

    fn is_two_way(&self, connection_handle: &ConnectionHandle) -> bool {
        !locked(&self.one_way).contains(connection_handle)
    }

    fn is_secure(&self, connection_handle: &ConnectionHandle) -> bool {
        locked(&self.secure).contains(connection_handle)
    }

    fn carries_credential(&self, connection_handle: &ConnectionHandle) -> bool {
        locked(&self.carrying).contains(connection_handle)
    }

    fn start(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }
}
