use std::sync::{Arc, LazyLock};

use bead::{MessageForm, MessageFormError, RequestPlace};
use buffa_descriptor::reflect::{
    DynamicMessage, MapKey, MapValue, ReflectMessage, ReflectMessageMut, Value,
};
use buffa_descriptor::{DescriptorPool, MessageIndex};

use super::base64::base64_of;
use super::read::read_draft;
use super::text::read_text;
use super::{JsonForm, write_message};
use crate::records::ProtoSchema;

// ── The fixture's pool ────────────────────────────────────────────────────────

// the set protoc wrote of the tests' files and their imports: spec/transcoding.proto's messages,
// spec/validations.proto's, descriptor.proto's, read by their descriptors alone
static POOL: LazyLock<Arc<DescriptorPool>> = LazyLock::new(|| {
    Arc::new(
        DescriptorPool::decode(include_bytes!("../../proto/tests.binpb"))
            .expect("the tests' descriptor set reads"),
    )
});

static BASE: LazyLock<ProtoSchema> = LazyLock::new(|| {
    ProtoSchema::new(
        Arc::clone(&POOL),
        index_of("bead.transcoding.v1.Everything"),
    )
});

const EVERYTHING: &str = "bead.transcoding.v1.Everything";
const EDGES: &str = "bead.transcoding.v1.Edges";
const INT32_VALUE_URL: &str = "type.googleapis.com/google.protobuf.Int32Value";
const INT64_VALUE_URL: &str = "type.googleapis.com/google.protobuf.Int64Value";

fn index_of(name: &str) -> MessageIndex {
    POOL.message_index(name)
        .unwrap_or_else(|| panic!("the pool holds {name}"))
}

pub(crate) fn schema_of(name: &str) -> ProtoSchema {
    BASE.at(index_of(name))
}

pub(crate) fn form_of(name: &str) -> Arc<dyn MessageForm> {
    JsonForm::new(Arc::clone(&POOL)).form_of(schema_of(name))
}

fn times(text: &str, count: usize) -> String {
    core::iter::repeat_n(text, count).collect()
}

// ── Reading and writing ───────────────────────────────────────────────────────

fn decoded(name: &str, bytes: &[u8]) -> DynamicMessage {
    DynamicMessage::decode(Arc::clone(&POOL), index_of(name), bytes).expect("a payload decodes")
}

fn read(name: &str, body: &str) -> DynamicMessage {
    let bytes = form_of(name)
        .read(body.as_bytes())
        .unwrap_or_else(|error| panic!("{body} reads: {error}"));

    decoded(name, &bytes)
}

// why `body` is refused as a message of `name`, in the words of transcoding 5, and where
fn refusal_of(name: &str, body: &str) -> Option<(String, Option<RequestPlace>)> {
    match form_of(name).read(body.as_bytes()) {
        Ok(_) => None,
        Err(MessageFormError::Form(error)) => {
            Some((error.reason().to_owned(), error.place().cloned()))
        }
        Err(error) => panic!("{body}: {error}"),
    }
}

fn reason_of(name: &str, body: &str) -> Option<String> {
    refusal_of(name, body).map(|(reason, _)| reason)
}

fn pointer(text: &str) -> RequestPlace {
    RequestPlace::Pointer(text.to_owned())
}

// `message`'s JSON, as a result comes: through its payload, read by its stock library first
fn write(message: &DynamicMessage) -> Result<String, MessageFormError> {
    let name = message.message_descriptor().full_name().to_owned();
    let payload = message.try_encode_to_vec().expect("a message encodes");

    form_of(&name).write(&payload, None)
}

fn written(message: &DynamicMessage) -> String {
    write(message).unwrap_or_else(|error| panic!("a message writes: {error}"))
}

// why the mapping refuses to write `message`, in the companion's words
fn write_refusal(message: &DynamicMessage) -> String {
    match write(message) {
        Err(MessageFormError::Form(error)) => error.reason().to_owned(),
        Ok(text) => panic!("written, {text}"),
        Err(error) => panic!("refused otherwise: {error}"),
    }
}

// ── Building messages ─────────────────────────────────────────────────────────

fn message(name: &str, fields: Vec<(&str, Value)>) -> DynamicMessage {
    let mut built = DynamicMessage::new(Arc::clone(&POOL), index_of(name));

    for (field, value) in fields {
        let descriptor = POOL
            .message(index_of(name))
            .field_by_name(field)
            .unwrap_or_else(|| panic!("{name} has {field}"));

        built.set(descriptor, value);
    }

    built
}

fn held(name: &str, fields: Vec<(&str, Value)>) -> Value {
    Value::Message(message(name, fields))
}

fn edges(fields: Vec<(&str, Value)>) -> DynamicMessage {
    message(EDGES, fields)
}

fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn any(type_url: &str, bytes: Vec<u8>) -> Value {
    held(
        "google.protobuf.Any",
        vec![("type_url", text(type_url)), ("value", Value::Bytes(bytes))],
    )
}

fn instant(name: &str, (seconds, nanos): (i64, i32)) -> Value {
    held(
        name,
        vec![
            ("seconds", Value::I64(seconds)),
            ("nanos", Value::I32(nanos)),
        ],
    )
}

fn kind_of(number: &str, value: Value) -> Value {
    held("google.protobuf.Value", vec![(number, value)])
}

fn struct_of(members: Vec<(&str, Value)>) -> Value {
    held(
        "google.protobuf.Struct",
        vec![(
            "fields",
            Value::Map(MapValue::from_entries(
                members
                    .into_iter()
                    .map(|(name, value)| (MapKey::String(name.to_owned()), value))
                    .collect(),
            )),
        )],
    )
}

fn nested_edges(count: usize) -> DynamicMessage {
    let mut built = edges(vec![]);

    for _ in 0..count {
        built = edges(vec![("child", Value::Message(built))]);
    }

    built
}

