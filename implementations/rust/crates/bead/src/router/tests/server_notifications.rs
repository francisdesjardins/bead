//! Subscription places held by a server: ordinary requests, callbacks before an answer,
//! connection closes and cancels, and the subscribers a notification's options keep.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::server::{Served, first, news, request_of, second, subscribing_of};
use super::{cancel_of, locked};
use crate::NotificationResolverDependencies;
use crate::envelope::{Envelope, RequestHeader};
use crate::errors::{CallError, ResolverError};
use crate::managers::service::{
    Notifier, NotifyOptions, RequestResolverDependencies, ResolverCallback, Response,
};
use crate::payloads::TextCodec;
use crate::router::server::RouterServerOptions;
use crate::router::types::ConnectionHandle;
use crate::testing::scripted::handle_of;

fn served() -> Served {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served
}

fn resolving(
    served: &Served,
    callback: ResolverCallback<TextCodec, TextCodec>,
) -> Notifier<TextCodec> {
    served
        .services
        .get_notification_resolver(
            &news(),
            NotificationResolverDependencies::new(
                RequestResolverDependencies::new(TextCodec, TextCodec),
                TextCodec,
            ),
        )
        .expect("news resolved")
        .on(callback)
        .expect("news registered")
}

async fn subscriptions(served: &Served) -> Vec<(ConnectionHandle, u32)> {
    served
        .router
        .owner()
        .run(|state| {
            state
                .notifications
                .subscriptions(None)
                .into_iter()
                .map(|subscription| {
                    assert_eq!(subscription.procedure, news().address());
                    (subscription.connection_handle, subscription.call_id)
                })
                .collect()
        })
        .await
        .expect("subscriptions read")
}

// spec 11.2
#[tokio::test]
async fn an_ordinary_request_answered_before_any_subscription_takes_no_place_the_subscription_after_it_is_kept()
 {
    let served = served();
    let news = served.news();
    served
        .transport
        .deliver(&request_of((1, &super::server::news(), "")), &first());
    served.settle().await;
    assert_eq!(subscriptions(&served).await, Vec::new());
    served.transport.deliver(&subscribing_of(3), &first());
    served.settle().await;
    served.sent_since();
    news.notify("flash".to_owned(), &NotifyOptions::default())
        .await;
    served.settle().await;
    assert_eq!(subscriptions(&served).await, [(first(), 3)]);
    assert_eq!(served.sent_since(), ["first notification 3 flash"]);
    assert_eq!(served.reported(), Vec::<String>::new());
}

// spec 11.2
#[tokio::test]
async fn a_callback_that_subscribes_an_ordinary_request_fails_is_reported_and_subscribes_nothing() {
    let served = served();
    resolving(
        &served,
        Arc::new(|_, response: Response<TextCodec>| {
            Box::pin(async move {
                response
                    .register_notification()
                    .await
                    .map_err(ResolverError::other)?;
                response.result("ok".to_owned()).await
            })
        }),
    );
    served
        .transport
        .deliver(&request_of((1, &news(), "")), &first());
    served.settle().await;
    assert_eq!(served.sent_since(), ["first failure 1 PROCEDURE_FAILED"]);
    assert_eq!(subscriptions(&served).await, Vec::new());
    let reports = locked(&served.reports).clone();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].1, Some(first()));
    let crate::router::types::RouterError::Other(error) = &reports[0].0 else {
        panic!("a programmer error is reported");
    };
    assert!(matches!(
        error.downcast_ref::<CallError>(),
        Some(CallError::Refused(_))
    ));
}

// spec 11.2
#[tokio::test]
async fn a_callback_that_subscribes_before_it_answers_gets_its_requests_call_id_and_the_one_held_each_time_after()
 {
    let served = served();
    let news = resolving(
        &served,
        Arc::new(|_, response: Response<TextCodec>| {
            Box::pin(async move {
                let id = response
                    .register_notification()
                    .await
                    .map_err(ResolverError::other)?;
                response.result(id.to_string()).await
            })
        }),
    );
    for id in [7, 9] {
        served.transport.deliver(&subscribing_of(id), &first());
        served.settle().await;
    }
    assert_eq!(
        served.sent_since(),
        ["first result 7 7", "first result 9 7"]
    );
    assert_eq!(subscriptions(&served).await, [(first(), 7)]);
    news.notify("flash".to_owned(), &NotifyOptions::default())
        .await;
    served.settle().await;
    assert_eq!(served.sent_since(), ["first notification 7 flash"]);
    assert_eq!(served.reported(), Vec::<String>::new());
}

