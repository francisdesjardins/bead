//! The check of a `proto` payload's records, on `Probe`, the message of `spec/codecs.proto`, and on
//! a descriptor written here where `Probe` reaches no case: the twin of the TypeScript side's
//! `records.test.ts` and the C# side's `ProtoRecordsTests`. `spec/codecs.json`'s entries play the
//! check through the codecs.

use std::iter;
use std::ptr;
use std::sync::Arc;

use bead::testing::hexadecimal;
use buffa::{Message, MessageField};
use buffa_descriptor::generated::descriptor::field_descriptor_proto::{Label, Type};
use buffa_descriptor::generated::descriptor::{
    DescriptorProto, EnumDescriptorProto, EnumValueDescriptorProto, FieldDescriptorProto,
    FileDescriptorProto, FileDescriptorSet, MessageOptions,
};
use buffa_descriptor::{DescriptorPool, ScalarType, SingularKind};

use super::{Holds, ProtoSchema, check_records};
use crate::testing::codecs::Probe;

// bytes as the conformance files write them, in hexadecimal, a space between two
fn bytes_of(hex: &str) -> Vec<u8> {
    hexadecimal::bytes_of(hex).expect("bytes in hexadecimal")
}

fn probe() -> ProtoSchema {
    ProtoSchema::of::<Probe>()
}

fn takes(schema: &ProtoSchema, hex: &str) {
    assert!(
        check_records(&bytes_of(hex), schema).is_ok(),
        "the check takes {hex}"
    );
}

fn refuses(schema: &ProtoSchema, hex: &str) {
    assert!(
        check_records(&bytes_of(hex), schema).is_err(),
        "the check refuses {hex}"
    );
}

// a record of the tag `tag` given whole, its length before it
fn delimited(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut length = payload.len();
    let mut record = vec![tag];

    while length >= 0x80 {
        record.push(u8::try_from(length & 0x7F).expect("seven bits") | 0x80);
        length >>= 7;
    }

    record.push(u8::try_from(length).expect("seven bits"));
    record.extend_from_slice(payload);
    record
}

// a Probe holding `depth` messages below it, each one's message given by `nest`
fn nested(depth: usize, nest: fn(&[u8]) -> Vec<u8>) -> Vec<u8> {
    (0..depth).fold(Vec::new(), |bytes, _| nest(&bytes))
}

// a child holding the message given
fn child(message: &[u8]) -> Vec<u8> {
    delimited(0x1A, message)
}

// a map's entry, its key empty and its value the message given: two messages below its own
fn entry(message: &[u8]) -> Vec<u8> {
    delimited(0x62, &delimited(0x12, message))
}

// a group of delimited holding the message given
fn group(message: &[u8]) -> Vec<u8> {
    iter::once(0x6B)
        .chain(message.iter().copied())
        .chain([0x6C])
        .collect()
}

// a field of a descriptor written by hand
fn field_of(name: &str, (number, kind): (i32, Type)) -> FieldDescriptorProto {
    FieldDescriptorProto {
        name: Some(name.to_owned()),
        json_name: Some(name.to_owned()),
        number: Some(number),
        label: Some(Label::LABEL_OPTIONAL),
        r#type: Some(kind),
        ..FieldDescriptorProto::default()
    }
}

#[test]
fn refuses_reserved_wire_types_on_unknown_fields_as_well_as_known_fields() {
    let schema = probe();

    for hex in ["A0 06 01", "1A 03 A0 06 01"] {
        takes(&schema, hex);
    }

    for hex in ["0E", "0F", "A6 06", "A7 06", "1A 02 A6 06", "1A 02 A7 06"] {
        refuses(&schema, hex);
    }
}

#[test]
fn reads_enum_map_values_as_varints_and_refuses_other_wire_types_or_undeclared_entry_fields() {
    let file = FileDescriptorProto {
        name: Some("enum-map.proto".to_owned()),
        package: Some("coverage".to_owned()),
        syntax: Some("proto3".to_owned()),
        enum_type: vec![EnumDescriptorProto {
            name: Some("Choice".to_owned()),
            value: [("ZERO", 0), ("ONE", 1)]
                .into_iter()
                .map(|(name, number)| EnumValueDescriptorProto {
                    name: Some(name.to_owned()),
                    number: Some(number),
                    ..EnumValueDescriptorProto::default()
                })
                .collect(),
            ..EnumDescriptorProto::default()
        }],
        message_type: vec![DescriptorProto {
            name: Some("Map".to_owned()),
            field: vec![FieldDescriptorProto {
                label: Some(Label::LABEL_REPEATED),
                type_name: Some(".coverage.Map.ValuesEntry".to_owned()),
                ..field_of("values", (1, Type::TYPE_MESSAGE))
            }],
            nested_type: vec![DescriptorProto {
                name: Some("ValuesEntry".to_owned()),
                options: MessageField::some(MessageOptions {
                    map_entry: Some(true),
                    ..MessageOptions::default()
                }),
                field: vec![
                    field_of("key", (1, Type::TYPE_STRING)),
                    FieldDescriptorProto {
                        type_name: Some(".coverage.Choice".to_owned()),
                        ..field_of("value", (2, Type::TYPE_ENUM))
                    },
                ],
                ..DescriptorProto::default()
            }],
            ..DescriptorProto::default()
        }],
        ..FileDescriptorProto::default()
    };
    let pool = DescriptorPool::new(FileDescriptorSet {
        file: vec![file],
        ..FileDescriptorSet::default()
    })
    .expect("a pool of the file");
    let index = pool.message_index("coverage.Map").expect("its Map");
    let schema = ProtoSchema::new(Arc::new(pool), index);

    for hex in [
        "",
        "0A 00",
        "0A 03 0A 01 61",
        "0A 02 10 01",
        "0A 05 0A 01 61 10 01",
        "0A 05 10 01 0A 01 61",
        "0A 02 10 7F",
        "0A 04 10 01 10 00",
    ] {
        takes(&schema, hex);
    }

    for hex in [
        "0A 02 12 00",
        "0A 05 15 00 00 00 00",
        "0A 02 13 14",
        "0A 02 18 01",
        "0A 02 10 80",
        "0A 02 08 01",
    ] {
        refuses(&schema, hex);
    }
}

