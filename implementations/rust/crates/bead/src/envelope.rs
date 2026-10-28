//! An envelope's codec: its prefix, its header and its blocks, a failure's record, and the envelope
//! whole (spec 2 to 7). What reads a peer's bytes indexes, slices and counts by checked operations
//! alone, and refuses in the order the header is written, so the failure raised is the first met.

use core::fmt;
use core::num::NonZeroU16;

use bytes::Bytes;

use crate::constants::{
    CredentialScheme, EnvelopeFlag, EnvelopeKind, EnvelopeLayout, FailureScope, ProtocolCode,
    RouterSide, SESSION_TOKEN_BYTES,
};
use crate::errors::ProgrammerError;
use crate::failure::Failure;
use crate::session_token::SessionToken;

#[cfg(test)]
mod tests;

/// The bytes a header takes at most: the 255 words its fourth byte counts.
pub const MAXIMUM_HEADER_BYTES: usize = 1_020;

/// The largest value a 64-bit field holds: 2⁵³ − 1, the largest integer every side holds exactly,
/// as JavaScript's numbers do.
pub const LARGEST_64_BIT_FIELD: u64 = 0x001f_ffff_ffff_ffff;

/// How many bytes of a failure's detail a reader keeps, and a writer writes, when nothing else is
/// given (spec 7.3).
pub const MAXIMUM_DETAIL_BYTES: usize = 1_024;

/// How many bytes a whole envelope holds at most, when nothing else is given (spec 12.2).
pub const MAXIMUM_ENVELOPE_BYTES: usize = 16_778_240;

// the prefix: layout, kind, flags, header words, then the call id at bytes 4 to 7
const PREFIX_BYTES: usize = 8;

// the layouts to come end here
const LAST_LAYOUT: u8 = 0xaf;

// below it, never a kind; from the advisory one on, skipped
const FIRST_KIND: u8 = 0x10;
const FIRST_ADVISORY: u8 = 0x80;

// a credential's head, as a TLS extension's (RFC 8446 §4.2): its scheme, then its length
const CREDENTIAL_HEAD_BYTES: usize = 4;

// a failure's record: its code, its relays, its flags, then its detail
const RECORD_BYTES: usize = 4;

// the one flag of a failure's record: the code is the procedure's own
const APPLICATION: u8 = 0x01;

/// A credential, as a header carries it: [`Credential::None`] and [`Credential::Opaque`] on an
/// answer, any but `None` on a request.
#[derive(Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum Credential {
    /// On an answer alone: its connection's session ended.
    None,
    /// A session's token.
    Opaque(SessionToken),
    /// On a request alone, a token in JWS Compact Serialization (RFC 7515), a byte a character.
    Jwt(Bytes),
    /// On a request alone, a credential its transport carried beside it.
    Elsewhere,
    /// A scheme to come, from 4 to 65535, and its bytes as they came.
    ToCome {
        /// Its scheme.
        scheme: CredentialScheme,
        /// Its bytes.
        bytes: Bytes,
    },
}

impl Credential {
    /// Its scheme.
    #[must_use]
    pub fn scheme(&self) -> CredentialScheme {
        match self {
            Self::None => CredentialScheme::NONE,
            Self::Opaque(_) => CredentialScheme::OPAQUE,
            Self::Jwt(_) => CredentialScheme::JWT,
            Self::Elsewhere => CredentialScheme::ELSEWHERE,
            Self::ToCome { scheme, .. } => *scheme,
        }
    }
}

impl fmt::Debug for Credential {
    // ! a bearer credential is never written out: its scheme alone
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Credential({})", self.scheme())
    }
}

/// A request's header (spec 3.1.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestHeader {
    /// Its call's id, from 1 to 0xFFFFFFFF.
    pub call_id: u32,
    /// Its service's id, from 1 to 65535.
    pub service_id: u16,
    /// Its procedure's id in its service, from 1 to 65535.
    pub procedure_id: u16,
    /// What it is for behind the peer, from 1 to 0xFFFFFFFF; the peer itself when none.
    pub destination_id: Option<u32>,
    /// Whether it opens a subscription.
    pub opens_subscription: bool,
    /// Whether the subscription it opens has its notifications as credited.
    pub paced: bool,
    /// The whole payload's length, for a request that opens a transfer.
    pub total: Option<u64>,
    /// The credential it presents.
    pub credential: Option<Credential>,
}

/// A result's header (spec 3.1.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultHeader {
    /// The call it answers.
    pub call_id: u32,
    /// The whole payload's length, for a result that opens a transfer.
    pub total: Option<u64>,
    /// The session it announces: `OPAQUE` or `NONE`.
    pub credential: Option<Credential>,
}

/// A failure's header (spec 3.1.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailureHeader {
    /// The call it answers.
    pub call_id: u32,
    /// The session it announces: `OPAQUE` or `NONE`.
    pub credential: Option<Credential>,
}

/// A notification's header (spec 3.1.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationHeader {
    /// The subscription it comes under.
    pub call_id: u32,
}

/// A chunk's header (spec 3.1.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkHeader {
    /// The call whose transfer it carries.
    pub call_id: u32,
    /// Where in the payload its bytes start.
    pub offset: u64,
    /// Whether it is the last chunk of its transfer.
    pub is_last: bool,
}

/// A credit's header (spec 3.1.6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreditHeader {
    /// The call whose transfer, or subscription, it credits.
    pub call_id: u32,
    /// How far the other end may send: a transfer's bytes, or a subscription's notifications.
    pub credit_end: u64,
    /// Whether it counts a subscription's notifications.
    pub paced: bool,
}

/// A cancel's header (spec 3.1.7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelHeader {
    /// The call it ends.
    pub call_id: u32,
}

