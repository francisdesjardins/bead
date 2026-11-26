//! The server's router shares the clock below it and refuses a different one in either direction.

use std::sync::Arc;

use crate::clock::{SharedClock, SystemClock, SystemClockOptions};
use crate::memory::{MemoryTransportServer, MemoryTransportServerOptions};
use crate::router::server::{RouterServer, RouterServerOptions};
use crate::testing::SteppingClock;
use crate::testing::scripted::ScriptedServer;
use crate::transport::ServerTransport;

#[tokio::test]
async fn runs_on_its_transports_clock_and_refuses_another() {
    let clock: SharedClock = SteppingClock::new(super::january_first());
    let system: SharedClock =
        Arc::new(SystemClock::new(&SystemClockOptions::default()).expect("a system clock"));
    let transport = ScriptedServer::new(Arc::clone(&clock));
    let on_transport = RouterServer::new(
        Arc::<ScriptedServer>::clone(&transport),
        &RouterServerOptions::default(),
    )
    .expect("its transport's clock");
    let given = RouterServerOptions {
        clock: Some(Arc::clone(&clock)),
        ..RouterServerOptions::default()
    };
    let same = RouterServer::new(Arc::<ScriptedServer>::clone(&transport), &given)
        .expect("the same clock");
    for router in [&on_transport, &same] {
        assert!(Arc::ptr_eq(&router.clock(), &clock));
    }
    let before = transport.listener_count();
    assert_eq!(
        RouterServer::new(
            Arc::<ScriptedServer>::clone(&transport),
            &RouterServerOptions {
                clock: Some(Arc::clone(&system)),
                ..RouterServerOptions::default()
            }
        )
        .expect_err("a different clock")
        .to_string(),
        "a server's router runs on the clock of its transport, one of its own, and was given another, the platform's"
    );
    assert_eq!(transport.listener_count(), before);
    let platform = ScriptedServer::new(system);
    assert_eq!(
        RouterServer::new(Arc::<ScriptedServer>::clone(&platform), &given)
            .expect_err("the platform's transport and a different clock")
            .to_string(),
        "a server's router runs on the clock of its transport, the platform's, and was given another, one of its own"
    );
    assert_eq!(platform.listener_count(), 0);
    let unclocked: Arc<dyn ServerTransport> = Arc::new(
        MemoryTransportServer::new(&MemoryTransportServerOptions::default())
            .expect("a transport given no clock"),
    );
    assert_eq!(
        RouterServer::new(unclocked, &given)
            .expect_err("a transport given none and a clock of its own")
            .to_string(),
        "a server's router runs on the clock of its transport, the platform's, and was given another, one of its own"
    );
    for router in [on_transport, same] {
        router.dispose().await;
    }
    assert_eq!(transport.listener_count(), 0);
}
