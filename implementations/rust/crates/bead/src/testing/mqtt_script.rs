//! A scripted MQTT 5 peer on the loopback, which the adapter's tests play a broker with.
//!
//! As the TypeScript side's `mqtt-script` and the C# side's `MqttScript` are: each packet the client
//! sends read as it comes, each answer the test's own, so that nothing a real broker does hides what the
//! adapter sends. Its reader and its writer are its own, never the client's codec, so that a fault
//! of the codec shows rather than hides on both ends.

use core::time::Duration;
use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use rustls::ServerConfig;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, mpsc};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

use crate::testing::{Instant, patience, spawn};

/// How long a wait of a script's lasts unless told: five seconds.
pub const PATIENCE: Duration = Duration::from_secs(5);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A packet's type, as the script names what it reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Kind {
    /// A CONNECT.
    Connect,
    /// A PUBLISH.
    Publish,
    /// A PUBACK.
    Puback,
    /// A SUBSCRIBE.
    Subscribe,
    /// An UNSUBSCRIBE.
    Unsubscribe,
    /// A PINGREQ.
    Pingreq,
    /// A DISCONNECT.
    Disconnect,
    /// Any other, by its fixed header's byte.
    Other(u8),
}

/// A will, as a CONNECT carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ScriptedWill {
    /// Its topic.
    pub topic: String,
    /// Its payload.
    pub payload: Vec<u8>,
    /// Its `QoS`.
    pub qos: u8,
    /// Its RETAIN flag.
    pub retain: bool,
    /// Its Will Delay Interval, where it carries one.
    pub delay: Option<u32>,
}

/// A CONNECT, as the script read it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ScriptedConnect {
    /// Its protocol level: 5.
    pub protocol_level: u8,
    /// Its Clean Start flag.
    pub clean_start: bool,
    /// Its Keep Alive, in seconds.
    pub keep_alive: u16,
    /// Its Client Identifier.
    pub client_identifier: String,
    /// Its User Name.
    pub user_name: Option<String>,
    /// Its Password.
    pub password: Option<Vec<u8>>,
    /// Its will.
    pub will: Option<ScriptedWill>,
    /// Its Session Expiry Interval, where it carries one.
    pub session_expiry_interval: Option<u32>,
    /// Its Receive Maximum.
    pub receive_maximum: Option<u16>,
    /// Its Maximum Packet Size.
    pub maximum_packet_size: Option<u32>,
    /// Its Topic Alias Maximum.
    pub topic_alias_maximum: Option<u16>,
}

/// A PUBLISH, as the script read it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ScriptedPublish {
    /// Its topic.
    pub topic: String,
    /// Its `QoS`.
    pub qos: u8,
    /// Its RETAIN flag.
    pub retain: bool,
    /// Its DUP flag.
    pub dup: bool,
    /// Its Packet Identifier, at `QoS` 1.
    pub identifier: Option<u16>,
    /// Its Message Expiry Interval, where it carries one.
    pub message_expiry_interval: Option<u32>,
    /// The identifier of each property it carries, in its order.
    pub properties: Vec<u8>,
    /// Its payload.
    pub payload: Vec<u8>,
}

/// A packet the client sent, as the script read it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Scripted {
    /// A CONNECT.
    Connect(Box<ScriptedConnect>),
    /// A PUBLISH.
    Publish(ScriptedPublish),
    /// A PUBACK, its identifier and its Reason Code, 0x00 where it is left out.
    Puback {
        /// The PUBLISH it answers.
        identifier: u16,
        /// Its Reason Code.
        reason: u8,
    },
    /// A SUBSCRIBE: its identifier, and each filter with its options' byte.
    Subscribe {
        /// Its Packet Identifier.
        identifier: u16,
        /// Each filter, and its subscription options' byte.
        filters: Vec<(String, u8)>,
    },
    /// An UNSUBSCRIBE: its identifier, and its filters.
    Unsubscribe {
        /// Its Packet Identifier.
        identifier: u16,
        /// Its filters.
        filters: Vec<String>,
    },
    /// A PINGREQ.
    Pingreq,
    /// A DISCONNECT, its Reason Code, 0x00 where it is left out.
    Disconnect {
        /// Its Reason Code.
        reason: u8,
    },
    /// Any other, its fixed header's byte and its body.
    Other {
        /// Its fixed header's byte.
        first: u8,
        /// Its body.
        body: Vec<u8>,
    },
}

