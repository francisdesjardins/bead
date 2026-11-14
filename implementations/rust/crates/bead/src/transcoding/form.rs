//! The seam between a gateway and a message's JSON form (spec/transcoding.md 4, 5, 7.4): what a
//! route's message is bound, read and written by, which the core declares and a codec of messages
//! fills, as `bead_protobuf`'s `JsonForm` fills it for a `proto` message, as [`PayloadCodec`]
//! joins a codec to its routers.
//!
//! [`PayloadCodec`]: crate::PayloadCodec

use core::fmt;
use std::error::Error;

use bytes::Bytes;

use crate::errors::ProgrammerError;
use crate::payloads::CodecRefusal;
use crate::transcoding::routes::HttpRouteTemplate;
use crate::transcoding::templates::VariableValue;

/// Where a request's reading met what it refuses, or where a violation's field lies (7.4).
///
/// A JSON Pointer into its body, as a URI fragment, or a parameter, a variable's or the
/// query's, by its JSON names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestPlace {
    /// A JSON Pointer into its body, as a URI fragment (RFC 6901 §6), `#` its body whole.
    Pointer(String),
    /// A parameter, a variable's or the query's, by its JSON names.
    Parameter(String),
}

/// What a message's JSON form refuses (transcoding 5): its words, which a problem carries as its
/// detail, and where it met them, which a problem carries as its `pointer` or its `parameter`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct JsonFormError {
    reason: String,
    place: Option<RequestPlace>,
}

impl JsonFormError {
    /// A refusal, saying `reason`, placed nowhere.
    #[must_use]
    pub fn new<R: Into<String>>(reason: R) -> Self {
        Self {
            reason: reason.into(),
            place: None,
        }
    }

    /// The same refusal, at `place`.
    #[must_use]
    pub fn at(mut self, place: RequestPlace) -> Self {
        self.place = Some(place);
        self
    }

    /// Its words, the mapping's.
    #[must_use]
    pub fn reason(&self) -> &str {
        &self.reason
    }

    /// Where it met them, where it knows.
    #[must_use]
    pub const fn place(&self) -> Option<&RequestPlace> {
        self.place.as_ref()
    }
}

impl fmt::Display for JsonFormError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.reason)
    }
}

impl Error for JsonFormError {}

/// What a request is bound from (transcoding 4): its route's body, its variables decoded, its query
/// and its body.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct BindingOptions<'a> {
    /// Its body's bytes, a message's JSON text; none where its route takes none.
    pub body: Option<&'a [u8]>,
    /// Whether its route is a `patch` rule's, whose `update_mask` its body's keys fill (4.5).
    pub is_patch: Option<bool>,
    /// Its query, raw, after the first `?`; none where its target has none.
    pub query: Option<&'a str>,
    /// Its route's body: `*`, a top-level field's proto name, or none.
    pub route_body: Option<&'a str>,
    /// Each variable's value, decoded, by its field path of proto names, in its template's order.
    pub variables: &'a [VariableValue],
}

impl<'a> BindingOptions<'a> {
    /// The options of a request whose route's variables took `variables`.
    #[must_use]
    pub const fn new(variables: &'a [VariableValue]) -> Self {
        Self {
            body: None,
            is_patch: None,
            query: None,
            route_body: None,
            variables,
        }
    }
}

/// Why a message's form gave no payload or no text: what the host answers by (transcoding 5.7, 7.4,
/// 7.5).
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum MessageFormError {
    /// What the mapping refuses, its words and its place.
    Form(JsonFormError),
    /// A payload its stock library does not read: 502, code 50, reported, never in a problem.
    Undecodable(CodecRefusal),
    /// A route its message does not hold: a programmer's error.
    Programmer(ProgrammerError),
}

impl fmt::Display for MessageFormError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Form(error) => fmt::Display::fmt(error, formatter),
            Self::Undecodable(refusal) => fmt::Display::fmt(refusal, formatter),
            Self::Programmer(error) => fmt::Display::fmt(error, formatter),
        }
    }
}

impl Error for MessageFormError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Form(error) => Some(error),
            Self::Undecodable(refusal) => Some(refusal),
            Self::Programmer(error) => Some(error),
        }
    }
}

/// A message's JSON form (transcoding 4, 5).
///
/// A gateway binds a request of it and writes a result of it, and a caller writes a request of it
/// and reads a result of it: `bead_protobuf`'s
/// `JsonForm` makes one of each message, under its feature `transcoding`. The payload on either
/// side is the binary one its stock library reads and writes. A method added later comes with a
/// default body.
pub trait MessageForm: fmt::Debug + Send + Sync + 'static {
    /// The message's full name, as a problem names it.
    fn full_name(&self) -> &str;

    /// Its request bound from a route's variables, query and body (4), read by 5.2, encoded.
    ///
    /// # Errors
    ///
    /// What the mapping refuses, at its place; a programmer's error for a variable that names no
    /// field.
    fn bind(&self, options: &BindingOptions<'_>) -> Result<Bytes, MessageFormError>;

    /// A JSON text read as a message of it (5.2), encoded: a caller's result, an event's data.
    ///
    /// # Errors
    ///
    /// What the mapping refuses.
    fn read(&self, body: &[u8]) -> Result<Bytes, MessageFormError>;

    /// A payload read by its stock library, then written in Bead's proto JSON form (5.6, 5.7),
    /// whole or its top-level field (5.8): read once.
    ///
    /// # Errors
    ///
    /// [`MessageFormError::Undecodable`] for a payload its stock library refuses,
    /// [`MessageFormError::Form`] for one the mapping holds no form of.
    fn write(&self, payload: &[u8], field: Option<&str>) -> Result<String, MessageFormError>;

    /// Where a violation's field path lies in a request bound by `route` (7.4), by JSON names;
    /// none where it lies nowhere a request carries.
    fn place_of(&self, field_path: &str, route: &HttpRouteTemplate) -> Option<RequestPlace>;
}
