//! MQTT 5's packets as a client writes and reads them (MQTT 5.0 §2, §3), and the count of a PUBLISH
//! to its every byte (spec 15.30; §2.1.4, §3.3.2), which `spec/vectors.json`'s `mqttPublishBounds`
//! holds every side to with no broker; a topic and a group's shared subscription as MQTT names them
//! (spec 15.25).
//!
//! A client writes CONNECT, PUBLISH, PUBACK, SUBSCRIBE, UNSUBSCRIBE, PINGREQ and DISCONNECT; it reads
//! CONNACK, PUBLISH, PUBACK, SUBACK, UNSUBACK, PINGRESP and DISCONNECT, each property in any order
//! §2.2.2 allows, and refuses AUTH, which no CONNECT of Bead's asks for, and every packet a broker
//! never sends a client. Its reader parses a peer's bytes by checked operations alone, refusing
//! what is malformed or past its bound, and never panics. It judges a PUBACK's, a SUBACK's and an
//! UNSUBACK's Reason Codes by their packet's table, which `mqttAcknowledgementCodes` holds every
//! side to with no broker (spec 15.27 to 15.29): one under 0x80 its table does not name refused as
//! a Protocol Error, one of 0x80 or more read, a refusal whether or not its table names it.

use bytes::Bytes;

#[cfg(test)]
mod tests;

/// The largest Remaining Length a Variable Byte Integer holds (MQTT 5.0 §1.5.5).
pub const LARGEST_REMAINING_LENGTH: u32 = 268_435_455;

/// The largest packet MQTT 5 writes, the bound of a CONNACK that names none: 268,435,460 bytes.
pub const LARGEST_PACKET_SIZE: u32 = 268_435_460;

/// A participant's Maximum Packet Size, its CONNECT's, by default: 16 MiB (spec 15.30).
pub const MAXIMUM_PACKET_SIZE: u32 = 16_777_216;

// a Message Expiry Interval: its identifier and its Four Byte Integer (MQTT 5.0 §3.3.2.3.3)
const EXPIRY_BYTES: u64 = 5;

// the packets' types, the fixed header's high four bits (MQTT 5.0 §2.1.2)
const CONNECT: u8 = 1;
const CONNACK: u8 = 2;
const PUBLISH: u8 = 3;
const PUBACK: u8 = 4;
const SUBSCRIBE: u8 = 8;
const SUBACK: u8 = 9;
const UNSUBSCRIBE: u8 = 10;
const UNSUBACK: u8 = 11;
const PINGREQ: u8 = 12;
const PINGRESP: u8 = 13;
const DISCONNECT: u8 = 14;
const AUTH: u8 = 15;

// the properties' identifiers (MQTT 5.0 §2.2.2.2)
const PAYLOAD_FORMAT_INDICATOR: u8 = 0x01;
const MESSAGE_EXPIRY_INTERVAL: u8 = 0x02;
const CONTENT_TYPE: u8 = 0x03;
const RESPONSE_TOPIC: u8 = 0x08;
const CORRELATION_DATA: u8 = 0x09;
const SUBSCRIPTION_IDENTIFIER: u8 = 0x0B;
const SESSION_EXPIRY_INTERVAL: u8 = 0x11;
const ASSIGNED_CLIENT_IDENTIFIER: u8 = 0x12;
const SERVER_KEEP_ALIVE: u8 = 0x13;
const AUTHENTICATION_METHOD: u8 = 0x15;
const AUTHENTICATION_DATA: u8 = 0x16;
const WILL_DELAY_INTERVAL: u8 = 0x18;
const RESPONSE_INFORMATION: u8 = 0x1A;
const SERVER_REFERENCE: u8 = 0x1C;
const REASON_STRING: u8 = 0x1F;
const RECEIVE_MAXIMUM: u8 = 0x21;
const TOPIC_ALIAS_MAXIMUM: u8 = 0x22;
const TOPIC_ALIAS: u8 = 0x23;
const MAXIMUM_QOS: u8 = 0x24;
const RETAIN_AVAILABLE: u8 = 0x25;
const USER_PROPERTY: u8 = 0x26;
const MAXIMUM_PACKET_SIZE_PROPERTY: u8 = 0x27;
const WILDCARD_SUBSCRIPTION_AVAILABLE: u8 = 0x28;
const SUBSCRIPTION_IDENTIFIERS_AVAILABLE: u8 = 0x29;
const SHARED_SUBSCRIPTION_AVAILABLE: u8 = 0x2A;

// the properties each packet a client reads may carry (MQTT 5.0 §3.2.2.3, §3.3.2.3, §3.4.2.2,
// §3.9.2.1, §3.11.2.1, §3.14.2.2)
const CONNACK_PROPERTIES: [u8; 17] = [
    SESSION_EXPIRY_INTERVAL,
    RECEIVE_MAXIMUM,
    MAXIMUM_QOS,
    RETAIN_AVAILABLE,
    MAXIMUM_PACKET_SIZE_PROPERTY,
    ASSIGNED_CLIENT_IDENTIFIER,
    TOPIC_ALIAS_MAXIMUM,
    REASON_STRING,
    USER_PROPERTY,
    WILDCARD_SUBSCRIPTION_AVAILABLE,
    SUBSCRIPTION_IDENTIFIERS_AVAILABLE,
    SHARED_SUBSCRIPTION_AVAILABLE,
    SERVER_KEEP_ALIVE,
    RESPONSE_INFORMATION,
    SERVER_REFERENCE,
    AUTHENTICATION_METHOD,
    AUTHENTICATION_DATA,
];
const PUBLISH_PROPERTIES: [u8; 8] = [
    PAYLOAD_FORMAT_INDICATOR,
    MESSAGE_EXPIRY_INTERVAL,
    TOPIC_ALIAS,
    RESPONSE_TOPIC,
    CORRELATION_DATA,
    USER_PROPERTY,
    SUBSCRIPTION_IDENTIFIER,
    CONTENT_TYPE,
];
const ACKNOWLEDGEMENT_PROPERTIES: [u8; 2] = [REASON_STRING, USER_PROPERTY];
// ! a Session Expiry Interval among them, which a broker never sends ([MQTT-3.14.2-2]): a
// DISCONNECT is read by its Reason Code whatever it carries, its link ending either way
// ([MQTT-3.14.4-2]), so that one of 0x8E keeps its fence (spec 15.21)
const DISCONNECT_PROPERTIES: [u8; 4] = [
    SESSION_EXPIRY_INTERVAL,
    REASON_STRING,
    USER_PROPERTY,
    SERVER_REFERENCE,
];

