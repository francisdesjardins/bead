//! A `proto` message judged by its fields of `LEGACY_REQUIRED` presence (spec 17.9.7, decision
//! 0042): proto2's `required`, an edition's `features.field_presence = LEGACY_REQUIRED`, which
//! protobuf has "required for parsing and serialization". The walk takes a message's own fields
//! first, by their numbers, then each message it holds, depth first, by field number: a repeated
//! field's items by index, a map's values by key in spec 18.5's order. It looks into no
//! extension, which Buffa's generated code holds among the unknown fields, and no `Any`'s message,
//! which it holds as bytes. A message that reaches no required field costs one lookup. The
//! TypeScript side's twin is the walk of `protoCodecOf`, the C# side's `ProtoRequired`.

use bead::CodecRefusal;
use buffa::editions::EnumType;
use buffa_descriptor::reflect::{MapKey, ReflectMessage, ValueRef};
use buffa_descriptor::{FieldDescriptor, FieldKind, SingularKind};

use crate::records::{Form, Holding, ProtoSchema, Shape};

#[cfg(test)]
mod tests;

/// What a message's `has` of a required field witnesses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Presence {
    /// The wire's, or the application's: a view's, which the wire decoder records, and a dynamic
    /// message's, which holds a field set or not.
    Given,
    /// None, for a required scalar or enum, which an owned message holds bare and writes always:
    /// its `has` compares its value with its default. A required message it holds as a
    /// `MessageField`, set or not, which its `has` tells.
    Held,
}

/// Refuses `message` where it leaves a required field unset, at any depth.
///
/// It names the first the walk finds by its full name: a field of the schema, never a key a peer
/// sent. `message` is of `schema`'s message, and tells whether a field was given: a view Buffa
/// decoded, or a
/// [`DynamicMessage`](buffa_descriptor::reflect::DynamicMessage); never an owned message, which
/// holds a required scalar bare. A closed enum's number its enum does not declare is no value of a
/// required field, which only an application sets, since a reading of 17.9.8 sets none.
///
/// # Errors
///
/// A [`CodecRefusal`] for a message that leaves a field of `LEGACY_REQUIRED` presence unset.
pub fn check_required(
    message: &dyn ReflectMessage,
    schema: &ProtoSchema,
) -> Result<(), CodecRefusal> {
    checked(message, (schema, Presence::Given))
}

/// The first field of `LEGACY_REQUIRED` presence the walk finds unset in `message`, and its way
/// there, as [`check_required`] walks it; none where it leaves none.
#[must_use]
pub fn unset_of(message: &dyn ReflectMessage, schema: &ProtoSchema) -> Option<Unset> {
    unset_in(message, (schema, Presence::Given))
}

/// [`check_required`] of a message whose `has` witnesses as `presence` says.
pub(crate) fn checked(
    message: &dyn ReflectMessage,
    (schema, presence): (&ProtoSchema, Presence),
) -> Result<(), CodecRefusal> {
    unset_in(message, (schema, presence)).map_or(Ok(()), |unset| {
        Err(CodecRefusal::new(format!(
            "a proto message leaves {} unset",
            unset.full_name()
        )))
    })
}

// the first field the walk finds unset, its `has` witnessing as `presence` says
fn unset_in(
    message: &dyn ReflectMessage,
    (schema, presence): (&ProtoSchema, Presence),
) -> Option<Unset> {
    let shape = schema.root();

    if !shape.reaches {
        return None;
    }

    let mut walk = Walk {
        schema,
        presence,
        steps: Vec::new(),
    };

    walk.message(message, shape)
}

/// The first field of `LEGACY_REQUIRED` presence the walk found unset, and its way there from the
/// top message.
#[derive(Debug, Clone)]
pub struct Unset {
    steps: Vec<UnsetStep>,
    field: FieldDescriptor,
    holder: String,
}

impl Unset {
    /// Each step from the top message to the one that leaves it unset.
    #[must_use]
    pub fn steps(&self) -> &[UnsetStep] {
        &self.steps
    }

    /// The field left unset.
    #[must_use]
    pub fn field(&self) -> &FieldDescriptor {
        &self.field
    }

    /// The field's full name, its message's then its own.
    #[must_use]
    pub fn full_name(&self) -> String {
        format!("{}.{}", self.holder, self.field.name())
    }
}

/// A step of the walk's way to a field left unset: a field of a message, and the item's index of a
/// repeated field, or the entry's key of a map.
#[derive(Debug, Clone)]
pub struct UnsetStep {
    field: FieldDescriptor,
    at: Place,
}

impl UnsetStep {
    /// The field the step takes.
    #[must_use]
    pub fn field(&self) -> &FieldDescriptor {
        &self.field
    }

    /// Where in its field it takes a message.
    #[must_use]
    pub fn place(&self) -> &Place {
        &self.at
    }
}

/// Where in its field a step takes a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    /// A singular field's message.
    Field,
    /// A repeated field's item, by its index.
    Index(usize),
    /// A map's value, by its key.
    Key(MapKey),
}

// one walk, its way to the message it is in
struct Walk<'a> {
    schema: &'a ProtoSchema,
    presence: Presence,
    steps: Vec<UnsetStep>,
}

impl Walk<'_> {
    // a message's own required fields, then each message it holds that reaches one; each field by
    // the message's own descriptor of it, which its reflection takes, its pool being its code's
    fn message(&mut self, message: &dyn ReflectMessage, shape: &Shape) -> Option<Unset> {
        let descriptor = message.message_descriptor();

        for field in &shape.required {
            let is_set = descriptor
                .field(field.number())
                .is_none_or(|own| self.is_set(message, own));

            if !is_set {
                return Some(Unset {
                    steps: self.steps.clone(),
                    field: field.clone(),
                    holder: shape.full_name.clone(),
                });
            }
        }

        shape.holding.iter().find_map(|holding| {
            let own = descriptor.field(holding.field.number())?;

            self.held(message, (own, holding))
        })
    }

    // the messages a field holds, each walked one step further
    fn held(
        &mut self,
        message: &dyn ReflectMessage,
        (field, holding): (&FieldDescriptor, &Holding),
    ) -> Option<Unset> {
        match (holding.form, message.get(field)) {
            (Form::Singular, ValueRef::Message(held)) if message.has(field) => {
                self.step((&*held, Place::Field), holding)
            }
            (Form::List, ValueRef::List(list)) => (0..list.len()).find_map(|index| {
                if let Some(ValueRef::Message(held)) = list.get(index) {
                    return self.step((&*held, Place::Index(index)), holding);
                }

                None
            }),
            (Form::Map, ValueRef::Map(map)) => {
                let mut keys = Vec::with_capacity(map.len());

                map.for_each(&mut |key, _| keys.push(key.to_owned()));

                // * spec 18.5's order, a map's keys being of one type: integers ascending, false
                // before true, strings by their UTF-8 bytes, which order as their code points do
                keys.sort();

                keys.into_iter().find_map(|key| {
                    if let Some(ValueRef::Message(held)) = map.get(&key) {
                        return self.step((&*held, Place::Key(key)), holding);
                    }

                    None
                })
            }
            _ => None,
        }
    }

    // the message one step further, the step taken there and back
    fn step(
        &mut self,
        (message, at): (&dyn ReflectMessage, Place),
        holding: &Holding,
    ) -> Option<Unset> {
        self.steps.push(UnsetStep {
            field: holding.field.clone(),
            at,
        });

        let unset = self.message(message, self.schema.shape(holding.held));

        self.steps.pop();

        unset
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
