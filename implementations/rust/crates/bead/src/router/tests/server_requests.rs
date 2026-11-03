//! A server's requests: its transport, admissions before decoding, routing refusals, and the
//! connection and parity of each incoming call.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::server::{Served, first, news, request_of, second, subscribing_of};
use super::{locked, result_of};
use crate::NotificationResolverDependencies;
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Envelope, NotificationHeader, RequestHeader};
use crate::managers::service::{RequestResolverDependencies, Response};
use crate::payloads::{CodecRefusal, PayloadCodec, TextCodec};
use crate::router::admissions::BeforeRequest;
use crate::router::core::Handler;
use crate::router::server::RouterServerOptions;
use crate::router::types::TransportMessage;
use crate::testing::pair::echo;

// A refused request is deliberately unreadable: the decode history proves its admission comes
// first, rather than merely obtaining the same refusal from another stage.
#[derive(Debug)]
struct NonEmptyText(Arc<Mutex<Vec<Bytes>>>);

impl PayloadCodec for NonEmptyText {
    type Value = String;

    fn decode(&self, bytes: &Bytes) -> Result<String, CodecRefusal> {
        locked(&self.0).push(bytes.clone());
        if bytes.is_empty() {
            return Err(CodecRefusal::new("no text"));
        }
        TextCodec.decode(bytes)
    }

    fn encode(&self, value: &String) -> Result<Bytes, CodecRefusal> {
        TextCodec.encode(value)
    }

    fn encoding(&self) -> &'static str {
        "text"
    }
}

fn idle() -> Handler {
    Handler {
        resolve: Arc::new(|_| Box::pin(async { Ok(()) })),
        admit: None,
        maximum_payload_bytes: None,
        forwards_credentials: false,
        notifies: false,
    }
}

#[tokio::test]
async fn takes_this_packages_transport_server() {
    let served = Served::new(&RouterServerOptions::default());
    let transport: Arc<dyn crate::transport::ServerTransport> =
        Arc::<crate::testing::scripted::ScriptedServer>::clone(&served.transport);
    assert!(Arc::ptr_eq(&served.router.transport(), &transport));
    served
        .router
        .owner()
        .run(|state| {
            assert_eq!(state.core.side, RouterSide::Server);
            assert_eq!(state.notifications.subscriptions(None), Vec::new());
        })
        .await
        .expect("the router starts without a subscription");
    assert_eq!(
        served.router.gauges().await.counts["notifiedSubscriptions"],
        0
    );
}

// spec 9.2, 13.5
#[tokio::test]
async fn requests_are_asked_their_admission_once_on_their_header_before_their_payload_is_read() {
    let served = Served::new(&RouterServerOptions::default());
    let asked = Arc::new(Mutex::new(Vec::new()));
    let asking = Arc::clone(&asked);
    let decoded = Arc::default();
    let mut dependencies =
        RequestResolverDependencies::new(NonEmptyText(Arc::clone(&decoded)), TextCodec);
    dependencies.before_request = Some(BeforeRequest::new(
        move |request| {
            locked(&asking).push((
                Arc::clone(&request.connection_handle),
                request.header.clone(),
            ));
            request.header.call_id == 31
        },
        None,
    ));
    served
        .services
        .get_request_resolver(&echo(), dependencies)
        .expect("echo resolved")
        .on(Arc::new(|request, response: Response<TextCodec>| {
            response.result(format!("{}!", request.payload))
        }))
        .expect("echo registered");
    served
        .transport
        .deliver(&request_of((31, &echo(), "hi")), &first());
    served.settle().await;
    served
        .transport
        .deliver(&request_of((33, &echo(), "")), &first());
    served.settle().await;
    assert_eq!(
        *locked(&asked),
        [
            (first(), super::server::header_of((31, &echo()))),
            (first(), super::server::header_of((33, &echo())))
        ]
    );
    assert_eq!(*locked(&decoded), [Bytes::from_static(b"hi")]);
    assert_eq!(
        served.sent_since(),
        ["first result 31 hi!", "first failure 33 ACCESS_DENIED"]
    );
    assert_eq!(served.reported(), Vec::<String>::new());
}

// spec 9.2, 13.5
#[tokio::test]
async fn requests_refused_their_admission_never_reach_a_callback_which_would_subscribe_a_plain_request()
 {
    let served = Served::new(&RouterServerOptions::default());
    let reached = Arc::new(Mutex::new(Vec::new()));
    let reaching = Arc::clone(&reached);
    let mut dependencies = RequestResolverDependencies::new(TextCodec, TextCodec);
    dependencies.before_request = Some(BeforeRequest::new(|_| false, None));
    served
        .services
        .get_notification_resolver(
            &news(),
            NotificationResolverDependencies::new(dependencies, TextCodec),
        )
        .expect("news resolved")
        .on(Arc::new(move |request, response: Response<TextCodec>| {
            locked(&reaching).push(request.payload);
            Box::pin(async move {
                response
                    .register_notification()
                    .await
                    .map_err(|error| crate::errors::ResolverError::Other(Box::new(error)))?;
                response.result("ok".to_owned()).await
            })
        }))
        .expect("news registered");
    served
        .transport
        .deliver(&request_of((31, &news(), "hi")), &first());
    served.settle().await;
    assert!(locked(&reached).is_empty());
    assert_eq!(served.sent_since(), ["first failure 31 ACCESS_DENIED"]);
    assert_eq!(served.reported(), Vec::<String>::new());
    served
        .router
        .owner()
        .run(|state| {
            assert_eq!(state.notifications.subscriptions(None), Vec::new());
        })
        .await
        .expect("no subscription");
}