impl Scripted {
    /// Its type.
    #[must_use]
    pub const fn kind(&self) -> Kind {
        match self {
            Self::Connect(_) => Kind::Connect,
            Self::Publish(_) => Kind::Publish,
            Self::Puback { .. } => Kind::Puback,
            Self::Subscribe { .. } => Kind::Subscribe,
            Self::Unsubscribe { .. } => Kind::Unsubscribe,
            Self::Pingreq => Kind::Pingreq,
            Self::Disconnect { .. } => Kind::Disconnect,
            Self::Other { first, .. } => Kind::Other(*first),
        }
    }

    /// Its Packet Identifier, where it names one.
    #[must_use]
    pub fn identifier(&self) -> u16 {
        match self {
            Self::Publish(publish) => publish.identifier.unwrap_or_default(),
            Self::Puback { identifier, .. }
            | Self::Subscribe { identifier, .. }
            | Self::Unsubscribe { identifier, .. } => *identifier,
            Self::Connect(_) | Self::Pingreq | Self::Disconnect { .. } | Self::Other { .. } => 0,
        }
    }

    /// Its filters: a SUBSCRIBE's or an UNSUBSCRIBE's, none for any other.
    #[must_use]
    pub fn filters(&self) -> Vec<String> {
        match self {
            Self::Subscribe { filters, .. } => {
                filters.iter().map(|(filter, _)| filter.clone()).collect()
            }
            Self::Unsubscribe { filters, .. } => filters.clone(),
            Self::Connect(_)
            | Self::Publish(_)
            | Self::Puback { .. }
            | Self::Pingreq
            | Self::Disconnect { .. }
            | Self::Other { .. } => Vec::new(),
        }
    }

    /// Its PUBLISH, where it is one.
    #[must_use]
    pub const fn publish(&self) -> Option<&ScriptedPublish> {
        match self {
            Self::Publish(publish) => Some(publish),
            Self::Connect(_)
            | Self::Puback { .. }
            | Self::Subscribe { .. }
            | Self::Unsubscribe { .. }
            | Self::Pingreq
            | Self::Disconnect { .. }
            | Self::Other { .. } => None,
        }
    }
}

// ── Its reader ───────────────────────────────────────────────────────────────────────────────

// a packet's body read from its front
struct Body<'a>(&'a [u8]);

impl<'a> Body<'a> {
    fn take(&mut self, length: usize) -> Option<&'a [u8]> {
        let (taken, rest) = self.0.split_at_checked(length)?;

        self.0 = rest;

        Some(taken)
    }

    fn byte(&mut self) -> Option<u8> {
        self.take(1).and_then(|taken| taken.first().copied())
    }

    fn two(&mut self) -> Option<u16> {
        let taken = self.take(2)?;

        Some(u16::from_be_bytes(taken.try_into().ok()?))
    }

    fn variable(&mut self) -> Option<usize> {
        let mut value = 0_usize;

        for shift in [0_u32, 7, 14, 21] {
            let byte = self.byte()?;

            value |= usize::from(byte & 0x7F).checked_shl(shift)?;

            if byte & 0x80 == 0 {
                return Some(value);
            }
        }

        None
    }

    fn binary(&mut self) -> Option<Vec<u8>> {
        let length = self.two()?;

        self.take(usize::from(length)).map(<[u8]>::to_vec)
    }

    fn text(&mut self) -> Option<String> {
        String::from_utf8(self.binary()?).ok()
    }

    // a property list: each identifier, and its value's bytes, by MQTT 5's types
    fn properties(&mut self) -> Option<Vec<(u8, Vec<u8>)>> {
        let length = self.variable()?;
        let mut inner = Body(self.take(length)?);
        let mut properties = Vec::new();

        while !inner.0.is_empty() {
            let identifier = inner.byte()?;
            let value = match identifier {
                0x01 | 0x17 | 0x19 | 0x24 | 0x25 | 0x28 | 0x29 | 0x2A => inner.take(1)?.to_vec(),
                0x13 | 0x21 | 0x22 | 0x23 => inner.take(2)?.to_vec(),
                0x02 | 0x11 | 0x18 | 0x27 => inner.take(4)?.to_vec(),
                0x0B => {
                    let start = inner.0;
                    let before = start.len();

                    inner.variable()?;

                    start.get(..before.checked_sub(inner.0.len())?)?.to_vec()
                }
                0x26 => {
                    let mut pair = inner.binary()?;

                    pair.extend(inner.binary()?);

                    pair
                }
                _ => inner.binary()?,
            };

            properties.push((identifier, value));
        }

        Some(properties)
    }
}

