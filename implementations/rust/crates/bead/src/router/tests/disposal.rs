//! A router's dispose and its end: what its transport tells once it is disposed reaches nothing of
//! it, as both other sides stop listening within their dispose; and a router nobody holds, its
//! transport gone, ends with its owner, as the other sides collect one nothing references.

use core::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};

use bytes::Bytes;

use super::server::{Served, first, request_of};
use crate::constants::ProcedureKind;
use crate::envelope::{Envelope, RequestHeader};
use crate::errors::ResolverError;
use crate::identity::Procedure;
use crate::managers::service::{
    ResolverDependencies, Response, ServiceManager, ServiceManagerOptions, ServiceRouter,
};
use crate::payloads::RawCodec;
use crate::router::core::ResolverProps;
use crate::router::server::RouterServerOptions;
use crate::router::types::RouterAnswer;
use crate::testing::pair::echo;

// a counter of the times a resolver ran
fn counting() -> (
    Arc<AtomicUsize>,
    crate::managers::service::ResolverCallback<RawCodec, RawCodec>,
) {
    let resolved = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&resolved);

    (
        resolved,
        Arc::new(move |_request, response: Response<RawCodec>| {
            counted.fetch_add(1, Ordering::SeqCst);
            response.result(Bytes::from_static(b"ok"))
        }),
    )
}

// decision 0044, spec 9.0: the dispose marks the router at once and lets go in a later turn; what
// its transport tells in between is dropped, as the other sides unlisten within their dispose
#[tokio::test]
async fn a_request_its_transport_tells_once_its_router_is_disposed_reaches_no_resolver() {
    let served = Served::new(&RouterServerOptions::default());
    let (resolved, callback) = counting();

    served
        .services
        .get_request_resolver(&echo(), ResolverDependencies::of(RawCodec, RawCodec))
        .expect("echo resolved")
        .on(callback)
        .expect("echo registered");
    served.transport.open(&first(), true);
    served.settle().await;

    // * disposed at once; the request told before the dispose's turn lets its transport go
    let disposed = served.router.dispose();

    served
        .transport
        .deliver(&request_of((1, &echo(), "hi")), &first());
    served.settle().await;
    disposed.await;

    assert_eq!(resolved.load(Ordering::SeqCst), 0, "no resolver ran");
    assert!(served.sent_since().is_empty(), "nothing answered");
    assert!(served.reported().is_empty(), "nothing reported");
}

// the client's side alike: a command of its server's, told once it is disposed
#[tokio::test]
async fn a_command_its_transport_tells_once_its_router_is_disposed_reaches_no_resolver() {
    let scripted = super::Scripted::new();
    let services = ServiceManager::new(
        ServiceRouter::Client(scripted.router.clone()),
        &ServiceManagerOptions::default(),
    )
    .expect("a manager built");
    let (resolved, callback) = counting();
    let command = Procedure {
        id: 9,
        name: "clock".to_owned(),
        kind: Some(ProcedureKind::Command),
        ..echo()
    };

    services
        .get_command_resolver(&command, ResolverDependencies::of(RawCodec, RawCodec))
        .expect("clock resolved")
        .on(callback)
        .expect("clock registered");
    scripted.settle().await;

    let disposed = scripted.router.dispose();

    scripted.transport.deliver(&Envelope::Request {
        header: RequestHeader {
            procedure_id: 9,
            ..super::request_header_of(2)
        },
        payload: Bytes::new(),
    });
    scripted.settle().await;
    disposed.await;

    assert_eq!(resolved.load(Ordering::SeqCst), 0, "no resolver ran");
    assert!(
        scripted.transport.envelopes().is_empty(),
        "nothing answered"
    );
}

// waits, a while at most, for `weak` to be let go
async fn let_go<T: ?Sized + Send + Sync>(weak: &Weak<T>) -> bool {
    for _ in 0..1_000 {
        if weak.strong_count() == 0 {
            return true;
        }

        tokio::task::yield_now().await;
    }

    weak.strong_count() == 0
}

// what a router's owner holds, seen let go once its owner ended
struct Held;

