//! The test kit's messages (decision 0044): under the feature `testing` alone, the tests' files
//! generated from `proto/tests.binpb`, the set protoc wrote of them and of the transcoding's, which
//! its unit tests read by their descriptors alone, as `bead_protobuf_build` sets Buffa's generator; `node tools/check-protobuf.mjs --write`, from the Rust side's folder, writes
//! the set again. The library itself holds no generated code. `proto/codec.proto` is generated a
//! second time by Buffa's generator as it is by default, its closed enums left closed, for the
//! codec's refusal of such a message.

use std::error::Error;

#[cfg_attr(
    not(feature = "testing"),
    expect(
        clippy::unnecessary_wraps,
        reason = "the feature testing alone generates, and fails as it does"
    )
)]
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

    #[cfg(feature = "testing")]
    {
        let closed = std::path::PathBuf::from(std::env::var("OUT_DIR")?).join("closed");

        std::fs::create_dir_all(&closed)?;
        bead_protobuf_build::Config::new()
            .descriptor_set(std::path::Path::new("proto/tests.binpb"))
            .files(&["codec.proto"])
            .generate_views(true)
            .generate_reflection(true)
            .out_dir(closed)
            .include_file("_include.rs")
            .compile()?;
    }

    Ok(())
}
