//! Its guards and its reconnection, which the TypeScript side keeps once, in
//! `createTransportClient`, and the C# side's client keeps a copy of: the WebSocket transport
//! client's twins.

use super::*;
use crate::http::peer::gauge;
use crate::transport::{ServerTransport, TransportClientReconnectDelay};

// the same wait after every failed attempt
fn delay_of(delay: Duration) -> TransportClientReconnectDelay {
    TransportClientReconnectDelay::Fixed(delay)
}

fn is_refused_with(outcome: &Result<(), TransportError>, message: &str) -> bool {
    matches!(outcome, Err(TransportError::Refused(error)) if error.to_string() == message)
}

fn is_cancelled(outcome: &Result<(), TransportError>) -> bool {
    matches!(outcome, Err(TransportError::Cancelled { message, .. }) if message == RECONNECTION_CANCELLED)
}

/// A client of `options` on a server of the tests' own whose connect drew nothing: it failed,
/// ending closed, and its target is the one a reconnection takes.
async fn connect_refused(options: &HttpTransportClientOptions) -> Faked {
    let fake = fake().await;
    let client = client_of(options);
    let told = recorded(&client);
    let connecting = client.connect(&to(fake.port));

    fake.call_of(0).await.answer(&Answer::of(503));

    assert!(
        matches!(settled(connecting).await, Err(TransportError::Connect(_))),
        "refused"
    );

    Faked { client, fake, told }
}

// the delays a tap heard, and their attempts
fn tapping(taps: &Arc<Mutex<Vec<(Duration, u32)>>>) -> Arc<dyn Fn(Duration, u32) + Send + Sync> {
    let keeping = Arc::clone(taps);

    Arc::new(move |delay, attempt| locked(&keeping).push((delay, attempt)))
}

#[tokio::test]
async fn refuses_a_connect_while_open_reaching_no_server() {
    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&not_listening());

    settled(client.connect(&to(server.port))).await.unwrap();

    let refused = settled(client.connect(&to(server.port))).await;

    assert!(
        is_refused_with(&refused, "the transport client is already open"),
        "{refused:?}"
    );
    rest(WHILE).await;
    assert_eq!(
        (
            client.ready_state(),
            server.server.clients().len(),
            server.recorder.told().connections.len()
        ),
        (ReadyState::Open, 1, 1),
        "no server reached"
    );
    client.dispose();
    server.stop().await;
}

// a socket here is a POST, which draws a connection
#[tokio::test]
async fn refuses_a_second_connect_while_the_first_is_connecting_opening_one_socket_only() {
    let fake = fake().await;
    let client = client_of(&not_listening());
    let first = client.connect(&to(fake.port));
    let refused = settled(client.connect(&to(fake.port))).await;

    assert!(
        is_refused_with(&refused, "the transport client is already connecting"),
        "{refused:?}"
    );

    fake.call_of(0).await.answer(&drawn(false));
    settled(first).await.unwrap();

    assert!(fake.makes_no_call_of(1).await, "one socket only");
    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    client.dispose();
}

#[tokio::test]
async fn refuses_a_connect_while_its_close_is_under_way_and_connects_again_once_closed() {
    // under way as long as its DELETE is held, whatever the machine's pace
    let faked = connected(
        fake_of(&ScriptOptions {
            is_delete_held: true,
            ..ScriptOptions::default()
        })
        .await,
        &not_listening(),
    )
    .await;
    let closing = faked
        .client
        .disconnect(&TransportClientDisconnectOptions::default())
        .unwrap();
    let refused = settled(faked.client.connect(&to(faked.fake.port))).await;

    assert!(
        is_refused_with(&refused, "the transport client is already closing"),
        "{refused:?}"
    );

    faked.fake.call_of(1).await.answer(&Answer::of(204));
    within(closing).await;

    let connecting = faked.client.connect(&to(faked.fake.port));

    faked.fake.call_of(2).await.answer(&drawn(false));
    settled(connecting).await.unwrap();

    assert_eq!(faked.client.ready_state(), ReadyState::Open, "open");
    disconnected(&faked.client, &quick()).await;
}

#[tokio::test]
async fn reconnects_after_a_close() {
    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&not_listening());

    settled(client.connect(&to(server.port))).await.unwrap();
    disconnected(&client, &TransportClientDisconnectOptions::default()).await;
    within(
        client
            .reconnect(&TransportClientReconnectOptions {
                delay: Some(delay_of(Duration::from_millis(10))),
                maximum_attempts: Some(1),
                ..TransportClientReconnectOptions::default()
            })
            .unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    client.dispose();
    server.stop().await;
}

