//! `proto-codecs`: the `proto` codecs over `spec/codecs.proto`'s `Probe` (spec 17.9). The input's
//! first byte draws a path, a child, a map's entry or a group; its second a count, 0 to 127; its
//! third a number of unknown groups, 0 to 127. The rest, wrapped in that many groups of field 4,
//! which `Probe` does not declare, is read by the typed and the dynamic codec, which both read it
//! or both refuse it. A message that reads is wrapped `count` times on its path, then written: its
//! writer refuses it, `nested past 100`, or its reader takes what it wrote (17.2), which equals the
//! message and writes again as it did. The TypeScript side's `tools/fuzz/proto-codecs.ts` and the
//! C# side's `ProtoCodecsTarget` are its twins.

#![no_main]

use std::sync::{Arc, LazyLock};

use bead::{CodecRefusal, PayloadCodec};
use bead_protobuf::testing::codecs::Probe;
use bead_protobuf::{DynamicCodec, ProtoCodec};
use buffa::MessageField;
use buffa_descriptor::reflect::{DynamicMessage, MapKey, ReflectMessageMut, Value};
use bytes::Bytes;
use libfuzzer_sys::fuzz_target;

// a group of field 4, opened and closed (Encoding, "Groups")
const START: u8 = 0x23;
const END: u8 = 0x24;

static TYPED: LazyLock<ProtoCodec<Probe>> = LazyLock::new(|| ProtoCodec::new().expect("Probe opens its closed enums"));

static DYNAMIC: LazyLock<DynamicCodec> = LazyLock::new(|| {
    let schema = TYPED.schema();

    DynamicCodec::new(Arc::clone(schema.pool()), schema.message())
});

// how a message is wrapped: in a child, as an entry's value under the key "", or in a group
#[derive(Debug, Clone, Copy)]
enum Path {
    Child,
    Entry,
    Group,
}

impl Path {
    fn of(byte: u8) -> Self {
        match byte % 3 {
            0 => Self::Child,
            1 => Self::Entry,
            _ => Self::Group,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Child => "child",
            Self::Entry => "children",
            Self::Group => "delimited",
        }
    }

    fn typed(self, inner: Probe) -> Probe {
        let mut above = Probe::default();

        match self {
            Self::Child => above.child = MessageField::some(inner),
            Self::Entry => {
                above.children.insert(String::new(), inner);
            }
            Self::Group => above.delimited = MessageField::some(inner),
        }

        above
    }

    fn dynamic(self, inner: DynamicMessage) -> DynamicMessage {
        let pool = Arc::clone(DYNAMIC.schema().pool());
        let index = DYNAMIC.schema().message();
        let mut above = DynamicMessage::new(Arc::clone(&pool), index);
        let field = pool
            .message(index)
            .field_by_name(self.name())
            .expect("a field of Probe");
        let held = match self {
            Self::Entry => Value::Map(
                core::iter::once((MapKey::String(String::new()), Value::Message(inner))).collect(),
            ),
            Self::Child | Self::Group => Value::Message(inner),
        };

        above.set(field, held);

        above
    }
}

// the writer's refusal, or its reader's taking of what it wrote: anything else is a finding
fn judged(written: &Result<Bytes, CodecRefusal>, codec: &str) {
    if let Err(refusal) = written {
        assert_eq!(
            refusal.reason(),
            "nested past 100",
            "the {codec} writer refuses for its depth alone"
        );
    }
}

fuzz_target!(|data: &[u8]| {
    let (Some(&path), Some(&count), Some(&groups)) = (data.first(), data.get(1), data.get(2)) else {
        return;
    };
    let (path, count, groups) = (Path::of(path), usize::from(count % 128), usize::from(groups % 128));
    let mut bytes = vec![START; groups];

    bytes.extend_from_slice(data.get(3..).unwrap_or_default());
    bytes.extend(std::iter::repeat_n(END, groups));

    let bytes = Bytes::from(bytes);
    let (typed, dynamic) = match (TYPED.decode(&bytes), DYNAMIC.decode(&bytes)) {
        (Ok(typed), Ok(dynamic)) => (typed, dynamic),
        (Err(_), Err(_)) => return,
        (typed, dynamic) => {
            panic!("the typed codec read {typed:?}, the dynamic {dynamic:?}")
        }
    };
    let typed = (0..count).fold(typed, |inner, _| path.typed(inner));
    let dynamic = (0..count).fold(dynamic, |inner, _| path.dynamic(inner));
    let written = (TYPED.encode(&typed), DYNAMIC.encode(&dynamic));

    judged(&written.0, "typed");
    judged(&written.1, "dynamic");

    match written {
        (Ok(by_type), Ok(by_descriptor)) => {
            // * what reads back equals the message, as Buffa compares messages
            let read = TYPED.decode(&by_type).expect("the typed reader takes what it wrote");

            assert!(read == typed, "read back as written: {typed:?}");

            // ! a dynamic message tells a field of implicit presence set at its default from one left
            // out, which no writing does: what it reads back is held to its bytes. A typed map is a
            // hash map, whose entries a writing orders as it holds them; the dynamic message's map
            // is ordered, so it writes again to the same bytes
            let held = DYNAMIC
                .decode(&by_descriptor)
                .expect("the dynamic reader takes what it wrote");

            assert!(
                matches!(DYNAMIC.encode(&held), Ok(again) if again == by_descriptor),
                "written again as it was"
            );
            assert!(
                matches!(TYPED.encode(&read).map(|again| TYPED.decode(&again)), Ok(Ok(again)) if again == typed),
                "written again as the same message"
            );
        }
        (Err(_), Err(_)) => {}
        (by_type, by_descriptor) => {
            panic!("the typed codec wrote {by_type:?}, the dynamic {by_descriptor:?}")
        }
    }
});
