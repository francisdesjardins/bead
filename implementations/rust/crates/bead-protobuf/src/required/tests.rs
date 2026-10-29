//! The walk of spec 17.9.7 over a message that tells a field given from one left out, on
//! `requiring.proto`'s `Requiring`, which `spec/transcoding.proto` declares, and
//! `spec/codecs.proto`'s `Probe`: its order, and what it names. The codecs' tests play it through
//! the reader and the writer. The twin of the TypeScript side's `required.test.ts` and the C#
//! side's `ProtoRequiredTests`, sentence for sentence; each message is built as a dynamic message,
//! the form that holds a required field unset, or decoded as a view.

use std::sync::Arc;

use bead::testing::hexadecimal;
use buffa::DecodeOptions;
use buffa_descriptor::DescriptorPool;
use buffa_descriptor::reflect::{
    DynamicMessage, MapKey, MapValue, ReflectMessage, ReflectMessageMut, Value,
};

use super::{Place, unset_of};
use crate::records::ProtoSchema;
use crate::testing::codecs::Probe;
use crate::testing::test::{Requiring, RequiringView};

// the pool of the tests' messages, as their generated code embeds it
fn pool() -> Arc<DescriptorPool> {
    Arc::clone(crate::testing::test::descriptor_pool())
}

// a dynamic message of `name`, each field given set to its value
fn message_of(name: &str, fields: Vec<(&str, Value)>) -> DynamicMessage {
    let pool = pool();
    let index = pool.message_index(name).expect("a message of the pool");
    let mut message = DynamicMessage::new(Arc::clone(&pool), index);

    for (field, value) in fields {
        message.set(
            pool.message(index)
                .field_by_name(field)
                .expect("a field of the message"),
            value,
        );
    }

    message
}

// a Needs of spec/transcoding-required.proto, as a field's value
fn needs(fields: Vec<(&str, Value)>) -> Value {
    Value::Message(message_of("bead.transcoding.v1.Needs", fields))
}

fn text(text: &str) -> Value {
    Value::String(text.to_owned())
}

fn requiring(fields: Vec<(&str, Value)>) -> DynamicMessage {
    message_of("bead.test.Requiring", fields)
}

// the path the walk gives of a message: each step's field by its name, then an item's index or a
// map's key as it is, then the field left unset; none where it leaves none
fn path_of(message: &dyn ReflectMessage, schema: &ProtoSchema) -> Option<Vec<String>> {
    let unset = unset_of(message, schema)?;
    let mut path = Vec::new();

    for step in unset.steps() {
        path.push(step.field().name().to_owned());

        match step.place() {
            Place::Field => {}
            Place::Index(index) => path.push(index.to_string()),
            Place::Key(MapKey::String(key)) => path.push(key.clone()),
            Place::Key(key) => path.push(format!("{key:?}")),
        }
    }

    path.push(unset.field().name().to_owned());

    Some(path)
}

#[test]
fn takes_a_message_s_own_fields_by_number_before_what_it_holds_and_what_it_holds_depth_first_by_field_number()
 {
    let schema = ProtoSchema::of::<Requiring>();
    let path = |message: DynamicMessage| path_of(&message, &schema);

    assert_eq!(
        path(requiring(vec![("needs", needs(vec![]))])),
        Some(vec!["needs".to_owned(), "name".to_owned()]),
        "its own name first"
    );
    assert_eq!(
        path(requiring(vec![(
            "needs",
            needs(vec![
                ("child", needs(vec![("name", text("b"))])),
                ("name", text("a"))
            ])
        )])),
        Some(vec!["needs".to_owned(), "count".to_owned()]),
        "its own count before its child's"
    );
    assert_eq!(
        path(requiring(vec![
            ("many", Value::List(vec![needs(vec![("name", text("c"))])])),
            (
                "needs",
                needs(vec![
                    ("child", needs(vec![("name", text("b"))])),
                    ("count", Value::I32(1)),
                    ("name", text("a")),
                ])
            ),
        ])),
        Some(vec![
            "needs".to_owned(),
            "child".to_owned(),
            "count".to_owned()
        ]),
        "its needs, depth first, before its many"
    );
    assert_eq!(
        path(requiring(vec![(
            "many",
            Value::List(vec![
                needs(vec![("count", Value::I32(1)), ("name", text("a"))]),
                needs(vec![("name", text("b"))]),
            ])
        )])),
        Some(vec!["many".to_owned(), "1".to_owned(), "count".to_owned()]),
        "an item by its index"
    );
    assert_eq!(
        path(requiring(vec![(
            "needs",
            needs(vec![("count", Value::I32(0)), ("name", text(""))])
        )])),
        None,
        "each set, at its default"
    );
}

#[test]
fn takes_a_map_s_values_by_key_in_18_5_s_order_whatever_order_the_map_holds_them_in() {
    let schema = ProtoSchema::of::<Requiring>();
    let by_key: MapValue = [
        (
            MapKey::String("b".to_owned()),
            needs(vec![("name", text("x"))]),
        ),
        (
            MapKey::String("a".to_owned()),
            needs(vec![("name", text("y"))]),
        ),
    ]
    .into_iter()
    .collect();
    let expected = Some(vec![
        "by_key".to_owned(),
        "a".to_owned(),
        "count".to_owned(),
    ]);

    assert_eq!(
        path_of(&requiring(vec![("by_key", Value::Map(by_key))]), &schema),
        expected,
        "a dynamic message's map"
    );

    // * a view holds a map's entries as the wire gives them: b, then a
    let bytes =
        hexadecimal::bytes_of("1A 08 0A 01 62 12 03 0A 01 78 1A 08 0A 01 61 12 03 0A 01 79")
            .expect("bytes in hexadecimal");
    let view: RequiringView<'_> = DecodeOptions::new()
        .decode_view(&bytes)
        .expect("a view of Requiring");

    assert_eq!(path_of(&view, &schema), expected, "a view's map");
}

#[test]
fn names_the_field_a_path_leaves_unset_by_its_full_name() {
    let schema = ProtoSchema::of::<Probe>();
    let pool = Arc::clone(schema.pool());
    let index = pool
        .message_index("bead.codecs.v1.Needs")
        .expect("Needs in its pool");
    let mut item = DynamicMessage::new(Arc::clone(&pool), index);

    item.set(
        pool.message(index)
            .field_by_name("must")
            .expect("Needs.must"),
        Value::U32(1),
    );

    let mut probe = DynamicMessage::new(Arc::clone(&pool), schema.message());

    probe.set(
        pool.message(schema.message())
            .field_by_name("needs_items")
            .expect("Probe.needs_items"),
        Value::List(vec![Value::Message(item)]),
    );

    assert_eq!(
        path_of(&probe, &schema),
        Some(vec![
            "needs_items".to_owned(),
            "0".to_owned(),
            "shade".to_owned()
        ]),
        "its item's shade"
    );
    assert_eq!(
        unset_of(&probe, &schema).map(|unset| unset.full_name()),
        Some("bead.codecs.v1.Needs.shade".to_owned()),
        "named by its full name"
    );
}
