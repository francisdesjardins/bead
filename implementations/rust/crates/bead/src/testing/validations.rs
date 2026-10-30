//! `spec/validations.json`, each group read through a typed structure of its own, never by index.

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::testing::files;

/// The entries of the group `group` of `spec/validations.json`, each read as `T`.
///
/// # Errors
///
/// What reading the file, or the group as `T`, refuses.
pub fn of<T: DeserializeOwned>(group: &str) -> Result<Vec<T>, String> {
    let mut validations: serde_json::Map<String, Value> = files::read("validations.json")?;
    let entries = validations
        .remove(group)
        .ok_or_else(|| format!("validations.json holds no group {group}"))?;

    serde_json::from_value(entries).map_err(|error| format!("validations.json, {group}: {error}"))
}
