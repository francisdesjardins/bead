//! A client and a server converse over a binary in-memory link, through their service managers.

use std::sync::{Arc, Mutex};

use super::locked;
use crate::clock::SharedClock;
use crate::constants::{CredentialScheme, EnvelopeKind};
use crate::debug::DebugDirection;
use crate::errors::ResolverError;
use crate::identity::Procedure;
use crate::managers::service::{
    NotificationDependencies, NotificationResolverDependencies, Notifier, NotifyOptions,
    RequestDependencies, RequestOptions, RequestResolverDependencies, Response, ServiceManager,
    ServiceManagerOptions, ServiceRouter,
};
use crate::memory::{
    MemoryTransportClient, MemoryTransportClientConnectOptions, MemoryTransportClientOptions,
    MemoryTransportServer, MemoryTransportServerOptions,
};
use crate::payloads::TextCodec;
use crate::router::client::{RouterClient, RouterClientOptions};
use crate::router::server::{RouterServer, RouterServerOptions};
use crate::router::types::{CallAddress, ConnectionHandle};
use crate::testing::{SteppingClock, instants};
use crate::transport::{ServerTransport, TransportClientDisconnectOptions};

fn procedure(id: u16, name: &str) -> Procedure {
    Procedure {
        procedure_id: id,
        procedure_name: name.to_owned(),
        procedure_kind: None,
        ..crate::testing::pair::echo()
    }
}

struct Link {
    clock: Arc<SteppingClock>,
    memory: MemoryTransportServer,
    transport: Arc<MemoryTransportClient>,
    client: RouterClient,
    server: RouterServer,
    caller: ServiceManager,
    answering: ServiceManager,
}

