//! The server router's conversation over WebSocket: its request, command and subscription share
//! one connection, whose end takes the subscription away on both sides.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use crate::constants::{CredentialScheme, EnvelopeKind, ProcedureKind};
use crate::debug::DebugDirection;
use crate::errors::ResolverError;
use crate::managers::service::{
    CommandOptions, NotificationDependencies, NotificationResolverDependencies, Notifier,
    NotifyOptions, RegistrationOptions, RequestDependencies, RequestOptions,
    RequestResolverDependencies, ServiceManagerOptions, ServiceManagerServer,
};
use crate::payloads::TextCodec;
use crate::router::server::{RouterServer, RouterServerOptions};
use crate::router::types::CallAddress;
use crate::testing::{Instant, patience, rest};
use crate::transport::{
    ServerTransport, TransportClientDisconnectOptions, TransportServerStartOptions,
};
use crate::{
    WebSocketClient, WebSocketClientOptions, WebSocketTransportClientConnectOptions,
    WebSocketTransportServer, WebSocketTransportServerOptions,
};

use super::server::news;
use super::{PATIENCE, locked, token};
use crate::testing::pair::echo;

fn asked() -> RequestDependencies<TextCodec, TextCodec> {
    RequestDependencies::new(TextCodec, TextCodec)
}

fn answering() -> RequestResolverDependencies<TextCodec, TextCodec> {
    RequestResolverDependencies::new(TextCodec, TextCodec)
}

async fn heard_within(mut holds: impl FnMut() -> bool) {
    let started = Instant::now();

    while !holds() {
        assert!(started.elapsed() < PATIENCE, "the event arrives in time");
        rest(Duration::from_millis(1)).await;
    }
}