fn value_of(message: &DynamicMessage, field: &str) -> Value {
    let descriptor = message
        .message_descriptor()
        .field_by_name(field)
        .unwrap_or_else(|| panic!("a field {field}"));

    message.get(descriptor).to_owned()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
fn refuses_empty_and_trailing_json_texts_through_the_public_message_reader() {
    for body in [
        "",
        " \t\r\n",
        "{} {}",
        "{} true",
        "[] 0",
        "null false",
        "{}x",
    ] {
        assert_eq!(
            reason_of("google.protobuf.Empty", body).as_deref(),
            Some("not JSON"),
            "{body:?}"
        );
    }
}

#[test]
fn bounds_json_arrays_and_objects_before_reading_a_message() {
    for body in [
        format!("{}{}", times("[", 203), times("]", 203)),
        format!("{}0{}", times("{\"a\":", 203), times("}", 203)),
    ] {
        assert_eq!(
            reason_of("google.protobuf.Empty", &body).as_deref(),
            Some("nested past 100"),
            "a text nested 203 deep"
        );
    }
}

#[test]
fn packs_an_any_with_unset_proto2_required_fields_and_keeps_explicit_defaults_on_repeated_reads() {
    let type_url = "type.googleapis.com/google.protobuf.UninterpretedOption.NamePart";
    let cases: [(&str, &[u8]); 3] = [
        ("", &[]),
        (",\"namePart\":\"Ada\"", &[10, 3, 65, 100, 97]),
        (",\"namePart\":\"\",\"isExtension\":false", &[10, 0, 16, 0]),
    ];

    for (members, bytes) in cases {
        let body = format!("{{\"@type\":\"{type_url}\"{members}}}");

        for _pass in 0..2 {
            let read = read("google.protobuf.Any", &body);

            assert_eq!(value_of(&read, "type_url"), text(type_url), "{body}");
            assert_eq!(
                value_of(&read, "value"),
                Value::Bytes(bytes.to_vec()),
                "{body}"
            );
            assert_eq!(written(&read), body, "{body} written back");
        }
    }
}

#[test]
fn reads_and_writes_signed_infinities_and_nan_in_double_and_float_fields() {
    for (word, value) in [
        ("Infinity", f64::INFINITY),
        ("-Infinity", f64::NEG_INFINITY),
        ("NaN", f64::NAN),
    ] {
        let read = read(
            EDGES,
            &format!("{{\"aDouble\":\"{word}\",\"aFloat\":\"{word}\"}}"),
        );
        let (Value::F64(double), Value::F32(float)) =
            (value_of(&read, "a_double"), value_of(&read, "a_float"))
        else {
            panic!("a double and a float");
        };

        assert!(
            double.to_bits() == value.to_bits() || (double.is_nan() && value.is_nan()),
            "{word} as a double"
        );
        assert_eq!(
            f64::from(float).is_nan(),
            value.is_nan(),
            "{word} as a float"
        );
        assert_eq!(
            written(&read),
            format!("{{\"aFloat\":\"{word}\",\"aDouble\":\"{word}\"}}"),
            "{word} written"
        );
    }
}

#[test]
fn reads_enum_lists_by_name_or_number_and_refuses_an_invalid_member_at_its_index() {
    for body in [
        "{\"targets\":[1,4]}",
        "{\"targets\":[\"TARGET_TYPE_FILE\",\"TARGET_TYPE_FIELD\"]}",
    ] {
        let read = read("google.protobuf.FieldOptions", body);

        assert_eq!(
            value_of(&read, "targets"),
            Value::List(vec![Value::EnumNumber(1), Value::EnumNumber(4)]),
            "{body}"
        );
        assert_eq!(
            written(&read),
            "{\"targets\":[\"TARGET_TYPE_FILE\",\"TARGET_TYPE_FIELD\"]}",
            "{body} written"
        );
    }

    for (member, reason) in [
        ("999", "no value of OptionTargetType of that number"),
        ("\"NOPE\"", "no value of OptionTargetType of that name"),
        ("true", "no OptionTargetType"),
    ] {
        assert_eq!(
            refusal_of(
                "google.protobuf.FieldOptions",
                &format!("{{\"targets\":[1,{member}]}}")
            ),
            Some((reason.to_owned(), Some(pointer("#/targets/1")))),
            "{member}"
        );
    }
}

#[test]
fn refuses_unknown_numbers_of_a_closed_enum_and_keeps_open_enum_numbers() {
    let name = "google.protobuf.FieldDescriptorProto";

    for body in ["{\"type\":1}", "{\"type\":\"TYPE_DOUBLE\"}"] {
        let read = read(name, body);

        assert_eq!(value_of(&read, "type"), Value::EnumNumber(1), "{body}");
        assert_eq!(
            written(&read),
            "{\"type\":\"TYPE_DOUBLE\"}",
            "{body} written"
        );
    }

    for body in ["{\"type\":0}", "{\"type\":999}"] {
        assert_eq!(
            refusal_of(name, body),
            Some((
                "no value of Type of that number".to_owned(),
                Some(pointer("#/type"))
            )),
            "{body}"
        );
    }

    assert_eq!(
        value_of(&read(EDGES, "{\"aliased\":7}"), "aliased"),
        Value::EnumNumber(7),
        "an open enum's number kept"
    );
    assert_eq!(
        written(&edges(vec![("aliased", Value::EnumNumber(7))])),
        "{\"aliased\":7}",
        "an open enum's number written"
    );
}

#[test]
fn refuses_an_empty_value_that_is_not_an_object() {
    for body in ["1", "[]"] {
        assert_eq!(
            refusal_of("google.protobuf.Empty", body),
            Some(("an Empty that is no object".to_owned(), Some(pointer("#")))),
            "{body}"
        );
    }
}

#[test]
fn reads_unsigned_64_bit_map_keys_exactly_and_refuses_keys_outside_their_bounds() {
    let maps = "bead.validations.v1.Maps";

    for (field, member, kind) in [
        ("by_uint64", "byUint64", "uint64"),
        ("by_fixed64", "byFixed64", "fixed64"),
    ] {
        let read = read(
            maps,
            &format!(
                "{{\"{member}\":{{\"9007199254740993\":\"large\",\"18446744073709551615\":\"max\",\"0\":\"zero\"}}}}"
            ),
        );
        let Value::Map(map) = value_of(&read, field) else {
            panic!("a map");
        };

        assert_eq!(
            map.get(&MapKey::U64(9_007_199_254_740_993)),
            Some(&text("large")),
            "{member}: a key past a double's integers"
        );
        assert_eq!(
            map.get(&MapKey::U64(u64::MAX)),
            Some(&text("max")),
            "{member}: the largest"
        );
        assert_eq!(
            written(&read),
            format!(
                "{{\"{member}\":{{\"0\":\"zero\",\"18446744073709551615\":\"max\",\"9007199254740993\":\"large\"}}}}"
            ),
            "{member} written"
        );

        for (key, reason) in [
            ("-1", format!("a {kind} key past its range")),
            (
                "18446744073709551616",
                format!("a {kind} key past its range"),
            ),
            ("01", format!("a {kind} key off -?(0|[1-9][0-9]*)")),
            ("1e3", format!("a {kind} key off -?(0|[1-9][0-9]*)")),
        ] {
            assert_eq!(
                refusal_of(maps, &format!("{{\"{member}\":{{\"{key}\":\"x\"}}}}")),
                Some((reason, Some(pointer(&format!("#/{member}/{key}"))))),
                "{member}: {key}"
            );
        }
    }
}

#[test]
fn reads_the_limits_of_unsigned_64_bit_numbers_without_rounding() {
    for (digits, value) in [
        ("0", 0),
        ("9007199254740993", 9_007_199_254_740_993),
        ("18446744073709551615", u64::MAX),
    ] {
        for member in [digits.to_owned(), format!("\"{digits}\"")] {
            let read = read(EVERYTHING, &format!("{{\"aUint64\":{member}}}"));

            assert_eq!(value_of(&read, "a_uint64"), Value::U64(value), "{member}");
        }
    }

    for member in ["-1", "18446744073709551616"] {
        assert_eq!(
            reason_of(EVERYTHING, &format!("{{\"aUint64\":{member}}}")).as_deref(),
            Some("a uint64 past its range"),
            "{member}"
        );
    }
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "each scalar and well-known form, then each refusal, as the other sides pin them"
)]
fn reads_a_proto_body_by_bead_s_mapping_each_scalar_and_well_known_form_as_pinned() {
    let everything = read(
        EVERYTHING,
        "{\"an_int64\":9007199254740993,\"anInt32\":\"1e2\",\"aUint64\":\"18446744073709551615\",\"aFloat\":\"0.1\",\"someBytes\":\"-_8\",\"color\":2,\"renamed\":\"r\",\"labels\":{\"a\":1},\"byId\":{\"-0\":\"z\"},\"flags\":{\"true\":\"t\"},\"maybe\":0,\"choiceText\":null,\"choiceInner\":{\"name\":\"n\"},\"at\":\"1970-01-01T08:00:01+08:00\",\"took\":\"-0.5s\",\"mask\":\"fooBar,a.bC\",\"anyValue\":[1,\"x\",null],\"wrappedInt64\":\"7\",\"extra\":{\"k\":true}}",
    );

    assert_eq!(
        value_of(&everything, "an_int64"),
        Value::I64(9_007_199_254_740_993),
        "an int64"
    );
    assert_eq!(
        value_of(&everything, "an_int32"),
        Value::I32(100),
        "an int32 of 1e2"
    );
    assert_eq!(
        value_of(&everything, "a_uint64"),
        Value::U64(u64::MAX),
        "a uint64"
    );
    assert_eq!(value_of(&everything, "a_float"), Value::F32(0.1), "a float");
    assert_eq!(
        value_of(&everything, "some_bytes"),
        Value::Bytes(vec![0xFB, 0xFF]),
        "bytes of the URL-safe alphabet"
    );
    assert_eq!(
        value_of(&everything, "color"),
        Value::EnumNumber(2),
        "an enum"
    );
    assert_eq!(
        value_of(&everything, "custom_named"),
        text("r"),
        "a field by its json_name"
    );
    assert_eq!(
        value_of(&everything, "maybe"),
        Value::I32(0),
        "a field of its own presence"
    );
    assert_eq!(
        written(&everything),
        "{\"aFloat\":0.1,\"anInt64\":\"9007199254740993\",\"aUint64\":\"18446744073709551615\",\"anInt32\":100,\"someBytes\":\"+/8=\",\"color\":\"COLOR_GREEN\",\"labels\":{\"a\":1},\"byId\":{\"0\":\"z\"},\"flags\":{\"true\":\"t\"},\"maybe\":0,\"choiceInner\":{\"name\":\"n\"},\"at\":\"1970-01-01T00:00:01Z\",\"took\":\"-0.500s\",\"mask\":\"fooBar,a.bC\",\"extra\":{\"k\":true},\"anyValue\":[1,\"x\",null],\"wrappedInt64\":\"7\",\"renamed\":\"r\"}",
        "each form read, written back"
    );

    // what each form refuses, the stock libraries parting on many (decision 0037, D5 to D20)
    for (body, reason) in [
        ("{\"anInt32\":1,\"an_int32\":2}", "a field by its two names"),
        (
            "{\"anInt64\":\"1e3\"}",
            "an int64 string off -?(0|[1-9][0-9]*)",
        ),
        ("{\"anInt32\":0.5}", "an int32 that is no integer"),
        ("{\"aUint32\":-1}", "a uint32 past its range"),
        (
            "{\"someBytes\":\"+_8=\"}",
            "bytes of no one alphabet of base64",
        ),
        ("{\"someBytes\":\"AQ=\"}", "bytes padded wrongly"),
        (
            "{\"byInt32\":{\"01\":\"a\"}}",
            "an int32 key off -?(0|[1-9][0-9]*)",
        ),
        (
            "{\"at\":\"2026-02-30T00:00:00Z\"}",
            "a Timestamp of no instant",
        ),
        (
            "{\"at\":\"2026-10-21T12:00:00z\"}",
            "a Timestamp off RFC 3339",
        ),
        ("{\"took\":\"01s\"}", "a Duration off its form"),
        (
            "{\"mask\":\"FooBar\"}",
            "a FieldMask path off lowerCamelCase",
        ),
        ("{\"mask\":\"a,,b\"}", "a FieldMask of an empty path"),
        ("{\"any\":{\"x\":1}}", "an Any without its @type"),
        (
            "{\"aliased\":\"aliased_first\"}",
            "no value of Aliased of that name",
        ),
        (
            "{\"nullMember\":null,\"textMember\":\"a\"}",
            "two members of one oneof",
        ),
        ("{\"ints\":[1,null]}", "a null item"),
        (
            "{\"anInt32\":1,\"an\\u0049nt32\":2}",
            "a member named twice",
        ),
        ("{\"anInt32\":1,\"anInt32\":2}", "a member named twice"),
        (
            "{\"wrappedInt64\":\"1e3\"}",
            "an int64 string off -?(0|[1-9][0-9]*)",
        ),
        ("{\"took\":\"1.0000000001s\"}", "a Duration off its form"),
        ("{\"nope\":1}", "a key no field names"),
    ] {
        assert_eq!(reason_of(EDGES, body).as_deref(), Some(reason), "{body}");
    }

    assert_eq!(
        read_text(&[0xEF, 0xBB, 0xBF, 0x7B, 0x7D]).map_err(|refused| refused.reason().to_owned()),
        Err("a byte order mark".to_owned()),
        "a byte order mark"
    );

    // an Any of a message its definitions hold, its @type in any place
    let any = read(
        EDGES,
        "{\"any\":{\"count\":2,\"@type\":\"type.googleapis.com/bead.transcoding.v1.Inner\",\"name\":\"a\"}}",
    );
    let Value::Message(packed) = value_of(&any, "any") else {
        panic!("an Any");
    };
    let Value::Bytes(bytes) = value_of(&packed, "value") else {
        panic!("its bytes");
    };
    let inner = decoded("bead.transcoding.v1.Inner", &bytes);

    assert_eq!(value_of(&inner, "count"), Value::I32(2), "its count");
    assert_eq!(value_of(&inner, "name"), text("a"), "its name");
}