fn four_of(properties: &[(u8, Vec<u8>)], identifier: u8) -> Option<u32> {
    properties
        .iter()
        .find(|(held, _)| *held == identifier)
        .and_then(|(_, value)| Some(u32::from_be_bytes(value.as_slice().try_into().ok()?)))
}

fn two_of(properties: &[(u8, Vec<u8>)], identifier: u8) -> Option<u16> {
    properties
        .iter()
        .find(|(held, _)| *held == identifier)
        .and_then(|(_, value)| Some(u16::from_be_bytes(value.as_slice().try_into().ok()?)))
}

fn connect_of(body: &mut Body<'_>) -> Option<ScriptedConnect> {
    body.text()?;

    let protocol_level = body.byte()?;
    let flags = body.byte()?;
    let keep_alive = body.two()?;
    let properties = body.properties()?;
    let client_identifier = body.text()?;
    let will = if flags & 0x04 == 0 {
        None
    } else {
        let will_properties = body.properties()?;

        Some(ScriptedWill {
            topic: body.text()?,
            payload: body.binary()?,
            qos: (flags & 0x18).checked_shr(3)?,
            retain: flags & 0x20 != 0,
            delay: four_of(&will_properties, 0x18),
        })
    };
    let user_name = if flags & 0x80 == 0 {
        None
    } else {
        Some(body.text()?)
    };
    let password = if flags & 0x40 == 0 {
        None
    } else {
        Some(body.binary()?)
    };

    Some(ScriptedConnect {
        protocol_level,
        clean_start: flags & 0x02 != 0,
        keep_alive,
        client_identifier,
        user_name,
        password,
        will,
        session_expiry_interval: four_of(&properties, 0x11),
        receive_maximum: two_of(&properties, 0x21),
        maximum_packet_size: four_of(&properties, 0x27),
        topic_alias_maximum: two_of(&properties, 0x22),
    })
}

