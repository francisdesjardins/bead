//! `spec/vectors.json`, each group read through a typed structure of its own, never by index.

use bytes::Bytes;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::constants::{CredentialScheme, FailureScope, RouterSide};
use crate::envelope::{
    CancelHeader, ChunkHeader, Credential, CreditHeader, Envelope, FailureHeader, FailureRecord,
    Header, NotificationHeader, RequestHeader, ResultHeader,
};
use crate::session_token::SessionToken;
use crate::testing::files;
use crate::testing::hexadecimal;

/// The entries of the group `group` of `spec/vectors.json`, each read as `T`.
///
/// # Errors
///
/// What reading the file, or the group as `T`, refuses.
pub fn of<T: DeserializeOwned>(group: &str) -> Result<Vec<T>, String> {
    let mut vectors: serde_json::Map<String, Value> = files::read("vectors.json")?;
    let entries = vectors
        .remove(group)
        .ok_or_else(|| format!("vectors.json holds no group {group}"))?;

    serde_json::from_value(entries).map_err(|error| format!("vectors.json, {group}: {error}"))
}

/// A credential as the vectors write it: its scheme by name, or by number for a scheme to come; a
/// `JWT`'s token as it is; the bytes of an `OPAQUE` and of a scheme to come in hexadecimal.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VectorCredential {
    /// Its scheme, by its name or its number.
    pub scheme: Value,
    /// A `JWT`'s token.
    pub token: Option<String>,
    /// An `OPAQUE`'s bytes, or a scheme to come's, in hexadecimal.
    pub bytes: Option<String>,
}

/// A header as the vectors write it.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VectorHeader {
    /// Its call id.
    pub call_id: u32,
    /// Its kind's byte.
    pub kind: u8,
    /// A request's service.
    pub service_id: Option<u16>,
    /// A request's procedure.
    pub procedure_id: Option<u16>,
    /// A request's destination.
    pub destination_id: Option<u32>,
    /// Whether a request opens a subscription.
    pub opens_subscription: Option<bool>,
    /// Whether a request, or a credit, is paced.
    pub paced: Option<bool>,
    /// A transfer's total.
    pub total: Option<u64>,
    /// Its credential.
    pub credential: Option<VectorCredential>,
    /// Whether a chunk is the last.
    pub is_last: Option<bool>,
    /// A chunk's offset.
    pub offset: Option<u64>,
    /// A credit's end.
    pub credit_end: Option<u64>,
}

/// A header's bytes and what they say.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeaderVector {
    /// Its name.
    pub name: String,
    /// The units it checks.
    pub clauses: Vec<String>,
    /// Its bytes, in hexadecimal.
    pub bytes: String,
    /// What they say.
    pub header: VectorHeader,
}

/// Bytes a side reads, and the header it reads, none for one it skips.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadVector {
    /// Its name.
    pub name: String,
    /// The units it checks.
    pub clauses: Vec<String>,
    /// The side that reads.
    pub side: String,
    /// Its bytes, in hexadecimal.
    pub bytes: String,
    /// What they say; none for an envelope skipped.
    pub header: Option<VectorHeader>,
}

/// A prefix as the vectors write it.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VectorPrefix {
    /// Its call id.
    pub call_id: u32,
    /// Its kind's byte.
    pub kind: u8,
    /// Its layout's byte.
    pub layout: u8,
}

/// A prefix's bytes and what they say.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrefixVector {
    /// Its name.
    pub name: String,
    /// The units it checks.
    pub clauses: Vec<String>,
    /// Its bytes, in hexadecimal.
    pub bytes: String,
    /// What they say.
    pub prefix: VectorPrefix,
}

