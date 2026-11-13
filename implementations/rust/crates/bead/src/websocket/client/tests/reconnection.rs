//! The WebSocket client's reconnection guards and clock, the C# client's owed twins.

use super::*;
use crate::TransportClientReconnectDelay;

#[tokio::test]
async fn throws_a_reconnect_exception_carrying_the_last_failure_ending_closed() {
    const NOT_IMPLEMENTED: &str =
        "HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
    let server = hearing(Some(NOT_IMPLEMENTED)).await;
    let client = client();
    let refusing = Arc::clone(&server.refusal);

    assert!(settled(client.connect(&to(server.port))).await.is_err());
    let failed = reconnected(
        &client,
        &TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::ZERO)),
            maximum_attempts: Some(2),
            tap: Some(Arc::new(move |_, _| {
                *refusing.lock().unwrap() = Some(BAD_GATEWAY);
            })),
            ..TransportClientReconnectOptions::default()
        },
    )
    .await;
    let Err(TransportError::Reconnect(error)) = failed else {
        panic!("two refused attempts");
    };

    assert_eq!(error.to_string(), "attempt 2 reached");
    assert!(matches!(
        error
            .source()
            .and_then(|cause| cause.downcast_ref::<TransportError>()),
        Some(TransportError::Connect(_))
    ));
    assert!(
        error.source().unwrap().to_string().contains("502"),
        "the second failure"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(server.accepted.load(Ordering::SeqCst), 3);
    client.dispose();
}

#[tokio::test]
async fn waits_its_delay_after_each_failed_attempt_connecting_once_per_attempt() {
    let server = hearing(Some(BAD_GATEWAY)).await;
    let clock = stepping();
    let client = stepping_client(&clock);
    let (tapped, mut taps) = mpsc::unbounded_channel();
    let delay = Duration::from_millis(60);

    assert!(settled(client.connect(&to(server.port))).await.is_err());
    let reconnecting = client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(delay)),
            tap: Some(Arc::new(move |delay, attempt| {
                tapped.send((delay, attempt)).unwrap();
            })),
            ..TransportClientReconnectOptions::default()
        })
        .unwrap();
    for attempt in 1..=2 {
        assert_eq!(
            patience(PATIENCE, taps.recv()).await.unwrap(),
            Some((delay, attempt))
        );
        assert_eq!(
            server.accepted.load(Ordering::SeqCst),
            usize::try_from(attempt).unwrap() + 1
        );
        assert!(clock.dues().contains(&delay));
        clock.advance(Duration::from_millis(59)).await;
        assert_eq!(
            server.accepted.load(Ordering::SeqCst),
            usize::try_from(attempt).unwrap() + 1,
            "none before its wait"
        );
        if attempt == 2 {
            *server.refusal.lock().unwrap() = None;
        }
        clock.advance(Duration::from_millis(1)).await;
    }
    patience(PATIENCE, reconnecting).await.unwrap().unwrap();
    assert_eq!(client.ready_state(), ReadyState::Open);
    assert_eq!(
        server.accepted.load(Ordering::SeqCst),
        4,
        "at 0, 60 and 120 milliseconds"
    );
    client.dispose();
}

#[tokio::test]
async fn tells_its_tap_the_wait_and_the_attempt_that_failed_and_nothing_when_the_first_succeeds() {
    let server = hearing(None).await;
    let client = client();
    let (tapped, mut taps) = mpsc::unbounded_channel();
    let refusing = Arc::clone(&server.refusal);
    let options = TransportClientReconnectOptions {
        delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_millis(
            10,
        ))),
        tap: Some(Arc::new(move |delay, attempt| {
            *refusing.lock().unwrap() = None;
            tapped.send((delay, attempt)).unwrap();
        })),
        ..TransportClientReconnectOptions::default()
    };

    settled(client.connect(&to(server.port))).await.unwrap();
    reconnected(&client, &options).await.unwrap();
    assert!(taps.try_recv().is_err(), "nothing when the first succeeds");
    *server.refusal.lock().unwrap() = Some(BAD_GATEWAY);
    reconnected(&client, &options).await.unwrap();
    assert_eq!(taps.try_recv().unwrap(), (Duration::from_millis(10), 1));
    assert!(taps.try_recv().is_err(), "one failure alone");
    client.dispose();
}

