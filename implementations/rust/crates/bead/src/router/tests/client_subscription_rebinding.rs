//! A replacement subscription cancels its predecessor before its request goes out.

use super::client::Notified;
use super::{Scripted, TIMEOUT, answered, notification_of, result_of};
use crate::constants::EnvelopeKind;
use crate::constants::ProtocolCode;
use crate::errors::CallError;
use crate::router::server::CallHooks;
use bytes::Bytes;

#[tokio::test]
async fn a_second_subscription_of_the_same_notification_cancels_the_call_of_the_first() {
    let scripted = Scripted::new();
    let notification = Notified::new(None);
    for call_id in [1, 3] {
        let subscribing = scripted.subscribe((&notification.like(), TIMEOUT)).await;
        scripted.transport.deliver(&result_of(call_id, None));
        answered(subscribing).await.expect("subscribed");
    }
    scripted.transport.deliver(&notification_of(1, 5));
    scripted.transport.deliver(&notification_of(3, 5));
    scripted.settle().await;
    assert_eq!(notification.triggered(), [5]);
    assert_eq!(scripted.codes(), Vec::<String>::new());
    assert_eq!(
        scripted.transport.calls(),
        [
            (EnvelopeKind::Request, 1),
            (EnvelopeKind::Cancel, 1),
            (EnvelopeKind::Request, 3)
        ]
    );
}

#[tokio::test]
async fn keeps_the_replacement_bound_when_its_predecessor_is_cancelled_before_its_answer() {
    let scripted = Scripted::new();
    let notification = Notified::new(None);
    let first = scripted.subscribe((&notification.like(), TIMEOUT)).await;
    let second = scripted.subscribe((&notification.like(), TIMEOUT)).await;
    assert!(matches!(answered(first).await, Err(CallError::Cancelled)));
    scripted.transport.deliver(&result_of(3, None));
    answered(second).await.expect("the replacement's result");
    scripted.transport.deliver(&notification_of(3, 7));
    scripted.settle().await;
    assert_eq!(notification.triggered(), [7]);
    assert_eq!(scripted.codes(), Vec::<String>::new());
    assert_eq!(
        scripted.transport.calls(),
        [
            (EnvelopeKind::Request, 1),
            (EnvelopeKind::Cancel, 1),
            (EnvelopeKind::Request, 3)
        ]
    );
}

#[tokio::test]
async fn keeps_the_subscription_when_its_replacement_is_refused_before_drawing_a_call_id() {
    let scripted = Scripted::new();
    let notification = Notified::new(None);
    let first = scripted.subscribe((&notification.like(), TIMEOUT)).await;
    scripted.transport.deliver(&result_of(1, None));
    answered(first).await.expect("subscribed");
    let replacement = scripted
        .router
        .request(
            Bytes::from(vec![0; 0x100_0001]),
            (
                super::request_of((Some(notification.like()), TIMEOUT)),
                CallHooks::default(),
            ),
        )
        .expect("a request future");
    assert!(
        matches!(answered(replacement).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get())
    );
    scripted.transport.deliver(&notification_of(1, 7));
    scripted.settle().await;
    assert_eq!(notification.triggered(), [7]);
    assert_eq!(scripted.transport.calls(), [(EnvelopeKind::Request, 1)]);
    assert_eq!(scripted.codes(), Vec::<String>::new());
}
