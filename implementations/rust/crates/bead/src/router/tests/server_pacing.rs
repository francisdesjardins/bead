//! Paced notifications at the server's wire: credits, queue keys, bounds and the place handed
//! to a request answered while its holder was in flight.

use core::num::NonZeroU16;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::server::{Served, first, news, second};
use super::{cancel_of, locked};
use crate::constants::{ProtocolCode, RouterSide};
use crate::debug::DebugDirection;
use crate::envelope::{CreditHeader, Envelope, RequestHeader};
use crate::errors::{CallError, ResolverError};
use crate::failure::{Failure, FailureOrigin};
use crate::managers::notification::{NotificationKey, PacingLimitsOptions};
use crate::managers::service::{Notifier, NotifyOptions, ResolverDependencies, Response};
use crate::payloads::TextCodec;
use crate::router::server::RouterServerOptions;
use crate::testing::scripted::Sending;

struct Paced {
    served: Served,
    released: CancellationToken,
    notifier: Notifier<TextCodec>,
}

impl Paced {
    fn new(maximum: Option<u64>) -> Self {
        let served = Served::new(&RouterServerOptions {
            pacing: Some(PacingLimitsOptions {
                maximum_queued_notifications: maximum,
                ..PacingLimitsOptions::default()
            }),
            ..RouterServerOptions::default()
        });
        served.transport.open(&first(), true);
        served.transport.open(&second(), true);
        let released = CancellationToken::new();
        let waiting = released.clone();
        let notifier = served
            .services
            .get_notification_resolver(
                &news(),
                (ResolverDependencies::of(TextCodec, TextCodec), TextCodec),
            )
            .expect("a resolver")
            .on(Arc::new(move |request, response: Response<TextCodec>| {
                let waiting = waiting.clone();
                Box::pin(async move {
                    response
                        .register_notification()
                        .await
                        .map_err(ResolverError::other)?;
                    if request.payload == "hold" || request.payload == "fail" {
                        waiting.cancelled().await;
                    }
                    if request.payload == "fail" {
                        response
                            .failure(&Failure::application(
                                NonZeroU16::new(1).expect("a code"),
                                "",
                            ))
                            .await
                    } else {
                        response.result("ok".to_owned()).await
                    }
                })
            }))
            .expect("a callback");
        Self {
            served,
            released,
            notifier,
        }
    }

    async fn notify(&self, payload: &str, options: &NotifyOptions) {
        self.notifier.notify(payload.to_owned(), options).await;
        self.served.settle().await;
    }

    async fn queued(&self) -> (u64, u64) {
        let counts = self
            .served
            .router
            .gauges()
            .await
            .expect("distinct counts")
            .counts;
        (counts["pausedSubscriptions"], counts["queuedNotifications"])
    }

    async fn held(&self) -> Vec<(crate::router::types::ConnectionHandle, u32)> {
        self.served
            .router
            .owner()
            .run(|state| {
                state
                    .notifications
                    .subscriptions(None)
                    .into_iter()
                    .map(|subscription| (subscription.connection_handle, subscription.call_id))
                    .collect()
            })
            .await
            .expect("subscriptions read")
    }

    async fn release(&self) {
        self.released.cancel();
        self.served.settle().await;
    }
}

fn request((call_id, paced, payload): (u32, bool, &str)) -> Envelope {
    Envelope::Request {
        header: RequestHeader {
            paced,
            opens_subscription: true,
            ..super::server::header_of((call_id, &news()))
        },
        payload: Bytes::copy_from_slice(payload.as_bytes()),
    }
}

fn credit(call_id: u32, credit_end: u64) -> Envelope {
    Envelope::Credit {
        header: CreditHeader {
            call_id,
            credit_end,
            paced: true,
        },
    }
}

