//! The common reconnect loop through a real memory client, with each source delay and ending.

use core::sync::atomic::{AtomicUsize, Ordering};
use core::time::Duration;
use std::sync::{Arc, Mutex};

use super::{Ends, OnReconnect, locked, never_started};
use crate::errors::TransportError;
use crate::memory::MemoryTransportClientConnectOptions;
use crate::transport::{
    ReadyState, RouterClientTransport, ServerTransport, TransportClientDisconnectOptions,
    TransportClientReconnectDelay, TransportClientReconnectOptions,
};

fn attempts(client: &crate::memory::MemoryTransportClient) -> u64 {
    locked(&client.inner.state).serial
}

#[tokio::test]
async fn makes_its_first_attempt_at_once() {
    let ends = Ends::started().await;
    let (client, _) = ends.connected((None, None)).await;

    client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_secs(
                60,
            ))),
            ..TransportClientReconnectOptions::default()
        })
        .expect("a reconnection")
        .await
        .expect("connected without advancing the clock");

    assert_eq!(attempts(&client), 2);
    assert_eq!(client.ready_state(), ReadyState::Open);
    assert_eq!(ends.clock.dues(), []);
    assert_eq!(
        ends.server_told(),
        [
            format!("connection {}", super::FIRST),
            format!("closed {} false", super::FIRST),
            format!("connection {}", super::SECOND),
        ]
    );
    client.dispose();
    ends.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn always_makes_one_attempt_even_with_a_maximum_of_zero() {
    let (clock, client) = never_started().await;
    let failed = client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::ZERO)),
            maximum_attempts: Some(0),
            ..TransportClientReconnectOptions::default()
        })
        .expect("a reconnection")
        .await
        .expect_err("the server refuses the first attempt");

    assert!(matches!(failed, TransportError::Reconnect(_)));
    assert_eq!(
        attempts(&client),
        2,
        "the connect and one reconnect attempt"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(clock.dues(), []);
}

#[tokio::test]
async fn makes_five_attempts_a_second_apart_when_told_nothing() {
    let (clock, client) = never_started().await;
    let taps = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&taps);
    let reconnecting = crate::testing::spawn(
        client
            .reconnect(&TransportClientReconnectOptions {
                tap: Some(Arc::new(move |delay, attempt| {
                    locked(&hearing).push((delay, attempt));
                })),
                ..TransportClientReconnectOptions::default()
            })
            .expect("a reconnection"),
    );

    clock.settle().await;
    for attempt in 1..=4 {
        assert_eq!(attempts(&client), attempt + 1);
        assert_eq!(clock.dues(), [Duration::from_secs(1)]);
        clock.advance(Duration::from_secs(1)).await;
    }
    let failure = reconnecting
        .await
        .expect("settled")
        .expect_err("the fifth attempt fails");

    assert!(matches!(&failure, TransportError::Reconnect(error) if error.attempts() == 5));
    assert_eq!(failure.to_string(), "attempt 5 reached");
    assert_eq!(
        *locked(&taps),
        [1, 2, 3, 4].map(|attempt| (Duration::from_secs(1), attempt))
    );
    assert_eq!(attempts(&client), 6);
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(clock.dues(), []);
}

