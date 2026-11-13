//! The messages of each golden output whose messages its application's build writes (`messages:
//! external`): Buffa's generator, set by `bead_protobuf_build::config_of`, over the set beadc's
//! golden writer keeps beside the output, `messages.binpb`, its include file in `OUT_DIR`, where
//! the output's `mod.rs` includes it from.

use std::error::Error;
use std::fs;
use std::path::Path;

use buffa_descriptor::DescriptorPool;

// the goldens, beside the side's folder
const GOLDENS: &str = "../../../../builder/test/golden/rust";

// the outputs of `messages: external`
const EXTERNAL: [&str; 1] = ["validations"];

// a file of the set beadc generates: neither Google's nor protovalidate's, nor beadc's options
fn is_generated(name: &str) -> bool {
    !name.starts_with("google/") && !name.starts_with("buf/") && name != "bead/options.proto"
}

fn main() -> Result<(), Box<dyn Error>> {
    for output in EXTERNAL {
        let set = Path::new(GOLDENS).join(output).join("messages.binpb");
        let pool = DescriptorPool::decode(&fs::read(&set)?)?;
        let files: Vec<&str> = pool
            .files()
            .iter()
            .filter_map(|file| file.name.as_deref())
            .filter(|name| is_generated(name))
            .collect();

        println!("cargo::rerun-if-changed={}", set.display());
        bead_protobuf_build::config_of(&set, &files)?
            .include_file("_include.rs")
            .compile()?;
    }

    Ok(())
}
