//! The codecs of spec section 17: `raw`, `text` and `json`, the same bytes from every side, and a
//! codec of a type's own through `serde`: what a procedure's descriptor reads and writes by.

use core::fmt;
use core::marker::PhantomData;
use std::error::Error;
use std::sync::Arc;

use bytes::Bytes;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::json::{self, JsonRefusal};
use crate::transport::{Panicked, caught};

#[cfg(test)]
mod tests;

/// Why a codec does not read a payload, or write a value: its reason, and what more the side knows
/// of it in its cause.
///
/// A codec of spec 17 refuses with its reason in 17.2's words and no others, `not UTF-8` or
/// `nested past 100`, say: the words a request's `PAYLOAD_UNDECODABLE` carries as its detail. What
/// more a side knows, its library's own words, the record refused, a required field's name, rides
/// in its cause, its [`source`](Error::source), for its reports and its trace, never on the wire.
/// Two refusals are equal by their reasons.
#[derive(Debug, Clone)]
pub struct CodecRefusal {
    reason: String,
    cause: Option<Arc<dyn Error + Send + Sync>>,
}

impl CodecRefusal {
    /// A refusal, saying `reason`.
    #[must_use]
    pub fn new<R: Into<String>>(reason: R) -> Self {
        Self {
            reason: reason.into(),
            cause: None,
        }
    }

    /// The same refusal, caused by `cause`: what more the side knows of it.
    #[must_use]
    pub fn caused_by(mut self, cause: Arc<dyn Error + Send + Sync>) -> Self {
        self.cause = Some(cause);
        self
    }

    /// Its reason.
    #[must_use]
    pub fn reason(&self) -> &str {
        &self.reason
    }
}

impl PartialEq for CodecRefusal {
    fn eq(&self, other: &Self) -> bool {
        self.reason == other.reason
    }
}

impl Eq for CodecRefusal {}

impl fmt::Display for CodecRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.reason)
    }
}

impl Error for CodecRefusal {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.cause
            .as_deref()
            .map(|cause| -> &(dyn Error + 'static) { cause })
    }
}

// * the refusal's reason is the JSON refusal's, in 17.2's words; what serde said, where it said
// anything, rides in its cause
impl From<JsonRefusal> for CodecRefusal {
    fn from(refusal: JsonRefusal) -> Self {
        let reason = refusal.reason();

        match refusal {
            JsonRefusal::NoJsonValue(_) | JsonRefusal::NotItsType(_) => {
                Self::new(reason).caused_by(Arc::new(refusal))
            }
            JsonRefusal::NotUtf8
            | JsonRefusal::ByteOrderMark
            | JsonRefusal::NotJson
            | JsonRefusal::NameTwice
            | JsonRefusal::SurrogateAlone
            | JsonRefusal::NumberPastADouble
            | JsonRefusal::NestedPast64
            | JsonRefusal::NotAFiniteNumber => Self::new(reason),
        }
    }
}

/// How one encoding reads a payload and writes a value: what does not read, or write, is a
/// [`CodecRefusal`], its refusal.
///
/// A request's payload its codec refuses is answered `PAYLOAD_UNDECODABLE`, the refusal's reason its
/// detail (spec 17.2). A codec that panics is
/// no refusal but the side's own error: a request is answered `PROCEDURE_FAILED` and the panic
/// reported (spec 9.0, 17.2).
pub trait PayloadCodec: Send + Sync + fmt::Debug + 'static {
    /// What it reads a payload to, and writes.
    type Value: Send + 'static;

    /// The value `bytes` hold.
    ///
    /// # Errors
    ///
    /// A [`CodecRefusal`] for bytes that do not read, its refusal; what it panics with is the
    /// side's own error (spec 9.0, 17.2).
    fn decode(&self, bytes: &Bytes) -> Result<Self::Value, CodecRefusal>;

    /// The bytes `value` writes.
    ///
    /// # Errors
    ///
    /// A [`CodecRefusal`] for a value that does not write.
    fn encode(&self, value: &Self::Value) -> Result<Bytes, CodecRefusal>;

    /// The encoding's name, as a blueprint names it.
    fn encoding(&self) -> &'static str;
}

