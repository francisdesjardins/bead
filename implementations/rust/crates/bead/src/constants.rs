//! The wire's values: an envelope's layout, its kinds and its flags, the credential schemes, a
//! failure's scopes and the protocol's own codes (spec 2 to 8), and a procedure's kinds (spec 16.11).

use core::fmt;
use core::num::NonZeroU16;
use core::time::Duration;

#[cfg(test)]
mod tests;

/// How an envelope's header is laid out, in its first byte.
///
/// Only [`EnvelopeLayout::First`] is read; 0xA2 to 0xAF are the layouts to come, which a request is
/// refused with `LAYOUT_UNSUPPORTED`; any other first byte is not an envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum EnvelopeLayout {
    /// 0xA1, the one layout this side reads and writes.
    First,
}

impl EnvelopeLayout {
    /// The first byte this layout is.
    #[must_use]
    pub fn byte(self) -> u8 {
        match self {
            Self::First => 0xa1,
        }
    }
}

/// What an envelope is, in its second byte. 0x17 to 0x7F are the kinds to come, refused as
/// `KIND_UNSUPPORTED`; 0x80 to 0xFF are advisory and skipped; 0x00 to 0x0F are never a kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum EnvelopeKind {
    /// 0x10, a call.
    Request,
    /// 0x11, a call's answer.
    Result,
    /// 0x12, a call's failure.
    Failure,
    /// 0x13, what a subscription carries.
    Notification,
    /// 0x14, the next bytes of a payload a request or a result opened as a transfer, at its offset.
    Chunk,
    /// 0x15, what lets the other end send a transfer's bytes up to its end, or a subscription's
    /// notifications.
    Credit,
    /// 0x16, a requester ending its call: 8 bytes, never answered.
    Cancel,
}

impl EnvelopeKind {
    /// Every kind this layout reads, in the order of their bytes.
    pub const ALL: [Self; 7] = [
        Self::Request,
        Self::Result,
        Self::Failure,
        Self::Notification,
        Self::Chunk,
        Self::Credit,
        Self::Cancel,
    ];

    /// The second byte this kind is.
    #[must_use]
    pub fn byte(self) -> u8 {
        match self {
            Self::Request => 0x10,
            Self::Result => 0x11,
            Self::Failure => 0x12,
            Self::Notification => 0x13,
            Self::Chunk => 0x14,
            Self::Credit => 0x15,
            Self::Cancel => 0x16,
        }
    }

    /// The kind `byte` is, or none for a byte this layout reads as no kind of its own.
    #[must_use]
    pub fn of(byte: u8) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.byte() == byte)
    }
}

/// The flags of an envelope's header, in its third byte.
///
/// Those of the low nibble add a block, laid out in the order of their bits: [`DESTINATION`](Self::DESTINATION), 4 bytes, on a request alone;
/// [`TRANSFER`](Self::TRANSFER), 8 bytes, a whole payload's length; [`CREDENTIAL`](Self::CREDENTIAL),
/// last; 0x01 is kept. Those of the high nibble add none; 0x80 is kept. A flag its kind does not
/// take makes the envelope malformed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EnvelopeFlag(u8);

impl EnvelopeFlag {
    /// A destination's block, on a request alone.
    pub const DESTINATION: Self = Self(0x02);
    /// A transfer's total, on a request or a result that opens one.
    pub const TRANSFER: Self = Self(0x04);
    /// A credential's block, on a request, a result or a failure.
    pub const CREDENTIAL: Self = Self(0x08);
    /// On a request alone: it opens a subscription.
    pub const SUBSCRIPTION: Self = Self(0x10);
    /// On a request that opens a subscription, its notifications as credited; on a credit, it
    /// counts notifications.
    pub const PACED: Self = Self(0x20);
    /// On a chunk alone: more chunks follow it.
    pub const MORE: Self = Self(0x40);

    /// The bit this flag is.
    #[must_use]
    pub fn bits(self) -> u8 {
        self.0
    }
}

/// What a CREDENTIAL block holds, in its first 2 bytes (RFC 9110 §11.1's authentication schemes).
///
/// An open code space: 4 to 65535 are the schemes to come, read whole on a request, so it holds
/// every number of its width.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CredentialScheme(u16);

impl CredentialScheme {
    /// On an answer alone: its connection's session ended.
    pub const NONE: Self = Self(0);
    /// A session's token.
    pub const OPAQUE: Self = Self(1);
    /// On a request alone, a token in JWS Compact Serialization (RFC 7515).
    pub const JWT: Self = Self(2);
    /// On a request alone, a credential its transport carried.
    pub const ELSEWHERE: Self = Self(3);

    /// The scheme of number `number`.
    #[must_use]
    pub fn new(number: u16) -> Self {
        Self(number)
    }

