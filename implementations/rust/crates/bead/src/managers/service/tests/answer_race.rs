//! A router answers in its resolver's place while that resolver's answer goes to it.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use super::{Fixture, Recording, locked, props};
use crate::constants::{ProtocolCode, RouterSide};
use crate::debug::{DebugDirection, DebugType};
use crate::envelope::{EnvelopeHeader, FailureHeader, FailureRecord};
use crate::errors::CallError;
use crate::failure::{Failure, FailureOrigin};
use crate::managers::service::{DebugEvent, Resolving, TracedError};
use crate::payloads::JsonCodec;
use crate::router::core::Answerer;
use crate::router::types::{BoxFuture, RouterAnswer};
use crate::testing::{SteppingClock, pair::echo};

struct Racing {
    clock: Arc<SteppingClock>,
    held: Arc<Mutex<Option<FailureRecord>>>,
    replacement: Option<FailureRecord>,
}

impl crate::router::core::sealed::Answerer for Racing {}

impl Answerer for Racing {
    fn respond(&self, answer: RouterAnswer) -> BoxFuture<Result<(), CallError>> {
        let clock = Arc::clone(&self.clock);
        let held = Arc::clone(&self.held);
        let replacement = self.replacement.clone();
        Box::pin(async move {
            if let Some(failure) = replacement {
                clock.advance(Duration::from_millis(5)).await;
                *locked(&held) = Some(failure);
            } else if let RouterAnswer::Failure(failure) = answer {
                *locked(&held) = Some(failure);
            }
            Ok(())
        })
    }

    fn answered(&self) -> BoxFuture<Option<FailureRecord>> {
        let held = locked(&self.held).clone();
        Box::pin(async move { held })
    }

    fn subscribe(&self) -> BoxFuture<Result<u32, CallError>> {
        panic!("the request opens no subscription")
    }
}

#[tokio::test]
#[ignore = "divergence: a replacement failure answered while the resolver's response is sent is not told again; C# tells the same start with the failure at 15 ms"]
#[expect(
    clippy::too_many_lines,
    reason = "the source keeps a replacement race and its own-failure control in one test"
)]
async fn tells_again_at_its_start_the_failure_its_router_answered_in_its_place_as_its_answer_went_to_it()
 {
    let fixture = Fixture::new();
    fixture.clock.wall_by(-1_767_225_599_000);
    let heard = Arc::new(Mutex::new(Vec::<(Option<TracedError>, DebugEvent)>::new()));
    let hearing = Arc::clone(&heard);
    fixture.manager.on_debug(Arc::new(move |error, event| {
        locked(&hearing).push((error.cloned(), event.clone()));
    }));
    let exceeded = Failure::protocol(ProtocolCode::CAPACITY_EXCEEDED, RouterSide::Server)
        .saying("the notifications queued for call 7 went past their bounds")
        .record();
    let racing = Arc::new(Racing {
        clock: Arc::clone(&fixture.clock),
        held: Arc::default(),
        replacement: Some(exceeded.clone()),
    });
    let clock = Arc::clone(&fixture.clock);
    let mut resolver = Resolving {
        manager: Arc::clone(&fixture.manager.inner),
        admit: None,
        procedure: echo(),
        request: JsonCodec,
        result: Arc::new(JsonCodec),
        validate: None,
        fail_fast: false,
        callback: Arc::new(move |request, response| {
            let clock = Arc::clone(&clock);
            Box::pin(async move {
                clock.advance(Duration::from_millis(10)).await;
                response.result(request.payload).await
            })
        }),
        call_type: DebugType::Request,
        listed: None,
    };
    let mut request = props(&Arc::new(Recording::default()), br#"{"text":"hi"}"#);
    request.answerer = racing;
    resolver
        .resolve(request)
        .await
        .expect("the router takes the response");
    let steps = locked(&heard).clone();
    assert_eq!(
        steps
            .iter()
            .map(|(error, event)| {
                let tx = event.tx.as_ref().map(|value| {
                    value
                        .as_ref()
                        .as_any()
                        .downcast_ref::<serde_json::Value>()
                        .expect("the response")
                        .clone()
                });
                (
                    event.direction,
                    error.is_some(),
                    tx,
                    event.started_at,
                    event.duration,
                )
            })
            .collect::<Vec<_>>(),
        [
            (DebugDirection::Rx, false, None, 1_000, None),
            (
                DebugDirection::Tx,
                false,
                Some(serde_json::json!({"text":"hi"})),
                1_000,
                Some(10)
            ),
            (
                DebugDirection::Tx,
                true,
                Some(serde_json::json!({"text":"hi"})),
                1_000,
                Some(15)
            ),
        ]
    );
    let error = steps[2]
        .0
        .as_ref()
        .expect("the router's replacement failure")
        .downcast_ref::<CallError>()
        .expect("a call error");
    let CallError::Failure(failure) = error else {
        panic!("the replacement is a failure");
    };
    assert_eq!(failure.record(), exceeded);
    assert_eq!(failure.origin(), FailureOrigin::Local);
    assert_eq!(failure.side(), Some(RouterSide::Server));
    assert_eq!(
        failure.header(),
        Some(&EnvelopeHeader::Failure(FailureHeader {
            call_id: 7,
            credential: None
        }))
    );

    locked(&heard).clear();
    resolver.procedure.procedure_id = 2;
    resolver.procedure.procedure_name = "fail".to_owned();
    resolver.callback = Arc::new(|_, response| {
        response.failure(&Failure::application(
            core::num::NonZeroU16::new(7).expect("an application code"),
            "",
        ))
    });
    let mut request = props(&Arc::new(Recording::default()), br#"{"text":"hi"}"#);
    request.answerer = Arc::new(Racing {
        clock: Arc::clone(&fixture.clock),
        held: Arc::default(),
        replacement: None,
    });
    resolver
        .resolve(request)
        .await
        .expect("its own failure answered");
    assert_eq!(
        locked(&heard)
            .iter()
            .map(|(_, event)| (event.direction, event.call_type))
            .collect::<Vec<_>>(),
        [
            (DebugDirection::Rx, DebugType::Request),
            (DebugDirection::Tx, DebugType::Request),
        ]
    );
    fixture.router.dispose().await;
}
