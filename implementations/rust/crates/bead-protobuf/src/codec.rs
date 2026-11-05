//! The runtime codecs of a `proto` message (spec 17.9, decision 0042), which hold 17.9 once: its
//! records checked against its schema before Buffa reads them (decision 0028), a singular closed
//! enum's undeclared number dropped before Buffa reads (17.9.8), the bound of 17.9.3 set in the
//! call, then the message refused where it leaves a required field unset (17.9.7).
//! A value is written as its reader would read it (17.2, decision 0031): refused before Buffa
//! writes any of it where its known fields nest past the bound, or the same walk finds a required
//! field unset; then its bytes checked as a reader checks them, which refuses what a reading kept
//! nesting past the bound. Each refusal says its reason in 17.2's words, Buffa's own error or what
//! Bead found in its cause. The TypeScript side's twin is `protoCodecOf`, the C# side's
//! `ProtoCodecs`.

use core::fmt;
use core::marker::PhantomData;
use std::sync::Arc;

use bead::{CodecRefusal, PayloadCodec};
use buffa::{DecodeError, DecodeOptions, EncodeError, HasMessageView, MessageView};
use buffa_descriptor::reflect::{DynamicMessage, ReflectMessage};
use buffa_descriptor::{DescriptorPool, MessageIndex};
use bytes::Bytes;

use crate::records::{DEPTH, ProtoSchema, check_records, filtered};
use crate::refusal::{NOT_ITS_MESSAGE, found, refusal};
use crate::required::{Presence, bounded, checked};

#[cfg(test)]
mod tests;

/// The encoding both codecs are of, as a blueprint names it.
pub const ENCODING: &str = "proto";

// * Buffa's view and dynamic message decoded within 17.9.3's bound, Buffa counting the messages
// below the top one; its own budgets of unknown fields and of elements lifted, as neither other
// side's library holds one: the procedure's payload limit bounds a payload
fn decode_options() -> DecodeOptions {
    DecodeOptions::new()
        .with_recursion_limit(DEPTH)
        .with_unknown_field_limit(usize::MAX)
        .with_element_memory_limit(usize::MAX)
}

// Buffa's refusal of bytes past the records' check, its error the cause
fn refused(error: DecodeError) -> CodecRefusal {
    refusal(NOT_ITS_MESSAGE, error)
}

// a message past protobuf's 2 GiB, which no payload's limit takes: no encoding of it
fn unwritten(error: EncodeError) -> CodecRefusal {
    refusal(NOT_ITS_MESSAGE, error)
}

// * what a writer writes, its reader reads (17.2): the bytes Buffa wrote checked as a reader checks
// them, its refusal the writer's, in its words; past the depth pass, it refuses what a reading
// kept nesting past the bound, an unknown group or an extension's message
fn read_back(bytes: Vec<u8>, schema: &ProtoSchema) -> Result<Bytes, CodecRefusal> {
    check_records(&bytes, schema)?;

    Ok(Bytes::from(bytes))
}

// ── Typed ─────────────────────────────────────────────────────────────────────

/// The codec of `M`, a message Buffa generated as `bead_protobuf_build` sets its generator.
///
/// Its reading checks a payload's records, drops a singular closed enum's undeclared number,
/// decodes `M`'s view within the bound, walks the view's required fields, then gives the owned
/// message; its writing bounds its depth, walks its required fields, writes it, then checks its
/// bytes as its reading does. An owned message holds a required scalar or enum bare and a closed
/// enum as its Rust enum, so no value of `M` leaves such a field unset or holds a number its enum
/// does not declare: the type makes the fault impossible rather than hiding it. A required message
/// it holds as a field set or not, which the walk refuses unset before anything is written.
/// [`DynamicCodec`] writes the forms `M` cannot hold.
pub struct ProtoCodec<M> {
    schema: ProtoSchema,
    of: PhantomData<fn() -> M>,
}

impl<M: ReflectMessage + Default> ProtoCodec<M> {
    /// The codec of `M`, by the pool its code embeds.
    #[must_use]
    pub fn new() -> Self {
        Self {
            schema: ProtoSchema::of::<M>(),
            of: PhantomData,
        }
    }
}

impl<M: ReflectMessage + Default> Default for ProtoCodec<M> {
    fn default() -> Self {
        Self::new()
    }
}

