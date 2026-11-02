//! Notification registration, shared callbacks, unsubscription and declaration identity.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{ClientFixture, locked};
use crate::constants::{ProcedureKind, ProtocolCode, RouterSide};
use crate::envelope::{Envelope, FailureHeader, NotificationHeader, ResultHeader};
use crate::errors::CallError;
use crate::failure::Failure;
use crate::identity::{Deprecation, Procedure};
use crate::managers::service::{
    Notification, NotificationCallback, NotificationDependencies, NotificationRegistration,
    RequestOptions,
};
use crate::payloads::{JsonCodec, TextCodec};
use crate::router::types::BoxFuture;
use crate::testing::pair::echo;

type News = Notification<TextCodec, TextCodec, TextCodec>;
pub(super) type Heard = Arc<Mutex<Vec<String>>>;

pub(super) fn procedure() -> Procedure {
    Procedure {
        kind: None,
        ..echo()
    }
}

pub(super) fn notification(fixture: &ClientFixture) -> News {
    fixture
        .manager
        .get_notification(
            &procedure(),
            NotificationDependencies::of((TextCodec, TextCodec, TextCodec)),
        )
        .expect("declared")
}

pub(super) fn callback(heard: &Heard, label: &str) -> NotificationCallback<String> {
    let (heard, label) = (Arc::clone(heard), label.to_owned());
    Arc::new(move |value| {
        locked(&heard).push(format!("{label}{value}"));
        Box::pin(async { Ok(()) })
    })
}

pub(super) async fn pending<T>(future: &mut BoxFuture<T>) {
    core::future::poll_fn(|context| {
        assert!(future.as_mut().poll(context).is_pending());
        core::task::Poll::Ready(())
    })
    .await;
}

pub(super) fn result(call_id: u32, payload: &[u8]) -> Envelope {
    Envelope::Result {
        header: ResultHeader {
            call_id,
            total: None,
            credential: None,
        },
        payload: Bytes::copy_from_slice(payload),
    }
}

pub(super) fn deliver(fixture: &ClientFixture, (call_id, payload): (u32, &str)) {
    fixture.transport.deliver(&Envelope::Notification {
        header: NotificationHeader { call_id },
        payload: Bytes::copy_from_slice(payload.as_bytes()),
    });
}

pub(super) fn requests(fixture: &ClientFixture) -> Vec<Envelope> {
    fixture
        .transport
        .envelopes()
        .into_iter()
        .filter(|envelope| matches!(envelope, Envelope::Request { .. }))
        .collect()
}

pub(super) async fn subscribed(
    fixture: &ClientFixture,
    (notification, callback): (&News, NotificationCallback<String>),
) -> NotificationRegistration {
    let mut registering = notification.on(
        ("subscribe".to_owned(), callback),
        RequestOptions::default(),
    );
    pending(&mut registering).await;
    fixture.clock.settle().await;
    let call_id = requests(fixture).last().expect("a request").call_id();
    fixture.transport.deliver(&result(call_id, b"subscribed"));
    crate::testing::patience(Duration::from_secs(10), registering)
        .await
        .expect("answered")
        .expect("subscribed")
}

#[tokio::test]
async fn the_first_registration_requests_registers_and_then_hears_each_notification() {
    let fixture = ClientFixture::new();
    let heard = Heard::default();
    let notification = notification(&fixture);
    let registration = subscribed(&fixture, (&notification, callback(&heard, ""))).await;
    deliver(&fixture, (1, "one"));
    deliver(&fixture, (1, "two"));
    fixture.clock.settle().await;
    assert_eq!(requests(&fixture).len(), 1);
    assert!(fixture.router.has_notification(&notification.as_like()));
    assert!(
        matches!(&requests(&fixture)[0], Envelope::Request { header, .. } if header.opens_subscription && header.service_id == 2 && header.procedure_id == 1)
    );
    assert_eq!(*locked(&heard), ["one", "two"]);
    registration.unregister().await.expect("unregistered");
}

