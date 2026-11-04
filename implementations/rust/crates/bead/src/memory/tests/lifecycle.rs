//! A connect and a reconnection the client's signal or tap ends, and a second start its server
//! refuses, each through the in-memory transport.

use core::time::Duration;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::{Ends, OnConnection, locked, never_started};
use crate::errors::TransportError;
use crate::memory::{MemoryTransportClient, MemoryTransportClientConnectOptions};
use crate::router::types::{ConnectionHandle, RouterError};
use crate::transport::{
    ReadyState, RouterClientTransport, ServerTransport, TransportClientReconnectDelay,
    TransportClientReconnectOptions,
};

// the connects a client made, its reconnection's attempts among them
fn attempts(client: &MemoryTransportClient) -> u64 {
    locked(&client.inner.state).serial
}

fn cancelled() -> CancellationToken {
    let token = CancellationToken::new();
    token.cancel();

    token
}

#[tokio::test]
async fn connect_with_a_signal_already_aborted_rejects_with_a_cancel_error_never_reaching_the_transport()
 {
    let ends = Ends::started().await;
    let (client, _) = ends.client();
    let refused = client
        .connect(&MemoryTransportClientConnectOptions {
            signal: Some(cancelled()),
            ..MemoryTransportClientConnectOptions::new(ends.server.clone())
        })
        .await
        .expect_err("cancelled before it starts");
    ends.clock.settle().await;

    assert!(matches!(refused, TransportError::Cancelled { .. }));
    assert_eq!(ends.server_told(), Vec::<String>::new());
    assert!(ends.server.clients().is_empty(), "none drawn");
    assert_eq!(client.ready_state(), ReadyState::Uninitialized);
    ends.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn passes_on_what_tap_throws_ending_closed_with_no_attempt_after_it_and_no_wait_left_armed() {
    let (clock, client) = never_started().await;
    let refused = client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_millis(
                10,
            ))),
            tap: Some(Arc::new(|_, _| panic!("tap_error"))),
            ..TransportClientReconnectOptions::default()
        })
        .expect("a reconnection")
        .await
        .expect_err("its tap panics");

    assert!(matches!(&refused, TransportError::Refused(_)));
    assert_eq!(refused.to_string(), "tap_error");
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(attempts(&client), 2, "its connect and one attempt");
    assert_eq!(clock.dues(), []);
}

#[tokio::test]
async fn rejects_with_a_cancel_error_without_waiting_out_the_delay_when_the_signal_aborts_mid_wait()
{
    let (clock, client) = never_started().await;
    let signal = CancellationToken::new();
    let aborting = signal.clone();
    let reconnecting = client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_mins(1))),
            signal: Some(signal),
            // after tap, once the wait has begun
            tap: Some(Arc::new(move |_, _| {
                let aborting = aborting.clone();
                drop(crate::testing::spawn(async move { aborting.cancel() }));
            })),
            ..TransportClientReconnectOptions::default()
        })
        .expect("a reconnection");

    // * its clock never moves: the wait is cut short, not waited out
    let refused = reconnecting.await.expect_err("cancelled mid-wait");
    assert!(matches!(&refused, TransportError::Cancelled { .. }));
    assert_eq!(refused.to_string(), "the reconnection was cancelled");
    assert_eq!(attempts(&client), 2);
    assert_eq!(client.ready_state(), ReadyState::Closed);
    assert_eq!(clock.dues(), []);
}

#[tokio::test]
async fn aborts_the_attempt_in_flight_when_the_signal_aborts() {
    let ends = Ends::unstarted();
    let (client, _) = ends.client();
    client
        .connect(&MemoryTransportClientConnectOptions::new(
            ends.server.clone(),
        ))
        .await
        .expect_err("its server not started yet");
    ends.server.start().await.expect("started");

    // * cancelled as its server draws the attempt's connection, before its client hears it open
    let signal = CancellationToken::new();
    let cancel = signal.clone();
    ends.server
        .listen(Arc::new(OnConnection(move |_: &ConnectionHandle| {
            cancel.cancel();
        })));
    let reconnecting = client
        .reconnect(&TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::ZERO)),
            signal: Some(signal),
            ..TransportClientReconnectOptions::default()
        })
        .expect("a reconnection");
    ends.clock.settle().await;

    let refused = reconnecting.await.expect_err("cancelled in flight");
    assert!(matches!(&refused, TransportError::Cancelled { .. }));
    assert_eq!(refused.to_string(), "the reconnection was cancelled");
    assert_eq!(attempts(&client), 2);
    assert_eq!(client.ready_state(), ReadyState::Closed);
    ends.clock.settle().await;
    assert!(ends.server.clients().is_empty(), "none held");
    ends.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn rejects_a_second_start_with_a_programmer_error_without_reaching_the_transport() {
    let ends = Ends::started().await;
    let (_client, _) = ends.connected((None, None)).await;
    ends.server_told();
    let refused = ends.server.start().await.expect_err("started already");

    assert!(
        matches!(&refused, RouterError::Other(error) if error.to_string() == "the transport server is already open")
    );
    assert_eq!(ends.server.ready_state(), ReadyState::Open);
    assert_eq!(ends.server.clients().len(), 1, "its connection kept");
    assert_eq!(ends.server_told(), Vec::<String>::new());
    ends.server.stop().await.expect("stopped");
}
