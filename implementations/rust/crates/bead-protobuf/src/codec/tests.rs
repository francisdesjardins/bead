//! The codecs of a `proto` message: its records, its bound, the read, and the walk of a required
//! field unset both ways (spec 17.9.7) and a closed enum's undeclared number (17.9.8), on
//! `spec/codecs.proto`'s `Probe`, `requiring.proto`'s `Requiring`, which `spec/transcoding.proto`
//! declares, and `codec.proto`, a proto2 file of what neither reaches. The twin of the TypeScript
//! side's `codec.test.ts` and the C# side's `ProtoCodecsTests`, sentence for sentence, beside the
//! Rust side's own rows of the matrix.

use std::ptr;
use std::sync::Arc;

use bead::PayloadCodec;
use bead::testing::hexadecimal;
use buffa::{DecodeOptions, EnumValue, Enumeration, ExtensionSet, Inline, MessageField};
use buffa_descriptor::generated::descriptor::feature_set::EnumType;
use buffa_descriptor::generated::descriptor::field_descriptor_proto::{Label, Type};
use buffa_descriptor::generated::descriptor::{
    DescriptorProto, Edition, EnumDescriptorProto, EnumValueDescriptorProto, FeatureSet,
    FieldDescriptorProto, FileDescriptorProto, FileDescriptorSet, FileOptions, MessageOptions,
};
use buffa_descriptor::reflect::{
    DynamicMessage, ReflectMessage, ReflectMessageMut, Value, ValueRef,
};
use buffa_descriptor::{DescriptorPool, MessageIndex};
use bytes::Bytes;

use super::{DynamicCodec, ProtoCodec};
use crate::records::ProtoSchema;
use crate::required::{Place, unset_of};
use crate::testing::codecs::{self, Probe, Shade};
use crate::testing::test::__buffa::ext::INNER;
use crate::testing::test::__buffa::oneof::toned::Pick;
use crate::testing::test::{
    Alone, Back, Edges, Holder, Leveled, Loop, LoopView, Must, Requiring, Tone, Toned,
};
use crate::testing::transcoding::{Needs, NeedsUpdate};

// ── Helpers ───────────────────────────────────────────────────────────────────

// bytes as the conformance files write them, in hexadecimal, a space between two
fn bytes_of(hex: &str) -> Bytes {
    Bytes::from(hexadecimal::bytes_of(hex).expect("bytes in hexadecimal"))
}

// bytes as bytes_of reads them
fn hex_of(bytes: &[u8]) -> String {
    hexadecimal::text_of(bytes)
}

// the words of the refusal of a message that leaves the field `name` unset
fn words_of(name: &str) -> String {
    format!("a proto message leaves {name} unset")
}

// the dynamic codec of the message `name`, by the pool the tests' generated code embeds
fn dynamic_of(name: &str) -> DynamicCodec {
    let pool = Arc::clone(codecs::descriptor_pool());
    let index = pool.message_index(name).expect("a message of the pool");

    DynamicCodec::new(pool, index)
}

// a dynamic message of the codec's message, each field given set to its value
fn message_of(codec: &DynamicCodec, fields: Vec<(&str, Value)>) -> DynamicMessage {
    let pool = Arc::clone(codec.schema().pool());
    let index = codec.schema().message();
    let mut message = DynamicMessage::new(Arc::clone(&pool), index);

    for (field, value) in fields {
        message
            .try_set(
                pool.message(index)
                    .field_by_name(field)
                    .expect("a field of the message"),
                value,
            )
            .expect("a value of the field");
    }

    message
}

// a descriptor's features, as its options hold them
type Features = MessageField<FeatureSet, Inline<FeatureSet>>;

// the options of a descriptor written by hand: none, empty, or of an empty feature set
fn holder_of<T: Default>(holder: usize, features: fn(Features) -> T) -> Option<T> {
    match holder {
        1 => Some(T::default()),
        2 => Some(features(MessageField::some(FeatureSet::default()))),
        _ => None,
    }
}

// features of an enum's type
fn features_of(enum_type: EnumType) -> Features {
    MessageField::some(FeatureSet {
        enum_type: Some(enum_type),
        ..FeatureSet::default()
    })
}