#[test]
fn counts_a_body_s_depth_by_its_message_a_value_nested_past_100_refused_before_it_is_built() {
    let lists =
        |count: usize, inside: &str| format!("{}{inside}{}", times("[", count), times("]", count));
    let children =
        |count: usize| format!("{}{{}}{}", times("{\"child\":", count), times("}", count));

    // * a Value at 1, each array a ListValue below it and each item a Value below that
    assert_eq!(
        reason_of(EDGES, &format!("{{\"value\":{}}}", lists(50, ""))),
        None,
        "50 lists"
    );
    assert_eq!(
        reason_of(EDGES, &format!("{{\"value\":{}}}", lists(50, "1"))).as_deref(),
        Some("nested past 100"),
        "a Value in 50 lists"
    );
    assert_eq!(reason_of(EDGES, &children(100)), None, "100 children");
    assert_eq!(
        reason_of(EDGES, &children(101)).as_deref(),
        Some("nested past 100"),
        "101 children"
    );
    // a map's entry is a message, its value one more
    assert_eq!(
        reason_of(
            EDGES,
            &format!(
                "{}{{\"labels\":{{\"a\":1}}}}{}",
                times("{\"child\":", 99),
                times("}", 99)
            )
        ),
        None,
        "a map's entry 100 deep"
    );
    assert_eq!(
        reason_of(
            EDGES,
            &format!(
                "{}{{\"labels\":{{\"a\":1}}}}{}",
                times("{\"child\":", 100),
                times("}", 100)
            )
        )
        .as_deref(),
        Some("nested past 100"),
        "a map's entry 101 deep"
    );
    // a repeated field's array counts nothing
    assert_eq!(
        reason_of(
            EDGES,
            &format!("{}{{}}{}", times("{\"children\":[", 100), times("]}", 100))
        ),
        None,
        "100 repeated children"
    );
    // a text past what any message nests is refused before its message is read, its nodes bounded
    assert_eq!(
        read_text(lists(300, "").as_bytes()).map_err(|refused| refused.reason().to_owned()),
        Err("nested past 100".to_owned()),
        "300 lists"
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "a result, an Any and a Struct, then each refusal, as the other sides pin them"
)]
fn writes_a_proto_result_in_bead_s_proto_json_form_its_fields_by_number_its_maps_sorted_type_first()
{
    let everything = message(
        EVERYTHING,
        vec![
            ("a_double", Value::F64(1e21)),
            ("a_string", text("\u{2028}<>\u{1f}")),
            ("an_int64", Value::I64(-5)),
            (
                "by_id",
                Value::Map(MapValue::from_entries(vec![
                    (MapKey::I64(10), text("x")),
                    (MapKey::I64(2), text("y")),
                    (MapKey::I64(-1), text("z")),
                ])),
            ),
            ("custom_named", text("r")),
            (
                "labels",
                Value::Map(MapValue::from_entries(vec![
                    (MapKey::String("b".to_owned()), Value::I32(1)),
                    (MapKey::String("a".to_owned()), Value::I32(2)),
                    (MapKey::String("é".to_owned()), Value::I32(3)),
                    (MapKey::String("Z".to_owned()), Value::I32(4)),
                ])),
            ),
            ("some_bytes", Value::Bytes(vec![0xFB])),
            ("wrapped_int64", held("google.protobuf.Int64Value", vec![])),
        ],
    );

    assert_eq!(
        written(&everything),
        "{\"aDouble\":1e+21,\"anInt64\":\"-5\",\"aString\":\"\u{2028}<>\\u001f\",\"someBytes\":\"+w==\",\"labels\":{\"Z\":4,\"a\":2,\"b\":1,\"é\":3},\"byId\":{\"-1\":\"z\",\"10\":\"x\",\"2\":\"y\"},\"wrappedInt64\":\"0\",\"renamed\":\"r\"}",
        "a result's members, its maps sorted"
    );
    assert_eq!(
        written(&edges(vec![
            (
                "any",
                any(
                    "type.googleapis.com/bead.transcoding.v1.Inner",
                    vec![0x10, 0x02]
                )
            ),
            (
                "extra",
                struct_of(vec![
                    ("b", kind_of("number_value", Value::F64(1.0))),
                    (
                        "a",
                        kind_of(
                            "list_value",
                            held(
                                "google.protobuf.ListValue",
                                vec![(
                                    "values",
                                    Value::List(vec![
                                        kind_of("bool_value", Value::Bool(true)),
                                        kind_of("null_value", Value::EnumNumber(0)),
                                    ]),
                                )],
                            ),
                        ),
                    ),
                ]),
            ),
        ])),
        "{\"extra\":{\"a\":[true,null],\"b\":1},\"any\":{\"@type\":\"type.googleapis.com/bead.transcoding.v1.Inner\",\"count\":2}}",
        "an Any, @type first, and a Struct sorted"
    );
    assert_eq!(
        written(&edges(vec![
            (
                "at",
                instant("google.protobuf.Timestamp", (-62_135_596_800, 1000))
            ),
            (
                "mask",
                held(
                    "google.protobuf.FieldMask",
                    vec![("paths", Value::List(vec![text("foo_bar"), text("a.b_c")]))],
                ),
            ),
            (
                "took",
                instant("google.protobuf.Duration", (-1, -500_000_000))
            ),
        ])),
        "{\"at\":\"0001-01-01T00:00:00.000001Z\",\"took\":\"-1.500s\",\"mask\":\"fooBar,a.bC\"}",
        "a Timestamp, a Duration and a FieldMask"
    );

    // what the form holds none of (5.7)
    assert_eq!(
        write_refusal(&edges(vec![(
            "mask",
            held(
                "google.protobuf.FieldMask",
                vec![("paths", Value::List(vec![text("foo_")]))]
            ),
        )])),
        "a FieldMask path whose lowerCamelCase does not read back"
    );
    assert_eq!(
        write_refusal(&edges(vec![(
            "value",
            kind_of("number_value", Value::F64(f64::NAN))
        )])),
        "a Value whose number is not finite"
    );
    assert_eq!(
        write_refusal(&edges(vec![(
            "any",
            any("type.googleapis.com/nope.Nope", vec![])
        )])),
        "an Any whose type its definitions do not hold"
    );
}