/// PUBACK's Reason Codes, its table's (MQTT 5.0 §3.4.2.1).
pub(crate) const PUBACK_CODES: [u8; 9] = [0x00, 0x10, 0x80, 0x83, 0x87, 0x90, 0x91, 0x97, 0x99];

/// SUBACK's Reason Codes, its table's (MQTT 5.0 §3.9.3, Table 3-8).
pub(crate) const SUBACK_CODES: [u8; 12] = [
    0x00, 0x01, 0x02, 0x80, 0x83, 0x87, 0x8F, 0x91, 0x97, 0x9E, 0xA1, 0xA2,
];

/// UNSUBACK's Reason Codes, its table's (MQTT 5.0 §3.11.3, Table 3-9).
pub(crate) const UNSUBACK_CODES: [u8; 7] = [0x00, 0x11, 0x80, 0x83, 0x87, 0x8F, 0x91];

// a subscription's options: QoS 1, No Local 0, Retain As Published 0, Retain Handling 2 (MQTT 5.0
// §3.8.3.1; spec 15.27)
const SUBSCRIPTION_OPTIONS: u8 = 0b0010_0001;

// what a byte of a Variable Byte Integer holds, and the bit that says another follows
const SEVEN_BITS: u8 = 0x7F;
const CONTINUES: u8 = 0x80;

/// What a client reads that refuses it: a packet past the bound it set, or one malformed, or one no
/// client reads (MQTT 5.0 §4.13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MqttRefusal {
    /// A packet whose size, counted from its Remaining Length, passes the bound the reader was
    /// given: its size, and that bound.
    PastMaximum {
        /// Its size, in bytes.
        size: u64,
        /// The bound.
        maximum: u32,
    },
    /// A packet that does not read as MQTT 5 writes one, or that no client reads, saying why.
    Malformed(String),
}

impl core::fmt::Display for MqttRefusal {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::PastMaximum { size, maximum } => write!(
                formatter,
                "a packet of {size} bytes, past its Maximum Packet Size, {maximum} bytes"
            ),
            Self::Malformed(why) => write!(formatter, "a malformed packet: {why}"),
        }
    }
}

impl std::error::Error for MqttRefusal {}

fn malformed<S: Into<String>>(why: S) -> MqttRefusal {
    MqttRefusal::Malformed(why.into())
}

fn short() -> MqttRefusal {
    malformed("it ends before what it holds")
}

/// What an acknowledgement's Reason Code says against its packet's table, the three verdicts of
/// `mqttAcknowledgementCodes` (spec 15.27 to 15.29; MQTT 5.0 §2.4, §4.13).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CodeVerdict {
    /// One its table names: its table's meaning.
    Named,
    /// One of 0x80 or more its table does not name: a refusal all the same (MQTT 5.0 §2.4,
    /// §4.13.2).
    Refusal,
    /// One under 0x80 its table does not name: a Protocol Error, a packet no client reads
    /// ([MQTT-3.4.2-1], [MQTT-3.9.3-2], [MQTT-3.11.3-2]).
    Unreadable,
}

/// `code` judged against `table`, its packet's.
pub(crate) fn verdict_of((table, code): (&[u8], u8)) -> CodeVerdict {
    if table.contains(&code) {
        CodeVerdict::Named
    } else if code >= 0x80 {
        CodeVerdict::Refusal
    } else {
        CodeVerdict::Unreadable
    }
}

// ! judged once the rest of its packet is read: a packet its client cannot read for another
// reason, its flags, a property or its length, is that, whatever its code (spec 15.29)
fn judged((name, table): (&str, &[u8]), codes: &[u8]) -> Result<(), MqttRefusal> {
    let unreadable = codes
        .iter()
        .find(|code| verdict_of((table, **code)) == CodeVerdict::Unreadable);

    unreadable.map_or(Ok(()), |code| {
        Err(malformed(format!(
            "{name} of {}, a Reason Code its table does not name",
            code_of(*code)
        )))
    })
}

/// A CONNACK (MQTT 5.0 §3.2): its link's outcome and what its broker bounds it by.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct MqttConnack {
    /// Whether its broker kept a session of the link's, which a Clean Start never finds.
    pub session_present: bool,
    /// Its Reason Code: 0x00 linked, 0x80 or more refused.
    pub reason_code: u8,
    /// Its Receive Maximum, the quota of its link's PUBLISH packets of `QoS` 1: 65,535 when none.
    pub receive_maximum: Option<u16>,
    /// Its Maximum `QoS`: 1 or 0; none for 2.
    pub maximum_qos: Option<u8>,
    /// Its Maximum Packet Size, the largest packet it takes: none for what MQTT 5 writes at most.
    pub maximum_packet_size: Option<u32>,
    /// Whether it offers shared subscriptions: none for yes.
    pub shared_subscription_available: Option<bool>,
    /// Its Server Keep Alive, the link's Keep Alive in its place, in seconds.
    pub server_keep_alive: Option<u16>,
    /// Its Reason String, what it says of its Reason Code.
    pub reason_string: Option<String>,
}

/// A PUBLISH (MQTT 5.0 §3.3), as a client writes and reads it: of `QoS` 0 or 1, its Message Expiry
/// Interval its one property a client writes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct MqttPublish {
    /// Its Topic Name.
    pub topic: String,
    /// Its Packet Identifier, at `QoS` 1; none at `QoS` 0.
    pub packet_identifier: Option<u16>,
    /// Its RETAIN flag.
    pub retain: bool,
    /// Its DUP flag, at `QoS` 1 alone.
    pub dup: bool,
    /// Its Message Expiry Interval, in seconds.
    pub message_expiry_interval: Option<u32>,
    /// Its payload.
    pub payload: Bytes,
}