/// An envelope's header, by its kind.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Header {
    /// A request's.
    Request(RequestHeader),
    /// A result's.
    Result(ResultHeader),
    /// A failure's.
    Failure(FailureHeader),
    /// A notification's.
    Notification(NotificationHeader),
    /// A chunk's.
    Chunk(ChunkHeader),
    /// A credit's.
    Credit(CreditHeader),
    /// A cancel's.
    Cancel(CancelHeader),
}

impl Header {
    /// Its kind.
    #[must_use]
    pub fn kind(&self) -> EnvelopeKind {
        match self {
            Self::Request(_) => EnvelopeKind::Request,
            Self::Result(_) => EnvelopeKind::Result,
            Self::Failure(_) => EnvelopeKind::Failure,
            Self::Notification(_) => EnvelopeKind::Notification,
            Self::Chunk(_) => EnvelopeKind::Chunk,
            Self::Credit(_) => EnvelopeKind::Credit,
            Self::Cancel(_) => EnvelopeKind::Cancel,
        }
    }

    /// Its call's id.
    #[must_use]
    pub fn call_id(&self) -> u32 {
        match self {
            Self::Request(header) => header.call_id,
            Self::Result(header) => header.call_id,
            Self::Failure(header) => header.call_id,
            Self::Notification(header) => header.call_id,
            Self::Chunk(header) => header.call_id,
            Self::Credit(header) => header.call_id,
            Self::Cancel(header) => header.call_id,
        }
    }

    /// The credential it carries.
    #[must_use]
    pub fn credential(&self) -> Option<&Credential> {
        match self {
            Self::Request(header) => header.credential.as_ref(),
            Self::Result(header) => header.credential.as_ref(),
            Self::Failure(header) => header.credential.as_ref(),
            Self::Notification(_) | Self::Chunk(_) | Self::Credit(_) | Self::Cancel(_) => None,
        }
    }

    /// A copy fit to be traced or kept: a bearer credential, a `JWT`'s or one to come, kept by its
    /// scheme alone, its bytes dropped.
    #[must_use]
    pub fn redacted(&self) -> Self {
        let redact = |credential: &Option<Credential>| -> Option<Credential> {
            credential.as_ref().map(|credential| match credential {
                Credential::Jwt(_) => Credential::Jwt(Bytes::new()),
                Credential::ToCome { scheme, .. } => Credential::ToCome {
                    scheme: *scheme,
                    bytes: Bytes::new(),
                },
                Credential::None | Credential::Opaque(_) | Credential::Elsewhere => {
                    credential.clone()
                }
            })
        };

        match self {
            Self::Request(header) => Self::Request(RequestHeader {
                credential: redact(&header.credential),
                ..header.clone()
            }),
            Self::Result(header) => Self::Result(ResultHeader {
                credential: redact(&header.credential),
                ..header.clone()
            }),
            Self::Failure(header) => Self::Failure(FailureHeader {
                credential: redact(&header.credential),
                ..header.clone()
            }),
            Self::Notification(_) | Self::Chunk(_) | Self::Credit(_) | Self::Cancel(_) => {
                self.clone()
            }
        }
    }
}

/// The first 8 bytes of an envelope, which every layout keeps where they are (spec 2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Prefix {
    /// Its first byte.
    pub layout: u8,
    /// Its second byte.
    pub kind: u8,
    /// Its call id, bytes 4 to 7.
    pub call_id: u32,
}

/// A header as it was read: the header, and where the payload starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadHeader {
    /// The header.
    pub header: Header,
    /// Its length, where the payload starts.
    pub header_bytes: usize,
}

/// A failure's record, as a failure envelope carries it (spec 7.1): its code, its relays as they
/// came, its scope, and its detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailureRecord {
    /// Its code, never 0.
    pub code: NonZeroU16,
    /// Whose code it is.
    pub scope: FailureScope,
    /// Why, as UTF-8; empty when it says nothing.
    pub detail: String,
    /// The relays it crossed.
    pub relays: u8,
}

/// An envelope whole: its header, and what follows it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Envelope {
    /// A request and its payload.
    Request {
        /// Its header.
        header: RequestHeader,
        /// Its payload, or a transfer's opening bytes.
        payload: Bytes,
    },
    /// A result and its payload.
    Result {
        /// Its header.
        header: ResultHeader,
        /// Its payload, or a transfer's opening bytes.
        payload: Bytes,
    },
    /// A failure and its record.
    Failure {
        /// Its header.
        header: FailureHeader,
        /// Its record.
        failure: FailureRecord,
    },
    /// A notification and its payload.
    Notification {
        /// Its header.
        header: NotificationHeader,
        /// Its payload.
        payload: Bytes,
    },
    /// A chunk and its bytes.
    Chunk {
        /// Its header.
        header: ChunkHeader,
        /// Its bytes, one at least.
        payload: Bytes,
    },
    /// A credit, which carries nothing else.
    Credit {
        /// Its header.
        header: CreditHeader,
    },
    /// A cancel, which carries nothing else.
    Cancel {
        /// Its header.
        header: CancelHeader,
    },
}

impl Envelope {
    /// Its header.
    #[must_use]
    pub fn header(&self) -> Header {
        match self {
            Self::Request { header, .. } => Header::Request(header.clone()),
            Self::Result { header, .. } => Header::Result(header.clone()),
            Self::Failure { header, .. } => Header::Failure(header.clone()),
            Self::Notification { header, .. } => Header::Notification(header.clone()),
            Self::Chunk { header, .. } => Header::Chunk(header.clone()),
            Self::Credit { header } => Header::Credit(header.clone()),
            Self::Cancel { header } => Header::Cancel(header.clone()),
        }
    }

