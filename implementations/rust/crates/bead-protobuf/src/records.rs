//! A `proto` payload's records, read against its message before Buffa reads them (spec 17.9,
//! decision 0028): the check that refuses what protobuf refuses where a stock library reads on, and
//! reads nothing in the library's place. It walks the payload once, by its message's schema, and
//! allocates nothing per record. The schema holds what the required walk takes too (17.9.7): each
//! message's fields protobuf requires, and those that hold a message reaching one. The TypeScript
//! side's twin is `checkProtoRecords`, the C# side's `ProtoRecords`.

use core::fmt;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use bead::CodecRefusal;
use buffa::editions::FieldPresence;
use buffa_descriptor::generated::descriptor::feature_set;
use buffa_descriptor::reflect::ReflectMessage;
use buffa_descriptor::{
    DescriptorPool, FieldDescriptor, FieldKind, MessageIndex, ScalarType, SingularKind,
};

#[cfg(test)]
mod tests;

// the wire types of protobuf's Encoding guide, "Message Structure"
const VARINT: u32 = 0;
const I64: u32 = 1;
const LEN: u32 = 2;
const SGROUP: u32 = 3;
const EGROUP: u32 = 4;
const I32: u32 = 5;

/// How deep a message nests below the top one, a group and a map's entry each a message (spec
/// 17.9.3).
pub(crate) const DEPTH: u32 = 100;

// a frame's group, where it is no group
const NO_GROUP: u32 = 0;

// an unknown group's shape, and a message's the schema does not hold: every field it holds unknown
static UNKNOWN: Shape = Shape {
    full_name: String::new(),
    fields: Vec::new(),
    required: Vec::new(),
    holding: Vec::new(),
    reaches: false,
};

// ── The schema ────────────────────────────────────────────────────────────────

/// A message's schema: what the records check and the required walk take of it and of each
/// message its pool holds, read once from the pool's descriptors and shared by every clone.
#[derive(Clone)]
pub struct ProtoSchema {
    shapes: Arc<Shapes>,
    message: MessageIndex,
}

impl ProtoSchema {
    /// The schema of the message `message` of `pool`, an index the pool gave.
    #[must_use]
    pub fn new(pool: Arc<DescriptorPool>, message: MessageIndex) -> Self {
        Self {
            shapes: Arc::new(Shapes::of(pool)),
            message,
        }
    }

    /// The schema of `M`, a message Buffa generated with reflection, by the pool its code embeds.
    #[must_use]
    pub fn of<M: ReflectMessage + Default>() -> Self {
        let message = M::default().to_dynamic();

        Self::new(Arc::clone(message.pool()), message.message_index())
    }

    /// The pool its descriptors are read from.
    #[must_use]
    pub fn pool(&self) -> &Arc<DescriptorPool> {
        &self.shapes.pool
    }

    /// Its message, by its index in [`pool`](Self::pool).
    #[must_use]
    pub fn message(&self) -> MessageIndex {
        self.message
    }

    /// The shape of its message.
    pub(crate) fn root(&self) -> &Shape {
        self.shape(self.message)
    }

    /// The shape of the message `index` of its pool, an unknown group's where it holds none.
    pub(crate) fn shape(&self, index: MessageIndex) -> &Shape {
        self.shapes.by_message.get(&index).unwrap_or(&UNKNOWN)
    }
}

impl fmt::Debug for ProtoSchema {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProtoSchema")
            .field("message", &self.root().full_name)
            .finish_non_exhaustive()
    }
}

// each message of a pool's shape, by its index
struct Shapes {
    pool: Arc<DescriptorPool>,
    by_message: HashMap<MessageIndex, Shape>,
}

