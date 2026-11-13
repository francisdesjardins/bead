//! The goldens' messages, which beadc has the pinned `protoc-gen-buffa` write under `messages/`,
//! against Buffa's generator in an application's build, set by `bead_protobuf_build::config_of`
//! over the same set, `messages.binpb`, which beadc's golden writer keeps beside each output: the two
//! modes of a Rust output, `generate` and `external`, give one code (decision 0051).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use buffa_descriptor::DescriptorPool;

// the goldens, beside the side's folder
const GOLDENS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../builder/test/golden/rust"
);

// a file of the set beadc generates: neither Google's nor protovalidate's, nor beadc's options
fn is_generated(name: &str) -> bool {
    !name.starts_with("google/") && !name.starts_with("buf/") && name != "bead/options.proto"
}

// a path's last part
fn name_of(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or_else(|| format!("{} has no name", path.display()))
}

// each file under `folder`, by its path from it, its line endings as git may have checked them out
fn files_under(folder: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut files = BTreeMap::new();

    for entry in fs::read_dir(folder).map_err(|error| format!("{}: {error}", folder.display()))? {
        let path = entry.map_err(|error| error.to_string())?.path();
        let text =
            fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;

        files.insert(name_of(&path)?, text.replace("\r\n", "\n"));
    }

    Ok(files)
}

// the outputs whose messages beadc writes, each with its folder
fn generated_outputs() -> Result<Vec<(String, PathBuf)>, String> {
    let mut outputs = Vec::new();

    for entry in fs::read_dir(GOLDENS).map_err(|error| format!("{GOLDENS}: {error}"))? {
        let path = entry.map_err(|error| error.to_string())?.path();

        if path.join("messages").is_dir() {
            outputs.push((name_of(&path)?, path));
        }
    }

    outputs.sort();

    Ok(outputs)
}

#[test]
fn writes_the_messages_buffa_writes_checked_in_as_config_of_sets_its_generator() {
    let outputs = generated_outputs().expect("the goldens read");

    assert!(!outputs.is_empty(), "an output of messages: generate");

    for (output, folder) in outputs {
        let set = folder.join("messages.binpb");
        let pool = DescriptorPool::decode(&fs::read(&set).expect("its set read")).expect("a set");
        let files: Vec<&str> = pool
            .files()
            .iter()
            .filter_map(|file| file.name.as_deref())
            .filter(|name| is_generated(name))
            .collect();
        let written = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("parity-{output}"));

        if written.exists() {
            fs::remove_dir_all(&written).expect("the last run's files removed");
        }

        fs::create_dir_all(&written).expect("a folder for Buffa's files");
        bead_protobuf_build::config_of(&set, &files)
            .expect("its generator set")
            .out_dir(&written)
            .include_file("mod.rs")
            .compile()
            .expect("its messages written");

        // * every file, mod.rs among them, byte for byte, and no other
        assert_eq!(
            files_under(&folder.join("messages")).expect("the golden's messages read"),
            files_under(&written).expect("Buffa's read"),
            "{output}'s messages"
        );
    }
}
