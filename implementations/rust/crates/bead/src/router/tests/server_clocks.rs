//! The server's router shares the clock below it and refuses a different one in either direction.

use std::sync::Arc;

use crate::clock::{SharedClock, SystemClock, SystemClockOptions};
use crate::router::server::{RouterServer, RouterServerOptions};
use crate::testing::SteppingClock;
use crate::testing::clockless::Clockless;
use crate::testing::scripted::ScriptedServer;

#[tokio::test]
async fn runs_on_its_transports_clock_or_on_the_one_it_is_given_when_its_transport_has_none_and_refuses_one_that_differs()
 {
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
    let on_own = RouterServer::new(
        Arc::new(Clockless(Arc::<ScriptedServer>::clone(&transport))),
        &given,
    )
    .expect("the given clock");
    for router in [&on_transport, &same, &on_own] {
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
    for router in [on_transport, same, on_own] {
        router.dispose().await;
    }
    assert_eq!(transport.listener_count(), 0);
}