    /// Its number.
    #[must_use]
    pub fn get(self) -> u16 {
        self.0
    }

    /// Its name, for a scheme the protocol names.
    #[must_use]
    pub fn name(self) -> Option<&'static str> {
        match self.0 {
            0 => Some("NONE"),
            1 => Some("OPAQUE"),
            2 => Some("JWT"),
            3 => Some("ELSEWHERE"),
            _ => None,
        }
    }
}

impl From<u16> for CredentialScheme {
    fn from(number: u16) -> Self {
        Self(number)
    }
}

impl fmt::Display for CredentialScheme {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.name() {
            Some(name) => formatter.write_str(name),
            None => write!(formatter, "scheme {}", self.0),
        }
    }
}

/// A procedure's kind, how it is called (spec 16.11): never an envelope's kind, which is a request
/// for every call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ProcedureKind {
    /// A command a server makes of a client.
    Command,
    /// A request to a procedure that notifies, which may open a subscription to it.
    Notifies,
    /// A request a client makes of its server.
    Request,
}

impl ProcedureKind {
    /// The kind as the files and the blueprints name it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Notifies => "notifies",
            Self::Request => "request",
        }
    }

    /// The kind named `name`, as the files and the blueprints name it.
    #[must_use]
    pub fn named(name: &str) -> Option<Self> {
        match name {
            "command" => Some(Self::Command),
            "notifies" => Some(Self::Notifies),
            "request" => Some(Self::Request),
            _ => None,
        }
    }
}

/// Whose code a failure's is: the protocol's, or the procedure's own (spec 7.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum FailureScope {
    /// One of the protocol's codes, [`ProtocolCode`].
    Protocol,
    /// The procedure's own code.
    Application,
}

impl FailureScope {
    /// The scope as the files number it: the protocol's 0, the application's 1.
    #[must_use]
    pub fn number(self) -> u8 {
        match self {
            Self::Protocol => 0,
            Self::Application => 1,
        }
    }
}

/// The protocol's own failures, in blocks of 16 by how far a request went.
///
/// The envelope (1 to 15), its route (16 to 31), its admission (32 to 47), its payload (48 to 63),
/// then its procedure (64 to 79). An open code space: a code read that none of these names stays a number (spec 8.1), so
/// it holds every code of its width but 0, which the wire refuses (spec 7.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ProtocolCode(NonZeroU16);

// each of the protocol's codes, its number and its name, in the order of their numbers
const CODES: [(u16, &str); 23] = [
    (1, "ENVELOPE_MALFORMED"),
    (2, "LAYOUT_UNSUPPORTED"),
    (3, "KIND_UNSUPPORTED"),
    (4, "ENVELOPE_TOO_LARGE"),
    (16, "DESTINATION_UNKNOWN"),
    (17, "DESTINATION_UNREACHABLE"),
    (18, "SERVICE_UNKNOWN"),
    (19, "PROCEDURE_UNKNOWN"),
    (20, "CALL_UNKNOWN"),
    (21, "SUBSCRIPTION_UNKNOWN"),
    (22, "SUBSCRIPTION_UNSUPPORTED"),
    (32, "SESSION_REQUIRED"),
    (33, "ACCESS_DENIED"),
    (34, "PAYLOAD_TOO_LARGE"),
    (35, "CAPACITY_EXCEEDED"),
    (36, "CREDENTIAL_UNSUPPORTED"),
    (48, "CHUNK_INVALID"),
    (49, "CREDIT_EXCEEDED"),
    (50, "PAYLOAD_UNDECODABLE"),
    (51, "TRANSFER_STALLED"),
    (52, "PAYLOAD_INVALID"),
    (64, "PROCEDURE_FAILED"),
    (65, "DESTINATION_LOST"),
];