// where an edition file sets its enum's type: on the file, on Outer, on Inner, and Holder's options
#[derive(Default)]
struct Edition2023 {
    file: Option<EnumType>,
    outer: Option<EnumType>,
    inner: Option<EnumType>,
    holder: usize,
}

// an edition file of a singular enum field nested through three messages, its type set as
// `options` sets it
fn edition_file(options: &Edition2023) -> FileDescriptorProto {
    let message_options = |enum_type: Option<EnumType>| {
        enum_type.map_or_else(MessageField::none, |enum_type| {
            MessageField::some(MessageOptions {
                features: features_of(enum_type),
                ..MessageOptions::default()
            })
        })
    };
    let inner = DescriptorProto {
        name: Some("Inner".to_owned()),
        options: message_options(options.inner),
        enum_type: vec![EnumDescriptorProto {
            name: Some("Tone".to_owned()),
            value: [("LOW", 0), ("HIGH", 1)]
                .into_iter()
                .map(|(name, number)| EnumValueDescriptorProto {
                    name: Some(name.to_owned()),
                    number: Some(number),
                    ..EnumValueDescriptorProto::default()
                })
                .collect(),
            ..EnumDescriptorProto::default()
        }],
        field: vec![FieldDescriptorProto {
            name: Some("tone".to_owned()),
            json_name: Some("tone".to_owned()),
            number: Some(1),
            label: Some(Label::LABEL_OPTIONAL),
            r#type: Some(Type::TYPE_ENUM),
            type_name: Some(".edition.Outer.Holder.Inner.Tone".to_owned()),
            ..FieldDescriptorProto::default()
        }],
        ..DescriptorProto::default()
    };
    FileDescriptorProto {
        name: Some("edition.proto".to_owned()),
        package: Some("edition".to_owned()),
        syntax: Some("editions".to_owned()),
        edition: Some(Edition::EDITION_2023),
        options: options.file.map_or_else(
            || {
                holder_of(options.holder, |features| FileOptions {
                    features,
                    ..FileOptions::default()
                })
                .map_or_else(MessageField::none, MessageField::some)
            },
            |enum_type| {
                MessageField::some(FileOptions {
                    features: features_of(enum_type),
                    ..FileOptions::default()
                })
            },
        ),
        message_type: vec![DescriptorProto {
            name: Some("Outer".to_owned()),
            options: message_options(options.outer),
            nested_type: vec![DescriptorProto {
                name: Some("Holder".to_owned()),
                options: holder_of(options.holder, |features| MessageOptions {
                    features,
                    ..MessageOptions::default()
                })
                .map_or_else(MessageField::none, MessageField::some),
                nested_type: vec![inner],
                ..DescriptorProto::default()
            }],
            ..DescriptorProto::default()
        }],
        ..FileDescriptorProto::default()
    }
}

// the dynamic codec of a singular enum field nested through three edition messages, then what it
// reads held to an enum closed or open
fn check_edition(closed: bool, options: &Edition2023) {
    let file = edition_file(options);
    let pool = DescriptorPool::new(FileDescriptorSet {
        file: vec![file],
        ..FileDescriptorSet::default()
    })
    .expect("a pool of the edition file");
    let index: MessageIndex = pool
        .message_index("edition.Outer.Holder.Inner")
        .expect("Inner");
    let codec = DynamicCodec::new(Arc::new(pool), index);
    let read = |hex: &str| codec.decode(&bytes_of(hex)).expect("read");
    let tone_of = |message: &DynamicMessage| {
        let field = message
            .message_descriptor()
            .field_by_name("tone")
            .expect("Inner.tone");

        let ValueRef::EnumNumber(number) = message.get(field) else {
            panic!("tone read as no enum's number");
        };

        (message.has(field), number)
    };

    assert_eq!(
        tone_of(&read("08 05")),
        if closed { (false, 0) } else { (true, 5) },
        "5 alone, closed {closed}"
    );
    assert_eq!(
        tone_of(&read("08 01 08 05")).1,
        if closed { 1 } else { 5 },
        "1 then 5, closed {closed}"
    );
    assert_eq!(tone_of(&read("08 01")).1, 1, "1 alone");
}

// ── Twins ─────────────────────────────────────────────────────────────────────