#[tokio::test]
async fn its_request_takes_the_destination_and_the_timeout_it_is_given_and_names_the_notification_it_subscribes()
 {
    let fixture = ClientFixture::new();
    let notification = notification(&fixture);
    let mut registering = notification.on(
        ("s".to_owned(), callback(&Heard::default(), "")),
        RequestOptions {
            destination_id: Some(3),
            timeout: Some(Duration::from_millis(50)),
            ..RequestOptions::default()
        },
    );
    pending(&mut registering).await;
    fixture.clock.settle().await;
    assert_eq!(fixture.clock.dues(), [Duration::from_millis(50)]);
    assert!(fixture.router.has_notification(&notification.as_like()));
    assert!(
        matches!(&requests(&fixture)[0], Envelope::Request { header, payload } if header.destination_id == Some(3) && header.opens_subscription && payload.as_ref() == b"s")
    );
    fixture.transport.deliver(&result(1, b"s"));
    registering
        .await
        .expect("subscribed")
        .unregister()
        .await
        .expect("unregistered");
}

#[tokio::test]
async fn the_router_holds_it_before_its_request_goes_out_so_a_notification_right_behind_the_answer_is_heard()
 {
    let fixture = ClientFixture::new();
    let notification = notification(&fixture);
    let heard = Heard::default();
    let mut registering = notification.on(
        ("s".to_owned(), callback(&heard, "")),
        RequestOptions::default(),
    );
    pending(&mut registering).await;
    fixture.clock.settle().await;
    assert!(fixture.router.has_notification(&notification.as_like()));
    let transport = Arc::clone(&fixture.transport);
    fixture
        .router
        .owner()
        .run(move |_| {
            transport.deliver(&Envelope::Notification {
                header: NotificationHeader { call_id: 1 },
                payload: Bytes::from_static(b"right behind"),
            });
            transport.deliver(&result(1, b"s"));
        })
        .await
        .expect("one read");
    let registration = registering.await.expect("subscribed");
    fixture.clock.settle().await;
    assert_eq!(*locked(&heard), ["right behind"]);
    registration.unregister().await.expect("unregistered");
}

#[tokio::test]
async fn once_registered_another_callback_joins_without_a_request() {
    let fixture = ClientFixture::new();
    let notification = notification(&fixture);
    let heard = Heard::default();
    let first = subscribed(&fixture, (&notification, callback(&heard, "first "))).await;
    let second = notification
        .on(
            ("subscribe".to_owned(), callback(&heard, "second ")),
            RequestOptions::default(),
        )
        .await
        .expect("joined");
    deliver(&fixture, (1, "news"));
    fixture.clock.settle().await;
    assert_eq!(requests(&fixture).len(), 1);
    assert_eq!(*locked(&heard), ["first news", "second news"]);
    first.unregister().await.expect("first out");
    second.unregister().await.expect("last out");
}

#[tokio::test]
async fn callbacks_registering_at_once_share_one_request_and_one_registration() {
    let fixture = ClientFixture::new();
    let notification = notification(&fixture);
    let heard = Heard::default();
    let mut first = notification.on(
        ("a".to_owned(), callback(&heard, "a ")),
        RequestOptions::default(),
    );
    let mut second = notification.on(
        ("b".to_owned(), callback(&heard, "b ")),
        RequestOptions::default(),
    );
    pending(&mut first).await;
    pending(&mut second).await;
    fixture.clock.settle().await;
    assert_eq!(requests(&fixture).len(), 1);
    fixture.transport.deliver(&result(1, b"a"));
    let first = first.await.expect("first joined");
    let second = second.await.expect("second joined");
    deliver(&fixture, (1, "news"));
    fixture.clock.settle().await;
    assert_eq!(*locked(&heard), ["a news", "b news"]);
    assert!(fixture.router.has_notification(&notification.as_like()));
    first.unregister().await.expect("first out");
    second.unregister().await.expect("last out");
}

