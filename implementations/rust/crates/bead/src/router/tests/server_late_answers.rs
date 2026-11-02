//! Late answers announce a replacement session, and failed answers undo their subscriptions.

use core::num::NonZeroU16;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::server::{Served, first, header_of, news, request_of, second};
use super::token;
use crate::envelope::{Credential, Envelope, RequestHeader};
use crate::errors::ResolverError;
use crate::managers::service::{ResolverDependencies, Response};
use crate::payloads::TextCodec;
use crate::router::server::RouterServerOptions;
use crate::testing::pair::echo;
use crate::testing::scripted::Sending;

#[tokio::test]
async fn requests_answered_after_their_connection_closed_send_nothing_so_the_handle_is_told_its_session_anew()
 {
    let served = Served::new(&RouterServerOptions {
        session_token_of: Some(Arc::new(|_| Ok(Some(token())))),
        ..RouterServerOptions::default()
    });
    let released = CancellationToken::new();
    let waiting = released.clone();
    served
        .services
        .get_request_resolver(&echo(), ResolverDependencies::of(TextCodec, TextCodec))
        .expect("echo resolved")
        .on(Arc::new(move |request, response: Response<TextCodec>| {
            let waiting = waiting.clone();
            Box::pin(async move {
                if request.payload == "late" {
                    waiting.cancelled().await;
                }
                response.result(format!("{}!", request.payload)).await
            })
        }))
        .expect("echo registered");
    served.transport.open(&first(), true);
    served
        .transport
        .deliver(&request_of((1, &echo(), "late")), &first());
    served.settle().await;
    served.transport.close_connection(&first());
    released.cancel();
    served.settle().await;
    assert_eq!(served.transport.take(), Vec::new());
    served
        .transport
        .deliver(&request_of((3, &echo(), "again")), &first());
    served.settle().await;
    let sent = served.transport.take();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, first());
    let Envelope::Result { header, payload } = &sent[0].1 else {
        panic!("the replacement's result")
    };
    assert_eq!(header.call_id, 3);
    assert_eq!(header.credential, Some(Credential::Opaque(token())));
    assert_eq!(payload.as_ref(), b"again!");
    assert_eq!(served.reported(), Vec::<String>::new());
}

async fn subscriptions(served: &Served) -> Vec<u32> {
    served
        .router
        .owner()
        .run(|state| {
            state
                .notifications
                .subscriptions(None)
                .into_iter()
                .map(|call| call.call_id)
                .collect()
        })
        .await
        .expect("subscriptions")
}

#[tokio::test]
async fn what_an_answer_subscribed_goes_with_it_when_it_is_a_failure_or_does_not_go_out() {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served
        .services
        .get_notification_resolver(
            &news(),
            (ResolverDependencies::of(TextCodec, TextCodec), TextCodec),
        )
        .expect("news resolved")
        .on(Arc::new(|request, response: Response<TextCodec>| {
            Box::pin(async move {
                if request.payload != "implicit" {
                    response
                        .register_notification()
                        .await
                        .map_err(ResolverError::other)?;
                }
                if request.payload == "refuse" {
                    response
                        .failure(&crate::failure::Failure::application(
                            NonZeroU16::new(1).expect("one"),
                            "",
                        ))
                        .await
                } else {
                    response.result("ok".to_owned()).await
                }
            })
        }))
        .expect("news registered");
    let deliver = |(call_id, handle, payload): (u32, _, &'static str)| {
        served.transport.deliver(
            &Envelope::Request {
                header: RequestHeader {
                    opens_subscription: true,
                    ..header_of((call_id, &news()))
                },
                payload: bytes::Bytes::from_static(payload.as_bytes()),
            },
            &handle,
        );
    };
    deliver((1, first(), "refuse"));
    served.settle().await;
    assert_eq!(subscriptions(&served).await, Vec::<u32>::new());
    served
        .transport
        .send_as((&second(), Sending::Thrown("gone".to_owned())));
    deliver((1, second(), "explicit"));
    served.settle().await;
    assert_eq!(subscriptions(&served).await, Vec::<u32>::new());
    deliver((3, second(), "implicit"));
    served.settle().await;
    assert_eq!(subscriptions(&served).await, Vec::<u32>::new());
    assert_eq!(served.reported(), ["gone second", "gone second"]);
}