#[test]
fn resolves_an_edition_enum_from_its_nearest_message_before_its_file() {
    check_edition(
        false,
        &Edition2023 {
            file: Some(EnumType::CLOSED),
            outer: Some(EnumType::CLOSED),
            inner: Some(EnumType::OPEN),
            ..Edition2023::default()
        },
    );
    check_edition(
        true,
        &Edition2023 {
            file: Some(EnumType::OPEN),
            outer: Some(EnumType::OPEN),
            inner: Some(EnumType::CLOSED),
            ..Edition2023::default()
        },
    );

    for holder in [0, 1, 2] {
        check_edition(
            true,
            &Edition2023 {
                file: Some(EnumType::OPEN),
                outer: Some(EnumType::CLOSED),
                holder,
                ..Edition2023::default()
            },
        );
        check_edition(
            false,
            &Edition2023 {
                file: Some(EnumType::CLOSED),
                outer: Some(EnumType::OPEN),
                holder,
                ..Edition2023::default()
            },
        );
    }
}

#[test]
fn resolves_an_edition_enum_from_its_file_when_no_message_sets_its_type() {
    for holder in [0, 1, 2] {
        check_edition(
            true,
            &Edition2023 {
                file: Some(EnumType::CLOSED),
                holder,
                ..Edition2023::default()
            },
        );
        check_edition(
            false,
            &Edition2023 {
                file: Some(EnumType::OPEN),
                holder,
                ..Edition2023::default()
            },
        );
    }
}

#[test]
fn opens_an_edition_enum_when_no_message_or_file_sets_its_type() {
    for holder in [0, 1, 2] {
        check_edition(
            false,
            &Edition2023 {
                holder,
                ..Edition2023::default()
            },
        );
    }
}

#[test]
fn refuses_a_message_that_leaves_a_required_field_unset_at_every_depth_a_proto3_root_s_message_an_item_a_map_s_value_a_group_and_a_delimited_field()
 {
    let requiring = |bytes: &Bytes| ProtoCodec::<Requiring>::new().decode(bytes).map(|_| ());
    let probe = |bytes: &Bytes| ProtoCodec::<Probe>::new().decode(bytes).map(|_| ());

    for (hex, name, by_requiring) in [
        // its needs, {count: 1}
        ("0A 02 10 01", "bead.transcoding.v1.Needs.name", true),
        // an item of many, the second, {name: "a"}
        (
            "12 04 0A 00 10 00 12 03 0A 01 61",
            "bead.transcoding.v1.Needs.count",
            true,
        ),
        // a value of by_key, at "k", {count: 1}
        (
            "1A 07 0A 01 6B 12 02 10 01",
            "bead.transcoding.v1.Needs.name",
            true,
        ),
        // Probe's delimited, a group, whose needs is {must: 0}
        ("6B 3A 02 08 00 6C", "bead.codecs.v1.Needs.shade", false),
        // its needs' delimited, {count: 1}
        (
            "0A 09 0A 01 61 10 01 23 10 01 24",
            "bead.transcoding.v1.Needs.name",
            true,
        ),
    ] {
        let bytes = bytes_of(hex);
        let typed = if by_requiring {
            requiring(&bytes)
        } else {
            probe(&bytes)
        };
        let dynamic = dynamic_of(if by_requiring {
            "bead.test.Requiring"
        } else {
            "bead.codecs.v1.Probe"
        })
        .decode(&bytes)
        .map(|_| ());

        for refused in [typed, dynamic] {
            assert_eq!(
                refused.map_err(|refusal| refusal.to_string()),
                Err(words_of(name)),
                "{hex} refused"
            );
        }
    }
}

#[test]
fn refuses_a_payload_and_a_value_with_a_codec_refusal_in_the_same_words() {
    let read = ProtoCodec::<Needs>::new()
        .decode(&bytes_of("10 01"))
        .expect_err("a payload that leaves name unset");
    let needs = dynamic_of("bead.transcoding.v1.Needs");
    let written = needs
        .encode(&message_of(&needs, vec![("count", Value::I32(1))]))
        .expect_err("a value that leaves name unset");

    assert_eq!(
        read.to_string(),
        words_of("bead.transcoding.v1.Needs.name"),
        "read"
    );
    assert_eq!(written, read, "written, in the same words");

    // * a closed enum's number its enum does not declare is no value of a required field
    let probe = dynamic_of("bead.codecs.v1.Probe");
    let shaded = dynamic_of("bead.codecs.v1.Needs");
    let value = message_of(
        &probe,
        vec![(
            "needs",
            Value::Message(message_of(
                &shaded,
                vec![("must", Value::U32(0)), ("shade", Value::EnumNumber(5))],
            )),
        )],
    );

    assert_eq!(
        probe.encode(&value).map_err(|refusal| refusal.to_string()),
        Err(words_of("bead.codecs.v1.Needs.shade")),
        "a shade of 5"
    );
}