/// Bytes a reader refuses, and the code it answers with.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RefusalVector {
    /// Its name.
    pub name: String,
    /// The units it checks.
    pub clauses: Vec<String>,
    /// Its bytes, in hexadecimal.
    pub bytes: String,
    /// The protocol code a reader answers with.
    pub code: u16,
    /// The TypeScript side's words, informative.
    pub detail: Option<String>,
    /// The bound a whole envelope is read with, where the vector is about it.
    pub maximum_envelope_bytes: Option<usize>,
}

/// A failure's record as the vectors write it.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VectorFailure {
    /// Its code.
    pub code: u16,
    /// Its detail.
    pub detail: String,
    /// The relays it crossed.
    pub relays: u8,
    /// Its scope's number.
    pub scope: u8,
}

/// An envelope as the vectors write it.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VectorEnvelope {
    /// Its kind's byte.
    pub kind: u8,
    /// Its header.
    pub header: VectorHeader,
    /// Its payload, in hexadecimal.
    pub payload: Option<String>,
    /// A failure's record.
    pub failure: Option<VectorFailure>,
}

/// An envelope's bytes and what they say.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvelopeVector {
    /// Its name.
    pub name: String,
    /// The units it checks.
    pub clauses: Vec<String>,
    /// Its bytes, in hexadecimal.
    pub bytes: String,
    /// What they say.
    pub envelope: VectorEnvelope,
}

/// A failure's record, and what it reads to.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FailureVector {
    /// Its name.
    pub name: String,
    /// The units it checks.
    pub clauses: Vec<String>,
    /// Its record, in hexadecimal.
    pub record: String,
    /// The detail's bound it is read with, where given.
    pub maximum_detail_bytes: Option<usize>,
    /// What it reads to.
    pub failure: VectorFailure,
}

/// A failure's record a reader refuses.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FailureRefusalVector {
    /// Its name.
    pub name: String,
    /// The units it checks.
    pub clauses: Vec<String>,
    /// Its record, in hexadecimal.
    pub record: String,
    /// The protocol code a reader answers with.
    pub code: u16,
}

/// The bytes `text` spells in hexadecimal.
///
/// # Errors
///
/// For text no bytes spell.
pub fn bytes_of(text: &str) -> Result<Bytes, String> {
    hexadecimal::bytes_of(text)
        .map(Bytes::from)
        .ok_or_else(|| format!("{text:?} is no hexadecimal"))
}

/// The side a vector names.
///
/// # Errors
///
/// For a name no side is.
pub fn side_of(side: &str) -> Result<RouterSide, String> {
    match side {
        "client" => Ok(RouterSide::Client),
        "server" => Ok(RouterSide::Server),
        _ => Err(format!("{side} is no side")),
    }
}

/// A credential the vectors write, as a header carries it.
///
/// # Errors
///
/// For a credential no header carries.
pub fn credential_of(credential: &VectorCredential) -> Result<Credential, String> {
    let bytes = || bytes_of(credential.bytes.as_deref().unwrap_or(""));

    match &credential.scheme {
        Value::String(name) => match name.as_str() {
            "NONE" => Ok(Credential::None),
            "OPAQUE" => SessionToken::from_slice(&bytes()?)
                .map(Credential::Opaque)
                .map_err(|error| error.to_string()),
            "JWT" => Ok(Credential::Jwt(Bytes::from(latin1_bytes_of(
                credential.token.as_deref().unwrap_or(""),
            )?))),
            "ELSEWHERE" => Ok(Credential::Elsewhere),
            _ => Err(format!("{name} is no scheme")),
        },
        Value::Number(number) => {
            let scheme = number
                .as_u64()
                .and_then(|number| u16::try_from(number).ok())
                .ok_or_else(|| format!("{number} is no scheme"))?;

            Ok(Credential::ToCome {
                scheme: CredentialScheme::new(scheme),
                bytes: bytes()?,
            })
        }
        Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => {
            Err("a scheme is a name or a number".to_owned())
        }
    }
}

