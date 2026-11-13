//! Source trace scenarios: failure identity, payload snapshots and a listener attached between steps.

use core::fmt;
use core::time::Duration;
use std::error::Error;
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::super::{Step, traced_failure_of};
use super::{ClientFixture, locked};
use crate::constants::{FailureScope, ProtocolCode, RouterSide, SERVER_CONNECTION_HANDLE};
use crate::debug::{DebugDirection, DebugType};
use crate::envelope::FailureRecord;
use crate::errors::CallError;
use crate::failure::Failure;
use crate::managers::service::{RequestDependencies, RequestOptions};
use crate::payloads::JsonCodec;
use crate::testing::pair::echo;
use crate::testing::service_port::FakeRouter;

#[derive(Debug)]
struct Lookalike {
    code: &'static str,
    scope: u8,
}

impl fmt::Display for Lookalike {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("reset")
    }
}

impl Error for Lookalike {}

fn same_error(actual: &CallError, expected: &CallError) {
    match (actual, expected) {
        (CallError::Failure(actual), CallError::Failure(expected)) => {
            assert_eq!(actual.record(), expected.record());
            assert_eq!(actual.origin(), expected.origin());
            assert_eq!(actual.side(), expected.side());
            assert!(core::ptr::eq(
                actual.source().expect("the original cause"),
                expected.source().expect("the original cause")
            ));
        }
        (CallError::Other(actual), CallError::Other(expected)) => {
            assert!(Arc::ptr_eq(actual, expected));
        }
        _ => panic!("the original error variant: {actual:?} instead of {expected:?}"),
    }
}

#[tokio::test]
async fn rethrows_what_the_router_rejects_with_and_tells_debug_its_failure_and_only_a_failures() {
    let router = FakeRouter::client();
    let manager = router.manager();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seeing = Arc::clone(&seen);
    manager.on_debug(Arc::new(move |error, event| {
        locked(&seeing).push((error.cloned(), event.clone()));
    }));
    let failure = Failure::received(
        &FailureRecord {
            code: ProtocolCode::ACCESS_DENIED.get(),
            scope: FailureScope::Protocol,
            detail: "no".to_owned(),
            relays: 2,
        },
        RouterSide::Client,
    )
    .caused_by(Arc::new(std::io::Error::other("original failure")));
    let lookalike = Lookalike {
        code: "ECONNRESET",
        scope: 0,
    };
    assert_eq!((lookalike.code, lookalike.scope), ("ECONNRESET", 0));
    let errors = [
        CallError::Failure(failure.clone()),
        CallError::Other(Arc::new(lookalike)),
        CallError::Other(Arc::new(std::io::Error::other("reset"))),
    ];
    for expected in &errors {
        *locked(&router.control().request_error) = Some(expected.clone());
        let outcome = manager
            .get_request(&echo(), RequestDependencies::new(JsonCodec, JsonCodec))
            .expect("the requester")
            .call(json!({ "text": "x" }), &RequestOptions::default())
            .expect("the call")
            .await
            .expect_err("the router's error");
        same_error(&outcome, expected);
    }
    let seen = locked(&seen).clone();
    assert_eq!(seen.len(), 6);
    for (index, expected) in errors.iter().enumerate() {
        let sent = &seen[index * 2];
        let received = &seen[index * 2 + 1];
        assert!(sent.0.is_none());
        assert_eq!(sent.1.direction, DebugDirection::Tx);
        assert_eq!(received.1.direction, DebugDirection::Rx);
        let actual = received
            .0
            .as_ref()
            .and_then(|error| error.downcast_ref::<CallError>())
            .expect("the call's error wrapper");
        same_error(actual, expected);
        if index == 0 {
            let record = received
                .1
                .rx
                .as_ref()
                .and_then(|value| value.as_any().downcast_ref::<FailureRecord>())
                .expect("a failure's record");
            assert_eq!(*record, failure.record());
        } else {
            assert!(received.1.rx.is_none());
        }
    }
}

#[tokio::test]
async fn tells_its_observer_each_step_while_someone_listens_the_server_named_on_a_client_its_duration_once_answered_and_nothing_while_nobody_does()
 {
    let fixture = ClientFixture::new();
    let manager = &fixture.manager;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let started = manager.inner.started_now();
    let first = Step {
        call_id: Some(1),
        connection_handle: None,
        direction: DebugDirection::Tx,
        error: None,
        is_answered: false,
        options: None,
        rx: None,
        started,
        tx: Some(Arc::new(json!({ "text": "hi" }))),
        call_type: DebugType::Request,
    };
    manager.inner.trace(&echo(), first.clone());
    assert!(!manager.is_debugging());
    assert!(locked(&seen).is_empty());
    let seeing = Arc::clone(&seen);
    let listener = manager.on_debug(Arc::new(move |error, event| {
        locked(&seeing).push((error.cloned(), event.clone()));
    }));
    fixture.clock.advance(Duration::from_millis(250)).await;
    manager.inner.trace(
        &echo(),
        Step {
            direction: DebugDirection::Rx,
            is_answered: true,
            rx: Some(Arc::new(json!({ "text": "hi!" }))),
            tx: None,
            ..first
        },
    );
    assert!(manager.is_debugging());
    {
        let seen = locked(&seen).clone();
        assert_eq!(seen.len(), 1);
        let (error, event) = &seen[0];
        assert!(error.is_none());
        assert_eq!(event.call_id, Some(1));
        assert_eq!(
            event.connection_handle.as_deref(),
            Some(SERVER_CONNECTION_HANDLE)
        );
        assert_eq!(event.direction, DebugDirection::Rx);
        assert_eq!(event.duration, Some(250));
        assert_eq!(event.procedure_name, "echo");
        assert_eq!(event.started_at, 1_767_225_600_000);
        assert!(event.tx.is_none());
        assert_eq!(
            event
                .rx
                .as_ref()
                .and_then(|value| value.as_any().downcast_ref::<serde_json::Value>()),
            Some(&json!({ "text": "hi!" }))
        );
    }
    assert!(
        traced_failure_of(&CallError::Other(Arc::new(std::io::Error::other(
            "no failure"
        ))))
        .is_none()
    );
    manager.off(listener);
    fixture.router.dispose().await;
}
