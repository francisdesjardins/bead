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

// a pair's server answers echo with its payload
fn serve_echo(pair: &crate::testing::pair::Pair) {
    use crate::managers::service::{RequestResolverDependencies, Response};
    use crate::payloads::TextCodec;
    use crate::testing::pair::echo;

    pair.server
        .services()
        .get_request_resolver(
            &echo(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("echo resolved")
        .on(Arc::new(|request, response: Response<TextCodec>| {
            response.result(request.payload)
        }))
        .expect("echo registered");
}

// what echo answers `text` through `client`'s services, or the failure's detail
async fn echoed(client: &Client, text: &str) -> Result<String, String> {
    use crate::errors::CallError;
    use crate::managers::service::{RequestDependencies, RequestOptions};
    use crate::payloads::TextCodec;
    use crate::testing::pair::echo;

    let call = client
        .services()
        .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("echo asked")
        .call(text.to_owned(), &RequestOptions::default())
        .expect("a call");

    match crate::testing::patience(core::time::Duration::from_secs(10), call)
        .await
        .expect("answered in time")
    {
        Ok(answer) => Ok(answer),
        Err(CallError::Failure(failure)) => Err(failure.detail().to_owned()),
        Err(other) => Err(other.to_string()),
    }
}

// no factory of a layer on this side: its router is built on its transport, its services on its
// router
#[tokio::test]
async fn builds_its_router_on_its_transport_and_its_services_on_its_router() {
    use crate::testing::pair::{Pair, PairOptions};

    let pair = Pair::connected(
        crate::testing::instants::new_year(),
        &PairOptions::default(),
    )
    .await
    .expect("a pair connected");
    serve_echo(&pair);
    assert!(Arc::ptr_eq(
        &pair.client.router().transport(),
        &pair.client.transport()
    ));
    assert_eq!(echoed(&pair.client, "hello").await, Ok("hello".to_owned()));
    pair.client.dispose().await;
}

// no factory of a router on this side: the limits its options give are its router's own
#[tokio::test]
async fn builds_its_router_with_the_limits_given_its_own_or_the_factory_given_for_it() {
    use crate::router::types::RouterLimitsOptions;
    use crate::testing::pair::{Pair, PairOptions};

    let pair = Pair::connected(
        crate::testing::instants::new_year(),
        &PairOptions {
            client: Some(ClientOptions {
                limits: Some(RouterLimitsOptions {
                    maximum_payload_bytes: Some(8),
                    ..RouterLimitsOptions::default()
                }),
                ..ClientOptions::default()
            }),
            ..PairOptions::default()
        },
    )
    .await
    .expect("a pair connected");
    serve_echo(&pair);
    assert_eq!(pair.client.router().limits().maximum_payload_bytes, 8);
    assert_eq!(
        echoed(&pair.client, "much too long").await,
        Err("a payload is 8 bytes at most, not 13".to_owned())
    );
    pair.client.dispose().await;
}