/// A PUBACK, a SUBACK or an UNSUBACK (MQTT 5.0 §3.4, §3.9, §3.11): the packet it answers, by its
/// identifier, and its Reason Codes, one for a PUBACK, one per filter for the others.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct MqttAcknowledgement {
    /// The Packet Identifier of the packet it answers.
    pub packet_identifier: u16,
    /// Its Reason Codes.
    pub reason_codes: Vec<u8>,
    /// Its Reason String.
    pub reason_string: Option<String>,
}

impl MqttAcknowledgement {
    /// Its first Reason Code: what it says of the one packet or filter a client asked.
    #[must_use]
    pub fn reason_code(&self) -> u8 {
        self.reason_codes.first().copied().unwrap_or_default()
    }
}

/// A DISCONNECT (MQTT 5.0 §3.14): its Reason Code, and what it says of it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct MqttDisconnect {
    /// Its Reason Code: 0x00 a clean end, 0x8E a session taken over.
    pub reason_code: u8,
    /// Its Reason String.
    pub reason_string: Option<String>,
}

/// A packet a client reads from its broker.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum MqttPacket {
    /// A CONNACK.
    Connack(MqttConnack),
    /// A PUBLISH.
    Publish(MqttPublish),
    /// A PUBACK.
    Puback(MqttAcknowledgement),
    /// A SUBACK.
    Suback(MqttAcknowledgement),
    /// An UNSUBACK.
    Unsuback(MqttAcknowledgement),
    /// A PINGRESP.
    Pingresp,
    /// A DISCONNECT.
    Disconnect(MqttDisconnect),
}

/// What a read of a client's bytes gives: a packet whole, or the want of more bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MqttReading {
    /// A packet whole, and the bytes it took from the front of what was read.
    Packet {
        /// The packet.
        packet: MqttPacket,
        /// The bytes it took.
        length: usize,
    },
    /// No packet whole yet: more bytes are wanted.
    Partial,
}

/// How a PUBLISH is counted: its `QoS`, and whether it carries a Message Expiry Interval.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct MqttPublishShapeOptions {
    /// At `QoS` 0, no Packet Identifier: `false`, `QoS` 1, when none.
    pub is_at_most_once: Option<bool>,
    /// Whether it carries a Message Expiry Interval: `true` when none, so that a bound holds for
    /// every message, a life or none (spec 15.30).
    pub has_life: Option<bool>,
}

// ── Counts and names ─────────────────────────────────────────────────────────────────────────

/// The bytes of a Variable Byte Integer of `value` (MQTT 5.0 §1.5.5).
#[must_use]
pub const fn width_of(value: u64) -> u64 {
    if value < 128 {
        1
    } else if value < 16_384 {
        2
    } else if value < 2_097_152 {
        3
    } else {
        4
    }
}

// R: the topic's length and bytes, the packet identifier at QoS 1, the properties' length and a
// Message Expiry Interval where there is one, then the payload
fn remaining_of((topic_bytes, payload): (u64, u64), options: &MqttPublishShapeOptions) -> u64 {
    let properties = if options.has_life.unwrap_or(true) {
        EXPIRY_BYTES
    } else {
        0
    };
    let identifier = if options.is_at_most_once.unwrap_or(false) {
        0
    } else {
        2
    };

    2_u64
        .saturating_add(topic_bytes)
        .saturating_add(identifier)
        .saturating_add(width_of(properties))
        .saturating_add(properties)
        .saturating_add(payload)
}

/// S, the bytes of a PUBLISH of `payload` bytes to a topic of `topic_bytes` bytes in UTF-8, shaped
/// as `options` says: its fixed header's byte, its Remaining Length's own bytes, and R (spec 15.30).
#[must_use]
pub fn publish_bytes(topic_bytes: u64, payload: u64, options: &MqttPublishShapeOptions) -> u64 {
    let remaining = remaining_of((topic_bytes, payload), options);

    1_u64
        .saturating_add(width_of(remaining))
        .saturating_add(remaining)
}

/// The largest payload of a PUBLISH to `topic` within `maximum` bytes, or none where an empty one
/// does not fit.
///
/// Shaped as `options` says, a life counted unless told otherwise, whatever the message (spec
/// 15.30). Found by a search: S grows with N, and v(R) with it, so no overhead is fixed.
#[must_use]
pub fn largest_payload(
    topic: &str,
    maximum: u64,
    options: &MqttPublishShapeOptions,
) -> Option<u64> {
    let topic_bytes = u64::try_from(topic.len()).unwrap_or(u64::MAX);
    let fits = |payload: u64| {
        publish_bytes(topic_bytes, payload, options) <= maximum
            && remaining_of((topic_bytes, payload), options) <= u64::from(LARGEST_REMAINING_LENGTH)
    };

    if !fits(0) {
        return None;
    }

    let mut low = 0_u64;
    let mut high = u64::from(LARGEST_REMAINING_LENGTH);

    while low < high {
        // the middle rounded up, so that the search ends
        let middle = low.saturating_add(high.saturating_sub(low).div_ceil(2));

        if fits(middle) {
            low = middle;
        } else {
            high = middle.saturating_sub(1);
        }
    }

    Some(low)
}

/// A topic's tokens joined by `/`, as MQTT names it (spec 15.25): `bead/i/ada`.
pub(crate) fn topic_of(topic: &[String]) -> String {
    topic.join("/")
}

/// The shared subscription a name served in a group is (spec 15.25; MQTT 5.0 §4.8.2): its share
/// name the group, then the name's topic, `$share/interop/bead/s/interop`.
pub(crate) fn group_filter_of(group: &str, topic: &[String]) -> String {
    format!("$share/{group}/{}", topic_of(topic))
}

/// A Reason Code as a refusal names it: `0x87`.
pub(crate) fn code_of(code: u8) -> String {
    format!("0x{code:02X}")
}

