//! A `proto` payload's records, read against its message before Buffa reads them (spec 17.9,
//! decision 0028): the check that refuses what protobuf refuses where a stock library reads on, and
//! reads nothing in the library's place. It walks the payload once, by its message's schema, and
//! allocates nothing per record. Where the walk meets a singular closed enum's record of a number
//! its enum does not declare, the reader is given the payload without it, each enclosing length
//! written again (17.9.8): what protobuf keeps among the unknown fields, Buffa then never reads, as
//! every side drops it. The schema holds what the required walk takes too (17.9.7): each message's
//! fields protobuf requires, and those that hold a message reaching one. The TypeScript side's twin
//! is `checkProtoRecords`, the C# side's `ProtoRecords`.

use core::fmt;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use bead::CodecRefusal;
use buffa::editions::{EnumType, FieldPresence};
use buffa_descriptor::generated::descriptor::feature_set;
use buffa_descriptor::reflect::ReflectMessage;
use buffa_descriptor::{
    DescriptorPool, EnumIndex, FieldDescriptor, FieldKind, MessageIndex, ScalarType, SingularKind,
};

use crate::refusal::{NESTED_PAST_100, NOT_ITS_MESSAGE, found};

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
    nesting: Vec::new(),
    nests_past: false,
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

    /// The schema of the message `message` of its pool, its shapes shared.
    #[cfg(feature = "transcoding")]
    pub(crate) fn at(&self, message: MessageIndex) -> Self {
        Self {
            shapes: Arc::clone(&self.shapes),
            message,
        }
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

            let mut nesting: Vec<Holding> = message
                .fields()
                .iter()
                .filter_map(Holding::nesting)
                .collect();

            fields.sort_by_key(|(number, _)| *number);
            required.sort_by_key(FieldDescriptor::number);
            nesting.sort_by_key(|holding| holding.field.number());
            holds.insert(index, message.fields().iter().filter_map(held_of).collect());
            by_message.insert(
                index,
                Shape {
                    full_name: message.full_name().to_owned(),
                    fields,
                    required,
                    holding: Vec::new(),
                    reaches: false,
                    nesting,
                    nests_past: false,
                },
            );
        }

        let past = nesting_past(&by_message);

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
                .filter(|holding| holding.held.is_some_and(|held| reaching.contains(&held)))
                .collect();

            holding.sort_by_key(|holding| holding.field.number());

            if let Some(shape) = by_message.get_mut(&index) {
                shape.reaches = reaching.contains(&index);
                shape.nests_past = past.contains(&index);
                shape.holding = holding;
            }
        }

        Self { pool, by_message }
    }
}

// the messages whose known fields can nest past the bound, counted as the wire nests: a message
// field, an item and a group one each, a map's entry one and its message value one more; a cycle
// among them nests past. How deep each can nest, at most DEPTH + 1, grows from 0 until none grows,
// so a cycle stops at the cap
fn nesting_past(by_message: &HashMap<MessageIndex, Shape>) -> HashSet<MessageIndex> {
    let cap = DEPTH.saturating_add(1);
    let mut deepest: HashMap<MessageIndex, u32> =
        by_message.keys().map(|index| (*index, 0)).collect();

    loop {
        let mut grown = false;

        for (index, shape) in by_message {
            let deep = shape
                .nesting
                .iter()
                .map(|holding| {
                    let below = holding.held.map_or(0, |held| {
                        deepest.get(&held).copied().unwrap_or(0).saturating_add(1)
                    });

                    match holding.form {
                        Form::Map => below.saturating_add(1),
                        Form::Singular | Form::List => below,
                    }
                })
                .max()
                .unwrap_or(0)
                .min(cap);

            if let Some(was) = deepest.get_mut(index)
                && deep > *was
            {
                *was = deep;
                grown = true;
            }
        }

        if !grown {
            break;
        }
    }

    deepest
        .into_iter()
        .filter(|(_, deep)| *deep > DEPTH)
        .map(|(index, _)| index)
        .collect()
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
/// protobuf requires, by their numbers; those that hold a message reaching one; whether it, or a
/// message it holds at any depth, has one; its fields that nest, a message or a map's entry; and
/// whether they can nest past the bound.
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
    /// Its fields that nest, by their numbers: each that holds a message, and each map.
    pub(crate) nesting: Vec<Holding>,
    /// Whether its known fields can nest a message more than 100 deep below it (17.9.3): a cycle
    /// among them, or a path that deep, a map's entry counting as a message. Sound for keeping a
    /// walk of a value's fields within the bound, never for the bound itself: any message holds
    /// what a reading kept.
    pub(crate) nests_past: bool,
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

/// A field that holds a message, or a map's entries, and how it holds them.
#[derive(Debug)]
pub(crate) struct Holding {
    /// The field.
    pub(crate) field: FieldDescriptor,
    /// The message it holds, a map's value's among them; none for a map of scalars or enums.
    pub(crate) held: Option<MessageIndex>,
    /// How: one, a list of them, or a map's entries.
    pub(crate) form: Form,
}

impl Holding {
    // a field that holds a message, as the required walk takes it
    fn of(field: &FieldDescriptor) -> Option<Self> {
        held_of(field)?;

        Self::nesting(field)
    }

    // a field that nests: one that holds a message, or a map, whose entry is a message on the wire
    fn nesting(field: &FieldDescriptor) -> Option<Self> {
        let form = match field.kind() {
            FieldKind::Singular(SingularKind::Message(_)) => Form::Singular,
            FieldKind::List(SingularKind::Message(_)) => Form::List,
            FieldKind::Map { .. } => Form::Map,
            FieldKind::Singular(SingularKind::Scalar(_) | SingularKind::Enum(_))
            | FieldKind::List(SingularKind::Scalar(_) | SingularKind::Enum(_)) => return None,
        };

        Some(Self {
            field: field.clone(),
            held: held_of(field),
            form,
        })
    }
}

/// How a field holds a message, or a map's entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Form {
    /// One message.
    Singular,
    /// A repeated field's items.
    List,
    /// A map's entries, each a message on the wire, and their values.
    Map,
}