#[test]
fn writes_an_aliased_enum_by_its_first_name_a_float_at_its_shortest_and_a_minus_0_left_out() {
    assert_eq!(
        written(&edges(vec![("aliased", Value::EnumNumber(1))])),
        "{\"aliased\":\"ALIASED_FIRST\"}"
    );
    assert_eq!(
        written(&edges(vec![("aliased", Value::EnumNumber(7))])),
        "{\"aliased\":7}"
    );
    assert_eq!(
        written(&edges(vec![("a_float", Value::F32(0.1))])),
        "{\"aFloat\":0.1}"
    );
    assert_eq!(
        written(&edges(vec![
            ("a_float", Value::F32(f32::MAX)),
            (
                "wrapped_float",
                held(
                    "google.protobuf.FloatValue",
                    vec![("value", Value::F32(0.1))]
                )
            ),
        ])),
        "{\"wrappedFloat\":0.1,\"aFloat\":3.4028235e+38}"
    );
    assert_eq!(
        written(&edges(vec![("a_float", Value::F32(1e-45))])),
        "{\"aFloat\":1e-45}"
    );
    assert_eq!(
        written(&edges(vec![("a_float", Value::F32(f32::INFINITY))])),
        "{\"aFloat\":\"Infinity\"}"
    );
    assert_eq!(
        written(&edges(vec![
            ("a_double", Value::F64(-0.0)),
            ("a_float", Value::F32(-0.0))
        ])),
        "{}"
    );
    assert_eq!(
        written(&edges(vec![(
            "some_bytes",
            Value::Bytes(vec![0, 0xFF, 0xFE])
        )])),
        "{\"someBytes\":\"AP/+\"}"
    );
    assert_eq!(base64_of(&[0, 0xFF, 0xFE]), "AP/+", "standard base64");
    // * a field of no presence of its own at its default, given on the wire, is left out
    assert_eq!(
        form_of(EDGES)
            .write(&[0x90, 0x01, 0x00], None)
            .ok()
            .as_deref(),
        Some("{}"),
        "an int32 at 0 on the wire"
    );
    // a field of its own presence at -0 is written, 0
    assert_eq!(
        written(&edges(vec![("maybe_double", Value::F64(-0.0))])),
        "{\"maybeDouble\":0}"
    );
}