// spec 9.2
#[tokio::test]
async fn requests_are_refused_when_nobody_answers_them_or_they_name_a_destination_this_router_relays_nothing()
 {
    let served = Served::new(&RouterServerOptions::default());
    let other = crate::identity::Procedure {
        procedure_id: 9,
        ..echo()
    };
    served
        .router
        .register_resolver((&other, idle()))
        .expect("the other procedure registered");
    let unknown_service = crate::identity::Procedure {
        service_id: 99,
        ..echo()
    };
    served
        .transport
        .deliver(&request_of((1, &unknown_service, "")), &first());
    served
        .transport
        .deliver(&request_of((3, &echo(), "")), &first());
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                destination_id: Some(4),
                ..super::server::header_of((5, &echo()))
            },
            payload: Bytes::new(),
        },
        &first(),
    );
    served.transport.deliver_message(
        &TransportMessage {
            data: Bytes::from_static(&[0xa2, 0x10, 0, 3, 0, 0, 0, 7, 0, 2, 0, 1]),
            ..TransportMessage::default()
        },
        &first(),
    );
    served.settle().await;
    let sent = served.transport.take();
    assert_eq!(sent.len(), 4);
    for ((handle, envelope), (call_id, code)) in sent.iter().zip([
        (1, ProtocolCode::SERVICE_UNKNOWN),
        (3, ProtocolCode::PROCEDURE_UNKNOWN),
        (5, ProtocolCode::DESTINATION_UNKNOWN),
        (7, ProtocolCode::LAYOUT_UNSUPPORTED),
    ]) {
        assert_eq!(*handle, first());
        assert!(matches!(envelope, Envelope::Failure { header, failure }
            if header.call_id == call_id && header.credential.is_none() && failure.code == code.get()));
    }
    assert_eq!(served.reported(), Vec::<String>::new());
}

// spec 9.2
#[tokio::test]
async fn requests_are_the_only_envelopes_answered_any_other_is_reported() {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.deliver(
        &Envelope::Notification {
            header: NotificationHeader { call_id: 1 },
            payload: Bytes::new(),
        },
        &first(),
    );
    served.transport.deliver(&result_of(2, None), &first());
    served.transport.deliver_message(
        &TransportMessage {
            data: Bytes::from_static(&[0xa2, 0x11, 0, 2, 0, 0, 0, 3]),
            ..TransportMessage::default()
        },
        &second(),
    );
    served.settle().await;
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(
        served.reported(),
        [
            "KIND_UNSUPPORTED first",
            "CALL_UNKNOWN first",
            "LAYOUT_UNSUPPORTED second"
        ]
    );
}

// spec 9.2, 11.2
#[tokio::test]
async fn requests_of_the_servers_own_parity_or_on_a_subscriptions_call_id_are_reported_on_their_connection_and_taken_on_another()
 {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served.news();
    served.transport.deliver(&subscribing_of(13), &first());
    served.settle().await;
    assert_eq!(served.sent_since(), ["first result 13 ok"]);
    served.transport.deliver(&subscribing_of(13), &first());
    served.transport.deliver(&subscribing_of(14), &first());
    served.transport.deliver(&subscribing_of(13), &second());
    served.settle().await;
    assert_eq!(
        served.reported(),
        ["ENVELOPE_MALFORMED first", "ENVELOPE_MALFORMED first"]
    );
    assert_eq!(served.sent_since(), ["second result 13 ok"]);
    served
        .router
        .owner()
        .run(|state| {
            let subscriptions = state.notifications.subscriptions(None);
            assert_eq!(subscriptions.len(), 2);
            for handle in [first(), second()] {
                assert!(
                    subscriptions
                        .iter()
                        .any(|subscription| subscription.connection_handle == handle
                            && subscription.call_id == 13
                            && subscription.procedure == news().address())
                );
            }
        })
        .await
        .expect("a call id belongs to its connection");
}

#[tokio::test]
async fn requests_refuse_a_second_resolver_for_one_procedure() {
    let served = Served::new(&RouterServerOptions::default());
    served
        .router
        .register_resolver((&echo(), idle()))
        .expect("echo registered");
    assert!(served.router.register_resolver((&echo(), idle())).is_err());
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(served.reported(), Vec::<String>::new());
}
