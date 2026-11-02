//! An ELSEWHERE verifier's invalid session fails before its end is compared to the clock.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::credentials::{CredentialRequest, Credentials, ElsewhereSession};
use crate::envelope::Credential;
use crate::router::core::{Resolved, Unresolved};
use crate::testing::surface::Consumer;

#[tokio::test]
async fn fails_a_session_whose_end_is_not_a_number_within_2_53_and_one_whose_id_is_no_string() {
    for end in [
        9_007_199_254_740_992_i64,
        -9_007_199_254_740_992,
        i64::MAX,
        i64::MIN,
        9_007_199_254_740_991,
        -9_007_199_254_740_991,
    ] {
        let (_clock, resolver) = super::resolver_of(&Credentials {
            verify: Some(Arc::new(move |_, _| {
                Box::pin(async move {
                    Ok(Some(ElsewhereSession {
                        id: "ada".to_owned(),
                        data: None,
                        end: Some(end),
                    }))
                })
            })),
            ..Credentials::default()
        });
        let outcome = resolver
            .resolve((
                CredentialRequest {
                    audiences: None,
                    credential: Credential::Elsewhere,
                    transport_credential: Some("Interop sub=ada".to_owned()),
                },
                CancellationToken::new(),
            ))
            .await;
        if end == 9_007_199_254_740_991 {
            assert!(matches!(outcome, Ok(Resolved::Session(session)) if session.end == Some(end)));
        } else if end == -9_007_199_254_740_991 {
            assert!(matches!(outcome, Ok(Resolved::Refused(reason)) if reason == "end"));
        } else {
            let Err(Unresolved::Other(error)) = outcome else {
                panic!("a verifier's out-of-range end fails: {outcome:?}");
            };
            assert!(
                error
                    .downcast_ref::<crate::errors::ProgrammerError>()
                    .is_some()
            );
            assert_eq!(
                error.to_string(),
                "an ELSEWHERE's verifier settles with a session whose end is a number of milliseconds within ±9007199254740991"
            );
        }
    }
    let consumer = Consumer::new();
    consumer.accepts("pub fn check() { let _ = bead::ElsewhereSession { id: String::from(\"ada\"), data: None, end: Some(1) }; }");
    consumer.refuses(
        "pub fn check(mut session: bead::ElsewhereSession) { session.id = 7; }",
        ("E0308", "mismatched types"),
    );
    consumer.refuses(
        "pub fn check() { let _: bead::ElsewhereSession = \"ada\"; }",
        ("E0308", "mismatched types"),
    );
    for invalid in ["f64::NAN", "f64::INFINITY", "f64::NEG_INFINITY", "\"1\""] {
        consumer.refuses(&format!("pub fn check(mut session: bead::ElsewhereSession) {{ session.end = Some({invalid}); }}"), ("E0308", "mismatched types"));
    }
}