#[tokio::test]
async fn refuses_a_second_reconnection_leaving_the_first_alone() {
    let server = hearing(Some(BAD_GATEWAY)).await;
    let clock = stepping();
    let client = stepping_client(&clock);
    let (tapped, mut taps) = mpsc::unbounded_channel();

    assert!(settled(client.connect(&to(server.port))).await.is_err());
    let first = client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_millis(
                20,
            ))),
            tap: Some(Arc::new(move |delay, attempt| {
                tapped.send((delay, attempt)).unwrap();
            })),
            ..TransportClientReconnectOptions::default()
        })
        .unwrap();
    assert!(
        matches!(client.reconnect(&TransportClientReconnectOptions::default()), Err(TransportError::Refused(error)) if error.message() == "the transport client is already reconnecting")
    );
    assert_eq!(client.ready_state(), ReadyState::Reconnecting);
    assert_eq!(
        patience(PATIENCE, taps.recv()).await.unwrap(),
        Some((Duration::from_millis(20), 1))
    );
    *server.refusal.lock().unwrap() = None;
    clock.advance(Duration::from_millis(20)).await;
    patience(PATIENCE, first).await.unwrap().unwrap();
    assert_eq!(client.ready_state(), ReadyState::Open);
    assert_eq!(
        server.accepted.load(Ordering::SeqCst),
        3,
        "the second made none"
    );
    client.dispose();
}

#[tokio::test]
async fn refuses_a_connect_while_it_waits_to_attempt_again() {
    let server = hearing(Some(BAD_GATEWAY)).await;
    let client = client();
    let signal = CancellationToken::new();
    let (tapped, mut taps) = mpsc::unbounded_channel();

    assert!(settled(client.connect(&to(server.port))).await.is_err());
    let reconnecting = client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_secs(
                60,
            ))),
            signal: Some(signal.clone()),
            tap: Some(Arc::new(move |_, _| {
                tapped.send(()).unwrap();
            })),
            ..TransportClientReconnectOptions::default()
        })
        .unwrap();
    patience(PATIENCE, taps.recv()).await.unwrap().unwrap();
    assert!(
        matches!(settled(client.connect(&to(server.port))).await, Err(TransportError::Refused(error)) if error.message() == "the transport client is already reconnecting")
    );
    signal.cancel();
    assert!(is_cancelled(
        &patience(PATIENCE, reconnecting).await.unwrap()
    ));
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(
        server.accepted.load(Ordering::SeqCst),
        2,
        "the refused connect made none"
    );
    client.dispose();
}

#[tokio::test]
async fn arms_its_wait_before_its_tap_hears_it_so_a_tap_that_moves_the_clock_by_the_wait_lets_the_next_attempt_follow_with_no_other_move()
 {
    let server = hearing(Some(BAD_GATEWAY)).await;
    let clock = stepping();
    let client = stepping_client(&clock);
    let advancing = Arc::clone(&clock);
    let refusing = Arc::clone(&server.refusal);

    assert!(settled(client.connect(&to(server.port))).await.is_err());
    reconnected(
        &client,
        &TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_millis(
                60,
            ))),
            tap: Some(Arc::new(move |delay, _| {
                *refusing.lock().unwrap() = None;
                advancing.tick(delay);
            })),
            ..TransportClientReconnectOptions::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(client.ready_state(), ReadyState::Open);
    assert_eq!(server.accepted.load(Ordering::SeqCst), 3);
    client.dispose();
    assert_eq!(clock.dues(), []);
}

#[tokio::test]
async fn passes_on_what_its_tap_throws_ending_closed_with_no_attempt_after_it_and_no_wait_left_armed()
 {
    let server = hearing(Some(BAD_GATEWAY)).await;
    let clock = stepping();
    let client = stepping_client(&clock);

    assert!(settled(client.connect(&to(server.port))).await.is_err());
    let failed = reconnected(
        &client,
        &TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_millis(
                10,
            ))),
            tap: Some(Arc::new(|_, _| {
                panic!("tap_error");
            })),
            ..TransportClientReconnectOptions::default()
        },
    )
    .await;
    assert!(
        matches!(failed, Err(TransportError::Refused(error)) if error.message() == "tap_error")
    );
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(clock.dues(), []);
    clock.advance(Duration::from_secs(1)).await;
    assert_eq!(server.accepted.load(Ordering::SeqCst), 2);
    client.dispose();
}

