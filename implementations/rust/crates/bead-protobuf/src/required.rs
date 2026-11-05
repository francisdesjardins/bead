//! A `proto` message judged by its fields of `LEGACY_REQUIRED` presence (spec 17.9.7, decision
//! 0042): proto2's `required`, an edition's `features.field_presence = LEGACY_REQUIRED`, which
//! protobuf has "required for parsing and serialization". The walk takes a message's own fields
//! first, by their numbers, then each message it holds, depth first, by field number: a repeated
//! field's items by index, a map's values by key in spec 18.5's order. It looks into no
//! extension, which Buffa's generated code holds among the unknown fields, and no `Any`'s message,
//! which it holds as bytes. A message that reaches no required field costs one lookup. The
//! TypeScript side's twin is the walk of `protoCodecOf`, the C# side's `ProtoRequired`.
//!
//! The same walk, over every field that nests rather than those that reach a required field, is
//! a writer's depth pass (17.9.3, decision 0031): it refuses a value nested more than 100 deep
//! below the top one in its known fields, counted as the wire nests, before anything walks it
//! further or Buffa writes it. Either walk goes 100 messages deep at most, so it never recurses
//! past the bound, whatever a value holds; over a reading, whose records were held to the bound
//! first, one more where Buffa gives a map's entry that held no value its value's default.

use core::fmt;
use std::error::Error;

use bead::CodecRefusal;
use buffa::editions::EnumType;
use buffa_descriptor::reflect::{MapKey, ReflectMessage, ValueRef};
use buffa_descriptor::{FieldDescriptor, FieldKind, SingularKind};

use crate::records::{DEPTH, Form, Holding, ProtoSchema, Shape};
use crate::refusal::{A_REQUIRED_FIELD_UNSET, NESTED_PAST_100, found, refusal};

#[cfg(test)]
mod tests;

/// What a message's `has` of a required field witnesses, and whether its depth is still to judge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Presence {
    /// The wire's: a reading's view, which the wire decoder records, or its dynamic message. Its
    /// depth is not judged: the records' check judged the wire's before Buffa read it, and Buffa
    /// gives a map's entry that held no value its value's default, a message one deeper than the
    /// wire nests, which a reader takes (17.9.3) and its writer then refuses.
    Read,
    /// The application's: a dynamic message's, which holds a field set or not.
    Given,
    /// None, for a required scalar or enum, which an owned message holds bare and writes always:
    /// its `has` compares its value with its default. A required message it holds as a
    /// `MessageField`, set or not, which its `has` tells.
    Held,
}

/// Refuses `message` where it leaves a required field unset, at any depth.
///
/// Its reason is spec 17.2's, `a required field unset`; its cause names the first field the walk
/// finds by its full name, a field of the schema, never a key a peer sent, and its way there.
/// `message` is of `schema`'s message, and tells whether a field was given: a view Buffa decoded,
/// or a [`DynamicMessage`](buffa_descriptor::reflect::DynamicMessage); never an owned message,
/// which holds a required scalar bare. A closed enum's number its enum does not declare is no value
/// of a required field, which only an application sets, since a reading of 17.9.8 sets none. The
/// walk goes 100 messages deep below the top one at most, as a reader reads (17.9.3).
///
/// # Errors
///
/// A [`CodecRefusal`] for a message that leaves a field of `LEGACY_REQUIRED` presence unset, or
/// that nests a message reaching one more than 100 deep below the top one, `nested past 100`.
pub fn check_required(
    message: &dyn ReflectMessage,
    schema: &ProtoSchema,
) -> Result<(), CodecRefusal> {
    checked(message, (schema, Presence::Given))
}

/// The first field of `LEGACY_REQUIRED` presence the walk finds unset in `message`, and its way
/// there, as [`check_required`] walks it; none where it leaves none, or nests past the bound.
#[cfg(test)]
pub(crate) fn unset_of(message: &dyn ReflectMessage, schema: &ProtoSchema) -> Option<Unset> {
    unset_in(message, (schema, Presence::Given)).ok().flatten()
}

/// [`check_required`] of a message whose `has` witnesses as `presence` says.
pub(crate) fn checked(
    message: &dyn ReflectMessage,
    (schema, presence): (&ProtoSchema, Presence),
) -> Result<(), CodecRefusal> {
    unset_in(message, (schema, presence))?
        .map_or(Ok(()), |unset| Err(refusal(A_REQUIRED_FIELD_UNSET, unset)))
}

