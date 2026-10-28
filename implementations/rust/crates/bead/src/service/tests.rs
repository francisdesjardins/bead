//! The service layer's tests: a catalogue of failures, a call its rules refuse before it goes,
//! and a failure its procedure does not list, answered.

use core::num::NonZeroU16;
use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};

use super::{
    AdmissionRule, DescriptorInit, ListedFailure, ServiceProcedure, ServiceServer,
    ServiceServerOptions, failures_of, request_of,
};
use crate::client::ClientOptions;
use crate::constants::ProtocolCode;
use crate::debug::DebugDirection;
use crate::errors::CallError;
use crate::failure::Failure;
use crate::managers::service::{
    DebugEvent, RequestDependencies, RequestOptions, ResolverDependencies, Response, TracedError,
    ValidateOptions,
};
use crate::metrics::{MetricsRegistry, MetricsRegistryOptions};
use crate::payloads::JsonCodec;
use crate::router::types::RouterError;
use crate::testing::pair::{Pair, PairOptions, echo};
use crate::violations::{Judged, Violation};

// what a manager's debug listener heard: why, when a step went wrong, and the step
type Heard = Arc<Mutex<Vec<(Option<String>, DebugEvent)>>>;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[test]
fn keeps_a_catalogue_of_failures_each_of_its_own_code_refusing_one_of_0_or_one_twice() {
    let on_purpose = ListedFailure::new("ON_PURPOSE", 7);
    let catalogue = failures_of(
        1,
        &[on_purpose, ListedFailure::new("REGISTERED_ALREADY", 8)],
    )
    .expect("a catalogue of two codes");

    assert_eq!(catalogue.service_id(), 1, "its service");
    assert_eq!(catalogue.failures().len(), 2, "each failure kept");

    let refused = [
        failures_of(0, &[on_purpose])
            .expect_err("a service of id 0")
            .message()
            .to_owned(),
        failures_of(1, &[ListedFailure::new("NONE", 0)])
            .expect_err("a code of 0")
            .message()
            .to_owned(),
        failures_of(1, &[on_purpose, ListedFailure::new("AGAIN", 7)])
            .expect_err("a code twice")
            .message()
            .to_owned(),
    ];

    assert_eq!(
        refused,
        [
            "a service's id is a whole number from 1 to 65535, not 0",
            "a failure's code is a whole number from 1 to 65535, not 0 for NONE",
            "AGAIN and ON_PURPOSE are both failure 7",
        ],
        "each refused, saying why"
    );
}

// a string empty breaks the rule that it holds one character at least
fn judge(value: &Value, _options: ValidateOptions) -> Judged {
    if value.as_str().is_some_and(|text| !text.is_empty()) {
        return Judged::default();
    }

    Judged {
        violations: vec![Violation {
            rule_id: "string.min_len".to_owned(),
            message: Some("value length must be at least 1 characters".to_owned()),
            ..Violation::default()
        }],
        more: 0,
        stopped: false,
    }
}