/// What a record of a field takes: its own wire type, the length-delimited one besides where it
/// packs, the message it holds, an entry's of a map's among them, and the enum whose numbers alone
/// set it, where it is a singular field of a closed enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FieldShape {
    own: u32,
    packs: Packs,
    /// The message a record of it holds, or a map's entry; none for a scalar or an enum.
    pub(crate) holds: Option<Holds>,
    /// The enum of a singular field of a closed enum, a map's value apart, whose record of a number
    /// it declares no value of sets nothing (17.9.8); none otherwise.
    declared: Option<EnumIndex>,
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
                declared: None,
            },
        };

        // * spec 17.9.8: a singular field of a closed enum, as Buffa reads the field, which keeps
        // the generator's opening of a repeated or map field apart
        if let FieldKind::Singular(SingularKind::Enum(index)) = field.kind()
            && field.enum_type() == Some(EnumType::Closed)
        {
            return Self {
                declared: Some(index),
                ..shape
            };
        }

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
                declared: None,
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
            declared: None,
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

// a length as a varint's shortest form (Encoding, "Base 128 Varints")
fn length_into(output: &mut Vec<u8>, length: usize) {
    let mut value = u64::try_from(length).unwrap_or(u64::MAX);

    loop {
        let low = u8::try_from(value & 0x7F).unwrap_or_default();

        value >>= 7;

        if value == 0 {
            output.push(low);

            return;
        }

        output.push(low | 0x80);
    }
}

// ── The check ─────────────────────────────────────────────────────────────────

/// Checks `bytes` against the records of `schema`'s message, at every depth.
///
/// Refused: a tag of more than 5 bytes, past 32 bits or of field number 0; a varint of more than
/// 10 bytes, or whose 10th byte sets a bit past the 64th, its field known or not, packed or not; a
/// length past the bytes that follow it; a record past the end of its message; a packed record whose
/// values do not end at its length; a group closed by another number's end group or never closed,
/// an end group that closes none, and the wire types 6 and 7; a message nested more than 100 deep
/// below the top one (17.9.3); a field the message declares at a wire type its type does not take
/// (17.9.5); and a map's entry with a field other than its key and its value (17.9.6). An unknown
/// length-delimited record is opaque, as protobuf keeps it.
///
/// # Errors
///
/// A [`CodecRefusal`] for bytes that are no encoding of the message, its reason `not its message`,
/// or that nest too deep, `nested past 100`: spec 17.2's words, the record refused in its cause.
pub fn check_records(bytes: &[u8], schema: &ProtoSchema) -> Result<(), CodecRefusal> {
    checked(bytes, schema).map(|_| ())
}

/// Checks `bytes` as [`check_records`] does: whether they hold a singular closed enum's record of
/// a number its enum declares no value of (17.9.8), which [`filtered`] drops.
pub(crate) fn checked(bytes: &[u8], schema: &ProtoSchema) -> Result<bool, CodecRefusal> {
    let mut reader = Reader::of(bytes, schema);

    reader.message(
        Some(Holds::Message(schema.message)),
        Frame {
            end: bytes.len(),
            depth: 0,
            group: NO_GROUP,
        },
    )?;

    Ok(reader.undeclared)
}