/// A writer's depth pass: refuses `value` where its known fields nest a message more than 100
/// deep below the top one, a map's entry counting as a message, as the wire nests (17.9.3). It
/// walks nothing of a message whose fields cannot nest past the bound.
pub(crate) fn bounded(
    value: &dyn ReflectMessage,
    schema: &ProtoSchema,
) -> Result<(), CodecRefusal> {
    let shape = schema.root();

    if !shape.nests_past {
        return Ok(());
    }

    let mut walk = Walk {
        schema,
        presence: Presence::Given,
        steps: Vec::new(),
        depth: 0,
        nesting: true,
    };

    walk.message(value, shape).map(drop)
}

// the first field the walk finds unset, its `has` witnessing as `presence` says
fn unset_in(
    message: &dyn ReflectMessage,
    (schema, presence): (&ProtoSchema, Presence),
) -> Result<Option<Unset>, CodecRefusal> {
    let shape = schema.root();

    if !shape.reaches {
        return Ok(None);
    }

    let mut walk = Walk {
        schema,
        presence,
        steps: Vec::new(),
        depth: 0,
        nesting: false,
    };

    walk.message(message, shape)
}

/// The first field of `LEGACY_REQUIRED` presence the walk found unset, and its way there from the
/// top message: a refusal's cause, which names them.
#[derive(Debug, Clone)]
pub(crate) struct Unset {
    steps: Vec<UnsetStep>,
    field: FieldDescriptor,
    holder: String,
}

impl Unset {
    /// Each step from the top message to the one that leaves it unset.
    #[must_use]
    #[cfg(test)]
    pub(crate) fn steps(&self) -> &[UnsetStep] {
        &self.steps
    }

    /// The field left unset.
    #[must_use]
    #[cfg(test)]
    pub(crate) fn field(&self) -> &FieldDescriptor {
        &self.field
    }

    /// The field's full name, its message's then its own.
    #[must_use]
    pub(crate) fn full_name(&self) -> String {
        format!("{}.{}", self.holder, self.field.name())
    }
}

// its full name, then its way there: each field by its name, an item's index or an entry's key
impl fmt::Display for Unset {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "a proto message leaves {} unset",
            self.full_name()
        )?;

        for (at, step) in self.steps.iter().enumerate() {
            formatter.write_str(if at == 0 { ", at " } else { "." })?;
            formatter.write_str(step.field.name())?;

            match &step.at {
                Place::Field => {}
                Place::Index(index) => write!(formatter, "[{index}]")?,
                Place::Key(MapKey::String(key)) => write!(formatter, "[{key:?}]")?,
                Place::Key(key) => write!(formatter, "[{}]", key_of(key))?,
            }
        }

        Ok(())
    }
}

impl Error for Unset {}

// a map's key that is no string, as protobuf's text format writes it
fn key_of(key: &MapKey) -> String {
    match key {
        MapKey::Bool(key) => key.to_string(),
        MapKey::I32(key) => key.to_string(),
        MapKey::I64(key) => key.to_string(),
        MapKey::U32(key) => key.to_string(),
        MapKey::U64(key) => key.to_string(),
        MapKey::String(key) => key.clone(),
    }
}

/// A step of the walk's way to a field left unset: a field of a message, and the item's index of a
/// repeated field, or the entry's key of a map.
#[derive(Debug, Clone)]
pub(crate) struct UnsetStep {
    field: FieldDescriptor,
    at: Place,
}

impl UnsetStep {
    /// The field the step takes.
    #[must_use]
    #[cfg(test)]
    pub(crate) fn field(&self) -> &FieldDescriptor {
        &self.field
    }

    /// Where in its field it takes a message.
    #[must_use]
    #[cfg(test)]
    pub(crate) fn place(&self) -> &Place {
        &self.at
    }
}

/// Where in its field a step takes a message.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub(crate) enum Place {
    /// A singular field's message.
    Field,
    /// A repeated field's item, by its index.
    Index(usize),
    /// A map's value, by its key.
    Key(MapKey),
}

// what a walk of a message gives: the first field it finds unset, or none; or its refusal of a
// message nested past the bound
type Walked = Result<Option<Unset>, CodecRefusal>;

// one walk, its way to the message it is in and how deep that is below the top one; over the
// fields that reach a required field, or, as the depth pass, over every field that nests
struct Walk<'a> {
    schema: &'a ProtoSchema,
    presence: Presence,
    steps: Vec<UnsetStep>,
    depth: u32,
    nesting: bool,
}

