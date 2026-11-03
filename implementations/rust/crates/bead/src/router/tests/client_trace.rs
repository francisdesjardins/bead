//! A client's service trace names each call by the id its router draws.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{Scripted, failure_of, locked, notification_of};
use crate::constants::{EnvelopeKind, ProtocolCode};
use crate::debug::{DebugDirection, DebugType};
use crate::envelope::{Envelope, Header, ResultHeader};
use crate::errors::CallError;
use crate::managers::service::{
    NotificationDependencies, RequestDependencies, RequestOptions, ServiceManager,
    ServiceManagerOptions, ServiceRouter,
};
use crate::payloads::TextCodec;
use crate::router::client::RouterClientOptions;
use crate::router::types::RouterLimitsOptions;
use crate::testing::pair::echo;

fn services(scripted: &Scripted) -> ServiceManager {
    ServiceManager::new(
        ServiceRouter::Client(scripted.router.clone()),
        &ServiceManagerOptions::default(),
    )
    .expect("a manager built")
}

fn result(call_id: u32, text: &str) -> Envelope {
    Envelope::Result {
        header: ResultHeader {
            call_id,
            total: None,
            credential: None,
        },
        payload: Bytes::copy_from_slice(text.as_bytes()),
    }
}

#[tokio::test]
async fn tells_a_calls_steps_with_the_call_id_its_request_carries() {
    let scripted = Scripted::with(&RouterClientOptions {
        limits: Some(RouterLimitsOptions {
            chunk_bytes: Some(1_000),
            maximum_envelope_bytes: Some(1_000),
            window_bytes: Some(2_000),
            ..RouterLimitsOptions::default()
        }),
        ..RouterClientOptions::default()
    });
    let services = services(&scripted);
    let asking = services
        .get_request(&echo(), RequestDependencies::of(TextCodec, TextCodec))
        .expect("echo declared");
    let envelopes = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&envelopes);
    scripted.router.on_debug(Arc::new(move |direction, event| {
        locked(&hearing).push((
            direction,
            event.header.kind(),
            event.header.call_id(),
            matches!(&event.header, Header::Request(header) if header.total.is_some()),
        ));
    }));
    let steps = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&steps);
    services.on_debug(Arc::new(move |_, event| {
        locked(&hearing).push((event.direction, event.call_id));
    }));
    let whole = asking
        .call("a".to_owned(), &RequestOptions::default())
        .expect("a call");
    scripted.settle().await;
    scripted.transport.deliver(&result(1, "b"));
    assert_eq!(
        crate::testing::patience(super::PATIENCE, whole)
            .await
            .expect("answered")
            .expect("a result"),
        "b"
    );
    let opening = asking
        .call("x".repeat(3_000), &RequestOptions::default())
        .expect("a transfer");
    scripted.settle().await;
    scripted
        .transport
        .deliver(&failure_of(3, (ProtocolCode::SESSION_REQUIRED, None)));
    assert!(
        matches!(crate::testing::patience(super::PATIENCE, opening).await.expect("answered"), Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::SESSION_REQUIRED.get())
    );
    scripted.settle().await;
    assert_eq!(
        *locked(&envelopes),
        [
            (DebugDirection::Tx, EnvelopeKind::Request, 1, false),
            (DebugDirection::Rx, EnvelopeKind::Result, 1, false),
            (DebugDirection::Tx, EnvelopeKind::Request, 3, true),
            (DebugDirection::Rx, EnvelopeKind::Failure, 3, false),
        ]
    );
    assert_eq!(
        *locked(&steps),
        [
            (DebugDirection::Tx, Some(1)),
            (DebugDirection::Rx, Some(1)),
            (DebugDirection::Tx, Some(3)),
            (DebugDirection::Rx, Some(3)),
        ]
    );
}