/// What MQTT 5 calls a Reason Code (MQTT 5.0 §2.4).
pub(crate) const fn reason_name_of(code: u8) -> &'static str {
    match code {
        0x00 => "Success",
        0x01 => "Granted QoS 1",
        0x02 => "Granted QoS 2",
        0x04 => "Disconnect with Will Message",
        0x10 => "No matching subscribers",
        0x11 => "No subscription existed",
        0x18 => "Continue authentication",
        0x19 => "Re-authenticate",
        0x80 => "Unspecified error",
        0x81 => "Malformed Packet",
        0x82 => "Protocol Error",
        0x83 => "Implementation specific error",
        0x84 => "Unsupported Protocol Version",
        0x85 => "Client Identifier not valid",
        0x86 => "Bad User Name or Password",
        0x87 => "Not authorized",
        0x88 => "Server unavailable",
        0x89 => "Server busy",
        0x8A => "Banned",
        0x8B => "Server shutting down",
        0x8C => "Bad authentication method",
        0x8D => "Keep Alive timeout",
        0x8E => "Session taken over",
        0x8F => "Topic Filter invalid",
        0x90 => "Topic Name invalid",
        0x91 => "Packet Identifier in use",
        0x92 => "Packet Identifier not found",
        0x93 => "Receive Maximum exceeded",
        0x94 => "Topic Alias invalid",
        0x95 => "Packet too large",
        0x96 => "Message rate too high",
        0x97 => "Quota exceeded",
        0x98 => "Administrative action",
        0x99 => "Payload format invalid",
        0x9A => "Retain not supported",
        0x9B => "QoS not supported",
        0x9C => "Use another server",
        0x9D => "Server moved",
        0x9E => "Shared Subscriptions not supported",
        0x9F => "Connection rate exceeded",
        0xA0 => "Maximum connect time",
        0xA1 => "Subscription Identifiers not supported",
        0xA2 => "Wildcard Subscriptions not supported",
        _ => "no Reason Code of MQTT 5's",
    }
}

// ── The reader ───────────────────────────────────────────────────────────────────────────────

// a Variable Byte Integer at the front of `bytes`, and the bytes it took; none where it is not
// whole yet: past four bytes, or written in more bytes than its value needs, it is malformed
// (MQTT 5.0 §1.5.5, [MQTT-1.5.5-1])
fn variable_of(bytes: &[u8]) -> Result<Option<(u32, usize)>, MqttRefusal> {
    let mut value = 0_u32;
    let mut multiplier = 1_u32;

    for (index, byte) in bytes.iter().take(4).enumerate() {
        let digit = u32::from(byte & SEVEN_BITS)
            .checked_mul(multiplier)
            .ok_or_else(|| malformed("a Variable Byte Integer past four bytes"))?;

        value = value
            .checked_add(digit)
            .ok_or_else(|| malformed("a Variable Byte Integer past four bytes"))?;

        if byte & CONTINUES == 0 {
            if index > 0 && *byte == 0 {
                return Err(malformed(
                    "a Variable Byte Integer in more bytes than its value needs",
                ));
            }

            return Ok(Some((value, index.saturating_add(1))));
        }

        multiplier = multiplier.saturating_mul(128);
    }

    if bytes.len() >= 4 {
        Err(malformed("a Variable Byte Integer past four bytes"))
    } else {
        Ok(None)
    }
}

// a packet's body, read from its front by checked operations alone
struct Cursor<'a> {
    rest: &'a [u8],
}

impl<'a> Cursor<'a> {
    const fn is_empty(&self) -> bool {
        self.rest.is_empty()
    }

    fn byte(&mut self) -> Result<u8, MqttRefusal> {
        let (first, rest) = self.rest.split_first().ok_or_else(short)?;

        self.rest = rest;

        Ok(*first)
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], MqttRefusal> {
        let (taken, rest) = self.rest.split_at_checked(length).ok_or_else(short)?;

        self.rest = rest;

        Ok(taken)
    }

    fn rest(&mut self) -> &'a [u8] {
        core::mem::take(&mut self.rest)
    }

    fn two(&mut self) -> Result<u16, MqttRefusal> {
        let taken = self.take(2)?;
        let bytes = <[u8; 2]>::try_from(taken).map_err(|_short| short())?;

        Ok(u16::from_be_bytes(bytes))
    }

    fn four(&mut self) -> Result<u32, MqttRefusal> {
        let taken = self.take(4)?;
        let bytes = <[u8; 4]>::try_from(taken).map_err(|_short| short())?;

        Ok(u32::from_be_bytes(bytes))
    }

    fn variable(&mut self) -> Result<u32, MqttRefusal> {
        let (value, width) = variable_of(self.rest)?.ok_or_else(short)?;

        self.take(width)?;

        Ok(value)
    }

    fn binary(&mut self) -> Result<&'a [u8], MqttRefusal> {
        let length = self.two()?;

        self.take(usize::from(length))
    }

    // a UTF-8 Encoded String (MQTT 5.0 §1.5.4): well-formed, and holding no U+0000
    fn text(&mut self) -> Result<&'a str, MqttRefusal> {
        let bytes = self.binary()?;
        let text = core::str::from_utf8(bytes)
            .map_err(|_ill_formed| malformed("a string that is no UTF-8"))?;

        if text.contains('\0') {
            return Err(malformed("a string that holds U+0000"));
        }

        Ok(text)
    }
}

// the properties a client keeps of what it reads
#[derive(Debug, Default)]
struct Properties {
    reason_string: Option<String>,
    receive_maximum: Option<u16>,
    maximum_qos: Option<u8>,
    maximum_packet_size: Option<u32>,
    shared_subscription_available: Option<bool>,
    server_keep_alive: Option<u16>,
    message_expiry_interval: Option<u32>,
    topic_alias: Option<u16>,
}

// a property's value, by its type (MQTT 5.0 §2.2.2.2)
enum Value<'a> {
    Byte(u8),
    Two(u16),
    Four(u32),
    Variable(u32),
    Text,
    Binary,
    Pair,
    Kept(&'a str),
}