#[tokio::test]
async fn tells_tap_the_wait_and_the_attempt_that_failed_and_nothing_when_the_first_one_succeeds() {
    let ends = Ends::started().await;
    let (client, _) = ends.connected((None, None)).await;
    let taps = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&taps);
    let options = TransportClientReconnectOptions {
        delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_millis(
            10,
        ))),
        tap: Some(Arc::new(move |delay, attempt| {
            locked(&hearing).push((delay, attempt));
        })),
        ..TransportClientReconnectOptions::default()
    };

    client
        .reconnect(&options)
        .expect("a reconnection")
        .await
        .expect("its first attempt succeeds");
    assert!(locked(&taps).is_empty());
    client.dispose();
    ends.server.stop().await.expect("stopped");

    let failing = Ends::unstarted();
    let (client, _) = failing.client();
    assert!(matches!(
        client
            .connect(&MemoryTransportClientConnectOptions::new(
                failing.server.clone()
            ))
            .await,
        Err(TransportError::Connect(_))
    ));
    let reconnecting = crate::testing::spawn(client.reconnect(&options).expect("a reconnection"));
    failing.clock.settle().await;
    assert_eq!(*locked(&taps), [(Duration::from_millis(10), 1)]);
    assert_eq!(attempts(&client), 2);
    failing
        .server
        .start()
        .await
        .expect("the next attempt can open");
    failing.clock.advance(Duration::from_millis(10)).await;
    reconnecting.await.expect("settled").expect("connected");
    assert_eq!(*locked(&taps), [(Duration::from_millis(10), 1)]);
    assert_eq!(attempts(&client), 3);
    assert_eq!(client.ready_state(), ReadyState::Open);
    client.dispose();
    failing.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn connect_during_the_wait_rejects_with_a_programmer_error() {
    let ends = Ends::unstarted();
    let (client, _) = ends.client();
    assert!(
        client
            .connect(&MemoryTransportClientConnectOptions::new(
                ends.server.clone()
            ))
            .await
            .is_err()
    );
    let signal = tokio_util::sync::CancellationToken::new();
    let reconnecting = crate::testing::spawn(
        client
            .reconnect(&TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_secs(
                    60,
                ))),
                signal: Some(signal.clone()),
                ..TransportClientReconnectOptions::default()
            })
            .expect("a reconnection"),
    );
    ends.clock.settle().await;
    assert_eq!(ends.clock.dues(), [Duration::from_secs(60)]);
    let error = client
        .connect(&MemoryTransportClientConnectOptions::new(
            ends.server.clone(),
        ))
        .await
        .expect_err("the reconnection holds the client");

    assert!(matches!(&error, TransportError::Refused(_)));
    assert_eq!(
        error.to_string(),
        "the transport client is already reconnecting"
    );
    assert_eq!(attempts(&client), 2);
    signal.cancel();
    let cancelled = reconnecting.await.expect("settled").expect_err("cancelled");
    assert!(matches!(&cancelled, TransportError::Cancelled { .. }));
    assert_eq!(cancelled.to_string(), "the reconnection was cancelled");
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(ends.clock.dues(), []);
    assert_eq!(ends.server_told(), Vec::<String>::new());
}

#[tokio::test]
async fn does_not_keep_the_signal_of_a_connect_for_its_reconnections() {
    let ends = Ends::started().await;
    let (client, _) = ends.client();
    let signal = tokio_util::sync::CancellationToken::new();
    client
        .connect(&MemoryTransportClientConnectOptions {
            signal: Some(signal.clone()),
            ..MemoryTransportClientConnectOptions::new(ends.server.clone())
        })
        .await
        .expect("connected");
    signal.cancel();
    client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::ZERO)),
            ..TransportClientReconnectOptions::default()
        })
        .expect("a reconnection with its own signal")
        .await
        .expect("connected anew");

    assert_eq!(attempts(&client), 2);
    assert_eq!(client.ready_state(), ReadyState::Open);
    client.dispose();
    ends.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn rejects_with_a_programmer_error_ending_closed_when_delay_throws() {
    let (clock, client) = never_started().await;
    let error = client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Resolver(Arc::new(|_, _| {
                panic!("decay_error");
            }))),
            ..TransportClientReconnectOptions::default()
        })
        .expect("a reconnection")
        .await
        .expect_err("the delay panics");

    assert!(matches!(&error, TransportError::Refused(_)));
    assert_eq!(error.to_string(), "decay_error");
    assert_eq!(attempts(&client), 2);
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(clock.dues(), []);
}

