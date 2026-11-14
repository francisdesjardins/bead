//! Bead's own mapping of protobuf's JSON (spec/transcoding.md 5, decisions 0037 and 0052), under
//! the feature `transcoding`: a `proto` body read over its message's descriptor into the binary
//! payload its stock library reads, and a result's payload, read by its stock library, written in
//! Bead's proto JSON form; one sequence of bytes on every side. Buffa's own JSON is not used: its
//! reading and its writing part from the mapping where the stock libraries part (5.3 to 5.7).

mod base64;
mod read;
pub(crate) mod text;
mod wellknown;
mod write;

#[cfg(test)]
mod tests;

use core::fmt;
use std::rc::Rc;
use std::sync::Arc;

use bead::internal::{RoutedFieldPath, place_by};
use bead::{
    BindingOptions, HttpRouteTemplate, JsonFormError, MessageForm, MessageFormError,
    ProgrammerError, RequestPlace,
};
use buffa_descriptor::reflect::DynamicMessage;
use buffa_descriptor::{
    DescriptorPool, FieldDescriptor, FieldKind, MessageDescriptor, MessageIndex, SingularKind,
};
use bytes::Bytes;

use crate::records::{DEPTH, ProtoSchema, filtered};
use crate::refusal::{NOT_ITS_MESSAGE, refusal};
use crate::required::{Presence, checked};

pub(crate) use read::{judge_unset, put, read_draft, read_message};
pub(crate) use text::{Node, read_text};
pub(crate) use write::write_message;

/// How deep a message nests below the one read or written, as spec 17.9.3 counts it.
pub(crate) const MAXIMUM_DEPTH: u32 = DEPTH;

/// How deep a JSON text nests at most before its message is read: two levels a message, an array of
/// a repeated field and the object of each item, for 100 below the request and the request's own.
pub(crate) const TEXT_DEPTH: u32 = 2 * (MAXIMUM_DEPTH + 1);

// the bytes of UTF-8 a key of the request is written whole within (spec 18.4)
const KEY_BYTES: usize = 64;

// ── Places ────────────────────────────────────────────────────────────────────

/// A token of a place in a JSON value: a field's JSON name, an item's index, or a member's name or a
/// key the request carried, which a parameter cuts and a pointer stops before past 64 bytes of
/// UTF-8 (7.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Token {
    pub(crate) is_given: bool,
    pub(crate) text: String,
}

// a step of a place, below the one before it
#[derive(Debug)]
pub(crate) struct Step {
    token: Token,
    up: At,
}

/// Where a reading is in the value it reads: the value itself, by default, or a token below a place.
#[derive(Debug, Clone, Default)]
pub(crate) struct At(Option<Rc<Step>>);

fn below(at: &At, token: Token) -> Rc<Step> {
    Rc::new(Step {
        token,
        up: at.clone(),
    })
}

/// A field's place below `at`, by its JSON name.
pub(crate) fn field_at(at: &At, name: &str) -> At {
    At(Some(below(
        at,
        Token {
            is_given: false,
            text: name.to_owned(),
        },
    )))
}

/// A member's or a key's place below `at`, as the request carried it.
pub(crate) fn given_at(at: &At, name: &str) -> At {
    At(Some(below(
        at,
        Token {
            is_given: true,
            text: name.to_owned(),
        },
    )))
}

/// An item's place below `at`, by its index.
pub(crate) fn item_at(at: &At, index: usize) -> At {
    At(Some(below(
        at,
        Token {
            is_given: false,
            text: index.to_string(),
        },
    )))
}

// a place's tokens, from the value read
fn tokens_of(at: &At) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut step = at.0.as_ref();

    while let Some(held) = step {
        tokens.push(held.token.clone());
        step = held.up.0.as_ref();
    }

    tokens.reverse();
    tokens
}

/// A name or a key the request carried, cut as spec 18.4 cuts a key: whole within 64 bytes of
/// UTF-8, else its first 64, back to the start of the character the cut fell in, and `...` after.
pub(crate) fn cut_of(text: &str) -> String {
    if text.len() <= KEY_BYTES {
        return text.to_owned();
    }

    let mut end = KEY_BYTES;

    while !text.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }

    format!("{}...", text.get(..end).unwrap_or_default())
}

/// A place's JSON Pointer, as a URI's fragment (RFC 6901 §6): `#`, then each token after a `/`, up
/// to the value that holds a name or a key the request carried past 64 bytes of UTF-8, which a
/// pointer never cuts (7.4).
pub(crate) fn pointer_of(tokens: &[Token]) -> String {
    let mut pointer = "#".to_owned();

    for Token { is_given, text } in tokens {
        if *is_given && text.len() > KEY_BYTES {
            break;
        }

        pointer.push('/');
        pointer.push_str(&bead::internal::fragment_of(
            &bead::internal::pointer_token_of(text),
        ));
    }

    pointer
}

// ── Refusals ──────────────────────────────────────────────────────────────────

