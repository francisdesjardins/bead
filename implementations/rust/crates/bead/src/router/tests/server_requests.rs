//! A server's requests: its transport, admissions before decoding, routing refusals, and the
//! connection and parity of each incoming call.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::server::{Served, first, news, request_of, second, subscribing_of};
use super::{locked, result_of};
use crate::NotificationResolverDependencies;
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope, NotificationHeader, RequestHeader};
use crate::managers::service::{RequestResolverDependencies, Response};
use crate::payloads::{CodecRefusal, PayloadCodec, TextCodec};
use crate::router::admissions::BeforeRequest;
use crate::router::core::Handler;
use crate::router::server::RouterServerOptions;
use crate::router::types::{CallSession, ConnectionHandle, TransportMessage};
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

#[derive(Debug, PartialEq, Eq)]
enum SessionStep {
    Session(ConnectionHandle, u32, bool),
    Admit(u32, Option<Arc<CallSession>>),
    Callback(u32, Option<Arc<CallSession>>),
}

#[tokio::test]
async fn a_session_provider_s_error_or_panic_is_reported_and_refuses_only_its_call() {
    for panics in [false, true] {
        let served = Served::new(&RouterServerOptions {
            session_of: Some(Arc::new(move |request, _| {
                let header = request.header;
                if header.call_id == 1 {
                    assert!(!panics, "the session provider failed");
                    return Err(crate::testing::core_port::error_of(
                        "the session provider failed",
                    ));
                }
                Ok(None)
            })),
            ..RouterServerOptions::default()
        });
        let admitted = Arc::new(Mutex::new(Vec::new()));
        let admitting = Arc::clone(&admitted);
        let mut dependencies = RequestResolverDependencies::new(TextCodec, TextCodec);
        dependencies.before_request = Some(BeforeRequest::new(
            move |request| {
                locked(&admitting).push(request.header.call_id);
                true
            },
            None,
        ));
        served
            .services
            .get_request_resolver(&echo(), dependencies)
            .expect("echo resolved")
            .on(Arc::new(|_, response| response.result("ok".to_owned())))
            .expect("echo registered");
        for id in [1, 3] {
            served
                .transport
                .deliver(&request_of((id, &echo(), "")), &first());
        }
        served.settle().await;
        assert_eq!(*locked(&admitted), [3]);
        let sent = served.transport.take();
        assert!(
            matches!(&sent[0].1, Envelope::Failure { header, failure } if header.call_id == 1 && failure.code == ProtocolCode::PROCEDURE_FAILED.get() && failure.detail.is_empty())
        );
        assert!(
            matches!(&sent[1].1, Envelope::Result { header, payload } if header.call_id == 3 && payload.as_ref() == b"ok")
        );
        {
            let reports = locked(&served.reports).clone();
            assert_eq!(reports.len(), 1);
            assert_eq!(reports[0].1, Some(first()));
            assert!(
                reports[0]
                    .0
                    .to_string()
                    .contains("the session provider failed")
            );
        }
        assert_eq!(
            served
                .router
                .gauges()
                .await
                .expect("distinct counts")
                .counts["answeringCalls"],
            0
        );
    }
}

// spec 9.2, 13.1
#[tokio::test]
async fn are_each_asked_their_session_of_its_session_of_once_their_call_id_held_before_their_admission_which_reads_it_as_their_callback_does()
 {
    let order = Arc::new(Mutex::new(Vec::new()));
    let resolving = Arc::clone(&order);
    let session = CallSession {
        data: Some(serde_json::json!("ada")),
        ..CallSession::default()
    };
    let resolved = session.clone();
    let token = super::token();
    let served = Served::new(&RouterServerOptions {
        session_of: Some(Arc::new(move |request, signal| {
            let (handle, header) = (request.connection_handle, request.header);
            locked(&resolving).push(SessionStep::Session(
                Arc::clone(handle),
                header.call_id,
                signal.is_aborted(),
            ));
            Ok((header.credential == Some(Credential::Opaque(token))).then(|| resolved.clone()))
        })),
        ..RouterServerOptions::default()
    });
    let admitting = Arc::clone(&order);
    let mut dependencies = RequestResolverDependencies::new(TextCodec, TextCodec);
    dependencies.before_request = Some(BeforeRequest::new(
        move |request| {
            locked(&admitting).push(SessionStep::Admit(
                request.header.call_id,
                request.session.clone(),
            ));
            true
        },
        None,
    ));
    let callbacks = Arc::clone(&order);
    served
        .services
        .get_request_resolver(&echo(), dependencies)
        .expect("echo resolved")
        .on(Arc::new(move |request, response| {
            locked(&callbacks).push(SessionStep::Callback(
                request.header.call_id,
                request.session,
            ));
            response.result("ok".to_owned())
        }))
        .expect("echo registered");
    for (id, credential) in [
        (31, None),
        (33, Some(Credential::Opaque(token))),
        (
            35,
            Some(Credential::Opaque(
                crate::SessionToken::new([2; 16]).expect("another token"),
            )),
        ),
    ] {
        served.transport.deliver(
            &Envelope::Request {
                header: RequestHeader {
                    credential,
                    ..super::server::header_of((id, &echo()))
                },
                payload: Bytes::new(),
            },
            &first(),
        );
    }
    served.settle().await;
    assert_eq!(
        *locked(&order),
        [
            SessionStep::Session(first(), 31, false),
            SessionStep::Admit(31, None),
            SessionStep::Session(first(), 33, false),
            SessionStep::Admit(33, Some(Arc::new(session.clone()))),
            SessionStep::Session(first(), 35, false),
            SessionStep::Callback(31, None),
            SessionStep::Callback(33, Some(Arc::new(session))),
        ]
    );
    {
        let steps = locked(&order);
        let (SessionStep::Admit(_, Some(admitted)), SessionStep::Callback(_, Some(received))) =
            (&steps[3], &steps[6])
        else {
            panic!("the admitted call reaches its callback with its session");
        };
        assert!(Arc::ptr_eq(admitted, received));
        drop(steps);
    }
    assert_eq!(
        served.sent_since(),
        [
            "first failure 35 SESSION_REQUIRED",
            "first result 31 ok",
            "first result 33 ok",
        ]
    );
    assert_eq!(served.reported(), Vec::<String>::new());
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
        served
            .router
            .gauges()
            .await
            .expect("distinct counts")
            .counts["notifiedSubscriptions"],
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