/// The bytes `text` spells, a character a byte, as a `JWT`'s token is written.
///
/// # Errors
///
/// For a character past U+00FF.
pub fn latin1_bytes_of(text: &str) -> Result<Vec<u8>, String> {
    text.chars()
        .map(|character| {
            u8::try_from(u32::from(character))
                .map_err(|_error| format!("{character} is past U+00FF"))
        })
        .collect()
}

/// A header the vectors write, as this side reads it.
///
/// # Errors
///
/// For a header of no kind this side reads, or missing a field its kind holds.
pub fn header_of(header: &VectorHeader) -> Result<Header, String> {
    let credential = header.credential.as_ref().map(credential_of).transpose()?;
    let missing = |field: &str| format!("a header of kind {} holds its {field}", header.kind);

    Ok(match header.kind {
        0x10 => Header::Request(RequestHeader {
            call_id: header.call_id,
            service_id: header.service_id.ok_or_else(|| missing("serviceId"))?,
            procedure_id: header.procedure_id.ok_or_else(|| missing("procedureId"))?,
            destination_id: header.destination_id,
            opens_subscription: header.opens_subscription.unwrap_or(false),
            paced: header.paced.unwrap_or(false),
            total: header.total,
            credential,
        }),
        0x11 => Header::Result(ResultHeader {
            call_id: header.call_id,
            total: header.total,
            credential,
        }),
        0x12 => Header::Failure(FailureHeader {
            call_id: header.call_id,
            credential,
        }),
        0x13 => Header::Notification(NotificationHeader {
            call_id: header.call_id,
        }),
        0x14 => Header::Chunk(ChunkHeader {
            call_id: header.call_id,
            offset: header.offset.ok_or_else(|| missing("offset"))?,
            is_last: header.is_last.ok_or_else(|| missing("isLast"))?,
        }),
        0x15 => Header::Credit(CreditHeader {
            call_id: header.call_id,
            credit_end: header.credit_end.ok_or_else(|| missing("creditEnd"))?,
            paced: header.paced.unwrap_or(false),
        }),
        0x16 => Header::Cancel(CancelHeader {
            call_id: header.call_id,
        }),
        kind => return Err(format!("{kind} is no kind this side reads")),
    })
}

/// A failure's record the vectors write, as this side reads it.
///
/// # Errors
///
/// For a code of 0, or a scope no failure has.
pub fn record_of(failure: &VectorFailure) -> Result<FailureRecord, String> {
    Ok(FailureRecord {
        code: core::num::NonZeroU16::new(failure.code).ok_or("a failure's code is never 0")?,
        scope: match failure.scope {
            0 => FailureScope::Protocol,
            1 => FailureScope::Application,
            scope => return Err(format!("{scope} is no scope")),
        },
        detail: failure.detail.clone(),
        relays: failure.relays,
    })
}

/// An envelope the vectors write, as this side reads it.
///
/// # Errors
///
/// For an envelope whose kind is not its header's, or missing what its kind carries.
pub fn envelope_of(envelope: &VectorEnvelope) -> Result<Envelope, String> {
    let header = header_of(&envelope.header)?;
    let payload = || bytes_of(envelope.payload.as_deref().unwrap_or(""));

    if header.kind().byte() != envelope.kind {
        return Err("an envelope's kind is its header's".to_owned());
    }

    Ok(match header {
        Header::Request(header) => Envelope::Request {
            header,
            payload: payload()?,
        },
        Header::Result(header) => Envelope::Result {
            header,
            payload: payload()?,
        },
        Header::Failure(header) => Envelope::Failure {
            header,
            failure: record_of(
                envelope
                    .failure
                    .as_ref()
                    .ok_or("a failure holds its record")?,
            )?,
        },
        Header::Notification(header) => Envelope::Notification {
            header,
            payload: payload()?,
        },
        Header::Chunk(header) => Envelope::Chunk {
            header,
            payload: payload()?,
        },
        Header::Credit(header) => Envelope::Credit { header },
        Header::Cancel(header) => Envelope::Cancel { header },
    })
}