impl ProtocolCode {
    /// 1, an envelope that does not read.
    pub const ENVELOPE_MALFORMED: Self = Self::known(1);
    /// 2, a layout this side does not read.
    pub const LAYOUT_UNSUPPORTED: Self = Self::known(2);
    /// 3, a kind this side does not take.
    pub const KIND_UNSUPPORTED: Self = Self::known(3);
    /// 4, an envelope past its bound.
    pub const ENVELOPE_TOO_LARGE: Self = Self::known(4);
    /// 16, a destination its peer does not know.
    pub const DESTINATION_UNKNOWN: Self = Self::known(16);
    /// 17, a destination its peer cannot reach.
    pub const DESTINATION_UNREACHABLE: Self = Self::known(17);
    /// 18, a service its peer does not offer.
    pub const SERVICE_UNKNOWN: Self = Self::known(18);
    /// 19, a procedure its service does not have.
    pub const PROCEDURE_UNKNOWN: Self = Self::known(19);
    /// 20, a call its peer does not know.
    pub const CALL_UNKNOWN: Self = Self::known(20);
    /// 21, a subscription its peer does not hold.
    pub const SUBSCRIPTION_UNKNOWN: Self = Self::known(21);
    /// 22, a subscription its connection cannot carry.
    pub const SUBSCRIPTION_UNSUPPORTED: Self = Self::known(22);
    /// 32, a session the call needs.
    pub const SESSION_REQUIRED: Self = Self::known(32);
    /// 33, a call its admission refuses.
    pub const ACCESS_DENIED: Self = Self::known(33);
    /// 34, a payload past its bound.
    pub const PAYLOAD_TOO_LARGE: Self = Self::known(34);
    /// 35, a bound of its peer's reached.
    pub const CAPACITY_EXCEEDED: Self = Self::known(35);
    /// 36, a credential scheme its peer does not take.
    pub const CREDENTIAL_UNSUPPORTED: Self = Self::known(36);
    /// 48, a chunk that does not fit its transfer.
    pub const CHUNK_INVALID: Self = Self::known(48);
    /// 49, a transfer's bytes past their credit.
    pub const CREDIT_EXCEEDED: Self = Self::known(49);
    /// 50, a payload its codec cannot read.
    pub const PAYLOAD_UNDECODABLE: Self = Self::known(50);
    /// 51, a transfer silent too long.
    pub const TRANSFER_STALLED: Self = Self::known(51);
    /// 52, a payload its rules refuse.
    pub const PAYLOAD_INVALID: Self = Self::known(52);
    /// 64, a procedure that failed before it answered.
    pub const PROCEDURE_FAILED: Self = Self::known(64);
    /// 65, a destination lost under a call.
    pub const DESTINATION_LOST: Self = Self::known(65);

    // a code this file names, which is never 0
    #[expect(
        clippy::panic,
        reason = "evaluated at compile time alone, over the codes above, none 0"
    )]
    const fn known(number: u16) -> Self {
        match NonZeroU16::new(number) {
            Some(code) => Self(code),
            None => panic!("a protocol code is never 0"),
        }
    }

    /// The code of number `number`, named or to come.
    #[must_use]
    pub fn new(number: NonZeroU16) -> Self {
        Self(number)
    }

    /// Every code the protocol names, in the order of their numbers.
    #[must_use]
    pub fn named() -> Vec<Self> {
        CODES
            .iter()
            .filter_map(|&(number, _)| NonZeroU16::new(number).map(Self))
            .collect()
    }

    /// Its number.
    #[must_use]
    pub fn get(self) -> NonZeroU16 {
        self.0
    }

    /// Its name, for a code the protocol names.
    #[must_use]
    pub fn name(self) -> Option<&'static str> {
        CODES
            .iter()
            .find(|&&(number, _)| number == self.0.get())
            .map(|&(_, name)| name)
    }
}

impl From<NonZeroU16> for ProtocolCode {
    fn from(number: NonZeroU16) -> Self {
        Self(number)
    }
}

impl fmt::Display for ProtocolCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.name() {
            Some(name) => formatter.write_str(name),
            None => write!(formatter, "{}", self.0),
        }
    }
}

/// The side of a router: a client's, or a server's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum RouterSide {
    /// A client's router, which opens odd call ids.
    Client,
    /// A server's router, which opens even call ids.
    Server,
}

impl RouterSide {
    /// The side at the other end of a connection.
    #[must_use]
    pub fn peer(self) -> Self {
        match self {
            Self::Client => Self::Server,
            Self::Server => Self::Client,
        }
    }

    /// The side as a message names it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Client => "client",
            Self::Server => "server",
        }
    }

    /// The first and the last call id this side draws, two apart, as HTTP/2 numbers its streams:
    /// odd from a client, even from a server, so the two never draw the same one.
    #[must_use]
    pub fn call_ids(self) -> (u32, u32) {
        match self {
            Self::Client => (1, 0xffff_ffff),
            Self::Server => (2, 0xffff_fffe),
        }
    }

    /// Which side opened the call `call_id` names: odd, a client; even, a server; none for 0.
    #[must_use]
    pub fn of_call_id(call_id: u32) -> Option<Self> {
        if call_id == 0 {
            None
        } else if call_id % 2 == 1 {
            Some(Self::Client)
        } else {
            Some(Self::Server)
        }
    }
}

impl fmt::Display for RouterSide {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A session token's length, in bytes: 128 bits drawn from the system's source.
pub const SESSION_TOKEN_BYTES: usize = 16;

/// How long a call id stays reserved when its call gave no timeout a timer can hold.
pub const RESERVATION: Duration = Duration::from_secs(5);

/// The one peer a client has, as its router and its manager name the connection.
pub const SERVER_CONNECTION_HANDLE: &str = "server";
