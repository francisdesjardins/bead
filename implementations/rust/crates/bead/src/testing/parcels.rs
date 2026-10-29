//! A broker's parcels as the conformance files write them (spec 15.17).
//!
//! Each field by its name, its halves, its incarnation and what a DATA carries in hexadecimal; and
//! the parcel's codec, which the API does not offer, reached through them.

use bytes::Bytes;
use serde::Deserialize;

use crate::broker::parcel::{LAYOUT, Parcel, ParcelRead, encode_parcel, read_parcel, write_parcel};
use crate::testing::hexadecimal;

/// A parcel by its fields, as `spec/vectors.json` and `spec/transports.json` write one.
///
/// A field its kind has no part for is left out; its halves, its incarnation and what a DATA
/// carries are in hexadecimal; there are no flags for one read to its prefix alone.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParcelFields {
    /// Its layout: `0xB1` when none.
    #[serde(default = "layout")]
    pub layout: u8,
    /// Its kind.
    pub kind: u8,
    /// Its flags; none for one read to its prefix alone.
    pub flags: Option<u8>,
    /// Its opener's half.
    pub opener: String,
    /// Its acceptor's half.
    pub acceptor: String,
    /// Its sequence.
    pub sequence: u64,
    /// An OPEN's, an ACCEPT's or a GONE's id.
    pub id: Option<String>,
    /// An OPEN's, an ACCEPT's or a GONE's incarnation.
    pub incarnation: Option<String>,
    /// An OPEN's or an ACCEPT's receive bound.
    pub bound: Option<u64>,
    /// A REFUSE's status.
    pub status: Option<u16>,
    /// A REFUSE 426's layouts.
    pub layouts: Option<Vec<u8>>,
    /// A DATA's credential.
    pub credential: Option<String>,
    /// What a DATA carries.
    pub carried: Option<String>,
    /// A PONG's sequence answered.
    pub answers: Option<u64>,
    /// A CLOSE's code.
    pub code: Option<u16>,
}

const fn layout() -> u8 {
    LAYOUT
}

/// A message read as a parcel, its fields as the files write them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParcelReading {
    /// A parcel that reads.
    Parcel(ParcelFields),
    /// No parcel, and why.
    NoParcel(String),
    /// A parcel that does not read: its prefix, and why.
    DoesNotRead(ParcelFields, String),
}

/// A parcel of `spec/vectors.json`'s `parcels`: its bytes and what they read as.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParcelVector {
    /// Its name.
    pub name: String,
    /// The units it checks.
    pub clauses: Vec<String>,
    /// Its bytes.
    pub bytes: String,
    /// What they read as.
    pub parcel: ParcelFields,
    /// False for a parcel a side reads and no writer writes.
    pub written: Option<bool>,
}

/// A message of `spec/vectors.json`'s `parcelRefusals`: its bytes and how it is refused.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParcelRefusalVector {
    /// Its name.
    pub name: String,
    /// The units it checks.
    pub clauses: Vec<String>,
    /// Its bytes.
    pub bytes: String,
    /// `no-parcel` or `does-not-read`.
    pub refused: String,
}

fn bytes_of(text: &str) -> Result<Vec<u8>, String> {
    hexadecimal::bytes_of(text).ok_or_else(|| format!("{text:?} is no hexadecimal"))
}

fn number_of<const N: usize>(text: &str) -> Result<[u8; N], String> {
    <[u8; N]>::try_from(bytes_of(text)?).map_err(|bytes| format!("{} bytes, not {N}", bytes.len()))
}

/// A half's 8 bytes, in hexadecimal, as a number.
///
/// # Errors
///
/// For one that is not 8 bytes of hexadecimal.
pub fn half_of(text: &str) -> Result<u64, String> {
    number_of::<8>(text).map(u64::from_be_bytes)
}

/// A half as the files write it.
#[must_use]
pub fn text_of_half(half: u64) -> String {
    hexadecimal::text_of(&half.to_be_bytes())
}

fn parcel_of(fields: &ParcelFields) -> Result<Parcel, String> {
    Ok(Parcel {
        layout: fields.layout,
        kind: fields.kind,
        flags: fields.flags,
        opener: half_of(&fields.opener)?,
        acceptor: half_of(&fields.acceptor)?,
        sequence: fields.sequence,
        id: fields.id.clone(),
        incarnation: fields
            .incarnation
            .as_deref()
            .map(number_of::<16>)
            .transpose()?
            .map(u128::from_be_bytes),
        bound: fields.bound,
        status: fields.status,
        layouts: fields.layouts.clone(),
        credential: fields.credential.clone(),
        carried: fields
            .carried
            .as_deref()
            .map(bytes_of)
            .transpose()?
            .map(Bytes::from),
        answers: fields.answers,
        code: fields.code,
    })
}

fn fields_of(parcel: &Parcel) -> ParcelFields {
    ParcelFields {
        layout: parcel.layout,
        kind: parcel.kind,
        flags: parcel.flags,
        opener: text_of_half(parcel.opener),
        acceptor: text_of_half(parcel.acceptor),
        sequence: parcel.sequence,
        id: parcel.id.clone(),
        incarnation: parcel
            .incarnation
            .map(|incarnation| hexadecimal::text_of(&incarnation.to_be_bytes())),
        bound: parcel.bound,
        status: parcel.status,
        layouts: parcel.layouts.clone(),
        credential: parcel.credential.clone(),
        carried: parcel.carried.as_deref().map(hexadecimal::text_of),
        answers: parcel.answers,
        code: parcel.code,
    }
}

/// `fields` with each of its hexadecimal fields as the reader writes it, for a comparison.
///
/// # Errors
///
/// For a field of hexadecimal that is not.
pub fn normalized(fields: &ParcelFields) -> Result<ParcelFields, String> {
    parcel_of(fields).map(|parcel| fields_of(&parcel))
}

/// `bytes` read as a parcel, by the side's codec.
#[must_use]
pub fn read(bytes: &[u8]) -> ParcelReading {
    match read_parcel(&Bytes::copy_from_slice(bytes)) {
        ParcelRead::Parcel(parcel) => ParcelReading::Parcel(fields_of(&parcel)),
        ParcelRead::NoParcel(why) => ParcelReading::NoParcel(why),
        ParcelRead::DoesNotRead(prefix, why) => ParcelReading::DoesNotRead(fields_of(&prefix), why),
    }
}

/// The bytes the side writes of `fields`.
///
/// # Errors
///
/// What the side's writer refuses, its words, or a field of hexadecimal that is not.
pub fn write(fields: &ParcelFields) -> Result<Vec<u8>, String> {
    write_parcel(&parcel_of(fields)?)
        .map(|bytes| bytes.to_vec())
        .map_err(|refused| refused.to_string())
}

/// The bytes of `fields`, held to nothing: what a test's own peer writes, a parcel the side refuses
/// among them.
///
/// # Errors
///
/// For an id or a credential that no byte holds, or a field of hexadecimal that is not.
pub fn encode(fields: &ParcelFields) -> Result<Vec<u8>, String> {
    encode_parcel(&parcel_of(fields)?).map_err(|refused| refused.to_string())
}