#[test]
fn refuses_a_text_that_is_no_json_a_string_left_open_or_wrongly_escaped_a_comma_or_a_colon_missing()
{
    let refusal = |text: &str| {
        read_text(text.as_bytes())
            .err()
            .map(|refused| refused.reason().to_owned())
    };

    assert_eq!(
        refusal("{\"a").as_deref(),
        Some("not JSON"),
        "a string left open"
    );
    assert_eq!(
        refusal("{\"a\":\"\\q\"}").as_deref(),
        Some("not JSON"),
        "a wrong escape"
    );
    assert_eq!(
        refusal("[1 2]").as_deref(),
        Some("not JSON"),
        "a comma missing"
    );
    assert_eq!(
        refusal("{\"a\" 1}").as_deref(),
        Some("not JSON"),
        "a colon missing"
    );
    assert_eq!(
        refusal("{\"a\":1 \"b\":2}").as_deref(),
        Some("not JSON"),
        "a comma missing"
    );
    assert_eq!(refusal("{\"a\":[1,2],\"b\":{}}"), None, "a text");
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "each refusal of the other sides' table, in its order"
)]
fn refuses_a_value_its_field_s_type_holds_none_of_each_by_its_reason() {
    let mut parted = Vec::new();

    for (name, body, words) in [
        (EDGES, "{\"labels\":[]}", "a map that is no object"),
        (EDGES, "{\"labels\":1}", "a map that is no object"),
        (
            EDGES,
            "{\"anInt32\":\"0.5\"}",
            "an int32 that is no integer",
        ),
        (EDGES, "{\"anInt32\":1e30}", "an int32 past its range"),
        (EDGES, "{\"extra\":1}", "a Struct that is no object"),
        (
            EDGES,
            "{\"any\":{\"@type\":\"type.googleapis.com/google.protobuf.ListValue\",\"value\":1}}",
            "a ListValue that is no array",
        ),
        (EDGES, "{\"ints\":1}", "a repeated field that is no array"),
        (EDGES, "{\"ints\":[null]}", "a null item"),
        (EDGES, "{\"labels\":{\"a\":null}}", "a null value in a map"),
        (
            EDGES,
            "{\"aliased\":1.5}",
            "an enum number that is no integer",
        ),
        (
            EDGES,
            "{\"aliased\":2147483648}",
            "an enum number past its range",
        ),
        (EDGES, "{\"aliased\":true}", "no Aliased"),
        (
            EDGES,
            "{\"aliased\":\"NOPE\"}",
            "no value of Aliased of that name",
        ),
        (EDGES, "{\"aDouble\":\"abc\"}", "no double"),
        (EDGES, "{\"aDouble\":true}", "no double"),
        (EDGES, "{\"aDouble\":\"1e400\"}", "a double past its range"),
        (EDGES, "{\"aFloat\":\"1e400\"}", "a float past its range"),
        (EDGES, "{\"someBytes\":1}", "no bytes"),
        (EDGES, "{\"someBytes\":\"AAAAA\"}", "bytes padded wrongly"),
        (
            EDGES,
            "{\"byUint32\":{\"4294967296\":\"a\"}}",
            "a uint32 key past its range",
        ),
        (
            EDGES,
            "{\"byInt64\":{\"1\":\"a\",\"01\":\"b\"}}",
            "an int64 key off -?(0|[1-9][0-9]*)",
        ),
        (
            EVERYTHING,
            "{\"flags\":{\"maybe\":\"a\"}}",
            "a bool key that is neither true nor false",
        ),
        (EDGES, "{\"anInt32\":1e41}", "an int32 past its range"),
        (EDGES, "{\"anInt32\":1e-41}", "an int32 that is no integer"),
        (EDGES, "{\"anInt32\":true}", "no int32"),
        (
            EVERYTHING,
            "{\"aUint64\":\"18446744073709551616\"}",
            "a uint64 past its range",
        ),
        (EVERYTHING, "{\"aFixed64\":-1}", "a fixed64 past its range"),
        (
            EVERYTHING,
            "{\"aSint64\":\"1.5\"}",
            "an sint64 string off -?(0|[1-9][0-9]*)",
        ),
        (EVERYTHING, "{\"aString\":1}", "no string"),
        (EDGES, "{\"extra\":[]}", "a Struct that is no object"),
        (EVERYTHING, "{\"list\":{}}", "a ListValue that is no array"),
        (EDGES, "{\"any\":1}", "an Any that is no object"),
        (
            EDGES,
            "{\"any\":{\"@type\":1}}",
            "an Any whose @type is no URL",
        ),
        (
            EDGES,
            "{\"any\":{\"@type\":\"type.googleapis.com/bead.transcoding.v1.Nope\"}}",
            "an Any of a type its definitions do not hold",
        ),
        (
            EDGES,
            "{\"any\":{\"@type\":\"type.googleapis.com/google.protobuf.Duration\",\"seconds\":1}}",
            "an Any of a well-known type whose members are not its value alone",
        ),
        (EDGES, "{\"child\":1}", "an Edges that is no object"),
        (EDGES, "{\"at\":1}", "a Timestamp that is no string"),
        (EDGES, "{\"at\":\"yesterday\"}", "a Timestamp off RFC 3339"),
        (
            EDGES,
            "{\"at\":\"2026-01-01T24:00:00Z\"}",
            "a Timestamp of no instant",
        ),
        (
            EDGES,
            "{\"at\":\"2026-04-31T00:00:00Z\"}",
            "a Timestamp of no instant",
        ),
        (
            EDGES,
            "{\"at\":\"1900-02-29T00:00:00Z\"}",
            "a Timestamp of no instant",
        ),
        (
            EDGES,
            "{\"at\":\"2026-01-01T00:00:00+24:00\"}",
            "a Timestamp of no offset",
        ),
        (
            EDGES,
            "{\"at\":\"0000-01-01T00:00:00Z\"}",
            "a Timestamp past its range",
        ),
        (EDGES, "{\"took\":1}", "a Duration off its form"),
        (
            EDGES,
            "{\"took\":\"315576000001s\"}",
            "a Duration past its range",
        ),
        (EDGES, "{\"mask\":1}", "a FieldMask that is no string"),
    ] {
        match reason_of(name, body) {
            None => parted.push(format!("{body}: taken, where {words}")),
            Some(reason) if reason != words => {
                parted.push(format!("{body}: {reason}, where {words}"));
            }
            Some(_) => {}
        }
    }

    assert_eq!(parted, Vec::<String>::new(), "each refusal in its words");
}

