//! A participant's trace of parcels (debugging 13), with metadata alone.

use std::sync::Arc;

use crate::broker::parcel::{Parcel, flags, hex_of_byte, is_advisory, kind_named, kinds};
use crate::debug::DebugDirection;
use crate::router::types::ConnectionHandle;

#[cfg(test)]
mod tests;

/// What a participant decides about an incoming message (debugging 13.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ParcelVerdict {
    /// An advisory kind, skipped in sequence.
    Advisory,
    /// Below the sequence awaited.
    Copy,
    /// A parcel whose body does not read.
    DoesNotRead,
    /// Past the sequence awaited.
    Loss,
    /// A message with no readable prefix.
    NoParcel,
    /// Of no inbox, name or departure held.
    OffTopic,
    /// Of a pair the participant does not hold.
    PairNotHeld,
    /// A retained message, dropped before reading.
    Retained,
    /// A parcel taken.
    Taken,
}

impl ParcelVerdict {
    /// The verdict as the companion names it.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Advisory => "advisory",
            Self::Copy => "copy",
            Self::DoesNotRead => "does-not-read",
            Self::Loss => "loss",
            Self::NoParcel => "no-parcel",
            Self::OffTopic => "off-topic",
            Self::PairNotHeld => "pair-not-held",
            Self::Retained => "retained",
            Self::Taken => "taken",
        }
    }
}

/// A participant's event: no carried bytes, credential or acceptor's half (debugging 13.7).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ParticipantDebugEvent {
    /// `parcel`, `link`, `names` or `report`.
    pub event: &'static str,
    /// Which way a parcel goes.
    pub direction: Option<DebugDirection>,
    /// Its logical topic tokens.
    pub topic: Option<Vec<String>>,
    /// Its payload's length.
    pub bytes: Option<usize>,
    /// Its layout, when its prefix reads.
    pub layout: Option<u8>,
    /// Its kind's name, hexadecimal byte, or `advisory` and its byte.
    pub kind: Option<String>,
    /// The flags byte, including on a prefix read alone.
    pub flags: Option<u8>,
    /// Its sequence.
    pub sequence: Option<u64>,
    /// Its opener's half in hexadecimal.
    pub opener: Option<String>,
    /// The connection's ordinal, never reused.
    pub connection: Option<u64>,
    /// Its server's handle after the third leg, or `server` on a client.
    pub connection_handle: Option<ConnectionHandle>,
    /// An OPEN's, ACCEPT's or GONE's participant id.
    pub id: Option<String>,
    /// The participant's incarnation in hexadecimal.
    pub incarnation: Option<String>,
    /// An OPEN's or ACCEPT's receive bound.
    pub bound: Option<u64>,
    /// Whether the sender's leg is secure.
    pub secure: Option<bool>,
    /// A REFUSE's status.
    pub status: Option<u16>,
    /// A DATA's carried length, without copying its bytes.
    pub carried_bytes: Option<usize>,
    /// Whether another part comes.
    pub more: Option<bool>,
    /// Whether the credential flag is set, without reading it.
    pub has_credential: Option<bool>,
    /// The sequence a PONG answers.
    pub answers: Option<u64>,
    /// A CLOSE's code.
    pub code: Option<u16>,
    /// An incoming message's judgment.
    pub verdict: Option<ParcelVerdict>,
    /// The sequence awaited on a loss.
    pub awaited: Option<u64>,
    /// The sequence that came on a loss.
    pub came: Option<u64>,
    /// A completed link transition: `up`, `down`, `taken-over` or `stopped`.
    pub state: Option<&'static str>,
    /// The ordinals it ends, on a down, takeover or stop.
    pub ended: Option<Vec<u64>>,
    /// A name acknowledged held or let go.
    pub name: Option<String>,
    /// Whether its broker holds the name.
    pub is_held: Option<bool>,
    /// The name's subscription group, when any.
    pub group: Option<String>,
    /// What the participant or its transport reports, in its own words.
    pub report: Option<String>,
}

/// What hears a participant's trace, synchronously in its owner's turn, within a panic guard.
pub type ParticipantDebugListener = Arc<dyn Fn(&ParticipantDebugEvent) + Send + Sync>;

impl ParticipantDebugEvent {
    /// The allowlist of a parcel's fields, from the participant's own reading.
    pub(crate) fn parcel(parcel: &Parcel) -> Self {
        let mut event = Self {
            event: "parcel",
            layout: Some(parcel.layout),
            kind: Some(if is_advisory(parcel.kind) {
                format!("advisory {}", parcel.kind)
            } else if parcel.kind > kinds::GONE {
                hex_of_byte(parcel.kind)
            } else {
                kind_named(parcel.kind)
                    .trim_start_matches("an ")
                    .trim_start_matches("a ")
                    .to_owned()
            }),
            flags: parcel.flags,
            sequence: Some(parcel.sequence),
            opener: Some(format!("{:016x}", parcel.opener)),
            ..Self::default()
        };

        match parcel.kind {
            kinds::OPEN | kinds::ACCEPT => {
                event.id.clone_from(&parcel.id);
                event.incarnation = parcel.incarnation.map(|value| format!("{value:032x}"));
                event.bound = parcel.bound;
                event.secure = parcel.flags.map(|value| value & flags::SECURE != 0);
            }
            kinds::REFUSE => event.status = parcel.status,
            kinds::DATA => {
                event.carried_bytes = parcel.carried.as_ref().map(bytes::Bytes::len);
                event.more = parcel.flags.map(|value| value & flags::MORE != 0);
                event.has_credential = parcel.flags.map(|value| value & flags::CREDENTIAL != 0);
            }
            kinds::PONG => event.answers = parcel.answers,
            kinds::CLOSE => event.code = parcel.code,
            kinds::GONE => {
                event.id.clone_from(&parcel.id);
                event.incarnation = parcel.incarnation.map(|value| format!("{value:032x}"));
            }
            _ => {}
        }

        event
    }
}
