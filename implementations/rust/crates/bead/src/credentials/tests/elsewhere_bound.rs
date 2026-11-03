//! An ELSEWHERE verifier's invalid session fails before its end is compared to the clock.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::credentials::{CredentialRequest, Credentials, ElsewhereSession};
use crate::envelope::Credential;
use crate::router::core::{Resolved, Unresolved};
use crate::testing::surface::Consumer;

#[tokio::test]
async fn rounds_an_end_up_to_a_millisecond_half_a_millisecond_past_the_wall_clock_holds_and_half_short_does_not()
 {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    let ends = Arc::new(Mutex::new(VecDeque::from([
        1_767_225_600_000.5,
        1_767_225_599_999.5,
        1_767_225_600_000.0,
        9_007_199_254_740_991.0,
    ])));
    let verifying = Arc::clone(&ends);
    let (clock, resolver) = super::resolver_of(&Credentials {
        verify: Some(Arc::new(move |_, _| {
            let end = verifying
                .lock()
                .expect("the verifier's ends")
                .pop_front()
                .expect("one end per resolution");
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
    assert_eq!(
        crate::clock::Clock::wall(&*clock),
        crate::testing::instants::new_year()
    );
    for expected in [
        Some(1_767_225_600_001),
        None,
        None,
        Some(9_007_199_254_740_991),
    ] {
        let outcome = resolver
            .resolve((
                super::elsewhere_of("Interop sub=ada"),
                CancellationToken::new(),
            ))
            .await
            .expect("the verifier settles");
        match (expected, outcome) {
            (Some(end), Resolved::Session(session)) => assert_eq!(session.end, Some(end)),
            (None, Resolved::Refused(reason)) => assert_eq!(reason, "end"),
            (expected, actual) => panic!("expected {expected:?}, got {actual:?}"),
        }
    }
    assert!(ends.lock().expect("the verifier's ends").is_empty());
}

#[tokio::test]
async fn fails_a_session_whose_end_is_not_a_number_within_2_53_and_one_whose_id_is_no_string() {
    for (end, whole) in [
        (9_007_199_254_740_992.0, None),
        (-9_007_199_254_740_992.0, None),
        (f64::MAX, None),
        (f64::MIN, None),
        (f64::NAN, None),
        (f64::INFINITY, None),
        (f64::NEG_INFINITY, None),
        (9_007_199_254_740_991.0, Some(9_007_199_254_740_991_i64)),
        (-9_007_199_254_740_991.0, Some(-9_007_199_254_740_991)),
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
        if whole == Some(9_007_199_254_740_991) {
            assert!(matches!(outcome, Ok(Resolved::Session(session)) if session.end == whole));
        } else if whole == Some(-9_007_199_254_740_991) {
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
    consumer.accepts("pub fn check() { let _ = bead::ElsewhereSession { id: String::from(\"ada\"), data: None, end: Some(1.0) }; }");
    consumer.refuses(
        "pub fn check(mut session: bead::ElsewhereSession) { session.id = 7; }",
        ("E0308", "mismatched types"),
    );
    consumer.refuses(
        "pub fn check() { let _: bead::ElsewhereSession = \"ada\"; }",
        ("E0308", "mismatched types"),
    );
    for invalid in ["true", "()", "\"1\""] {
        consumer.refuses(&format!("pub fn check(mut session: bead::ElsewhereSession) {{ session.end = Some({invalid}); }}"), ("E0308", "mismatched types"));
    }
}