impl Shapes {
    // every message's shape, then which of them reach a required field: those that have one, then
    // those that hold one that does, grown until none is added, cycles among them
    fn of(pool: Arc<DescriptorPool>) -> Self {
        let mut by_message = HashMap::new();
        let mut holds: HashMap<MessageIndex, Vec<MessageIndex>> = HashMap::new();

        for message in pool.messages() {
            let Some(index) = pool.message_index(message.full_name()) else {
                continue;
            };
            let mut fields: Vec<(u32, FieldShape)> = message
                .fields()
                .iter()
                .map(|field| (field.number(), FieldShape::of(field)))
                .collect();
            let mut required: Vec<FieldDescriptor> = message
                .fields()
                .iter()
                .filter(|field| is_required(field))
                .cloned()
                .collect();

            fields.sort_by_key(|(number, _)| *number);
            required.sort_by_key(FieldDescriptor::number);
            holds.insert(index, message.fields().iter().filter_map(held_of).collect());
            by_message.insert(
                index,
                Shape {
                    full_name: message.full_name().to_owned(),
                    fields,
                    required,
                    holding: Vec::new(),
                    reaches: false,
                },
            );
        }

        let mut reaching: HashSet<MessageIndex> = by_message
            .iter()
            .filter(|(_, shape)| !shape.required.is_empty())
            .map(|(index, _)| *index)
            .collect();

        loop {
            let grown: Vec<MessageIndex> = holds
                .iter()
                .filter(|(index, held)| {
                    !reaching.contains(*index) && held.iter().any(|each| reaching.contains(each))
                })
                .map(|(index, _)| *index)
                .collect();

            if grown.is_empty() {
                break;
            }

            reaching.extend(grown);
        }

        for message in pool.messages() {
            let Some(index) = pool.message_index(message.full_name()) else {
                continue;
            };
            let mut holding: Vec<Holding> = message
                .fields()
                .iter()
                .filter_map(Holding::of)
                .filter(|holding| reaching.contains(&holding.held))
                .collect();

            holding.sort_by_key(|holding| holding.field.number());

            if let Some(shape) = by_message.get_mut(&index) {
                shape.reaches = reaching.contains(&index);
                shape.holding = holding;
            }
        }

        Self { pool, by_message }
    }
}

// whether a field is of LEGACY_REQUIRED presence: proto2's `required`, or an edition's feature
fn is_required(field: &FieldDescriptor) -> bool {
    // ! Buffa reads an edition's singular message field as of explicit presence whatever its
    // features say: its own feature, the one place protoc lets LEGACY_REQUIRED be set, is read here
    field.presence() == FieldPresence::LegacyRequired
        || field
            .options()
            .and_then(|options| options.features.as_option())
            .and_then(|features| features.field_presence)
            == Some(feature_set::FieldPresence::LEGACY_REQUIRED)
}

// the message a field holds: its own, an item's, or a map's value's; none for a scalar or an enum
fn held_of(field: &FieldDescriptor) -> Option<MessageIndex> {
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

/// A message's shape: its fields by their numbers, each what its records take; its fields
/// protobuf requires, by their numbers; those that hold a message reaching one; and whether it, or
/// a message it holds at any depth, has one.
#[derive(Debug)]
pub(crate) struct Shape {
    /// Its full name.
    pub(crate) full_name: String,
    fields: Vec<(u32, FieldShape)>,
    /// Its fields of `LEGACY_REQUIRED` presence, by their numbers.
    pub(crate) required: Vec<FieldDescriptor>,
    /// Its fields that hold a message reaching a required field, by their numbers.
    pub(crate) holding: Vec<Holding>,
    /// Whether it reaches a required field.
    pub(crate) reaches: bool,
}

impl Shape {
    /// What a record of its field `number` takes; none where it declares no such field.
    pub(crate) fn field(&self, number: u32) -> Option<FieldShape> {
        self.fields
            .binary_search_by_key(&number, |(each, _)| *each)
            .ok()
            .and_then(|at| self.fields.get(at))
            .map(|(_, shape)| *shape)
    }
}

/// A field that holds a message reaching a required field, and how it holds it.
#[derive(Debug)]
pub(crate) struct Holding {
    /// The field.
    pub(crate) field: FieldDescriptor,
    /// The message it holds.
    pub(crate) held: MessageIndex,
    /// How: one, a list of them, or a map's values.
    pub(crate) form: Form,
}

impl Holding {
    fn of(field: &FieldDescriptor) -> Option<Self> {
        let held = held_of(field)?;
        let form = match field.kind() {
            FieldKind::Singular(_) => Form::Singular,
            FieldKind::List(_) => Form::List,
            FieldKind::Map { .. } => Form::Map,
        };

        Some(Self {
            field: field.clone(),
            held,
            form,
        })
    }
}

/// How a field holds a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Form {
    /// One message.
    Singular,
    /// A repeated field's items.
    List,
    /// A map's values.
    Map,
}