#[tokio::test]
async fn a_failed_request_rejects_and_keeps_nothing_the_next_registration_asks_again() {
    let fixture = ClientFixture::new();
    let notification = notification(&fixture);
    let heard = Heard::default();
    let mut first = notification.on(
        ("a".to_owned(), callback(&heard, "a ")),
        RequestOptions::default(),
    );
    pending(&mut first).await;
    fixture.clock.settle().await;
    let failure =
        Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server).saying("refused");
    fixture.transport.deliver(&Envelope::Failure {
        header: FailureHeader {
            call_id: 1,
            credential: None,
        },
        failure: failure.record(),
    });
    assert!(
        matches!(first.await, Err(CallError::Failure(failure)) if failure.detail() == "refused")
    );
    assert!(!fixture.router.has_notification(&notification.as_like()));
    let registration = subscribed(&fixture, (&notification, callback(&heard, "b "))).await;
    deliver(&fixture, (3, "news"));
    fixture.clock.settle().await;
    assert_eq!(requests(&fixture).len(), 2);
    assert_eq!(*locked(&heard), ["b news"]);
    registration.unregister().await.expect("last out");
}

#[tokio::test]
async fn an_answer_to_its_subscription_that_does_not_decode_lets_go_of_it_the_router_cancelling_its_call()
 {
    let fixture = ClientFixture::new();
    let notification = fixture
        .manager
        .get_notification(
            &procedure(),
            NotificationDependencies::of((JsonCodec, JsonCodec, JsonCodec)),
        )
        .expect("declared");
    let mut registering = notification.on(
        (
            serde_json::json!({ "text": "a" }),
            Arc::new(|_| Box::pin(async { Ok(()) })),
        ),
        RequestOptions::default(),
    );
    pending(&mut registering).await;
    fixture.clock.settle().await;
    fixture.transport.deliver(&result(1, b"{not json"));
    assert!(
        matches!(registering.await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PAYLOAD_UNDECODABLE.get())
    );
    assert!(!fixture.router.has_notification(&notification.as_like()));
    assert!(
        matches!(fixture.transport.envelopes().last(), Some(Envelope::Cancel { header }) if header.call_id == 1)
    );
}

#[tokio::test]
async fn the_last_callback_taken_away_unregisters_the_notification_taking_one_away_twice_does_nothing()
 {
    let fixture = ClientFixture::new();
    let notification = notification(&fixture);
    let heard = Heard::default();
    let first = subscribed(&fixture, (&notification, callback(&heard, "first "))).await;
    let second = notification
        .on(
            ("s".to_owned(), callback(&heard, "second ")),
            RequestOptions::default(),
        )
        .await
        .expect("joined");
    first.unregister().await.expect("first out");
    first.unregister().await.expect("twice");
    deliver(&fixture, (1, "one"));
    fixture.clock.settle().await;
    assert!(fixture.router.has_notification(&notification.as_like()));
    assert_eq!(fixture.transport.sent().len(), 1);
    second.unregister().await.expect("last out");
    assert!(!fixture.router.has_notification(&notification.as_like()));
    assert_eq!(*locked(&heard), ["second one"]);
    assert_eq!(fixture.transport.sent().len(), 2);
    assert!(
        matches!(fixture.transport.envelopes().last(), Some(Envelope::Cancel { header }) if header.call_id == 1)
    );
}