    /// Its kind.
    #[must_use]
    pub fn kind(&self) -> EnvelopeKind {
        match self {
            Self::Request { .. } => EnvelopeKind::Request,
            Self::Result { .. } => EnvelopeKind::Result,
            Self::Failure { .. } => EnvelopeKind::Failure,
            Self::Notification { .. } => EnvelopeKind::Notification,
            Self::Chunk { .. } => EnvelopeKind::Chunk,
            Self::Credit { .. } => EnvelopeKind::Credit,
            Self::Cancel { .. } => EnvelopeKind::Cancel,
        }
    }

    /// Its call's id.
    #[must_use]
    pub fn call_id(&self) -> u32 {
        match self {
            Self::Request { header, .. } => header.call_id,
            Self::Result { header, .. } => header.call_id,
            Self::Failure { header, .. } => header.call_id,
            Self::Notification { header, .. } => header.call_id,
            Self::Chunk { header, .. } => header.call_id,
            Self::Credit { header } => header.call_id,
            Self::Cancel { header } => header.call_id,
        }
    }
}

/// How an envelope is read beyond its side, each bound the router's default when not given.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
#[expect(
    clippy::struct_field_names,
    reason = "the spec's names of its bounds, each in bytes"
)]
pub struct ReadEnvelopeOptions {
    /// The bytes a whole envelope holds at most; [`MAXIMUM_ENVELOPE_BYTES`] when none.
    pub maximum_envelope_bytes: Option<usize>,
    /// The bytes a request holds at most, whole or a transfer's opening, as its requester sends
    /// one (spec 12.2); the envelope's bound when none.
    pub chunk_bytes: Option<usize>,
    /// The bytes of a failure's detail kept; [`MAXIMUM_DETAIL_BYTES`] when none.
    pub maximum_detail_bytes: Option<usize>,
}

// helpers

fn hexadecimal_of(value: u8) -> String {
    format!("0x{value:02x}")
}

fn is_zero(bytes: &[u8]) -> bool {
    bytes.iter().all(|&byte| byte == 0)
}

fn malformed(side: RouterSide, detail: String) -> Failure {
    Failure::protocol(ProtocolCode::ENVELOPE_MALFORMED, side).saying(detail)
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let end = offset.checked_add(2)?;
    let held: [u8; 2] = bytes.get(offset..end)?.try_into().ok()?;

    Some(u16::from_be_bytes(held))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    let held: [u8; 4] = bytes.get(offset..end)?.try_into().ok()?;

    Some(u32::from_be_bytes(held))
}

// a 64-bit field, its high word first; none for 2⁵³ or more, which no side holds exactly, or past
// the bytes, which a header's length checked already
fn read_u53(bytes: &[u8], offset: usize) -> Option<u64> {
    let end = offset.checked_add(8)?;
    let held: [u8; 8] = bytes.get(offset..end)?.try_into().ok()?;
    let value = u64::from_be_bytes(held);

    (value <= LARGEST_64_BIT_FIELD).then_some(value)
}

// the flags each kind may carry; any other bit makes the envelope malformed
fn allowed_flags(kind: EnvelopeKind) -> u8 {
    match kind {
        EnvelopeKind::Request => {
            EnvelopeFlag::DESTINATION.bits()
                | EnvelopeFlag::TRANSFER.bits()
                | EnvelopeFlag::CREDENTIAL.bits()
                | EnvelopeFlag::SUBSCRIPTION.bits()
                | EnvelopeFlag::PACED.bits()
        }
        // an answer names its call alone: a destination means something to its relay only
        EnvelopeKind::Result => EnvelopeFlag::TRANSFER.bits() | EnvelopeFlag::CREDENTIAL.bits(),
        EnvelopeKind::Failure => EnvelopeFlag::CREDENTIAL.bits(),
        EnvelopeKind::Notification | EnvelopeKind::Cancel => 0,
        EnvelopeKind::Chunk => EnvelopeFlag::MORE.bits(),
        // a credit counts a subscription's notifications, or a transfer's bytes
        EnvelopeKind::Credit => EnvelopeFlag::PACED.bits(),
    }
}

// what follows the prefix before the blocks: a request's service and procedure, a chunk's offset,
// a credit's end
fn kind_part_bytes(kind: EnvelopeKind) -> usize {
    match kind {
        EnvelopeKind::Request => 4,
        EnvelopeKind::Chunk | EnvelopeKind::Credit => 8,
        EnvelopeKind::Result
        | EnvelopeKind::Failure
        | EnvelopeKind::Notification
        | EnvelopeKind::Cancel => 0,
    }
}

// how far a header of `kind` with `flags` runs before its credential: the prefix, the kind's own
// part, then each block of a fixed length
fn fixed_size_of(kind: EnvelopeKind, flags: u8) -> usize {
    let mut bytes = PREFIX_BYTES.saturating_add(kind_part_bytes(kind));

    if flags & EnvelopeFlag::DESTINATION.bits() != 0 {
        bytes = bytes.saturating_add(4);
    }

    if flags & EnvelopeFlag::TRANSFER.bits() != 0 {
        bytes = bytes.saturating_add(8);
    }

    bytes
}

// `length` bytes and the zero bytes that pad them to the next 4-byte word
fn padded_of(length: usize) -> usize {
    length.saturating_add((4_usize.saturating_sub(length % 4)) % 4)
}

// why `held`, the bytes of a credential of `scheme`, are not its scheme's; none when they are
fn broken_rule_of(scheme: CredentialScheme, held: &[u8]) -> Option<String> {
    match scheme {
        CredentialScheme::NONE | CredentialScheme::ELSEWHERE => {
            (!held.is_empty()).then(|| format!("{scheme} holds no byte, not {}", held.len()))
        }
        CredentialScheme::OPAQUE => {
            if held.len() != SESSION_TOKEN_BYTES {
                Some(format!(
                    "an OPAQUE token is {SESSION_TOKEN_BYTES} bytes, not {}",
                    held.len()
                ))
            } else if is_zero(held) {
                Some("an OPAQUE token is never all zero".to_owned())
            } else {
                None
            }
        }
        CredentialScheme::JWT => held
            .is_empty()
            .then(|| "a JWT is 1 byte at least".to_owned()),
        _ => None,
    }
}