impl Walk<'_> {
    // a message's own required fields, then each message it holds that reaches one; each field by
    // the message's own descriptor of it, which its reflection takes, its pool being its code's.
    // The depth pass judges no required field, and takes every field that nests
    fn message(&mut self, message: &dyn ReflectMessage, shape: &Shape) -> Walked {
        let descriptor = message.message_descriptor();

        if !self.nesting {
            for field in &shape.required {
                let is_set = descriptor
                    .field(field.number())
                    .is_none_or(|own| self.is_set(message, own));

                if !is_set {
                    return Ok(Some(Unset {
                        steps: self.steps.clone(),
                        field: field.clone(),
                        holder: shape.full_name.clone(),
                    }));
                }
            }
        }

        let fields = if self.nesting {
            &shape.nesting
        } else {
            &shape.holding
        };

        for holding in fields {
            let Some(own) = descriptor.field(holding.field.number()) else {
                continue;
            };

            if let Some(unset) = self.held(message, (own, holding))? {
                return Ok(Some(unset));
            }
        }

        Ok(None)
    }

    // the messages a field holds, each walked one step further
    fn held(
        &mut self,
        message: &dyn ReflectMessage,
        (field, holding): (&FieldDescriptor, &Holding),
    ) -> Walked {
        match (holding.form, message.get(field)) {
            (Form::Singular, ValueRef::Message(held)) if message.has(field) => {
                self.step((&*held, Place::Field), holding)
            }
            (Form::List, ValueRef::List(list)) => {
                for index in 0..list.len() {
                    if let Some(ValueRef::Message(held)) = list.get(index)
                        && let Some(unset) = self.step((&*held, Place::Index(index)), holding)?
                    {
                        return Ok(Some(unset));
                    }
                }

                Ok(None)
            }
            (Form::Map, ValueRef::Map(map)) if !map.is_empty() => {
                // * a map's entry is a message on the wire, a map of scalars' among them
                self.deeper(1)?;

                if holding.held.is_none() {
                    return Ok(None);
                }

                let mut keys = Vec::with_capacity(map.len());

                map.for_each(&mut |key, _| keys.push(key.to_owned()));

                // * spec 18.5's order, a map's keys being of one type: integers ascending, false
                // before true, strings by their UTF-8 bytes, which order as their code points do
                keys.sort();

                for key in keys {
                    if let Some(ValueRef::Message(held)) = map.get(&key)
                        && let Some(unset) = self.step((&*held, Place::Key(key)), holding)?
                    {
                        return Ok(Some(unset));
                    }
                }

                Ok(None)
            }
            _ => Ok(None),
        }
    }

    // the message one step further, the step taken there and back: a map's value two below the
    // message that holds it, its entry between, any other message one
    fn step(&mut self, (message, at): (&dyn ReflectMessage, Place), holding: &Holding) -> Walked {
        let Some(held) = holding.held else {
            return Ok(None);
        };
        let was = self.depth;

        self.depth = self.deeper(if matches!(at, Place::Key(_)) { 2 } else { 1 })?;
        self.steps.push(UnsetStep {
            field: holding.field.clone(),
            at,
        });

        let walked = self.message(message, self.schema.shape(held));

        self.steps.pop();
        self.depth = was;

        walked
    }

    // the depth `below` messages deeper, within the bound, which a reading's records were held to
    fn deeper(&self, below: u32) -> Result<u32, CodecRefusal> {
        let depth = self.depth.saturating_add(below);

        if depth > DEPTH && self.presence != Presence::Read {
            return Err(found(
                NESTED_PAST_100,
                format!("a proto value nests a message more than {DEPTH} deep below the top one"),
            ));
        }

        Ok(depth)
    }

    // whether a required field holds a value: a closed enum's of a number its enum declares
    fn is_set(&self, message: &dyn ReflectMessage, field: &FieldDescriptor) -> bool {
        let kind = field.kind();

        if self.presence == Presence::Held
            && !matches!(kind, FieldKind::Singular(SingularKind::Message(_)))
        {
            return true;
        }

        if !message.has(field) {
            return false;
        }

        if let (FieldKind::Singular(SingularKind::Enum(index)), ValueRef::EnumNumber(number)) =
            (kind, message.get(field))
            && field.enum_type() == Some(EnumType::Closed)
        {
            return message.pool().enumeration(index).value(number).is_some();
        }

        true
    }
}