// spec 11.2, 12.3
#[tokio::test]
async fn a_subscriptions_result_too_large_for_one_envelope_is_refused_answered_as_failed_and_subscribes_nothing()
 {
    let served = served();
    let large = "x".repeat(1_048_549);
    assert_eq!(
        large.len() + 28,
        1_048_577,
        "the result header and its announcement exceed one chunk by a byte"
    );
    resolving(
        &served,
        Arc::new(move |request, response: Response<TextCodec>| {
            let large = large.clone();
            Box::pin(async move {
                if request.payload == "explicit" {
                    response
                        .register_notification()
                        .await
                        .map_err(ResolverError::other)?;
                }
                response.result(large).await
            })
        }),
    );
    for (call_id, payload) in [(1, "explicit"), (3, "implicit")] {
        served.transport.deliver(
            &Envelope::Request {
                header: RequestHeader {
                    opens_subscription: true,
                    ..super::server::header_of((call_id, &news()))
                },
                payload: Bytes::from_static(payload.as_bytes()),
            },
            &first(),
        );
        served.settle().await;
    }
    assert_eq!(subscriptions(&served).await, Vec::new());
    assert_eq!(
        served.sent_since(),
        [
            "first failure 1 PROCEDURE_FAILED",
            "first failure 3 PROCEDURE_FAILED"
        ]
    );
    assert_eq!(
        served.reported(),
        ["PAYLOAD_TOO_LARGE first", "PAYLOAD_TOO_LARGE first"]
    );
}

// spec 11.2
#[tokio::test]
async fn a_connection_that_closes_before_its_answer_goes_out_is_not_subscribed() {
    let served = served();
    let released = CancellationToken::new();
    let done = CancellationToken::new();
    let (waiting, finished) = (released.clone(), done.clone());
    resolving(
        &served,
        Arc::new(move |_, response: Response<TextCodec>| {
            let (waiting, finished) = (waiting.clone(), finished.clone());
            Box::pin(async move {
                waiting.cancelled().await;
                let answer = response.result("ok".to_owned()).await;
                finished.cancel();
                answer
            })
        }),
    );
    served.transport.deliver(&subscribing_of(1), &first());
    served.settle().await;
    served.transport.close_connection(&first());
    served.settle().await;
    released.cancel();
    served.settle().await;
    assert!(done.is_cancelled(), "the callback attempts its late answer");
    assert_eq!(subscriptions(&served).await, Vec::new());
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(served.reported(), Vec::<String>::new());
}

#[derive(Clone, Copy)]
enum End {
    Close,
    Cancel,
}

async fn late_subscription(ending: End) {
    let served = served();
    let released = CancellationToken::new();
    let waiting = released.clone();
    let thrown = Arc::new(Mutex::new(Vec::new()));
    let recording = Arc::clone(&thrown);
    let notifier = resolving(
        &served,
        Arc::new(move |request, response: Response<TextCodec>| {
            let (waiting, recording) = (waiting.clone(), Arc::clone(&recording));
            Box::pin(async move {
                if request.header.call_id == 1 {
                    waiting.cancelled().await;
                }
                let id = response.register_notification().await.map_err(|error| {
                    locked(&recording).push(error.clone());
                    ResolverError::other(error)
                })?;
                response.result(id.to_string()).await
            })
        }),
    );
    served.transport.deliver(&subscribing_of(1), &first());
    served.settle().await;
    match ending {
        End::Close => served.transport.close_connection(&first()),
        End::Cancel => served.transport.deliver(&cancel_of(1), &first()),
    }
    served.settle().await;
    released.cancel();
    served.settle().await;
    assert!(matches!(
        (ending, locked(&thrown).as_slice()),
        (End::Close, [CallError::Disconnected(_)]) | (End::Cancel, [CallError::Cancelled])
    ));
    assert_eq!(subscriptions(&served).await, Vec::new());
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(served.reported(), Vec::<String>::new());
    if matches!(ending, End::Cancel) {
        served.transport.deliver(&subscribing_of(3), &first());
        served.settle().await;
        notifier
            .notify("flash".to_owned(), &NotifyOptions::default())
            .await;
        served.settle().await;
        assert_eq!(
            served.sent_since(),
            ["first result 3 3", "first notification 3 flash"]
        );
        assert_eq!(subscriptions(&served).await, [(first(), 3)]);
        assert_eq!(served.reported(), Vec::<String>::new());
    }
}