impl<M> ProtoCodec<M> {
    /// Its message's schema.
    #[must_use]
    pub fn schema(&self) -> &ProtoSchema {
        &self.schema
    }
}

impl<M> Clone for ProtoCodec<M> {
    fn clone(&self) -> Self {
        Self {
            schema: self.schema.clone(),
            of: PhantomData,
        }
    }
}

impl<M> fmt::Debug for ProtoCodec<M> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProtoCodec")
            .field(&self.schema)
            .finish()
    }
}

impl<M> PayloadCodec for ProtoCodec<M>
where
    M: HasMessageView + ReflectMessage + 'static,
    for<'a> M::View<'a>: ReflectMessage,
{
    type Value = M;

    fn decode(&self, bytes: &Bytes) -> Result<M, CodecRefusal> {
        // ! the check first: it refuses what protobuf refuses where Buffa reads on (decision 0028),
        // and drops what Buffa would set aside among the unknown fields (17.9.8)
        let bytes = filtered(bytes, &self.schema)?;
        let view: M::View<'_> = decode_options().decode_view(&bytes).map_err(refused)?;

        // ! the view's presence is the wire's, merged as protobuf merges a message given twice
        checked(&view, (&self.schema, Presence::Read))?;

        view.to_owned_message().map_err(refused)
    }

    fn encode(&self, value: &M) -> Result<Bytes, CodecRefusal> {
        // ! the depth pass first: past it, no walk and no write of Buffa's recurses past the bound
        bounded(value, &self.schema)?;
        checked(value, (&self.schema, Presence::Held))?;

        read_back(value.try_encode_to_vec().map_err(unwritten)?, &self.schema)
    }

    fn encoding(&self) -> &'static str {
        ENCODING
    }
}

// ── Dynamic ───────────────────────────────────────────────────────────────────

/// The codec of a message by its descriptor alone, its value Buffa's [`DynamicMessage`].
///
/// Its reading checks a payload's records, drops a singular closed enum's undeclared number,
/// decodes the dynamic message within the bound and walks its required fields; its writing bounds
/// its depth, walks them, writes it, then checks its bytes as its reading does. A dynamic message
/// holds a field set or not, a required one among them, and any number of a closed enum, so its
/// writer refuses what a typed message cannot hold. The pool is the one the message's generated
/// code embeds, where it has some: it carries the generator's opening of a closed enum's repeated
/// and map fields.
#[derive(Debug, Clone)]
pub struct DynamicCodec {
    schema: ProtoSchema,
}

impl DynamicCodec {
    /// The codec of the message `message` of `pool`, an index the pool gave.
    #[must_use]
    pub fn new(pool: Arc<DescriptorPool>, message: MessageIndex) -> Self {
        Self {
            schema: ProtoSchema::new(pool, message),
        }
    }

    /// Its message's schema.
    #[must_use]
    pub fn schema(&self) -> &ProtoSchema {
        &self.schema
    }
}

impl PayloadCodec for DynamicCodec {
    type Value = DynamicMessage;

    fn decode(&self, bytes: &Bytes) -> Result<DynamicMessage, CodecRefusal> {
        let bytes = filtered(bytes, &self.schema)?;
        let message = DynamicMessage::decode_with_options(
            Arc::clone(self.schema.pool()),
            self.schema.message(),
            &bytes,
            &decode_options(),
        )
        .map_err(refused)?;

        checked(&message, (&self.schema, Presence::Read))?;

        Ok(message)
    }

    fn encode(&self, value: &DynamicMessage) -> Result<Bytes, CodecRefusal> {
        // ! the walk reads a message by the schema's descriptors: one of another message is refused
        if !Arc::ptr_eq(value.pool(), self.schema.pool())
            || value.message_index() != self.schema.message()
        {
            return Err(found(
                NOT_ITS_MESSAGE,
                format!(
                    "a proto value of {}, where its codec writes {}",
                    value.message_descriptor().full_name(),
                    self.schema.root().full_name
                ),
            ));
        }

        bounded(value, &self.schema)?;
        checked(value, (&self.schema, Presence::Given))?;

        read_back(value.try_encode_to_vec().map_err(unwritten)?, &self.schema)
    }

    fn encoding(&self) -> &'static str {
        ENCODING
    }
}