// a property's value read by its identifier's type; none for an identifier MQTT 5 has not
fn value_of<'a>(identifier: u8, cursor: &mut Cursor<'a>) -> Result<Value<'a>, MqttRefusal> {
    match identifier {
        PAYLOAD_FORMAT_INDICATOR
        | MAXIMUM_QOS
        | RETAIN_AVAILABLE
        | WILDCARD_SUBSCRIPTION_AVAILABLE
        | SUBSCRIPTION_IDENTIFIERS_AVAILABLE
        | SHARED_SUBSCRIPTION_AVAILABLE => Ok(Value::Byte(cursor.byte()?)),
        SERVER_KEEP_ALIVE | RECEIVE_MAXIMUM | TOPIC_ALIAS_MAXIMUM | TOPIC_ALIAS => {
            Ok(Value::Two(cursor.two()?))
        }
        MESSAGE_EXPIRY_INTERVAL
        | SESSION_EXPIRY_INTERVAL
        | WILL_DELAY_INTERVAL
        | MAXIMUM_PACKET_SIZE_PROPERTY => Ok(Value::Four(cursor.four()?)),
        SUBSCRIPTION_IDENTIFIER => Ok(Value::Variable(cursor.variable()?)),
        REASON_STRING => Ok(Value::Kept(cursor.text()?)),
        CONTENT_TYPE
        | RESPONSE_TOPIC
        | ASSIGNED_CLIENT_IDENTIFIER
        | AUTHENTICATION_METHOD
        | RESPONSE_INFORMATION
        | SERVER_REFERENCE => cursor.text().map(|_text| Value::Text),
        CORRELATION_DATA | AUTHENTICATION_DATA => cursor.binary().map(|_bytes| Value::Binary),
        USER_PROPERTY => {
            cursor.text()?;
            cursor.text()?;

            Ok(Value::Pair)
        }
        _ => Err(malformed(format!(
            "a property of identifier 0x{identifier:02X}, which MQTT 5 has not"
        ))),
    }
}

// a byte that is a boolean, 0 or 1
fn flag_of(byte: u8, name: &str) -> Result<bool, MqttRefusal> {
    match byte {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(malformed(format!("{name} of {byte}, neither 0 nor 1"))),
    }
}

// the properties at `cursor`'s front, each of those `allowed`, in any order, none twice but a User
// Property and a Subscription Identifier (MQTT 5.0 §2.2.2)
fn properties_of(cursor: &mut Cursor<'_>, allowed: &[u8]) -> Result<Properties, MqttRefusal> {
    let length = cursor.variable()?;
    let length = usize::try_from(length).map_err(|_huge| short())?;
    let mut inner = Cursor {
        rest: cursor.take(length)?,
    };
    let mut properties = Properties::default();
    let mut seen = 0_u64;

    while !inner.is_empty() {
        let identifier = inner.variable()?;
        let identifier = u8::try_from(identifier)
            .map_err(|_huge| malformed("a property of an identifier MQTT 5 has not"))?;

        // * its value read first, so that one MQTT 5 has not is refused as such
        let value = value_of(identifier, &mut inner)?;

        if !allowed.contains(&identifier) {
            return Err(malformed(format!(
                "a property of identifier 0x{identifier:02X}, which its packet does not carry"
            )));
        }

        let bit = 1_u64.checked_shl(u32::from(identifier)).unwrap_or_default();

        if seen & bit != 0 && identifier != USER_PROPERTY && identifier != SUBSCRIPTION_IDENTIFIER {
            return Err(malformed(format!(
                "the property of identifier 0x{identifier:02X} twice"
            )));
        }

        seen |= bit;

        match (identifier, value) {
            (REASON_STRING, Value::Kept(reason)) => {
                properties.reason_string = Some(reason.to_owned());
            }
            (RECEIVE_MAXIMUM, Value::Two(maximum)) => {
                if maximum == 0 {
                    return Err(malformed("a Receive Maximum of 0"));
                }

                properties.receive_maximum = Some(maximum);
            }
            (MAXIMUM_QOS, Value::Byte(qos)) => {
                if qos > 1 {
                    return Err(malformed(format!("a Maximum QoS of {qos}")));
                }

                properties.maximum_qos = Some(qos);
            }
            (MAXIMUM_PACKET_SIZE_PROPERTY, Value::Four(size)) => {
                if size == 0 {
                    return Err(malformed("a Maximum Packet Size of 0"));
                }

                properties.maximum_packet_size = Some(size);
            }
            (SHARED_SUBSCRIPTION_AVAILABLE, Value::Byte(byte)) => {
                properties.shared_subscription_available =
                    Some(flag_of(byte, "Shared Subscription Available")?);
            }
            (SERVER_KEEP_ALIVE, Value::Two(seconds)) => {
                properties.server_keep_alive = Some(seconds);
            }
            (MESSAGE_EXPIRY_INTERVAL, Value::Four(seconds)) => {
                properties.message_expiry_interval = Some(seconds);
            }
            (TOPIC_ALIAS, Value::Two(alias)) => {
                properties.topic_alias = Some(alias);
            }
            (PAYLOAD_FORMAT_INDICATOR, Value::Byte(byte)) => {
                flag_of(byte, "a Payload Format Indicator")?;
            }
            (RETAIN_AVAILABLE, Value::Byte(byte)) => {
                flag_of(byte, "Retain Available")?;
            }
            (WILDCARD_SUBSCRIPTION_AVAILABLE, Value::Byte(byte)) => {
                flag_of(byte, "Wildcard Subscription Available")?;
            }
            (SUBSCRIPTION_IDENTIFIERS_AVAILABLE, Value::Byte(byte)) => {
                flag_of(byte, "Subscription Identifiers Available")?;
            }
            (SUBSCRIPTION_IDENTIFIER, Value::Variable(identifier)) => {
                if identifier == 0 {
                    return Err(malformed("a Subscription Identifier of 0"));
                }
            }
            (
                _,
                Value::Byte(_)
                | Value::Two(_)
                | Value::Four(_)
                | Value::Variable(_)
                | Value::Text
                | Value::Binary
                | Value::Pair
                | Value::Kept(_),
            ) => {}
        }
    }

    Ok(properties)
}