// spec 11.2
#[tokio::test]
async fn a_callback_subscribes_only_an_open_connection_and_fails_otherwise() {
    late_subscription(End::Close).await;
}

// spec 10.4, 11.2
#[tokio::test]
async fn a_callback_that_subscribes_once_its_call_was_cancelled_subscribes_nothing_and_the_next_one_is_kept()
 {
    late_subscription(End::Cancel).await;
}

// spec 10.4, 11.2
#[tokio::test]
async fn a_cancel_takes_away_what_its_call_subscribed_in_flight_and_nothing_answers_it() {
    let served = served();
    let released = CancellationToken::new();
    let waiting = released.clone();
    let done = CancellationToken::new();
    let finished = done.clone();
    resolving(
        &served,
        Arc::new(move |_, response: Response<TextCodec>| {
            let (waiting, finished) = (waiting.clone(), finished.clone());
            Box::pin(async move {
                response
                    .register_notification()
                    .await
                    .map_err(ResolverError::other)?;
                waiting.cancelled().await;
                let answer = response.result("ok".to_owned()).await;
                finished.cancel();
                answer
            })
        }),
    );
    served.transport.deliver(&subscribing_of(1), &first());
    served.settle().await;
    assert_eq!(subscriptions(&served).await, [(first(), 1)]);
    served.transport.deliver(&cancel_of(1), &first());
    served.settle().await;
    released.cancel();
    served.settle().await;
    assert!(
        done.is_cancelled(),
        "the cancelled callback attempts its answer"
    );
    assert_eq!(subscriptions(&served).await, Vec::new());
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(served.reported(), Vec::<String>::new());
}

// spec 10.4, 11.2
#[tokio::test]
async fn a_cancel_takes_an_established_subscription_away_on_its_own_connection_alone() {
    let served = served();
    let news = served.news();
    for handle in [first(), second()] {
        served.transport.deliver(&subscribing_of(1), &handle);
    }
    served.settle().await;
    served.sent_since();
    served.transport.deliver(&cancel_of(1), &second());
    news.notify("flash".to_owned(), &NotifyOptions::default())
        .await;
    served.settle().await;
    assert_eq!(served.sent_since(), ["first notification 1 flash"]);
    assert_eq!(subscriptions(&served).await, [(first(), 1)]);
    assert_eq!(served.reported(), Vec::<String>::new());
}

// spec 11.7
#[tokio::test]
async fn notify_reaches_only_those_its_options_keep() {
    let served = served();
    let third = handle_of(3);
    served.transport.open(&third, true);
    let news = served.news();
    for handle in [first(), second(), Arc::clone(&third)] {
        served.transport.deliver(&subscribing_of(1), &handle);
    }
    served.settle().await;
    served.sent_since();
    for (exclude, filtered, expected) in [
        (None, false, vec![first(), second(), Arc::clone(&third)]),
        (Some(second()), false, vec![first(), Arc::clone(&third)]),
        (None, true, vec![second(), Arc::clone(&third)]),
        (Some(Arc::clone(&third)), true, vec![second()]),
    ] {
        let mut options = NotifyOptions {
            exclude,
            ..NotifyOptions::default()
        };
        if filtered {
            options.filter = Some(Arc::new(|subscriber| {
                subscriber.connection_handle != first()
            }));
        }
        news.notify("flash".to_owned(), &options).await;
        served.settle().await;
        let sent = served.transport.take();
        assert_eq!(
            sent.iter()
                .map(|(handle, _)| Arc::clone(handle))
                .collect::<Vec<_>>(),
            expected
        );
        for (_, envelope) in sent {
            assert!(
                matches!(envelope, Envelope::Notification { header, payload }
                if header.call_id == 1 && payload == b"flash".as_slice())
            );
        }
    }
    assert_eq!(served.reported(), Vec::<String>::new());
}
