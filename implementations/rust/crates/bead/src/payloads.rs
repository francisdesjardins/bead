//! The codecs of spec section 17: `raw`, `text` and `json`, the same bytes from every side, and a
//! codec of a type's own through `serde`: what a procedure's descriptor reads and writes by.

use core::fmt;
use core::marker::PhantomData;
use std::error::Error;

use bytes::Bytes;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::json::{self, JsonRefusal};
use crate::transport::caught;

#[cfg(test)]
mod tests;

/// Why a codec does not read a payload, or write a value: its reason, in its own words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodecRefusal {
    reason: String,
}

impl CodecRefusal {
    /// A refusal, saying `reason`.
    #[must_use]
    pub fn new<R: Into<String>>(reason: R) -> Self {
        Self {
            reason: reason.into(),
        }
    }

    /// Its reason.
    #[must_use]
    pub fn reason(&self) -> &str {
        &self.reason
    }
}

impl fmt::Display for CodecRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.reason)
    }
}

impl Error for CodecRefusal {}

impl From<JsonRefusal> for CodecRefusal {
    fn from(refusal: JsonRefusal) -> Self {
        Self::new(refusal.to_string())
    }
}

/// How one encoding reads a payload and writes a value.
pub trait PayloadCodec: Send + Sync + fmt::Debug + 'static {
    /// What it reads a payload to, and writes.
    type Value: Send + 'static;

    /// The value `bytes` hold.
    ///
    /// # Errors
    ///
    /// A [`CodecRefusal`] for bytes that do not read.
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

/// What `codec` reads `bytes` to, within a guard: a codec is the application's code, and what it
/// panics is its throw, a refusal saying it, as both other sides take any throw of a decode
/// (decision 0044).
pub(crate) fn decoded<C: PayloadCodec>(codec: &C, bytes: &Bytes) -> Result<C::Value, CodecRefusal> {
    caught(("a codec", || codec.decode(bytes)))
        .unwrap_or_else(|panicked| Err(CodecRefusal::new(panicked.to_string())))
}

/// The bytes `codec` writes `value` to, within a guard, as [`decoded`] reads.
pub(crate) fn encoded<C: PayloadCodec>(codec: &C, value: &C::Value) -> Result<Bytes, CodecRefusal> {
    caught(("a codec", || codec.encode(value)))
        .unwrap_or_else(|panicked| Err(CodecRefusal::new(panicked.to_string())))
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
            .map_err(|_error| CodecRefusal::new("not UTF-8"))
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