fn publish_of((first, body): (u8, &mut Body<'_>)) -> Option<ScriptedPublish> {
    let qos = (first & 0x06).checked_shr(1)?;
    let topic = body.text()?;
    let identifier = if qos > 0 { Some(body.two()?) } else { None };
    let properties = body.properties()?;

    Some(ScriptedPublish {
        topic,
        qos,
        retain: first & 0x01 != 0,
        dup: first & 0x08 != 0,
        identifier,
        message_expiry_interval: four_of(&properties, 0x02),
        properties: properties
            .iter()
            .map(|(identifier, _)| *identifier)
            .collect(),
        payload: body.0.to_vec(),
    })
}

// a packet the client sent, read from `first` and its body; one that does not read as its type, its
// bytes as they are
fn scripted_of((first, bytes): (u8, &[u8])) -> Scripted {
    let mut body = Body(bytes);
    let read = match first.checked_shr(4).unwrap_or_default() {
        1 => connect_of(&mut body).map(|connect| Scripted::Connect(Box::new(connect))),
        3 => publish_of((first, &mut body)).map(Scripted::Publish),
        4 => body.two().map(|identifier| Scripted::Puback {
            identifier,
            reason: body.byte().unwrap_or_default(),
        }),
        8 => (|| {
            let identifier = body.two()?;

            body.properties()?;

            let mut filters = Vec::new();

            while !body.0.is_empty() {
                let filter = body.text()?;

                filters.push((filter, body.byte()?));
            }

            Some(Scripted::Subscribe {
                identifier,
                filters,
            })
        })(),
        10 => (|| {
            let identifier = body.two()?;

            body.properties()?;

            let mut filters = Vec::new();

            while !body.0.is_empty() {
                filters.push(body.text()?);
            }

            Some(Scripted::Unsubscribe {
                identifier,
                filters,
            })
        })(),
        12 => Some(Scripted::Pingreq),
        14 => Some(Scripted::Disconnect {
            reason: body.byte().unwrap_or_default(),
        }),
        _ => None,
    };

    read.unwrap_or_else(|| Scripted::Other {
        first,
        body: bytes.to_vec(),
    })
}

// the packets whole at the front of `buffer`, taken from it
fn packets_of(buffer: &mut Vec<u8>) -> Vec<Scripted> {
    let mut packets = Vec::new();

    loop {
        let Some((&first, after)) = buffer.split_first() else {
            return packets;
        };
        let mut head = Body(after);
        let Some(remaining) = head.variable() else {
            return packets;
        };
        let start = after.len().saturating_sub(head.0.len()).saturating_add(1);
        let Some(end) = start.checked_add(remaining) else {
            return packets;
        };
        let Some(body) = buffer.get(start..end) else {
            return packets;
        };

        packets.push(scripted_of((first, body)));
        buffer.drain(..end);
    }
}

// ── Its writer ───────────────────────────────────────────────────────────────────────────────

fn variable_of(value: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut rest = value;

    loop {
        let digit = u8::try_from(rest & 0x7F).unwrap_or_default();

        rest = rest.checked_shr(7).unwrap_or_default();

        if rest == 0 {
            bytes.push(digit);

            return bytes;
        }

        bytes.push(digit | 0x80);
    }
}

fn packet_of(first: u8, body: &[u8]) -> Vec<u8> {
    let mut packet = vec![first];

    packet.extend(variable_of(body.len()));
    packet.extend_from_slice(body);

    packet
}

fn text_of(text: &str) -> Vec<u8> {
    let mut bytes = u16::try_from(text.len())
        .unwrap_or(u16::MAX)
        .to_be_bytes()
        .to_vec();

    bytes.extend_from_slice(text.as_bytes());

    bytes
}

fn properties_of(properties: &[u8]) -> Vec<u8> {
    let mut bytes = variable_of(properties.len());

    bytes.extend_from_slice(properties);

    bytes
}

/// A CONNACK the script answers with: its Reason Code, and the properties it names.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct Connack {
    /// Its Reason Code: 0x00 by default.
    pub reason_code: u8,
    /// Its Receive Maximum.
    pub receive_maximum: Option<u16>,
    /// Its Maximum `QoS`.
    pub maximum_qos: Option<u8>,
    /// Its Maximum Packet Size.
    pub maximum_packet_size: Option<u32>,
    /// Its Shared Subscription Available.
    pub shared_subscription_available: Option<bool>,
    /// Its Server Keep Alive, in seconds.
    pub server_keep_alive: Option<u16>,
}

/// A CONNACK's bytes.
#[must_use]
pub fn connack(connack: &Connack) -> Vec<u8> {
    let mut properties = Vec::new();

    if let Some(maximum) = connack.receive_maximum {
        properties.push(0x21);
        properties.extend_from_slice(&maximum.to_be_bytes());
    }

    if let Some(qos) = connack.maximum_qos {
        properties.extend_from_slice(&[0x24, qos]);
    }

    if let Some(size) = connack.maximum_packet_size {
        properties.push(0x27);
        properties.extend_from_slice(&size.to_be_bytes());
    }

    if let Some(available) = connack.shared_subscription_available {
        properties.extend_from_slice(&[0x2A, u8::from(available)]);
    }

    if let Some(seconds) = connack.server_keep_alive {
        properties.push(0x13);
        properties.extend_from_slice(&seconds.to_be_bytes());
    }

    let mut body = vec![0, connack.reason_code];

    body.extend(properties_of(&properties));

    packet_of(0x20, &body)
}

fn acknowledgement_of(first: u8, (identifier, code): (u16, u8)) -> Vec<u8> {
    let mut body = identifier.to_be_bytes().to_vec();

    body.extend_from_slice(&[0, code]);

    packet_of(first, &body)
}

