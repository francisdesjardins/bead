//! A subscription answered while a holder is in flight: its handoff, its cancellation, the end
//! of its session, and the connection and procedure each place belongs to.

use core::num::NonZeroU16;
use std::sync::Arc;

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::cancel_of;
use super::server::{Served, first, news};
use crate::NotificationResolverDependencies;
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Envelope, RequestHeader};
use crate::errors::{CallError, ResolverError};
use crate::failure::Failure;
use crate::identity::Procedure;
use crate::managers::service::{Notifier, NotifyOptions, RequestResolverDependencies, Response};
use crate::payloads::TextCodec;
use crate::router::server::RouterServerOptions;
use crate::router::types::{CallAddress, ConnectionHandle};
use crate::testing::scripted::Sending;

#[derive(Clone, Copy)]
enum Outcome {
    Answer,
    Cancel,
    Fail,
}

fn failure() -> Failure {
    Failure::application(NonZeroU16::new(1).expect("a code"), "")
}

fn other() -> Procedure {
    Procedure {
        procedure_id: 7,
        procedure_name: "other".to_owned(),
        ..news()
    }
}

fn subscribing((call_id, procedure, payload): (u32, &Procedure, &str)) -> Envelope {
    Envelope::Request {
        header: RequestHeader {
            opens_subscription: true,
            ..super::server::header_of((call_id, procedure))
        },
        payload: Bytes::copy_from_slice(payload.as_bytes()),
    }
}

fn resolve(
    served: &Served,
    (procedure, released, outcome): (&Procedure, &CancellationToken, Outcome),
) -> Notifier<TextCodec> {
    let released = released.clone();
    served
        .services
        .get_notification_resolver(
            procedure,
            NotificationResolverDependencies::new(
                RequestResolverDependencies::new(TextCodec, TextCodec),
                TextCodec,
            ),
        )
        .expect("a resolver")
        .on(Arc::new(move |request, response: Response<TextCodec>| {
            let released = released.clone();
            Box::pin(async move {
                response
                    .register_notification()
                    .await
                    .map_err(ResolverError::other)?;
                if request.payload != "hold" {
                    return response.result("ok".to_owned()).await;
                }
                if matches!(outcome, Outcome::Cancel) {
                    request.signal.token().cancelled().await;
                    return Err(ResolverError::other(CallError::Cancelled(None)));
                }
                released.cancelled().await;
                match outcome {
                    Outcome::Fail => response.failure(&failure()).await,
                    Outcome::Answer | Outcome::Cancel => response.result("held".to_owned()).await,
                }
            })
        }))
        .expect("a callback")
}

struct Holding {
    served: Served,
    released: CancellationToken,
    notifier: Notifier<TextCodec>,
}

impl Holding {
    async fn new(outcome: Outcome) -> Self {
        let served = Served::new(&RouterServerOptions::default());
        served.transport.open(&first(), true);
        let released = CancellationToken::new();
        let notifier = resolve(&served, (&news(), &released, outcome));
        served
            .transport
            .deliver(&subscribing((1, &news(), "hold")), &first());
        served
            .transport
            .deliver(&subscribing((3, &news(), "subscribe")), &first());
        served.settle().await;
        assert_eq!(held(&served).await, [(first(), 1, 5)]);
        assert_eq!(served.sent_since(), ["first result 3 ok"]);
        assert_eq!(
            served
                .router
                .gauges()
                .await
                .expect("distinct counts")
                .counts["subscriptionsWaiting"],
            1
        );
        Self {
            served,
            released,
            notifier,
        }
    }

    async fn release(&self) {
        self.released.cancel();
        self.served.settle().await;
    }

    async fn notify(&self) -> Vec<String> {
        self.served.sent_since();
        self.notifier
            .notify("flash".to_owned(), &NotifyOptions::default())
            .await;
        self.served.settle().await;
        self.served.sent_since()
    }
}

async fn held(served: &Served) -> Vec<(ConnectionHandle, u32, u16)> {
    served
        .router
        .owner()
        .run(|state| {
            state
                .notifications
                .subscriptions(None)
                .into_iter()
                .map(|subscription| {
                    assert_eq!(subscription.procedure.service_id, 2);
                    (
                        subscription.connection_handle,
                        subscription.call_id,
                        subscription.procedure.procedure_id,
                    )
                })
                .collect()
        })
        .await
        .expect("subscriptions read")
}

