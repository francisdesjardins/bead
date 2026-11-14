//! A client's service trace names each call by the id its router draws.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{Scripted, failure_of, locked, notification_of};
use crate::constants::{EnvelopeKind, ProtocolCode};
use crate::debug::{DebugDirection, DebugType};
use crate::envelope::{Envelope, EnvelopeHeader, ResultHeader};
use crate::errors::CallError;
use crate::managers::service::{
    NotificationDependencies, RegistrationOptions, RequestDependencies, RequestOptions,
    ServiceManager, ServiceManagerOptions, ServiceRouter,
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tells_a_calls_tx_step_off_its_routers_scheduler() {
    let scripted = Scripted::new();
    let services = services(&scripted);
    let (answered, answer) = std::sync::mpsc::channel();
    scripted.router.on_debug(Arc::new(move |direction, event| {
        if direction == DebugDirection::Rx && matches!(event.header, EnvelopeHeader::Result(_)) {
            answered
                .send(std::thread::current().id())
                .expect("the listener waits");
        }
    }));
    let answer = Arc::new(Mutex::new(answer));
    let told = Arc::new(Mutex::new(Vec::new()));
    let telling = Arc::clone(&told);
    let transport = Arc::clone(&scripted.transport);
    services.on_debug(Arc::new(move |_, step| {
        if step.direction == DebugDirection::Tx
            && let Some(call_id) = step.call_id
        {
            let here = std::thread::current().id();
            transport.deliver(&result(call_id, "b"));
            // A blocking listener leaves the router able to take its answer, as the source's wait does.
            let received =
                crate::testing::blocking(|| locked(&answer).recv_timeout(super::PATIENCE));
            let is_answered = received.is_ok();
            let is_same_thread = received.is_ok_and(|there| there == here);
            locked(&telling).push((is_same_thread, is_answered));
        }
    }));
    let waiting = services
        .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("echo declared")
        .call("a".to_owned(), &RequestOptions::default())
        .expect("a call");
    assert_eq!(
        crate::testing::patience(super::PATIENCE, waiting)
            .await
            .expect("the listener and router progress")
            .expect("answered"),
        "b"
    );
    assert_eq!(*locked(&told), [(false, true)]);
    assert_eq!(scripted.codes(), Vec::<String>::new());
}

#[tokio::test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test repeats its own string a bounded number of times"
)]
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
        .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("echo declared");
    let envelopes = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&envelopes);
    scripted.router.on_debug(Arc::new(move |direction, event| {
        locked(&hearing).push((
            direction,
            event.header.kind(),
            event.header.call_id(),
            matches!(&event.header, EnvelopeHeader::Request(header) if header.total.is_some()),
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
        .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
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
            NotificationDependencies::new(
                RequestDependencies::new(TextCodec, TextCodec),
                TextCodec,
            ),
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
    let mut registering = notification.register(
        "subscribe".to_owned(),
        Arc::new(move |news| {
            locked(&hearing).push(news);
            Box::pin(async { Ok(()) })
        }),
        &RegistrationOptions::default(),
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

// debugging 4.4; spec 9.0
#[tokio::test]
async fn a_request_made_inside_a_notification_callback_names_its_call_id_on_its_tx_step() {
    let scripted = Scripted::new();
    let services = services(&scripted);
    let notification = services
        .get_notification(
            &super::notifying(),
            NotificationDependencies::new(
                RequestDependencies::new(TextCodec, TextCodec),
                TextCodec,
            ),
        )
        .expect("notification declared");
    let asking = Arc::new(
        services
            .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
            .expect("echo declared"),
    );
    let steps = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&steps);
    services.on_debug(Arc::new(move |error, event| {
        assert!(error.is_none());
        let tx = event
            .tx
            .as_ref()
            .and_then(|value| value.as_ref().as_any().downcast_ref::<String>().cloned());
        let rx = event
            .rx
            .as_ref()
            .and_then(|value| value.as_ref().as_any().downcast_ref::<String>().cloned());
        if event.call_type == DebugType::Request
            && (tx.as_deref() == Some("read") || rx.as_deref() == Some("counter at 1"))
        {
            locked(&hearing).push((event.direction, event.call_id));
        }
    }));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let requesting = Arc::clone(&requests);
    scripted.router.on_debug(Arc::new(move |direction, event| {
        if direction == DebugDirection::Tx
            && let EnvelopeHeader::Request(header) = &event.header
        {
            locked(&requesting).push(header.call_id);
        }
    }));
    let reading = Arc::new(Mutex::new(None));
    let made = Arc::clone(&reading);
    let mut registering = notification.register(
        "subscribe".to_owned(),
        Arc::new(move |_| {
            // * made from within the notification's callback
            *locked(&made) = Some(
                asking
                    .call("read".to_owned(), &RequestOptions::default())
                    .expect("read made"),
            );
            Box::pin(async { Ok(()) })
        }),
        &RegistrationOptions::default(),
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
    scripted.transport.deliver(&notification_of(1, b'c'));
    scripted.settle().await;
    scripted.transport.deliver(&result(3, "counter at 1"));
    let read = locked(&reading).take().expect("read made");
    assert_eq!(
        crate::testing::patience(super::PATIENCE, read)
            .await
            .expect("answered")
            .expect("a result"),
        "counter at 1"
    );
    scripted.settle().await;
    assert_eq!(*locked(&requests), [1, 3]);
    assert_eq!(
        *locked(&steps),
        [(DebugDirection::Tx, Some(3)), (DebugDirection::Rx, Some(3)),]
    );
    assert_eq!(scripted.codes(), Vec::<String>::new());
    registration.unregister().await.expect("unregistered");
}