#[tokio::test]
async fn the_last_callback_out_unsubscribes_with_the_call_id_and_the_answer_that_subscribed_before_the_router_lets_go_of_it()
 {
    let fixture = ClientFixture::new();
    let told = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&told);
    let router = fixture.router.clone();
    let liked = Arc::new(Mutex::new(
        None::<std::sync::Weak<dyn crate::router::client::NotificationLike>>,
    ));
    let reading = Arc::clone(&liked);
    let mut dependencies = NotificationDependencies::of((TextCodec, TextCodec, TextCodec));
    dependencies.unsubscribe = Some(Arc::new(move |call_id, response| {
        let notification = locked(&reading)
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
            .expect("the notification is held");
        let held = router.has_notification(&notification);
        locked(&hearing).push((call_id, response, held));
        Box::pin(async { Ok(()) })
    }));
    let notification = fixture
        .manager
        .get_notification(&procedure(), dependencies)
        .expect("declared");
    *locked(&liked) = Some(Arc::downgrade(&notification.as_like()));
    let first = subscribed(&fixture, (&notification, callback(&Heard::default(), ""))).await;
    let second = notification
        .on(
            ("s".to_owned(), callback(&Heard::default(), "")),
            RequestOptions::default(),
        )
        .await
        .expect("joined");
    first.unregister().await.expect("first out");
    assert_eq!(locked(&told).len(), 0);
    second.unregister().await.expect("last out");
    assert_eq!(*locked(&told), [(1, "subscribed".to_owned(), true)]);
    assert!(!fixture.router.has_notification(&notification.as_like()));
    assert_eq!(fixture.transport.sent().len(), 1);
}

#[tokio::test]
async fn taking_the_same_registration_away_twice_leaves_another_of_the_same_callback_alone() {
    let fixture = ClientFixture::new();
    let notification = notification(&fixture);
    let heard = Heard::default();
    let callback = callback(&heard, "");
    let first = subscribed(&fixture, (&notification, Arc::clone(&callback))).await;
    let second = notification
        .on(("s".to_owned(), callback), RequestOptions::default())
        .await
        .expect("joined");
    first.unregister().await.expect("first out");
    first.unregister().await.expect("twice");
    deliver(&fixture, (1, "one"));
    fixture.clock.settle().await;
    assert_eq!(*locked(&heard), ["one"]);
    assert!(fixture.router.has_notification(&notification.as_like()));
    second.unregister().await.expect("last out");
    second.unregister().await.expect("twice");
    assert!(!fixture.router.has_notification(&notification.as_like()));
    assert_eq!(fixture.transport.sent().len(), 2);
}

#[tokio::test]
async fn the_same_procedure_gives_the_same_notification_so_every_callback_is_heard() {
    let fixture = ClientFixture::new();
    let first = notification(&fixture);
    let second = notification(&fixture);
    assert!(Arc::ptr_eq(&first.as_like(), &second.as_like()));
    let heard = Heard::default();
    let one = subscribed(&fixture, (&first, callback(&heard, "first "))).await;
    let two = second
        .on(
            ("s".to_owned(), callback(&heard, "second ")),
            RequestOptions::default(),
        )
        .await
        .expect("joined");
    deliver(&fixture, (1, "news"));
    fixture.clock.settle().await;
    assert_eq!(*locked(&heard), ["first news", "second news"]);
    one.unregister().await.expect("first out");
    two.unregister().await.expect("last out");
}

