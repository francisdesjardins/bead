//! A subscribing request names the very procedure its held notification belongs to.

use bytes::Bytes;

use super::client::Notified;
use super::{Scripted, TIMEOUT, request_of};

#[tokio::test]
async fn binds_no_notification_the_router_does_not_hold_for_the_procedure() {
    let scripted = Scripted::new();
    let held = Notified::new(None);
    scripted
        .router
        .request(Bytes::new(), request_of((Some(held.like()), TIMEOUT)))
        .expect_err("the notification is not held");
    scripted
        .router
        .register_notification(held.like())
        .expect("registered");
    scripted
        .router
        .request(
            Bytes::new(),
            request_of((Some(Notified::new(None).like()), TIMEOUT)),
        )
        .expect_err("another notification of the procedure is not held");
    let mut mismatch = request_of((Some(held.like()), TIMEOUT));
    mismatch.procedure.procedure_id = 9;
    scripted
        .router
        .request(Bytes::new(), mismatch)
        .expect_err("the notification belongs to another procedure");
    scripted.settle().await;
    assert_eq!(scripted.transport.sent().len(), 0);
}

#[tokio::test]
async fn keeps_a_notification_refused_by_its_registry_unregistered_and_accepts_the_declared_procedure_afterward()
 {
    use crate::UnregisterNotificationOptions;
    use crate::identity::Procedure;
    use crate::metrics::{MetricsRegistry, MetricsRegistryOptions};
    use crate::router::client::RouterClientOptions;
    use std::sync::Arc;

    let echo = super::notifying();
    for (procedure, detail) in [
        (
            Procedure {
                procedure_name: "other".to_owned(),
                ..echo.clone()
            },
            "the metrics registry holds 2/1 as \"echo\", and is given \"other\": another name at its address",
        ),
        (
            Procedure {
                procedure_id: 2,
                ..echo.clone()
            },
            "the metrics registry holds \"echo\" at 2/1, and is given \"echo\" at 2/2: its name at another address",
        ),
        (
            Procedure {
                procedure_id: 2,
                procedure_name: "other".to_owned(),
                ..echo.clone()
            },
            "the metrics registry's notification families name 1 procedures at most, and 2/2 is one more: past the ceiling",
        ),
    ] {
        let registry = MetricsRegistry::new(&MetricsRegistryOptions {
            maximum_procedures: Some(1),
            ..MetricsRegistryOptions::default()
        })
        .expect("a registry for one procedure");
        let options = RouterClientOptions {
            metrics_registry: Some(registry.clone()),
            ..RouterClientOptions::default()
        };
        let declaring = Scripted::with(&options);
        let held = Notified::new(None).like();
        declaring
            .router
            .register_notification(Arc::clone(&held))
            .expect("declared");
        let scripted = Scripted::with(&options);
        let before = registry.exposition().text;
        let rejected = Notified::of(procedure).like();
        assert_eq!(
            scripted
                .router
                .register_notification(Arc::clone(&rejected))
                .expect_err("refused")
                .to_string(),
            detail
        );
        assert!(!scripted.router.has_notification(&rejected));
        assert!(declaring.router.has_notification(&held));
        assert_eq!(registry.exposition().text, before);
        assert_eq!(
            scripted.transport.sent(),
            Vec::<crate::router::types::TransportMessage>::new()
        );
        let accepted = Notified::new(None);
        let like = accepted.like();
        scripted
            .router
            .register_notification(Arc::clone(&like))
            .expect("accepted");
        assert!(scripted.router.has_notification(&like));
        let subscribing = scripted
            .router
            .request(Bytes::new(), request_of((Some(Arc::clone(&like)), TIMEOUT)))
            .expect("subscribing");
        scripted.settle().await;
        scripted.transport.deliver(&super::result_of(1, None));
        super::answered(subscribing).await.expect("subscribed");
        scripted.transport.deliver(&super::notification_of(1, 5));
        scripted.settle().await;
        assert_eq!(accepted.triggered(), [5]);
        assert!(super::metrics::counts_of(&registry).contains(
            &"bead_notifications_heard_total{service=\"2\",procedure=\"echo\"} 1".to_owned()
        ));
        scripted
            .router
            .unregister_notification(&like, &UnregisterNotificationOptions::default())
            .await;
        scripted.settle().await;
        assert!(!scripted.router.has_notification(&like));
        assert!(declaring.router.has_notification(&held));
        assert_eq!(scripted.codes(), Vec::<String>::new());
        assert_eq!(
            declaring.transport.sent(),
            Vec::<crate::router::types::TransportMessage>::new()
        );
        scripted.router.dispose().await;
        declaring.router.dispose().await;
    }
}