// a nonzero Packet Identifier ([MQTT-2.2.1-3])
fn identifier_of(cursor: &mut Cursor<'_>) -> Result<u16, MqttRefusal> {
    match cursor.two()? {
        0 => Err(malformed("a Packet Identifier of 0")),
        identifier => Ok(identifier),
    }
}

fn ended(cursor: &Cursor<'_>) -> Result<(), MqttRefusal> {
    if cursor.is_empty() {
        Ok(())
    } else {
        Err(malformed("bytes past what it holds"))
    }
}

fn connack_of(cursor: &mut Cursor<'_>) -> Result<MqttPacket, MqttRefusal> {
    let flags = cursor.byte()?;

    if flags & 0xFE != 0 {
        return Err(malformed("a CONNACK's reserved flags set"));
    }

    let reason_code = cursor.byte()?;
    let properties = properties_of(cursor, &CONNACK_PROPERTIES)?;

    ended(cursor)?;

    Ok(MqttPacket::Connack(MqttConnack {
        session_present: flags == 1,
        reason_code,
        receive_maximum: properties.receive_maximum,
        maximum_qos: properties.maximum_qos,
        maximum_packet_size: properties.maximum_packet_size,
        shared_subscription_available: properties.shared_subscription_available,
        server_keep_alive: properties.server_keep_alive,
        reason_string: properties.reason_string,
    }))
}

fn publish_of(flags: u8, cursor: &mut Cursor<'_>) -> Result<MqttPacket, MqttRefusal> {
    let retain = flags & 0b0001 != 0;
    let dup = flags & 0b1000 != 0;
    let qos = (flags & 0b0110).checked_shr(1).unwrap_or_default();

    match qos {
        0 if dup => return Err(malformed("a PUBLISH of QoS 0 marked DUP")),
        0 | 1 => {}
        2 => {
            return Err(malformed(
                "a PUBLISH of QoS 2, which no subscription of QoS 1 is handed",
            ));
        }
        _ => return Err(malformed("a PUBLISH of QoS 3")),
    }

    let topic = cursor.text()?;

    if topic.contains(['+', '#']) {
        return Err(malformed("a Topic Name holding a wildcard"));
    }

    let packet_identifier = if qos == 1 {
        Some(identifier_of(cursor)?)
    } else {
        None
    };
    let properties = properties_of(cursor, &PUBLISH_PROPERTIES)?;

    // ! its CONNECT's Topic Alias Maximum is 0: an alias, and so an empty topic, is refused
    if properties.topic_alias.is_some() {
        return Err(malformed(
            "a Topic Alias, past the Topic Alias Maximum of 0 its CONNECT said",
        ));
    }

    if topic.is_empty() {
        return Err(malformed("an empty Topic Name"));
    }

    Ok(MqttPacket::Publish(MqttPublish {
        topic: topic.to_owned(),
        packet_identifier,
        retain,
        dup,
        message_expiry_interval: properties.message_expiry_interval,
        payload: Bytes::copy_from_slice(cursor.rest()),
    }))
}

// a PUBACK: its identifier, then a Reason Code and properties where its Remaining Length holds them
fn puback_of(cursor: &mut Cursor<'_>) -> Result<MqttPacket, MqttRefusal> {
    let packet_identifier = identifier_of(cursor)?;
    let mut acknowledgement = MqttAcknowledgement {
        packet_identifier,
        reason_codes: vec![0],
        reason_string: None,
    };

    if !cursor.is_empty() {
        acknowledgement.reason_codes = vec![cursor.byte()?];

        if !cursor.is_empty() {
            acknowledgement.reason_string =
                properties_of(cursor, &ACKNOWLEDGEMENT_PROPERTIES)?.reason_string;
        }
    }

    ended(cursor)?;
    judged(("a PUBACK", &PUBACK_CODES), &acknowledgement.reason_codes)?;

    Ok(MqttPacket::Puback(acknowledgement))
}

// a SUBACK's or an UNSUBACK's: its identifier, its properties, then a Reason Code per filter, each
// judged by its packet's table; their count is its adapter's to judge, one per filter it asked
fn acknowledgement_of(
    cursor: &mut Cursor<'_>,
    packet: (&str, &[u8]),
) -> Result<MqttAcknowledgement, MqttRefusal> {
    let packet_identifier = identifier_of(cursor)?;
    let reason_string = properties_of(cursor, &ACKNOWLEDGEMENT_PROPERTIES)?.reason_string;
    let reason_codes = cursor.rest().to_vec();

    if reason_codes.is_empty() {
        return Err(malformed("an acknowledgement of no filter"));
    }

    judged(packet, &reason_codes)?;

    Ok(MqttAcknowledgement {
        packet_identifier,
        reason_codes,
        reason_string,
    })
}

fn disconnect_of(cursor: &mut Cursor<'_>) -> Result<MqttPacket, MqttRefusal> {
    let mut disconnect = MqttDisconnect::default();

    if !cursor.is_empty() {
        disconnect.reason_code = cursor.byte()?;

        if !cursor.is_empty() {
            disconnect.reason_string = properties_of(cursor, &DISCONNECT_PROPERTIES)?.reason_string;
        }
    }

    ended(cursor)?;

    Ok(MqttPacket::Disconnect(disconnect))
}

// the type a refusal names a packet a client never reads by
const fn name_of(kind: u8) -> &'static str {
    match kind {
        CONNECT => "a CONNECT",
        5..=7 => "a QoS 2 acknowledgement",
        SUBSCRIBE => "a SUBSCRIBE",
        UNSUBSCRIBE => "an UNSUBSCRIBE",
        PINGREQ => "a PINGREQ",
        _ => "a packet of the reserved type 0",
    }
}