#[tokio::test]
async fn takes_the_place_when_that_call_fails_and_hears_what_comes() {
    let holding = Holding::new(Outcome::Fail).await;
    holding.release().await;
    assert_eq!(held(&holding.served).await, [(first(), 3, 5)]);
    assert_eq!(holding.notify().await, ["first notification 3 flash"]);
    assert_eq!(holding.served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn takes_the_place_when_that_call_is_cancelled() {
    let holding = Holding::new(Outcome::Cancel).await;
    holding.served.transport.deliver(&cancel_of(1), &first());
    holding.served.settle().await;
    assert_eq!(held(&holding.served).await, [(first(), 3, 5)]);
    assert_eq!(holding.served.transport.take(), Vec::new());
    assert_eq!(holding.served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn takes_the_place_when_the_answer_of_that_call_cannot_go_out() {
    let holding = Holding::new(Outcome::Answer).await;
    holding
        .served
        .transport
        .send_as((&first(), Sending::Thrown("gone".to_owned())));
    holding.release().await;
    holding.served.transport.send_as((&first(), Sending::Taken));
    assert_eq!(held(&holding.served).await, [(first(), 3, 5)]);
    assert_eq!(holding.notify().await, ["first notification 3 flash"]);
    assert_eq!(holding.served.reported(), ["gone first"]);
}

#[tokio::test]
async fn stays_out_once_that_call_is_answered_and_does_not_take_a_place_it_leaves_later() {
    let holding = Holding::new(Outcome::Answer).await;
    holding.release().await;
    assert_eq!(held(&holding.served).await, [(first(), 1, 5)]);
    holding.served.transport.deliver(&cancel_of(1), &first());
    holding.served.settle().await;
    assert_eq!(held(&holding.served).await, []);
    assert_eq!(
        holding
            .served
            .router
            .gauges()
            .await
            .expect("distinct counts")
            .counts["subscriptionsWaiting"],
        0
    );
}

#[tokio::test]
async fn takes_nothing_once_cancelled_or_unsubscribed_itself() {
    for cancel in [true, false] {
        let holding = Holding::new(Outcome::Fail).await;
        if cancel {
            holding.served.transport.deliver(&cancel_of(3), &first());
        } else {
            assert!(
                !holding
                    .served
                    .router
                    .unsubscribe(CallAddress {
                        connection_handle: first(),
                        call_id: 3,
                    })
                    .await
            );
        }
        holding.served.settle().await;
        holding.release().await;
        assert_eq!(held(&holding.served).await, []);
        assert_eq!(holding.served.reported(), Vec::<String>::new());
    }
}

#[tokio::test]
async fn waits_by_procedure_two_held_on_one_connection_each_hand_their_own_place_over() {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    let released = CancellationToken::new();
    for procedure in [news(), other()] {
        resolve(&served, (&procedure, &released, Outcome::Fail));
    }
    for (call_id, procedure, payload) in [
        (1, news(), "hold"),
        (3, other(), "hold"),
        (5, news(), "subscribe"),
        (7, other(), "subscribe"),
    ] {
        served
            .transport
            .deliver(&subscribing((call_id, &procedure, payload)), &first());
    }
    served.settle().await;
    assert_eq!(held(&served).await, [(first(), 1, 5), (first(), 3, 7)]);
    released.cancel();
    served.settle().await;
    assert_eq!(held(&served).await, [(first(), 5, 5), (first(), 7, 7)]);
    assert_eq!(served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn is_the_first_answered_one_answered_after_it_waits_for_nothing() {
    let holding = Holding::new(Outcome::Fail).await;
    holding
        .served
        .transport
        .deliver(&subscribing((5, &news(), "subscribe")), &first());
    holding.served.settle().await;
    holding.release().await;
    assert_eq!(held(&holding.served).await, [(first(), 3, 5)]);
    assert_eq!(holding.notify().await, ["first notification 3 flash"]);
}

#[tokio::test]
async fn is_ended_as_an_established_one_when_the_session_ends_and_takes_nothing_after() {
    let holding = Holding::new(Outcome::Fail).await;
    holding
        .served
        .router
        .drop_subscriptions(
            first(),
            Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Server),
        )
        .await;
    holding.release().await;
    let sent = holding.served.transport.take();
    assert_eq!(sent.len(), 2);
    for ((handle, envelope), (call_id, code)) in sent
        .iter()
        .zip([(3, ProtocolCode::SESSION_REQUIRED.get().get()), (1, 1)])
    {
        assert_eq!(*handle, first());
        assert!(matches!(envelope, Envelope::Failure { header, failure }
            if header.call_id == call_id && failure.code.get() == code));
    }
    assert_eq!(held(&holding.served).await, []);
    assert_eq!(holding.notify().await, Vec::<String>::new());
}

#[tokio::test]
async fn a_subscription_answered_once_another_holds_its_place_answered_already_waits_for_nothing() {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    let released = CancellationToken::new();
    resolve(&served, (&news(), &released, Outcome::Answer));
    for call_id in [1, 3] {
        served
            .transport
            .deliver(&subscribing((call_id, &news(), "subscribe")), &first());
        served.settle().await;
    }
    served.transport.deliver(&cancel_of(1), &first());
    served.settle().await;
    assert_eq!(held(&served).await, []);
    assert_eq!(
        served
            .router
            .gauges()
            .await
            .expect("distinct counts")
            .counts["subscriptionsWaiting"],
        0
    );
}

#[tokio::test]
async fn drop_subscriptions_ends_the_established_and_the_waiting_never_one_in_flight_and_no_call_waits_after()
 {
    let holding = Holding::new(Outcome::Answer).await;
    let released = CancellationToken::new();
    resolve(&holding.served, (&other(), &released, Outcome::Answer));
    holding
        .served
        .transport
        .deliver(&subscribing((5, &other(), "subscribe")), &first());
    holding.served.settle().await;
    holding.served.sent_since();
    holding
        .served
        .router
        .drop_subscriptions(
            first(),
            Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Server),
        )
        .await;
    assert_eq!(
        holding.served.sent_since(),
        [
            "first failure 5 SESSION_REQUIRED",
            "first failure 3 SESSION_REQUIRED",
        ]
    );
    holding.release().await;
    assert_eq!(holding.served.sent_since(), ["first result 1 held"]);
    assert_eq!(held(&holding.served).await, [(first(), 1, 5)]);
    assert_eq!(
        holding
            .served
            .router
            .gauges()
            .await
            .expect("distinct counts")
            .counts["subscriptionsWaiting"],
        0
    );
}

#[tokio::test]
async fn a_connection_that_closes_takes_its_calls_in_flight_and_waiting_away() {
    let holding = Holding::new(Outcome::Fail).await;
    holding.served.transport.close_connection(&first());
    holding.served.settle().await;
    holding.served.transport.open(&first(), true);
    holding
        .served
        .transport
        .deliver(&subscribing((1, &news(), "hold")), &first());
    holding.served.settle().await;
    holding.release().await;
    let sent = holding.served.transport.take();
    assert_eq!(sent.len(), 1);
    assert!(
        matches!(&sent[0], (handle, Envelope::Failure { header, failure })
        if *handle == first() && header.call_id == 1 && failure.code.get() == 1)
    );
    assert_eq!(held(&holding.served).await, []);
    assert_eq!(holding.served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn takes_no_place_on_a_connection_that_closed_as_the_answer_of_that_call_failed_to_go_out() {
    let holding = Holding::new(Outcome::Answer).await;
    let released = CancellationToken::new();
    holding.served.transport.send_as((
        &first(),
        Sending::Waiting {
            released: released.clone(),
            outcome: Err(crate::testing::core_port::error_of("gone")),
        },
    ));
    holding.release().await;
    assert_eq!(holding.served.sent_since(), ["first result 1 held"]);
    assert_eq!(holding.served.reported(), Vec::<String>::new());
    holding.served.transport.close_connection(&first());
    holding.served.settle().await;
    assert_eq!(held(&holding.served).await, []);
    released.cancel();
    holding.served.settle().await;
    // * its resolver, which outlived its call, was told as its connection closed (spec 9.10): what
    // it fails with after is its connection's, reported by none
    assert_eq!(holding.served.reported(), Vec::<String>::new());
    assert_eq!(held(&holding.served).await, []);
    assert_eq!(
        holding
            .served
            .router
            .gauges()
            .await
            .expect("distinct counts")
            .counts["subscriptionsWaiting"],
        0
    );
}

#[tokio::test]
async fn keeps_apart_the_subscribing_calls_in_flight_on_one_connection_each_settled_by_its_own_answer()
 {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    let released = CancellationToken::new();
    resolve(&served, (&news(), &released, Outcome::Fail));
    resolve(&served, (&other(), &released, Outcome::Answer));
    for (call_id, procedure) in [(1, news()), (3, other())] {
        served
            .transport
            .deliver(&subscribing((call_id, &procedure, "hold")), &first());
    }
    served.settle().await;
    assert_eq!(held(&served).await, [(first(), 1, 5), (first(), 3, 7)]);
    released.cancel();
    served.settle().await;
    assert_eq!(held(&served).await, [(first(), 3, 7)]);
    assert_eq!(served.reported(), Vec::<String>::new());
}
