//! A notifier's registration, encoded values, subscriber filters and pacing keys.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{Fixture, Recording, header, locked, props};
use crate::clock::SharedClock;
use crate::debug::{DebugDirection, DebugType};
use crate::envelope::{CreditHeader, Envelope, RequestHeader};
use crate::errors::{CallError, ResolverError};
use crate::identity::Procedure;
use crate::managers::notification::NotificationKey;
use crate::managers::service::{
    Notifier, NotifyOptions, ResolverDependencies, ServiceManager, ServiceManagerOptions,
    ServiceRouter, Subscriber, filter_of,
};
use crate::payloads::TextCodec;
use crate::router::types::SessionIdentifier;
use crate::testing::pair::echo;
use crate::testing::{SteppingClock, instants};

fn news() -> Procedure {
    Procedure {
        id: 2,
        name: "news".to_owned(),
        kind: Some(crate::constants::ProcedureKind::Notifies),
        ..echo()
    }
}

fn notifier(fixture: &Fixture) -> Notifier<TextCodec> {
    fixture
        .manager
        .get_notification_resolver(
            &news(),
            (ResolverDependencies::of(TextCodec, TextCodec), TextCodec),
        )
        .expect("defined")
        .on(Arc::new(|request, response| {
            response.result(request.payload)
        }))
        .expect("registered")
}

async fn subscribe(fixture: &Fixture, paced: bool) {
    fixture.transport.open(&Arc::from("a"), true);
    fixture.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                procedure_id: 2,
                opens_subscription: true,
                paced,
                ..header()
            },
            payload: Bytes::from_static(b"subscribe"),
        },
        &Arc::from("a"),
    );
    fixture.clock.settle().await;
    assert!(
        matches!(&fixture.transport.take()[0].1, Envelope::Result { header, .. } if header.call_id == 7)
    );
}

#[tokio::test]
async fn runs_on_its_routers_clock_and_refuses_another() {
    let fixture = Fixture::new();
    let own = fixture.router.clock();
    let manager = ServiceManager::new(
        ServiceRouter::Server(fixture.router.clone()),
        &ServiceManagerOptions {
            clock: Some(Arc::clone(&own)),
            ..ServiceManagerOptions::default()
        },
    )
    .expect("its router's clock");
    assert!(Arc::ptr_eq(&manager.inner.clock, &own));
    let another: SharedClock = SteppingClock::new(instants::new_year());
    let error = ServiceManager::new(
        ServiceRouter::Server(fixture.router.clone()),
        &ServiceManagerOptions {
            clock: Some(another),
            ..ServiceManagerOptions::default()
        },
    )
    .expect_err("another clock");
    assert!(error.message().contains("clock"));
    assert!(Arc::ptr_eq(&fixture.manager.inner.clock, &own));
    fixture.router.dispose().await;
}

#[tokio::test]
async fn registers_its_resolver_with_its_notify_for_its_router_to_declare_it_as_the_side_that_notifies()
 {
    let fixture = Fixture::new();
    fixture
        .manager
        .get_request_resolver(&echo(), ResolverDependencies::of(TextCodec, TextCodec))
        .expect("defined")
        .on(Arc::new(|_, _| Box::pin(async { Ok(()) })))
        .expect("registered");
    let _notifier = notifier(&fixture);
    fixture
        .router
        .owner()
        .run(|state| {
            let resolvers = locked(&state.core.resolvers);
            assert!(!resolvers[&(2, 1)].handler.notifies);
            assert!(resolvers[&(2, 2)].handler.notifies);
            drop(resolvers);
        })
        .await
        .expect("both registered");
    fixture.router.dispose().await;
}