// debugging 9.6.5
#[tokio::test]
async fn counts_a_call_its_rules_refuse_before_it_goes_as_payload_invalid_started_and_ended_in_its_turn()
 {
    let registry = MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let client = ClientOptions {
        metrics_registry: Some(registry.clone()),
        ..ClientOptions::default()
    };

    let options = PairOptions {
        client,
        ..PairOptions::default()
    };

    let pair = Pair::connected((crate::testing::instants::new_year(), options))
        .await
        .expect("a pair connected");

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(JsonCodec, JsonCodec))
        .expect("echo resolved")
        .on(Arc::new(|request, response: Response<JsonCodec>| {
            response.result(request.payload)
        }))
        .expect("echo registered");

    let manager = pair.client.services();
    let steps: Heard = Arc::default();
    let hearing = Arc::clone(&steps);

    manager.on_debug(Arc::new(
        move |error: Option<&TracedError>, event: &DebugEvent| {
            locked(&hearing).push((error.map(ToString::to_string), event.clone()));
        },
    ));

    let validating = manager
        .get_request(
            &echo(),
            RequestDependencies {
                validate: Some(Arc::new(judge)),
                ..RequestDependencies::of(JsonCodec, JsonCodec)
            },
        )
        .expect("echo asked");

    // * the call queued on its router's owner, then a read queued right behind it: what the call
    // did in its own turn is counted by then, and nothing after
    let refusing = validating
        .call(Value::from(""), RequestOptions::default())
        .expect("a call");
    let reading = registry.clone();
    let in_its_turn = pair
        .client
        .router()
        .owner()
        .run(move |_state| reading.exposition().text)
        .await
        .expect("read on its owner");
    let refused = tokio::time::timeout(Duration::from_secs(10), refusing)
        .await
        .expect("refused at once");

    assert!(
        matches!(&refused, Err(CallError::Failure(failure)) if failure.protocol_code() == Some(ProtocolCode::PAYLOAD_INVALID)),
        "refused PAYLOAD_INVALID: {refused:?}"
    );

    for line in [
        "bead_client_call_started_total{service=\"2\",procedure=\"echo\",type=\"request\"} 1\n",
        "bead_client_call_handled_total{service=\"2\",procedure=\"echo\",type=\"request\",outcome=\"failure\",code=\"PAYLOAD_INVALID\"} 1\n",
        "bead_client_call_duration_seconds_count{service=\"2\",procedure=\"echo\",type=\"request\"} 1\n",
    ] {
        assert!(in_its_turn.contains(line), "counted in its turn: {line}");
    }

    // * its tx step told as it was refused, naming no call, then its failure
    pair.settle().await;

    let steps = locked(&steps).clone();

    assert_eq!(
        steps
            .iter()
            .map(|(error, event)| (error.is_some(), event.direction, event.call_id))
            .collect::<Vec<_>>(),
        [
            (false, DebugDirection::Tx, None),
            (true, DebugDirection::Rx, None)
        ],
        "its two steps"
    );
}

#[tokio::test]
async fn sends_an_unlisted_code_as_written_and_reports_it() {
    let pair = Pair::connected((crate::testing::instants::new_year(), PairOptions::default()))
        .await
        .expect("a pair connected");
    let descriptor = request_of(DescriptorInit {
        procedure: echo(),
        admission: AdmissionRule::None,
        failures: vec![ListedFailure::new("ON_PURPOSE", 7)],
        request: JsonCodec,
        result: JsonCodec,
        validate: None,
    })
    .expect("echo described");
    let service = ServiceServer::new(
        vec![ServiceProcedure::of(&descriptor)],
        ServiceServerOptions::default(),
    )
    .expect("its server");

    // a code of its service's catalogue that echo does not list, which nothing typed refuses
    service
        .on(
            &descriptor,
            Arc::new(|_request, response: Response<JsonCodec>| {
                let unlisted = NonZeroU16::new(9).map_or_else(
                    || Failure::application(NonZeroU16::MIN, "none"),
                    |code| Failure::application(code, "not listed"),
                );

                response.failure(&unlisted)
            }),
        )
        .expect("echo registered");
    service.offer(&pair.server).expect("offered");

    let answered = pair
        .client
        .services()
        .get_request(&echo(), RequestDependencies::of(JsonCodec, JsonCodec))
        .expect("echo asked")
        .call(json!("hello"), RequestOptions::default())
        .expect("echo called")
        .await;

    assert!(
        matches!(&answered, Err(CallError::Failure(failure)) if failure.code().get() == 9 && failure.detail() == "not listed"),
        "sent as written: {answered:?}"
    );

    pair.settle().await;

    let reports: Vec<String> = locked(&pair.server_reports)
        .iter()
        .map(|(error, _)| match error {
            RouterError::Other(error) => error.to_string(),
            RouterError::Failure(failure) => failure.to_string(),
        })
        .collect();

    assert_eq!(
        reports,
        ["echo answers failure 9, which it does not list"],
        "and reported"
    );
}
