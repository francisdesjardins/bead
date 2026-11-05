//! The client's router shares its transport's clock, takes one when the transport has none,
//! and refuses a different one before registering a listener.

use std::sync::Arc;

use crate::clock::{SharedClock, SystemClock, SystemClockOptions};
use crate::router::client::{RouterClient, RouterClientOptions};
use crate::testing::SteppingClock;
use crate::testing::clockless::Clockless;
use crate::testing::scripted::ScriptedClient;

#[tokio::test]
async fn runs_on_its_transports_clock_or_on_the_one_it_is_given_when_its_transport_has_none_and_refuses_one_that_differs()
 {
    let clock: SharedClock = SteppingClock::new(super::january_first());
    let system: SharedClock =
        Arc::new(SystemClock::new(&SystemClockOptions::default()).expect("a system clock"));
    let transport = ScriptedClient::new(Arc::clone(&clock));
    let on_transport = RouterClient::new(
        Arc::<ScriptedClient>::clone(&transport),
        &RouterClientOptions::default(),
    )
    .expect("its transport's clock");
    let given = RouterClientOptions {
        clock: Some(Arc::clone(&clock)),
        ..RouterClientOptions::default()
    };
    let same = RouterClient::new(Arc::<ScriptedClient>::clone(&transport), &given)
        .expect("the same clock");
    let without = Arc::new(Clockless(Arc::<ScriptedClient>::clone(&transport)));
    let on_own = RouterClient::new(Arc::<Clockless<ScriptedClient>>::clone(&without), &given)
        .expect("the given clock");
    let alone =
        RouterClient::new(without, &RouterClientOptions::default()).expect("the platform's clock");
    for router in [&on_transport, &same, &on_own] {
        assert!(Arc::ptr_eq(&router.clock(), &clock));
    }
    assert_eq!(alone.clock().description(), "the platform's");
    let before = transport.listener_count();
    assert_eq!(
        RouterClient::new(
            Arc::<ScriptedClient>::clone(&transport),
            &RouterClientOptions {
                clock: Some(system),
                ..RouterClientOptions::default()
            }
        )
        .expect_err("a different clock")
        .to_string(),
        "a client's router runs on the clock of its transport, one of its own, and was given another, the platform's"
    );
    assert_eq!(transport.listener_count(), before);
    for router in [on_transport, same, on_own, alone] {
        router.dispose().await;
    }
    assert_eq!(transport.listener_count(), 0);
}
