//! Dropping established subscriptions announces a session's end and leaves a call in flight alone.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::server::{Served, first, header_of, news, second, subscribing_of};
use super::{locked, token};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope, FailureHeader, RequestHeader};
use crate::errors::ResolverError;
use crate::failure::Failure;
use crate::identity::Procedure;
use crate::managers::service::{ResolverDependencies, Response};
use crate::payloads::TextCodec;
use crate::router::server::RouterServerOptions;
use crate::router::types::{ConnectionHandle, RouterError};
use crate::testing::pair::echo;
use crate::testing::scripted::Sending;

fn resolve(served: &Served, (procedure, release): (&Procedure, Option<CancellationToken>)) {
    let procedure = Procedure {
        kind: Some(crate::constants::ProcedureKind::Notifies),
        ..procedure.clone()
    };
    served
        .services
        .get_notification_resolver(
            &procedure,
            (ResolverDependencies::of(TextCodec, TextCodec), TextCodec),
        )
        .expect("the notification resolved")
        .on(Arc::new(move |_, response: Response<TextCodec>| {
            let release = release.clone();
            Box::pin(async move {
                if let Some(release) = release {
                    response
                        .register_notification()
                        .await
                        .map_err(ResolverError::other)?;
                    release.cancelled().await;
                    response.result("late".to_owned()).await
                } else {
                    response.result("ok".to_owned()).await
                }
            })
        }))
        .expect("the notification registered");
}

async fn subscriptions(served: &Served) -> Vec<(ConnectionHandle, u32, u16)> {
    served
        .router
        .owner()
        .run(|state| {
            state
                .notifications
                .subscriptions(None)
                .into_iter()
                .map(|subscription| {
                    assert_eq!(subscription.procedure.service_id, 2);
                    (
                        subscription.connection_handle,
                        subscription.call_id,
                        subscription.procedure.procedure_id,
                    )
                })
                .collect()
        })
        .await
        .expect("the subscriptions read")
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the twin follows establishment, the session announcement, the call in flight and an unwritable ending"
)]
async fn drop_subscriptions_ends_each_established_subscription_with_a_failure_the_first_announcing_and_skips_a_call_in_flight()
 {
    let current = Arc::new(Mutex::new(Some(token())));
    let reading = Arc::clone(&current);
    let served = Served::new(&RouterServerOptions {
        session_token_of: Some(Arc::new(move |_| Ok(*locked(&reading)))),
        ..RouterServerOptions::default()
    });
    let other = Procedure {
        id: 7,
        name: "other".to_owned(),
        ..news()
    };
    let release = CancellationToken::new();
    resolve(&served, (&news(), None));
    resolve(&served, (&other, None));
    resolve(&served, (&echo(), Some(release.clone())));
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served.transport.deliver(&subscribing_of(1), &first());
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                opens_subscription: true,
                ..header_of((3, &other))
            },
            payload: Bytes::new(),
        },
        &first(),
    );
    served.transport.deliver(&subscribing_of(1), &second());
    served.settle().await;
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                opens_subscription: true,
                ..header_of((5, &echo()))
            },
            payload: Bytes::new(),
        },
        &first(),
    );
    served.settle().await;
    assert_eq!(
        served.sent_since(),
        [
            "first result 1 ok",
            "first result 3 ok",
            "second result 1 ok"
        ]
    );
    *locked(&current) = None;
    served
        .router
        .drop_subscriptions((
            first(),
            Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Server),
        ))
        .await;
    served.settle().await;
    let sent = served.transport.take();
    let expected = [
        FailureHeader {
            call_id: 1,
            credential: Some(Credential::None),
        },
        FailureHeader {
            call_id: 3,
            credential: None,
        },
    ];
    assert_eq!(sent.len(), expected.len());
    for ((handle, envelope), expected) in sent.iter().zip(&expected) {
        assert_eq!(*handle, first());
        let Envelope::Failure { header, failure } = envelope else {
            panic!("an established subscription ends with a failure")
        };
        assert_eq!(header, expected);
        assert_eq!(failure.code, ProtocolCode::SESSION_REQUIRED.get());
        assert_eq!(failure.detail, "");
    }
    assert_eq!(
        subscriptions(&served).await,
        [(first(), 5, 1), (second(), 1, 5)]
    );
    release.cancel();
    served.settle().await;
    assert_eq!(served.sent_since(), ["first result 5 late"]);
    let error: Arc<dyn std::error::Error + Send + Sync> = Arc::new(std::io::Error::other("gone"));
    served.transport.send_as((
        &second(),
        Sending::Error(RouterError::Other(Arc::clone(&error))),
    ));
    served
        .router
        .drop_subscriptions((
            second(),
            Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Server),
        ))
        .await;
    served.settle().await;
    assert_eq!(served.reported(), ["gone second"]);
    assert!(
        matches!(&locked(&served.reports)[0].0, RouterError::Other(reported) if Arc::ptr_eq(reported, &error))
    );
    assert_eq!(subscriptions(&served).await, [(first(), 5, 1)]);
}
