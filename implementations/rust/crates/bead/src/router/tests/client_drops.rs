//! Notification drops report panics, clear reservations and keep registrations made by a drop.

use core::time::Duration;
use std::sync::Arc;

use bytes::Bytes;

use super::client::Notified;
use super::{Scripted, answered, failure_of, result_of};
use crate::UnregisterNotificationOptions;
use crate::constants::ProtocolCode;
use crate::failure::Failure;
use crate::identity::Procedure;
use crate::router::client::{NotificationLike, Settled};
use crate::router::types::{BoxFuture, RouterError};

struct Dropping {
    procedure: Procedure,
    drop: Box<dyn Fn() + Send + Sync>,
}

impl core::fmt::Debug for Dropping {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Dropping")
            .field("procedure", &self.procedure)
            .finish_non_exhaustive()
    }
}

impl NotificationLike for Dropping {
    fn procedure(&self) -> &Procedure {
        &self.procedure
    }
    fn drop_with(&self, _failure: Option<&Failure>) {
        (self.drop)();
    }
    fn trigger(&self, _payload: Bytes) -> Result<BoxFuture<Settled>, RouterError> {
        Ok(Box::pin(async { Vec::new() }))
    }
}

fn throwing() -> Arc<dyn NotificationLike> {
    Arc::new(Dropping {
        procedure: super::notifying(),
        drop: Box::new(|| {
            panic!("drop bug");
        }),
    })
}

#[tokio::test]
async fn a_drop_that_throws_when_a_failure_ends_its_subscription_is_reported() {
    let scripted = Scripted::new();
    let notification = throwing();
    let subscribing = scripted.subscribe((&notification, super::TIMEOUT)).await;
    scripted.transport.deliver(&result_of(1, None));
    answered(subscribing).await.expect("subscribed");
    scripted
        .transport
        .deliver(&failure_of(1, (ProtocolCode::SESSION_REQUIRED, None)));
    scripted.settle().await;
    assert_eq!(scripted.codes(), ["a listener panicked: drop bug"]);
}

#[tokio::test]
async fn clears_the_timers_of_its_reservations_with_the_connection() {
    let scripted = Scripted::new();
    let notification = Notified::new(None);
    let timeout = Duration::from_millis(20);
    let subscribing = scripted.subscribe((&notification.like(), timeout)).await;
    scripted.transport.deliver(&result_of(1, None));
    answered(subscribing).await.expect("subscribed");
    scripted.settle().await;
    assert_eq!(scripted.clock.dues(), Vec::<Duration>::new());
    scripted
        .router
        .unregister_notification(
            &notification.like(),
            &UnregisterNotificationOptions::default(),
        )
        .await;
    assert_eq!(scripted.clock.dues(), [timeout]);
    scripted.transport.close_connection();
    scripted.settle().await;
    assert_eq!(scripted.clock.dues(), Vec::<Duration>::new());
    assert!(!scripted.router.is_reserved(1).await);
}

#[tokio::test]
async fn drops_every_notification_though_one_of_them_throws_and_keeps_what_a_drop_registers_again()
{
    let scripted = Scripted::new();
    let again = Notified::new(None);
    let registering = Arc::clone(&again);
    let router = scripted.router.clone();
    let reregistering: Arc<dyn NotificationLike> = Arc::new(Dropping {
        procedure: Procedure {
            procedure_id: 7,
            ..super::notifying()
        },
        drop: Box::new(move || {
            router
                .register_notification(registering.like())
                .expect("registered by the drop");
        }),
    });
    scripted
        .router
        .register_notification(throwing())
        .expect("the throwing drop registered");
    scripted
        .router
        .register_notification(Arc::clone(&reregistering))
        .expect("the registering drop registered");
    scripted.transport.close_connection();
    scripted.settle().await;
    assert_eq!(scripted.codes(), ["a listener panicked: drop bug"]);
    assert!(scripted.router.has_notification(&again.like()));
    assert!(!scripted.router.has_notification(&reregistering));
}
