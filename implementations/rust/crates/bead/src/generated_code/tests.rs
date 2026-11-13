//! The contract with generated code: the TypeScript side's `generated-code.test.ts` and the C#
//! side's `GeneratedCodeTests`, their numbers the Rust runtime's.

use super::{GENERATED_CODE_SUPPORTS_VERSION_7, GENERATED_CODE_SUPPORTS_VERSION_8};

// the module's own text, whose constants are the contracts it declares
const SOURCE: &str = include_str!("../generated_code.rs");

const PREFIX: &str = "pub const GENERATED_CODE_SUPPORTS_VERSION_";

#[test]
fn holds_the_constants_of_the_contracts_this_runtime_supports_7_and_8_and_no_other() {
    assert_eq!(
        [
            GENERATED_CODE_SUPPORTS_VERSION_7,
            GENERATED_CODE_SUPPORTS_VERSION_8
        ],
        [true, true],
        "7 and 8 held"
    );

    // * no other: the module declares those two, and the crate's root offers what it declares
    let declared: Vec<&str> = SOURCE
        .lines()
        .filter_map(|line| line.strip_prefix(PREFIX))
        .filter_map(|rest| rest.split(':').next())
        .collect();

    assert_eq!(declared, ["7", "8"], "the contracts declared");
}