#[tokio::test]
async fn throws_an_invalid_operation_exception_ending_closed_when_its_delay_throws() {
    let server = hearing(Some(BAD_GATEWAY)).await;
    let client = client();

    assert!(settled(client.connect(&to(server.port))).await.is_err());
    let failed = reconnected(
        &client,
        &TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Resolver(Arc::new(|_, _| {
                panic!("decay_error");
            }))),
            ..TransportClientReconnectOptions::default()
        },
    )
    .await;
    assert!(
        matches!(failed, Err(TransportError::Refused(error)) if error.message() == "decay_error")
    );
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(server.accepted.load(Ordering::SeqCst), 2);
    client.dispose();
}

#[tokio::test]
async fn throws_an_operation_canceled_exception_without_waiting_out_its_delay_when_cancelled_mid_wait()
 {
    let server = hearing(Some(BAD_GATEWAY)).await;
    let clock = stepping();
    let client = stepping_client(&clock);
    let signal = CancellationToken::new();
    let (tapped, mut taps) = mpsc::unbounded_channel();

    assert!(settled(client.connect(&to(server.port))).await.is_err());
    let reconnecting = client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_secs(
                60,
            ))),
            signal: Some(signal.clone()),
            tap: Some(Arc::new(move |_, _| {
                tapped.send(()).unwrap();
            })),
            ..TransportClientReconnectOptions::default()
        })
        .unwrap();
    patience(PATIENCE, taps.recv()).await.unwrap().unwrap();
    assert!(clock.dues().contains(&Duration::from_secs(60)));
    signal.cancel();
    assert!(is_cancelled(
        &patience(PATIENCE, reconnecting).await.unwrap()
    ));
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(clock.dues(), []);
    assert_eq!(server.accepted.load(Ordering::SeqCst), 2);
    client.dispose();
}