/// A reading's or a writing's refusal: its reason, the mapping's own words; where the reading met
/// it, none for its text's own; whether it is a required field unset (5.2, step 4); and where its
/// request carried it, which a binding gives it (7.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Refusal {
    reason: String,
    at: Option<Vec<Token>>,
    is_unset: bool,
    place: Option<RequestPlace>,
}

impl Refusal {
    pub(crate) fn new<R: Into<String>>(reason: R) -> Self {
        Self {
            reason: reason.into(),
            at: None,
            is_unset: false,
            place: None,
        }
    }

    /// The same refusal, met at `at`.
    pub(crate) fn at(mut self, at: &At) -> Self {
        self.at = Some(tokens_of(at));
        self
    }

    /// The same refusal, a required field unset.
    pub(crate) const fn unset(mut self) -> Self {
        self.is_unset = true;
        self
    }

    /// The same refusal, carried at `place` of the request.
    pub(crate) fn placed(mut self, place: RequestPlace) -> Self {
        self.place = Some(place);
        self
    }

    #[cfg(test)]
    pub(crate) fn reason(&self) -> &str {
        &self.reason
    }

    pub(crate) fn tokens(&self) -> Option<&[Token]> {
        self.at.as_deref()
    }

    pub(crate) const fn is_unset(&self) -> bool {
        self.is_unset
    }

    /// Its place's pointer, the value read the body whole; none where the reading met it nowhere.
    pub(crate) fn pointer(&self) -> Option<String> {
        self.at.as_deref().map(pointer_of)
    }

    /// The form's error it is: its words, at its place in the request, else its pointer.
    pub(crate) fn into_error(self) -> JsonFormError {
        let place = self
            .place
            .clone()
            .or_else(|| self.pointer().map(RequestPlace::Pointer));
        let error = JsonFormError::new(self.reason);

        match place {
            Some(place) => error.at(place),
            None => error,
        }
    }
}

/// The refusal of a value nested past 17.9.3's bound.
pub(crate) fn nested_past() -> Refusal {
    Refusal::new(format!("nested past {MAXIMUM_DEPTH}"))
}

/// The article a type's name takes, as it is read aloud: `an int32`, `an sint32`, `an Edges`, `an
/// Empty`; `a uint32`, `a fixed32`, `a Timestamp`.
pub(crate) fn article_of(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();

    if lower.starts_with(['a', 'e', 'i', 'o'])
        || lower.starts_with("sint")
        || lower.starts_with("sfixed")
    {
        "an"
    } else {
        "a"
    }
}

/// A message's name, the last of its full name.
pub(crate) fn short_name(full_name: &str) -> &str {
    full_name.rsplit('.').next().unwrap_or(full_name)
}

// ── Fields ────────────────────────────────────────────────────────────────────

/// The field of `message` a member names, by its JSON name or its proto name; none for no field.
pub(crate) fn field_named<'a>(
    message: &'a MessageDescriptor,
    name: &str,
) -> Option<&'a FieldDescriptor> {
    message
        .fields()
        .iter()
        .find(|field| field.json_name() == name || field.name() == name)
}

/// The message a field holds, or each item or value of a repeated or a map field.
pub(crate) fn message_of_field(field: &FieldDescriptor) -> Option<MessageIndex> {
    match field.kind() {
        FieldKind::Singular(SingularKind::Message(index))
        | FieldKind::List(SingularKind::Message(index))
        | FieldKind::Map {
            value: SingularKind::Message(index),
            ..
        } => Some(index),
        FieldKind::Singular(SingularKind::Scalar(_) | SingularKind::Enum(_))
        | FieldKind::List(SingularKind::Scalar(_) | SingularKind::Enum(_))
        | FieldKind::Map {
            value: SingularKind::Scalar(_) | SingularKind::Enum(_),
            ..
        } => None,
    }
}

/// Whether `field` is a member of one of `message`'s oneofs, which no proto3 `optional` is.
pub(crate) fn is_in_oneof(message: &MessageDescriptor, field: &FieldDescriptor) -> bool {
    field
        .oneof_index()
        .and_then(|index| message.oneofs().get(usize::from(index)))
        .is_some_and(|oneof| !oneof.is_synthetic())
}

/// Whether `message` is a wrapper: a well-known `…Value` of one scalar field.
pub(crate) fn is_wrapper(message: &MessageDescriptor) -> bool {
    let name = message.full_name();

    name.starts_with("google.protobuf.")
        && name.ends_with("Value")
        && matches!(
            message.fields(),
            [field] if matches!(field.kind(), FieldKind::Singular(SingularKind::Scalar(_)))
        )
}

/// The well-known types whose JSON is a form of their own, under an `Any`'s `value` (5.4.6).
pub(crate) fn is_own_form(full_name: &str) -> bool {
    matches!(
        full_name,
        "google.protobuf.Any"
            | "google.protobuf.BoolValue"
            | "google.protobuf.BytesValue"
            | "google.protobuf.DoubleValue"
            | "google.protobuf.Duration"
            | "google.protobuf.FieldMask"
            | "google.protobuf.FloatValue"
            | "google.protobuf.Int32Value"
            | "google.protobuf.Int64Value"
            | "google.protobuf.ListValue"
            | "google.protobuf.StringValue"
            | "google.protobuf.Struct"
            | "google.protobuf.Timestamp"
            | "google.protobuf.UInt32Value"
            | "google.protobuf.UInt64Value"
            | "google.protobuf.Value"
    )
}

