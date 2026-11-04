//! Notifications at their payload and envelope bounds, a command's timeout, and a callback
//! attempting to subscribe as its router ends.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::server::{Served, first, news, second, subscribing_of};
use super::{answered, locked, options_of, token};
use crate::constants::EnvelopeKind;
use crate::envelope::{Envelope, NotificationHeader};
use crate::errors::{CallError, ResolverError};
use crate::managers::service::{NotifyOptions, RequestResolverDependencies, Response};
use crate::payloads::TextCodec;
use crate::router::server::{RouterServer, RouterServerOptions};
use crate::router::types::RouterLimitsOptions;
use crate::session_token::SessionToken;
use crate::testing::pair::echo;
use crate::{NotificationResolverDependencies, NotifyRequest, RouterRequest};

fn opened(options: &RouterServerOptions) -> Served {
    let served = Served::new(options);
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served
}

async fn subscribe(served: &Served) {
    served.transport.deliver(&subscribing_of(13), &first());
    served.transport.deliver(&subscribing_of(21), &second());
    served.settle().await;
    assert_eq!(
        served.sent_since(),
        ["first result 13 ok", "second result 21 ok"]
    );
}

#[tokio::test]
async fn counts_what_it_and_its_parts_hold_for_the_connections_it_follows_which_it_forgets_as_each_closes()
 {
    let served = opened(&RouterServerOptions {
        relay: Some(crate::RelayOptions {
            before_route: Some(crate::BeforeRequest::new(|_| true, None)),
            ..crate::RelayOptions::default()
        }),
        ..RouterServerOptions::default()
    });
    served
        .services
        .get_request_resolver(
            &echo(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("echo defined")
        .on(Arc::new(|request, _| {
            Box::pin(async move {
                request.signal.token().cancelled().await;
                Ok(())
            })
        }))
        .expect("the resolver leaves its request unanswered");
    let gauged = served
        .router
        .gauges()
        .await
        .expect("the connections' gauges");
    assert_eq!(
        gauged.connection_handles,
        [first(), second()].into_iter().collect()
    );
    served
        .transport
        .deliver(&super::server::request_of((1, &echo(), "")), &first());
    served
        .router
        .register_destination(
            crate::RelayTarget::Connection(second()),
            &crate::DestinationOptions {
                destination_id: Some(5),
                ..crate::DestinationOptions::default()
            },
        )
        .expect("destination 5");
    served.transport.close_connection(&second());
    served.settle().await;
    let gauged = served
        .router
        .gauges()
        .await
        .expect("the counts of every part");
    assert_eq!(gauged.anomalies, Vec::<String>::new());
    assert_eq!(
        gauged.connection_handles,
        std::iter::once(first()).collect()
    );
    for (name, expected) in [
        ("answeringCalls", 1),
        ("closedDestinations", 1),
        ("connections", 1),
        ("destinations", 1),
        ("notifiedSubscriptions", 0),
        ("pendingCalls", 0),
        ("subscriptionsInFlight", 0),
        ("subscriptionsWaiting", 0),
    ] {
        assert_eq!(gauged.counts[name], expected, "{name}");
    }
    served.transport.close_connection(&first());
    served.settle().await;
    let gauged = served
        .router
        .gauges()
        .await
        .expect("the closed connections forgotten");
    assert_eq!(gauged.connection_handles, std::collections::BTreeSet::new());
    for (name, expected) in [
        ("answeringCalls", 0),
        ("closedDestinations", 1),
        ("connections", 0),
        ("destinations", 1),
    ] {
        assert_eq!(gauged.counts[name], expected, "{name}");
    }
    assert_eq!(served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn notify_reaches_each_subscriber_under_the_call_id_it_subscribed_with_and_announces_no_session()
 {
    let other = SessionToken::new([2; 16]).expect("another token");
    let served = opened(&RouterServerOptions {
        session_token_of: Some(Arc::new(move |handle| {
            Ok(Some(if *handle == first() { token() } else { other }))
        })),
        ..RouterServerOptions::default()
    });
    let resolver = served.news();
    subscribe(&served).await;
    locked(&served.activity).clear();
    resolver
        .notify("flash".to_owned(), &NotifyOptions::default())
        .await;
    served.settle().await;
    assert_eq!(
        served.transport.take(),
        [
            (
                first(),
                Envelope::Notification {
                    header: NotificationHeader { call_id: 13 },
                    payload: Bytes::from_static(b"flash"),
                }
            ),
            (
                second(),
                Envelope::Notification {
                    header: NotificationHeader { call_id: 21 },
                    payload: Bytes::from_static(b"flash"),
                }
            ),
        ]
    );
    assert_eq!(
        *locked(&served.activity),
        ["Notification first", "Notification second"]
    );
    assert_eq!(served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn notify_refuses_a_payload_too_large_for_each_connection_and_reports_it_with_that_connection()
 {
    let served = opened(&RouterServerOptions::default());
    let _resolver = served.news();
    served.transport.deliver(&subscribing_of(1), &first());
    served.settle().await;
    served.sent_since();
    served
        .router
        .notify(
            Ok(Bytes::from(vec![0; 0x100_0001])),
            NotifyRequest::new(news().address()),
        )
        .await
        .expect("targets selected");
    served.settle().await;
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(served.reported(), ["PAYLOAD_TOO_LARGE first"]);
}

#[tokio::test]
async fn notify_sends_a_notification_in_one_envelope_of_the_routers_limits_or_refuses_it_for_each_connection()
 {
    let served = opened(&RouterServerOptions {
        limits: Some(RouterLimitsOptions {
            chunk_bytes: Some(64),
            maximum_envelope_bytes: Some(64),
            window_bytes: Some(128),
            ..RouterLimitsOptions::default()
        }),
        ..RouterServerOptions::default()
    });
    let _resolver = served.news();
    subscribe(&served).await;
    for count in [57, 56] {
        served
            .router
            .notify(
                Ok(Bytes::from(vec![0; count])),
                NotifyRequest::new(news().address()),
            )
            .await
            .expect("targets selected");
    }
    served.settle().await;
    assert_eq!(
        served.reported(),
        ["PAYLOAD_TOO_LARGE first", "PAYLOAD_TOO_LARGE second"]
    );
    let sent = served.transport.take();
    assert_eq!(sent.len(), 2);
    for (handle, envelope) in sent {
        assert!(
            matches!(envelope, Envelope::Notification { header, payload }
            if payload == vec![0; 56] && header.call_id == if handle == first() { 13 } else { 21 })
        );
    }
    RouterServer::new(
        Arc::<crate::testing::scripted::ScriptedServer>::clone(&served.transport),
        &RouterServerOptions {
            limits: Some(RouterLimitsOptions {
                window_bytes: Some(1),
                ..RouterLimitsOptions::default()
            }),
            ..RouterServerOptions::default()
        },
    )
    .expect_err("a window holds a chunk at least");
    assert_eq!(
        (
            served.router.limits().chunk_bytes,
            served.router.limits().maximum_envelope_bytes
        ),
        (64, 64)
    );
    let heard = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&heard);
    let mut options = options_of(Duration::from_secs(5));
    options.connection_handle = Some(first());
    let asking = served
        .router
        .request(Bytes::from_static(&[1]), {
            let mut request = RouterRequest {
                procedure: news(),
                options,
                series: None,
                refusal: None,
                subscribes: None,
                on_call_id: None,
                on_sent: None,
            };

            request.on_sent = Some(Box::new(move |handed| {
                locked(&hearing).push(handed);
            }));
            request
        })
        .expect("a command");
    served.settle().await;
    assert_eq!(*locked(&heard), [true]);
    served.router.dispose().await;
    assert!(matches!(
        answered(asking).await,
        Err(CallError::Disconnected(_))
    ));
}

#[tokio::test]
async fn a_command_that_times_out_is_cancelled_on_its_even_call_id() {
    let served = opened(&RouterServerOptions::default());
    let mut options = options_of(Duration::from_millis(20));
    options.connection_handle = Some(first());
    let asking = served
        .router
        .request(
            Bytes::from_static(b"ping"),
            RouterRequest {
                procedure: echo(),
                options,
                series: None,
                refusal: None,
                subscribes: None,
                on_call_id: None,
                on_sent: None,
            },
        )
        .expect("a command");
    served.clock.advance(Duration::from_millis(20)).await;
    let error = answered(asking).await.expect_err("the command times out");
    assert!(matches!(error, CallError::TimedOut(delay) if delay == Duration::from_millis(20)));
    assert_eq!(error.to_string(), "no answer came in 20 milliseconds");
    assert_eq!(
        served.sent_since(),
        ["first request 2 ping", "first Cancel 2"]
    );
    assert_eq!(
        served.transport.calls(&first()),
        Vec::<(EnvelopeKind, u32)>::new()
    );
}

#[tokio::test]
async fn a_callback_that_subscribes_as_the_router_is_disposed_hears_a_disconnect_error() {
    let served = opened(&RouterServerOptions::default());
    let thrown = Arc::new(Mutex::new(Vec::new()));
    let throwing = Arc::clone(&thrown);
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
        .on(Arc::new(move |request, response: Response<TextCodec>| {
            let throwing = Arc::clone(&throwing);
            Box::pin(async move {
                request.signal.token().cancelled().await;
                let outcome = response.register_notification().await;
                locked(&throwing).push(outcome);
                Err(ResolverError::other(std::io::Error::other("stopped")))
            })
        }))
        .expect("news registered");
    served.transport.deliver(&subscribing_of(1), &first());
    served.settle().await;
    served.router.dispose().await;
    served.settle().await;
    assert!(matches!(
        locked(&thrown).as_slice(),
        [Err(CallError::Disconnected(_))]
    ));
    served
        .router
        .owner()
        .run(|state| {
            assert_eq!(state.notifications.subscriptions(None), Vec::new());
        })
        .await
        .expect("no subscription remains");
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(served.reported(), Vec::<String>::new());
}
