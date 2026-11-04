//! The server's snapshots, unknown handles and the connections its stop forgets.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use super::{Ends, FIRST, MemoryTransportClient, message_of, taken};
use crate::router::types::{ConnectionHandle, Gauges};
use crate::transport::{ReadyState, ServerTransport, TransportServerClient};

fn handles(clients: &[TransportServerClient]) -> Vec<ConnectionHandle> {
    clients
        .iter()
        .map(|client| Arc::clone(&client.connection_handle))
        .collect()
}

fn handle((address, ordinal): (&str, u32)) -> ConnectionHandle {
    Arc::from(format!("type=MEMORY;ip={address};ordinal={ordinal}"))
}

#[tokio::test]
async fn clients_is_a_copy_without_the_sockets() {
    let ends = Ends::started().await;
    let (first, _) = ends.connected((Some("127.0.0.1"), Some(1))).await;
    let a = handle(("127.0.0.1", 1));
    let mut clients = ends.server.clients();
    assert_eq!(
        clients,
        [TransportServerClient {
            connection_handle: Arc::clone(&a),
            address: "127.0.0.1".to_owned(),
            port: Some(1),
            last_activity: None,
            transport_type: crate::memory::TRANSPORT_MEMORY,
        }]
    );
    clients.pop();
    assert_eq!(ends.server.clients().len(), 1);
    let before = ends.server.clients();
    let (second, _) = ends.connected((Some("10.0.0.2"), Some(2))).await;
    assert!(ends.server.close(&a).await);
    let (third, _) = ends.connected((Some("10.0.0.0"), Some(3))).await;
    let b = handle(("10.0.0.2", 2));
    let c = handle(("10.0.0.0", 3));
    assert_eq!(
        handles(&ends.server.clients()),
        [Arc::clone(&b), Arc::clone(&c)]
    );
    assert_eq!(handles(&before), [Arc::clone(&a)]);
    let (fourth, _) = ends.connected((Some("10.0.0.4"), Some(4))).await;
    let (fifth, _) = ends.connected((Some("10.0.0.5"), Some(5))).await;
    assert_eq!(
        handles(&ends.server.clients()),
        [b, c, handle(("10.0.0.4", 4)), handle(("10.0.0.5", 5))]
    );
    assert_eq!(handles(&before), [a]);
    ends.server.stop().await.expect("stopped");
    ends.clock.settle().await;
    for client in [first, second, third, fourth, fifth] {
        client.dispose();
    }
}

#[tokio::test]
async fn close_resolves_false_for_an_unknown_handle_without_reaching_the_transport() {
    let ends = Ends::started().await;
    let (client, _) = ends.connected((None, None)).await;
    ends.server_told();
    assert!(!ends.server.close(&handle(("local", 2))).await);
    assert_eq!(handles(&ends.server.clients()), [Arc::from(FIRST)]);
    assert_eq!(ends.server_told(), Vec::<String>::new());
    assert!(ends.server.close(&Arc::from(FIRST)).await);
    assert_eq!(ends.server_told(), [format!("closed {FIRST} true")]);
    assert_eq!(ends.server.clients(), []);
    client.dispose();
    ends.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn send_to_an_unknown_handle_resolves_without_reaching_the_transport() {
    let ends = Ends::started().await;
    let (client, told) = ends.connected((None, None)).await;
    ends.server
        .send(message_of(b"x", None), &handle(("local", 2)))
        .expect("an unknown handle settles");
    ends.clock.settle().await;
    assert_eq!(taken(&told), Vec::<String>::new());
    ends.server
        .send(message_of(b"x", None), &Arc::from(FIRST))
        .expect("sent to the known handle");
    ends.clock.settle().await;
    assert_eq!(taken(&told), ["heard 78 carrying None"]);
    assert_eq!(handles(&ends.server.clients()), [Arc::from(FIRST)]);
    client.dispose();
    ends.server.stop().await.expect("stopped");
}

#[tokio::test]
async fn stop_forgets_every_connection() {
    let ends = Ends::started().await;
    let (client, _) = ends.connected((None, None)).await;
    assert_eq!(ends.server.clients().len(), 1);
    ends.server.stop().await.expect("stopped");
    assert_eq!(ends.server.clients(), []);
    assert_eq!(ends.server.ready_state(), ReadyState::Closed);
    client.dispose();
}

#[tokio::test]
async fn counts_the_connections_it_holds_and_gives_their_handles_for_no_one_outside_the_process() {
    let ends = Ends::started().await;
    let (first, _) = ends.connected((None, None)).await;
    let (second, _) = ends.connected((None, None)).await;
    assert_eq!(
        ends.server.gauges(),
        Some(Gauges {
            counts: BTreeMap::from([("connections", 2)]),
            connection_handles: BTreeSet::from([Arc::from(FIRST), handle(("local", 2))]),
            ..Gauges::default()
        })
    );
    ends.server.stop().await.expect("stopped");
    for client in [first, second] {
        MemoryTransportClient::dispose(&client);
    }
}
