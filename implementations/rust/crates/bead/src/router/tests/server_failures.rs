//! A resolver's immediate throw, its future's failure, malformed bytes and a refused answer.

use std::sync::Arc;

use bytes::Bytes;

use super::locked;
use super::server::{Served, first, news, request_of, second, subscribing_of};
use crate::errors::ResolverError;
use crate::router::core::{Handler, ResolveFn};
use crate::router::server::RouterServerOptions;
use crate::router::types::{RouterError, TransportMessage};
use crate::testing::pair::echo;
use crate::testing::scripted::Sending;

fn handler(resolve: ResolveFn) -> Handler {
    Handler {
        resolve,
        admit: None,
        maximum_payload_bytes: None,
        forwards_credentials: false,
        notifies: false,
    }
}

#[tokio::test]
async fn requests_that_fail_in_their_resolver_or_do_not_read_are_reported_with_their_connection() {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served
        .router
        .register_resolver((
            &echo(),
            handler(Arc::new(|_| {
                Box::pin(async { Err(ResolverError::other(std::io::Error::other("rejected"))) })
            })),
        ))
        .expect("echo registered");
    served
        .router
        .register_resolver((
            &news(),
            Handler {
                notifies: true,
                ..handler(Arc::new(|_| {
                    panic!("thrown");
                }))
            },
        ))
        .expect("news registered");

    // The C# twin delivers one at a time: each asynchronous failure reaches its own connection.
    served
        .transport
        .deliver(&request_of((1, &echo(), "")), &first());
    served.settle().await;
    served.transport.deliver(&subscribing_of(1), &second());
    served.settle().await;
    // A TransportMessage holds bytes: a text value is excluded by its type.
    served.transport.deliver_message(
        &TransportMessage {
            data: Bytes::from_static(b"text"),
            ..TransportMessage::default()
        },
        &first(),
    );
    served.settle().await;
    let gone: Arc<dyn std::error::Error + Send + Sync> = Arc::new(std::io::Error::other("gone"));
    served.transport.send_as((
        &second(),
        Sending::Error(RouterError::Other(Arc::clone(&gone))),
    ));
    served.transport.deliver(
        &request_of((
            3,
            &crate::identity::Procedure {
                service_id: 99,
                ..echo()
            },
            "",
        )),
        &second(),
    );
    served.settle().await;
    assert_eq!(
        served.reported(),
        [
            "rejected first",
            "a resolver panicked: thrown second",
            "ENVELOPE_MALFORMED first",
            "gone second"
        ]
    );
    {
        let reported = locked(&served.reports);
        let RouterError::Other(error) = &reported[3].0 else {
            panic!("the transport's error")
        };
        assert!(
            Arc::ptr_eq(error, &gone),
            "the transport's very error is reported"
        );
        drop(reported);
    }
    assert_eq!(
        served.sent_since(),
        [
            "first failure 1 PROCEDURE_FAILED",
            "second failure 1 PROCEDURE_FAILED",
            "second failure 3 SERVICE_UNKNOWN",
        ]
    );
    served
        .router
        .owner()
        .run(|state| {
            assert!(
                !state.core.is_disposed(),
                "an application's throw affects its own call"
            );
        })
        .await
        .expect("the router runs on");
}