#[tokio::test]
async fn the_same_procedure_under_another_kind_name_revision_deprecation_or_limit_is_a_programmer_error()
 {
    let fixture = ClientFixture::new();
    let held = notification(&fixture);
    for asked in [
        Procedure {
            kind: Some(ProcedureKind::Notifies),
            ..procedure()
        },
        Procedure {
            name: "echo2".to_owned(),
            ..procedure()
        },
        Procedure {
            service_revision: 4,
            ..procedure()
        },
        Procedure {
            deprecation: Some(Deprecation::default()),
            ..procedure()
        },
        Procedure {
            deprecation: Some(Deprecation {
                message: Some("soon".to_owned()),
            }),
            ..procedure()
        },
        Procedure {
            maximum_payload_bytes: Some(8),
            ..procedure()
        },
    ] {
        fixture
            .manager
            .get_notification(
                &asked,
                NotificationDependencies::of((TextCodec, TextCodec, TextCodec)),
            )
            .expect_err("another declaration");
    }
    let deprecated = Procedure {
        id: 70,
        deprecation: Some(Deprecation {
            message: Some("use news2".to_owned()),
        }),
        ..procedure()
    };
    let first = fixture
        .manager
        .get_notification(
            &deprecated,
            NotificationDependencies::of((TextCodec, TextCodec, TextCodec)),
        )
        .expect("declared");
    let second = fixture
        .manager
        .get_notification(
            &Procedure {
                deprecation: Some(Deprecation {
                    message: Some("use news2".to_owned()),
                }),
                ..deprecated
            },
            NotificationDependencies::of((TextCodec, TextCodec, TextCodec)),
        )
        .expect("declared again");
    assert!(Arc::ptr_eq(&first.as_like(), &second.as_like()));
    assert!(Arc::ptr_eq(
        &held.as_like(),
        &notification(&fixture).as_like()
    ));
}

#[tokio::test]
async fn refuses_a_notification_asked_for_again_at_another_window_none_against_one_among_them_and_gives_the_same_at_the_same()
 {
    for (paced_id, unpaced_id) in [(71, 1), (1, 9)] {
        let fixture = ClientFixture::new();
        let paced = Procedure {
            id: paced_id,
            ..procedure()
        };
        let unpaced = Procedure {
            id: unpaced_id,
            ..procedure()
        };
        let dependencies = |window| {
            let mut dependencies = NotificationDependencies::of((TextCodec, TextCodec, TextCodec));
            dependencies.window = window;
            dependencies
        };
        let held = fixture
            .manager
            .get_notification(&paced, dependencies(Some(4)))
            .expect("declared");
        let same = fixture
            .manager
            .get_notification(&paced, dependencies(Some(4)))
            .expect("the same window");
        assert!(Arc::ptr_eq(&held.as_like(), &same.as_like()));
        assert_eq!(
            fixture
                .manager
                .get_notification(&paced, dependencies(Some(1)))
                .expect_err("another window")
                .to_string(),
            format!("2/{paced_id} is already a notification with window 4, not window 1")
        );
        fixture
            .manager
            .get_notification(&paced, dependencies(None))
            .expect_err("no window against one");
        let held = fixture
            .manager
            .get_notification(&unpaced, dependencies(None))
            .expect("declared");
        let same = fixture
            .manager
            .get_notification(&unpaced, dependencies(None))
            .expect("the same window");
        assert!(Arc::ptr_eq(&held.as_like(), &same.as_like()));
        assert_eq!(
            fixture
                .manager
                .get_notification(&unpaced, dependencies(Some(1)))
                .expect_err("one against none")
                .to_string(),
            format!("2/{unpaced_id} is already a notification with no window, not window 1")
        );
    }
}

#[tokio::test]
async fn makes_a_notification_with_the_window_its_dependencies_give_paced_by_it() {
    let fixture = ClientFixture::new();
    let mut dependencies = NotificationDependencies::of((TextCodec, TextCodec, TextCodec));
    dependencies.window = Some(2);
    let notification = fixture
        .manager
        .get_notification(&procedure(), dependencies)
        .expect("declared");
    assert_eq!(notification.as_like().window(), Some(2));
    let unpaced = fixture
        .manager
        .get_notification(
            &Procedure {
                id: 9,
                ..procedure()
            },
            NotificationDependencies::of((TextCodec, TextCodec, TextCodec)),
        )
        .expect("declared");
    assert_eq!(unpaced.as_like().window(), None);
    let registration = subscribed(&fixture, (&notification, callback(&Heard::default(), ""))).await;
    assert!(matches!(&requests(&fixture)[0], Envelope::Request { header, .. } if header.paced));
    registration.unregister().await.expect("unregistered");
}
