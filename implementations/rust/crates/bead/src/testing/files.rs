//! The conformance files of `spec/`, each read whole as its own typed structure.

use std::path::PathBuf;

use serde::de::DeserializeOwned;

/// Where `spec/`'s file `name` is, from this crate.
#[must_use]
pub fn path_of(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../spec")
        .join(name)
}

/// The file `name` of `spec/`, read as `T`.
///
/// # Errors
///
/// What reading it or its form refuses, saying which file.
pub fn read<T: DeserializeOwned>(name: &str) -> Result<T, String> {
    let path = path_of(name);
    let text =
        std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;

    serde_json::from_str(&text).map_err(|error| format!("{name}: {error}"))
}

/// The file `name` of `spec/`, read by Bead's own reader, then as `T`: its numbers keep the form
/// the file writes them in.
///
/// # Errors
///
/// What reading it, Bead's reader, or its form refuses, saying which file.
pub fn read_by_bead<T: DeserializeOwned>(name: &str) -> Result<T, String> {
    let text = text_of(name)?;
    let value =
        crate::json::read(text.as_bytes()).map_err(|refusal| format!("{name}: {refusal}"))?;

    serde_json::from_value(value).map_err(|error| format!("{name}: {error}"))
}

/// The file `name` of `spec/`, its text whole.
///
/// # Errors
///
/// What reading it refuses, saying which file.
pub fn text_of(name: &str) -> Result<String, String> {
    let path = path_of(name);

    std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))
}
