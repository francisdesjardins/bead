//! Transports a test scripts, as the other sides' scripted ones are.
//!
//! What a router sends on one is recorded and read back as envelopes, what the test delivers
//! reaches the router as its transport's message, and a send is taken, refused as it is handed
//! over, or refused later, as the test says.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;

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

/// How a scripted transport answers a send.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub enum Sending {
    /// Taken, and done.
    #[default]
    Taken,
    /// Refused as it is handed over, saying why.
    Thrown(String),
    /// Taken, then refused, saying why.
    Rejected(String),
}

fn sent_of(sending: &Sending) -> Result<Sent, RouterError> {
    match sending {
        Sending::Taken => Ok(Sent::Done),
        Sending::Thrown(message) => Err(RouterError::Other(Arc::new(std::io::Error::other(
            message.clone(),
        )))),
        Sending::Rejected(message) => {
            let error = RouterError::Other(Arc::new(std::io::Error::other(message.clone())));

            Ok(Sent::Later(Box::pin(async move { Err(error) })))
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
    clock: SharedClock,
    sent: Mutex<Vec<TransportMessage>>,
    listeners: Mutex<Vec<Arc<dyn ClientListener>>>,
    sending: Mutex<Sending>,
    carrying: AtomicBool,
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
        Arc::new(Self {
            clock,
            sent: Mutex::default(),
            listeners: Mutex::default(),
            sending: Mutex::default(),
            carrying: AtomicBool::new(true),
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

    /// Hands its router `envelope`, as its server sent it.
    pub fn deliver(&self, envelope: &Envelope) {
        self.deliver_message(&TransportMessage {
            data: bytes_of(envelope),
            ..TransportMessage::default()
        });
    }

    /// Hands its router `message`.
    pub fn deliver_message(&self, message: &TransportMessage) {
        self.tell(|listener| listener.on_message(message.clone()));
    }

    /// Tells its router its connection closed.
    pub fn close_connection(&self) {
        self.tell(|listener| listener.on_close(false, false));
    }

    /// Tells its router its connection was replaced, as a reconnection starts.
    pub fn replace(&self) {
        self.tell(|listener| listener.on_reconnect());
    }

    /// Each message its router handed it.
    #[must_use]
    pub fn sent(&self) -> Vec<TransportMessage> {
        locked(&self.sent).clone()
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

    fn clock(&self) -> Option<SharedClock> {
        Some(Arc::clone(&self.clock))
    }

    fn is_secure(&self) -> bool {
        true
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
    clock: SharedClock,
    sent: Mutex<Vec<(ConnectionHandle, TransportMessage)>>,
    listeners: Mutex<Vec<Arc<dyn ServerListener>>>,
    sending: Mutex<HashMap<ConnectionHandle, Sending>>,
    one_way: Mutex<BTreeSet<ConnectionHandle>>,
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
        Arc::new(Self {
            clock,
            sent: Mutex::default(),
            listeners: Mutex::default(),
            sending: Mutex::default(),
            one_way: Mutex::default(),
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

    /// Opens the connection `connection_handle`, two-way unless `is_two_way` is false.
    pub fn open(&self, connection_handle: &ConnectionHandle, is_two_way: bool) {
        if !is_two_way {
            locked(&self.one_way).insert(Arc::clone(connection_handle));
        }

        self.tell(|listener| listener.on_connection(connection_handle));
    }

    /// Hands its router `envelope` on `connection_handle`, as its client sent it.
    pub fn deliver(&self, envelope: &Envelope, connection_handle: &ConnectionHandle) {
        let message = TransportMessage {
            data: bytes_of(envelope),
            ..TransportMessage::default()
        };

        self.tell(|listener| listener.on_message(message.clone(), connection_handle));
    }

    /// Hands its router `message` on `connection_handle`.
    pub fn deliver_message(
        &self,
        message: &TransportMessage,
        connection_handle: &ConnectionHandle,
    ) {
        self.tell(|listener| listener.on_message(message.clone(), connection_handle));
    }

    /// Tells its router `connection_handle` closed.
    pub fn close_connection(&self, connection_handle: &ConnectionHandle) {
        self.tell(|listener| listener.on_close(false, connection_handle));
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

    fn clock(&self) -> Option<SharedClock> {
        Some(Arc::clone(&self.clock))
    }

    fn is_two_way(&self, connection_handle: &ConnectionHandle) -> bool {
        !locked(&self.one_way).contains(connection_handle)
    }

    fn start(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> BoxFuture<()> {
        Box::pin(async {})
    }
}