/// A SUBACK of one Reason Code to the SUBSCRIBE of `identifier`.
#[must_use]
pub fn suback(identifier: u16, code: u8) -> Vec<u8> {
    acknowledgement_of(0x90, (identifier, code))
}

/// An UNSUBACK of one Reason Code to the UNSUBSCRIBE of `identifier`.
#[must_use]
pub fn unsuback(identifier: u16, code: u8) -> Vec<u8> {
    acknowledgement_of(0xB0, (identifier, code))
}

/// A PUBACK of `code` to the PUBLISH of `identifier`, its properties' length written.
#[must_use]
pub fn puback(identifier: u16, code: u8) -> Vec<u8> {
    let mut body = identifier.to_be_bytes().to_vec();

    body.extend_from_slice(&[code, 0]);

    packet_of(0x40, &body)
}

/// A PINGRESP.
#[must_use]
pub fn pingresp() -> Vec<u8> {
    vec![0xD0, 0]
}

/// A DISCONNECT of `code`.
#[must_use]
pub fn disconnect(code: u8) -> Vec<u8> {
    packet_of(0xE0, &[code, 0])
}

/// A PUBLISH the script sends the client.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct Publish {
    /// Its topic.
    pub topic: String,
    /// Its Packet Identifier, at `QoS` 1; `QoS` 0 where none.
    pub identifier: Option<u16>,
    /// Its RETAIN flag.
    pub retain: bool,
    /// Its payload.
    pub payload: Vec<u8>,
}

/// A PUBLISH's bytes.
#[must_use]
pub fn publish(publish: &Publish) -> Vec<u8> {
    let mut first = 0x30;
    let mut body = text_of(&publish.topic);

    if let Some(identifier) = publish.identifier {
        first |= 0x02;
        body.extend_from_slice(&identifier.to_be_bytes());
    }

    if publish.retain {
        first |= 0x01;
    }

    body.push(0);
    body.extend_from_slice(&publish.payload);

    packet_of(first, &body)
}

/// The bytes MQTT 5 writes an UNSUBSCRIBE of `filters` in, one packet of them all.
#[must_use]
pub fn unsubscribe_bytes(identifier: u16, filters: &[String]) -> usize {
    let mut body = identifier.to_be_bytes().to_vec();

    body.push(0);

    for filter in filters {
        body.extend(text_of(filter));
    }

    packet_of(0xA2, &body).len()
}

// ── Its links ────────────────────────────────────────────────────────────────────────────────

// what a link's writer is told
enum Order {
    Write(Vec<u8>),
    End,
}

#[derive(Default)]
struct Heard {
    packets: Vec<Scripted>,
    unread: VecDeque<Scripted>,
    is_closed: bool,
}

/// One network connection to the script: what came on it, and what the test writes back.
pub struct ScriptedLink {
    connect: ScriptedConnect,
    heard: Arc<Mutex<Heard>>,
    notify: Arc<Notify>,
    orders: mpsc::UnboundedSender<Order>,
    // ! let go as it is cut: a handle of its own keeps its socket open
    resetter: Mutex<Option<socket2::Socket>>,
    tasks: Vec<JoinHandle<()>>,
}

impl core::fmt::Debug for ScriptedLink {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("ScriptedLink")
            .field("connect", &self.connect)
            .finish_non_exhaustive()
    }
}

impl ScriptedLink {
    /// Its CONNECT.
    #[must_use]
    pub const fn connect(&self) -> &ScriptedConnect {
        &self.connect
    }

    // the next unread packet of `kind` where given, those before it skipped
    fn unread(&self, kind: Option<Kind>) -> Option<Scripted> {
        let mut heard = locked(&self.heard);
        let index = heard
            .unread
            .iter()
            .position(|packet| kind.is_none_or(|kind| packet.kind() == kind))?;

        heard.unread.drain(..=index).next_back()
    }

    /// Every packet that came, in its order, its CONNECT first.
    #[must_use]
    pub fn packets(&self) -> Vec<Scripted> {
        locked(&self.heard).packets.clone()
    }