/// What `codec` reads `bytes` to, within a guard: its value or its refusal, the payload's; or,
/// apart, what it panicked with, its throw other than its refusal, the side's own error (spec 9.0,
/// 17.2, decision 0044), since a codec is the application's code.
pub(crate) fn decoded<C: PayloadCodec>(
    codec: &C,
    bytes: &Bytes,
) -> Result<Result<C::Value, CodecRefusal>, Panicked> {
    caught(("a codec", || codec.decode(bytes)))
}

/// A codec's panic where a refusal and a bug end alike, a result's or a notification's read or any
/// write (spec 17.2, items 2 to 6): a refusal saying it, its words the side's own.
pub(crate) fn refusal_saying(panicked: &Panicked) -> CodecRefusal {
    CodecRefusal::new(panicked.to_string())
}

/// The bytes `codec` writes `value` to, within a guard, as [`decoded`] reads: its panic a refusal
/// saying it, as [`refusal_saying`] has it (spec 17.2, items 4 to 6).
pub(crate) fn encoded<C: PayloadCodec>(codec: &C, value: &C::Value) -> Result<Bytes, CodecRefusal> {
    caught(("a codec", || codec.encode(value)))
        .unwrap_or_else(|panicked| Err(refusal_saying(&panicked)))
}

/// `raw`: a payload's bytes as they are, any of them, none included (spec 17.3).
#[derive(Debug, Clone, Copy, Default)]
pub struct RawCodec;

impl PayloadCodec for RawCodec {
    type Value = Bytes;

    fn decode(&self, bytes: &Bytes) -> Result<Bytes, CodecRefusal> {
        Ok(bytes.clone())
    }

    fn encode(&self, value: &Bytes) -> Result<Bytes, CodecRefusal> {
        Ok(value.clone())
    }

    fn encoding(&self) -> &'static str {
        "raw"
    }
}

/// `text`: a string in UTF-8, read strictly, a leading U+FEFF kept (spec 17.4).
#[derive(Debug, Clone, Copy, Default)]
pub struct TextCodec;

impl PayloadCodec for TextCodec {
    type Value = String;

    fn decode(&self, bytes: &Bytes) -> Result<String, CodecRefusal> {
        core::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|error| CodecRefusal::new("not UTF-8").caused_by(Arc::new(error)))
    }

    fn encode(&self, value: &String) -> Result<Bytes, CodecRefusal> {
        Ok(Bytes::copy_from_slice(value.as_bytes()))
    }

    fn encoding(&self) -> &'static str {
        "text"
    }
}

/// `json`: a JSON value, read by [`json::read`] and written in its canonical form (spec 17.5 to
/// 17.7).
#[derive(Debug, Clone, Copy, Default)]
pub struct JsonCodec;

impl PayloadCodec for JsonCodec {
    type Value = Value;

    fn decode(&self, bytes: &Bytes) -> Result<Value, CodecRefusal> {
        json::read(bytes).map_err(CodecRefusal::from)
    }

    fn encode(&self, value: &Value) -> Result<Bytes, CodecRefusal> {
        json::write(value)
            .map(Bytes::from)
            .map_err(CodecRefusal::from)
    }

    fn encoding(&self) -> &'static str {
        "json"
    }
}

/// `json`, of a type of the application's own: read through [`json::read`] then `serde`, written
/// through [`json::to_value`], which refuses a double that is not finite, then canonical.
pub struct JsonOf<T> {
    of: PhantomData<fn() -> T>,
}

impl<T> JsonOf<T> {
    /// The codec of `T`.
    #[must_use]
    pub fn new() -> Self {
        Self { of: PhantomData }
    }
}

impl<T> Default for JsonOf<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Clone for JsonOf<T> {
    fn clone(&self) -> Self {
        Self::new()
    }
}

impl<T> fmt::Debug for JsonOf<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JsonOf")
    }
}

impl<T: Serialize + DeserializeOwned + Send + 'static> PayloadCodec for JsonOf<T> {
    type Value = T;

    fn decode(&self, bytes: &Bytes) -> Result<T, CodecRefusal> {
        json::from_value(json::read(bytes)?).map_err(CodecRefusal::from)
    }

    fn encode(&self, value: &T) -> Result<Bytes, CodecRefusal> {
        json::to_bytes(value)
            .map(Bytes::from)
            .map_err(CodecRefusal::from)
    }

    fn encoding(&self) -> &'static str {
        "json"
    }
}