/// `bytes`, checked as [`check_records`] checks them, without each singular closed enum's record of
/// a number its enum declares no value of, the length of each record that held one written again
/// (17.9.8): what protobuf keeps among the unknown fields, Buffa then never reads as the field's,
/// which holds the last declared number its records give, or none. Borrowed where they hold none.
pub(crate) fn filtered<'a>(
    bytes: &'a [u8],
    schema: &ProtoSchema,
) -> Result<Cow<'a, [u8]>, CodecRefusal> {
    if !checked(bytes, schema)? {
        return Ok(Cow::Borrowed(bytes));
    }

    let mut reader = Reader::of(bytes, schema);
    let mut output = Vec::with_capacity(bytes.len());

    reader.rewrite(
        Some(Holds::Message(schema.message)),
        ((bytes.len(), NO_GROUP), &mut output),
    )?;

    Ok(Cow::Owned(output))
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
            return Err(found(
                NESTED_PAST_100,
                format!("a proto payload nests a message more than {DEPTH} deep below the top one"),
            ));
        }

        Ok(self.depth.saturating_add(1))
    }
}

// the record refused, in the check's words, the refusal's cause
fn refused(record: &str) -> CodecRefusal {
    found(NOT_ITS_MESSAGE, record)
}

// one walk of a payload, its position moving over its bytes, and whether it met a singular closed
// enum's record of a number its enum does not declare
struct Reader<'a> {
    schema: &'a ProtoSchema,
    bytes: &'a [u8],
    at: usize,
    undeclared: bool,
}

impl<'a> Reader<'a> {
    fn of(bytes: &'a [u8], schema: &'a ProtoSchema) -> Self {
        Self {
            schema,
            bytes,
            at: 0,
            undeclared: false,
        }
    }

    // whether a varint record of the field sets nothing: a singular closed enum's number, its
    // varint's low 32 bits as protobuf reads an int32, that its enum declares no value of
    fn sets_nothing(&self, field: Option<FieldShape>, value: u64) -> bool {
        let Some(index) = field.and_then(|field| field.declared) else {
            return false;
        };
        let [first, second, third, fourth, ..] = value.to_le_bytes();
        let number = i32::from_le_bytes([first, second, third, fourth]);

        self.schema
            .pool()
            .enumeration(index)
            .value(number)
            .is_none()
    }

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
            VARINT => {
                let value = self.varint(frame.end)?;

                // * spec 17.9.8: a record that sets nothing, which filtered drops
                if self.sets_nothing(field, value) {
                    self.undeclared = true;
                }

                Ok(())
            }
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

    // the records of a message the walk took, up to its end or through the end group that closes
    // it, written to `output` without each record that sets nothing, each message record's length
    // written again
    fn rewrite(
        &mut self,
        within: Option<Holds>,
        ((end, group), output): ((usize, u32), &mut Vec<u8>),
    ) -> Result<(), CodecRefusal> {
        while self.at < end {
            let start = self.at;
            let tag = self.tag(end)?;
            let after_tag = self.at;
            let field = self.field_of(within, tag >> 3);

            match tag & 7 {
                EGROUP if tag >> 3 == group => {
                    output.extend_from_slice(self.span(start));

                    return Ok(());
                }
                VARINT => {
                    let value = self.varint(end)?;

                    if self.sets_nothing(field, value) {
                        continue;
                    }
                }
                I64 => self.skip(8, end)?,
                I32 => self.skip(4, end)?,
                LEN => {
                    let delimited = self.length(end)?;

                    if let Some(holds) = field.and_then(|field| field.holds) {
                        let mut inner = Vec::with_capacity(delimited.saturating_sub(self.at));

                        output.extend_from_slice(
                            self.bytes.get(start..after_tag).unwrap_or_default(),
                        );
                        self.rewrite(Some(holds), ((delimited, NO_GROUP), &mut inner))?;
                        length_into(output, inner.len());
                        output.extend_from_slice(&inner);

                        continue;
                    }

                    self.at = delimited;
                }
                SGROUP => {
                    // * a group: its tag, then its records through its end group
                    output.extend_from_slice(self.span(start));
                    self.rewrite(
                        field.and_then(|field| field.holds),
                        ((end, tag >> 3), output),
                    )?;

                    continue;
                }
                wire => return Err(refused(&format!("the wire type {wire}"))),
            }

            output.extend_from_slice(self.span(start));
        }

        Ok(())
    }

    // the bytes from `start` to the reader
    fn span(&self, start: usize) -> &'a [u8] {
        self.bytes.get(start..self.at).unwrap_or_default()
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

    // a varint of 10 bytes at most, within 64 bits (Encoding, "Base 128 Varints"), within the
    // message
    fn varint(&mut self, end: usize) -> Result<u64, CodecRefusal> {
        let mut value = 0_u64;

        for shift in (0..10_u32).map(|place| place.saturating_mul(7)) {
            let byte = self
                .next(end)
                .ok_or_else(|| refused("a varint cut short, or past the end of its message"))?;

            value |= u64::from(byte & 0x7F).checked_shl(shift).unwrap_or(0);

            if byte & 0x80 == 0 {
                // ! a 10th byte past 0x01 sets a bit past the 64th: no unsigned 64-bit integer, so no
                // encoding, refused here before Buffa reads
                if shift == 63 && byte > 0x01 {
                    return Err(refused("a varint past 64 bits"));
                }

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
