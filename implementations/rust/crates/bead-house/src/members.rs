//! Every member under the workspace's lints: each crate's manifest holds `[lints]` and, in it,
//! `workspace = true`, so no crate leaves the policy.

use crate::Finding;

const UNDER_NO_LINTS: &str =
    "a member holds `[lints]` with `workspace = true`, and this one does not";

/// What the rule refuses in a member's manifest: none when its `[lints]` table takes the
/// workspace's.
#[must_use]
pub fn members_of(manifest: &str) -> Vec<Finding> {
    let mut table = "";

    for line in manifest.lines() {
        let line = line.trim();

        if line.starts_with('[') {
            table = line;
        } else if table == "[lints]" && line.replace(' ', "") == "workspace=true" {
            return Vec::new();
        }
    }

    vec![Finding {
        line: 1,
        reason: UNDER_NO_LINTS,
    }]
}