// decision 0044: the owner lives while its application holds a handle or its transport holds it;
// neither, it ends, its state let go, as the other sides collect a router nothing references
#[tokio::test]
async fn a_router_never_disposed_ends_once_its_application_and_its_transport_let_it_go() {
    for is_client in [false, true] {
        let held = Arc::new(Held);
        let kept = Arc::downgrade(&held);
        let transport: Weak<dyn core::any::Any + Send + Sync> = if is_client {
            let scripted = super::Scripted::new();
            let transport = Arc::downgrade(&scripted.transport);

            scripted.router.on_error(Arc::new(move |_error| {
                drop(Arc::clone(&held));
            }));

            transport
        } else {
            let served = Served::new(&RouterServerOptions::default());
            let transport = Arc::downgrade(&served.transport);

            served.router.on_error(Arc::new(move |_error, _handle| {
                drop(Arc::clone(&held));
            }));
            served.transport.open(&first(), true);
            served.settle().await;

            transport
        };

        assert!(
            let_go(&transport).await,
            "its transport let go, client {is_client}"
        );
        assert!(
            let_go(&kept).await,
            "its owner ended, what its state held let go with it, client {is_client}"
        );
    }
}

// decision 0044: its transport holds it while the application holds none of it
#[tokio::test]
async fn a_router_its_transport_holds_answers_still_once_its_application_let_go_of_it() {
    let resolved = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&resolved);
    let served = super::resolving(Arc::new(move |props: ResolverProps| {
        counted.fetch_add(1, Ordering::SeqCst);

        Box::pin(async move {
            props
                .answerer
                .respond(RouterAnswer::Result(Bytes::from_static(b"ok")))
                .await
                .map_err(ResolverError::other)
        })
    }));
    let Served {
        clock, transport, ..
    } = served;

    // * nothing of the application holds its router; its transport does
    clock.settle().await;
    transport.deliver(&request_of((1, &echo(), "hi")), &first());
    clock.settle().await;

    assert_eq!(resolved.load(Ordering::SeqCst), 1, "its resolver ran");
    assert_eq!(transport.take().len(), 1, "answered");
}

// decision 0044, as above, over the in-memory transport: a connection held, then closed, nothing
// disposed
#[tokio::test]
async fn routers_never_disposed_over_the_in_memory_transport_end_once_nothing_holds_them() {
    let clock = crate::testing::SteppingClock::new(super::january_first());
    let shared: crate::clock::SharedClock = Arc::<crate::testing::SteppingClock>::clone(&clock);
    let (server_held, client_held) = (Arc::new(Held), Arc::new(Held));
    let kept = (Arc::downgrade(&server_held), Arc::downgrade(&client_held));

    {
        let memory = crate::memory::MemoryServer::new(&crate::memory::MemoryServerOptions {
            clock: Some(Arc::clone(&shared)),
            runtime: None,
        })
        .expect("a server transport");
        let server = crate::router::server::RouterServer::new(
            Arc::new(memory.clone()),
            &RouterServerOptions::default(),
        )
        .expect("a server's router");

        crate::transport::ServerTransport::start(&memory)
            .await
            .expect("started");

        let transport = crate::memory::MemoryClient::new(&crate::memory::MemoryClientOptions {
            clock: Some(Arc::clone(&shared)),
            server: memory.clone(),
        })
        .expect("a client transport");
        let client = crate::router::client::RouterClient::new(
            Arc::new(transport.clone()),
            &crate::router::client::RouterClientOptions::default(),
        )
        .expect("a client's router");

        server.on_error(Arc::new(move |_error, _handle| {
            drop(Arc::clone(&server_held));
        }));
        client.on_error(Arc::new(move |_error| {
            drop(Arc::clone(&client_held));
        }));

        let connecting = transport.connect(crate::memory::MemoryConnectOptions::default());

        clock.settle().await;
        connecting.await.expect("connected");
        transport
            .disconnect(crate::transport::DisconnectOptions::default())
            .expect("closed");
        clock.settle().await;
    }

    clock.settle().await;

    assert!(let_go(&kept.0).await, "the server's owner ended");
    assert!(let_go(&kept.1).await, "the client's owner ended");
}