/// What a record of a field takes: its own wire type, the length-delimited one besides where it
/// packs, and the message it holds, an entry's of a map's among them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FieldShape {
    own: u32,
    packs: Packs,
    /// The message a record of it holds, or a map's entry; none for a scalar or an enum.
    pub(crate) holds: Option<Holds>,
}

/// What a packed record of a field holds: none, varints, or values of a fixed width.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Packs {
    No,
    Varints,
    Fixed(usize),
}

/// The message a record holds: one of the pool's, or a map's entry, its key at 1 and its value at
/// 2 (Encoding, "Maps").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Holds {
    /// A message of the pool.
    Message(MessageIndex),
    /// A map's entry.
    Entry {
        /// Its key's type.
        key: ScalarType,
        /// Its value's.
        value: SingularKind,
    },
}

impl FieldShape {
    fn of(field: &FieldDescriptor) -> Self {
        let shape = match field.kind() {
            FieldKind::Singular(kind) => Self::of_kind(kind, false),
            FieldKind::List(kind) => Self::of_kind(kind, true),
            FieldKind::Map { key, value } => Self {
                own: LEN,
                packs: Packs::No,
                holds: Some(Holds::Entry { key, value }),
            },
        };

        // * a message of DELIMITED encoding, a proto2 group among them, is a group on the wire
        if field.is_delimited() && matches!(shape.holds, Some(Holds::Message(_))) {
            return Self {
                own: SGROUP,
                ..shape
            };
        }

        shape
    }

    fn of_kind(kind: SingularKind, is_repeated: bool) -> Self {
        match kind {
            SingularKind::Scalar(scalar) => Self::of_scalar(wire_of(scalar), is_repeated),
            SingularKind::Enum(_) => Self::of_scalar(VARINT, is_repeated),
            SingularKind::Message(index) => Self {
                own: LEN,
                packs: Packs::No,
                holds: Some(Holds::Message(index)),
            },
        }
    }

    // * a repeated scalar of a numeric type takes its own wire type and the length-delimited, packed
    // or not, as protobuf's parsers must (Encoding, "Packed Repeated Fields")
    fn of_scalar(own: u32, is_repeated: bool) -> Self {
        let packs = match own {
            VARINT if is_repeated => Packs::Varints,
            I64 if is_repeated => Packs::Fixed(8),
            I32 if is_repeated => Packs::Fixed(4),
            _ => Packs::No,
        };

        Self {
            own,
            packs,
            holds: None,
        }
    }

    // whether a record at `wire` is one of its type's
    fn takes(self, wire: u32) -> bool {
        wire == self.own || (self.packs != Packs::No && wire == LEN)
    }
}

fn wire_of(scalar: ScalarType) -> u32 {
    match scalar {
        ScalarType::Double | ScalarType::Fixed64 | ScalarType::Sfixed64 => I64,
        ScalarType::Float | ScalarType::Fixed32 | ScalarType::Sfixed32 => I32,
        ScalarType::String | ScalarType::Bytes => LEN,
        ScalarType::Int64
        | ScalarType::Uint64
        | ScalarType::Int32
        | ScalarType::Bool
        | ScalarType::Uint32
        | ScalarType::Sint32
        | ScalarType::Sint64 => VARINT,
    }
}

