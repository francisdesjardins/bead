//! A client's callback outcomes, credit failures and subscriptions ended within one read.

use std::sync::Arc;

use super::client::Notified;
use super::{Scripted, TIMEOUT, answered, failure_of, notification_of, result_of};
use crate::constants::ProtocolCode;
use crate::envelope::Envelope;
use crate::testing::scripted::Sending;

async fn subscribed(scripted: &Scripted, notification: &Arc<Notified>) {
    let subscribing = scripted.subscribe((&notification.like(), TIMEOUT)).await;
    scripted.transport.deliver(&result_of(1, None));
    answered(subscribing).await.expect("subscribed");
    scripted.settle().await;
}

#[tokio::test]
async fn counts_done_a_notification_whose_callback_threw_or_rejected_and_reports_why() {
    let scripted = Scripted::new();
    let notification = Notified::new(Some(1));
    subscribed(&scripted, &notification).await;
    scripted.transport.deliver(&notification_of(1, 1));
    scripted.settle().await;
    notification.settle((
        0,
        vec![
            Err(Arc::new(std::io::Error::other("callback failed"))),
            Ok(()),
            Err(Arc::new(std::io::Error::other("no error"))),
            Err(Arc::new(std::io::Error::other("another failed"))),
        ],
    ));
    scripted.settle().await;
    assert_eq!(
        scripted.codes(),
        ["callback failed", "no error", "another failed"]
    );
    assert_eq!(scripted.transport.credits(), [2]);
    notification.fail_with("decoded nothing");
    scripted.transport.deliver(&notification_of(1, 2));
    scripted.settle().await;
    assert_eq!(
        scripted.codes(),
        [
            "callback failed",
            "no error",
            "another failed",
            "decoded nothing"
        ]
    );
    assert_eq!(scripted.transport.credits(), [2, 3]);
}

#[tokio::test]
async fn credits_nothing_for_a_subscription_let_go_of_while_its_callbacks_ran() {
    let scripted = Scripted::new();
    let notification = Notified::new(Some(1));
    subscribed(&scripted, &notification).await;
    scripted.transport.deliver(&notification_of(1, 1));
    scripted.settle().await;
    scripted
        .router
        .unregister_notification((&notification.like(), true))
        .await;
    scripted.done((&notification, 0)).await;
    assert_eq!(scripted.transport.credits(), Vec::<u64>::new());
    assert!(
        matches!(scripted.transport.envelopes().last(), Some(Envelope::Cancel { header }) if header.call_id == 1)
    );
}

#[tokio::test]
async fn opens_no_window_for_a_subscription_the_server_ended_in_the_read_of_its_result() {
    let scripted = Scripted::new();
    let notification = Notified::new(Some(4));
    let subscribing = scripted.subscribe((&notification.like(), TIMEOUT)).await;
    let transport = Arc::clone(&scripted.transport);
    scripted
        .router
        .owner()
        .run(move |_| {
            transport.deliver(&result_of(1, None));
            transport.deliver(&failure_of(1, (ProtocolCode::CAPACITY_EXCEEDED, None)));
        })
        .await
        .expect("both envelopes in one turn");
    answered(subscribing).await.expect("subscribed");
    scripted.settle().await;
    assert_eq!(scripted.transport.credits(), Vec::<u64>::new());
    assert_eq!(scripted.codes(), Vec::<String>::new());
}

#[tokio::test]
async fn reports_a_credit_that_cannot_go_out() {
    let scripted = Scripted::new();
    let notification = Notified::new(Some(1));
    subscribed(&scripted, &notification).await;
    scripted.transport.deliver(&notification_of(1, 1));
    scripted.settle().await;
    scripted
        .transport
        .send_as(Sending::Thrown("gone".to_owned()));
    scripted.done((&notification, 0)).await;
    assert_eq!(scripted.transport.credits(), [2]);
    assert_eq!(scripted.codes(), ["gone"]);
}

#[tokio::test]
async fn credits_nothing_for_a_subscription_that_did_not_ask_and_reports_its_callbacks_rejections_all_the_same()
 {
    let scripted = Scripted::new();
    let notification = Notified::held(None);
    subscribed(&scripted, &notification).await;
    scripted.transport.deliver(&notification_of(1, 1));
    scripted.settle().await;
    notification.settle((
        0,
        vec![Err(Arc::new(std::io::Error::other("callback failed")))],
    ));
    scripted.settle().await;
    assert!(
        matches!(&scripted.transport.envelopes()[0], Envelope::Request { header, .. } if !header.paced)
    );
    assert_eq!(scripted.transport.credits(), Vec::<u64>::new());
    assert_eq!(scripted.codes(), ["callback failed"]);
}