/// The first 8 bytes of an envelope, which every layout keeps where they are. Refuses, with
/// `ENVELOPE_MALFORMED` of `side`, fewer bytes, or a first byte no layout is.
///
/// # Errors
///
/// The failure a router of `side` answers with.
pub fn read_prefix(bytes: &[u8], side: RouterSide) -> Result<Prefix, Failure> {
    let (Some(&layout), Some(&kind), Some(call_id)) =
        (bytes.first(), bytes.get(1), read_u32(bytes, 4))
    else {
        return Err(malformed(
            side,
            format!(
                "an envelope is at least {PREFIX_BYTES} bytes, not {}",
                bytes.len()
            ),
        ));
    };

    if !(EnvelopeLayout::First.byte()..=LAST_LAYOUT).contains(&layout) {
        return Err(malformed(
            side,
            format!("{} is not an envelope's first byte", hexadecimal_of(layout)),
        ));
    }

    Ok(Prefix {
        layout,
        kind,
        call_id,
    })
}

// the prefix of an envelope of this layout, of a kind this peer takes; none for an advisory kind,
// skipped. Refuses, in this order, a layout to come, a byte that is never a kind, a kind to come,
// and a call id of 0
fn check_prefix(bytes: &[u8], side: RouterSide) -> Result<Option<(EnvelopeKind, u32)>, Failure> {
    let prefix = read_prefix(bytes, side)?;

    if prefix.layout != EnvelopeLayout::First.byte() {
        return Err(Failure::protocol(ProtocolCode::LAYOUT_UNSUPPORTED, side)
            .saying(format!("0x{:02X}", EnvelopeLayout::First.byte())));
    }

    if prefix.kind >= FIRST_ADVISORY {
        return Ok(None);
    }

    if prefix.kind < FIRST_KIND {
        return Err(malformed(
            side,
            format!("{} is never a kind", hexadecimal_of(prefix.kind)),
        ));
    }

    let Some(kind) = EnvelopeKind::of(prefix.kind) else {
        return Err(
            Failure::protocol(ProtocolCode::KIND_UNSUPPORTED, side).saying(format!(
                "{} is not a kind this peer takes",
                hexadecimal_of(prefix.kind)
            )),
        );
    };

    if prefix.call_id == 0 {
        return Err(malformed(side, "a call id is never 0".to_owned()));
    }

    Ok(Some((kind, prefix.call_id)))
}

// the flags of a header of `kind`, and its length. Refuses a flag its kind does not carry, then a
// length that is not its blocks', to the end of its credential's padding, or that runs past the
// message
fn check_length(
    bytes: &[u8],
    (kind, side): (EnvelopeKind, RouterSide),
) -> Result<(u8, usize), Failure> {
    let flags = bytes.get(2).copied().unwrap_or(0);
    let words = bytes.get(3).copied().unwrap_or(0);
    let allowed = allowed_flags(kind);

    if flags & !allowed != 0 {
        return Err(malformed(
            side,
            format!(
                "a {} envelope carries no flag {}",
                hexadecimal_of(kind.byte()),
                hexadecimal_of(flags & !allowed)
            ),
        ));
    }

    let header_bytes = usize::from(words).saturating_mul(4);
    let fixed_bytes = fixed_size_of(kind, flags);
    let has_credential = flags & EnvelopeFlag::CREDENTIAL.bits() != 0;
    let length_of = |expected: usize| {
        malformed(
            side,
            format!(
                "a {} header of flags {} is {expected} bytes, not {header_bytes} of {}",
                hexadecimal_of(kind.byte()),
                hexadecimal_of(flags),
                bytes.len()
            ),
        )
    };

    if !has_credential {
        if header_bytes != fixed_bytes || header_bytes > bytes.len() {
            return Err(length_of(fixed_bytes));
        }

        return Ok((flags, header_bytes));
    }

    if header_bytes > bytes.len() {
        return Err(malformed(
            side,
            format!(
                "a {} header of {header_bytes} bytes runs past its message of {}",
                hexadecimal_of(kind.byte()),
                bytes.len()
            ),
        ));
    }

    // the credential's head states its length, which the header's own must hold before it is read
    let head_end = fixed_bytes.saturating_add(CREDENTIAL_HEAD_BYTES);

    if header_bytes < head_end {
        return Err(malformed(
            side,
            format!(
                "a {} header of flags {} holds its credential's head: {head_end} bytes at least, not {header_bytes}",
                hexadecimal_of(kind.byte()),
                hexadecimal_of(flags)
            ),
        ));
    }

    let length = read_u16(bytes, fixed_bytes.saturating_add(2)).unwrap_or(0);
    let expected = head_end.saturating_add(padded_of(usize::from(length)));

    if header_bytes != expected {
        return Err(length_of(expected));
    }

    Ok((flags, header_bytes))
}