#[test]
fn reads_each_well_known_form_at_its_edges() {
    // * a leap day of a year that 400 divides, the earliest instant, an Empty, a Value of each kind
    let leap = read(EDGES, "{\"at\":\"2000-02-29T00:00:00Z\"}");

    assert_eq!(
        written(&leap),
        "{\"at\":\"2000-02-29T00:00:00Z\"}",
        "a leap day"
    );

    let Value::Message(at) = value_of(&leap, "at") else {
        panic!("a Timestamp");
    };

    assert_eq!(
        value_of(&at, "seconds"),
        Value::I64(951_782_400),
        "its seconds"
    );

    let earliest = read(EDGES, "{\"at\":\"0001-01-01T00:00:00Z\"}");
    let Value::Message(at) = value_of(&earliest, "at") else {
        panic!("a Timestamp");
    };

    assert_eq!(
        value_of(&at, "seconds"),
        Value::I64(-62_135_596_800),
        "the earliest"
    );
    assert_eq!(
        written(&read(EDGES, "{\"nothing\":{}}")),
        "{\"nothing\":{}}",
        "an Empty"
    );
    assert_eq!(
        written(&read(EDGES, "{\"value\":false}")),
        "{\"value\":false}",
        "a Value"
    );
    assert_eq!(
        written(&read(EDGES, "{\"value\":{\"a\":[null,\"b\"]}}")),
        "{\"value\":{\"a\":[null,\"b\"]}}",
        "a Value of a Struct"
    );

    let everything = read(
        EVERYTHING,
        "{\"list\":[1],\"wrappedBool\":true,\"wrappedString\":\"\"}",
    );

    assert_eq!(
        written(&everything),
        "{\"wrappedString\":\"\",\"list\":[1],\"wrappedBool\":true}",
        "a ListValue and wrappers, at their default too"
    );

    // a map of each key's form, bytes of the URL-safe alphabet, the empty Any
    let keyed = read(
        EVERYTHING,
        "{\"flags\":{\"true\":\"t\",\"false\":\"f\"},\"byId\":{\"-1\":\"a\"},\"someBytes\":\"-_8\"}",
    );

    assert_eq!(
        written(&keyed),
        "{\"someBytes\":\"+/8=\",\"byId\":{\"-1\":\"a\"},\"flags\":{\"false\":\"f\",\"true\":\"t\"}}",
        "keys of each form"
    );
    assert_eq!(
        written(&read(EDGES, "{\"byUint32\":{\"4294967295\":\"a\"}}")),
        "{\"byUint32\":{\"4294967295\":\"a\"}}",
        "the largest uint32 key"
    );
    assert_eq!(
        written(&read(EDGES, "{\"any\":{}}")),
        "{\"any\":{}}",
        "the empty Any"
    );
}

#[test]
fn writes_each_well_known_form_at_its_edges_and_refuses_what_its_form_holds_none_of() {
    // * a second before the epoch, an Any of an Empty, the empty Any, a map of bool keys
    assert_eq!(
        written(&edges(vec![(
            "at",
            instant("google.protobuf.Timestamp", (-1, 500_000_000))
        )])),
        "{\"at\":\"1969-12-31T23:59:59.500Z\"}"
    );
    assert_eq!(
        written(&edges(vec![(
            "any",
            any("type.googleapis.com/google.protobuf.Empty", vec![])
        )])),
        "{\"any\":{\"@type\":\"type.googleapis.com/google.protobuf.Empty\"}}"
    );
    assert_eq!(
        written(&edges(vec![("any", held("google.protobuf.Any", vec![]))])),
        "{\"any\":{}}"
    );
    assert_eq!(
        written(&edges(vec![(
            "took",
            instant("google.protobuf.Duration", (-1, -1))
        )])),
        "{\"took\":\"-1.000000001s\"}"
    );
    assert_eq!(
        written(&edges(vec![(
            "took",
            instant("google.protobuf.Duration", (0, 1000))
        )])),
        "{\"took\":\"0.000001s\"}"
    );
    assert_eq!(
        written(&message(
            EVERYTHING,
            vec![(
                "flags",
                Value::Map(MapValue::from_entries(vec![
                    (MapKey::Bool(true), text("t")),
                    (MapKey::Bool(false), text("f")),
                ])),
            )],
        )),
        "{\"flags\":{\"false\":\"f\",\"true\":\"t\"}}"
    );

    let mut parted = Vec::new();

    for (field, value, words) in [
        (
            "at",
            instant("google.protobuf.Timestamp", (0, -1)),
            "a Timestamp outside its range",
        ),
        (
            "at",
            instant("google.protobuf.Timestamp", (253_402_300_800, 0)),
            "a Timestamp outside its range",
        ),
        (
            "took",
            instant("google.protobuf.Duration", (1, -1)),
            "a Duration outside its range",
        ),
        (
            "took",
            instant("google.protobuf.Duration", (315_576_000_001, 0)),
            "a Duration outside its range",
        ),
        (
            "any",
            any("nope", vec![]),
            "an Any whose type its definitions do not hold",
        ),
        (
            "any",
            any("type.googleapis.com/bead.transcoding.v1.Inner", vec![0xFF]),
            "an Any whose bytes do not read as its type",
        ),
    ] {
        match write(&edges(vec![(field, value)])) {
            Ok(_) => parted.push(format!("{field}: written, where {words}")),
            Err(MessageFormError::Form(error)) if error.reason() != words => {
                parted.push(format!("{field}: {}, where {words}", error.reason()));
            }
            Err(MessageFormError::Form(_)) => {}
            Err(error) => parted.push(format!("{field}: {error}, where {words}")),
        }
    }

    assert_eq!(parted, Vec::<String>::new(), "each refusal in its words");
}