#[tokio::test]
async fn cancels_the_attempt_in_flight_when_its_token_is_cancelled() {
    let mut server = holding().await;
    let client = client();
    let initial = CancellationToken::new();
    let connecting = client.connect(&WebSocketTransportClientConnectOptions {
        signal: Some(initial.clone()),
        ..to(server.port)
    });
    let _first = server.next().await;

    initial.cancel();
    assert!(is_cancelled(&settled(connecting).await));
    let signal = CancellationToken::new();
    let reconnecting = client
        .reconnect(&TransportClientReconnectOptions {
            signal: Some(signal.clone()),
            ..TransportClientReconnectOptions::default()
        })
        .unwrap();
    let mut peer = server.next().await;

    head_of(&mut peer).await;
    signal.cancel();
    assert!(is_cancelled(
        &patience(PATIENCE, reconnecting).await.unwrap()
    ));
    assert_eq!(client.ready_state(), ReadyState::Closed);
    let mut byte = [0_u8; 1];

    assert_eq!(
        patience(PATIENCE, peer.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0,
        "the handshake's socket ended"
    );
    client.dispose();
}

#[tokio::test]
async fn raises_reconnect_once_as_it_starts_open_or_closed_and_not_on_a_misuse() {
    let server = hearing(None).await;
    let client = client();
    let told = recorded(&client);

    assert!(
        client
            .reconnect(&TransportClientReconnectOptions::default())
            .is_err()
    );
    assert_eq!(told.told.lock().unwrap().reconnects, 0);
    settled(client.connect(&to(server.port))).await.unwrap();
    reconnected(&client, &TransportClientReconnectOptions::default())
        .await
        .unwrap();
    disconnected(&client).await.unwrap();
    reconnected(&client, &TransportClientReconnectOptions::default())
        .await
        .unwrap();
    assert_eq!(told.told.lock().unwrap().reconnects, 2);
    assert_eq!(client.ready_state(), ReadyState::Open);
    client.dispose();
}

#[tokio::test]
async fn a_connect_refused_after_a_close_keeps_the_target_before_it_which_a_reconnection_replays() {
    let server = hearing(None).await;
    let client = client();

    settled(client.connect(&to(server.port))).await.unwrap();
    disconnected(&client).await.unwrap();
    assert!(matches!(
        settled(client.connect(&WebSocketTransportClientConnectOptions {
            timeout: Some(Duration::from_micros(500)),
            ..to(closed_port().await)
        }))
        .await,
        Err(TransportError::Refused(_))
    ));
    assert_eq!(client.ready_state(), ReadyState::Closed);
    reconnected(&client, &reconnecting_by((Duration::ZERO, 5)))
        .await
        .unwrap();
    assert_eq!(client.ready_state(), ReadyState::Open);
    assert_eq!(server.accepted.load(Ordering::SeqCst), 2);
    client.dispose();
}

#[tokio::test]
async fn keeps_no_token_of_a_connect_for_its_reconnections() {
    let server = hearing(None).await;
    let client = client();
    let signal = CancellationToken::new();

    settled(client.connect(&WebSocketTransportClientConnectOptions {
        signal: Some(signal.clone()),
        ..to(server.port)
    }))
    .await
    .unwrap();
    signal.cancel();
    reconnected(&client, &reconnecting_by((Duration::ZERO, 5)))
        .await
        .unwrap();
    assert_eq!(client.ready_state(), ReadyState::Open);
    assert_eq!(server.accepted.load(Ordering::SeqCst), 2);
    client.dispose();
}

#[tokio::test]
async fn refuses_to_reconnect_a_client_never_connected_leaving_it_uninitialized() {
    let client = client();

    assert!(
        matches!(client.reconnect(&TransportClientReconnectOptions::default()), Err(TransportError::Refused(error)) if error.message() == "the transport client was never connected")
    );
    assert_eq!(client.ready_state(), ReadyState::Uninitialized);
    client.close().await;
}

#[tokio::test]
async fn makes_its_first_attempt_at_once() {
    let server = hearing(None).await;
    let clock = stepping();
    let client = stepping_client(&clock);

    settled(client.connect(&to(server.port))).await.unwrap();
    reconnected(
        &client,
        &TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_secs(
                60,
            ))),
            ..TransportClientReconnectOptions::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(client.ready_state(), ReadyState::Open);
    assert_eq!(server.accepted.load(Ordering::SeqCst), 2);
    assert_eq!(crate::clock::Clock::monotonic(&*clock), Duration::ZERO);
    client.dispose();
}

#[tokio::test]
async fn always_makes_one_attempt_even_with_a_maximum_of_zero() {
    let server = hearing(Some(BAD_GATEWAY)).await;
    let client = client();

    assert!(settled(client.connect(&to(server.port))).await.is_err());
    let failed = reconnected(&client, &reconnecting_by((Duration::ZERO, 0))).await;

    assert!(matches!(failed, Err(TransportError::Reconnect(_))));
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(
        server.accepted.load(Ordering::SeqCst),
        2,
        "one attempt after its connect"
    );
    client.dispose();
}

#[tokio::test]
async fn makes_five_attempts_a_second_apart_when_told_nothing() {
    let server = hearing(Some(BAD_GATEWAY)).await;
    let clock = stepping();
    let client = stepping_client(&clock);
    let (tapped, mut taps) = mpsc::unbounded_channel();

    assert!(settled(client.connect(&to(server.port))).await.is_err());
    let reconnecting = client
        .reconnect(&TransportClientReconnectOptions {
            tap: Some(Arc::new(move |delay, attempt| {
                tapped.send((delay, attempt)).unwrap();
            })),
            ..TransportClientReconnectOptions::default()
        })
        .unwrap();
    for attempt in 1..5 {
        assert_eq!(
            patience(PATIENCE, taps.recv()).await.unwrap(),
            Some((Duration::from_secs(1), attempt))
        );
        assert_eq!(
            server.accepted.load(Ordering::SeqCst),
            usize::try_from(attempt).unwrap() + 1
        );
        clock.advance(Duration::from_secs(1)).await;
    }
    let failed = patience(PATIENCE, reconnecting).await.unwrap();

    assert!(matches!(failed, Err(TransportError::Reconnect(error)) if error.attempts() == 5));
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(server.accepted.load(Ordering::SeqCst), 6);
    assert_eq!(clock.dues(), []);
    taps.try_recv().expect_err("no tap after the last attempt");
    client.dispose();
}