// the credential a header of `kind` carries from `offset`, its length checked with the header's.
// Refuses a scheme its kind does not take, bytes that are not its scheme's, and padding not zero
fn read_credential(
    bytes: &[u8],
    ((kind, offset), side): ((EnvelopeKind, usize), RouterSide),
) -> Result<Credential, Failure> {
    let scheme = CredentialScheme::new(read_u16(bytes, offset).unwrap_or(0));
    let length = usize::from(read_u16(bytes, offset.saturating_add(2)).unwrap_or(0));
    let start = offset.saturating_add(CREDENTIAL_HEAD_BYTES);
    let end = start.saturating_add(length);
    let held = bytes.get(start..end).unwrap_or_default();

    if kind == EnvelopeKind::Request && scheme == CredentialScheme::NONE {
        return Err(malformed(
            side,
            "a request presents a credential, never NONE".to_owned(),
        ));
    }

    if kind != EnvelopeKind::Request && scheme > CredentialScheme::OPAQUE {
        return Err(malformed(
            side,
            format!("an answer announces OPAQUE or NONE, not {scheme}"),
        ));
    }

    if let Some(broken) = broken_rule_of(scheme, held) {
        return Err(malformed(side, broken));
    }

    let padding = bytes
        .get(end..start.saturating_add(padded_of(length)))
        .unwrap_or_default();

    if !is_zero(padding) {
        return Err(malformed(
            side,
            "a credential's padding is zero bytes".to_owned(),
        ));
    }

    Ok(match scheme {
        CredentialScheme::NONE => Credential::None,
        CredentialScheme::OPAQUE => Credential::Opaque(
            SessionToken::from_slice(held).map_err(|error| malformed(side, error.to_string()))?,
        ),
        // a relay passes the same bytes on, whatever they are: a token past ASCII never verifies
        CredentialScheme::JWT => Credential::Jwt(Bytes::copy_from_slice(held)),
        CredentialScheme::ELSEWHERE => Credential::Elsewhere,
        _ => Credential::ToCome {
            scheme,
            bytes: Bytes::copy_from_slice(held),
        },
    })
}

// the blocks a header carries, in the order of their bits: its destination, a transfer's total,
// then its credential
#[derive(Default)]
struct Blocks {
    destination_id: Option<u32>,
    total: Option<u64>,
    credential: Option<Credential>,
}

fn read_blocks(
    bytes: &[u8],
    ((kind, flags), side): ((EnvelopeKind, u8), RouterSide),
) -> Result<Blocks, Failure> {
    let mut offset = PREFIX_BYTES.saturating_add(kind_part_bytes(kind));
    let mut blocks = Blocks::default();

    if flags & EnvelopeFlag::DESTINATION.bits() != 0 {
        let destination_id = read_u32(bytes, offset).unwrap_or(0);

        if destination_id == 0 {
            return Err(malformed(side, "a destination id is never 0".to_owned()));
        }

        blocks.destination_id = Some(destination_id);
        offset = offset.saturating_add(4);
    }

    if flags & EnvelopeFlag::TRANSFER.bits() != 0 {
        let Some(total) = read_u53(bytes, offset) else {
            return Err(malformed(side, "a total is below 2⁵³".to_owned()));
        };

        blocks.total = Some(total);
        offset = offset.saturating_add(8);
    }

    if flags & EnvelopeFlag::CREDENTIAL.bits() != 0 {
        blocks.credential = Some(read_credential(bytes, ((kind, offset), side))?);
    }

    Ok(blocks)
}

// the header of `kind`: its call, its kind's own part, and its blocks. Refuses a procedure of 0, a
// request paced that opens no subscription, and an offset or an end of 2⁵³ or more
fn header_of(
    bytes: &[u8],
    ((kind, call_id, flags), (blocks, side)): ((EnvelopeKind, u32, u8), (Blocks, RouterSide)),
) -> Result<Header, Failure> {
    Ok(match kind {
        EnvelopeKind::Request => {
            let service_id = read_u16(bytes, PREFIX_BYTES).unwrap_or(0);
            let procedure_id = read_u16(bytes, PREFIX_BYTES.saturating_add(2)).unwrap_or(0);
            let opens_subscription = flags & EnvelopeFlag::SUBSCRIPTION.bits() != 0;
            let paced = flags & EnvelopeFlag::PACED.bits() != 0;

            if procedure_id == 0 {
                return Err(malformed(side, "a procedure id is never 0".to_owned()));
            }

            // pacing is a subscription's: a request that opens none has nothing to pace
            if paced && !opens_subscription {
                return Err(malformed(
                    side,
                    "a request paced opens a subscription".to_owned(),
                ));
            }

            Header::Request(RequestHeader {
                call_id,
                service_id,
                procedure_id,
                destination_id: blocks.destination_id,
                opens_subscription,
                paced,
                total: blocks.total,
                credential: blocks.credential,
            })
        }
        EnvelopeKind::Result => Header::Result(ResultHeader {
            call_id,
            total: blocks.total,
            credential: blocks.credential,
        }),
        EnvelopeKind::Failure => Header::Failure(FailureHeader {
            call_id,
            credential: blocks.credential,
        }),
        EnvelopeKind::Notification => Header::Notification(NotificationHeader { call_id }),
        EnvelopeKind::Chunk => {
            let Some(offset) = read_u53(bytes, PREFIX_BYTES) else {
                return Err(malformed(side, "a chunk's offset is below 2⁵³".to_owned()));
            };

            Header::Chunk(ChunkHeader {
                call_id,
                offset,
                is_last: flags & EnvelopeFlag::MORE.bits() == 0,
            })
        }
        EnvelopeKind::Credit => {
            let Some(credit_end) = read_u53(bytes, PREFIX_BYTES) else {
                return Err(malformed(side, "a credit's end is below 2⁵³".to_owned()));
            };

            Header::Credit(CreditHeader {
                call_id,
                credit_end,
                paced: flags & EnvelopeFlag::PACED.bits() != 0,
            })
        }
        EnvelopeKind::Cancel => Header::Cancel(CancelHeader { call_id }),
    })
}