#[test]
fn takes_a_required_field_set_at_its_default_and_one_a_message_given_twice_sets_in_either_record() {
    let needs = ProtoCodec::<Needs>::new();
    let requiring = ProtoCodec::<Requiring>::new();
    let read = needs.decode(&bytes_of("0A 00 10 00")).expect("read");

    assert_eq!(
        (read.name.as_str(), read.count),
        ("", 0),
        "each at its default"
    );
    assert_eq!(
        hex_of(&needs.encode(&Needs::default()).expect("written")),
        "0A 00 10 00",
        "written at its defaults"
    );

    for hex in [
        "0A 04 0A 00 10 00 0A 00",
        "0A 00 0A 04 0A 00 10 00",
        "0A 02 0A 00 0A 02 10 00",
    ] {
        let held = requiring.decode(&bytes_of(hex)).expect("read");
        let held = held.needs.as_option().expect("its needs");

        assert_eq!((held.name.as_str(), held.count), ("", 0), "{hex}");
    }
}

#[test]
fn reads_a_closed_enum_s_undeclared_number_as_setting_nothing_its_last_declared_number_kept_a_oneof_s_other_member_too()
 {
    let probe = ProtoCodec::<Probe>::new();
    let nothing = probe.decode(&bytes_of("70 05")).expect("read");
    let kept = probe.decode(&bytes_of("70 01 70 05")).expect("read");
    let toned = ProtoCodec::<Toned>::new()
        .decode(&bytes_of("12 01 61 08 05"))
        .expect("read");

    assert_eq!(nothing.shade, None, "5 sets nothing");
    assert_eq!(kept.shade, Some(Shade::SHADE_LIGHT), "1, then 5");
    assert_eq!(
        toned.pick,
        Some(Pick::Word("a".to_owned())),
        "a oneof's word kept"
    );

    // ! a matrix row: kept among the unknown fields, which Buffa writes back, as protobuf-es does
    assert_eq!(
        hex_of(&probe.encode(&kept).expect("written")),
        "70 01 70 05",
        "written back whole"
    );

    // * the leveled row: a repeated field's item and a map's value of 5 kept as the item and the
    // value they are, since the generator opens such a field; a singular one set aside
    let leveled = ProtoCodec::<Leveled>::new();

    for (hex, expected) in [
        ("08 05", "tones [Unknown(5)]"),
        ("12 02 01 05", "packed [TONE_HIGH, Unknown(5)]"),
        ("1A 05 0A 01 61 10 05", "by_name {\"a\": Unknown(5)}"),
        ("20 05", "one None"),
    ] {
        let read = leveled.decode(&bytes_of(hex)).expect("read");
        let said = match hex {
            "08 05" => format!("tones {:?}", read.tones),
            "12 02 01 05" => format!("packed {:?}", read.packed),
            "1A 05 0A 01 61 10 05" => format!("by_name {:?}", read.by_name),
            _ => format!("one {:?}", read.one),
        };

        assert_eq!(said, expected, "{hex} read");
        assert_eq!(
            hex_of(&leveled.encode(&read).expect("written")),
            hex,
            "{hex} written back"
        );
    }

    assert_eq!(
        Leveled {
            tones: vec![EnumValue::Known(Tone::TONE_LOW), EnumValue::Unknown(5)],
            ..Leveled::default()
        }
        .tones
        .iter()
        .map(EnumValue::to_i32)
        .collect::<Vec<_>>(),
        [0, 5],
        "an item holds its number"
    );
}

