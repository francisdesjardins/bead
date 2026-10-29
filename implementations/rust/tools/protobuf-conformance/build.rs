//! The suite's test messages, its exchange and `spec/codecs.proto`, generated from
//! `generated/conformance.binpb`, the set protoc writes of them, which
//! `tools/protobuf-conformance.mjs` puts there, as `bead_protobuf_build` sets Buffa's generator.

use std::error::Error;
use std::path::Path;

fn main() -> Result<(), Box<dyn Error>> {
    bead_protobuf_build::config_of(
        Path::new("generated/conformance.binpb"),
        &[
            "protobuf_test_messages/test_messages_edition2023.proto",
            "protobuf_test_messages/test_messages_proto2.proto",
            "protobuf_test_messages/test_messages_proto2_editions.proto",
            "protobuf_test_messages/test_messages_proto3.proto",
            "protobuf_test_messages/test_messages_proto3_editions.proto",
            "conformance/conformance.proto",
            "codecs.proto",
        ],
    )?
    .include_file("_include.rs")
    .compile()
}