/// An envelope's header, as a router of `side` reads it: none for an advisory kind, skipped.
///
/// Read in the order a header is written — the prefix, the flags and the length, the
/// blocks, then the header — and checked in that order, so the failure raised is the first met.
///
/// # Errors
///
/// The failure a router of `side` answers with: `LAYOUT_UNSUPPORTED`, `KIND_UNSUPPORTED` or
/// `ENVELOPE_MALFORMED`.
pub fn read_header(bytes: &[u8], side: RouterSide) -> Result<Option<ReadHeader>, Failure> {
    let Some((kind, call_id)) = check_prefix(bytes, side)? else {
        return Ok(None);
    };
    let (flags, header_bytes) = check_length(bytes, (kind, side))?;
    let blocks = read_blocks(bytes, ((kind, flags), side))?;
    let header = header_of(bytes, ((kind, call_id, flags), (blocks, side)))?;

    Ok(Some(ReadHeader {
        header,
        header_bytes,
    }))
}

// whether `byte` continues a UTF-8 character rather than starts one
fn is_continuation(byte: u8) -> bool {
    byte & 0xc0 == 0x80
}

// the bytes of the character `byte` leads, as UTF-8 writes one (RFC 3629 §4): 2 to 4; 1 for any
// other byte
fn sequence_bytes_of(byte: u8) -> usize {
    match byte {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 1,
    }
}

// where a detail cut at `end` of `payload` ends: at the lead byte of the character the cut fell in,
// at most three bytes back, whose sequence crosses the cut; where it fell for anything else
fn cut_of(payload: &[u8], end: usize) -> usize {
    if end >= payload.len() {
        return end;
    }

    let lowest = RECORD_BYTES.max(end.saturating_sub(3));
    let mut index = end;

    while index > lowest {
        index = index.saturating_sub(1);

        let byte = payload.get(index).copied().unwrap_or(0);

        if !is_continuation(byte) {
            return if index.saturating_add(sequence_bytes_of(byte)) > end {
                index
            } else {
                end
            };
        }
    }

    end
}

/// A failure's record, from a failure envelope's payload.
///
/// Its code, its relays as they came, its scope, and its detail — cut to `maximum_detail_bytes`, back to the start of the character the
/// cut fell in, bytes that are not UTF-8 read as U+FFFD, a leading U+FEFF kept.
///
/// # Errors
///
/// `ENVELOPE_MALFORMED` of `side` for fewer than 4 bytes, a code of 0, or a flag other than the
/// application's.
pub fn read_failure(
    payload: &[u8],
    (side, maximum_detail_bytes): (RouterSide, usize),
) -> Result<FailureRecord, Failure> {
    let (Some(code), Some(&relays), Some(&flags)) =
        (read_u16(payload, 0), payload.get(2), payload.get(3))
    else {
        return Err(malformed(
            side,
            format!("a failure's record is {RECORD_BYTES} bytes at least"),
        ));
    };
    let Some(code) = NonZeroU16::new(code) else {
        return Err(malformed(side, "a failure is never of code 0".to_owned()));
    };

    if flags & !APPLICATION != 0 {
        return Err(malformed(
            side,
            format!(
                "a failure's record carries no flag 0x{:x}",
                flags & !APPLICATION
            ),
        ));
    }

    // ! a cut inside a character drops that character alone: a lead byte at most three bytes back
    // whose sequence crosses the cut; a stray continuation byte at the cut drops nothing (spec 7.3)
    let end = cut_of(
        payload,
        payload
            .len()
            .min(RECORD_BYTES.saturating_add(maximum_detail_bytes)),
    );
    let detail = payload.get(RECORD_BYTES..end).unwrap_or_default();

    Ok(FailureRecord {
        code,
        scope: if flags & APPLICATION == 0 {
            FailureScope::Protocol
        } else {
            FailureScope::Application
        },
        detail: String::from_utf8_lossy(detail).into_owned(),
        relays,
    })
}

/// An envelope, as a router of `side` reads it from `bytes`: none for an advisory kind. Its bound
/// is the envelope's, and `chunk_bytes`, when given, for a request, whole or a transfer's opening.
///
/// # Errors
///
/// The failure a router of `side` answers with: bytes that are not an envelope, one past its
/// bound, or one it does not read.
pub fn read_envelope(
    bytes: &Bytes,
    side: RouterSide,
    options: &ReadEnvelopeOptions,
) -> Result<Option<Envelope>, Failure> {
    // the first byte says whether these are an envelope's at all, and its kind which bound holds it
    let prefix = read_prefix(bytes, side)?;
    let maximum_envelope_bytes = options
        .maximum_envelope_bytes
        .unwrap_or(MAXIMUM_ENVELOPE_BYTES);
    let bound = match options.chunk_bytes {
        Some(chunk_bytes) if prefix.kind == EnvelopeKind::Request.byte() => chunk_bytes,
        Some(_) | None => maximum_envelope_bytes,
    };

    if bytes.len() > bound {
        let what = if bound == maximum_envelope_bytes {
            "an envelope"
        } else {
            "a request"
        };

        return Err(
            Failure::protocol(ProtocolCode::ENVELOPE_TOO_LARGE, side).saying(format!(
                "{what} is {bound} bytes at most, not {}",
                bytes.len()
            )),
        );
    }

    let Some(ReadHeader {
        header,
        header_bytes,
    }) = read_header(bytes, side)?
    else {
        return Ok(None);
    };
    let body = bytes.slice(header_bytes.min(bytes.len())..);
    let nothing_after = |what: &str| -> Result<(), Failure> {
        if body.is_empty() {
            Ok(())
        } else {
            Err(malformed(
                side,
                format!("a {what} carries no payload, not {} bytes", body.len()),
            ))
        }
    };

    Ok(Some(match header {
        Header::Failure(header) => Envelope::Failure {
            header,
            failure: read_failure(
                &body,
                (
                    side,
                    options.maximum_detail_bytes.unwrap_or(MAXIMUM_DETAIL_BYTES),
                ),
            )?,
        },
        Header::Notification(header) => Envelope::Notification {
            header,
            payload: body,
        },
        Header::Request(header) => Envelope::Request {
            header,
            payload: body,
        },
        Header::Result(header) => Envelope::Result {
            header,
            payload: body,
        },
        Header::Chunk(header) => {
            // a chunk carries the next bytes of its payload: without any, it moves nothing on
            if body.is_empty() {
                return Err(malformed(
                    side,
                    "a chunk carries one byte at least".to_owned(),
                ));
            }

            Envelope::Chunk {
                header,
                payload: body,
            }
        }
        Header::Credit(header) => {
            nothing_after("credit")?;

            Envelope::Credit { header }
        }
        Header::Cancel(header) => {
            nothing_after("cancel")?;

            Envelope::Cancel { header }
        }
    }))
}

