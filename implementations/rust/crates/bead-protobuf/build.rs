//! The test kit's messages (decision 0044): under the feature `testing` alone, the tests' files
//! generated from `proto/tests.binpb`, the set protoc wrote of them, as `bead_protobuf_build` sets
//! Buffa's generator; `node tools/check-protobuf.mjs --write`, from the Rust side's folder, writes
//! the set again. The library itself holds no generated code.

use std::error::Error;

fn main() -> Result<(), Box<dyn Error>> {
    #[cfg(feature = "testing")]
    bead_protobuf_build::config_of(
        std::path::Path::new("proto/tests.binpb"),
        &[
            "codecs.proto",
            "transcoding-required.proto",
            "codec.proto",
            "requiring.proto",
        ],
    )?
    .include_file("_include.rs")
    .compile()?;

    Ok(())
}