// ── The check ─────────────────────────────────────────────────────────────────

/// Checks `bytes` against the records of `schema`'s message, at every depth.
///
/// Refused: a tag of more than 5 bytes, past 32 bits or of field number 0; a varint of more than
/// 10 bytes; a length
/// past the bytes that follow it; a record past the end of its message; a packed record whose
/// values do not end at its length; a group closed by another number's end group or never closed,
/// an end group that closes none, and the wire types 6 and 7; a message nested more than 100 deep
/// below the top one (17.9.3); a field the message declares at a wire type its type does not take
/// (17.9.5); and a map's entry with a field other than its key and its value (17.9.6). An unknown
/// length-delimited record is opaque, as protobuf keeps it.
///
/// # Errors
///
/// A [`CodecRefusal`] for bytes that are no encoding of the message, or nest too deep.
pub fn check_records(bytes: &[u8], schema: &ProtoSchema) -> Result<(), CodecRefusal> {
    let mut reader = Reader {
        schema,
        bytes,
        at: 0,
    };

    reader.message(
        Some(Holds::Message(schema.message)),
        Frame {
            end: bytes.len(),
            depth: 0,
            group: NO_GROUP,
        },
    )
}

// where a message's records end, how deep it is below the top one, and the number of the group it
// is, or NO_GROUP
#[derive(Debug, Clone, Copy)]
struct Frame {
    end: usize,
    depth: u32,
    group: u32,
}

impl Frame {
    // the depth of what a record of this frame holds
    fn deeper(self) -> Result<u32, CodecRefusal> {
        if self.depth >= DEPTH {
            return Err(CodecRefusal::new(format!(
                "a proto payload nests a message more than {DEPTH} deep below the top one"
            )));
        }

        Ok(self.depth.saturating_add(1))
    }
}

fn refused(reason: &str) -> CodecRefusal {
    CodecRefusal::new(format!("a proto payload is not its message: {reason}"))
}