#[tokio::test]
async fn sends_one_notification_per_credit_and_queues_the_others_the_latest_of_a_key_in_its_place()
{
    let paced = Paced::new(None);
    paced
        .served
        .transport
        .deliver(&request((3, true, "")), &first());
    paced.served.settle().await;
    assert_eq!(paced.served.sent_since(), ["first result 3 ok"]);
    for (payload, key) in [
        ("7 a", Some(7)),
        ("7 b", Some(7)),
        ("9 a", Some(9)),
        ("event", None),
        ("7 c", Some(7)),
    ] {
        paced
            .notify(
                payload,
                &NotifyOptions {
                    key: key.map(NotificationKey::Number),
                    ..NotifyOptions::default()
                },
            )
            .await;
    }
    assert_eq!(paced.served.sent_since(), ["first notification 3 7 a"]);
    assert_eq!(paced.queued().await, (1, 3));
    paced.served.transport.deliver(&credit(3, 3), &first());
    paced.served.settle().await;
    assert_eq!(
        paced.served.sent_since(),
        ["first notification 3 7 c", "first notification 3 9 a"]
    );
    paced.served.transport.deliver(&credit(3, 2), &first());
    paced.served.transport.deliver(
        &Envelope::Credit {
            header: CreditHeader {
                call_id: 3,
                credit_end: 100,
                paced: false,
            },
        },
        &first(),
    );
    paced.served.settle().await;
    assert_eq!(paced.served.transport.take(), Vec::new());
    paced.served.transport.deliver(&credit(3, 5), &first());
    paced.served.settle().await;
    for payload in ["after", "past"] {
        paced.notify(payload, &NotifyOptions::default()).await;
    }
    assert_eq!(
        paced.served.sent_since(),
        ["first notification 3 event", "first notification 3 after"]
    );
    assert_eq!(paced.queued().await, (1, 1));
    assert_eq!(paced.served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn paces_no_subscription_that_did_not_ask_beside_one_that_did() {
    let paced = Paced::new(None);
    paced
        .served
        .transport
        .deliver(&request((3, true, "")), &first());
    paced
        .served
        .transport
        .deliver(&request((3, false, "")), &second());
    paced.served.settle().await;
    paced.served.sent_since();
    for payload in ["a", "b", "c"] {
        paced.notify(payload, &NotifyOptions::default()).await;
    }
    assert_eq!(
        paced.served.sent_since(),
        [
            "first notification 3 a",
            "second notification 3 a",
            "second notification 3 b",
            "second notification 3 c",
        ]
    );
    locked(&paced.served.activity).clear();
    paced.served.transport.deliver(&credit(3, 2), &first());
    paced.served.settle().await;
    assert_eq!(paced.served.sent_since(), ["first notification 3 b"]);
    assert_eq!(*locked(&paced.served.activity), ["Notification first"]);
}

#[tokio::test]
async fn drops_in_silence_a_credit_for_no_subscription_paced_which_may_have_crossed_its_end() {
    let paced = Paced::new(None);
    paced
        .served
        .transport
        .deliver(&request((3, false, "")), &second());
    paced.served.settle().await;
    paced.served.sent_since();
    paced.served.transport.deliver(&credit(9, 4), &first());
    paced.served.transport.deliver(&credit(3, 4), &second());
    paced.served.settle().await;
    assert_eq!(paced.served.transport.take(), Vec::new());
    assert_eq!(paced.served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn ends_an_established_subscription_whose_queue_goes_past_its_bounds_and_sends_it_nothing_after()
 {
    let paced = Paced::new(Some(2));
    paced
        .served
        .transport
        .deliver(&request((3, true, "")), &first());
    paced
        .served
        .transport
        .deliver(&request((5, true, "")), &second());
    paced.served.settle().await;
    paced.served.sent_since();
    for payload in ["a", "b", "c", "d"] {
        paced
            .notify(
                payload,
                &NotifyOptions {
                    filter: Some(Arc::new(|subscriber| {
                        subscriber.connection_handle == first()
                    })),
                    ..NotifyOptions::default()
                },
            )
            .await;
    }
    let sent = paced.served.transport.envelopes(&first());
    assert!(matches!(&sent[1], Envelope::Failure { failure, .. }
        if failure.detail == "the notifications queued for call 3 went past their bounds"));
    assert_eq!(
        paced.served.sent_since(),
        [
            "first notification 3 a",
            "first failure 3 CAPACITY_EXCEEDED"
        ]
    );
    assert_eq!(paced.held().await, [(second(), 5)]);
    assert_eq!(paced.queued().await, (0, 0));
    paced.notify("e", &NotifyOptions::default()).await;
    paced.served.transport.deliver(&credit(3, 10), &first());
    paced.served.settle().await;
    assert_eq!(paced.served.sent_since(), ["second notification 5 e"]);
    assert_eq!(paced.served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn answers_with_the_failure_a_call_in_flight_whose_queue_goes_past_its_bounds_and_hands_its_place_over()
 {
    let paced = Paced::new(Some(1));
    paced
        .served
        .transport
        .deliver(&request((3, true, "hold")), &first());
    paced
        .served
        .transport
        .deliver(&request((5, true, "")), &first());
    paced.served.settle().await;
    assert_eq!(paced.served.sent_since(), ["first result 5 ok"]);
    for payload in ["a", "b", "c"] {
        paced.notify(payload, &NotifyOptions::default()).await;
    }
    assert_eq!(
        paced.served.sent_since(),
        [
            "first notification 3 a",
            "first failure 3 CAPACITY_EXCEEDED"
        ]
    );
    for payload in ["d", "e"] {
        paced.notify(payload, &NotifyOptions::default()).await;
    }
    paced.release().await;
    assert_eq!(paced.served.sent_since(), ["first notification 5 d"]);
    assert_eq!(paced.held().await, [(first(), 5)]);
    paced.served.transport.deliver(&credit(5, 2), &first());
    paced.served.settle().await;
    assert_eq!(paced.served.sent_since(), ["first notification 5 e"]);
    assert_eq!(paced.served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn tells_the_failure_its_router_answered_in_the_resolvers_place() {
    let paced = Paced::new(Some(1));
    let told = Arc::new(Mutex::new(Vec::new()));
    let telling = Arc::clone(&told);
    paced
        .served
        .services
        .on_debug(Arc::new(move |error, event| {
            if event.call_id == Some(3) {
                let failure = error.map(|error| {
                    let error = error.downcast_ref::<CallError>().expect("a call error");
                    let CallError::Failure(failure) = error else {
                        panic!("a failure")
                    };
                    assert_eq!(failure.origin(), FailureOrigin::Local);
                    assert_eq!(
                        failure.header(),
                        Some(&crate::envelope::Header::Failure(
                            crate::envelope::FailureHeader {
                                call_id: 3,
                                credential: None
                            }
                        ))
                    );
                    (failure.code(), failure.detail().to_owned(), failure.side())
                });
                locked(&telling).push((
                    event.direction,
                    event.rx.as_ref().map(|value| format!("{value:?}")),
                    event.tx.as_ref().map(|value| format!("{value:?}")),
                    failure,
                ));
            }
        }));
    paced
        .served
        .transport
        .deliver(&request((3, true, "hold")), &first());
    paced.served.settle().await;
    for payload in ["a", "b", "c"] {
        paced.notify(payload, &NotifyOptions::default()).await;
    }
    paced.release().await;
    assert_eq!(
        paced.served.sent_since(),
        [
            "first notification 3 a",
            "first failure 3 CAPACITY_EXCEEDED"
        ]
    );
    assert_eq!(
        *locked(&told),
        [
            (DebugDirection::Rx, Some("\"hold\"".to_owned()), None, None),
            (
                DebugDirection::Tx,
                Some("\"hold\"".to_owned()),
                Some("\"ok\"".to_owned()),
                Some((
                    ProtocolCode::CAPACITY_EXCEEDED.get(),
                    "the notifications queued for call 3 went past their bounds".to_owned(),
                    Some(RouterSide::Server)
                ))
            ),
        ]
    );
    assert_eq!(paced.served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn reports_the_failure_it_could_not_send_a_call_in_flight_whose_queue_went_past_its_bounds() {
    let paced = Paced::new(Some(1));
    paced
        .served
        .transport
        .deliver(&request((3, true, "hold")), &first());
    paced.served.settle().await;
    for payload in ["a", "b"] {
        paced.notify(payload, &NotifyOptions::default()).await;
    }
    paced
        .served
        .transport
        .send_as((&first(), Sending::Thrown("gone".to_owned())));
    paced.notify("c", &NotifyOptions::default()).await;
    paced.release().await;
    paced.served.transport.send_as((&first(), Sending::Taken));
    assert_eq!(
        paced.served.sent_since(),
        [
            "first notification 3 a",
            "first failure 3 CAPACITY_EXCEEDED"
        ]
    );
    assert_eq!(paced.served.reported(), ["gone first"]);
    paced.served.transport.deliver(&credit(3, 10), &first());
    paced.served.settle().await;
    assert_eq!(paced.served.transport.take(), Vec::new());
    assert_eq!(paced.held().await, []);
}

#[tokio::test]
async fn paces_a_call_handed_its_place_as_its_own_request_asked_whatever_its_holder_asked() {
    let paced = Paced::new(None);
    for (handle, call_id, asks, payload) in [
        (first(), 1, true, "fail"),
        (first(), 3, false, "subscribe"),
        (second(), 1, false, "fail"),
        (second(), 3, true, "subscribe"),
    ] {
        paced
            .served
            .transport
            .deliver(&request((call_id, asks, payload)), &handle);
    }
    paced.served.settle().await;
    paced.served.transport.deliver(&cancel_of(1), &second());
    paced.served.settle().await;
    paced.release().await;
    paced.served.sent_since();
    for payload in ["a", "b"] {
        paced.notify(payload, &NotifyOptions::default()).await;
    }
    assert_eq!(
        paced.served.sent_since(),
        [
            "second notification 3 a",
            "first notification 3 a",
            "first notification 3 b",
        ]
    );
    assert_eq!(paced.served.reported(), Vec::<String>::new());
}