#[tokio::test]
async fn connect_on_an_open_client_rejects_without_reaching_the_transport() {
    let ends = Ends::started().await;
    let (client, _) = ends.connected((Some("h"), Some(1))).await;
    let error = client
        .connect(&MemoryTransportClientConnectOptions {
            address: Some("h".to_owned()),
            port: Some(2),
            ..MemoryTransportClientConnectOptions::new(ends.server.clone())
        })
        .await
        .expect_err("already open");

    assert!(matches!(&error, TransportError::Refused(_)));
    assert_eq!(error.to_string(), "the transport client is already open");
    assert_eq!(attempts(&client), 1);
    assert_eq!(client.ready_state(), ReadyState::Open);
    assert_eq!(
        ends.server_told(),
        ["connection type=MEMORY;ip=h;ordinal=1"]
    );
    assert_eq!(ends.server.clients().len(), 1);
    assert_eq!(ends.server.clients()[0].port, Some(1));
    client.dispose();
    ends.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn connect_while_closing_rejects_without_reaching_the_transport() {
    let ends = Ends::started().await;
    let (client, _) = ends.connected((None, Some(1))).await;
    locked(&client.inner.state).ready = ReadyState::Closing;
    let error = client
        .connect(&MemoryTransportClientConnectOptions::new(
            ends.server.clone(),
        ))
        .await
        .expect_err("already closing");

    assert!(matches!(&error, TransportError::Refused(_)));
    assert_eq!(error.to_string(), "the transport client is already closing");
    assert_eq!(attempts(&client), 1);
    assert_eq!(client.ready_state(), ReadyState::Closing);
    assert_eq!(ends.server_told(), [format!("connection {}", super::FIRST)]);
    assert_eq!(ends.server.clients().len(), 1);
    client.dispose();
    ends.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn rejects_with_a_programmer_error_while_connecting() {
    let ends = Ends::started().await;
    let (client, _) = ends.connected((None, None)).await;
    locked(&client.inner.state).ready = ReadyState::Connecting;
    let error = client
        .reconnect(&TransportClientReconnectOptions::default())
        .err()
        .expect("cannot reconnect while connecting");

    assert!(matches!(&error, TransportError::Refused(_)));
    assert_eq!(
        error.to_string(),
        "the transport client cannot reconnect while connecting"
    );
    assert_eq!(attempts(&client), 1);
    assert_eq!(client.ready_state(), ReadyState::Connecting);
    assert_eq!(ends.server_told(), [format!("connection {}", super::FIRST)]);
    client.dispose();
    ends.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn rejects_with_a_programmer_error_while_closing() {
    let ends = Ends::started().await;
    let (client, _) = ends.connected((None, None)).await;
    locked(&client.inner.state).ready = ReadyState::Closing;
    let error = client
        .reconnect(&TransportClientReconnectOptions::default())
        .err()
        .expect("cannot reconnect while closing");

    assert!(matches!(&error, TransportError::Refused(_)));
    assert_eq!(
        error.to_string(),
        "the transport client cannot reconnect while closing"
    );
    assert_eq!(attempts(&client), 1);
    assert_eq!(client.ready_state(), ReadyState::Closing);
    assert_eq!(ends.server_told(), [format!("connection {}", super::FIRST)]);
    client.dispose();
    ends.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn reuses_the_options_of_the_last_accepted_connect_disposing_an_open_protocol_first() {
    let ends = Ends::started().await;
    let (client, _) = ends.connected((Some("h"), Some(7))).await;
    let error = client
        .connect(&MemoryTransportClientConnectOptions {
            address: Some("h".to_owned()),
            port: Some(8),
            ..MemoryTransportClientConnectOptions::new(ends.server.clone())
        })
        .await
        .expect_err("the replacement connect is refused");
    assert!(matches!(error, TransportError::Refused(_)));
    client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::ZERO)),
            ..TransportClientReconnectOptions::default()
        })
        .expect("a reconnection")
        .await
        .expect("the accepted target opens again");
    ends.clock.settle().await;

    assert_eq!(client.ready_state(), ReadyState::Open);
    assert_eq!(attempts(&client), 2);
    assert_eq!(
        ends.server_told(),
        [
            "connection type=MEMORY;ip=h;ordinal=1",
            "closed type=MEMORY;ip=h;ordinal=1 false",
            "connection type=MEMORY;ip=h;ordinal=2",
        ]
    );
    assert_eq!(ends.server.clients().len(), 1);
    assert_eq!(ends.server.clients()[0].port, Some(7));
    client.dispose();
    ends.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn a_connect_refused_after_a_close_keeps_the_target_before_it_which_a_reconnection_replays() {
    let ends = Ends::started().await;
    let (client, _) = ends.connected((Some("h"), Some(7))).await;
    client
        .disconnect(&TransportClientDisconnectOptions::default())
        .expect("disconnected");
    let error = client
        .connect(&MemoryTransportClientConnectOptions {
            address: Some("h".to_owned()),
            port: Some(8),
            timeout: Some(Duration::from_micros(500)),
            ..MemoryTransportClientConnectOptions::new(ends.server.clone())
        })
        .await
        .expect_err("half a millisecond is no timeout");

    assert!(matches!(&error, TransportError::Refused(_)));
    assert_eq!(
        error.to_string(),
        "a connect's timeout is a duration of whole milliseconds from 1 to 2147483647, or Duration::MAX for never, not 0.5 milliseconds"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed);
    client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::ZERO)),
            ..TransportClientReconnectOptions::default()
        })
        .expect("a reconnection")
        .await
        .expect("connected to the accepted target");
    ends.clock.settle().await;

    assert_eq!(client.ready_state(), ReadyState::Open);
    assert_eq!(attempts(&client), 2);
    assert_eq!(
        ends.server_told(),
        [
            "connection type=MEMORY;ip=h;ordinal=1",
            "closed type=MEMORY;ip=h;ordinal=1 true",
            "connection type=MEMORY;ip=h;ordinal=2",
        ]
    );
    assert_eq!(ends.server.clients().len(), 1);
    assert_eq!(ends.server.clients()[0].port, Some(7));
    client.dispose();
    ends.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn hands_its_delay_function_the_wait_before_and_the_attempt_that_failed() {
    let (clock, client) = never_started().await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seeing = Arc::clone(&seen);
    let options = TransportClientReconnectOptions {
        delay: Some(TransportClientReconnectDelay::Resolver(Arc::new(
            move |previous, attempt| {
                locked(&seeing).push((previous, attempt));
                previous.unwrap_or(Duration::from_millis(5)) * 2
            },
        ))),
        maximum_attempts: Some(4),
        ..TransportClientReconnectOptions::default()
    };
    let reconnecting = crate::testing::spawn(client.reconnect(&options).expect("a reconnection"));
    clock.settle().await;
    for delay in [10, 20, 40] {
        assert_eq!(clock.dues(), [Duration::from_millis(delay)]);
        clock.advance(Duration::from_millis(delay)).await;
    }
    assert!(matches!(
        reconnecting.await.expect("the reconnection settled"),
        Err(TransportError::Reconnect(error)) if error.attempts() == 4
    ));
    assert_eq!(
        *locked(&seen),
        [
            (None, 1),
            (Some(Duration::from_millis(10)), 2),
            (Some(Duration::from_millis(20)), 3),
        ]
    );
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(clock.dues(), []);
}

