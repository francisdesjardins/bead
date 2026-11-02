//! The test kit's tests: the excusal every player of a conformance file reads an entry's `differs`
//! by.

use super::{Difference, is_excused};

// an entry's differs, as a conformance file writes it
fn differs_of(json: &str) -> Vec<Difference> {
    serde_json::from_str(json).expect("a differs of the files' form")
}

#[test]
fn excuses_an_entry_whose_differs_names_rust_and_no_other() {
    for (json, expected) in [
        (
            r#"[{ "row": "A row", "language": "C#" }, { "row": "A row", "language": "Rust" }]"#,
            true,
        ),
        (r#"[{ "row": "A row", "language": "C#" }]"#, false),
        (r#"[{ "row": "A row", "language": "TypeScript" }]"#, false),
        ("[]", false),
    ] {
        assert_eq!(is_excused(&differs_of(json)), expected, "{json}");
    }

    assert!(
        serde_json::from_str::<Vec<Difference>>(
            r#"[{ "row": "A row", "language": "Rust", "why": "a key no row holds" }]"#
        )
        .is_err(),
        "a row of a key it does not hold is refused"
    );
}