// the scheme and the bytes `credential` writes on a header of `kind`. Refuses a scheme its kind
// does not take — `NONE` on a request, any but `OPAQUE` and `NONE` on an answer — and a `JWT` of no
// byte, or a scheme to come numbered as one the protocol names
fn credential_bytes_of(
    credential: &Credential,
    kind: EnvelopeKind,
) -> Result<(CredentialScheme, Bytes), ProgrammerError> {
    let scheme = credential.scheme();

    if kind == EnvelopeKind::Request && scheme == CredentialScheme::NONE {
        return Err(ProgrammerError::new(
            "a request presents a credential, never NONE",
        ));
    }

    if kind != EnvelopeKind::Request && scheme > CredentialScheme::OPAQUE {
        return Err(ProgrammerError::new(format!(
            "an answer announces OPAQUE or NONE, not {scheme}"
        )));
    }

    match credential {
        Credential::None | Credential::Elsewhere => Ok((scheme, Bytes::new())),
        Credential::Opaque(token) => Ok((scheme, Bytes::copy_from_slice(token.bytes()))),
        Credential::Jwt(token) => {
            if token.is_empty() {
                return Err(ProgrammerError::new(
                    "a JWT is 1 character at least, each from U+0000 to U+00FF, a byte each",
                ));
            }

            Ok((scheme, token.clone()))
        }
        Credential::ToCome { bytes, .. } => {
            if scheme <= CredentialScheme::ELSEWHERE {
                return Err(ProgrammerError::new(format!(
                    "{scheme} holds no bytes: a scheme to come does"
                )));
            }

            Ok((scheme, bytes.clone()))
        }
    }
}

// the flags `header` writes: the blocks it carries, whether it opens a subscription, whether it is
// paced, and, for a chunk, whether more follow it
fn flags_of(header: &Header) -> u8 {
    match header {
        Header::Request(header) => {
            let mut flags = 0;

            if header.destination_id.is_some() {
                flags |= EnvelopeFlag::DESTINATION.bits();
            }

            if header.total.is_some() {
                flags |= EnvelopeFlag::TRANSFER.bits();
            }

            if header.credential.is_some() {
                flags |= EnvelopeFlag::CREDENTIAL.bits();
            }

            if header.opens_subscription {
                flags |= EnvelopeFlag::SUBSCRIPTION.bits();
            }

            if header.paced {
                flags |= EnvelopeFlag::PACED.bits();
            }

            flags
        }
        Header::Result(header) => {
            let mut flags = 0;

            if header.total.is_some() {
                flags |= EnvelopeFlag::TRANSFER.bits();
            }

            if header.credential.is_some() {
                flags |= EnvelopeFlag::CREDENTIAL.bits();
            }

            flags
        }
        Header::Failure(header) => {
            if header.credential.is_some() {
                EnvelopeFlag::CREDENTIAL.bits()
            } else {
                0
            }
        }
        Header::Chunk(header) => {
            if header.is_last {
                0
            } else {
                EnvelopeFlag::MORE.bits()
            }
        }
        Header::Credit(header) => {
            if header.paced {
                EnvelopeFlag::PACED.bits()
            } else {
                0
            }
        }
        Header::Notification(_) | Header::Cancel(_) => 0,
    }
}

// how `header` is laid out: its flags, its credential as written, and its length to the end of the
// credential's padding, its bound unchecked
// a credential as a header writes it: its scheme and its bytes
type Written = (CredentialScheme, Bytes);

fn unbounded_layout_of(header: &Header) -> Result<(u8, Option<Written>, usize), ProgrammerError> {
    let flags = flags_of(header);

    if let Header::Request(request) = header
        && request.paced
        && !request.opens_subscription
    {
        return Err(ProgrammerError::new(
            "a 0x10 header paces nothing: a request that opens a subscription does, or a credit",
        ));
    }

    let credential = header
        .credential()
        .map(|credential| credential_bytes_of(credential, header.kind()))
        .transpose()?;
    let mut header_bytes = fixed_size_of(header.kind(), flags);

    if let Some((_, bytes)) = &credential {
        header_bytes = header_bytes
            .saturating_add(CREDENTIAL_HEAD_BYTES)
            .saturating_add(padded_of(bytes.len()));
    }

    Ok((flags, credential, header_bytes))
}

/// How many bytes `header` takes once written, its bound of 1,020 bytes unchecked: what a writer
/// asks of a header it may refuse with a protocol failure.
///
/// # Errors
///
/// As [`write_header`] refuses, but for its bound.
pub fn unbounded_header_bytes_of(header: &Header) -> Result<usize, ProgrammerError> {
    unbounded_layout_of(header).map(|(_, _, header_bytes)| header_bytes)
}

/// How many bytes `header` takes once written.
///
/// # Errors
///
/// As [`write_header`] refuses.
pub fn header_bytes_of(header: &Header) -> Result<usize, ProgrammerError> {
    let header_bytes = unbounded_header_bytes_of(header)?;

    if header_bytes > MAXIMUM_HEADER_BYTES {
        return Err(ProgrammerError::new(format!(
            "a header is {MAXIMUM_HEADER_BYTES} bytes at most, not {header_bytes}"
        )));
    }

    Ok(header_bytes)
}