#[tokio::test]
async fn two_calls_to_one_procedure_started_in_one_millisecond_and_answered_in_one_batch_name_each_its_own_call_id()
 {
    let scripted = Scripted::new();
    let services = services(&scripted);
    let asking = services
        .get_request(&echo(), RequestDependencies::of(TextCodec, TextCodec))
        .expect("echo declared");
    let steps = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&steps);
    services.on_debug(Arc::new(move |error, event| {
        assert!(error.is_none());
        let value = if event.direction == DebugDirection::Tx {
            event.tx.as_ref()
        } else {
            event.rx.as_ref()
        };
        let text = value
            .expect("a value")
            .as_ref()
            .as_any()
            .downcast_ref::<String>()
            .expect("text")
            .clone();
        locked(&hearing).push((event.direction, event.call_id, event.started_at, text));
    }));
    let first = asking
        .call("a".to_owned(), &RequestOptions::default())
        .expect("first call");
    let second = asking
        .call("b".to_owned(), &RequestOptions::default())
        .expect("second call");
    scripted.settle().await;
    let transport = Arc::clone(&scripted.transport);
    scripted
        .router
        .owner()
        .run(move |_| {
            transport.deliver(&result(3, "answers b"));
            transport.deliver(&result(1, "answers a"));
        })
        .await
        .expect("one batch");
    assert_eq!(
        crate::testing::patience(super::PATIENCE, first)
            .await
            .expect("answered")
            .expect("a result"),
        "answers a"
    );
    assert_eq!(
        crate::testing::patience(super::PATIENCE, second)
            .await
            .expect("answered")
            .expect("a result"),
        "answers b"
    );
    scripted.settle().await;
    let steps = locked(&steps).clone();
    let tx = steps
        .iter()
        .filter(|(direction, ..)| *direction == DebugDirection::Tx)
        .cloned()
        .collect::<Vec<_>>();
    let mut rx = steps
        .iter()
        .filter(|(direction, ..)| *direction == DebugDirection::Rx)
        .cloned()
        .collect::<Vec<_>>();
    rx.sort_by_key(|(_, call_id, ..)| *call_id);
    let start = 1_767_225_600_000;
    assert_eq!(
        tx,
        [
            (DebugDirection::Tx, Some(1), start, "a".to_owned()),
            (DebugDirection::Tx, Some(3), start, "b".to_owned()),
        ]
    );
    assert_eq!(
        rx,
        [
            (DebugDirection::Rx, Some(1), start, "answers a".to_owned()),
            (DebugDirection::Rx, Some(3), start, "answers b".to_owned()),
        ]
    );
}

#[tokio::test]
async fn a_subscribing_call_binds_its_subscription_before_debug_hears_its_tx_step() {
    let scripted = Scripted::new();
    let services = services(&scripted);
    let notification = services
        .get_notification(
            &super::notifying(),
            NotificationDependencies::of((TextCodec, TextCodec, TextCodec)),
        )
        .expect("notification declared");
    let heard = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&heard);
    let transport = Arc::clone(&scripted.transport);
    services.on_debug(Arc::new(move |error, event| {
        assert!(error.is_none());
        if event.direction == DebugDirection::Tx
            && event.call_type == DebugType::Request
            && let Some(call_id) = event.call_id
        {
            let Envelope::Notification { header, .. } = notification_of(call_id, 0) else {
                panic!("a notification")
            };
            transport.deliver(&Envelope::Notification {
                header,
                payload: Bytes::from_static(b"first news"),
            });
        }
    }));
    let mut registering = notification.on(
        (
            "subscribe".to_owned(),
            Arc::new(move |news| {
                locked(&hearing).push(news);
                Box::pin(async { Ok(()) })
            }),
        ),
        &RequestOptions::default(),
    );
    core::future::poll_fn(|context| {
        assert!(registering.as_mut().poll(context).is_pending());
        core::task::Poll::Ready(())
    })
    .await;
    scripted.settle().await;
    scripted.transport.deliver(&super::result_of(1, None));
    let registration = crate::testing::patience(super::PATIENCE, registering)
        .await
        .expect("answered")
        .expect("subscribed");
    scripted.settle().await;
    assert_eq!(*locked(&heard), ["first news"]);
    assert_eq!(scripted.codes(), Vec::<String>::new());
    registration.unregister().await.expect("unregistered");
}
