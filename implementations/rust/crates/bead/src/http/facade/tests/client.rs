//! The twins of `http-client.test.ts` and `BeadHttpClientTests`: the client an application starts
//! from, against a server of the tests' own and against the server an application starts from.

use std::sync::{Arc, Mutex};

use super::*;
use crate::clock::SharedClock;
use crate::errors::{ResolverError, TransportError};
use crate::testing::SteppingClock;
use crate::transport::{
    ClientListener, ReadyState, RouterClientTransport, TransportClientDisconnectOptions,
    TransportClientReconnectDelay, TransportClientReconnectOptions,
};

// a server whose echo answers what it is asked, and whose slow call answers nothing until it is
// cancelled; the request it reads next told, so a test acts once it went
struct Served {
    server: HttpServer,
    port: u16,
    requested: Arc<tokio::sync::Notify>,
}

async fn served() -> Served {
    let server = HttpServer::new(&HttpServerOptions::default()).expect("a server");
    let requested = Arc::new(tokio::sync::Notify::new());
    let hearing = Arc::clone(&requested);

    server
        .services()
        .get_request_resolver(&echo(), text())
        .expect("a resolver")
        .on(Arc::new(|request, response| {
            response.result(request.payload)
        }))
        .expect("registered");
    server
        .services()
        .get_request_resolver(&slow(), text())
        .expect("a resolver")
        .on(Arc::new(move |request, _| {
            hearing.notify_one();

            Box::pin(async move {
                request.signal.token().cancelled().await;

                Err(ResolverError::other("stopped"))
            })
        }))
        .expect("registered");

    let port = port_of(&server).await;

    Served {
        server,
        port,
        requested,
    }
}

impl Served {
    async fn request_sent(&self) {
        patience(PATIENCE, self.requested.notified())
            .await
            .expect("a request in time");
    }

    async fn connected(&self) -> HttpClient {
        let client = client_of((false, None));

        connect(&client, self.port).await;

        client
    }
}

fn call_of(
    client: &HttpClient,
    (procedure, value): (&Procedure, &str),
    options: &RequestOptions,
) -> ServiceCall<String> {
    client
        .services()
        .get_request(procedure, asked())
        .expect("a requester")
        .call(value.to_owned(), options)
        .expect("a call")
}

#[derive(Default)]
struct Closes(Mutex<Vec<(bool, bool)>>);

impl ClientListener for Closes {
    fn on_close(&self, was_clean: bool, is_quick: bool) {
        locked(&self.0).push((was_clean, is_quick));
    }
}

// ── What it builds ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn builds_on_an_http_transport_with_the_fetch_it_is_given_one_envelope_per_exchange_and_no_transfer()
 {
    // a server that draws the connection, then answers each request with its payload in upper case
    let script = scripted(Arc::new(|heard: &Heard, _| {
        if heard.body.is_empty() {
            return drawn();
        }

        request_in(&heard.body).map_or_else(
            || answer_of(204, (&[], &[])),
            |(call_id, payload)| {
                let upper = String::from_utf8_lossy(&payload).to_uppercase();

                answer_of(
                    200,
                    (
                        &[("content-type", crate::http::fields::BEAD_MEDIA_TYPE)],
                        &result_of(call_id, upper.as_bytes()),
                    ),
                )
            },
        )
    }))
    .await;
    let client = client_of((
        false,
        Some(crate::router::types::RouterLimitsOptions {
            maximum_envelope_bytes: Some(4_096),
            ..crate::router::types::RouterLimitsOptions::default()
        }),
    ));

    connect(&client, script.port).await;

    assert_eq!(
        ask(&client, (&echo(), "hi"), &RequestOptions::default())
            .await
            .ok(),
        Some("HI".to_owned()),
        "answered"
    );

    let limits = client.router().limits();

    assert_eq!(
        (
            limits.chunk_bytes,
            limits.maximum_envelope_bytes,
            limits.maximum_transfers,
            limits.window_bytes
        ),
        (4_096, 4_096, 0, 8_192),
        "one envelope per exchange, no transfer"
    );
    assert_eq!(
        script
            .heard()
            .iter()
            .map(|heard| heard.line.clone())
            .collect::<Vec<_>>(),
        vec!["POST /bead HTTP/1.1"; 2],
        "a connect, then the request"
    );
    client.dispose().await;
}