#[test]
fn reads_and_writes_an_any_of_a_wrapper_by_its_value_and_a_wrapper_alone_as_its_scalar() {
    let packed = format!("{{\"any\":{{\"@type\":\"{INT32_VALUE_URL}\",\"value\":3}}}}");
    let int64 = read(
        EDGES,
        &format!("{{\"any\":{{\"@type\":\"{INT64_VALUE_URL}\",\"value\":\"7\"}}}}"),
    );
    let Value::Message(any_of) = value_of(&int64, "any") else {
        panic!("an Any");
    };

    // * a wrapper in an Any under value, as its scalar
    assert_eq!(
        value_of(&any_of, "type_url"),
        text(INT64_VALUE_URL),
        "its type"
    );
    assert_eq!(
        value_of(&any_of, "value"),
        Value::Bytes(vec![0x08, 0x07]),
        "its bytes"
    );
    assert_eq!(
        written(&edges(vec![(
            "any",
            any(INT64_VALUE_URL, vec![0x08, 0x07])
        )])),
        format!("{{\"any\":{{\"@type\":\"{INT64_VALUE_URL}\",\"value\":\"7\"}}}}"),
        "an Any of an Int64Value written"
    );

    let int32 = read(EDGES, &packed);
    let Value::Message(any_of) = value_of(&int32, "any") else {
        panic!("an Any");
    };

    assert_eq!(
        value_of(&any_of, "value"),
        Value::Bytes(vec![0x08, 0x03]),
        "an Int32Value's bytes"
    );
    assert_eq!(
        written(&edges(vec![(
            "any",
            any(INT32_VALUE_URL, vec![0x08, 0x03])
        )])),
        packed,
        "an Any of an Int32Value written"
    );

    // a wrapper alone, read and written as its scalar, at its default too
    assert_eq!(
        value_of(&read("google.protobuf.Int32Value", "3"), "value"),
        Value::I32(3),
        "a wrapper read"
    );
    assert_eq!(
        written(&message(
            "google.protobuf.Int32Value",
            vec![("value", Value::I32(3))]
        )),
        "3"
    );
    assert_eq!(
        written(&message(
            "google.protobuf.StringValue",
            vec![("value", text("a"))]
        )),
        "\"a\""
    );
    assert_eq!(written(&message("google.protobuf.Int32Value", vec![])), "0");
    assert_eq!(
        written(&message(
            "google.protobuf.Int64Value",
            vec![("value", Value::I64(-3))]
        )),
        "\"-3\""
    );
}

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "each kind of Value built whole, as the other sides build it"
)]
fn writes_each_kind_of_value_and_a_struct_within_a_struct_in_its_own_form() {
    let null = || kind_of("null_value", Value::EnumNumber(0));

    // * each kind, a Struct's members sorted, one within another
    assert_eq!(
        written(&edges(vec![(
            "value",
            kind_of("bool_value", Value::Bool(false))
        )])),
        "{\"value\":false}"
    );
    assert_eq!(written(&edges(vec![("value", null())])), "{\"value\":null}");
    assert_eq!(
        written(&edges(vec![(
            "extra",
            struct_of(vec![
                (
                    "s",
                    kind_of(
                        "struct_value",
                        struct_of(vec![
                            ("b", kind_of("number_value", Value::F64(1.5))),
                            ("a", null())
                        ]),
                    ),
                ),
                (
                    "l",
                    kind_of(
                        "list_value",
                        held(
                            "google.protobuf.ListValue",
                            vec![(
                                "values",
                                Value::List(vec![
                                    kind_of("string_value", text("x")),
                                    kind_of("bool_value", Value::Bool(true)),
                                    kind_of("bool_value", Value::Bool(false)),
                                ]),
                            )],
                        ),
                    ),
                ),
            ]),
        )])),
        "{\"extra\":{\"l\":[\"x\",true,false],\"s\":{\"a\":null,\"b\":1.5}}}"
    );
    assert_eq!(
        written(&edges(vec![(
            "value",
            kind_of(
                "struct_value",
                struct_of(vec![(
                    "a",
                    kind_of(
                        "list_value",
                        held(
                            "google.protobuf.ListValue",
                            vec![(
                                "values",
                                Value::List(vec![
                                    null(),
                                    kind_of("string_value", text("b")),
                                    kind_of("bool_value", Value::Bool(true)),
                                ]),
                            )],
                        ),
                    ),
                )]),
            ),
        )])),
        "{\"value\":{\"a\":[null,\"b\",true]}}"
    );
    assert_eq!(
        written(&edges(vec![(
            "value",
            kind_of(
                "struct_value",
                struct_of(vec![("b", kind_of("string_value", text("x")))])
            ),
        )])),
        "{\"value\":{\"b\":\"x\"}}"
    );
    assert_eq!(
        written(&edges(vec![(
            "extra",
            struct_of(vec![(
                "a",
                kind_of(
                    "struct_value",
                    struct_of(vec![
                        ("b", kind_of("number_value", Value::F64(1.0))),
                        (
                            "c",
                            kind_of("list_value", held("google.protobuf.ListValue", vec![]))
                        ),
                    ]),
                ),
            )]),
        )])),
        "{\"extra\":{\"a\":{\"b\":1,\"c\":[]}}}"
    );
    // a Value of no kind, which its form holds none of
    assert_eq!(
        write_refusal(&edges(vec![(
            "value",
            held("google.protobuf.Value", vec![])
        )])),
        "a Value that holds no kind"
    );
}