#[test]
fn takes_every_record_a_message_holds_a_group_closed_by_its_own_end_group_a_map_of_messages_a_repeated_scalar_packed_or_not_and_an_unknown_field_of_each_wire_type_skipped()
 {
    let schema = probe();

    for hex in [
        // nothing at all, and text, number and a child
        "",
        "0A 01 61 10 07 1A 03 0A 01 62",
        // a group closed by its own end group, one in another, and one in a child
        "6B 0A 01 61 6C",
        "6B 6B 10 01 6C 6C",
        "1A 05 6B 0A 01 61 6C",
        // a map of messages, its value before its key, and an entry with no field
        "62 07 0A 01 6B 12 02 10 01",
        "62 07 12 02 10 01 0A 01 6B",
        "62 00 62 02 0A 00 62 02 12 00",
        // counts packed, unpacked, and both; stamps packed and unpacked
        "52 03 01 02 03",
        "50 01 52 02 02 03",
        "52 00",
        "5A 08 01 00 00 00 02 00 00 00",
        "5D 01 00 00 00",
        // an unknown field of each wire type, an unknown group holding one of each
        "21 01 02 03 04 05 06 07 08 2A 01 7A 35 01 02 03 04 20 96 01",
        "23 21 01 02 03 04 05 06 07 08 2A 01 7A 35 01 02 03 04 20 01 2B 2C 24",
        // ! an unknown length-delimited record is opaque: what it holds is no record
        "2A 02 FF FF",
        // a tag of 5 bytes within 32 bits, and a varint of 10 bytes
        "C8 80 80 80 00 01 0A 01 62",
        "10 FF FF FF FF FF FF FF FF FF 01",
    ] {
        let bytes = bytes_of(hex);

        takes(&schema, hex);

        // * what the check takes, Buffa reads
        assert!(
            Probe::decode_from_slice(&bytes).is_ok(),
            "Buffa reads {hex}"
        );
    }
}

// spec 17.9.1
#[test]
fn refuses_a_record_past_the_end_of_its_message_at_any_depth_its_field_known_or_not() {
    let schema = probe();

    for hex in [
        // a string past its child, at the top, two children down, in a map's value and in a group
        "1A 02 0A 03 61 62 63",
        "0A 03 61 62",
        "1A 05 1A 03 0A 02 61 62 63",
        "62 06 12 04 0A 03 61 62",
        "6B 0A 05 61 6C",
        // an unknown record of each wire type past its child
        "0A 01 61 1A 02 25 00 0A 01 62",
        "1A 02 21 00 00 00 00 00 00 00 00",
        "1A 02 2A 05 00 00 00 00 00",
        "1A 02 20 80 01",
        // a fixed value past the top message, its field known
        "5D 01 00",
    ] {
        refuses(&schema, hex);
    }
}

// spec 17.9.1
#[test]
fn refuses_a_packed_record_whose_values_do_not_end_at_its_length() {
    let schema = probe();

    for hex in [
        // a fixed32 run whose length is no multiple of 4
        "5A 05 01 00 00 00 02",
        "5A 03 01 00 00",
        // a varint run whose last value runs past its record, a field after
        "52 02 05 81 01 10 07",
        "52 01 81",
        // a varint of more than 10 bytes in a run
        "52 0B 80 80 80 80 80 80 80 80 80 80 00",
    ] {
        refuses(&schema, hex);
    }
}

// spec 17.9.1
#[test]
fn refuses_a_varint_of_more_than_10_bytes_its_field_known_or_not() {
    let schema = probe();

    for hex in [
        "10 80 80 80 80 80 80 80 80 80 80 00",
        "48 80 80 80 80 80 80 80 80 80 80 00",
        "1A 0C 20 80 80 80 80 80 80 80 80 80 80 00",
    ] {
        refuses(&schema, hex);
    }
}

