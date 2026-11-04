//! The client's tests: the layers it builds over its transport, on its transport's clock.

use std::sync::Arc;

use super::{Client, ClientOptions};
use crate::clock::SharedClock;
use crate::testing::SteppingClock;
use crate::testing::clockless::Clockless;
use crate::testing::scripted::ScriptedClient;

// no façade of a transport, nor a router a builder makes, on this side: its router is built on its
// transport, on that transport's clock, or on the platform's when it has none
#[tokio::test]
async fn runs_its_router_on_its_transports_clock_which_a_facade_is_given_through_its_transports_options_and_refuses_a_router_on_another()
 {
    let clock: SharedClock = SteppingClock::new(crate::testing::instants::new_year());
    let transport = ScriptedClient::new(Arc::clone(&clock));
    let client = Client::new(
        Arc::<ScriptedClient>::clone(&transport),
        &ClientOptions::default(),
    )
    .expect("a client");
    assert!(Arc::ptr_eq(&client.router().clock(), &clock));
    client.dispose().await;

    // a transport with no clock leaves its router the platform's
    let without = Client::new(
        Arc::new(Clockless(Arc::<ScriptedClient>::clone(&transport))),
        &ClientOptions::default(),
    )
    .expect("a client on the platform's clock");
    assert_eq!(without.router().clock().description(), "the platform's");
    without.dispose().await;
}