#[tokio::test]
async fn builds_with_nothing_given_the_global_fetch_one_envelope_of_the_default_size_no_transfer() {
    let client = HttpClient::new(&HttpClientOptions::default()).expect("a client");
    let limits = client.router().limits();

    assert_eq!(
        (limits.maximum_envelope_bytes, limits.maximum_transfers),
        (
            crate::router::types::LIMIT_DEFAULTS.maximum_envelope_bytes,
            0
        ),
        "the default envelope, no transfer"
    );
    assert_eq!(
        client.transport().ready_state(),
        ReadyState::Uninitialized,
        "not yet connected"
    );
    client.dispose().await;
}

#[tokio::test]
async fn reads_an_answer_no_larger_than_the_envelope_its_router_takes_and_closes_on_one_past_it() {
    let script = scripted(Arc::new(|heard: &Heard, _| {
        if heard.body.is_empty() {
            return drawn();
        }

        answer_of(
            200,
            (
                &[("content-type", crate::http::fields::BEAD_MEDIA_TYPE)],
                &[0; 1_025],
            ),
        )
    }))
    .await;
    let client = client_of((
        false,
        Some(crate::router::types::RouterLimitsOptions {
            maximum_envelope_bytes: Some(1_024),
            ..crate::router::types::RouterLimitsOptions::default()
        }),
    ));

    connect(&client, script.port).await;
    assert!(
        ask(&client, (&echo(), "hi"), &RequestOptions::default())
            .await
            .is_err(),
        "an answer past its envelope fails its call"
    );
    assert!(
        eventually(|| client.transport().ready_state() == ReadyState::Closed).await,
        "closed"
    );
    client.dispose().await;
}

// the C# side's own: its router runs on its transport's clock
#[tokio::test]
async fn runs_its_router_on_its_transport_s_clock_which_times_a_request_out() {
    let served = served().await;
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let client = HttpClient::new(&HttpClientOptions {
        transport: Some(HttpTransportClientOptions {
            clock: Some(Arc::clone(&shared)),
            is_listening: Some(false),
            ..HttpTransportClientOptions::default()
        }),
        ..HttpClientOptions::default()
    })
    .expect("a client");

    assert!(
        Arc::ptr_eq(&client.router().clock(), &shared),
        "its router on its transport's clock"
    );
    connect(&client, served.port).await;

    // its timer is armed before its request goes out
    let slow_call = call_of(
        &client,
        (&slow(), "wait"),
        &RequestOptions {
            timeout: Some(Duration::from_secs(1)),
            ..RequestOptions::default()
        },
    );

    served.request_sent().await;
    clock.advance(Duration::from_secs(1)).await;
    assert!(
        matches!(
            outcome_of(slow_call, PATIENCE).await,
            Err(CallError::TimedOut(_))
        ),
        "timed out"
    );
    client.dispose().await;
    served.server.dispose().await.expect("stopped");
}

// the C# side's own
#[tokio::test]
async fn connects_disconnects_and_reconnects_through_its_transport_with_the_options_given() {
    let served = served().await;
    let client = served.connected().await;
    let closes = Arc::new(Closes::default());

    client.transport().listen(Arc::<Closes>::clone(&closes));
    patience(
        PATIENCE,
        client
            .disconnect(&TransportClientDisconnectOptions {
                is_quick: Some(true),
                ..TransportClientDisconnectOptions::default()
            })
            .expect("open"),
    )
    .await
    .expect("closed in time");
    assert_eq!(*locked(&closes.0), [(true, true)], "its close told");
    assert_eq!(
        client.transport().ready_state(),
        ReadyState::Closed,
        "closed"
    );

    // the signal given reaches the transport, which refuses to start
    let cancelled = CancellationToken::new();

    cancelled.cancel();
    assert!(
        client
            .reconnect(&TransportClientReconnectOptions {
                signal: Some(cancelled),
                ..TransportClientReconnectOptions::default()
            })
            .is_err(),
        "refused"
    );
    assert_eq!(
        client.transport().ready_state(),
        ReadyState::Closed,
        "still closed"
    );
    patience(
        PATIENCE,
        client
            .reconnect(&TransportClientReconnectOptions {
                maximum_attempts: Some(1),
                ..TransportClientReconnectOptions::default()
            })
            .expect("reconnecting"),
    )
    .await
    .expect("in time")
    .expect("reconnected");
    assert_eq!(client.transport().ready_state(), ReadyState::Open, "open");
    assert_eq!(
        ask(&client, (&echo(), "a"), &RequestOptions::default())
            .await
            .ok(),
        Some("a".to_owned()),
        "answered"
    );
    client.dispose().await;
    served.server.dispose().await.expect("stopped");
}