impl Link {
    fn new() -> Self {
        let clock = SteppingClock::new(instants::new_year());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let memory = MemoryTransportServer::new(&MemoryTransportServerOptions {
            clock: Some(Arc::clone(&shared)),
            runtime: None,
        })
        .expect("a server transport");
        let server = RouterServer::new(
            Arc::new(memory.clone()),
            &RouterServerOptions {
                session_token_of: Some(Arc::new(|_| {
                    Ok(Some(
                        crate::SessionToken::new([7; 16]).expect("the source's token"),
                    ))
                })),
                ..RouterServerOptions::default()
            },
        )
        .expect("a server router");
        let transport = Arc::new(
            MemoryTransportClient::new(&MemoryTransportClientOptions {
                clock: Some(shared),
            })
            .expect("a client transport"),
        );
        let client = RouterClient::new(
            Arc::<MemoryTransportClient>::clone(&transport),
            &RouterClientOptions::default(),
        )
        .expect("a client router");
        let caller = ServiceManager::new(
            ServiceRouter::Client(client.clone()),
            &ServiceManagerOptions::default(),
        )
        .expect("the caller's services");
        let answering = ServiceManager::new(
            ServiceRouter::Server(server.clone()),
            &ServiceManagerOptions::default(),
        )
        .expect("the server's services");
        Self {
            clock,
            memory,
            transport,
            client,
            server,
            caller,
            answering,
        }
    }
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the source's linked conversation keeps the request, notifications, command and disconnect together"
)]
async fn a_client_and_a_server_ask_answer_subscribe_notify_unsubscribe_and_command_each_other_over_a_link()
 {
    let link = Link::new();
    let asked = Arc::new(Mutex::new(None::<ConnectionHandle>));
    let asking = Arc::clone(&asked);
    link.answering
        .get_request_resolver(
            &procedure(1, "echo"),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("echo defined")
        .on(Arc::new(move |request, response| {
            *locked(&asking) = Some(request.connection_handle);
            response.result(request.payload.to_ascii_uppercase())
        }))
        .expect("echo registered");
    let notifier = Arc::new(Mutex::new(None::<Notifier<TextCodec>>));
    let notifying = Arc::clone(&notifier);
    *locked(&notifier) = Some(
        link.answering
            .get_notification_resolver(
                &procedure(5, "news"),
                NotificationResolverDependencies::new(
                    RequestResolverDependencies::new(TextCodec, TextCodec),
                    TextCodec,
                ),
            )
            .expect("news defined")
            .on(Arc::new(move |_, response: Response<TextCodec>| {
                let notifier = locked(&notifying)
                    .as_ref()
                    .expect("news registered before called")
                    .clone();
                Box::pin(async move {
                    let id = response
                        .register_notification()
                        .await
                        .map_err(ResolverError::other)?;
                    response.result(id.to_string()).await?;
                    notifier
                        .notify("first".to_owned(), &NotifyOptions::default())
                        .await;
                    Ok(())
                })
            }))
            .expect("news registered"),
    );
    let server = link.server.clone();
    link.answering
        .get_request_resolver(
            &procedure(6, "unsubscribe"),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("unsubscribe defined")
        .on(Arc::new(move |request, response| {
            let server = server.clone();
            Box::pin(async move {
                let call_id = request.payload.parse().map_err(ResolverError::other)?;
                let held = server
                    .unsubscribe(CallAddress {
                        call_id,
                        connection_handle: request.connection_handle,
                    })
                    .await;
                response
                    .result(if held { "True" } else { "False" }.to_owned())
                    .await
            })
        }))
        .expect("unsubscribe registered");
    link.caller
        .get_request_resolver(
            &procedure(40, "ping"),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("ping defined")
        .on(Arc::new(|_, response| response.result("pong".to_owned())))
        .expect("ping registered");
    let told = Arc::new(Mutex::new(Vec::new()));
    let telling = Arc::clone(&told);
    link.client.on_debug(Arc::new(move |direction, envelope| {
        locked(&telling).push((
            direction,
            envelope.header.kind(),
            envelope.header.call_id(),
            envelope.credential_scheme,
        ));
    }));
    link.memory.start().await.expect("the link listens");
    link.transport
        .connect(&MemoryTransportClientConnectOptions::new(
            link.memory.clone(),
        ))
        .await
        .expect("the client connects");
    let echo = link
        .caller
        .get_request(
            &procedure(1, "echo"),
            RequestDependencies::new(TextCodec, TextCodec),
        )
        .expect("echo requester");
    assert_eq!(
        echo.call("hi".to_owned(), &RequestOptions::default())
            .expect("echo called")
            .await
            .expect("echo answered"),
        "HI"
    );
    assert_eq!(
        link.client.session_token(),
        Some(crate::SessionToken::new([7; 16]).expect("the announced token"))
    );
    let unsubscribe = link
        .caller
        .get_request(
            &procedure(6, "unsubscribe"),
            RequestDependencies::new(TextCodec, TextCodec),
        )
        .expect("unsubscribe requester");
    let unsubscribed = Arc::new(Mutex::new(Vec::new()));
    let recording = Arc::clone(&unsubscribed);
    let mut dependencies =
        NotificationDependencies::new(RequestDependencies::new(TextCodec, TextCodec), TextCodec);
    dependencies.unsubscribe = Some(Arc::new(move |id, response| {
        let unsubscribe = unsubscribe.clone();
        let recording = Arc::clone(&recording);
        Box::pin(async move {
            let answered = unsubscribe
                .call(id.to_string(), &RequestOptions::default())
                .expect("unsubscribe called")
                .await?;
            locked(&recording).push(format!("{id} {response} {answered}"));
            Ok(())
        })
    }));
    let notification = link
        .caller
        .get_notification(&procedure(5, "news"), dependencies)
        .expect("news notification");
    let heard = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&heard);
    let registration = notification
        .register(
            "subscribe".to_owned(),
            Arc::new(move |payload| {
                locked(&hearing).push(payload);
                Box::pin(async { Ok(()) })
            }),
            &RequestOptions::default(),
        )
        .await
        .expect("subscribed");
    let news = locked(&notifier).as_ref().expect("news registered").clone();
    news.notify("flash".to_owned(), &NotifyOptions::default())
        .await;
    link.clock.settle().await;
    assert_eq!(*locked(&heard), ["first", "flash"]);
    let handle = locked(&asked).clone().expect("echo names its connection");
    let ping = link
        .answering
        .get_request(
            &procedure(40, "ping"),
            RequestDependencies::new(TextCodec, TextCodec),
        )
        .expect("ping requester");
    assert_eq!(
        ping.call(
            "ping".to_owned(),
            &RequestOptions {
                connection_handle: Some(Arc::clone(&handle)),
                ..RequestOptions::default()
            }
        )
        .expect("ping called")
        .await
        .expect("ping answered"),
        "pong"
    );
    registration
        .unregister()
        .await
        .expect("unsubscribed at both ends");
    assert_eq!(*locked(&unsubscribed), ["3 3 True"]);
    link.server
        .owner()
        .run(|state| assert_eq!(state.notifications.subscriptions(None), []))
        .await
        .expect("the server has no subscription");
    assert!(locked(&told).contains(&(DebugDirection::Rx, EnvelopeKind::Request, 2, None)));
    assert_eq!(
        locked(&told)
            .iter()
            .filter(|entry| entry.3.is_some())
            .copied()
            .collect::<Vec<_>>(),
        [(
            DebugDirection::Rx,
            EnvelopeKind::Result,
            1,
            Some(CredentialScheme::OPAQUE)
        )]
    );
    let dropped = Arc::new(Mutex::new(Vec::new()));
    let dropping = Arc::clone(&dropped);
    link.caller.on_dropped(Arc::new(move |procedure, _| {
        locked(&dropping).push(procedure.clone());
    }));
    let _again = notification
        .register(
            "subscribe".to_owned(),
            Arc::new(|_| Box::pin(async { Ok(()) })),
            &RequestOptions::default(),
        )
        .await
        .expect("subscribed again");
    let connection = Arc::clone(&handle);
    link.server
        .owner()
        .run(move |state| {
            assert_eq!(
                state
                    .notifications
                    .subscriptions(None)
                    .iter()
                    .map(|sub| (&sub.connection_handle, sub.call_id))
                    .collect::<Vec<_>>(),
                [(&connection, 7)]
            );
        })
        .await
        .expect("the next subscription uses call 7");
    link.transport
        .disconnect(&TransportClientDisconnectOptions::default())
        .expect("the link closes");
    link.clock.settle().await;
    assert_eq!(*locked(&dropped), [procedure(5, "news")]);
    link.server
        .owner()
        .run(|state| assert_eq!(state.notifications.subscriptions(None), []))
        .await
        .expect("the close removes its subscription");
    link.client.dispose().await;
    link.server.dispose().await;
    link.memory.stop().await.expect("the link stops");
}
