//! The issuer reader takes every held request and refuses every other shape in the shared file.

use serde_json::Value;

#[test]
fn the_interop_services_end_sessions_of_takes_an_issuer_alone_a_string_and_throws_for_anything_else()
 {
    let service: Value =
        serde_json::from_str(crate::INTEROP_SERVICE).expect("the interop service reads");
    let cases = &service["verifiers"]["endSessionsOf"];
    let takes = cases["takes"].as_array().expect("taken requests");
    let refuses = cases["refuses"].as_array().expect("refused requests");
    assert_ne!(takes, &Vec::<Value>::new());
    assert_ne!(refuses, &Vec::<Value>::new());
    for taken in takes {
        assert_eq!(
            super::issuer_of(&taken["request"]).expect("an issuer alone"),
            taken["issuer"].as_str().expect("an issuer")
        );
    }
    for request in refuses {
        assert_eq!(
            super::issuer_of(request)
                .expect_err("no issuer alone")
                .to_string(),
            cases["refusal"].as_str().expect("the refusal")
        );
    }
    // JavaScript's undefined has no serde_json::Value; null is the file's explicit absent value.
}