#[test]
fn looks_into_no_extension_and_no_any_s_message() {
    let requiring = ProtoCodec::<Requiring>::new();
    let holder = ProtoCodec::<Holder>::new();
    let partial = Requiring {
        any: MessageField::some(buffa_types::Any {
            type_url: "type.googleapis.com/bead.transcoding.v1.Needs".to_owned(),
            value: bytes_of("10 01"),
            ..buffa_types::Any::default()
        }),
        ..Requiring::default()
    };

    // its any, a Needs of {count: 1}
    let packed = "22 33 0A 2D 74 79 70 65 2E 67 6F 6F 67 6C 65 61 70 69 73 2E 63 6F 6D 2F 62 65 61 64 2E 74 72 61 6E 73 63 6F 64 69 6E 67 2E 76 31 2E 4E 65 65 64 73 12 02 10 01";

    assert_eq!(
        hex_of(&requiring.encode(&partial).expect("written")),
        packed,
        "an Any's message, not looked into"
    );
    assert_eq!(
        requiring
            .decode(&bytes_of(packed))
            .expect("read")
            .any
            .as_option()
            .map(|any| any.value.clone()),
        Some(bytes_of("10 01")),
        "read as bytes"
    );

    // an extension's Must of no field, which every side reads as an unknown field
    let read = holder.decode(&bytes_of("A2 06 00")).expect("read");

    assert_eq!(
        hex_of(&holder.encode(&read).expect("written")),
        "A2 06 00",
        "written back as read"
    );

    // ! a matrix row: Buffa's generated code, given no registry, holds an extension among the
    // unknown fields, which the walk does not look into, as the C# side's does not; a Must the
    // application sets holds its must bare, as every typed value does, and writes it
    let mut set = Holder::default();

    set.set_extension(&INNER, Must::default());

    assert_eq!(
        hex_of(&holder.encode(&set).expect("written")),
        "A2 06 02 08 00",
        "an extension set, written"
    );
}

#[test]
fn walks_nothing_of_a_message_that_reaches_no_required_field_cycles_included() {
    // * Edges holds itself and a Struct, which holds itself through a Value, and Alone holds
    // itself: neither reaches one
    let edges = ProtoSchema::of::<Edges>();

    assert!(!edges.root().reaches, "Edges reaches none");
    assert!(
        !ProtoSchema::of::<Alone>().root().reaches,
        "Alone reaches none"
    );
    assert!(
        unset_of(
            &Edges {
                child: MessageField::some(Edges {
                    child: MessageField::some(Edges::default()),
                    ..Edges::default()
                }),
                ..Edges::default()
            },
            &edges
        )
        .is_none(),
        "walked not"
    );

    // * Back holds Loop, which holds Back, and Must: each reaches Must
    let names = |schema: &ProtoSchema| {
        schema
            .root()
            .holding
            .iter()
            .map(|holding| holding.field.name().to_owned())
            .collect::<Vec<_>>()
    };

    assert_eq!(
        names(&ProtoSchema::of::<Back>()),
        ["loop", "must"],
        "Back's"
    );
    assert_eq!(names(&ProtoSchema::of::<Loop>()), ["back"], "Loop's");

    // Loop {back {loop {back {must {}}}}}, as the wire gives it
    let bytes = hexadecimal::bytes_of("0A 06 0A 04 0A 02 12 00").expect("bytes");
    let view: LoopView<'_> = DecodeOptions::new().decode_view(&bytes).expect("a view");
    let unset = unset_of(&view, &ProtoSchema::of::<Loop>()).expect("its must unset");

    assert_eq!(
        unset
            .steps()
            .iter()
            .map(|step| (step.field().name(), step.place().clone()))
            .chain([(unset.field().name(), Place::Field)])
            .map(|(name, _)| name)
            .collect::<Vec<_>>(),
        ["back", "loop", "back", "must", "must"],
        "its way through the cycle"
    );
}

// ── The Rust side's own ───────────────────────────────────────────────────────

// a matrix row: no counterpart, since a Rust String holds no surrogate alone; the string the other
// sides' writers repair is the one an application makes of such code units before Bead sees them
#[test]
fn a_proto_string_holding_a_surrogate_alone_is_no_string_on_the_rust_side() {
    let units = [0x61, 0xD800, 0x62];

    assert!(
        String::from_utf16(&units).is_err(),
        "no String of a, U+D800, b"
    );

    let probe = Probe {
        text: String::from_utf16_lossy(&units),
        ..Probe::default()
    };

    assert_eq!(
        hex_of(&ProtoCodec::<Probe>::new().encode(&probe).expect("written")),
        "0A 05 61 EF BF BD 62",
        "the repaired string, as the other sides write it"
    );
}