// spec 17.9.1
#[test]
fn refuses_a_tag_of_more_than_5_bytes_or_past_32_bits() {
    let schema = probe();

    for hex in [
        "90 80 80 80 80 00 07",
        "90 80 80 80 80 80 80 80 00 07",
        "90 80 80 80 40 07",
        "90 80 80 80 80 80 0F 07",
        "F8 FF FF FF 7F 01",
        "90 80 80 80 80 80 80 80 80 80 80 00 07",
        // and field number 0, wire types 6 and 7, a tag cut short
        "00 01",
        "0E",
        "0F",
        "90",
    ] {
        refuses(&schema, hex);
    }
}

// spec 17.9.1
#[test]
fn refuses_a_length_past_the_bytes_that_follow_it_a_varint_past_32_bits_among_them() {
    let schema = probe();

    for hex in [
        "0A 05 61",
        "2A 05 61",
        "0A 80 80 80 80 10",
        "0A 80 80 80 80 10 10 07",
        "2A FF FF FF FF FF FF FF FF FF 01",
    ] {
        refuses(&schema, hex);
    }
}

// spec 17.9.3
#[test]
fn refuses_a_message_nested_more_than_100_deep_below_the_top_one_groups_and_map_entries_counted() {
    let schema = probe();
    let checks = |bytes: &[u8]| check_records(bytes, &schema).is_ok();

    // * by child, by group, by map's entry, which holds its value one deeper, and by unknown group
    assert!(checks(&nested(100, child)), "100 children deep");
    assert!(!checks(&nested(101, child)), "101 children deep");
    assert!(checks(&nested(100, group)), "100 groups deep");
    assert!(!checks(&nested(101, group)), "101 groups deep");
    assert!(checks(&nested(50, entry)), "50 entries deep");
    assert!(!checks(&nested(51, entry)), "51 entries deep");

    // ! an entry below 98 children holds its value at 100; below 99, at 101
    let below = (0..98).fold(entry(&[]), |bytes, _| child(&bytes));

    assert!(checks(&below), "an entry below 98 children");
    assert!(!checks(&child(&below)), "an entry below 99 children");

    let unknown = |depth: usize| -> Vec<u8> {
        iter::repeat_n(0x23, depth)
            .chain(iter::repeat_n(0x24, depth))
            .collect()
    };

    assert!(checks(&unknown(100)), "100 unknown groups deep");
    assert!(!checks(&unknown(101)), "101 unknown groups deep");
}

#[test]
fn builds_a_message_s_shape_once_from_its_descriptor_a_message_that_holds_itself_among_them() {
    let schema = probe();
    let shape = schema.root();
    let itself = Some(Holds::Message(schema.message()));

    // * one shape of each message, which every clone of the schema shares
    assert!(
        ptr::eq(shape, schema.clone().root()),
        "one shape, shared by a clone"
    );

    // * child and delimited hold Probe itself, and a map's entry holds it as its value
    assert_eq!(
        shape.field(3).and_then(|field| field.holds),
        itself,
        "child"
    );
    assert_eq!(
        shape.field(13).and_then(|field| field.holds),
        itself,
        "delimited"
    );
    assert_eq!(
        shape.field(12).and_then(|field| field.holds),
        Some(Holds::Entry {
            key: ScalarType::String,
            value: SingularKind::Message(schema.message())
        }),
        "children"
    );
    assert_eq!(
        shape.field(1).and_then(|field| field.holds),
        None,
        "text holds no message"
    );
    assert!(shape.field(4).is_none(), "Probe declares no 4");

    // its child walked by the same shape: child at the varint wire type, two deep
    takes(&schema, "1A 04 1A 02 1A 00");
    refuses(&schema, "1A 04 1A 02 18 01");
}

// spec 17.9.5
#[test]
fn refuses_a_field_at_a_wire_type_its_type_does_not_take_in_a_map_s_entry_too() {
    let schema = probe();

    for hex in [
        // text at the varint wire type, number at the length-delimited and the fixed32, child at
        // the varint, stamps at the varint, delimited at the length-delimited, child at the start
        // group, counts at the fixed64 and the fixed32
        "08 61",
        "12 00",
        "15 01 02 03 04",
        "18 03 0A 05 61 62 63 64 65",
        "58 01",
        "6A 03 0A 01 61",
        "1B 1C",
        "51 01 00 00 00 00 00 00 00",
        "55 01 00 00 00",
        // a map's key at the varint wire type, its value at the varint and the start group
        "62 04 08 02 12 00",
        "62 04 0A 00 10 01",
        "62 04 0A 00 13 14",
        // a child's field
        "1A 02 08 61",
    ] {
        refuses(&schema, hex);
    }
}

// spec 17.9.6
#[test]
fn refuses_a_map_s_entry_with_a_field_it_does_not_declare() {
    let schema = probe();

    for hex in [
        "62 0C 1A 0A 01 7A 12 06 0A 04 61 62 63 64",
        "62 05 0A 00 1A 01 7A",
        "62 04 0A 00 18 01",
        "62 04 0A 00 23 24",
        "62 07 0A 00 1D 01 02 03 04",
    ] {
        refuses(&schema, hex);
    }
}
