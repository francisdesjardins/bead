//! Notification endings, failed unsubscriptions and a callback arriving while the last leaves.

use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use super::notifications::{
    Heard, callback, deliver, notification, pending, procedure, requests, result, subscribed,
};
use super::{ClientFixture, locked};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Envelope, FailureHeader};
use crate::errors::CallError;
use crate::failure::Failure;
use crate::managers::service::{
    NotificationDependencies, RequestOptions, ServiceManager, ServiceManagerOptions, ServiceRouter,
};
use crate::payloads::TextCodec;

#[tokio::test]
async fn an_unsubscription_that_fails_rejects_the_last_unregister_once_the_router_let_go_all_the_same()
 {
    let fixture = ClientFixture::new();
    let refusal: Arc<dyn std::error::Error + Send + Sync> =
        Arc::new(std::io::Error::other("refused"));
    let failure = Arc::clone(&refusal);
    let mut dependencies = NotificationDependencies::of((TextCodec, TextCodec, TextCodec));
    dependencies.unsubscribe = Some(Arc::new(move |_, _| {
        let failure = Arc::clone(&failure);
        Box::pin(async move { Err(CallError::Other(failure)) })
    }));
    let notification = fixture
        .manager
        .get_notification(&procedure(), dependencies)
        .expect("declared");
    let registration = subscribed(&fixture, (&notification, callback(&Heard::default(), ""))).await;
    assert!(
        matches!(registration.unregister().await, Err(CallError::Other(error)) if Arc::ptr_eq(&error, &refusal))
    );
    assert!(!fixture.router.has_notification(&notification.as_like()));
    assert!(
        matches!(fixture.transport.envelopes().last(), Some(Envelope::Cancel { header }) if header.call_id == 1)
    );
    let _registration =
        subscribed(&fixture, (&notification, callback(&Heard::default(), ""))).await;
    assert_eq!(requests(&fixture).len(), 2);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_second_manager_on_the_same_router_cannot_take_its_procedure_over_nor_away() {
    let fixture = ClientFixture::new();
    let first = notification(&fixture);
    let heard = Heard::default();
    let registration = subscribed(&fixture, (&first, callback(&heard, ""))).await;
    let second = ServiceManager::new(
        ServiceRouter::Client(fixture.router.clone()),
        &ServiceManagerOptions::default(),
    )
    .expect("a second manager");
    let second = second
        .get_notification(
            &procedure(),
            NotificationDependencies::of((TextCodec, TextCodec, TextCodec)),
        )
        .expect("declared");
    assert!(matches!(
        second
            .on(
                ("s".to_owned(), callback(&Heard::default(), "")),
                RequestOptions::default()
            )
            .await,
        Err(CallError::Refused(_))
    ));
    deliver(&fixture, (1, "news"));
    fixture.clock.settle().await;
    assert_eq!(*locked(&heard), ["news"]);
    assert!(fixture.router.has_notification(&first.as_like()));
    assert!(!fixture.router.has_notification(&second.as_like()));
    assert_eq!(fixture.transport.sent().len(), 1);
    registration.unregister().await.expect("last out");
}

#[tokio::test]
async fn dropped_with_its_connection_it_tells_dropped_hears_nothing_more_has_nothing_to_take_away_and_asks_anew()
 {
    let fixture = ClientFixture::new();
    let heard = Heard::default();
    let dropped = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&dropped);
    fixture
        .manager
        .on_dropped(Arc::new(move |procedure, failure| {
            locked(&hearing).push((procedure.clone(), failure.map(Failure::record)));
        }));
    let unsubscribed = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&unsubscribed);
    let mut dependencies = NotificationDependencies::of((TextCodec, TextCodec, TextCodec));
    dependencies.unsubscribe = Some(Arc::new(move |_, response| {
        locked(&hearing).push(response);
        Box::pin(async { Ok(()) })
    }));
    let notification = fixture
        .manager
        .get_notification(&procedure(), dependencies)
        .expect("declared");
    let registration = subscribed(&fixture, (&notification, callback(&heard, "first "))).await;
    fixture.transport.close_connection();
    fixture.clock.settle().await;
    registration
        .unregister()
        .await
        .expect("the dropped registration has nothing to remove");
    assert_eq!(*locked(&dropped), [(procedure(), None)]);
    assert_eq!(*locked(&unsubscribed), Vec::<String>::new());
    assert_eq!(fixture.transport.sent().len(), 1);
    let _registration = subscribed(&fixture, (&notification, callback(&heard, "second "))).await;
    deliver(&fixture, (3, "news"));
    fixture.clock.settle().await;
    assert_eq!(*locked(&heard), ["second news"]);
    assert_eq!(requests(&fixture).len(), 2);
    let failure =
        Failure::protocol(ProtocolCode::CAPACITY_EXCEEDED, RouterSide::Server).saying("queued");
    fixture.transport.deliver(&Envelope::Failure {
        header: FailureHeader {
            call_id: 3,
            credential: None,
        },
        failure: failure.record(),
    });
    fixture.clock.settle().await;
    assert_eq!(
        *locked(&dropped),
        [(procedure(), None), (procedure(), Some(failure.record()))]
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_registration_under_way_when_its_notification_is_dropped_fails_with_a_disconnect_error() {
    let fixture = ClientFixture::new();
    let notification = notification(&fixture);
    let heard = Heard::default();
    let mut registering = notification.on(
        ("s".to_owned(), callback(&heard, "")),
        RequestOptions::default(),
    );
    pending(&mut registering).await;
    fixture.clock.settle().await;
    fixture
        .router
        .unregister_notification((&notification.as_like(), false))
        .await;
    notification.as_like().drop_with(None);
    fixture.transport.deliver(&result(1, b"ok"));
    assert!(matches!(registering.await, Err(CallError::Disconnected(_))));
    deliver(&fixture, (1, "news"));
    fixture.clock.settle().await;
    assert_eq!(*locked(&heard), Vec::<String>::new());
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_registration_while_the_last_one_is_leaving_waits_for_it_then_registers_anew() {
    let fixture = ClientFixture::new();
    let (release, held) = oneshot::channel();
    let gate = Arc::new(Mutex::new(Some(held)));
    let mut dependencies = NotificationDependencies::of((TextCodec, TextCodec, TextCodec));
    dependencies.unsubscribe = Some(Arc::new(move |_, _| {
        let gate = locked(&gate).take().expect("one unsubscription held");
        Box::pin(async move {
            gate.await.expect("released");
            Ok(())
        })
    }));
    let notification = fixture
        .manager
        .get_notification(&procedure(), dependencies)
        .expect("declared");
    let leaving = subscribed(&fixture, (&notification, callback(&Heard::default(), ""))).await;
    let mut left = leaving.unregister();
    pending(&mut left).await;
    let heard = Heard::default();
    let mut joining = notification.on(
        ("s".to_owned(), callback(&heard, "")),
        RequestOptions::default(),
    );
    pending(&mut joining).await;
    fixture.clock.settle().await;
    assert_eq!(requests(&fixture).len(), 1);
    release.send(()).expect("the last callback waits");
    left.await.expect("left");
    pending(&mut joining).await;
    fixture.clock.settle().await;
    assert_eq!(requests(&fixture).len(), 2);
    fixture.transport.deliver(&result(3, b"s"));
    let _registration = joining.await.expect("joined anew");
    deliver(&fixture, (3, "news"));
    fixture.clock.settle().await;
    assert_eq!(*locked(&heard), ["news"]);
    fixture.router.dispose().await;
}
