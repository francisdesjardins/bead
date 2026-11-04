//! A resolver judges a decoded payload before its callback and traces the refusal.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::resolver::resolving;
use super::{Fixture, Recording, locked, props};
use crate::constants::{ProtocolCode, RouterSide};
use crate::debug::DebugDirection;
use crate::envelope::FailureRecord;
use crate::failure::Failure;
use crate::managers::service::{Validate, ValidateOptions};
use crate::router::types::RouterAnswer;
use crate::violations::{Judged, Violation};

const DETAIL: &str = "{\"bounds\":{\"min_len\":\"1\"},\"fieldPath\":\"text\",\"message\":\"must be at least 1 characters\",\"ruleId\":\"string.min_len\"}\n{\"more\":0}";

fn rules(given: &Arc<Mutex<Vec<ValidateOptions>>>) -> Validate<String> {
    let given = Arc::clone(given);
    Arc::new(move |value, options| {
        locked(&given).push(options.clone());
        if !value.is_empty() {
            return Ok(Judged::default());
        }
        Ok(Judged {
            violations: vec![Violation {
                bounds: Some(
                    serde_json::json!({ "min_len": "1" })
                        .as_object()
                        .expect("bounds")
                        .clone(),
                ),
                field_path: Some("text".to_owned()),
                message: Some("must be at least 1 characters".to_owned()),
                rule_id: "string.min_len".to_owned(),
                value: Some(serde_json::Value::String(value.clone())),
                ..Violation::default()
            }],
            stopped: options.fail_fast.unwrap_or(false),
            ..Judged::default()
        })
    })
}

#[tokio::test]
async fn answers_payload_invalid_to_a_request_its_rules_refuse_before_its_callback() {
    let fixture = Fixture::with(&crate::router::server::RouterServerOptions {
        limits: Some(crate::router::types::RouterLimitsOptions {
            maximum_detail_bytes: Some(512),
            ..crate::router::types::RouterLimitsOptions::default()
        }),
        ..crate::router::server::RouterServerOptions::default()
    });
    let recording = Arc::new(Recording::default());
    let given = Arc::new(Mutex::new(Vec::new()));
    let mut resolver = resolving(
        &fixture,
        Arc::new(|request, response| {
            assert_eq!(request.payload, "hi");
            response.result(request.payload)
        }),
    );
    resolver.validate = Some(rules(&given));
    resolver.fail_fast = true;
    resolver
        .resolve(props(&recording, b""))
        .await
        .expect("refused");
    resolver
        .resolve(props(&recording, b"hi"))
        .await
        .expect("answered");
    assert_eq!(
        recording.answers(),
        [
            RouterAnswer::Failure(
                Failure::protocol(ProtocolCode::PAYLOAD_INVALID, RouterSide::Server)
                    .saying(DETAIL.replace("{\"more\":0}", "{\"stopped\":true}"))
                    .record()
            ),
            RouterAnswer::Result(Bytes::from_static(b"hi")),
        ]
    );
    assert_eq!(
        *locked(&given),
        [
            ValidateOptions {
                fail_fast: Some(true),
                maximum_bytes: Some(512)
            },
            ValidateOptions {
                fail_fast: Some(true),
                maximum_bytes: Some(512)
            }
        ]
    );
}

#[tokio::test]
async fn traces_a_request_its_rules_refuse_its_rx_then_its_failure() {
    let fixture = Fixture::new();
    let heard = fixture.heard();
    let recording = Arc::new(Recording::default());
    let mut resolver = resolving(
        &fixture,
        Arc::new(|_, _| panic!("refused before the callback")),
    );
    resolver.validate = Some(rules(&Arc::new(Mutex::new(Vec::new()))));
    resolver
        .resolve(props(&recording, b""))
        .await
        .expect("refused");
    let heard = locked(&heard).clone();
    assert_eq!(
        heard
            .iter()
            .map(|(error, event)| (
                error.is_none(),
                event.direction,
                event.duration,
                event.call_id,
                event.started_at
            ))
            .collect::<Vec<_>>(),
        [
            (true, DebugDirection::Rx, None, Some(7), 1_767_225_600_000),
            (
                true,
                DebugDirection::Tx,
                Some(0),
                Some(7),
                1_767_225_600_000
            ),
        ]
    );
    for (_, event) in &heard {
        assert_eq!(
            event
                .rx
                .as_ref()
                .expect("the request")
                .as_ref()
                .as_any()
                .downcast_ref::<String>(),
            Some(&String::new())
        );
    }
    let failure = heard[1]
        .1
        .tx
        .as_ref()
        .expect("the refusal")
        .as_ref()
        .as_any()
        .downcast_ref::<FailureRecord>()
        .expect("a failure");
    assert_eq!(
        *failure,
        Failure::protocol(ProtocolCode::PAYLOAD_INVALID, RouterSide::Server)
            .saying(DETAIL)
            .record()
    );
}

#[tokio::test]
async fn answers_procedure_failed_to_rules_that_throw_and_hands_why_on_for_its_router_to_report() {
    let fixture = Fixture::new();
    let heard = fixture.heard();
    let recording = Arc::new(Recording::default());
    let mut resolver = resolving(
        &fixture,
        Arc::new(|_, _| panic!("the broken rule never reaches the callback")),
    );
    resolver.validate = Some(Arc::new(|_, _| Err("a rule that fails to judge".into())));
    let error = resolver
        .resolve(props(&recording, b"hi"))
        .await
        .expect_err("the router hears why");
    assert_eq!(error.to_string(), "a rule that fails to judge");
    assert_eq!(
        recording.answers(),
        [RouterAnswer::Failure(
            Failure::protocol(ProtocolCode::PROCEDURE_FAILED, RouterSide::Server).record()
        )]
    );
    assert_eq!(
        locked(&heard)
            .iter()
            .map(|(error, event)| (event.direction, error.is_some()))
            .collect::<Vec<_>>(),
        [(DebugDirection::Rx, false), (DebugDirection::Tx, true)]
    );
    assert_eq!(
        locked(&heard)[1].0.as_deref(),
        Some("a rule that fails to judge"),
        "why beside the answer, in the rule's own words"
    );
}

// the parity gap the other sides close by an initializer and a literal: built outside its crate by
// assignment over its default, as an options struct with no required member is; one with a required
// member has no default to start from
#[test]
fn builds_validate_options_from_another_crate() {
    let consumer = crate::testing::surface::Consumer::new();

    consumer.accepts(
        "pub fn check() -> bead::ValidateOptions { let mut o = bead::ValidateOptions::default(); o.fail_fast = Some(true); o.maximum_bytes = Some(512); o }",
    );
    consumer.refuses(
        "pub fn check() { let _ = bead::BrokerTransportClientConnectOptions::default(); }",
        ("E0599", "default"),
    );
}
