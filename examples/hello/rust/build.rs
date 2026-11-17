//! The messages of `hello-external`, with the feature `external`: buf builds the set of hello's
//! `.proto` from its workspace, `../buf.yaml`, Bead's options and protovalidate's among it from
//! beadc's copy in `../.beadc/include`, which `generate` writes; then Buffa's generator writes their
//! code into `OUT_DIR`, set by `bead_protobuf_build::config_of` as Bead's codec reads it, its
//! include file `_include.rs`, which the output's `messages` mounts. The set is never committed.
//! `BUF` names the buf to run, read from this folder, `buf` on the path when it is not set. Without
//! the feature, nothing.

use std::io::{self, Write};

#[cfg(feature = "external")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::env;
    use std::path::PathBuf;
    use std::process::Command;

    // the `.proto` whose messages are written, by its path in the set
    const FILES: [&str; 1] = ["hello/v1/hello.proto"];

    let mut said = io::stdout().lock();
    // hello's folder, the buf workspace's
    let hello = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?)
        .parent()
        .map(PathBuf::from)
        .ok_or("the Rust half has no parent folder")?;

    writeln!(said, "cargo::rerun-if-env-changed=BUF")?;

    for each in ["proto", "buf.yaml", ".beadc/include"] {
        writeln!(
            said,
            "cargo::rerun-if-changed={}",
            hello.join(each).display()
        )?;
    }

    let set = PathBuf::from(env::var("OUT_DIR")?).join("hello.binpb");
    // * run from this folder, the script's own, which a relative BUF is read from, as the
    // TypeScript half runs buf over `..`
    let buf = env::var_os("BUF").unwrap_or_else(|| "buf".into());
    let built = Command::new(&buf)
        .arg("build")
        .arg(&hello)
        .arg("--as-file-descriptor-set")
        .arg("-o")
        .arg(&set)
        .status()
        .map_err(|error| {
            format!("buf did not run: {error}; name it by BUF, or put it on the path")
        })?;

    if !built.success() {
        return Err(format!(
            "buf build failed, {built}: run generate once first, which writes .beadc/include"
        )
        .into());
    }

    bead_protobuf_build::config_of(&set, &FILES)?
        .include_file("_include.rs")
        .compile()?;

    Ok(())
}

#[cfg(not(feature = "external"))]
fn main() -> io::Result<()> {
    // nothing to write: run again only once this script changes
    writeln!(io::stdout().lock(), "cargo::rerun-if-changed=build.rs")
}