    /// The type of every packet that came, in its order.
    #[must_use]
    pub fn kinds(&self) -> Vec<Kind> {
        locked(&self.heard)
            .packets
            .iter()
            .map(Scripted::kind)
            .collect()
    }

    /// Every packet of `kind` that came, in its order.
    #[must_use]
    pub fn of(&self, kind: Kind) -> Vec<Scripted> {
        locked(&self.heard)
            .packets
            .iter()
            .filter(|packet| packet.kind() == kind)
            .cloned()
            .collect()
    }

    /// Whether the adapter's end of it closed.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        locked(&self.heard).is_closed
    }

    /// The next packet that comes, of `kind` where given, skipping others, within `within`.
    ///
    /// # Errors
    ///
    /// Where none came within its time.
    pub async fn next(&self, kind: Option<Kind>, within: Duration) -> Result<Scripted, String> {
        let deadline = Instant::now();

        loop {
            let notified = self.notify.notified();

            if let Some(packet) = self.unread(kind) {
                return Ok(packet);
            }

            let left = within.saturating_sub(deadline.elapsed());

            if left.is_zero() || patience(left, notified).await.is_err() {
                return Err(format!(
                    "no {} came within its time",
                    kind.map_or_else(|| "packet".to_owned(), |kind| format!("{kind:?}"))
                ));
            }
        }
    }

    /// Resolves once the adapter's end closed, within `within`; whether it did.
    pub async fn closed(&self, within: Duration) -> bool {
        let deadline = Instant::now();

        loop {
            let notified = self.notify.notified();

            if self.is_closed() {
                return true;
            }

            let left = within.saturating_sub(deadline.elapsed());

            if left.is_zero() || patience(left, notified).await.is_err() {
                return self.is_closed();
            }
        }
    }

    /// Writes `bytes` as they are.
    pub fn send(&self, bytes: Vec<u8>) {
        self.orders.send(Order::Write(bytes)).ok();
    }

    /// Ends it once what was written went, as a broker that closes a link does.
    pub fn end(&self) {
        self.orders.send(Order::End).ok();
    }

    /// Ends it at once, as a broker that drops a link does: its socket reset.
    pub fn cut(&self) {
        let resetter = locked(&self.resetter).take();

        if let Some(resetter) = resetter {
            resetter.set_linger(Some(Duration::ZERO)).ok();
        }

        for task in &self.tasks {
            task.abort();
        }
    }
}

impl Drop for ScriptedLink {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

// a link's two halves: its reader hearing each packet, its writer following its orders
fn link_of<S: AsyncRead + AsyncWrite + Send + 'static>(
    (socket, resetter): (S, Option<socket2::Socket>),
    links: &Arc<Links>,
) {
    let heard = Arc::new(Mutex::new(Heard::default()));
    let notify = Arc::new(Notify::new());
    let (orders, mut queue) = mpsc::unbounded_channel::<Order>();
    let (mut reading, mut writing) = tokio::io::split(socket);
    let reader_heard = Arc::clone(&heard);
    let reader_notify = Arc::clone(&notify);
    let reader = spawn(async move {
        let mut buffer = Vec::new();
        let mut chunk = vec![0_u8; 65_536];

        loop {
            let read = reading.read(&mut chunk).await.unwrap_or_default();

            if read == 0 {
                locked(&reader_heard).is_closed = true;
                reader_notify.notify_waiters();

                return;
            }

            buffer.extend_from_slice(chunk.get(..read).unwrap_or_default());

            let packets = packets_of(&mut buffer);
            let mut heard = locked(&reader_heard);

            for packet in packets {
                heard.packets.push(packet.clone());
                heard.unread.push_back(packet);
            }

            drop(heard);
            reader_notify.notify_waiters();
        }
    });
    let writer = spawn(async move {
        while let Some(order) = queue.recv().await {
            match order {
                Order::Write(bytes) => {
                    if writing.write_all(&bytes).await.is_err() {
                        return;
                    }
                }
                Order::End => {
                    writing.shutdown().await.ok();

                    return;
                }
            }
        }
    });
    let pending = Pending {
        heard,
        notify,
        orders,
        resetter,
        tasks: vec![reader, writer],
    };

    locked(&links.pending).push(pending);
    links.notify.notify_waiters();
}