// one walk of a payload, its position moving over its bytes
struct Reader<'a> {
    schema: &'a ProtoSchema,
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    // the records of a message, up to its end or to the end group that closes it; within an
    // unknown group where it holds no message the schema knows
    fn message(&mut self, within: Option<Holds>, frame: Frame) -> Result<(), CodecRefusal> {
        while self.at < frame.end {
            let tag = self.tag(frame.end)?;
            let number = tag >> 3;
            let wire = tag & 7;

            if number == 0 {
                return Err(refused("field number 0"));
            }

            if wire == EGROUP {
                if number == frame.group {
                    return Ok(());
                }

                return Err(refused("an end group that closes no group open"));
            }

            let field = self.field_of(within, number);

            // * spec 17.9.6: where protobuf's reference parsers skip it, a stock library reads it
            if field.is_none() && matches!(within, Some(Holds::Entry { .. })) {
                return Err(refused(
                    "a map's entry with a field other than its key and its value",
                ));
            }

            // * spec 17.9.5: where protobuf's reference parsers keep it as unknown, a stock library
            // reads it as its declared type
            if field.is_some_and(|field| !field.takes(wire)) {
                return Err(refused("a field at a wire type its type does not take"));
            }

            self.record(field, (tag, frame))?;
        }

        if frame.group != NO_GROUP {
            return Err(refused("a group never closed"));
        }

        Ok(())
    }

    // what a record of the field `number` takes, within a message, a map's entry or an unknown group
    fn field_of(&self, within: Option<Holds>, number: u32) -> Option<FieldShape> {
        match within? {
            Holds::Message(index) => self.schema.shape(index).field(number),
            Holds::Entry { key, value } => match number {
                1 => Some(FieldShape::of_scalar(wire_of(key), false)),
                2 => Some(FieldShape::of_kind(value, false)),
                _ => None,
            },
        }
    }

    // one record after its tag, of a field the message declares, or none
    fn record(
        &mut self,
        field: Option<FieldShape>,
        (tag, frame): (u32, Frame),
    ) -> Result<(), CodecRefusal> {
        match tag & 7 {
            VARINT => self.varint(frame.end).map(|_| ()),
            I64 => self.skip(8, frame.end),
            I32 => self.skip(4, frame.end),
            LEN => {
                let end = self.length(frame.end)?;

                match field {
                    Some(FieldShape {
                        holds: Some(holds), ..
                    }) => self.message(
                        Some(holds),
                        Frame {
                            end,
                            depth: frame.deeper()?,
                            group: NO_GROUP,
                        },
                    ),
                    Some(FieldShape { packs, .. }) if packs != Packs::No => self.packed(packs, end),
                    // ! an unknown record is opaque, as protobuf keeps it; a string's bytes are its
                    // library's to read
                    Some(_) | None => {
                        self.at = end;

                        Ok(())
                    }
                }
            }
            // * an unknown group is walked as a message every field of which is unknown
            SGROUP => self.message(
                field.and_then(|field| field.holds),
                Frame {
                    end: frame.end,
                    depth: frame.deeper()?,
                    group: tag >> 3,
                },
            ),
            wire => Err(refused(&format!("the wire type {wire}"))),
        }
    }

    // the values of a packed record, which end exactly at its end
    fn packed(&mut self, packs: Packs, end: usize) -> Result<(), CodecRefusal> {
        if let Packs::Fixed(width) = packs {
            if end.saturating_sub(self.at).checked_rem(width) != Some(0) {
                return Err(refused(
                    "a packed record whose values do not end at its length",
                ));
            }

            self.at = end;

            return Ok(());
        }

        // ! a varint that runs past the record's end is refused as cut short
        while self.at < end {
            self.varint(end)?;
        }

        Ok(())
    }

    fn skip(&mut self, count: usize, end: usize) -> Result<(), CodecRefusal> {
        if end.saturating_sub(self.at) < count {
            return Err(refused("a record past the end of its message"));
        }

        self.at = self.at.saturating_add(count);

        Ok(())
    }

    // a length's varint, and where the bytes it counts end, within the message's
    fn length(&mut self, end: usize) -> Result<usize, CodecRefusal> {
        let length = self.varint(end)?;
        let left = end.saturating_sub(self.at);

        match usize::try_from(length) {
            Ok(length) if length <= left => Ok(self.at.saturating_add(length)),
            Ok(_) | Err(_) => Err(refused("a length past the bytes that follow it")),
        }
    }

    // the byte at the reader, within the message's end; the reader moves past it
    fn next(&mut self, end: usize) -> Option<u8> {
        if self.at >= end {
            return None;
        }

        let byte = *self.bytes.get(self.at)?;

        self.at = self.at.saturating_add(1);

        Some(byte)
    }

    // a varint of 10 bytes at most, within the message
    fn varint(&mut self, end: usize) -> Result<u64, CodecRefusal> {
        let mut value = 0_u64;

        for shift in (0..10_u32).map(|place| place.saturating_mul(7)) {
            let byte = self
                .next(end)
                .ok_or_else(|| refused("a varint cut short, or past the end of its message"))?;

            value |= u64::from(byte & 0x7F).checked_shl(shift).unwrap_or(0);

            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }

        Err(refused("a varint of more than 10 bytes"))
    }

    // a tag: a varint of 5 bytes at most, within 32 bits (Encoding, "Message Structure")
    fn tag(&mut self, end: usize) -> Result<u32, CodecRefusal> {
        let mut value = 0_u32;

        for shift in (0..5_u32).map(|place| place.saturating_mul(7)) {
            let byte = self
                .next(end)
                .ok_or_else(|| refused("a tag cut short, or past the end of its message"))?;

            if shift == 28 && byte > 0x0F {
                return Err(refused("a tag of more than 5 bytes, or past 32 bits"));
            }

            value |= u32::from(byte & 0x7F).checked_shl(shift).unwrap_or(0);

            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }

        Err(refused("a tag of more than 5 bytes, or past 32 bits"))
    }
}