#[tokio::test]
async fn notifies_through_the_router_with_the_encoded_notification() {
    let fixture = Fixture::new();
    let notifier = notifier(&fixture);
    subscribe(&fixture, false).await;
    notifier
        .notify("news é".to_owned(), &NotifyOptions::default())
        .await;
    fixture.clock.settle().await;
    let sent = fixture.transport.take();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0.as_ref(), "a");
    assert!(
        matches!(&sent[0].1, Envelope::Notification { header, payload }
        if header.call_id == 7 && payload.as_ref() == "news é".as_bytes())
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn its_callback_may_subscribe_the_requester_before_answering_and_is_given_the_call_id_not_after()
 {
    let fixture = Fixture::new();
    let recording = Arc::new(Recording::default());
    let resolver = super::resolver::resolving(
        &fixture,
        Arc::new(|_, response| {
            Box::pin(async move {
                let call_id = response
                    .register_notification()
                    .await
                    .map_err(ResolverError::other)?;
                assert_eq!(call_id, 7);
                response.result(call_id.to_string()).await?;
                assert!(matches!(
                    response.register_notification().await,
                    Err(CallError::Refused(_))
                ));
                Ok(())
            })
        }),
    );
    resolver
        .resolve(props(&recording, b"subscribe"))
        .await
        .expect("resolved");
    assert_eq!(
        recording.answers(),
        [crate::router::types::RouterAnswer::Result(
            Bytes::from_static(b"7")
        )]
    );
    assert_eq!(*locked(&recording.subscriptions), 1);
}

#[test]
fn tells_the_router_whom_its_options_keep_none_excluded_and_those_the_filter_keeps() {
    let options = [
        NotifyOptions::default(),
        NotifyOptions {
            exclude: Some(Arc::from("b")),
            ..NotifyOptions::default()
        },
        NotifyOptions {
            filter: Some(Arc::new(|subscriber| {
                subscriber.connection_handle.as_ref() != "a"
            })),
            ..NotifyOptions::default()
        },
        NotifyOptions {
            exclude: Some(Arc::from("c")),
            filter: Some(Arc::new(|subscriber| {
                subscriber.connection_handle.as_ref() != "a"
            })),
            ..NotifyOptions::default()
        },
    ];
    let kept: Vec<Vec<&str>> = options
        .iter()
        .map(|options| {
            let filter = filter_of(options);
            ["a", "b", "c"]
                .into_iter()
                .filter(|handle| {
                    filter
                        .as_ref()
                        .is_none_or(|filter| filter(&Arc::from(*handle), None))
                })
                .collect()
        })
        .collect();
    assert!(filter_of(&options[0]).is_none());
    assert_eq!(
        kept,
        [
            vec!["a", "b", "c"],
            vec!["a", "c"],
            vec!["b", "c"],
            vec!["b"]
        ]
    );
}

#[test]
fn hands_the_filter_one_subscriber_its_connection_and_its_sessions_identifier() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&seen);
    let filter = filter_of(&NotifyOptions {
        exclude: Some(Arc::from("b")),
        filter: Some(Arc::new(move |subscriber| {
            locked(&hearing).push(subscriber.clone());
            subscriber.identifier.is_some()
        })),
        ..NotifyOptions::default()
    })
    .expect("a filter");
    let grace = SessionIdentifier::Elsewhere {
        id: "grace".to_owned(),
    };
    assert_eq!(
        [
            filter(&Arc::from("a"), Some(&grace)),
            filter(&Arc::from("a"), None),
            filter(&Arc::from("b"), Some(&grace)),
        ],
        [true, false, false]
    );
    assert_eq!(
        *locked(&seen),
        [
            Subscriber {
                connection_handle: Arc::from("a"),
                identifier: Some(grace)
            },
            Subscriber {
                connection_handle: Arc::from("a"),
                identifier: None
            },
        ]
    );
}

#[tokio::test]
async fn tells_the_router_what_a_notification_is_about_for_a_paced_subscription_to_keep_its_latest()
{
    let fixture = Fixture::new();
    let notifier = notifier(&fixture);
    subscribe(&fixture, true).await;
    for (value, key) in [
        ("first", None),
        ("old number", Some(NotificationKey::Number(7))),
        ("old text", Some(NotificationKey::Text("seven".to_owned()))),
        ("number", Some(NotificationKey::Number(7))),
        ("text", Some(NotificationKey::Text("seven".to_owned()))),
    ] {
        notifier
            .notify(
                value.to_owned(),
                &NotifyOptions {
                    key,
                    ..NotifyOptions::default()
                },
            )
            .await;
    }
    fixture.clock.settle().await;
    let first = fixture.transport.take();
    assert_eq!(first.len(), 1);
    assert!(
        matches!(&first[0].1, Envelope::Notification { payload, .. } if payload.as_ref() == b"first")
    );
    assert_eq!(
        fixture.router.gauges().await.counts["queuedNotifications"],
        2
    );
    fixture.transport.deliver(
        &Envelope::Credit {
            header: CreditHeader {
                call_id: 7,
                credit_end: 3,
                paced: true,
            },
        },
        &Arc::from("a"),
    );
    fixture.clock.settle().await;
    let sent = fixture.transport.take();
    assert_eq!(sent.len(), 2);
    let values: Vec<Bytes> = sent
        .into_iter()
        .map(|(_, envelope)| {
            let Envelope::Notification { header, payload } = envelope else {
                panic!("a notification")
            };
            assert_eq!(header.call_id, 7);
            payload
        })
        .collect();
    assert_eq!(
        values,
        [Bytes::from_static(b"number"), Bytes::from_static(b"text")]
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_failed_notify_resolves_all_the_same_and_only_debug_hears_of_it() {
    let fixture = Fixture::new();
    let notifier = notifier(&fixture);
    let heard = fixture.heard();
    let reported = Arc::new(Mutex::new(Vec::new()));
    let reporting = Arc::clone(&reported);
    fixture.router.on_error(Arc::new(move |error, _| {
        locked(&reporting).push(error.to_string());
    }));
    subscribe(&fixture, false).await;
    locked(&heard).clear();
    notifier
        .notify(
            "news".to_owned(),
            &NotifyOptions {
                filter: Some(Arc::new(|_| panic!("gone"))),
                ..NotifyOptions::default()
            },
        )
        .await;
    fixture.clock.settle().await;
    assert_eq!(fixture.transport.take(), Vec::new());
    assert!(locked(&reported).is_empty());
    let heard = locked(&heard).clone();
    assert_eq!(heard.len(), 2);
    assert!(heard[0].0.is_none());
    assert!(heard[1].0.as_ref().expect("why").contains("gone"));
    for (_, event) in &heard {
        assert_eq!(
            (event.direction, event.call_type, event.duration),
            (DebugDirection::Tx, DebugType::Notification, None)
        );
        assert_eq!(event.started_at, heard[0].1.started_at);
    }
    fixture.router.dispose().await;
}