// a link accepted, its CONNECT not yet read
struct Pending {
    heard: Arc<Mutex<Heard>>,
    notify: Arc<Notify>,
    orders: mpsc::UnboundedSender<Order>,
    resetter: Option<socket2::Socket>,
    tasks: Vec<JoinHandle<()>>,
}

#[derive(Default)]
struct Links {
    pending: Mutex<Vec<Pending>>,
    notify: Notify,
}

/// How a script listens: over TCP, or under TLS by `tls`.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct MqttScriptOptions {
    /// The TLS it serves under, `mqtts://localhost`: in the clear, `mqtt://127.0.0.1`, when none.
    pub tls: Option<Arc<ServerConfig>>,
}

/// The script: its address, each link as it comes, and what closes it.
pub struct MqttScript {
    url: String,
    links: Arc<Links>,
    accepting: JoinHandle<()>,
}

impl core::fmt::Debug for MqttScript {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("MqttScript")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

fn resetter_of(socket: &TcpStream) -> Option<socket2::Socket> {
    socket2::SockRef::from(socket).try_clone().ok()
}

impl MqttScript {
    /// A scripted MQTT 5 peer on 127.0.0.1, on a port of its own: over TCP, or over TLS under
    /// `options`' config, `mqtts://localhost`.
    ///
    /// # Errors
    ///
    /// Where it cannot listen.
    pub async fn new(options: &MqttScriptOptions) -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let links = Arc::new(Links::default());
        let accepted = Arc::clone(&links);
        let acceptor = options.tls.clone().map(TlsAcceptor::from);
        let accepting = spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let resetter = resetter_of(&socket);

                match &acceptor {
                    None => link_of((socket, resetter), &accepted),
                    Some(acceptor) => {
                        let acceptor = acceptor.clone();
                        let accepted = Arc::clone(&accepted);

                        drop(spawn(async move {
                            if let Ok(secured) = acceptor.accept(socket).await {
                                link_of((secured, resetter), &accepted);
                            }
                        }));
                    }
                }
            }
        });
        let url = match options.tls {
            None => format!("mqtt://127.0.0.1:{port}"),
            Some(_) => format!("mqtts://localhost:{port}"),
        };

        Ok(Self {
            url,
            links,
            accepting,
        })
    }

    /// Where an adapter links to it.
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    /// The next link that comes, its CONNECT read, within `within`.
    ///
    /// # Errors
    ///
    /// Where no link came within its time.
    pub async fn link(&self, within: Duration) -> Result<ScriptedLink, String> {
        let deadline = Instant::now();

        loop {
            let notified = self.links.notify.notified();

            if let Some(link) = self.connected() {
                return Ok(link);
            }

            let left = within.saturating_sub(deadline.elapsed());

            if left.is_zero() {
                return Err("no link came within its time".to_owned());
            }

            // * woken by a link that comes or a packet one of them reads, or a moment later
            let woken = async {
                let mut notified = core::pin::pin!(notified);
                let pause = Duration::from_millis(10).min(left);

                patience(pause, notified.as_mut()).await.ok();
            };

            woken.await;
        }
    }

    // a link pending whose CONNECT came, taken
    fn connected(&self) -> Option<ScriptedLink> {
        let mut pending = locked(&self.links.pending);
        let index = pending.iter().position(|link| {
            locked(&link.heard)
                .unread
                .front()
                .is_some_and(|packet| packet.kind() == Kind::Connect)
        })?;
        let link = pending.remove(index);

        drop(pending);

        let connect = locked(&link.heard).unread.pop_front();

        match connect {
            Some(Scripted::Connect(connect)) => Some(ScriptedLink {
                connect: *connect,
                heard: link.heard,
                notify: link.notify,
                orders: link.orders,
                resetter: Mutex::new(link.resetter),
                tasks: link.tasks,
            }),
            _ => None,
        }
    }

    /// Lets go of every link and stops listening.
    pub fn dispose(&self) {
        self.accepting.abort();
        locked(&self.links.pending).clear();
    }
}

impl Drop for MqttScript {
    fn drop(&mut self) {
        self.dispose();
    }
}
