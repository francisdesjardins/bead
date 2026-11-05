//! A connection's subscriptions, one per session and procedure, and their filter's public view.

use std::sync::{Arc, Mutex};

use super::locked;
use super::server::{Served, first, news, subscribing_of};
use crate::NotificationResolverDependencies;
use crate::credentials::{Credentials, ElsewhereSession};
use crate::envelope::{Credential, Envelope};
use crate::managers::service::{
    Notifier, NotifyOptions, RequestResolverDependencies, Response, Subscriber,
};
use crate::payloads::TextCodec;
use crate::router::server::RouterServerOptions;
use crate::router::types::{SessionIdentifier, TransportMessage};
use crate::testing::scripted::bytes_of;

fn serving() -> (Served, Notifier<TextCodec>) {
    let served = Served::new(&RouterServerOptions {
        credentials: Some(Credentials {
            verify: Some(Arc::new(|carried, _| {
                Box::pin(async move {
                    Ok(Some(ElsewhereSession {
                        id: carried,
                        data: None,
                        end: None,
                    }))
                })
            })),
            ..Credentials::default()
        }),
        ..RouterServerOptions::default()
    });
    served.transport.open(&first(), true);
    let notifier = served
        .services
        .get_notification_resolver(
            &news(),
            NotificationResolverDependencies::new(
                RequestResolverDependencies::new(TextCodec, TextCodec),
                TextCodec,
            ),
        )
        .expect("news resolved")
        .on(Arc::new(|_, response: Response<TextCodec>| {
            response.result("subscribed".to_owned())
        }))
        .expect("news registered");
    (served, notifier)
}

fn subscribe(served: &Served, (call_id, carried): (u32, Option<&str>)) {
    let Envelope::Request {
        mut header,
        payload,
    } = subscribing_of(call_id)
    else {
        panic!("a subscribing request")
    };
    header.credential = carried.map(|_| Credential::Elsewhere);
    served.transport.deliver_message(
        &TransportMessage {
            data: bytes_of(&Envelope::Request { header, payload }),
            credential: carried.map(str::to_owned),
            ..TransportMessage::default()
        },
        &first(),
    );
}

#[tokio::test]
async fn hands_the_filter_one_subscriber_its_connection_and_its_sessions_identifier() {
    let (served, notifier) = serving();
    subscribe(&served, (1, None));
    subscribe(&served, (3, Some("ada")));
    served.settle().await;
    served.sent_since();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seeing = Arc::clone(&seen);
    notifier
        .notify(
            "to none".to_owned(),
            &NotifyOptions {
                filter: Some(Arc::new(move |subscriber| {
                    locked(&seeing).push(subscriber.clone());
                    false
                })),
                ..NotifyOptions::default()
            },
        )
        .await;
    served.settle().await;
    assert_eq!(
        *locked(&seen),
        [
            Subscriber {
                connection_handle: first(),
                identifier: None
            },
            Subscriber {
                connection_handle: first(),
                identifier: Some(SessionIdentifier::Elsewhere {
                    id: "ada".to_owned()
                })
            },
        ]
    );
    assert_eq!(served.sent_since(), Vec::<String>::new());
    assert_eq!(served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn holds_one_subscription_a_procedure_per_session_of_a_connection_its_connections_and_each_credentials_each_notified_alone_and_ends_a_credentials_by_its_identifier()
 {
    let (served, notifier) = serving();
    for call in [
        (1, None),
        (3, Some("ada")),
        (5, Some("bob")),
        (7, Some("ada")),
    ] {
        subscribe(&served, call);
    }
    served.settle().await;
    assert_eq!(
        served.sent_since(),
        [
            "first result 1 subscribed",
            "first result 3 subscribed",
            "first result 5 subscribed",
            "first result 7 subscribed",
        ]
    );
    notifier.notify("to ada".to_owned(), &NotifyOptions {
        filter: Some(Arc::new(|subscriber| matches!(&subscriber.identifier, Some(SessionIdentifier::Elsewhere { id }) if id == "ada"))),
        ..NotifyOptions::default()
    }).await;
    notifier
        .notify("to all".to_owned(), &NotifyOptions::default())
        .await;
    for _ in 0..2 {
        served
            .router
            .end_session(SessionIdentifier::Elsewhere {
                id: "bob".to_owned(),
            })
            .await;
    }
    served.settle().await;
    assert_eq!(
        served.sent_since(),
        [
            "first notification 3 to ada",
            "first notification 1 to all",
            "first notification 3 to all",
            "first notification 5 to all",
            "first failure 5 SESSION_REQUIRED",
        ]
    );
    served
        .router
        .owner()
        .run(|state| {
            assert_eq!(
                state
                    .notifications
                    .subscriptions(None)
                    .into_iter()
                    .map(|subscription| (subscription.call_id, subscription.identifier))
                    .collect::<Vec<_>>(),
                [
                    (1, None),
                    (
                        3,
                        Some(SessionIdentifier::Elsewhere {
                            id: "ada".to_owned()
                        })
                    ),
                ]
            );
        })
        .await
        .expect("the remaining subscriptions");
    assert_eq!(served.reported(), Vec::<String>::new());
    assert_eq!(served.clock.dues(), Vec::<core::time::Duration>::new());
}