// a matrix row: an owned message holds a required scalar and enum bare, which no value leaves
// unset, and a closed enum as its Rust enum, which holds no undeclared number; the dynamic codec
// is given both, and refuses each
#[test]
fn a_typed_value_leaves_no_required_field_unset_and_holds_no_undeclared_number_on_the_rust_side() {
    let probe = ProtoCodec::<Probe>::new();
    let needs_left = Probe {
        needs: MessageField::some(codecs::Needs::default()),
        ..Probe::default()
    };

    // * the closest a typed value comes to needs set to no field is needs set at its defaults
    assert_eq!(
        hex_of(&probe.encode(&needs_left).expect("written")),
        "3A 04 08 00 10 00",
        "needs at its defaults"
    );
    assert_eq!(Shade::from_i32(5), None, "no Shade of 5");

    let dynamic = dynamic_of("bead.codecs.v1.Probe");
    let needs = dynamic_of("bead.codecs.v1.Needs");

    for (fields, name) in [
        (vec![], "bead.codecs.v1.Needs.must"),
        (
            vec![("must", Value::U32(0)), ("shade", Value::EnumNumber(5))],
            "bead.codecs.v1.Needs.shade",
        ),
    ] {
        let value = message_of(
            &dynamic,
            vec![("needs", Value::Message(message_of(&needs, fields)))],
        );

        assert_eq!(
            dynamic
                .encode(&value)
                .map_err(|refusal| refusal.to_string()),
            Err(words_of(name)),
            "{name} refused"
        );
    }
}

// ! Buffa's descriptors read an edition's singular message field of LEGACY_REQUIRED presence as of
// explicit presence; the schema reads the field's own feature, so such a field left unset is
// refused reading and writing, a typed value's among them, which holds a message set or not
#[test]
fn refuses_a_message_that_leaves_an_edition_s_required_message_field_unset_reading_and_writing() {
    let typed = ProtoCodec::<NeedsUpdate>::new();
    let words = Err(words_of("bead.transcoding.v1.NeedsUpdate.update_mask"));

    assert_eq!(
        typed
            .decode(&bytes_of(""))
            .map(|_| ())
            .map_err(|refusal| refusal.to_string()),
        words,
        "read by the typed codec"
    );
    assert_eq!(
        dynamic_of("bead.transcoding.v1.NeedsUpdate")
            .decode(&bytes_of(""))
            .map(|_| ())
            .map_err(|refusal| refusal.to_string()),
        words,
        "read by the dynamic codec"
    );
    assert_eq!(
        typed
            .encode(&NeedsUpdate::default())
            .map(|_| ())
            .map_err(|refusal| refusal.to_string()),
        words,
        "written"
    );

    let given = typed.decode(&bytes_of("12 00")).expect("its mask given");

    assert_eq!(
        hex_of(&typed.encode(&given).expect("written")),
        "12 00",
        "its mask given, written"
    );
}

#[test]
fn writes_a_dynamic_message_of_its_own_message_alone() {
    let probe = dynamic_of("bead.codecs.v1.Probe");
    let needs = dynamic_of("bead.codecs.v1.Needs");

    assert_eq!(
        probe
            .encode(&message_of(&needs, vec![]))
            .map_err(|refusal| refusal.to_string()),
        Err(
            "a proto value of bead.codecs.v1.Needs, where its codec writes bead.codecs.v1.Probe"
                .to_owned()
        ),
        "a Needs given to Probe's codec"
    );
    assert_eq!(probe.encoding(), "proto", "its encoding");
    assert_eq!(
        ProtoCodec::<Probe>::new().encoding(),
        "proto",
        "the typed codec's"
    );
}

#[test]
fn shares_its_schema_with_its_clones_and_shows_its_message_by_name() {
    let codec = ProtoCodec::<Probe>::default();

    assert!(
        ptr::eq(codec.schema().root(), codec.clone().schema().root()),
        "one schema"
    );
    assert_eq!(
        format!("{codec:?}"),
        "ProtoCodec(ProtoSchema { message: \"bead.codecs.v1.Probe\", .. })",
        "the typed codec"
    );
    assert_eq!(
        format!("{:?}", dynamic_of("bead.codecs.v1.Probe")),
        "DynamicCodec { schema: ProtoSchema { message: \"bead.codecs.v1.Probe\", .. } }",
        "the dynamic codec"
    );
}