#[tokio::test]
async fn emits_reconnect_once_as_it_starts_open_or_closed_and_not_on_a_misuse() {
    let ends = Ends::started().await;
    let (client, _told) = ends.client();
    let reconnects = Arc::new(AtomicUsize::new(0));
    let hearing = Arc::clone(&reconnects);
    client.listen(Arc::new(OnReconnect(move || {
        hearing.fetch_add(1, Ordering::SeqCst);
    })));
    assert!(matches!(
        client.reconnect(&TransportClientReconnectOptions::default()),
        Err(TransportError::Refused(_))
    ));
    assert_eq!(reconnects.load(Ordering::SeqCst), 0);
    client
        .connect(&MemoryTransportClientConnectOptions::new(
            ends.server.clone(),
        ))
        .await
        .expect("connected");
    client
        .reconnect(&TransportClientReconnectOptions::default())
        .expect("a reconnection from open")
        .await
        .expect("connected anew");
    client
        .disconnect(&TransportClientDisconnectOptions::default())
        .expect("disconnected");
    client
        .reconnect(&TransportClientReconnectOptions::default())
        .expect("a reconnection from closed")
        .await
        .expect("connected anew");
    assert_eq!(reconnects.load(Ordering::SeqCst), 2);
    client.dispose();
    ends.server.stop().await.expect("stopped");
}