#[test]
fn writes_a_message_nested_100_deep_and_refuses_one_nested_past_100() {
    // * 100 below the result written; 101 refused, a Struct's members counted as a message's
    assert!(
        written(&nested_edges(100)).starts_with("{\"child\":{\"child\":"),
        "100 deep written"
    );
    // ! a result comes as a payload, whose reader refuses it nested past 100 before the mapping
    // writes anything: the mapping's own bound is reached by a message handed to it whole
    assert!(
        matches!(
            write(&nested_edges(101)),
            Err(MessageFormError::Undecodable(_))
        ),
        "a payload nested past 100 refused by its stock library"
    );

    let schema = schema_of(EDGES);
    let refusal = |message: &DynamicMessage| {
        write_message(message, &schema)
            .err()
            .map(|refused| refused.reason().to_owned())
    };
    let mut structured = edges(vec![(
        "extra",
        struct_of(vec![("a", kind_of("number_value", Value::F64(1.0)))]),
    )]);

    for _ in 0..99 {
        structured = edges(vec![("child", Value::Message(structured))]);
    }

    assert_eq!(
        refusal(&nested_edges(101)).as_deref(),
        Some("a message nested past 100"),
        "101 deep"
    );
    assert_eq!(
        refusal(&structured).as_deref(),
        Some("a message nested past 100"),
        "a Struct's member 101 deep"
    );
}

// a response body's field `name` of `message`, its default where it holds none (5.8)
fn field_json(message: &DynamicMessage, name: &str) -> Result<String, MessageFormError> {
    let full_name = message.message_descriptor().full_name().to_owned();
    let payload = message.try_encode_to_vec().expect("a message encodes");

    form_of(&full_name).write(&payload, Some(name))
}

fn field_written(message: &DynamicMessage, name: &str) -> String {
    field_json(message, name).unwrap_or_else(|error| panic!("{name} writes: {error}"))
}

#[test]
fn writes_an_unset_64_bit_oneof_field_as_zero_in_a_response_body() {
    let profile = "bead.transcoding.tests.PatchProfile";

    for built in [
        message(profile, vec![]),
        message(profile, vec![("label", text("Ada"))]),
    ] {
        for name in ["count", "string_count"] {
            assert_eq!(field_written(&built, name), "\"0\"", "{name}");
        }
    }
}

#[test]
fn writes_a_response_body_s_field_at_its_default_where_its_oneof_holds_another_member_or_none() {
    let empty_edges = edges(vec![]);
    let everything = message(EVERYTHING, vec![]);

    // * a message field unset is its empty message, a wrapper's its value's zero, a scalar its zero
    for (built, name, expected) in [
        (&empty_edges, "child", "{}"),
        (&empty_edges, "wrapped_float", "0"),
        (&empty_edges, "wrapped_int64", "\"0\""),
        (&everything, "wrapped_bool", "false"),
        (&everything, "wrapped_string", "\"\""),
        (&empty_edges, "ints", "[]"),
        (&empty_edges, "labels", "{}"),
        (&empty_edges, "an_int32", "0"),
        (&everything, "choice_text", "\"\""),
        (&everything, "inner", "{}"),
        (&empty_edges, "null_member", "null"),
    ] {
        assert_eq!(field_written(built, name), expected, "{name}");
    }

    assert_eq!(
        field_written(
            &message(
                EVERYTHING,
                vec![(
                    "inner",
                    held("bead.transcoding.v1.Inner", vec![("name", text("a"))])
                )]
            ),
            "inner"
        ),
        "{\"name\":\"a\"}"
    );
    assert_eq!(
        field_written(
            &message("bead.transcoding.v1.ListBooksResponse", vec![]),
            "books"
        ),
        "[]"
    );

    // a oneof's member set, another of it at its default, and each of none at its default
    let chosen = message(EVERYTHING, vec![("choice_text", text("x"))]);

    assert_eq!(field_written(&chosen, "choice_text"), "\"x\"");
    assert_eq!(field_written(&chosen, "choice_inner"), "{}");
    assert_eq!(
        field_written(&message("google.protobuf.Value", vec![]), "number_value"),
        "0"
    );
    assert_eq!(
        field_written(&message("google.protobuf.Value", vec![]), "bool_value"),
        "false"
    );

    // * a response_body names its field by its proto name, as http.proto does: a JSON name, or
    // none, is its caller's bug, which a route's builder refuses
    for name in ["choiceText", "nope"] {
        assert!(
            matches!(
                field_json(&everything, name),
                Err(MessageFormError::Programmer(_))
            ),
            "{name}"
        );
    }

    // * a field of another message cannot be named: a response_body names a field of its message
    // by its proto name, so the same caller's bug is a name of no field, in its words
    let Err(MessageFormError::Programmer(error)) = field_json(&everything, "nope") else {
        panic!("a name of no field");
    };

    assert_eq!(
        error.message(),
        "bead.transcoding.v1.Everything has no field nope",
        "its words"
    );
}

#[test]
fn writes_a_field_of_its_own_presence_where_it_is_set_at_its_default_too_and_leaves_it_out_unset() {
    assert_eq!(written(&message(EVERYTHING, vec![])), "{}");
    assert_eq!(
        written(&message(
            EVERYTHING,
            vec![("a_string", text("")), ("maybe", Value::I32(0))]
        )),
        "{\"maybe\":0}"
    );
    // edition 2023's explicit presence, `explicit` and `needed`, and `implicit` of its own, on a
    // message of the validations' definitions
    let presence = "bead.validations.v1.Presence";

    assert_eq!(written(&message(presence, vec![])), "{}");
    assert_eq!(
        written(&message(
            presence,
            vec![("explicit", text("")), ("implicit", text(""))]
        )),
        "{\"explicit\":\"\"}"
    );
}

#[test]
fn writes_each_payload_s_data_as_its_encoding_reads_it() {
    // * a proto one in Bead's proto JSON form, a json one as it is, a text one a JSON string, a raw
    // one its base64
    assert_eq!(
        form_of("bead.transcoding.v1.Tick")
            .write(&[0x08, 0x01], None)
            .ok()
            .as_deref(),
        Some("{\"remaining\":1}"),
        "a proto payload"
    );
    assert_eq!(
        bead::internal::text_data_of("h\"é".as_bytes()).as_deref(),
        Some("\"h\\\"é\""),
        "a text payload"
    );
    assert_eq!(
        bead::internal::text_data_of(b"h\n\r").as_deref(),
        Some("\"h\\n\\r\""),
        "a text payload of control characters"
    );
    assert_eq!(
        bead::internal::raw_data_of(&[0x01, 0x02, 0xFF]),
        "\"AQL/\"",
        "a raw payload"
    );
    assert_eq!(
        bead::internal::raw_data_of(&[0, 0xFF, 0xFE]),
        "\"AP/+\"",
        "a raw payload"
    );
    assert_eq!(
        base64_of(&[0x01, 0x02, 0xFF]),
        "AQL/",
        "the form's own base64"
    );
    // a draft is read by steps 2 and 3 alone: no required field judged
    assert!(
        read_draft(
            &schema_of("bead.transcoding.v1.Needs"),
            &read_text(b"{}").expect("a text")
        )
        .is_ok(),
        "a draft of a message whose required fields are unset"
    );
}
