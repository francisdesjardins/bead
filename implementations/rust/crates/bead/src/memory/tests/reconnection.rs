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