fn assert_field(field: &str, (value, maximum): (u64, u64)) -> Result<(), ProgrammerError> {
    if value < 1 || value > maximum {
        return Err(ProgrammerError::new(format!(
            "{field} is an integer from 1 to {maximum}, got {value}"
        )));
    }

    Ok(())
}

fn assert_u53(field: &str, value: u64) -> Result<(), ProgrammerError> {
    if value > LARGEST_64_BIT_FIELD {
        return Err(ProgrammerError::new(format!(
            "{field} is a whole number from 0 to 2⁵³ − 1, got {value}"
        )));
    }

    Ok(())
}

/// Writes `header` at the end of `bytes`, and gives its length.
///
/// # Errors
///
/// A [`ProgrammerError`], before anything is written, for a field that is not from 1 to its
/// maximum — from 0 to 2⁵³ − 1 for an offset, an end or a total — a credential of a scheme its kind
/// does not take or that its scheme does not hold, a request paced that opens no subscription, or a
/// header past 1,020 bytes.
pub fn write_header(header: &Header, bytes: &mut Vec<u8>) -> Result<usize, ProgrammerError> {
    let (flags, credential, header_bytes) = unbounded_layout_of(header)?;

    if header_bytes > MAXIMUM_HEADER_BYTES {
        return Err(ProgrammerError::new(format!(
            "a header is {MAXIMUM_HEADER_BYTES} bytes at most, not {header_bytes}"
        )));
    }

    assert_field("callId", (u64::from(header.call_id()), 0xffff_ffff))?;

    let mut part: Vec<u8> = Vec::new();
    let mut destination_id = None;
    let mut total = None;

    match header {
        Header::Request(request) => {
            assert_field("serviceId", (u64::from(request.service_id), 0xffff))?;
            assert_field("procedureId", (u64::from(request.procedure_id), 0xffff))?;
            part.extend(request.service_id.to_be_bytes());
            part.extend(request.procedure_id.to_be_bytes());
            destination_id = request.destination_id;
            total = request.total;
        }
        Header::Result(result) => total = result.total,
        Header::Chunk(chunk) => {
            assert_u53("offset", chunk.offset)?;
            part.extend(chunk.offset.to_be_bytes());
        }
        Header::Credit(credit) => {
            assert_u53("creditEnd", credit.credit_end)?;
            part.extend(credit.credit_end.to_be_bytes());
        }
        Header::Failure(_) | Header::Notification(_) | Header::Cancel(_) => {}
    }

    if let Some(destination_id) = destination_id {
        assert_field("destinationId", (u64::from(destination_id), 0xffff_ffff))?;
    }

    if let Some(total) = total {
        assert_u53("total", total)?;
    }

    let start = bytes.len();

    bytes.push(EnvelopeLayout::First.byte());
    bytes.push(header.kind().byte());
    bytes.push(flags);
    bytes.push(u8::try_from(header_bytes / 4).unwrap_or(u8::MAX));
    bytes.extend(header.call_id().to_be_bytes());
    bytes.extend(part);

    if let Some(destination_id) = destination_id {
        bytes.extend(destination_id.to_be_bytes());
    }

    if let Some(total) = total {
        bytes.extend(total.to_be_bytes());
    }

    if let Some((scheme, held)) = credential {
        bytes.extend(scheme.get().to_be_bytes());
        bytes.extend(u16::try_from(held.len()).unwrap_or(u16::MAX).to_be_bytes());
        bytes.extend_from_slice(&held);
        bytes.resize(start.saturating_add(header_bytes), 0);
    }

    Ok(header_bytes)
}

/// A failure's record, to send: its code, the relays it crossed, its scope, and its detail cut to
/// `maximum_detail_bytes` at a character's boundary.
#[must_use]
pub fn write_failure(record: &FailureRecord, maximum_detail_bytes: usize) -> Vec<u8> {
    let mut end = record.detail.len().min(maximum_detail_bytes);

    while !record.detail.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }

    let mut bytes = Vec::with_capacity(RECORD_BYTES.saturating_add(end));

    bytes.extend(record.code.get().to_be_bytes());
    bytes.push(record.relays);
    bytes.push(if record.scope == FailureScope::Application {
        APPLICATION
    } else {
        0
    });
    bytes.extend_from_slice(record.detail.as_bytes().get(..end).unwrap_or_default());

    bytes
}

/// An envelope's bytes: its header, then its payload — a failure's record, its detail cut to
/// `maximum_detail_bytes`, for a failure.
///
/// # Errors
///
/// A [`ProgrammerError`] as its header refuses, or for a chunk without a byte.
pub fn write_envelope(
    envelope: &Envelope,
    maximum_detail_bytes: usize,
) -> Result<Bytes, ProgrammerError> {
    let header = envelope.header();
    let mut bytes = Vec::new();

    match envelope {
        Envelope::Chunk { payload, .. } if payload.is_empty() => {
            return Err(ProgrammerError::new("a chunk carries one byte at least"));
        }
        Envelope::Request { payload, .. }
        | Envelope::Result { payload, .. }
        | Envelope::Notification { payload, .. }
        | Envelope::Chunk { payload, .. } => {
            write_header(&header, &mut bytes)?;
            bytes.extend_from_slice(payload);
        }
        Envelope::Failure { failure, .. } => {
            write_header(&header, &mut bytes)?;
            bytes.extend(write_failure(failure, maximum_detail_bytes));
        }
        Envelope::Credit { .. } | Envelope::Cancel { .. } => {
            write_header(&header, &mut bytes)?;
        }
    }

    Ok(Bytes::from(bytes))
}