// the C# side's own
#[tokio::test]
async fn a_dispose_cancels_a_reconnection_under_way_and_a_token_given_still_cancels_it_too() {
    let served = served().await;
    let client = served.connected().await;
    let other = served.connected().await;
    let signal = CancellationToken::new();
    let reconnecting = TransportClientReconnectOptions {
        delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_secs(
            60,
        ))),
        ..TransportClientReconnectOptions::default()
    };

    // nothing listens any more: each attempt fails, then waits a minute
    patience(PATIENCE, served.server.dispose())
        .await
        .expect("in time")
        .expect("stopped");

    let by_dispose = client.reconnect(&reconnecting).expect("reconnecting");
    let by_signal = other
        .reconnect(&TransportClientReconnectOptions {
            signal: Some(signal.clone()),
            ..reconnecting.clone()
        })
        .expect("reconnecting");

    client.dispose().await;
    signal.cancel();
    assert!(
        matches!(
            patience(PATIENCE, by_dispose).await.expect("in time"),
            Err(TransportError::Cancelled { .. })
        ),
        "cancelled by its dispose"
    );
    assert!(
        matches!(
            patience(PATIENCE, by_signal).await.expect("in time"),
            Err(TransportError::Cancelled { .. })
        ),
        "cancelled by its signal"
    );
    assert_eq!(
        client.transport().ready_state(),
        ReadyState::Closed,
        "closed"
    );
    assert_eq!(
        other.transport().ready_state(),
        ReadyState::Closed,
        "the other closed"
    );
    other.dispose().await;
}

// the C# side's own
#[tokio::test]
async fn rejects_what_waits_as_replaced_once_its_transport_reconnects() {
    let served = served().await;
    let client = served.connected().await;
    let slow_call = call_of(&client, (&slow(), "wait"), &RequestOptions::default());

    served.request_sent().await;
    patience(
        PATIENCE,
        client
            .reconnect(&TransportClientReconnectOptions::default())
            .expect("reconnecting"),
    )
    .await
    .expect("in time")
    .expect("reconnected");
    assert!(
        matches!(
            outcome_of(slow_call, PATIENCE).await,
            Err(CallError::Disconnected(why)) if why == "the connection was replaced before the answer"
        ),
        "rejected as replaced"
    );
    assert_eq!(client.transport().ready_state(), ReadyState::Open, "open");
    assert_eq!(
        ask(&client, (&echo(), "a"), &RequestOptions::default())
            .await
            .ok(),
        Some("a".to_owned()),
        "answered"
    );
    client.dispose().await;
    served.server.dispose().await.expect("stopped");
}

// this side's own: the client's runtime is its transport's, every layer on it
#[test]
fn hands_its_runtime_to_its_transport_every_layer_on_it() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("a runtime");
    let client = HttpClient::new(&HttpClientOptions {
        client: Some(crate::client::ClientOptions {
            runtime: Some(runtime.handle().clone()),
            ..crate::client::ClientOptions::default()
        }),
        ..HttpClientOptions::default()
    })
    .expect("built outside any runtime, on the one given");
    let served = runtime.block_on(served());

    runtime.block_on(connect(&client, served.port));
    assert_eq!(
        runtime
            .block_on(ask(&client, (&echo(), "a"), &RequestOptions::default()))
            .ok(),
        Some("a".to_owned()),
        "answered"
    );
    runtime.block_on(client.dispose());
    runtime.block_on(served.server.dispose()).expect("stopped");
}