#[tokio::test]
async fn reconnects_to_the_target_of_the_last_accepted_connect() {
    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&not_listening());

    settled(client.connect(&to(server.port))).await.unwrap();

    // a target where the server draws no connection: a reconnection that took it would fail
    let refused = settled(client.connect(&HttpTransportClientConnectOptions {
        pathname: Some("/elsewhere".to_owned()),
        ..to(server.port)
    }))
    .await;

    assert!(
        matches!(&refused, Err(TransportError::Refused(_))),
        "{refused:?}"
    );

    within(
        client
            .reconnect(&TransportClientReconnectOptions {
                delay: Some(delay_of(Duration::ZERO)),
                ..TransportClientReconnectOptions::default()
            })
            .unwrap(),
    )
    .await
    .unwrap();
    server
        .recorder
        .until(|told| (told.connections.len() == 2).then_some(()))
        .await;

    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    client.dispose();
    server.stop().await;
}

#[tokio::test]
async fn keeps_no_token_of_a_connect_for_its_reconnections() {
    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&not_listening());
    let signal = CancellationToken::new();

    settled(client.connect(&HttpTransportClientConnectOptions {
        signal: Some(signal.clone()),
        ..to(server.port)
    }))
    .await
    .unwrap();
    signal.cancel();
    within(
        client
            .reconnect(&TransportClientReconnectOptions {
                delay: Some(delay_of(Duration::ZERO)),
                ..TransportClientReconnectOptions::default()
            })
            .unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    client.dispose();
    server.stop().await;
}

#[tokio::test]
async fn refuses_to_reconnect_a_client_never_connected_leaving_it_uninitialized() {
    let client = client_of(&not_listening());
    let refused = client
        .reconnect(&TransportClientReconnectOptions::default())
        .map(drop);

    assert!(
        matches!(&refused, Err(TransportError::Refused(error)) if error.to_string() == "the transport client was never connected"),
        "{refused:?}"
    );
    assert_eq!(
        client.ready_state(),
        ReadyState::Uninitialized,
        "uninitialized"
    );
}

#[tokio::test]
async fn refuses_to_reconnect_while_a_close_is_under_way() {
    // under way as long as its DELETE is held, whatever the machine's pace
    let faked = connected(
        fake_of(&ScriptOptions {
            is_delete_held: true,
            ..ScriptOptions::default()
        })
        .await,
        &not_listening(),
    )
    .await;
    let closing = faked
        .client
        .disconnect(&TransportClientDisconnectOptions::default())
        .unwrap();
    let refused = faked
        .client
        .reconnect(&TransportClientReconnectOptions::default())
        .map(drop);

    assert!(
        matches!(&refused, Err(TransportError::Refused(error)) if error.to_string() == "the transport client cannot reconnect while closing"),
        "{refused:?}"
    );

    faked.fake.call_of(1).await.answer(&Answer::of(204));
    within(closing).await;
}

#[tokio::test]
async fn refuses_to_reconnect_while_a_connect_is_under_way_and_that_connect_still_opens() {
    let fake = fake().await;
    let client = client_of(&not_listening());

    // under way as long as its POST is held, whatever the machine's pace
    let connecting = client.connect(&to(fake.port));
    let held = fake.call_of(0).await;
    let refused = client
        .reconnect(&TransportClientReconnectOptions::default())
        .map(drop);

    assert!(
        matches!(&refused, Err(TransportError::Refused(error)) if error.to_string() == "the transport client cannot reconnect while connecting"),
        "{refused:?}"
    );

    held.answer(&drawn(false));
    settled(connecting).await.unwrap();

    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    client.dispose();
}

#[tokio::test]
async fn refuses_a_second_reconnection_leaving_the_first_alone() {
    let clock = stepping();
    let faked = connect_refused(&HttpTransportClientOptions {
        clock: Some(on_clock(&clock)),
        ..not_listening()
    })
    .await;
    let taps: Arc<Mutex<Vec<(Duration, u32)>>> = Arc::default();
    let first = faked
        .client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(delay_of(Duration::from_millis(20))),
            tap: Some(tapping(&taps)),
            ..TransportClientReconnectOptions::default()
        })
        .unwrap();
    let refused = faked
        .client
        .reconnect(&TransportClientReconnectOptions::default())
        .map(drop);

    assert!(
        matches!(&refused, Err(TransportError::Refused(error)) if error.to_string() == "the transport client is already reconnecting"),
        "{refused:?}"
    );
    assert_eq!(
        faked.client.ready_state(),
        ReadyState::Reconnecting,
        "reconnecting"
    );

    faked.fake.call_of(1).await.answer(&Answer::of(503));
    until(|| !locked(&taps).is_empty()).await;
    clock.advance(Duration::from_millis(20)).await;
    faked.fake.call_of(2).await.answer(&drawn(false));
    within(first).await.unwrap();

    assert_eq!(faked.client.ready_state(), ReadyState::Open, "open");
    // the connect refused, then the first's two attempts: the second made none
    assert_eq!(faked.fake.count(), 3, "two attempts");
}

