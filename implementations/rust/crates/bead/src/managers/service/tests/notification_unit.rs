//! A client's notification: one subscription, callback settlements and individual registrations.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::oneshot;

use super::notifications::{
    Heard, callback, deliver, notification, pending, procedure, requests, result, subscribed,
};
use super::{ClientFixture, locked};
use crate::RequestDependencies;
use crate::envelope::Envelope;
use crate::errors::CallError;
use crate::managers::service::{
    NotificationCallback, NotificationDependencies, RegistrationOptions,
};
use crate::payloads::TextCodec;

#[tokio::test]
async fn is_held_by_the_router_before_its_one_request_goes_out_however_many_register_at_once() {
    let fixture = ClientFixture::new();
    let heard = Heard::default();
    let seen: super::Heard = Arc::default();
    let hearing = Arc::clone(&seen);
    fixture.manager.on_debug(Arc::new(move |error, event| {
        locked(&hearing).push((error.map(ToString::to_string), event.clone()));
    }));
    let notification = notification(&fixture);
    let mut first = notification.register(
        "first".to_owned(),
        callback(&heard, "a "),
        &RegistrationOptions::default(),
    );
    let mut second = notification.register(
        "second".to_owned(),
        callback(&heard, "b "),
        &RegistrationOptions::default(),
    );
    pending(&mut first).await;
    pending(&mut second).await;
    fixture.clock.settle().await;
    assert!(fixture.router.has_notification(&notification.as_like()));
    assert_eq!(requests(&fixture).len(), 1);
    assert!(
        matches!(&requests(&fixture)[0], Envelope::Request { payload, .. } if payload.as_ref() == b"first")
    );
    fixture.transport.deliver(&result(1, b"subscribed"));
    let first = first.await.expect("first subscribed");
    let second = second.await.expect("second subscribed");
    deliver(&fixture, (1, "flash"));
    fixture.clock.settle().await;
    assert_eq!(*locked(&heard), ["a flash", "b flash"]);
    assert_eq!(
        locked(&seen)
            .iter()
            .filter(|(_, event)| event.call_type == crate::debug::DebugType::Notification)
            .count(),
        1
    );
    first.unregister().await.expect("one out");
    second.unregister().await.expect("last out");
    fixture.router.dispose().await;
}

