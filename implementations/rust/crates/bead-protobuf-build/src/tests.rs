//! The generator's setting, read from the set of `bead-protobuf`'s tests, which protoc wrote.

use std::fs;
use std::path::Path;

use buffa_descriptor::DescriptorPool;

use super::opened_of;

// the set protoc wrote of the tests' files: spec/codecs.proto, spec/transcoding-required.proto,
// and bead-protobuf's codec.proto and requiring.proto
fn tests_set() -> DescriptorPool {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../bead-protobuf/proto/tests.binpb");
    let bytes = fs::read(&path).expect("the tests' set");

    DescriptorPool::decode(&bytes).expect("a set whose references resolve")
}

#[test]
fn opens_each_repeated_and_map_field_of_a_closed_enum_of_the_files_generated_and_no_other() {
    let pool = tests_set();

    // * Leveled's three, a singular field and an open enum's left as they are; Probe's shade is
    // singular, and every enum of requiring.proto's imports is open
    assert_eq!(
        opened_of(
            &pool,
            &[
                "codecs.proto",
                "transcoding-required.proto",
                "codec.proto",
                "requiring.proto"
            ]
        ),
        [
            ".bead.test.Leveled.tones",
            ".bead.test.Leveled.packed",
            ".bead.test.Leveled.by_name"
        ],
        "Leveled's repeated and map fields of Tone, a closed enum"
    );
    assert!(
        opened_of(&pool, &["codecs.proto", "requiring.proto"]).is_empty(),
        "no field of a file not generated"
    );
}