#[tokio::test]
async fn refuses_a_connect_while_it_waits_to_attempt_again() {
    let clock = stepping();
    let signal = CancellationToken::new();
    let faked = connect_refused(&HttpTransportClientOptions {
        clock: Some(on_clock(&clock)),
        ..not_listening()
    })
    .await;
    let taps: Arc<Mutex<Vec<(Duration, u32)>>> = Arc::default();
    let reconnecting = faked
        .client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(delay_of(Duration::from_mins(1))),
            signal: Some(signal.clone()),
            tap: Some(tapping(&taps)),
            ..TransportClientReconnectOptions::default()
        })
        .unwrap();

    faked.fake.call_of(1).await.answer(&Answer::of(503));
    until(|| !locked(&taps).is_empty()).await;

    let refused = settled(faked.client.connect(&to(faked.fake.port))).await;

    assert!(
        is_refused_with(&refused, "the transport client is already reconnecting"),
        "{refused:?}"
    );

    signal.cancel();

    let cancelled = within(reconnecting).await;

    assert!(is_cancelled(&cancelled), "{cancelled:?}");
    assert_eq!(faked.client.ready_state(), ReadyState::Closed, "closed");
    // the connect refused made no call
    assert!(faked.fake.makes_no_call_of(2).await, "no call");
}

#[tokio::test]
async fn raises_reconnect_once_as_it_starts_open_or_closed_and_not_on_a_misuse() {
    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&not_listening());
    let told = recorded(&client);

    assert!(
        client
            .reconnect(&TransportClientReconnectOptions::default())
            .is_err(),
        "a misuse"
    );
    assert_eq!(told.reconnects(), 0, "not on a misuse");

    settled(client.connect(&to(server.port))).await.unwrap();
    within(
        client
            .reconnect(&TransportClientReconnectOptions::default())
            .unwrap(),
    )
    .await
    .unwrap();
    disconnected(&client, &TransportClientDisconnectOptions::default()).await;
    within(
        client
            .reconnect(&TransportClientReconnectOptions::default())
            .unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(told.reconnects(), 2, "once each");
    client.dispose();
    server.stop().await;
}

#[tokio::test]
async fn throws_a_reconnectexception_carrying_the_last_failure_ending_closed() {
    let faked = connect_refused(&not_listening()).await;
    let reconnecting = faked
        .client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(delay_of(Duration::ZERO)),
            maximum_attempts: Some(2),
            ..TransportClientReconnectOptions::default()
        })
        .unwrap();

    // each refused with a status of its own, which its failure names
    faked.fake.call_of(1).await.answer(&Answer::of(501));
    faked.fake.call_of(2).await.answer(&Answer::of(502));

    let failed = within(reconnecting).await;
    let Err(TransportError::Reconnect(error)) = &failed else {
        panic!("a reconnect error: {failed:?}");
    };

    assert_eq!(error.to_string(), "attempt 2 reached", "its message");
    assert!(
        matches!(
            core::error::Error::source(error)
                .and_then(|cause| cause.downcast_ref::<TransportError>()),
            Some(TransportError::Connect(cause)) if cause.to_string() == "the server drew no connection: 502"
        ),
        "the last failure"
    );
    assert_eq!(faked.client.ready_state(), ReadyState::Closed, "closed");
    // no attempt after the last
    assert!(faked.fake.makes_no_call_of(3).await, "no attempt after");
}

#[tokio::test]
async fn never_attempts_with_a_token_cancelled_already_and_stops_at_the_wait_when_its_tap_cancels()
{
    let cancelled = CancellationToken::new();
    let faked = connected(fake().await, &not_listening()).await;

    cancelled.cancel();

    let refused = faked
        .client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(delay_of(Duration::ZERO)),
            signal: Some(cancelled),
            ..TransportClientReconnectOptions::default()
        })
        .map(drop);

    assert!(is_cancelled(&refused), "{refused:?}");

    // the open connection left alone: never let go of, and none drawn
    assert!(faked.fake.makes_no_call_of(1).await, "no call");
    assert_eq!(
        (faked.client.ready_state(), faked.told.reconnects()),
        (ReadyState::Open, 0),
        "left alone"
    );

    let signal = CancellationToken::new();
    let cancelling = signal.clone();
    let failing = connect_refused(&not_listening()).await;
    let reconnecting = failing
        .client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(delay_of(Duration::from_mins(1))),
            signal: Some(signal),
            tap: Some(Arc::new(move |_delay, _attempt| cancelling.cancel())),
            ..TransportClientReconnectOptions::default()
        })
        .unwrap();

    failing.fake.call_of(1).await.answer(&Answer::of(503));

    let stopped = within(reconnecting).await;

    assert!(is_cancelled(&stopped), "{stopped:?}");
    assert_eq!(failing.client.ready_state(), ReadyState::Closed, "closed");
    assert!(failing.fake.makes_no_call_of(2).await, "no attempt after");
}