async fn no_subscriptions(router: &RouterServer) {
    let started = Instant::now();

    loop {
        let gauges = router.gauges().await.expect("its gauges");

        if gauges
            .counts
            .get("notifiedSubscriptions")
            .copied()
            .unwrap_or_default()
            == 0
        {
            return;
        }

        assert!(
            started.elapsed() < PATIENCE,
            "the subscriptions end in time"
        );
        rest(Duration::from_millis(1)).await;
    }
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one wire conversation keeps the source's request, subscription, command and disconnect in order"
)]
async fn ask_answer_subscribe_notify_unsubscribe_and_command_each_other_over_the_wire() {
    let transport = WebSocketTransportServer::new(&WebSocketTransportServerOptions::default())
        .expect("a transport");
    let router = RouterServer::new(
        Arc::new(transport.clone()),
        &RouterServerOptions {
            session_token_of: Some(Arc::new(|_| Ok(Some(token())))),
            ..RouterServerOptions::default()
        },
    )
    .expect("a router");
    let services = ServiceManagerServer::new(router.clone(), &ServiceManagerOptions::default())
        .expect("its services");
    let address = patience(
        PATIENCE,
        transport.start(&TransportServerStartOptions {
            address: Some("127.0.0.1".to_owned()),
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        }),
    )
    .await
    .expect("started in time")
    .expect("started");
    let client = WebSocketClient::new(&WebSocketClientOptions::default()).expect("a client");
    let told = Arc::new(Mutex::new(Vec::new()));
    let telling = Arc::clone(&told);

    client.router().on_debug(Arc::new(move |direction, event| {
        locked(&telling).push((
            direction,
            event.header.kind(),
            event.header.call_id(),
            event.credential_scheme,
        ));
    }));

    let handle = Arc::new(Mutex::new(None));
    let asked_on = Arc::clone(&handle);

    services
        .get_request_resolver(&echo(), answering())
        .expect("echo's resolver")
        .on(Arc::new(move |request, response| {
            *locked(&asked_on) = Some(request.connection_handle);
            response.result(request.payload.to_uppercase())
        }))
        .expect("registered");

    let notifying: Arc<Mutex<Option<Notifier<TextCodec>>>> = Arc::default();
    let notifying_from = Arc::clone(&notifying);
    let notifier = services
        .get_notification_resolver(
            &news(),
            NotificationResolverDependencies::new(answering(), TextCodec),
        )
        .expect("news's resolver")
        .on(Arc::new(move |_, response| {
            let notifying_from = Arc::clone(&notifying_from);

            Box::pin(async move {
                let call_id = response
                    .register_notification()
                    .await
                    .map_err(ResolverError::other)?;
                response.result(call_id.to_string()).await?;
                let notifier = locked(&notifying_from).clone().expect("the notifier");
                notifier
                    .notify("first".to_owned(), &NotifyOptions::default())
                    .await;

                Ok(())
            })
        }))
        .expect("registered");

    *locked(&notifying) = Some(notifier.clone());

    let unsubscribe = crate::identity::Procedure {
        procedure_id: 6,
        procedure_name: "unsubscribe".to_owned(),
        ..echo()
    };
    let unsubscribing_on = router.clone();

    services
        .get_request_resolver(&unsubscribe, answering())
        .expect("unsubscribe's resolver")
        .on(Arc::new(move |request, response| {
            let unsubscribing = unsubscribing_on.unsubscribe(CallAddress {
                call_id: request.payload.parse().expect("the subscribing call's id"),
                connection_handle: request.connection_handle,
            });

            Box::pin(async move { response.result(unsubscribing.await.to_string()).await })
        }))
        .expect("registered");

    let ping = crate::identity::Procedure {
        procedure_id: 40,
        procedure_name: "ping".to_owned(),
        procedure_kind: Some(ProcedureKind::Command),
        ..echo()
    };

    client
        .services()
        .get_command_resolver(&ping, answering())
        .expect("ping's resolver")
        .on(Arc::new(|_, response| response.result("pong".to_owned())))
        .expect("registered");
    patience(
        PATIENCE,
        client.connect(&WebSocketTransportClientConnectOptions::new(
            "127.0.0.1",
            address.port,
        )),
    )
    .await
    .expect("connected in time")
    .expect("connected");

    let echoing = client
        .services()
        .get_request(&echo(), asked())
        .expect("echo's requester");
    assert_eq!(
        patience(
            PATIENCE,
            echoing
                .call("hi".to_owned(), &RequestOptions::default())
                .expect("a call")
        )
        .await
        .expect("answered in time")
        .expect("answered"),
        "HI"
    );
    assert_eq!(client.router().session_token(), Some(token()));

    let unsubscribing = client
        .services()
        .get_request(&unsubscribe, asked())
        .expect("unsubscribe's requester");
    let unsubscribed = Arc::new(Mutex::new(Vec::new()));
    let unsubscribing_with = Arc::clone(&unsubscribed);
    let notification = client
        .services()
        .get_notification(
            &news(),
            NotificationDependencies {
                unsubscribe: Some(Arc::new(move |call_id, response| {
                    let call = unsubscribing.call(call_id.to_string(), &RequestOptions::default());
                    let unsubscribing_with = Arc::clone(&unsubscribing_with);

                    Box::pin(async move {
                        let result = call?.await?;
                        locked(&unsubscribing_with).push(format!("{call_id} {response} {result}"));
                        Ok(())
                    })
                })),
                ..NotificationDependencies::new(asked(), TextCodec)
            },
        )
        .expect("news's notification");
    let heard = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&heard);
    let registration = patience(
        PATIENCE,
        notification.register(
            "subscribe".to_owned(),
            Arc::new(move |payload| {
                locked(&hearing).push(payload);
                Box::pin(async { Ok(()) })
            }),
            &RegistrationOptions::default(),
        ),
    )
    .await
    .expect("registered in time")
    .expect("registered");

    notifier
        .notify("flash".to_owned(), &NotifyOptions::default())
        .await;
    heard_within(|| *locked(&heard) == ["first", "flash"]).await;

    let commanded = services
        .get_command(&ping, asked())
        .expect("ping's requester")
        .call(
            "ping".to_owned(),
            &CommandOptions::new(locked(&handle).clone().expect("the connection")),
        )
        .expect("a command");
    assert_eq!(
        patience(PATIENCE, commanded)
            .await
            .expect("answered in time")
            .expect("answered"),
        "pong"
    );

    patience(PATIENCE, registration.unregister())
        .await
        .expect("unregistered in time")
        .expect("unregistered");
    assert_eq!(*locked(&unsubscribed), ["3 3 true"]);
    no_subscriptions(&router).await;
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
    client.services().on_dropped(Arc::new(move |procedure, _| {
        locked(&dropping).push(procedure.clone());
    }));
    let _registration = patience(
        PATIENCE,
        notification.register(
            "subscribe".to_owned(),
            Arc::new(|_| Box::pin(async { Ok(()) })),
            &RegistrationOptions::default(),
        ),
    )
    .await
    .expect("registered in time")
    .expect("registered");
    patience(
        PATIENCE,
        client
            .disconnect(&TransportClientDisconnectOptions::default())
            .expect("disconnect starts"),
    )
    .await
    .expect("disconnected in time");
    heard_within(|| *locked(&dropped) == [news()]).await;
    no_subscriptions(&router).await;

    patience(PATIENCE, client.dispose())
        .await
        .expect("disposed in time");
    router.dispose().await;
    patience(PATIENCE, transport.stop())
        .await
        .expect("stopped in time")
        .expect("stopped");
}
