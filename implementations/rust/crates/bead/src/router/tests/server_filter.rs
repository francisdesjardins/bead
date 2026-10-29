//! A notification's filter is settled for every candidate before any envelope goes out. Its
//! failure reaches the caller of the router and the service manager's trace.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::locked;
use super::server::{Served, first, news, second, subscribing_of};
use crate::managers::service::NotifyOptions;
use crate::router::server::RouterServerOptions;

// spec 11.7
#[tokio::test]
async fn notify_sends_to_none_when_its_filter_throws_on_any() {
    let served = Served::new(&RouterServerOptions::default());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seeing = Arc::clone(&seen);
    served.services.on_debug(Arc::new(move |error, _| {
        locked(&seeing).push(error.map(ToString::to_string));
    }));
    let notifier = served.news();
    for handle in [first(), second()] {
        served.transport.open(&handle, true);
        served.transport.deliver(&subscribing_of(1), &handle);
    }
    served.settle().await;
    served.sent_since();
    for failing in [first(), second()] {
        locked(&seen).clear();
        let fails = Arc::clone(&failing);
        let options = NotifyOptions {
            filter: Some(Arc::new(move |subscriber| {
                assert!(subscriber.connection_handle != fails, "no such user");
                true
            })),
            ..NotifyOptions::default()
        };
        notifier.notify("flash".to_owned(), &options).await;
        served.settle().await;
        assert_eq!(
            served.transport.take(),
            Vec::new(),
            "a filter failure prevents every send"
        );
        assert_eq!(
            *locked(&seen),
            [
                None,
                Some("a notification filter panicked: no such user".to_owned())
            ]
        );

        let error = served
            .router
            .notify(
                Ok(Bytes::from_static(b"flash")),
                (
                    news().address(),
                    Some(Arc::new(move |handle, _| {
                        assert!(*handle != failing, "no such user");
                        true
                    })),
                    None,
                ),
            )
            .await
            .expect_err("the router gives its caller the failure");
        assert_eq!(
            error.to_string(),
            "a notification filter panicked: no such user"
        );
        assert_eq!(served.transport.take(), Vec::new());
        assert_eq!(served.reported(), Vec::<String>::new());
    }
    notifier
        .notify("flash".to_owned(), &NotifyOptions::default())
        .await;
    served.settle().await;
    assert_eq!(
        served.sent_since(),
        ["first notification 1 flash", "second notification 1 flash"]
    );
}