// whether a packet's type is one a client reads, its flags held to what MQTT 5 sets them to
fn kind_of(first: u8) -> Result<(u8, u8), MqttRefusal> {
    let kind = first.checked_shr(4).unwrap_or_default();
    let flags = first & 0x0F;

    match kind {
        PUBLISH => Ok((kind, flags)),
        CONNACK | PUBACK | SUBACK | UNSUBACK | PINGRESP | DISCONNECT if flags == 0 => {
            Ok((kind, flags))
        }
        CONNACK | PUBACK | SUBACK | UNSUBACK | PINGRESP | DISCONNECT => {
            Err(malformed("a packet's reserved flags set"))
        }
        AUTH => Err(malformed(
            "an AUTH, which no CONNECT of Bead's asks for: it names no Authentication Method",
        )),
        _ => Err(malformed(format!(
            "{}, which no broker sends a client",
            name_of(kind)
        ))),
    }
}

/// The packet at the front of `bytes`, as a client reads it from its broker, or the want of more
/// bytes.
///
/// A packet past `maximum_packet_size`, whatever its kind, is refused as soon as its Remaining
/// Length is read, before its body comes (spec 15.29).
///
/// # Errors
///
/// A [`MqttRefusal`] for a packet past its bound, malformed, or one no client reads.
pub fn read_packet(bytes: &[u8], maximum_packet_size: u32) -> Result<MqttReading, MqttRefusal> {
    let Some((first, after)) = bytes.split_first() else {
        return Ok(MqttReading::Partial);
    };
    let Some((remaining, width)) = variable_of(after)? else {
        kind_of(*first)?;

        return Ok(MqttReading::Partial);
    };
    let size = 1_u64
        .saturating_add(u64::try_from(width).unwrap_or(u64::MAX))
        .saturating_add(u64::from(remaining));

    if size > u64::from(maximum_packet_size) {
        return Err(MqttRefusal::PastMaximum {
            size,
            maximum: maximum_packet_size,
        });
    }

    let (kind, flags) = kind_of(*first)?;
    let start = width.saturating_add(1);
    let end = usize::try_from(remaining)
        .ok()
        .and_then(|remaining| start.checked_add(remaining))
        .ok_or_else(short)?;
    let Some(body) = bytes.get(start..end) else {
        return Ok(MqttReading::Partial);
    };
    let mut cursor = Cursor { rest: body };
    let packet = match kind {
        CONNACK => connack_of(&mut cursor)?,
        PUBLISH => publish_of(flags, &mut cursor)?,
        PUBACK => puback_of(&mut cursor)?,
        SUBACK => MqttPacket::Suback(acknowledgement_of(
            &mut cursor,
            ("a SUBACK", &SUBACK_CODES),
        )?),
        UNSUBACK => MqttPacket::Unsuback(acknowledgement_of(
            &mut cursor,
            ("an UNSUBACK", &UNSUBACK_CODES),
        )?),
        PINGRESP => {
            ended(&cursor)?;

            MqttPacket::Pingresp
        }
        _ => disconnect_of(&mut cursor)?,
    };

    Ok(MqttReading::Packet {
        packet,
        length: end,
    })
}

// ── The writer ───────────────────────────────────────────────────────────────────────────────

fn put_variable(out: &mut Vec<u8>, value: u32) {
    let mut rest = value;

    loop {
        let digit = u8::try_from(rest & u32::from(SEVEN_BITS)).unwrap_or_default();

        rest = rest.checked_shr(7).unwrap_or_default();

        if rest == 0 {
            out.push(digit);

            return;
        }

        out.push(digit | CONTINUES);
    }
}

fn put_binary(out: &mut Vec<u8>, (bytes, name): (&[u8], &str)) -> Result<(), MqttRefusal> {
    let length = u16::try_from(bytes.len())
        .map_err(|_long| malformed(format!("{name} past 65,535 bytes")))?;

    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(bytes);

    Ok(())
}

fn put_text(out: &mut Vec<u8>, (text, name): (&str, &str)) -> Result<(), MqttRefusal> {
    if text.contains('\0') {
        return Err(malformed(format!("{name} holding U+0000")));
    }

    put_binary(out, (text.as_bytes(), name))
}

// a packet of `first` and `body`: its fixed header, its Remaining Length, then its body
fn packet_of(first: u8, body: &[u8]) -> Result<Vec<u8>, MqttRefusal> {
    let remaining = u32::try_from(body.len())
        .ok()
        .filter(|remaining| *remaining <= LARGEST_REMAINING_LENGTH)
        .ok_or_else(|| malformed("a packet past what MQTT 5 writes"))?;
    let mut out = Vec::with_capacity(body.len().saturating_add(5));

    out.push(first);
    put_variable(&mut out, remaining);
    out.extend_from_slice(body);

    Ok(out)
}

/// A will: what its broker publishes once it loses the link without a clean end (MQTT 5.0
/// §3.1.3.2), of `QoS` 1, RETAIN 0, a Will Delay Interval of 0.
#[derive(Debug, Clone)]
pub(crate) struct Will {
    pub(crate) topic: String,
    pub(crate) payload: Bytes,
}

/// A CONNECT as Bead writes it (spec 15.26): Clean Start 1, no Session Expiry Interval, a Receive
/// Maximum of 65,535, a Topic Alias Maximum of 0, its Maximum Packet Size and its Keep Alive.
#[derive(Debug, Clone)]
pub(crate) struct Connect {
    pub(crate) client_identifier: String,
    pub(crate) user_name: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) keep_alive: u16,
    pub(crate) maximum_packet_size: u32,
    pub(crate) will: Option<Will>,
}

// a link's quota toward it, the most a broker holds unacknowledged toward it (MQTT 5.0
// §3.1.2.11.3)
const RECEIVE_MAXIMUM_OF_ITS_OWN: u16 = 65_535;

