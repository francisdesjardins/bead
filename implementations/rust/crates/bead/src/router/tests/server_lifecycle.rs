//! A server's disposal releases its transport; its trace holds no token and owns its header.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::server::{Served, first, header_of, news, request_of, subscribing_of};
use super::{answered, locked, options_of, token};
use crate::constants::CredentialScheme;
use crate::debug::DebugDirection;
use crate::envelope::{Credential, Envelope, Header, RequestHeader, ResultHeader};
use crate::errors::CallError;
use crate::managers::service::{NotifyOptions, ResolverDependencies, Response};
use crate::payloads::TextCodec;
use crate::router::server::{CallHooks, RouterServerOptions, ServerRequest};
use crate::testing::pair::echo;

#[tokio::test]
async fn dispose_lets_go_of_the_transport_rejects_what_waits_forgets_every_connection_and_sends_nothing_more()
 {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    let notifier = served.news();
    let late_subscription = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&late_subscription);
    let other = crate::identity::Procedure {
        id: 7,
        name: "other".to_owned(),
        ..news()
    };
    served
        .services
        .get_notification_resolver(
            &other,
            (ResolverDependencies::of(TextCodec, TextCodec), TextCodec),
        )
        .expect("other resolved")
        .on(Arc::new(move |request, response: Response<TextCodec>| {
            let hearing = Arc::clone(&hearing);
            Box::pin(async move {
                request.signal.token().cancelled().await;
                let outcome = response.register_notification().await;
                locked(&hearing).push(outcome);
                Ok(())
            })
        }))
        .expect("other registered");
    served.transport.deliver(&subscribing_of(1), &first());
    served.settle().await;
    assert_eq!(served.sent_since(), ["first result 1 ok"]);
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                opens_subscription: true,
                ..header_of((5, &other))
            },
            payload: Bytes::new(),
        },
        &first(),
    );
    let mut options = options_of(super::TIMEOUT);
    options.connection_handle = Some(first());
    let request = ServerRequest {
        procedure: echo().address(),
        maximum_payload_bytes: None,
        options,
        series: None,
        refusal: None,
    };
    let waiting = served
        .router
        .request(Bytes::new(), (request.clone(), CallHooks::default()))
        .expect("a command waits");
    served.settle().await;
    assert_eq!(served.sent_since(), ["first request 2 "]);
    assert_eq!(served.transport.listener_count(), 1);
    served.router.dispose().await;
    assert!(matches!(
        answered(waiting).await,
        Err(CallError::Disconnected(_))
    ));
    assert_eq!(served.transport.listener_count(), 0);
    served
        .router
        .owner()
        .run(|state| {
            assert_eq!(state.notifications.subscriptions(None), Vec::new());
            assert!(state.connections.is_empty());
            assert!(state.core.is_disposed());
        })
        .await
        .expect("nothing held");
    served.transport.deliver(&subscribing_of(3), &first());
    notifier
        .notify("flash".to_owned(), &NotifyOptions::default())
        .await;
    let after = served
        .router
        .request(Bytes::new(), (request, CallHooks::default()))
        .expect("a disposed call has its failure");
    assert!(matches!(
        answered(after).await,
        Err(CallError::Disconnected(_))
    ));
    served.settle().await;
    assert!(matches!(
        locked(&late_subscription).as_slice(),
        [Err(CallError::Disconnected(_))]
    ));
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(served.reported(), Vec::<String>::new());
    assert_eq!(served.clock.dues(), Vec::<core::time::Duration>::new());
}

#[tokio::test]
async fn tells_debug_each_envelope_with_its_connection_and_a_copy_of_its_header_without_its_token()
{
    let served = Served::new(&RouterServerOptions {
        session_token_of: Some(Arc::new(|_| Ok(Some(token())))),
        ..RouterServerOptions::default()
    });
    served
        .services
        .get_request_resolver(&echo(), ResolverDependencies::of(TextCodec, TextCodec))
        .expect("echo resolved")
        .on(Arc::new(|_, response: Response<TextCodec>| {
            response.result("ok".to_owned())
        }))
        .expect("echo registered");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seeing = Arc::clone(&seen);
    served.router.on_debug(Arc::new(move |direction, envelope| {
        locked(&seeing).push((direction, envelope.clone()));
        // A listener owns only its copy; its change cannot reach the envelope sent.
        let mut changed = envelope.clone();
        match &mut changed.header {
            Header::Request(header) => header.call_id = 0,
            Header::Result(header) => header.call_id = 0,
            Header::Failure(_)
            | Header::Notification(_)
            | Header::Chunk(_)
            | Header::Credit(_)
            | Header::Cancel(_) => panic!("the request and its result alone"),
        }
        assert_eq!(changed.header.call_id(), 0);
    }));
    served
        .transport
        .deliver(&request_of((9, &echo(), "")), &first());
    served.settle().await;
    let seen = locked(&seen).clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].0, DebugDirection::Rx);
    assert_eq!(seen[0].1.connection_handle, first());
    assert_eq!(seen[0].1.header, Header::Request(header_of((9, &echo()))));
    assert_eq!(seen[0].1.credential_scheme, None);
    assert_eq!(seen[1].0, DebugDirection::Tx);
    assert_eq!(seen[1].1.connection_handle, first());
    assert_eq!(
        seen[1].1.header,
        Header::Result(ResultHeader {
            call_id: 9,
            total: None,
            credential: None
        })
    );
    assert_eq!(seen[1].1.credential_scheme, Some(CredentialScheme::OPAQUE));
    assert_eq!(
        served.transport.take(),
        [(
            first(),
            Envelope::Result {
                header: ResultHeader {
                    call_id: 9,
                    total: None,
                    credential: Some(Credential::Opaque(token()))
                },
                payload: Bytes::from_static(b"ok"),
            }
        )]
    );
    assert!(!format!("{seen:?}").contains(&token().to_string()));
    assert_eq!(served.reported(), Vec::<String>::new());
    served.router.dispose().await;
}