#[tokio::test]
async fn the_last_callback_out_unsubscribes_then_unregisters_the_notification_with_no_cancel_once_acknowledged()
 {
    let fixture = ClientFixture::new();
    let unsubscribed = Arc::new(Mutex::new(Vec::new()));
    let heard = Arc::clone(&unsubscribed);
    let mut dependencies =
        NotificationDependencies::new(RequestDependencies::new(TextCodec, TextCodec), TextCodec);
    dependencies.unsubscribe = Some(Arc::new(move |call_id, response| {
        locked(&heard).push((call_id, response));
        Box::pin(async { Ok(()) })
    }));
    let notification = fixture
        .manager
        .get_notification(&procedure(), dependencies)
        .expect("declared");
    let first = subscribed(&fixture, (&notification, callback(&Heard::default(), ""))).await;
    let second = notification
        .register(
            "s".to_owned(),
            callback(&Heard::default(), ""),
            &RegistrationOptions::default(),
        )
        .await
        .expect("second subscribed");
    first.unregister().await.expect("first out");
    assert!(fixture.router.has_notification(&notification.as_like()));
    assert!(locked(&unsubscribed).is_empty());
    second.unregister().await.expect("last out");
    second.unregister().await.expect("out already");
    fixture.clock.settle().await;
    assert_eq!(*locked(&unsubscribed), [(1, "subscribed".to_owned())]);
    assert!(!fixture.router.has_notification(&notification.as_like()));
    assert!(
        !fixture
            .transport
            .envelopes()
            .iter()
            .any(|envelope| matches!(envelope, Envelope::Cancel { .. }))
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_drop_silences_the_callbacks_tells_the_manager_and_fails_a_registration_under_way() {
    let fixture = ClientFixture::new();
    let heard = Heard::default();
    let dropped = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&dropped);
    fixture
        .manager
        .on_dropped(Arc::new(move |procedure, failure| {
            locked(&hearing).push((
                procedure.clone(),
                failure.map(crate::failure::Failure::record),
            ));
        }));
    let notification = notification(&fixture);
    let mut registering = notification.register(
        "held".to_owned(),
        callback(&heard, ""),
        &RegistrationOptions::default(),
    );
    pending(&mut registering).await;
    fixture.clock.settle().await;
    assert_eq!(requests(&fixture).len(), 1);
    fixture.transport.close_connection();
    fixture.clock.settle().await;
    assert!(matches!(registering.await, Err(CallError::Disconnected(_))));
    deliver(&fixture, (1, "news"));
    fixture.clock.settle().await;
    assert_eq!(*locked(&dropped), [(procedure(), None)]);
    assert!(locked(&heard).is_empty());
    assert!(!fixture.router.has_notification(&notification.as_like()));
    assert!(
        !fixture
            .transport
            .envelopes()
            .iter()
            .any(|envelope| matches!(envelope, Envelope::Cancel { .. }))
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_trigger_settles_as_every_callback_did_the_tasks_they_returned_too() {
    let fixture = ClientFixture::new();
    let notification = notification(&fixture);
    let first = subscribed(&fixture, (&notification, callback(&Heard::default(), ""))).await;
    let (fetch, fetched) = oneshot::channel();
    let fetched = Arc::new(Mutex::new(Some(fetched)));
    let fetching: NotificationCallback<String> = Arc::new(move |_| {
        let fetched = locked(&fetched).take().expect("one trigger");
        Box::pin(async move {
            fetched.await.expect("fetched");
            Ok(())
        })
    });
    let second = notification
        .register("s".to_owned(), fetching, &RegistrationOptions::default())
        .await
        .expect("second subscribed");
    let failure: Arc<dyn std::error::Error + Send + Sync> =
        Arc::new(std::io::Error::other("fetch failed"));
    let failing = Arc::clone(&failure);
    let third = notification
        .register(
            "s".to_owned(),
            Arc::new(move |_| {
                let failure = Arc::clone(&failing);
                Box::pin(async move { Err(failure) })
            }),
            &RegistrationOptions::default(),
        )
        .await
        .expect("third subscribed");
    let mut settling = notification
        .as_like()
        .trigger(Bytes::from_static(b"flash"))
        .expect("triggered");
    pending(&mut settling).await;
    fetch.send(()).expect("fetched");
    let settled = settling.await;
    assert_eq!(settled.len(), 3);
    settled[0].as_ref().expect("synchronous callback settled");
    settled[1].as_ref().expect("asynchronous callback settled");
    assert!(Arc::ptr_eq(
        settled[2].as_ref().expect_err("failed"),
        &failure
    ));
    first.unregister().await.expect("first out");
    second.unregister().await.expect("second out");
    third.unregister().await.expect("last out");
    fixture.router.dispose().await;
}

#[tokio::test]
async fn carries_its_window_and_refuses_one_that_is_not_a_whole_number_above_0() {
    for window in [Some(3), None, Some(0)] {
        let fixture = ClientFixture::new();
        let mut dependencies = NotificationDependencies::new(
            RequestDependencies::new(TextCodec, TextCodec),
            TextCodec,
        );
        dependencies.window = window;
        let notification = fixture.manager.get_notification(&procedure(), dependencies);
        if window == Some(0) {
            assert_eq!(
                notification.expect_err("zero refused").to_string(),
                "a window is a whole number above 0, not 0"
            );
        } else {
            assert_eq!(notification.expect("declared").as_like().window(), window);
        }
        fixture.router.dispose().await;
    }
    let consumer = crate::testing::surface::Consumer::new();
    consumer.accepts("pub fn check(d: &mut bead::NotificationDependencies<bead::TextCodec, bead::TextCodec, bead::TextCodec>) { d.window = Some(3); }");
    consumer.refuses("pub fn check(d: &mut bead::NotificationDependencies<bead::TextCodec, bead::TextCodec, bead::TextCodec>) { d.window = Some(-1); }", ("E0600", "cannot apply unary operator"));
    consumer.refuses("pub fn check(d: &mut bead::NotificationDependencies<bead::TextCodec, bead::TextCodec, bead::TextCodec>) { d.window = Some(1.5); }", ("E0308", "mismatched types"));
}

#[tokio::test]
async fn the_same_callback_registered_twice_is_heard_twice_and_its_registrations_taken_away_one_by_one()
 {
    let fixture = ClientFixture::new();
    let heard = Heard::default();
    let notification = notification(&fixture);
    let callback = callback(&heard, "");
    let first = subscribed(&fixture, (&notification, Arc::clone(&callback))).await;
    let second = notification
        .register("s".to_owned(), callback, &RegistrationOptions::default())
        .await
        .expect("second subscribed");
    let trigger = |payload| {
        notification
            .as_like()
            .trigger(Bytes::from_static(payload))
            .expect("triggered")
    };
    for settled in trigger(b"both").await {
        settled.expect("callback settled");
    }
    first.unregister().await.expect("first out");
    first.unregister().await.expect("first out already");
    for settled in trigger(b"one").await {
        settled.expect("callback settled");
    }
    assert_eq!(*locked(&heard), ["both", "both", "one"]);
    second.unregister().await.expect("last out");
    fixture.router.dispose().await;
}

// decision 0044: a registration takes effect as it is made, its future only waiting
#[tokio::test]
async fn a_registration_whose_future_is_dropped_unpolled_still_subscribes_and_listens() {
    let fixture = ClientFixture::new();
    let heard = Heard::default();
    let notification = notification(&fixture);

    drop(notification.register(
        "dropped".to_owned(),
        callback(&heard, ""),
        &RegistrationOptions::default(),
    ));
    fixture.clock.settle().await;

    assert!(
        matches!(requests(&fixture).as_slice(), [Envelope::Request { payload, .. }] if payload.as_ref() == b"dropped"),
        "its subscribing call went: {:?}",
        requests(&fixture)
    );
    assert!(fixture.router.has_notification(&notification.as_like()));

    fixture.transport.deliver(&result(1, b"subscribed"));
    deliver(&fixture, (1, "news"));
    fixture.clock.settle().await;

    assert_eq!(*locked(&heard), ["news"], "its callback listens");
    fixture.router.dispose().await;
}

// ! a registration's handle dropped unregisters nothing: its callback hears on, as a promise or a
// `Task` let go does on the other sides, until `unregister` or its notification's end
#[tokio::test]
async fn a_registration_whose_handle_is_dropped_still_listens_and_keeps_its_subscription() {
    let fixture = ClientFixture::new();
    let heard = Heard::default();
    let notification = notification(&fixture);
    let registration = subscribed(&fixture, (&notification, callback(&heard, ""))).await;

    drop(registration);
    fixture.clock.settle().await;
    deliver(&fixture, (1, "news"));
    fixture.clock.settle().await;

    assert_eq!(*locked(&heard), ["news"], "its callback listens");
    assert!(
        fixture.router.has_notification(&notification.as_like()),
        "held"
    );
    assert!(
        !fixture
            .transport
            .envelopes()
            .iter()
            .any(|envelope| matches!(envelope, Envelope::Cancel { .. })),
        "its subscription kept"
    );
    fixture.router.dispose().await;
}

// decision 0044: the last registration taken away leaves as it is made, its future only waiting,
// so one dropped, unpolled or once polled, holds back no registration after it
#[tokio::test]
async fn an_unregistration_whose_future_is_dropped_still_leaves_and_the_next_registration_subscribes_anew()
 {
    for is_polled in [false, true] {
        let fixture = ClientFixture::new();
        let heard = Heard::default();
        let notification = notification(&fixture);
        let first = subscribed(&fixture, (&notification, callback(&Heard::default(), ""))).await;
        let mut leaving = first.unregister();

        if is_polled {
            pending(&mut leaving).await;
        }

        drop(leaving);
        fixture.clock.settle().await;

        assert!(
            !fixture.router.has_notification(&notification.as_like()),
            "let go of, polled {is_polled}"
        );
        assert!(
            fixture
                .transport
                .envelopes()
                .iter()
                .any(|envelope| matches!(envelope, Envelope::Cancel { .. })),
            "its subscription cancelled, polled {is_polled}"
        );

        let mut registering = notification.register(
            "again".to_owned(),
            callback(&heard, ""),
            &RegistrationOptions::default(),
        );

        fixture.clock.settle().await;
        assert_eq!(
            requests(&fixture).len(),
            2,
            "asked anew, polled {is_polled}"
        );
        pending(&mut registering).await;

        let call_id = requests(&fixture).last().expect("a request").call_id();

        fixture.transport.deliver(&result(call_id, b"subscribed"));

        let registration = crate::testing::patience(Duration::from_secs(10), registering)
            .await
            .expect("settled in time")
            .expect("subscribed anew");

        deliver(&fixture, (call_id, "news"));
        fixture.clock.settle().await;
        assert_eq!(*locked(&heard), ["news"], "heard, polled {is_polled}");
        registration.unregister().await.expect("last out");
        fixture.router.dispose().await;
    }
}