// ── The form ──────────────────────────────────────────────────────────────────

/// Bead's mapping of protobuf's JSON (transcoding 5, decision 0052), made over a pool: each message
/// of it read from a body and written from a payload, an `Any` naming a message the pool holds.
///
/// One form an output, over the pool its messages embed; [`form_of`](Self::form_of) gives each
/// route's message its [`MessageForm`], which a gateway binds and writes by and a caller writes
/// and reads by.
#[derive(Clone)]
pub struct JsonForm {
    pool: Arc<DescriptorPool>,
}

impl fmt::Debug for JsonForm {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JsonForm")
            .field("messages", &self.pool.messages().len())
            .finish()
    }
}

impl JsonForm {
    /// The form of every message of `pool`: the pool an output's messages embed.
    #[must_use]
    pub fn new(pool: Arc<DescriptorPool>) -> Self {
        Self { pool }
    }

    /// The form of `schema`'s message: its JSON read into its payload and its payload written as
    /// its JSON, each `Any` among it naming a message of this form's pool.
    ///
    /// A schema of another pool is taken over this form's, by its message's full name, where this
    /// form's pool holds it, so an `Any` among it names a message of the one pool.
    #[must_use]
    pub fn form_of(&self, schema: ProtoSchema) -> Arc<dyn MessageForm> {
        let full_name = schema.root().full_name.clone();
        let schema = if Arc::ptr_eq(schema.pool(), &self.pool) {
            schema
        } else {
            self.pool.message_index(&full_name).map_or(schema, |index| {
                ProtoSchema::new(Arc::clone(&self.pool), index)
            })
        };

        Arc::new(MessageJsonForm { full_name, schema })
    }
}

/// One message's form, which [`JsonForm::form_of`] gives.
pub(crate) struct MessageJsonForm {
    full_name: String,
    schema: ProtoSchema,
}

impl fmt::Debug for MessageJsonForm {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MessageJsonForm")
            .field("message", &self.full_name)
            .finish_non_exhaustive()
    }
}

/// A message's payload, its bytes encoded.
pub(crate) fn encoded(message: &DynamicMessage) -> Result<Bytes, MessageFormError> {
    message
        .try_encode_to_vec()
        .map(Bytes::from)
        .map_err(|error| MessageFormError::Undecodable(refusal(NOT_ITS_MESSAGE, error)))
}

impl MessageJsonForm {
    pub(crate) const fn schema(&self) -> &ProtoSchema {
        &self.schema
    }

    // the payload read by its stock library, its records checked and its required fields judged
    fn decoded(&self, payload: &[u8]) -> Result<DynamicMessage, MessageFormError> {
        let bytes = filtered(payload, &self.schema).map_err(MessageFormError::Undecodable)?;
        let message = DynamicMessage::decode_with_options(
            Arc::clone(self.schema.pool()),
            self.schema.message(),
            &bytes,
            &crate::codec::decode_options(),
        )
        .map_err(|error| MessageFormError::Undecodable(refusal(NOT_ITS_MESSAGE, error)))?;

        checked(&message, (&self.schema, Presence::Read)).map_err(MessageFormError::Undecodable)?;

        Ok(message)
    }
}

impl MessageForm for MessageJsonForm {
    fn full_name(&self) -> &str {
        &self.full_name
    }

    fn bind(&self, options: &BindingOptions<'_>) -> Result<Bytes, MessageFormError> {
        crate::binding::bind(self, options)
    }

    fn read(&self, body: &[u8]) -> Result<Bytes, MessageFormError> {
        let message = read_text(body)
            .and_then(|node| read_message(&self.schema, &node))
            .map_err(|refused| MessageFormError::Form(refused.into_error()))?;

        encoded(&message)
    }

    fn write(&self, payload: &[u8], field: Option<&str>) -> Result<String, MessageFormError> {
        let message = self.decoded(payload)?;
        let written = match field {
            None => write_message(&message, &self.schema),
            Some(name) => {
                let descriptor = self.schema.pool().message(self.schema.message());
                let field = descriptor
                    .fields()
                    .iter()
                    .find(|field| field.name() == name)
                    .ok_or_else(|| {
                        MessageFormError::Programmer(ProgrammerError::new(format!(
                            "{} has no field {name}",
                            self.full_name
                        )))
                    })?;

                write::write_field(&message, (field, &self.schema))
            }
        };

        written.map_err(|refused| MessageFormError::Form(refused.into_error()))
    }

    fn place_of(&self, field_path: &str, route: &HttpRouteTemplate) -> Option<RequestPlace> {
        let mut at = Some(self.schema.message());

        place_by(&RoutedFieldPath { field_path, route }, &mut |name| {
            let message = self.schema.pool().message(at?);
            let field = field_named(message, name)?;

            at = message_of_field(field);
            Some(field.json_name().to_owned())
        })
    }
}