// spec 1.4
#[tokio::test]
async fn refuses_a_fixed_delay_out_of_bounds_as_reconnect_is_called_nothing_changed() {
    let faked = connected(fake().await, &not_listening()).await;
    let cancelled = CancellationToken::new();

    cancelled.cancel();

    // * refused as it is called: after its state's guards, before its signal
    for (delay, written) in [
        (Duration::from_micros(400), "0.4 milliseconds"),
        (
            Duration::from_millis(2_147_483_648),
            "2147483648 milliseconds",
        ),
        (NEVER, "Duration::MAX"),
    ] {
        let refused = faked
            .client
            .reconnect(&TransportClientReconnectOptions {
                delay: Some(delay_of(delay)),
                signal: Some(cancelled.clone()),
                ..TransportClientReconnectOptions::default()
            })
            .map(drop);

        assert!(
            is_refused_with(
                &refused,
                &format!(
                    "a delay is 0 for at once, or a duration of whole milliseconds from 1 to 2147483647, not {written}"
                )
            ),
            "{refused:?}"
        );
    }

    // nothing changed: open, no connection drawn, no reconnect told and no close
    assert!(faked.fake.makes_no_call_of(1).await, "no call");
    assert_eq!(
        (
            faked.client.ready_state(),
            faked.told.events(),
            faked.told.reconnects()
        ),
        (ReadyState::Open, Vec::new(), 0),
        "nothing changed"
    );

    // its state's guards first: a client never connected says so
    let never = client_of(&HttpTransportClientOptions::default());
    let refused = never
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(delay_of(NEVER)),
            ..TransportClientReconnectOptions::default()
        })
        .map(drop);

    assert!(
        is_refused_with(&refused, "the transport client was never connected"),
        "{refused:?}"
    );
}

// what its connect met when the server is gone: the server gone is told by the listen it holds,
// which its stop answers, and the attempt after meets a server stopping, which draws no
// connection, or nothing listening at all
#[tokio::test]
async fn throws_a_reconnectexception_from_what_its_connect_threw_when_the_server_is_gone() {
    // a listener that reconnects as the client closes, once
    struct Reconnecting {
        client: HttpTransportClient,
        reconnection: Mutex<Option<BoxFuture<Result<(), TransportError>>>>,
    }

    impl ClientListener for Reconnecting {
        fn on_close(&self, _was_clean: bool, _is_quick: bool) {
            let mut reconnection = locked(&self.reconnection);

            if reconnection.is_none() {
                *reconnection = self
                    .client
                    .reconnect(&TransportClientReconnectOptions {
                        maximum_attempts: Some(1),
                        ..TransportClientReconnectOptions::default()
                    })
                    .ok();
            }
        }
    }

    let server = started(&HttpTransportServerOptions::default()).await;
    let client = client_of(&HttpTransportClientOptions::default());
    let reconnecting = Arc::new(Reconnecting {
        client: client.clone(),
        reconnection: Mutex::default(),
    });

    // from its close, as the TypeScript side's test reconnects; one attempt, for a port nothing
    // listens on takes some systems two seconds to refuse
    client.listen(Arc::<Reconnecting>::clone(&reconnecting));
    settled(client.connect(&to(server.port))).await.unwrap();
    until(|| gauge(&server.server, "listens") == 1).await;
    within(server.server.stop()).await.unwrap();
    until(|| locked(&reconnecting.reconnection).is_some()).await;

    let reconnection = locked(&reconnecting.reconnection).take().unwrap();
    let failed = within(reconnection).await;
    let Err(TransportError::Reconnect(error)) = &failed else {
        panic!("a reconnect error: {failed:?}");
    };

    assert!(
        matches!(
            core::error::Error::source(error)
                .and_then(|cause| cause.downcast_ref::<TransportError>()),
            Some(TransportError::Connect(_))
        ),
        "what its connect threw"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
}