/// A CONNECT's bytes.
pub(crate) fn write_connect(connect: &Connect) -> Result<Vec<u8>, MqttRefusal> {
    let mut body = Vec::new();
    let mut flags = 0b0000_0010_u8;

    if connect.user_name.is_some() {
        flags |= 0b1000_0000;
    }

    if connect.password.is_some() {
        flags |= 0b0100_0000;
    }

    if connect.will.is_some() {
        // a will of QoS 1, RETAIN 0
        flags |= 0b0000_1100;
    }

    put_text(&mut body, ("MQTT", "a protocol name"))?;
    body.push(5);
    body.push(flags);
    body.extend_from_slice(&connect.keep_alive.to_be_bytes());

    let mut properties = vec![RECEIVE_MAXIMUM];

    properties.extend_from_slice(&RECEIVE_MAXIMUM_OF_ITS_OWN.to_be_bytes());
    properties.push(MAXIMUM_PACKET_SIZE_PROPERTY);
    properties.extend_from_slice(&connect.maximum_packet_size.to_be_bytes());
    properties.push(TOPIC_ALIAS_MAXIMUM);
    properties.extend_from_slice(&0_u16.to_be_bytes());
    put_variable(
        &mut body,
        u32::try_from(properties.len()).unwrap_or_default(),
    );
    body.extend_from_slice(&properties);
    put_text(
        &mut body,
        (&connect.client_identifier, "a Client Identifier"),
    )?;

    if let Some(will) = &connect.will {
        // its Will Delay Interval, 0
        let will_properties = [WILL_DELAY_INTERVAL, 0, 0, 0, 0];

        put_variable(
            &mut body,
            u32::try_from(will_properties.len()).unwrap_or_default(),
        );
        body.extend_from_slice(&will_properties);
        put_text(&mut body, (&will.topic, "a Will Topic"))?;
        put_binary(&mut body, (&will.payload, "a Will Payload"))?;
    }

    if let Some(user_name) = &connect.user_name {
        put_text(&mut body, (user_name, "a User Name"))?;
    }

    if let Some(password) = &connect.password {
        put_binary(&mut body, (password.as_bytes(), "a Password"))?;
    }

    packet_of(CONNECT.checked_shl(4).unwrap_or_default(), &body)
}

/// A PUBLISH's bytes: of `QoS` 1 where it names a Packet Identifier, 0 otherwise, its Message Expiry
/// Interval its one property, exactly [`publish_bytes`] of them (spec 15.30).
///
/// # Errors
///
/// A [`MqttRefusal`] for a topic past 65,535 bytes or holding U+0000, or a packet past what MQTT 5
/// writes.
pub fn write_publish(publish: &MqttPublish) -> Result<Vec<u8>, MqttRefusal> {
    let mut properties = Vec::new();

    if let Some(seconds) = publish.message_expiry_interval {
        properties.push(MESSAGE_EXPIRY_INTERVAL);
        properties.extend_from_slice(&seconds.to_be_bytes());
    }

    let mut head = Vec::new();

    put_text(&mut head, (&publish.topic, "a Topic Name"))?;

    if let Some(identifier) = publish.packet_identifier {
        head.extend_from_slice(&identifier.to_be_bytes());
    }

    put_variable(
        &mut head,
        u32::try_from(properties.len()).unwrap_or_default(),
    );
    head.extend_from_slice(&properties);

    let remaining = head
        .len()
        .checked_add(publish.payload.len())
        .and_then(|remaining| u32::try_from(remaining).ok())
        .filter(|remaining| *remaining <= LARGEST_REMAINING_LENGTH)
        .ok_or_else(|| malformed("a PUBLISH past what MQTT 5 writes"))?;
    let mut first = PUBLISH.checked_shl(4).unwrap_or_default();

    if publish.packet_identifier.is_some() {
        first |= 0b0010;

        if publish.dup {
            first |= 0b1000;
        }
    }

    if publish.retain {
        first |= 0b0001;
    }

    let mut out = Vec::with_capacity(
        head.len()
            .saturating_add(publish.payload.len())
            .saturating_add(5),
    );

    out.push(first);
    put_variable(&mut out, remaining);
    out.extend_from_slice(&head);
    out.extend_from_slice(&publish.payload);

    Ok(out)
}

/// A PUBACK of 0x00 to the PUBLISH of `packet_identifier`: its Reason Code left out, as 0x00 is
/// (MQTT 5.0 §3.4.2.1).
pub(crate) fn write_puback(packet_identifier: u16) -> Vec<u8> {
    let [high, low] = packet_identifier.to_be_bytes();

    vec![PUBACK.checked_shl(4).unwrap_or_default(), 2, high, low]
}

/// A SUBSCRIBE of one filter: `QoS` 1, No Local 0, Retain As Published 0, Retain Handling 2 (spec
/// 15.27).
pub(crate) fn write_subscribe(
    (packet_identifier, filter): (u16, &str),
) -> Result<Vec<u8>, MqttRefusal> {
    let mut body = packet_identifier.to_be_bytes().to_vec();

    body.push(0);
    put_text(&mut body, (filter, "a Topic Filter"))?;
    body.push(SUBSCRIPTION_OPTIONS);

    packet_of(SUBSCRIBE.checked_shl(4).unwrap_or_default() | 0b0010, &body)
}

/// An UNSUBSCRIBE of one filter (spec 15.27): one each, none past its broker's Maximum Packet
/// Size.
pub(crate) fn write_unsubscribe(
    (packet_identifier, filter): (u16, &str),
) -> Result<Vec<u8>, MqttRefusal> {
    let mut body = packet_identifier.to_be_bytes().to_vec();

    body.push(0);
    put_text(&mut body, (filter, "a Topic Filter"))?;

    packet_of(
        UNSUBSCRIBE.checked_shl(4).unwrap_or_default() | 0b0010,
        &body,
    )
}

/// A PINGREQ.
pub(crate) fn write_pingreq() -> Vec<u8> {
    vec![PINGREQ.checked_shl(4).unwrap_or_default(), 0]
}

/// A DISCONNECT of 0x00, a clean end, so that no will goes: its Reason Code left out, as 0x00 is
/// (MQTT 5.0 §3.14.2.1).
pub(crate) fn write_disconnect() -> Vec<u8> {
    vec![DISCONNECT.checked_shl(4).unwrap_or_default(), 0]
}
