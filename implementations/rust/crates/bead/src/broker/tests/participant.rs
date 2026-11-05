//! A broker's participant (spec 15.16, 15.19, 15.21): its link, its inbox, its incarnation, its
//! halves; its connections closed as its link goes down and its peers reset as it connects anew; a
//! GONE's; its acknowledgements; and the delivery it requires of its adapter.

#![expect(
    clippy::too_many_lines,
    reason = "a twin plays its sentence whole, as the other sides' twins do"
)]

use core::sync::atomic::{AtomicUsize, Ordering};
use core::time::Duration;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::{
    ACCEPTOR_HALF, AtClient, AtServer, BrokerPair, BrokerPairOptions, Calling, ClientTold,
    ServerTold, accepted_of, adapter_of, broker, locked, misuse_in, participant_of, peer_of,
    publish_to, settle, until,
};
use crate::broker::adapter::{
    BrokerAdapter, BrokerCapabilities, BrokerDelivery, BrokerError, BrokerListener, BrokerMessage,
    BrokerPublished, BrokerStart,
};
use crate::broker::client::{BrokerTransportClientConnectOptions, BrokerTransportClientOptions};
use crate::broker::memory::{
    MemoryBroker, MemoryBrokerAdapter, MemoryBrokerAdapterOptions, MemoryBrokerFault,
    MemoryBrokerFaultOptions, MemoryBrokerOptions,
};
use crate::broker::parcel::{Parcel, encode_parcel, flags, kinds, write_parcel};
use crate::broker::participant::{BrokerParticipant, BrokerParticipantOptions};
use crate::broker::server::{BrokerTransportServer, BrokerTransportServerOptions};
use crate::clock::SharedClock;
use crate::debug::participant::ParticipantDebugEvent;
use crate::duration::{DurationRefusal, NEVER};
use crate::errors::{ProgrammerError, Refusal, TransportError};
use crate::router::types::{RouterError, TransportMessage};
use crate::testing::SteppingClock;
use crate::transport::{
    ReadyState, RouterClientTransport, ServerListener, ServerTransport,
    TransportClientReconnectDelay, TransportClientReconnectOptions,
};

// what a case's acceptor publishes to its opener's inbox, each parcel's bytes, given the opener's
// half
type Sending = fn(u64) -> Vec<Vec<u8>>;

fn data(bytes: &[u8]) -> TransportMessage {
    TransportMessage {
        data: Bytes::copy_from_slice(bytes),
        ..TransportMessage::default()
    }
}

fn error_of(outcome: Result<(), TransportError>) -> String {
    outcome.expect_err("refused").to_string()
}

fn reporting(participant: &BrokerParticipant) -> Arc<Mutex<Vec<String>>> {
    let reported: Arc<Mutex<Vec<String>>> = Arc::default();
    let hearing = Arc::clone(&reported);

    participant.on_error(Arc::new(move |error: &RouterError| {
        locked(&hearing).push(error.to_string());
    }));

    reported
}

// the transitions its trace tells of its link, in order (debugging 13.5)
fn linking(participant: &BrokerParticipant) -> Arc<Mutex<Vec<&'static str>>> {
    let told: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let hearing = Arc::clone(&told);

    participant.on_debug(Arc::new(move |event: &ParticipantDebugEvent| {
        if event.event == "link"
            && let Some(state) = event.state
        {
            locked(&hearing).push(state);
        }
    }));

    told
}

// what it reports, each kept whole, its source among it
fn hearing(participant: &BrokerParticipant) -> Arc<Mutex<Vec<RouterError>>> {
    let reported: Arc<Mutex<Vec<RouterError>>> = Arc::default();
    let hearing = Arc::clone(&reported);

    participant.on_error(Arc::new(move |error: &RouterError| {
        locked(&hearing).push(error.clone());
    }));

    reported
}

// the words of each source a walk from a report reaches, in order
fn sources_of(error: &RouterError) -> Vec<String> {
    let mut sources = Vec::new();
    let mut source = std::error::Error::source(error);

    while let Some(cause) = source {
        sources.push(cause.to_string());
        source = cause.source();
    }

    sources
}

// the misuse a report's sources carry, the first of them
fn misuse_of(error: &RouterError) -> Option<ProgrammerError> {
    let RouterError::Other(error) = error else {
        return None;
    };

    error.source().and_then(misuse_in)
}

// a participant of `inner`'s id, through an adapter that writes down each call: what it asks of its
// broker counted
fn calling_of(
    inner: &MemoryBrokerAdapter,
    reconnect: &TransportClientReconnectOptions,
) -> (BrokerParticipant, Arc<Calling>) {
    let recording = Arc::new(Calling::of(inner.clone()));
    let adapter: Arc<dyn BrokerAdapter> = Arc::<Calling>::clone(&recording);
    let participant = BrokerParticipant::new(
        adapter,
        &BrokerParticipantOptions {
            reconnect: Some(reconnect.clone()),
            ..BrokerParticipantOptions::default()
        },
    )
    .expect("a participant");

    (participant, recording)
}

// the starts of its link asked of its broker, its first among them
fn starts_of(recording: &Calling) -> usize {
    recording
        .calls()
        .iter()
        .filter(|call| *call == "start")
        .count()
}

// its link lost, and its broker holding its id's link of another start already: each attempt is
// refused until the test lets it through
async fn lost_and_held(adapter: &MemoryBrokerAdapter) {
    adapter.lose();
    adapter
        .start(BrokerStart::default())
        .await
        .expect("started");
}

fn immediately() -> TransportClientReconnectOptions {
    TransportClientReconnectOptions {
        delay: Some(TransportClientReconnectDelay::Fixed(Duration::ZERO)),
        ..TransportClientReconnectOptions::default()
    }
}

fn shaped(parcels: &[Parcel]) -> Vec<(u8, u64, Option<u16>)> {
    parcels
        .iter()
        .map(|parcel| (parcel.kind, parcel.sequence, parcel.code))
        .collect()
}

// spec 15.24
#[tokio::test]
async fn subscribes_its_inbox_before_anything_goes_takes_its_id_from_its_adapter_and_draws_its_incarnation_and_each_half_from_a_cryptographic_source()
 {
    let pair = BrokerPair::of(&BrokerPairOptions::default()).await;
    let recording = Arc::new(Calling::of(adapter_of(&pair.broker, "ada")));
    let adapter: Arc<dyn BrokerAdapter> = Arc::<Calling>::clone(&recording);
    let participant = BrokerParticipant::new(adapter, &BrokerParticipantOptions::default())
        .expect("a participant");
    let client = participant
        .client(&BrokerTransportClientOptions::default())
        .expect("a client");

    client
        .connect(&BrokerTransportClientConnectOptions::new("interop"))
        .await
        .expect("connected");

    // * its link started, its inbox subscribed, before its first publication
    assert_eq!(
        recording.calls().get(..3),
        Some(
            &[
                "start".to_owned(),
                "subscribe bead/i/ada".to_owned(),
                "publish bead/s/interop".to_owned()
            ][..]
        ),
        "its first calls"
    );

    // its id its adapter's, and none that is no token
    assert_eq!(participant.id(), "ada", "its id");
    assert!(
        BrokerParticipant::new(
            Arc::new(adapter_of(&pair.broker, "a/b")),
            &BrokerParticipantOptions::default()
        )
        .is_err(),
        "an id that is no token"
    );

    // an incarnation and halves of 16 and 8 bytes, never zero, none drawn twice
    let other = participant_of(
        &adapter_of(&pair.broker, "bob"),
        &BrokerParticipantOptions::default(),
    );

    other.start().await.expect("started");
    assert_ne!(participant.incarnation(), 0, "an incarnation drawn");
    assert_ne!(
        participant.incarnation(),
        other.incarnation(),
        "each its own"
    );

    let mut halves = HashSet::new();

    for _ in 0..1_000 {
        halves.insert(participant.draw_half().await.expect("a half"));
    }

    assert!(!halves.contains(&0), "no half zero");
    assert_eq!(halves.len(), 1_000, "none drawn twice");
    other.stop().await;
    participant.stop().await;
    pair.stop().await;
}

#[tokio::test]
async fn closes_each_connection_as_its_link_goes_down_and_connects_anew_as_another_incarnation_resetting_its_peers()
 {
    // ! no will: what closes the server's end is the RESET its participant sends once linked again
    let pair = BrokerPair::of(&BrokerPairOptions {
        client_capabilities: Some(BrokerCapabilities::GROUPS | BrokerCapabilities::NO_SUBSCRIBER),
        ..BrokerPairOptions::default()
    })
    .await;
    let first = pair.connect().await;
    let second = pair.connect().await;
    let before = pair.client_participant.incarnation();
    let told = Arc::new(ClientTold::default());

    first.listen(Arc::new(AtClient(Arc::clone(&told))));
    second.listen(Arc::new(AtClient(Arc::clone(&told))));

    // a connect its link goes down under, its OPEN to a name no one answers
    let (_silent, heard) = peer_of(&pair.broker, ("silent", &[&["bead", "s", "quiet"]])).await;
    let waiting = pair
        .client_participant
        .client(&BrokerTransportClientOptions::default())
        .expect("a client");
    let pending =
        crate::testing::spawn(waiting.connect(&BrokerTransportClientConnectOptions::new("quiet")));

    until(
        || heard.parcels().len() == 1,
        "the connect's OPEN reaches the name, unanswered",
    )
    .await;
    pair.client_adapter.lose();
    assert_eq!(
        error_of(pending.await.expect("joined")),
        "the link of client went down as it connected",
        "the connect fails"
    );

    // each told dropped, unclean and not quick, as a dropped socket's
    until(
        || locked(&told.closes).len() == 2,
        "each connection closes as its link goes down",
    )
    .await;
    assert_eq!(
        *locked(&told.closes),
        [(false, false), (false, false)],
        "each dropped"
    );
    assert_eq!(
        (first.ready_state(), second.ready_state()),
        (ReadyState::Closed, ReadyState::Closed),
        "each closed"
    );

    // linked again as another incarnation, its peer reset of each connection it held
    until(
        || pair.client_participant.is_linked() && locked(&pair.told.closed).len() == 2,
        "linked again, and the server's ends reset",
    )
    .await;
    assert_ne!(
        before,
        pair.client_participant.incarnation(),
        "another incarnation"
    );
    assert!(
        locked(&pair.told.closed)
            .iter()
            .all(|(is_clean, _)| !is_clean),
        "each reset, unclean"
    );
    assert_eq!(
        pair.server
            .gauges()
            .and_then(|gauges| gauges.counts.get("connections").copied()),
        Some(0),
        "none held"
    );

    // and it connects through its new incarnation
    let third = pair.connect().await;

    assert_eq!(third.ready_state(), ReadyState::Open, "connected anew");

    // without a reconnection, a link lost stays down, and says so
    let lone = adapter_of(&pair.broker, "bob");
    let alone = participant_of(
        &lone,
        &BrokerParticipantOptions {
            reconnects: Some(false),
            ..BrokerParticipantOptions::default()
        },
    );
    let reported = reporting(&alone);

    alone.start().await.expect("started");
    lone.lose();
    until(
        || !locked(&reported).is_empty(),
        "its link lost, and said so",
    )
    .await;
    assert!(!alone.is_linked(), "down");
    assert_eq!(*locked(&reported), ["the link of bob went down"], "said so");
    alone.stop().await;
    pair.stop().await;
}

#[tokio::test]
async fn a_parcel_that_would_pass_maximum_unsent_bytes_loses_its_connection_with_a_close_of_4000_whose_sequence_is_the_next_reported_naming_the_bound()
 {
    let broker = broker();
    let participant = participant_of(
        &adapter_of(&broker, "ada"),
        &BrokerParticipantOptions::default(),
    );
    let client = participant
        .client(&BrokerTransportClientOptions {
            maximum_unsent_bytes: Some(2_048),
        })
        .expect("a client");
    let told = Arc::new(ClientTold::default());

    client.listen(Arc::new(AtClient(Arc::clone(&told))));

    let (_acceptor, heard, _) = accepted_of((&broker, &client), 1_024).await;

    // * an envelope in three parts of 1,024, 1,024 and 536 bytes, sent at once: each part held to
    // the bound, the third would pass it and goes not, and the CLOSE that loses the connection
    // takes its sequence, the next
    client.send(data(&[0; 2_500])).expect("sent");
    until(
        || heard.parcels().len() == 3 && locked(&told.errors).len() == 1,
        "its two parts and its CLOSE, reported",
    )
    .await;
    assert_eq!(
        shaped(&heard.parcels()),
        [
            (kinds::DATA, 3, None),
            (kinds::DATA, 4, None),
            (kinds::CLOSE, 5, Some(4_000))
        ],
        "two parts, then its CLOSE"
    );
    assert_eq!(
        *locked(&told.errors),
        [
            "the connection to acceptor is closed with 4000: what waits for its broker would pass maximumUnsentBytes, 2048 bytes"
        ],
        "reported"
    );
    participant.stop().await;
}

#[tokio::test]
async fn a_parcel_that_does_not_read_closes_its_connection_with_1002_at_once_but_a_kind_to_come_which_is_taken_in_its_order()
 {
    let broker = broker();
    let participant = participant_of(
        &adapter_of(&broker, "ada"),
        &BrokerParticipantOptions::default(),
    );
    let client = participant
        .client(&BrokerTransportClientOptions::default())
        .expect("a client");
    let told = Arc::new(ClientTold::default());

    client.listen(Arc::new(AtClient(Arc::clone(&told))));

    let (acceptor, heard, opener) = accepted_of((&broker, &client), 65_536).await;
    let inbox = ["bead", "i", "ada"];

    // * a kind to come below the next awaited is a copy, dropped in silence
    publish_to(
        &acceptor,
        (
            inbox,
            encode_parcel(&Parcel {
                opener,
                acceptor: ACCEPTOR_HALF,
                sequence: 1,
                ..Parcel::of(0x0A)
            })
            .expect("encoded"),
        ),
    )
    .await;

    // any other that does not read closes at once, whatever its sequence, a copy's among them
    let mut kept = encode_parcel(&Parcel {
        opener,
        acceptor: ACCEPTOR_HALF,
        sequence: 1,
        ..Parcel::of(kinds::PING)
    })
    .expect("encoded");

    if let Some(byte) = kept.get_mut(3) {
        *byte = 1;
    }

    publish_to(&acceptor, (inbox, kept)).await;
    until(
        || heard.parcels().len() == 1 && locked(&told.errors).len() == 1,
        "its CLOSE, reported",
    )
    .await;
    assert_eq!(
        shaped(&heard.parcels()),
        [(kinds::CLOSE, 3, Some(1_002))],
        "its CLOSE"
    );
    assert_eq!(
        *locked(&told.errors),
        [
            "the connection to acceptor is closed with 1002: a parcel that does not read: a kept byte that is not 0"
        ],
        "reported"
    );
    participant.stop().await;
}

#[tokio::test]
async fn refuses_a_send_whose_room_fits_no_part_and_keeps_the_connection_on_the_client_and_the_server_alike()
 {
    let broker = broker();
    // adapters whose broker publishes 28 bytes at most to a peer's inbox: a prefix, and no more
    let narrow = |id: &str| {
        let adapter: Arc<dyn BrokerAdapter> = Arc::new(Calling {
            room: Some(28),
            ..Calling::of(adapter_of(&broker, id))
        });

        BrokerParticipant::new(adapter, &BrokerParticipantOptions::default())
            .expect("a participant")
    };
    let serving = narrow("server");
    let connecting = narrow("ada");
    let server = serving
        .server(&BrokerTransportServerOptions::new(["interop"]))
        .expect("a server");
    let client = connecting
        .client(&BrokerTransportClientOptions::default())
        .expect("a client");
    let told = Arc::new(ServerTold::default());
    let refusal = "a parcel of 28 bytes leaves no byte of an envelope beside its credential";

    server.listen(Arc::new(AtServer(Arc::clone(&told))));
    server.start().await.expect("started");
    client
        .connect(&BrokerTransportClientConnectOptions::new("interop"))
        .await
        .expect("connected");
    until(
        || locked(&told.opened).len() == 1,
        "the server tells the connection open",
    )
    .await;

    let handle = locked(&told.opened).first().cloned().expect("a handle");

    assert_eq!(
        client.send(data(&[0])).expect_err("refused").to_string(),
        refusal,
        "the client's refused"
    );
    assert_eq!(
        server
            .send(data(&[0]), &handle)
            .expect_err("refused")
            .to_string(),
        refusal,
        "the server's refused"
    );
    assert_eq!(
        (
            client.ready_state(),
            server
                .gauges()
                .and_then(|gauges| gauges.counts.get("connections").copied())
        ),
        (ReadyState::Open, Some(1)),
        "the connection kept"
    );
    server.stop().await.expect("stopped");
    connecting.stop().await;
    serving.stop().await;
}

#[tokio::test]
async fn is_refused_as_built_over_an_adapter_whose_inbox_takes_a_parcel_under_1_024_bytes() {
    let narrow = MemoryBroker::new(&MemoryBrokerOptions {
        maximum_message_bytes: Some(1_023),
        ..MemoryBrokerOptions::default()
    })
    .expect("a broker");

    assert_eq!(
        BrokerParticipant::new(
            Arc::new(adapter_of(&narrow, "ada")),
            &BrokerParticipantOptions::default()
        )
        .expect_err("refused")
        .message(),
        "a participant's inbox takes a parcel of 1,024 bytes at least, and the adapter of ada takes 1023",
        "refused"
    );

    let enough = MemoryBroker::new(&MemoryBrokerOptions {
        maximum_message_bytes: Some(1_024),
        ..MemoryBrokerOptions::default()
    })
    .expect("a broker");

    assert_eq!(
        participant_of(
            &adapter_of(&enough, "ada"),
            &BrokerParticipantOptions::default()
        )
        .id(),
        "ada",
        "1,024 bytes taken"
    );
}

#[tokio::test]
async fn is_refused_as_built_with_a_minimum_body_bytes_per_second_of_0_as_an_http_server_is() {
    let broker = broker();
    let adapter = adapter_of(&broker, "ada");

    assert_eq!(
        BrokerParticipant::new(
            Arc::new(adapter.clone()),
            &BrokerParticipantOptions {
                minimum_body_bytes_per_second: Some(0),
                ..BrokerParticipantOptions::default()
            }
        )
        .expect_err("refused")
        .message(),
        "minimumBodyBytesPerSecond is a whole number above 0, not 0",
        "refused"
    );
    assert_eq!(
        participant_of(
            &adapter,
            &BrokerParticipantOptions {
                minimum_body_bytes_per_second: Some(1),
                ..BrokerParticipantOptions::default()
            }
        )
        .id(),
        "ada",
        "1 taken"
    );
}

#[tokio::test]
async fn refuses_a_server_transport_a_name_another_of_its_server_transports_serves() {
    let broker = broker();
    let participant = participant_of(
        &adapter_of(&broker, "server"),
        &BrokerParticipantOptions::default(),
    );
    let _first = participant
        .server(&BrokerTransportServerOptions::new(["interop", "echo"]))
        .expect("a server");

    assert_eq!(
        participant
            .server(&BrokerTransportServerOptions::new(["other", "echo"]))
            .expect_err("refused")
            .message(),
        "the name echo is served already by a server transport of this participant",
        "refused"
    );

    // the one refused holds none of its names
    assert!(
        participant
            .server(&BrokerTransportServerOptions::new(["other"]))
            .is_ok(),
        "its names free"
    );
}

#[tokio::test]
async fn closes_each_connection_bound_to_the_incarnation_a_gone_names_and_none_bound_to_another() {
    let pair = BrokerPair::of(&BrokerPairOptions::default()).await;
    let _first = pair.connect().await;
    let _second = pair.connect().await;
    let bob = participant_of(
        &adapter_of(&pair.broker, "bob"),
        &BrokerParticipantOptions::default(),
    );
    let third = bob
        .client(&BrokerTransportClientOptions::default())
        .expect("a client");
    let publisher = adapter_of(&pair.broker, "will");
    let counted = |name: &str| {
        pair.server
            .gauges()
            .and_then(|gauges| gauges.counts.get(name).copied())
    };

    third
        .connect(&BrokerTransportClientConnectOptions::new("interop"))
        .await
        .expect("connected");
    publisher
        .start(BrokerStart::default())
        .await
        .expect("started");
    until(
        || counted("departures") == Some(2),
        "the server subscribes each peer's departure",
    )
    .await;

    // a GONE of another incarnation of the client's closes none
    let departure = ["bead", "d", "client"];
    let gone = |incarnation: u128| {
        write_parcel(&Parcel {
            incarnation: Some(incarnation),
            id: Some("client".to_owned()),
            ..Parcel::of(kinds::GONE)
        })
        .expect("written")
        .to_vec()
    };
    let incarnation = pair.client_participant.incarnation();

    publish_to(&publisher, (departure, gone(incarnation.wrapping_add(1)))).await;
    settle().await;
    assert_eq!(counted("connections"), Some(3), "none closed");

    // * one of its incarnation closes each connection bound to it, unclean, and none of bob's
    publish_to(&publisher, (departure, gone(incarnation))).await;
    until(
        || locked(&pair.told.closed).len() == 2,
        "the client's two connections close",
    )
    .await;

    let mut closed: Vec<(bool, String)> = locked(&pair.told.closed)
        .iter()
        .map(|(is_clean, handle)| (*is_clean, handle.to_string()))
        .collect();

    closed.sort();
    assert_eq!(
        closed,
        [
            (false, "type=BROKER;participant=client;ordinal=1".to_owned()),
            (false, "type=BROKER;participant=client;ordinal=2".to_owned())
        ],
        "each of its incarnation's"
    );
    assert_eq!(
        (counted("connections"), counted("departures")),
        (Some(1), Some(1)),
        "bob's kept"
    );
    bob.stop().await;
    pair.stop().await;
}

#[tokio::test]
async fn acknowledges_a_message_once_taken_or_dropped_as_a_copy_never_after_its_router_is_done_with_it()
 {
    // a router that takes its time: told, and done much later
    struct Slow {
        adapter: MemoryBrokerAdapter,
        unsettled_as_told: Arc<Mutex<Vec<u64>>>,
    }

    impl ServerListener for Slow {
        fn on_message(
            &self,
            _message: TransportMessage,
            _connection_handle: &crate::router::types::ConnectionHandle,
        ) {
            locked(&self.unsettled_as_told).push(self.adapter.unsettled());
        }
    }

    let pair = BrokerPair::of(&BrokerPairOptions::default()).await;
    let client = pair.connect().await;
    let unsettled_as_told: Arc<Mutex<Vec<u64>>> = Arc::default();

    pair.server.listen(Arc::new(Slow {
        adapter: pair.server_adapter.clone(),
        unsettled_as_told: Arc::clone(&unsettled_as_told),
    }));
    settle().await;
    client
        .send(data(&[0xA1, 0x16, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01]))
        .expect("sent");
    until(
        || locked(&unsettled_as_told).len() == 1 && pair.server_adapter.unsettled() == 0,
        "the envelope told, and its message acknowledged",
    )
    .await;

    // * taken before it was acknowledged
    assert_eq!(*locked(&unsettled_as_told), [1], "taken, then acknowledged");

    // a copy, dropped as one, told nothing and acknowledged all the same
    pair.broker.fault(
        MemoryBrokerFault::Copy,
        &MemoryBrokerFaultOptions {
            topic: Some(vec!["bead".to_owned(), "i".to_owned(), "server".to_owned()]),
        },
    );
    client
        .send(data(&[0xA1, 0x16, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03]))
        .expect("sent");
    until(
        || locked(&unsettled_as_told).len() == 2 && pair.server_adapter.unsettled() == 0,
        "the envelope told once, and both its messages acknowledged",
    )
    .await;
    settle().await;
    assert_eq!(locked(&unsettled_as_told).len(), 2, "told once");
    assert_eq!(pair.server_adapter.unsettled(), 0, "both acknowledged");
    pair.stop().await;
}

#[tokio::test]
async fn is_refused_as_built_when_its_application_requires_delivery_at_least_once_of_an_adapter_that_gives_it_at_most_once()
 {
    let broker = broker();
    let at_most_once = broker
        .adapter(&MemoryBrokerAdapterOptions {
            delivery: Some(BrokerDelivery::AtMostOnce),
            ..MemoryBrokerAdapterOptions::new("ada")
        })
        .expect("an adapter");
    let requiring = |delivery: Option<BrokerDelivery>| BrokerParticipantOptions {
        require_delivery: delivery,
        ..BrokerParticipantOptions::default()
    };

    assert_eq!(
        BrokerParticipant::new(
            Arc::new(at_most_once.clone()),
            &requiring(Some(BrokerDelivery::AtLeastOnce))
        )
        .expect_err("refused")
        .message(),
        "its application requires delivery at least once, and the adapter of ada gives it at most once",
        "refused"
    );

    // what it requires, or less where nothing is required, is taken
    participant_of(&at_most_once, &requiring(None));
    participant_of(&at_most_once, &requiring(Some(BrokerDelivery::AtMostOnce)));
    participant_of(
        &adapter_of(&broker, "bob"),
        &requiring(Some(BrokerDelivery::AtLeastOnce)),
    );
}

#[tokio::test]
async fn holds_a_connection_secure_only_while_both_its_legs_are() {
    for insecure in ["ada", "server"] {
        let broker = broker();
        let participant_of = |id: &str| {
            let adapter: Arc<dyn BrokerAdapter> = Arc::new(Calling {
                secure: (id == insecure).then_some(false),
                ..Calling::of(adapter_of(&broker, id))
            });

            BrokerParticipant::new(adapter, &BrokerParticipantOptions::default())
                .expect("a participant")
        };
        let serving = participant_of("server");
        // its application saying its own leg secure changes nothing of its peer's
        let server = serving
            .server(&BrokerTransportServerOptions {
                secure: (insecure == "ada").then_some(true),
                ..BrokerTransportServerOptions::new(["interop"])
            })
            .expect("a server");
        let connecting = participant_of("ada");
        let client = connecting
            .client(&BrokerTransportClientOptions::default())
            .expect("a client");
        let told = Arc::new(ServerTold::default());

        server.listen(Arc::new(AtServer(Arc::clone(&told))));
        server.start().await.expect("started");
        client
            .connect(&BrokerTransportClientConnectOptions::new("interop"))
            .await
            .expect("connected");
        until(
            || locked(&told.opened).len() == 1,
            "the server tells the connection open",
        )
        .await;

        let handle = locked(&told.opened).first().cloned().expect("a handle");

        // * one leg not secure, as its OPEN or its ACCEPT says: neither end holds it secure
        assert_eq!(
            (
                client.ready_state(),
                client.is_secure(),
                server.is_secure(&handle)
            ),
            (ReadyState::Open, false, false),
            "{insecure}'s leg not secure"
        );
        server.stop().await.expect("stopped");
        connecting.stop().await;
        serving.stop().await;
    }
}

#[tokio::test]
async fn starts_anew_once_a_start_failed() {
    let broker = broker();
    let adapter = adapter_of(&broker, "ada");
    let participant = participant_of(&adapter, &BrokerParticipantOptions::default());

    // its broker holds a link of its id already: its first start is refused
    adapter
        .start(BrokerStart::default())
        .await
        .expect("started");
    assert_eq!(
        participant.start().await.expect_err("refused").to_string(),
        "the link of ada is up already",
        "refused"
    );
    adapter.stop().await;

    // * the next starts another
    participant.start().await.expect("started");
    assert!(participant.is_linked(), "linked");
    participant.stop().await;
}

#[tokio::test]
async fn counts_its_connections_half_open_among_them_what_they_hold_in_parts_and_what_waits_for_its_broker_by_the_same_keys_on_its_own_face_and_its_server_transport_s()
 {
    let broker = broker();
    let participant = participant_of(
        &adapter_of(&broker, "server"),
        &BrokerParticipantOptions {
            held_bytes_budget: Some(4_096),
            maximum_envelope_parts_bytes: Some(2_048),
            ..BrokerParticipantOptions::default()
        },
    );
    let server = participant
        .server(&BrokerTransportServerOptions {
            maximum_connections: Some(8),
            maximum_unsent_bytes: Some(65_536),
            ..BrokerTransportServerOptions::new(["interop"])
        })
        .expect("a server");
    let (peer, heard) = peer_of(&broker, ("peer", &[])).await;
    let inbox = ["bead", "i", "server"];

    server.start().await.expect("started");
    publish_to(
        &peer,
        (
            ["bead", "s", "interop"],
            write_parcel(&Parcel {
                opener: ACCEPTOR_HALF,
                sequence: 1,
                id: Some("peer".to_owned()),
                incarnation: Some(0xC0),
                bound: Some(65_536),
                ..Parcel::of(kinds::OPEN)
            })
            .expect("written")
            .to_vec(),
        ),
    )
    .await;
    until(|| heard.parcels().len() == 1, "its ACCEPT").await;

    let acceptor = heard.parcels().remove(0).acceptor;
    let none = [
        ("connections", 0),
        ("departures", 0),
        ("halfOpen", 0),
        ("largestPartsBytes", 0),
        ("largestUnsentBytes", 0),
        ("partsBytes", 0),
        ("unsentBytes", 0),
    ];
    let counts_of = |changed: &[(&'static str, u64)]| {
        let mut counts: std::collections::BTreeMap<&'static str, u64> =
            none.iter().copied().collect();

        counts.extend(changed.iter().copied());

        counts
    };

    // half-open, its third leg awaited
    until(
        || participant.gauges().counts == counts_of(&[("halfOpen", 1)]),
        "half-open",
    )
    .await;

    // * open, and 100 bytes of an envelope held in parts
    publish_to(
        &peer,
        (
            inbox,
            write_parcel(&Parcel {
                opener: ACCEPTOR_HALF,
                acceptor,
                sequence: 2,
                ..Parcel::of(kinds::PING)
            })
            .expect("written")
            .to_vec(),
        ),
    )
    .await;
    publish_to(
        &peer,
        (
            inbox,
            write_parcel(&Parcel {
                flags: Some(flags::MORE),
                opener: ACCEPTOR_HALF,
                acceptor,
                sequence: 3,
                carried: Some(Bytes::from(vec![0; 100])),
                ..Parcel::of(kinds::DATA)
            })
            .expect("written")
            .to_vec(),
        ),
    )
    .await;

    let held = counts_of(&[
        ("connections", 1),
        ("departures", 1),
        ("largestPartsBytes", 100),
        ("partsBytes", 100),
    ]);

    until(
        || participant.gauges().counts == held,
        "open, its parts held",
    )
    .await;

    let mut counted = held.clone();

    counted.insert("names", 1);
    assert_eq!(
        server.gauges().expect("its gauges").counts,
        counted,
        "its server's, by the same keys"
    );
    assert_eq!(
        participant.gauges().ceilings,
        [("largestPartsBytes", 2_048), ("partsBytes", 4_096)]
            .into_iter()
            .collect(),
        "its ceilings"
    );
    assert_eq!(
        server.gauges().expect("its gauges").ceilings,
        [
            ("connections", 8),
            ("halfOpen", 8),
            ("largestPartsBytes", 2_048),
            ("largestUnsentBytes", 65_536),
            ("partsBytes", 4_096)
        ]
        .into_iter()
        .collect(),
        "its server's ceilings"
    );
    server.stop().await.expect("stopped");
    participant.stop().await;
}

#[tokio::test]
async fn is_refused_as_built_with_a_root_that_is_no_token_and_names_each_topic_by_the_root_it_is_given()
 {
    let broker = broker();

    assert_eq!(
        BrokerParticipant::new(
            Arc::new(adapter_of(&broker, "ada")),
            &BrokerParticipantOptions {
                root: Some("a.b".to_owned()),
                ..BrokerParticipantOptions::default()
            }
        )
        .expect_err("refused")
        .message(),
        "a participant's root is a token of base64url's alphabet, 1 to 64 characters, not \"a.b\"",
        "refused"
    );

    let recording = Arc::new(Calling::of(adapter_of(&broker, "bob")));
    let adapter: Arc<dyn BrokerAdapter> = Arc::<Calling>::clone(&recording);
    let participant = BrokerParticipant::new(
        adapter,
        &BrokerParticipantOptions {
            root: Some("deploy".to_owned()),
            ..BrokerParticipantOptions::default()
        },
    )
    .expect("a participant");

    participant.start().await.expect("started");
    assert_eq!(participant.root(), "deploy", "its root");
    assert_eq!(
        recording.calls(),
        ["start", "subscribe deploy/i/bob"],
        "its inbox by its root"
    );
    participant.stop().await;
}

#[tokio::test]
async fn lets_a_listener_go_fails_a_connect_awaiting_its_answer_as_it_stops_and_stops_once() {
    let broker = broker();
    let participant = participant_of(
        &adapter_of(&broker, "ada"),
        &BrokerParticipantOptions::default(),
    );
    let (silent, heard) = peer_of(&broker, ("silent", &[&["bead", "s", "interop"]])).await;
    let reported: Arc<Mutex<Vec<String>>> = Arc::default();
    let hearing = Arc::clone(&reported);
    let listener: crate::broker::participant::ParticipantErrorListener =
        Arc::new(move |error: &RouterError| {
            locked(&hearing).push(error.to_string());
        });
    let inbox = ["bead", "i", "ada"];

    let listening = participant.on_error(Arc::clone(&listener));

    // a connect whose OPEN reached a name nobody answers
    let waiting = participant
        .client(&BrokerTransportClientOptions::default())
        .expect("a client");
    let pending = crate::testing::spawn(
        waiting.connect(&BrokerTransportClientConnectOptions::new("interop")),
    );

    until(|| heard.parcels().len() == 1, "its OPEN reaches the name").await;

    // a listener let go of hears no more
    publish_to(&silent, (inbox, vec![0xB1])).await;
    settle().await;
    participant.off(listening);
    publish_to(&silent, (inbox, vec![0xB1])).await;
    settle().await;
    assert_eq!(
        heard
            .parcels()
            .iter()
            .map(|parcel| parcel.kind)
            .collect::<Vec<_>>(),
        [kinds::OPEN],
        "its OPEN alone"
    );

    let counted = participant.gauges().counts;

    assert_eq!(
        (counted.get("connections"), counted.get("departures")),
        (Some(&0), Some(&0)),
        "nothing held"
    );

    participant.stop().await;

    // * the connect fails as its participant stops, and a second stop does nothing
    assert_eq!(
        error_of(pending.await.expect("joined")),
        "the participant ada stopped as it connected",
        "the connect fails"
    );
    participant.stop().await;
    assert!(!participant.is_linked(), "down");
    assert_eq!(
        *locked(&reported),
        ["a message to the inbox of ada is no parcel: 1 bytes, under a parcel's 28"],
        "heard once"
    );

    // * taken over, then stopped: a stop leaves the fence, so a connect reads the takeover's words
    let cat = adapter_of(&broker, "cat");
    let fenced = participant_of(
        &cat,
        &BrokerParticipantOptions {
            reconnects: Some(false),
            ..BrokerParticipantOptions::default()
        },
    );
    let fencing = reporting(&fenced);

    fenced.start().await.expect("started");
    cat.take_over();
    until(|| !locked(&fencing).is_empty(), "its takeover reported").await;
    fenced.stop().await;

    let connected = fenced
        .client(&BrokerTransportClientOptions::default())
        .expect("a client")
        .connect(&BrokerTransportClientConnectOptions::new("interop"))
        .await;

    assert!(
        matches!(connected, Err(TransportError::Connect(_))),
        "a connect's failure"
    );
    assert_eq!(
        error_of(connected),
        "the link of cat was taken over by another link of its id, and connects no more until it is started again",
        "the takeover's words"
    );
    fenced.dispose().await;
}

// spec 15.21
#[tokio::test]
async fn fails_a_start_its_stop_overtakes_what_its_adapter_s_start_failed_with_as_its_cause() {
    let broker = broker();
    let giving = Arc::new(Calling {
        gives_up: true,
        ..Calling::of(adapter_of(&broker, "ada"))
    });
    let adapter: Arc<dyn BrokerAdapter> = Arc::<Calling>::clone(&giving);
    let participant = BrokerParticipant::new(adapter, &BrokerParticipantOptions::default())
        .expect("a participant");
    let starting = crate::testing::spawn(participant.start());

    until(|| giving.calls() == ["start"], "its start asked").await;
    participant.stop().await;

    // * its start fails as a link fails, its adapter's failure its cause, by its words
    let failed = starting.await.expect("joined").expect_err("failed");

    assert!(
        matches!(failed, BrokerError::Failed { .. }),
        "a link's failure"
    );
    assert_eq!(
        failed.to_string(),
        "the participant ada stopped as it started",
        "its words"
    );
    assert_eq!(
        std::error::Error::source(&failed)
            .and_then(|source| source.downcast_ref::<BrokerError>())
            .map(ToString::to_string)
            .as_deref(),
        Some("the adapter gave up its start"),
        "its cause"
    );
    assert_eq!(
        giving.calls(),
        ["start", "stop"],
        "its adapter stopped once"
    );
}

#[tokio::test]
async fn closes_a_connection_with_1002_for_a_parcel_of_a_layout_to_come_an_accept_on_it_open_or_another_kind_between_an_envelope_s_parts_and_with_4000_at_a_gap_a_kind_to_come_leaves()
 {
    let part = |opener: u64| {
        write_parcel(&Parcel {
            flags: Some(flags::MORE),
            opener,
            acceptor: ACCEPTOR_HALF,
            sequence: 2,
            carried: Some(Bytes::from_static(&[0xA1])),
            ..Parcel::of(kinds::DATA)
        })
        .expect("written")
        .to_vec()
    };
    let cases: [(u16, Sending, &str); 5] = [
        (
            1_002,
            |opener| {
                vec![
                    encode_parcel(&Parcel {
                        layout: 0xB2,
                        opener,
                        acceptor: ACCEPTOR_HALF,
                        sequence: 2,
                        ..Parcel::of(kinds::PING)
                    })
                    .expect("encoded"),
                ]
            },
            "a parcel of a layout to come, 0xB2",
        ),
        (
            1_002,
            |opener| {
                vec![
                    write_parcel(&Parcel {
                        opener,
                        acceptor: ACCEPTOR_HALF,
                        sequence: 2,
                        id: Some("acceptor".to_owned()),
                        incarnation: Some(0xC0),
                        bound: Some(65_536),
                        ..Parcel::of(kinds::ACCEPT)
                    })
                    .expect("written")
                    .to_vec(),
                ]
            },
            "an ACCEPT on a connection open",
        ),
        (
            1_002,
            |opener| {
                vec![
                    write_parcel(&Parcel {
                        flags: Some(flags::MORE),
                        opener,
                        acceptor: ACCEPTOR_HALF,
                        sequence: 2,
                        carried: Some(Bytes::from_static(&[0xA1])),
                        ..Parcel::of(kinds::DATA)
                    })
                    .expect("written")
                    .to_vec(),
                    write_parcel(&Parcel {
                        opener,
                        acceptor: ACCEPTOR_HALF,
                        sequence: 3,
                        answers: Some(2),
                        ..Parcel::of(kinds::PONG)
                    })
                    .expect("written")
                    .to_vec(),
                ]
            },
            "a PONG between an envelope's parts",
        ),
        (
            1_002,
            |opener| {
                vec![
                    write_parcel(&Parcel {
                        flags: Some(flags::MORE),
                        opener,
                        acceptor: ACCEPTOR_HALF,
                        sequence: 2,
                        carried: Some(Bytes::from_static(&[0xA1])),
                        ..Parcel::of(kinds::DATA)
                    })
                    .expect("written")
                    .to_vec(),
                    write_parcel(&Parcel {
                        opener,
                        acceptor: ACCEPTOR_HALF,
                        sequence: 3,
                        code: Some(1_000),
                        ..Parcel::of(kinds::CLOSE)
                    })
                    .expect("written")
                    .to_vec(),
                ]
            },
            "a CLOSE between an envelope's parts",
        ),
        (
            4_000,
            |opener| {
                vec![
                    encode_parcel(&Parcel {
                        opener,
                        acceptor: ACCEPTOR_HALF,
                        sequence: 5,
                        ..Parcel::of(0x0A)
                    })
                    .expect("encoded"),
                ]
            },
            "a parcel lost: 2 was awaited, and 5 came",
        ),
    ];

    assert_eq!(part(1).len(), 29, "a part of one byte");

    for (code, parcels, why) in cases {
        let broker = broker();
        let participant = participant_of(
            &adapter_of(&broker, "ada"),
            &BrokerParticipantOptions::default(),
        );
        let client = participant
            .client(&BrokerTransportClientOptions::default())
            .expect("a client");
        let told = Arc::new(ClientTold::default());

        client.listen(Arc::new(AtClient(Arc::clone(&told))));

        let (acceptor, heard, opener) = accepted_of((&broker, &client), 65_536).await;

        for payload in parcels(opener) {
            publish_to(&acceptor, (["bead", "i", "ada"], payload)).await;
        }

        // * its CLOSE the next of its sequence, after its OPEN and its third leg; reported, unclean
        until(
            || {
                heard.parcels().len() == 1
                    && locked(&told.errors).len() == 1
                    && locked(&told.closes).len() == 1
            },
            &format!("its CLOSE, reported: {why}"),
        )
        .await;
        assert_eq!(
            shaped(&heard.parcels()),
            [(kinds::CLOSE, 3, Some(code))],
            "{why}"
        );
        assert_eq!(
            *locked(&told.errors),
            [format!(
                "the connection to acceptor is closed with {code}: {why}"
            )],
            "{why}"
        );
        assert_eq!(*locked(&told.closes), [(false, false)], "{why}");
        participant.stop().await;
    }
}

#[tokio::test]
async fn ends_a_connection_unclean_reporting_nothing_once_its_broker_refuses_a_parcel_to_its_peer_s_inbox_or_says_no_subscriber_takes_it()
 {
    for is_refused in [false, true] {
        let broker = broker();
        let adapter = adapter_of(&broker, "ada");
        let participant = participant_of(&adapter, &BrokerParticipantOptions::default());
        let client = participant
            .client(&BrokerTransportClientOptions::default())
            .expect("a client");
        let told = Arc::new(ClientTold::default());

        client.listen(Arc::new(AtClient(Arc::clone(&told))));

        let (acceptor, _, _) = accepted_of((&broker, &client), 65_536).await;

        // * its own link refused by its broker under it, or its peer's inbox gone, as a dropped
        // socket's peer
        if is_refused {
            adapter.stop().await;
        } else {
            acceptor.stop().await;
        }

        client
            .send(data(&[0xA1, 0x16, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01]))
            .expect("sent");
        // ! its close is told once its state is Closed: awaited by the close, never the state
        until(
            || !locked(&told.closes).is_empty(),
            &format!("its connection ends: {is_refused}"),
        )
        .await;
        assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
        assert_eq!(*locked(&told.closes), [(false, false)], "unclean");
        assert!(locked(&told.errors).is_empty(), "nothing reported");
        participant.stop().await;
    }
}

#[tokio::test]
async fn keeps_a_connection_whose_parts_come_at_their_rate_past_the_grace_and_hands_their_envelope_on_whole()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let broker = MemoryBroker::new(&MemoryBrokerOptions {
        clock: Some(Arc::clone(&shared)),
        ..MemoryBrokerOptions::default()
    })
    .expect("a broker");
    let participant = participant_of(
        &adapter_of(&broker, "ada"),
        &BrokerParticipantOptions {
            clock: Some(Arc::clone(&shared)),
            ..BrokerParticipantOptions::default()
        },
    );
    let client = participant
        .client(&BrokerTransportClientOptions::default())
        .expect("a client");
    let told = Arc::new(ClientTold::default());

    client.listen(Arc::new(AtClient(Arc::clone(&told))));

    let (acceptor, _, opener) = accepted_of((&broker, &client), 65_536).await;
    let part_of = |(sequence, length, is_last): (u64, usize, bool)| {
        write_parcel(&Parcel {
            flags: Some(if is_last { 0 } else { flags::MORE }),
            opener,
            acceptor: ACCEPTOR_HALF,
            sequence,
            carried: Some(Bytes::from(vec![0; length])),
            ..Parcel::of(kinds::DATA)
        })
        .expect("written")
        .to_vec()
    };
    let inbox = ["bead", "i", "ada"];

    // * 2,600 bytes by the grace's end, owed by 10,833 ms at 240 bytes a second: not late, held on
    publish_to(&acceptor, (inbox, part_of((2, 1_300, false)))).await;
    clock.settle().await;
    assert_eq!(clock.dues(), [Duration::from_secs(5)], "its grace armed");
    clock.advance(Duration::from_secs(4)).await;
    publish_to(&acceptor, (inbox, part_of((3, 1_300, false)))).await;
    clock.settle().await;
    assert_eq!(
        participant.gauges().counts.get("partsBytes"),
        Some(&2_600),
        "its second part held"
    );
    clock.advance(Duration::from_secs(1)).await;
    assert_eq!(
        clock.dues(),
        [Duration::from_millis(5_833)],
        "armed again at what its parts owe"
    );
    publish_to(&acceptor, (inbox, part_of((4, 1, true)))).await;
    clock.settle().await;
    assert_eq!(
        locked(&told.messages)
            .iter()
            .map(|message| message.data.len())
            .collect::<Vec<_>>(),
        [2_601],
        "its envelope told whole"
    );
    assert!(locked(&told.closes).is_empty(), "nothing closed");
    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    participant.stop().await;
}

#[tokio::test]
async fn reports_its_link_given_up_on_once_its_reconnection_s_attempts_run_out() {
    let broker = broker();
    let adapter = adapter_of(&broker, "ada");
    let participant = participant_of(
        &adapter,
        &BrokerParticipantOptions {
            reconnect: Some(TransportClientReconnectOptions {
                maximum_attempts: Some(2),
                ..immediately()
            }),
            ..BrokerParticipantOptions::default()
        },
    );
    let reported = reporting(&participant);

    participant.start().await.expect("started");
    adapter.lose();

    // * its broker holds its id's link of another start already: each attempt is refused
    adapter
        .start(BrokerStart::default())
        .await
        .expect("started");
    until(|| !locked(&reported).is_empty(), "given up on").await;
    assert_eq!(
        *locked(&reported),
        ["the link of ada went down, and 2 attempts did not bring it back"],
        "reported"
    );
    assert!(!participant.is_linked(), "down");
    participant.stop().await;
}

#[tokio::test]
async fn reports_its_reconnection_ended_once_its_signal_is_aborted() {
    let broker = broker();
    let adapter = adapter_of(&broker, "ada");
    let cancelling = CancellationToken::new();
    let participant = participant_of(
        &adapter,
        &BrokerParticipantOptions {
            reconnect: Some(TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Resolver(Arc::new(
                    |_previous, _attempt| Duration::from_secs(60),
                ))),
                signal: Some(cancelling.clone()),
                ..TransportClientReconnectOptions::default()
            }),
            ..BrokerParticipantOptions::default()
        },
    );
    let reported = reporting(&participant);

    participant.start().await.expect("started");
    adapter.lose();

    // * each attempt is refused, and the wait before the next one is cut short
    adapter
        .start(BrokerStart::default())
        .await
        .expect("started");
    settle().await;
    cancelling.cancel();
    until(|| !locked(&reported).is_empty(), "its reconnection ended").await;
    assert_eq!(
        *locked(&reported),
        ["the link of ada went down, and its reconnection ended: the reconnection was cancelled"],
        "reported"
    );
    assert!(!participant.is_linked(), "down");
    participant.stop().await;
}

// spec 1.4, 15.21
#[tokio::test]
async fn refuses_a_fixed_reconnection_delay_out_of_bounds_as_it_is_built_and_ends_its_reconnection_reported_on_a_function_s_answer_out_of_bounds()
 {
    let broker = broker();
    let adapter = adapter_of(&broker, "ada");

    // * a fixed delay held as it is built, whether or not it reconnects
    for (delay, reconnects, reason) in [
        (
            Duration::from_micros(500),
            None,
            DurationRefusal::UnderTheFloor,
        ),
        (
            Duration::from_millis(2_147_483_648),
            Some(true),
            DurationRefusal::PastTheCeiling,
        ),
        (NEVER, Some(false), DurationRefusal::NeverRefused),
    ] {
        let refused = BrokerParticipant::new(
            Arc::new(adapter.clone()),
            &BrokerParticipantOptions {
                reconnect: Some(TransportClientReconnectOptions {
                    delay: Some(TransportClientReconnectDelay::Fixed(delay)),
                    ..TransportClientReconnectOptions::default()
                }),
                reconnects,
                ..BrokerParticipantOptions::default()
            },
        )
        .err();

        assert_eq!(
            refused.and_then(|refused| refused.reason()),
            Some(Refusal::Duration(reason)),
            "{delay:?} refused as it is built"
        );
    }

    // a function's answer held at each attempt: out of bounds, its reconnection ends, reported,
    // its refusal the report's source
    let participant = participant_of(
        &adapter,
        &BrokerParticipantOptions {
            reconnect: Some(TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Resolver(Arc::new(
                    |_previous, _attempt| NEVER,
                ))),
                ..TransportClientReconnectOptions::default()
            }),
            ..BrokerParticipantOptions::default()
        },
    );
    let reported = hearing(&participant);

    participant.start().await.expect("started");
    lost_and_held(&adapter).await;
    until(|| !locked(&reported).is_empty(), "its reconnection ended").await;
    settle().await;

    let reports = locked(&reported).clone();

    assert_eq!(
        reports.iter().map(ToString::to_string).collect::<Vec<_>>(),
        [
            "the link of ada went down, and its reconnection ended: a delay is 0 for at once, or a duration of whole milliseconds from 1 to 2147483647, not Duration::MAX"
        ],
        "reported once"
    );
    assert_eq!(
        reports
            .first()
            .and_then(misuse_of)
            .and_then(|misuse| misuse.reason()),
        Some(Refusal::Duration(DurationRefusal::NeverRefused)),
        "its refusal the report's source, by its code"
    );
    assert!(!participant.is_linked(), "down");
    participant.stop().await;
}

// spec 15.21
#[tokio::test]
async fn reconnects_without_end_when_given_a_delay_alone() {
    let broker = broker();
    let adapter = adapter_of(&broker, "ada");
    let (participant, recording) = calling_of(
        &adapter,
        &TransportClientReconnectOptions {
            delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_millis(
                1,
            ))),
            ..TransportClientReconnectOptions::default()
        },
    );
    let reported = reporting(&participant);

    participant.start().await.expect("started");
    lost_and_held(&adapter).await;

    // * past the 5 attempts a transport client's reconnection makes when it names none
    until(|| starts_of(&recording) > 8, "its attempts past five").await;
    assert!(locked(&reported).is_empty(), "nothing reported");
    assert!(!participant.is_linked(), "down");

    // its broker lets it through: linked again, by its own reconnection
    adapter.stop().await;
    until(|| participant.is_linked(), "linked again").await;
    assert!(locked(&reported).is_empty(), "nothing reported");
    participant.stop().await;
}

// spec 15.21
#[tokio::test]
async fn ends_its_reconnection_at_once_as_it_is_stopped_in_a_wait_or_in_an_attempt_told_so_the_stop_its_cause()
 {
    // in a wait: on the test's clock, a delay of 10 s never advanced, its first attempt refused
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let broker = broker();
    let adapter = adapter_of(&broker, "ada");
    let recording = Arc::new(Calling::of(adapter.clone()));
    let tapped: Arc<Mutex<Vec<Duration>>> = Arc::default();
    let tapping = Arc::clone(&tapped);
    let participant = BrokerParticipant::new(
        Arc::<Calling>::clone(&recording),
        &BrokerParticipantOptions {
            clock: Some(Arc::clone(&shared)),
            reconnect: Some(TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_secs(
                    10,
                ))),
                tap: Some(Arc::new(move |delay, _attempt| {
                    locked(&tapping).push(delay);
                })),
                ..TransportClientReconnectOptions::default()
            }),
            ..BrokerParticipantOptions::default()
        },
    )
    .expect("a participant");
    let reported = hearing(&participant);

    participant.start().await.expect("started");
    lost_and_held(&adapter).await;
    until(|| locked(&tapped).len() == 1, "its first wait told").await;

    let before = shared.monotonic();

    // * its stop ends its link, the test's own among it: its broker would let it through now
    participant.stop().await;
    until(|| !locked(&reported).is_empty(), "its reconnection ended").await;
    settle().await;

    // * ended at once, told once, the stop its cause, which a walk from its report reaches once
    let reports = locked(&reported).clone();

    assert_eq!(
        reports.iter().map(ToString::to_string).collect::<Vec<_>>(),
        ["the link of ada went down, and its reconnection ended: the reconnection was cancelled"],
        "told so, once"
    );
    assert_eq!(
        reports.first().map(sources_of),
        Some(vec![
            "the reconnection was cancelled".to_owned(),
            "the participant ada stopped".to_owned()
        ]),
        "the stop its cause"
    );
    assert_eq!(shared.monotonic(), before, "the clock not moved");
    assert_eq!(
        *locked(&tapped),
        [Duration::from_secs(10)],
        "no wait told after its stop"
    );
    assert_eq!(starts_of(&recording), 2, "no attempt after its stop");
    assert!(
        !participant.is_linked() && !adapter.is_linked(),
        "linked no more"
    );

    // in an attempt: its attempt's start held, then its stop
    let bob = adapter_of(&broker, "bob");
    let holding = Arc::new(Calling {
        holds: Some(1),
        ..Calling::of(bob.clone())
    });
    let tapped: Arc<Mutex<Vec<Duration>>> = Arc::default();
    let tapping = Arc::clone(&tapped);
    let participant = BrokerParticipant::new(
        Arc::<Calling>::clone(&holding),
        &BrokerParticipantOptions {
            clock: Some(Arc::clone(&shared)),
            reconnect: Some(TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_secs(
                    10,
                ))),
                tap: Some(Arc::new(move |delay, _attempt| {
                    locked(&tapping).push(delay);
                })),
                ..TransportClientReconnectOptions::default()
            }),
            ..BrokerParticipantOptions::default()
        },
    )
    .expect("a participant");
    let reported = hearing(&participant);

    participant.start().await.expect("started");
    bob.lose();
    until(|| holding.holding() == 1, "its attempt's start held").await;

    let stopping = crate::testing::spawn(participant.stop());

    settle().await;
    assert!(holding.release(), "released");
    stopping.await.expect("joined");
    until(|| !locked(&reported).is_empty(), "its reconnection ended").await;
    settle().await;

    // * its attempt fails, and its reconnection ends at once, no wait told after it, the stop its
    // cause
    let reports = locked(&reported).clone();

    assert_eq!(
        reports.iter().map(ToString::to_string).collect::<Vec<_>>(),
        ["the link of bob went down, and its reconnection ended: the reconnection was cancelled"],
        "told so, once"
    );
    assert_eq!(
        reports.first().map(sources_of),
        Some(vec![
            "the reconnection was cancelled".to_owned(),
            "the participant bob stopped".to_owned()
        ]),
        "the stop its cause"
    );
    assert!(locked(&tapped).is_empty(), "no wait told");
    assert_eq!(shared.monotonic(), before, "the clock not moved");
    assert!(
        !participant.is_linked() && !bob.is_linked(),
        "linked no more"
    );
}

// spec 15.21
#[tokio::test]
async fn ends_its_reconnection_before_any_attempt_once_its_signal_is_aborted() {
    let broker = broker();
    let adapter = adapter_of(&broker, "ada");
    let cancelling = CancellationToken::new();
    let (participant, recording) = calling_of(
        &adapter,
        &TransportClientReconnectOptions {
            signal: Some(cancelling.clone()),
            ..immediately()
        },
    );
    let reported = reporting(&participant);

    participant.start().await.expect("started");

    // * aborted before its link goes down, its broker letting it through
    cancelling.cancel();
    adapter.lose();
    until(|| !locked(&reported).is_empty(), "its reconnection ended").await;
    settle().await;
    assert_eq!(
        *locked(&reported),
        ["the link of ada went down, and its reconnection ended: the reconnection was cancelled"],
        "reported once"
    );
    assert_eq!(starts_of(&recording), 1, "no attempt, its start alone");
    assert!(!participant.is_linked(), "down");
    participant.stop().await;
}

// spec 15.21
#[tokio::test]
async fn links_anew_at_its_next_start_once_its_reconnection_ended() {
    let broker = broker();
    let adapter = adapter_of(&broker, "ada");
    let participant = participant_of(
        &adapter,
        &BrokerParticipantOptions {
            reconnect: Some(TransportClientReconnectOptions {
                maximum_attempts: Some(2),
                ..immediately()
            }),
            ..BrokerParticipantOptions::default()
        },
    );
    let reported = reporting(&participant);

    participant.start().await.expect("started");

    let former = participant.incarnation();

    lost_and_held(&adapter).await;
    until(|| !locked(&reported).is_empty(), "given up on").await;
    assert_eq!(
        *locked(&reported),
        ["the link of ada went down, and 2 attempts did not bring it back"],
        "reported"
    );

    // its broker lets it through: it stays down until it is started
    adapter.stop().await;
    settle().await;
    assert!(!participant.is_linked(), "down");

    // * its next start links it anew, another incarnation, not the first start's outcome
    participant.start().await.expect("started");
    assert!(participant.is_linked(), "linked anew");
    assert!(adapter.is_linked(), "its link up at its broker");
    assert_ne!(former, participant.incarnation(), "another incarnation");
    participant.stop().await;
}

// spec 15.21
#[tokio::test]
async fn reports_its_reconnection_ended_when_its_delay_function_or_its_tap_throws() {
    let broker = broker();
    let ada = adapter_of(&broker, "ada");
    let bob = adapter_of(&broker, "bob");
    let throwing = participant_of(
        &ada,
        &BrokerParticipantOptions {
            reconnect: Some(TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Resolver(Arc::new(
                    |_previous, _attempt| panic!("its delay broke"),
                ))),
                ..TransportClientReconnectOptions::default()
            }),
            ..BrokerParticipantOptions::default()
        },
    );
    let tapping = participant_of(
        &bob,
        &BrokerParticipantOptions {
            reconnect: Some(TransportClientReconnectOptions {
                tap: Some(Arc::new(|_delay, _attempt| panic!("its tap broke"))),
                ..immediately()
            }),
            ..BrokerParticipantOptions::default()
        },
    );
    let reported = [hearing(&throwing), hearing(&tapping)];

    throwing.start().await.expect("started");
    tapping.start().await.expect("started");
    lost_and_held(&ada).await;
    lost_and_held(&bob).await;
    until(
        || reported.iter().all(|reported| !locked(reported).is_empty()),
        "each reconnection ended",
    )
    .await;
    settle().await;

    let reports: Vec<Vec<RouterError>> = reported
        .iter()
        .map(|reported| locked(reported).clone())
        .collect();

    // * each told once, in the other sides' words, what it panicked with its source
    assert_eq!(
        reports
            .iter()
            .map(|reports| reports.iter().map(ToString::to_string).collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        [
            ["the link of ada went down, and its reconnection ended: its delay broke"],
            ["the link of bob went down, and its reconnection ended: its tap broke"]
        ],
        "each reported once"
    );
    assert!(
        reports
            .iter()
            .flatten()
            .all(|report| misuse_of(report).is_some()),
        "what ended it, its source"
    );
    assert!(!throwing.is_linked() && !tapping.is_linked(), "each down");
    throwing.stop().await;
    tapping.stop().await;
}

// spec 1.4
#[tokio::test]
async fn takes_a_turn_of_its_platform_between_two_attempts_at_a_delay_of_0_over_an_adapter_that_refuses_its_start_at_once()
 {
    let broker = broker();
    let inner = adapter_of(&broker, "ada");
    let refusing = Arc::new(Calling {
        starts: Some(1),
        ..Calling::of(inner.clone())
    });
    let adapter: Arc<dyn BrokerAdapter> = Arc::<Calling>::clone(&refusing);
    // the starts asked of its broker as a task queued at its first wait ran
    let ran_at: Arc<Mutex<Option<usize>>> = Arc::default();
    let queuing = (Arc::clone(&refusing), Arc::clone(&ran_at));
    let participant = BrokerParticipant::new(
        adapter,
        &BrokerParticipantOptions {
            reconnect: Some(TransportClientReconnectOptions {
                maximum_attempts: Some(3),
                tap: Some(Arc::new(move |_delay, attempt| {
                    // * a task queued on its runtime as its first wait is told
                    if attempt == 1 {
                        let (refusing, ran_at) = (Arc::clone(&queuing.0), Arc::clone(&queuing.1));

                        drop(crate::testing::spawn(async move {
                            *locked(&ran_at) = Some(starts_of(&refusing));
                        }));
                    }
                })),
                ..immediately()
            }),
            ..BrokerParticipantOptions::default()
        },
    )
    .expect("a participant");
    let reported = reporting(&participant);

    participant.start().await.expect("started");
    inner.lose();
    until(|| !locked(&reported).is_empty(), "its attempts spent").await;
    assert_eq!(
        *locked(&ran_at),
        Some(2),
        "that task runs before its second attempt"
    );
    assert_eq!(
        *locked(&reported),
        ["the link of ada went down, and 3 attempts did not bring it back"],
        "reported"
    );
    participant.stop().await;
}

// spec 15.21
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fails_a_link_its_stop_meets_as_it_connects_at_its_start_or_as_it_links_anew_and_stops_its_adapter_once_that_start_settles_nothing_left_subscribed()
 {
    let broker = broker();
    let (peer, _heard) = peer_of(&broker, ("peer", &[])).await;

    // at its start: held, then two stops, neither settled while it runs
    let ada = adapter_of(&broker, "ada");
    let holding = Arc::new(Calling {
        holds: Some(0),
        ..Calling::of(ada.clone())
    });
    let adapter: Arc<dyn BrokerAdapter> = Arc::<Calling>::clone(&holding);
    let participant = BrokerParticipant::new(adapter, &BrokerParticipantOptions::default())
        .expect("a participant");
    let links = linking(&participant);
    let starting = crate::testing::spawn(participant.start());

    until(|| holding.holding() == 1, "its start held").await;

    let stops = [
        crate::testing::spawn(participant.stop()),
        crate::testing::spawn(participant.stop()),
    ];

    settle().await;
    assert!(
        stops.iter().all(|stop| !stop.is_finished()),
        "neither stop settled"
    );
    assert_eq!(holding.calls(), ["start"], "its adapter not stopped yet");
    assert!(holding.release(), "released");

    for stop in stops {
        stop.await.expect("joined");
    }

    // * its start fails, stopped as it started, and its adapter stops once that start settled
    assert_eq!(
        starting
            .await
            .expect("joined")
            .expect_err("failed")
            .to_string(),
        "the participant ada stopped as it started",
        "its start fails"
    );
    assert_eq!(
        holding.calls(),
        ["start", "stop"],
        "its inbox never subscribed, its adapter stopped once"
    );
    assert!(
        !participant.is_linked() && !ada.is_linked(),
        "neither linked"
    );
    assert_eq!(*locked(&links), ["stopped"], "its stop alone told");
    assert_eq!(
        publish_to(&peer, (["bead", "i", "ada"], vec![0xB1])).await,
        BrokerPublished::NoSubscriber,
        "nothing subscribed"
    );

    // * with no turn between them, on a runtime of two threads: its start may link whole before its
    // stop is marked, so its outcome is not pinned, but nothing outlives its stop
    for _ in 0..100 {
        let fresh = super::broker();
        let (peer, _heard) = peer_of(&fresh, ("peer", &[])).await;
        let cy = adapter_of(&fresh, "cy");
        let participant = participant_of(&cy, &BrokerParticipantOptions::default());
        let links = linking(&participant);
        let starting = participant.start();
        let stopping = participant.stop();

        stopping.await;
        starting.await.ok();

        let links = locked(&links).clone();

        assert!(
            !participant.is_linked() && !cy.is_linked(),
            "neither linked"
        );
        assert_eq!(
            publish_to(&peer, (["bead", "i", "cy"], vec![0xB1])).await,
            BrokerPublished::NoSubscriber,
            "nothing subscribed"
        );
        assert_eq!(
            links
                .iter()
                .skip_while(|state| **state != "stopped")
                .count(),
            1,
            "its stop told, none after it: {links:?}"
        );
    }

    // as it links anew, at a delay of 0 with a tap: its attempt's start held, then its stop
    let bob = adapter_of(&broker, "bob");
    let holding = Arc::new(Calling {
        holds: Some(1),
        ..Calling::of(bob.clone())
    });
    let adapter: Arc<dyn BrokerAdapter> = Arc::<Calling>::clone(&holding);
    let tapped: Arc<Mutex<Vec<Duration>>> = Arc::default();
    let tapping = Arc::clone(&tapped);
    let participant = BrokerParticipant::new(
        adapter,
        &BrokerParticipantOptions {
            reconnect: Some(TransportClientReconnectOptions {
                tap: Some(Arc::new(move |delay, _attempt| {
                    locked(&tapping).push(delay);
                })),
                ..immediately()
            }),
            ..BrokerParticipantOptions::default()
        },
    )
    .expect("a participant");
    let reported = reporting(&participant);

    participant.start().await.expect("started");
    bob.lose();
    until(|| holding.holding() == 1, "its attempt's start held").await;

    let stopping = crate::testing::spawn(participant.stop());

    settle().await;
    assert!(!stopping.is_finished(), "its stop not settled");
    assert_eq!(
        holding.calls(),
        ["start", "subscribe bead/i/bob", "start"],
        "its adapter not stopped yet"
    );
    assert!(holding.release(), "released");
    stopping.await.expect("joined");
    until(|| !locked(&reported).is_empty(), "its reconnection ended").await;
    settle().await;

    // * its attempt fails, and its reconnection ends at once, no wait told after it
    assert_eq!(
        *locked(&reported),
        ["the link of bob went down, and its reconnection ended: the reconnection was cancelled"],
        "told so, once"
    );
    assert!(locked(&tapped).is_empty(), "no wait told");
    assert_eq!(
        holding.calls(),
        ["start", "subscribe bead/i/bob", "start", "stop"],
        "its inbox not subscribed anew, its adapter stopped once"
    );
    assert!(
        !participant.is_linked() && !bob.is_linked(),
        "neither linked"
    );
    assert_eq!(
        publish_to(&peer, (["bead", "i", "bob"], vec![0xB1])).await,
        BrokerPublished::NoSubscriber,
        "nothing subscribed"
    );
}

#[tokio::test]
async fn serves_its_names_again_once_its_link_connects_anew_its_former_peers_reset() {
    let pair = BrokerPair::of(&BrokerPairOptions::default()).await;
    let first = pair.connect().await;
    let former = pair.server_participant.incarnation();

    pair.server_adapter.lose();

    // * its connection closed, unclean; its name held again, by another incarnation
    until(
        || {
            first.ready_state() == ReadyState::Closed
                && pair.server_participant.is_linked()
                && pair
                    .server
                    .gauges()
                    .and_then(|gauges| gauges.counts.get("names").copied())
                    == Some(1)
        },
        "its connection closed, and its name held again",
    )
    .await;
    assert_ne!(
        former,
        pair.server_participant.incarnation(),
        "another incarnation"
    );

    let _second = pair.connect().await;

    assert_eq!(
        pair.server
            .clients()
            .into_iter()
            .map(|client| client.connection_handle.to_string())
            .collect::<Vec<_>>(),
        ["type=BROKER;participant=client;ordinal=2"],
        "served anew"
    );
    pair.stop().await;
}

#[tokio::test]
async fn reports_what_reaches_a_name_but_a_parcel_and_an_open_that_does_not_read_and_drops_in_silence_any_other_parcel_there_a_parcel_at_its_inbox_that_names_no_connection_and_anything_but_a_gone_at_a_departure()
 {
    const HALF: u64 = 0xA100_0000_0000_0001;
    let pair = BrokerPair::of(&BrokerPairOptions::default()).await;
    let client = pair.connect().await;
    let (tester, heard) = peer_of(&pair.broker, ("tester", &[])).await;
    let reported = reporting(&pair.server_participant);

    // an OPEN of a layout to come whose id runs past its bytes, and one whose kept byte is not 0
    let mut cut = encode_parcel(&Parcel {
        layout: 0xB2,
        opener: HALF,
        sequence: 1,
        id: Some("tester".to_owned()),
        bound: Some(65_536),
        ..Parcel::of(kinds::OPEN)
    })
    .expect("encoded");

    cut.truncate(31);

    let mut kept = write_parcel(&Parcel {
        opener: HALF,
        sequence: 1,
        id: Some("tester".to_owned()),
        incarnation: Some(0xC0),
        bound: Some(65_536),
        ..Parcel::of(kinds::OPEN)
    })
    .expect("written")
    .to_vec();
    let ping = write_parcel(&Parcel {
        opener: HALF,
        acceptor: HALF,
        sequence: 2,
        ..Parcel::of(kinds::PING)
    })
    .expect("written")
    .to_vec();
    let mut unread = ping.clone();

    for bytes in [&mut kept, &mut unread] {
        if let Some(byte) = bytes.get_mut(3) {
            *byte = 1;
        }
    }

    for payload in [vec![0xB1], cut, kept, ping.clone(), unread.clone()] {
        publish_to(&tester, (["bead", "s", "interop"], payload)).await;
    }

    // at its inbox, an ACCEPT of a layout to come and a parcel that does not read, naming no pair
    for payload in [
        encode_parcel(&Parcel {
            layout: 0xB2,
            opener: HALF,
            acceptor: HALF,
            sequence: 1,
            ..Parcel::of(kinds::ACCEPT)
        })
        .expect("encoded"),
        unread,
    ] {
        publish_to(&tester, (["bead", "i", "server"], payload)).await;
    }

    // at a departure it subscribes, no parcel and a parcel but a GONE
    for payload in [vec![0xB1], ping] {
        publish_to(&tester, (["bead", "d", "client"], payload)).await;
    }

    let reports = [
        "a message to the name interop is no parcel: 1 bytes, under a parcel's 28",
        "an OPEN to the name interop does not read, dropped: an OPEN whose id runs past its bytes",
        "an OPEN to the name interop does not read, dropped: a kept byte that is not 0",
    ];

    until(|| locked(&reported).len() == 3, "each reported").await;
    settle().await;

    // * each reported by its participant, and by its server transport with no handle
    assert_eq!(*locked(&reported), reports, "reported by its participant");
    assert_eq!(
        *locked(&pair.told.errors),
        reports.map(|report| (report.to_owned(), None)),
        "and by its server transport, with no handle"
    );
    assert_eq!(
        (
            heard.parcels().len(),
            client.ready_state(),
            pair.server.clients().len()
        ),
        (0, ReadyState::Open, 1),
        "nothing else"
    );
    pair.stop().await;
}

#[tokio::test]
async fn gives_no_life_to_a_publication_of_an_adapter_that_offers_none() {
    let broker = broker();
    let serving = Arc::new(Calling::of(adapter_of(&broker, "server")));
    let recording = Arc::new(Calling::of(
        broker
            .adapter(&MemoryBrokerAdapterOptions {
                capabilities: Some(
                    BrokerCapabilities::GROUPS
                        | BrokerCapabilities::WILL
                        | BrokerCapabilities::NO_SUBSCRIBER,
                ),
                ..MemoryBrokerAdapterOptions::new("client")
            })
            .expect("an adapter"),
    ));
    let server_adapter: Arc<dyn BrokerAdapter> = Arc::<Calling>::clone(&serving);
    let client_adapter: Arc<dyn BrokerAdapter> = Arc::<Calling>::clone(&recording);
    let server = BrokerParticipant::new(server_adapter, &BrokerParticipantOptions::default())
        .expect("a participant");
    let participant = BrokerParticipant::new(client_adapter, &BrokerParticipantOptions::default())
        .expect("a participant");
    let transport = server
        .server(&BrokerTransportServerOptions::new(["interop"]))
        .expect("a server");
    let told = Arc::new(ServerTold::default());

    transport.listen(Arc::new(AtServer(Arc::clone(&told))));
    transport.start().await.expect("started");

    let client = participant
        .client(&BrokerTransportClientOptions::default())
        .expect("a client");

    client
        .connect(&BrokerTransportClientConnectOptions::new("interop"))
        .await
        .expect("connected");
    client
        .send(TransportMessage {
            credential: Some("Interop sub=ada".to_owned()),
            ..data(&[
                0xA1, 0x10, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x22, 0x78,
                0x22,
            ])
        })
        .expect("sent");
    until(|| !locked(&told.messages).is_empty(), "heard").await;

    // * its OPEN, its credential's DATA and every other parcel asked no life of an adapter that
    // offers none; its server's, which offers one, gave none to its own parcels
    let lives = locked(&recording.lives).clone();

    assert!(lives.iter().any(|(kind, _)| *kind == "open"), "an OPEN");
    assert!(
        lives.iter().any(|(kind, _)| *kind == "credential"),
        "a credential's DATA"
    );
    assert!(
        lives
            .iter()
            .chain(locked(&serving.lives).iter())
            .all(|(_, life)| life.is_none()),
        "no life asked"
    );
    transport.stop().await.expect("stopped");
    participant.stop().await;
    server.stop().await;
}

// spec 15.21
#[tokio::test]
async fn a_participant_taken_over_reports_it_connects_no_more_and_fails_each_connect_naming_it_until_it_is_started_again()
 {
    let pair = BrokerPair::of(&BrokerPairOptions::default()).await;
    let client = pair.connect().await;
    let told = Arc::new(ClientTold::default());
    let reported = reporting(&pair.client_participant);
    let former = pair.client_participant.incarnation();

    client.listen(Arc::new(AtClient(Arc::clone(&told))));

    // a connect its link is taken over under fails, naming it
    let (_silent, heard) = peer_of(&pair.broker, ("silent", &[&["bead", "s", "silent"]])).await;
    let waiting = pair
        .client_participant
        .client(&BrokerTransportClientOptions::default())
        .expect("a client");
    let pending =
        crate::testing::spawn(waiting.connect(&BrokerTransportClientConnectOptions::new("silent")));

    until(|| heard.parcels().len() == 1, "its OPEN reaches the name").await;
    pair.client_adapter.take_over();
    assert_eq!(
        error_of(pending.await.expect("joined")),
        "the link of client was taken over by another link of its id as it connected",
        "the connect fails"
    );

    // * its connection closed, unclean, as at any down, and the takeover reported, once
    until(|| !locked(&told.closes).is_empty(), "its connection closed").await;
    assert_eq!(*locked(&told.closes), [(false, false)], "unclean");
    until(|| !locked(&reported).is_empty(), "the takeover reported").await;
    settle().await;
    assert_eq!(
        *locked(&reported),
        ["the link of client was taken over by another link of its id"],
        "reported once"
    );

    // * it connects no more: no link anew, and a connect fails at once naming the takeover
    assert!(!pair.client_adapter.is_linked(), "no link anew");
    assert!(!pair.client_participant.is_linked(), "not linked");
    assert_eq!(
        error_of(
            pair.client_participant
                .client(&BrokerTransportClientOptions::default())
                .expect("a client")
                .connect(&BrokerTransportClientConnectOptions::new("interop"))
                .await
        ),
        "the link of client was taken over by another link of its id, and connects no more until it is started again",
        "a connect refused"
    );
    assert!(!pair.client_adapter.is_linked(), "no link anew");

    // * its application's start links it anew, another incarnation, and a connect then opens
    pair.client_participant.start().await.expect("started");
    assert!(pair.client_participant.is_linked(), "linked anew");
    assert_ne!(
        former,
        pair.client_participant.incarnation(),
        "another incarnation"
    );

    let again = pair.connect().await;

    assert_eq!(again.ready_state(), ReadyState::Open, "open");
    assert_eq!(locked(&reported).len(), 1, "reported once");
    pair.stop().await;
}

// spec 15.21
#[tokio::test]
async fn fails_a_link_that_goes_down_as_it_connects_at_its_start_or_as_it_links_anew_and_fences_it_where_another_link_of_its_id_took_it_over_then()
 {
    // what hears the link's loss, after its participant: its participant's turn is posted by then
    struct Losing(Arc<AtomicUsize>);

    impl BrokerListener for Losing {
        fn on_down(&self, _down: crate::broker::adapter::BrokerDown) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }

        fn on_message(&self, _message: &BrokerMessage) {}
    }

    let broker = broker();
    let inner = adapter_of(&broker, "ada");
    let granting = Arc::new(Calling {
        grants: true,
        ..Calling::of(inner.clone())
    });
    let adapter: Arc<dyn BrokerAdapter> = Arc::<Calling>::clone(&granting);
    let participant = BrokerParticipant::new(
        adapter,
        &BrokerParticipantOptions {
            reconnect: Some(TransportClientReconnectOptions {
                maximum_attempts: Some(5),
                ..immediately()
            }),
            ..BrokerParticipantOptions::default()
        },
    )
    .expect("a participant");
    let reported = reporting(&participant);
    let lost = Arc::new(AtomicUsize::new(0));

    inner.listen(Arc::new(Losing(Arc::clone(&lost))));

    // a loss as it subscribes its inbox fails its start, though its SUBACK came
    let starting = participant.start();

    until(|| granting.asked() > 0, "its inbox asked of its broker").await;
    inner.lose();
    until(|| lost.load(Ordering::SeqCst) == 1, "its loss heard").await;
    settle().await;
    assert!(granting.grant(), "granted");
    assert_eq!(
        starting.await.expect_err("failed").to_string(),
        "the link of ada went down as it connected",
        "its start fails"
    );
    assert!(!participant.is_linked(), "down");
    assert!(locked(&reported).is_empty(), "nothing reported");

    // * the next start links anew
    let again = participant.start();

    until(|| granting.asked() > 0, "its inbox asked of its broker").await;
    assert!(granting.grant(), "granted");
    again.await.expect("linked");
    assert!(participant.is_linked(), "linked");

    // a takeover as it links anew fences it: reported once, and no attempt after it
    inner.lose();
    until(
        || granting.asked() > 0,
        "its inbox asked anew of its broker",
    )
    .await;
    inner.take_over();
    until(|| !locked(&reported).is_empty(), "the takeover reported").await;
    assert!(granting.grant(), "granted");
    settle().await;
    assert_eq!(
        *locked(&reported),
        ["the link of ada was taken over by another link of its id"],
        "reported once"
    );
    assert_eq!(granting.asked(), 0, "no attempt after it");
    assert!(!participant.is_linked(), "fenced");
    assert_eq!(
        error_of(
            participant
                .client(&BrokerTransportClientOptions::default())
                .expect("a client")
                .connect(&BrokerTransportClientConnectOptions::new("interop"))
                .await
        ),
        "the link of ada was taken over by another link of its id, and connects no more until it is started again",
        "a connect refused"
    );
    participant.stop().await;
}

// ── A stop in place, its next link, and a dispose (spec 15.21) ────────────────────────────────

// a server's transport serving `interop` over `broker`, started, and its participant
async fn serving(broker: &MemoryBroker) -> (BrokerParticipant, BrokerTransportServer) {
    let participant = participant_of(
        &adapter_of(broker, "server"),
        &BrokerParticipantOptions::default(),
    );
    let server = participant
        .server(&BrokerTransportServerOptions::new(["interop"]))
        .expect("a server");

    server.start().await.expect("started");

    (participant, server)
}

// stops `participant`, whose adapter `holding` holds each stop, once that stop is held
async fn stopped(participant: &BrokerParticipant, holding: &Calling) {
    let stopping = crate::testing::spawn(participant.stop());

    until(|| holding.stopping() == 1, "its adapter's stop held").await;
    assert!(holding.release_stop(), "released");
    stopping.await.expect("joined");
}

// spec 15.21
#[tokio::test]
async fn stops_in_place_and_starts_again_as_another_incarnation_its_server_transports_names_served_again_and_its_listeners_kept_no_will_gone()
 {
    let pair = BrokerPair::of(&BrokerPairOptions::default()).await;
    let (_watching, departed) =
        peer_of(&pair.broker, ("watching", &[&["bead", "d", "server"]])).await;
    let client = pair.connect().await;
    let told = Arc::new(ClientTold::default());
    let links = linking(&pair.server_participant);
    let reported = reporting(&pair.server_participant);
    let former = pair.server_participant.incarnation();
    let names = || {
        pair.server
            .gauges()
            .and_then(|gauges| gauges.counts.get("names").copied())
    };

    client.listen(Arc::new(AtClient(Arc::clone(&told))));
    pair.server_participant.stop().await;

    // * each connection closed with a CLOSE of 1001, unclean at both ends, its link ended, its name
    // held no more, its server's transport kept
    until(
        || locked(&told.closes).len() == 1,
        "its client told its close",
    )
    .await;
    assert_eq!(*locked(&told.closes), [(false, false)], "closed with 1001");
    assert_eq!(
        locked(&pair.told.closed)
            .iter()
            .map(|(is_clean, _)| *is_clean)
            .collect::<Vec<_>>(),
        [false],
        "its server's end told closed, unclean"
    );
    assert!(
        !pair.server_participant.is_linked() && !pair.server_adapter.is_linked(),
        "its link ended"
    );
    assert_eq!(names(), Some(0), "its name held no more");
    assert!(pair.server_participant.names().is_empty(), "none held");
    assert_eq!(
        pair.server.ready_state(),
        ReadyState::Open,
        "its server's transport kept"
    );

    // * its next start: another incarnation, its name served again, each listener kept
    pair.server_participant.start().await.expect("started");
    assert!(pair.server_participant.is_linked(), "linked anew");
    assert_ne!(
        pair.server_participant.incarnation(),
        former,
        "another incarnation"
    );
    until(|| names() == Some(1), "its name served again").await;

    let again = pair.connect().await;

    assert_eq!(again.ready_state(), ReadyState::Open, "served anew");
    assert_eq!(*locked(&links), ["stopped", "up"], "its trace heard on");
    assert!(locked(&reported).is_empty(), "nothing reported");
    settle().await;
    assert!(departed.parcels().is_empty(), "no will gone");
    pair.stop().await;
}

// spec 15.21
#[tokio::test]
async fn refuses_a_start_while_its_stop_is_under_way_and_links_anew_at_a_start_a_connect_or_a_server_s_start_once_that_stop_settled()
 {
    let broker = broker();
    let (serving, _server) = serving(&broker).await;
    let ada = adapter_of(&broker, "ada");
    let holding = Arc::new(Calling {
        holds_stops: true,
        ..Calling::of(ada.clone())
    });
    let participant = BrokerParticipant::new(
        Arc::<Calling>::clone(&holding),
        &BrokerParticipantOptions::default(),
    )
    .expect("a participant");

    participant.start().await.expect("started");

    let mut incarnations = vec![participant.incarnation()];

    // * a start while its stop is under way: its application's misuse, refused
    let stopping = crate::testing::spawn(participant.stop());

    until(|| holding.stopping() == 1, "its adapter's stop held").await;

    let refused = participant.start().await.expect_err("refused");

    assert!(matches!(refused, BrokerError::Refused(_)), "a misuse");
    assert_eq!(
        refused.to_string(),
        "the participant ada is stopping",
        "its words"
    );
    assert!(holding.release_stop(), "released");
    stopping.await.expect("joined");
    assert!(!participant.is_linked(), "down");

    // * a connect once that stop settled, then a stop with no turn between them: that stop ends
    // what the connect would link
    let connecting = crate::testing::spawn(
        participant
            .client(&BrokerTransportClientOptions::default())
            .expect("a client")
            .connect(&BrokerTransportClientConnectOptions::new("interop")),
    );

    stopped(&participant, &holding).await;
    assert_eq!(
        error_of(connecting.await.expect("joined")),
        "the participant ada stopped as it connected",
        "the connect fails"
    );
    settle().await;
    assert!(!participant.is_linked(), "linked by none");

    // * once that stop settled, a start links it anew
    participant.start().await.expect("started");
    assert!(participant.is_linked(), "linked anew by a start");
    incarnations.push(participant.incarnation());

    // * so does a client's connect over it
    stopped(&participant, &holding).await;
    participant
        .client(&BrokerTransportClientOptions::default())
        .expect("a client")
        .connect(&BrokerTransportClientConnectOptions::new("interop"))
        .await
        .expect("connected");
    assert!(participant.is_linked(), "linked anew by a connect");
    incarnations.push(participant.incarnation());

    // * and a server's start over it
    stopped(&participant, &holding).await;

    let own = participant
        .server(&BrokerTransportServerOptions::new(["own"]))
        .expect("a server");

    own.start().await.expect("started");
    assert!(participant.is_linked(), "linked anew by a server's start");
    assert_eq!(
        participant.names(),
        std::iter::once("own".to_owned()).collect(),
        "its name served"
    );
    incarnations.push(participant.incarnation());
    assert_eq!(
        incarnations.iter().collect::<HashSet<_>>().len(),
        4,
        "each link another incarnation"
    );
    stopped(&participant, &holding).await;
    serving.stop().await;
}

// spec 15.21
#[tokio::test]
async fn refuses_a_start_once_disposed_lets_its_adapter_go_and_disposes_once_stopping_it_first() {
    let broker = broker();
    let ada = adapter_of(&broker, "ada");
    let recording = Arc::new(Calling::of(ada.clone()));
    let participant = BrokerParticipant::new(
        Arc::<Calling>::clone(&recording),
        &BrokerParticipantOptions::default(),
    )
    .expect("a participant");
    let links = linking(&participant);

    participant.start().await.expect("started");
    assert_eq!(recording.listening(), 1, "its adapter heard");

    // * two disposes: one stop of its adapter, then its listener let go of, once
    let disposing = [
        crate::testing::spawn(participant.dispose()),
        crate::testing::spawn(participant.dispose()),
    ];

    for disposed in disposing {
        disposed.await.expect("joined");
    }

    assert_eq!(
        recording.calls(),
        ["start", "subscribe bead/i/ada", "stop", "unlisten"],
        "stopped first, then let go of, once"
    );
    assert_eq!(recording.listening(), 0, "its adapter heard no more");
    assert!(
        !participant.is_linked() && !ada.is_linked(),
        "neither linked"
    );

    // * a start once disposed: its application's misuse, refused before anything moves
    let refused = participant.start().await.expect_err("refused");

    assert!(matches!(refused, BrokerError::Refused(_)), "a misuse");
    assert_eq!(
        refused.to_string(),
        "the participant ada is disposed",
        "its words"
    );

    // * a stop or a dispose after it settles with it, nothing asked of its adapter, nothing told
    participant.stop().await;
    participant.dispose().await;
    settle().await;
    assert_eq!(recording.calls().len(), 4, "nothing more asked");
    assert_eq!(*locked(&links), ["up", "stopped"], "its stop told once");
}

// spec 15.21
#[tokio::test]
async fn attributes_to_its_stop_what_that_stop_ended_though_a_start_follows_it_at_once_and_lets_the_next_link_stand()
 {
    let broker = broker();
    let (serving, _server) = serving(&broker).await;
    let ada = adapter_of(&broker, "ada");
    let holding = Arc::new(Calling {
        holds: Some(1),
        ..Calling::of(ada.clone())
    });
    let participant = BrokerParticipant::new(
        Arc::<Calling>::clone(&holding),
        &BrokerParticipantOptions {
            reconnects: Some(false),
            ..BrokerParticipantOptions::default()
        },
    )
    .expect("a participant");
    let reported = hearing(&participant);
    let waiting = participant
        .client(&BrokerTransportClientOptions::default())
        .expect("a client");
    let again = participant
        .client(&BrokerTransportClientOptions::default())
        .expect("a client");

    again
        .connect(&BrokerTransportClientConnectOptions::new("interop"))
        .await
        .expect("connected");
    ada.lose();
    until(|| !locked(&reported).is_empty(), "its link down").await;
    until(
        || again.ready_state() == ReadyState::Closed,
        "closed as its link goes down",
    )
    .await;

    // a link's start, a connect awaiting it and a client's reconnection in flight, its start held
    let starting = crate::testing::spawn(participant.start());

    until(|| holding.holding() == 1, "its start held").await;

    let connecting = crate::testing::spawn(
        waiting.connect(&BrokerTransportClientConnectOptions::new("interop")),
    );
    let reconnecting = crate::testing::spawn(
        again
            .reconnect(&TransportClientReconnectOptions {
                delay: Some(TransportClientReconnectDelay::Fixed(Duration::from_secs(
                    60,
                ))),
                ..TransportClientReconnectOptions::default()
            })
            .expect("reconnecting"),
    );

    settle().await;

    let stopping = crate::testing::spawn(participant.stop());

    // * the connect and the reconnection end at once, its start held still
    until(
        || connecting.is_finished() && reconnecting.is_finished(),
        "each ended",
    )
    .await;
    assert!(holding.release(), "released");
    stopping.await.expect("joined");

    // ! a start, with no turn between it and the stop's end
    let restarting = crate::testing::spawn(participant.start());

    until(|| holding.holding() == 1, "its next start held").await;
    assert!(holding.release(), "released");
    restarting.await.expect("joined").expect("started");

    // * each told as the stop's, though a start followed it at once
    assert_eq!(
        starting
            .await
            .expect("joined")
            .expect_err("failed")
            .to_string(),
        "the participant ada stopped as it started",
        "its start"
    );
    assert_eq!(
        error_of(connecting.await.expect("joined")),
        "the participant ada stopped as it connected",
        "the connect"
    );

    let reconnected = reconnecting.await.expect("joined");

    assert!(
        matches!(&reconnected, Err(TransportError::Cancelled { message, .. }) if message == "the reconnection was cancelled"),
        "the reconnection cancelled: {reconnected:?}"
    );
    assert_eq!(
        reconnected
            .as_ref()
            .err()
            .and_then(std::error::Error::source)
            .map(ToString::to_string)
            .as_deref(),
        Some("the participant ada stopped"),
        "its stop its source"
    );

    // * the next link stands: linked, and a connect goes through it
    settle().await;
    assert!(participant.is_linked(), "linked");
    waiting
        .connect(&BrokerTransportClientConnectOptions::new("interop"))
        .await
        .expect("connected");
    assert_eq!(waiting.ready_state(), ReadyState::Open, "open");
    assert_eq!(
        locked(&reported)
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        ["the link of ada went down"],
        "its loss alone reported"
    );
    participant.dispose().await;
    serving.stop().await;
}

// spec 15.21
#[tokio::test]
async fn resets_at_its_next_link_each_peer_whose_close_its_broker_did_not_take_as_it_stopped() {
    let broker = broker();
    let (serving, server) = serving(&broker).await;
    let told = Arc::new(ServerTold::default());
    let (_spy, heard) = peer_of(&broker, ("spy", &[&["bead", "i", "server"]])).await;
    let dropping = Arc::new(Calling::of(adapter_of(&broker, "ada")));
    let participant = BrokerParticipant::new(
        Arc::<Calling>::clone(&dropping),
        &BrokerParticipantOptions::default(),
    )
    .expect("a participant");
    let clients = [
        participant
            .client(&BrokerTransportClientOptions::default())
            .expect("a client"),
        participant
            .client(&BrokerTransportClientOptions::default())
            .expect("a client"),
    ];

    server.listen(Arc::new(AtServer(Arc::clone(&told))));

    for client in &clients {
        client
            .connect(&BrokerTransportClientConnectOptions::new("interop"))
            .await
            .expect("connected");
    }

    until(|| locked(&told.opened).len() == 2, "each told open").await;

    let pairs: Vec<_> = clients
        .iter()
        .map(|client| client.pair().expect("a pair"))
        .collect();
    let (dropped, taken) = (pairs[0], pairs[1]);

    // * the CLOSE of the first its broker does not take; the second's goes
    *locked(&dropping.drops_close) = Some(dropped.0);
    locked(&heard.messages).clear();
    participant.stop().await;
    until(|| locked(&told.closed).len() == 1, "one told closed").await;
    settle().await;

    let closes: Vec<_> = heard
        .parcels()
        .into_iter()
        .filter(|parcel| parcel.kind == kinds::CLOSE)
        .map(|parcel| (parcel.opener, parcel.acceptor))
        .collect();

    assert_eq!(closes, [taken], "the second's CLOSE alone reached its peer");
    assert_eq!(locked(&told.closed).len(), 1, "the first held still");

    // * its next link resets the first, whose CLOSE did not go, and no other
    locked(&heard.messages).clear();
    participant.start().await.expect("started");
    until(|| locked(&told.closed).len() == 2, "the first reset").await;
    settle().await;

    let resets: Vec<_> = heard
        .parcels()
        .into_iter()
        .filter(|parcel| parcel.kind == kinds::RESET)
        .map(|parcel| (parcel.opener, parcel.acceptor))
        .collect();

    assert_eq!(resets, [dropped], "a RESET of the first alone");
    assert!(
        locked(&told.closed).iter().all(|(is_clean, _)| !is_clean),
        "each closed, unclean"
    );

    // * a stop and a start again: none left to reset
    participant.stop().await;
    locked(&heard.messages).clear();
    participant.start().await.expect("started");
    settle().await;
    assert!(
        heard
            .parcels()
            .iter()
            .all(|parcel| parcel.kind != kinds::RESET),
        "no RESET again"
    );
    participant.dispose().await;
    serving.stop().await;
}

// ── A stop that lets each name go first (spec 15.18, 15.21) ───────────────────────────────────

// a participant of the id `server` over `calling`, serving `interop`, started, what its server's
// transport tells written down; and a client of `client`'s, connected, its close written down
async fn letting(
    (broker, calling): (&MemoryBroker, &Arc<Calling>),
) -> (
    BrokerParticipant,
    BrokerTransportServer,
    Arc<ServerTold>,
    Arc<ClientTold>,
) {
    let participant = BrokerParticipant::new(
        Arc::<Calling>::clone(calling),
        &BrokerParticipantOptions::default(),
    )
    .expect("a participant");
    let server = participant
        .server(&BrokerTransportServerOptions::new(["interop"]))
        .expect("a server");
    let told = Arc::new(ServerTold::default());
    let clients = participant_of(
        &adapter_of(broker, "client"),
        &BrokerParticipantOptions::default(),
    );
    let client = clients
        .client(&BrokerTransportClientOptions::default())
        .expect("a client");
    let client_told = Arc::new(ClientTold::default());

    server.listen(Arc::new(AtServer(Arc::clone(&told))));
    server.start().await.expect("started");
    client.listen(Arc::new(AtClient(Arc::clone(&client_told))));
    client
        .connect(&BrokerTransportClientConnectOptions::new("interop"))
        .await
        .expect("connected");
    until(|| locked(&told.opened).len() == 1, "told open").await;

    (participant, server, told, client_told)
}

// the `names` events its trace tells, each its name and whether held (debugging 13.5)
fn naming(participant: &BrokerParticipant) -> Arc<Mutex<Vec<(String, bool)>>> {
    let told: Arc<Mutex<Vec<(String, bool)>>> = Arc::default();
    let hearing = Arc::clone(&told);

    participant.on_debug(Arc::new(move |event: &ParticipantDebugEvent| {
        if event.event == "names"
            && let (Some(name), Some(is_held)) = (&event.name, event.is_held)
        {
            locked(&hearing).push((name.clone(), is_held));
        }
    }));

    told
}

fn gauge_of(server: &BrokerTransportServer, name: &str) -> Option<u64> {
    server
        .gauges()
        .and_then(|gauges| gauges.counts.get(name).copied())
}

// what it asked of its adapter since `before` but its peers' departures, which each connection's
// end lets go
fn calls_since(calling: &Calling, before: usize) -> Vec<String> {
    calling
        .calls()
        .get(before..)
        .unwrap_or_default()
        .iter()
        .filter(|call| !call.contains("bead/d/"))
        .cloned()
        .collect()
}

// spec 15.21
#[tokio::test]
async fn a_participant_s_stop_lets_each_name_go_and_closes_each_connection_with_1001_at_its_call_then_stops_its_adapter_once_its_broker_let_each_go_each_served_again_at_its_next_link()
 {
    let broker = broker();
    let calling = Arc::new(Calling {
        holds_unsubscribes: true,
        ..Calling::of(adapter_of(&broker, "server"))
    });
    let (participant, server, told, client_told) = letting((&broker, &calling)).await;
    let before = calling.calls().len();
    let stopping = crate::testing::spawn(participant.stop());

    // * in its turn, its name's unsubscription, then its CLOSE: its link down, its connection
    // forgotten, nothing handed on after its call, its adapter up
    until(|| calling.unsubscribing() == 1, "its name let go of").await;
    until(
        || locked(&client_told.closes).len() == 1,
        "its client told its close",
    )
    .await;
    assert_eq!(
        calls_since(&calling, before),
        ["unsubscribe bead/s/interop", "publish bead/i/client"],
        "its name's unsubscription, then its CLOSE"
    );
    assert_eq!(*locked(&client_told.closes), [(false, false)], "with 1001");
    assert!(!participant.is_linked(), "down from its call");
    assert_eq!(
        gauge_of(&server, "connections"),
        Some(0),
        "its connection forgotten"
    );
    assert!(locked(&told.messages).is_empty(), "nothing handed on");
    settle().await;
    assert!(!stopping.is_finished(), "awaiting its broker's word");

    // * its adapter stopped once its broker let its name go
    assert!(calling.settle_unsubscribe(Ok(())), "let go");
    stopping.await.expect("joined");
    assert_eq!(
        calls_since(&calling, before),
        [
            "unsubscribe bead/s/interop",
            "publish bead/i/client",
            "stop"
        ],
        "then its adapter's stop"
    );
    assert!(participant.names().is_empty(), "none held");

    // * served again at its next link
    participant.start().await.expect("started");
    until(|| gauge_of(&server, "names") == Some(1), "served again").await;

    let disposing = crate::testing::spawn(participant.dispose());

    until(|| calling.unsubscribing() == 1, "let go of again").await;
    assert!(calling.settle_unsubscribe(Ok(())), "let go");
    disposing.await.expect("joined");
}

// spec 15.18, 15.21
#[tokio::test]
async fn refuses_503_an_open_that_comes_while_its_stop_lets_its_names_go_its_adapter_up() {
    let broker = broker();
    let calling = Arc::new(Calling {
        holds_unsubscribes: true,
        ..Calling::of(adapter_of(&broker, "server"))
    });
    let (participant, _server, told, _client_told) = letting((&broker, &calling)).await;
    let (late, heard) = peer_of(&broker, ("late", &[])).await;
    let stopping = crate::testing::spawn(participant.stop());

    until(|| calling.unsubscribing() == 1, "its name let go of").await;

    // * its broker holds its name still: the OPEN reaches it, and is refused 503, its adapter up
    let open = write_parcel(&Parcel {
        opener: 0xA400_0000_0000_0004,
        sequence: 1,
        id: Some("late".to_owned()),
        incarnation: Some(0xC0),
        bound: Some(65_536),
        ..Parcel::of(kinds::OPEN)
    })
    .expect("written")
    .to_vec();

    assert_eq!(
        publish_to(&late, (["bead", "s", "interop"], open)).await,
        BrokerPublished::Taken,
        "its broker holds its name"
    );
    until(|| !heard.parcels().is_empty(), "the OPEN answered").await;
    assert_eq!(
        heard
            .parcels()
            .iter()
            .map(|parcel| (parcel.kind, parcel.opener, parcel.status))
            .collect::<Vec<_>>(),
        [(kinds::REFUSE, 0xA400_0000_0000_0004, Some(503))],
        "refused 503"
    );
    assert_eq!(
        locked(&told.refusals)
            .iter()
            .map(|refusal| (
                refusal.status,
                refusal.reason.clone(),
                refusal.address.clone()
            ))
            .collect::<Vec<_>>(),
        [(503, "busy".to_owned(), Some("late".to_owned()))],
        "told"
    );
    assert_eq!(locked(&told.opened).len(), 1, "no connection told");
    assert!(calling.settle_unsubscribe(Ok(())), "let go");
    stopping.await.expect("joined");
    participant.dispose().await;
}

// spec 15.21
#[tokio::test]
async fn lets_go_at_its_stop_a_name_whose_subscription_is_under_way() {
    let broker = broker();
    let calling = Arc::new(Calling {
        holds_names: true,
        holds_stops: true,
        ..Calling::of(adapter_of(&broker, "server"))
    });
    let participant = BrokerParticipant::new(
        Arc::<Calling>::clone(&calling),
        &BrokerParticipantOptions::default(),
    )
    .expect("a participant");
    let names = naming(&participant);
    let (asking, _heard) = peer_of(&broker, ("asking", &[])).await;

    participant.start().await.expect("started");

    let server = participant
        .server(&BrokerTransportServerOptions::new(["interop"]))
        .expect("a server");
    let starting = crate::testing::spawn(server.start());

    until(|| calling.naming() == 1, "its name asked of its broker").await;

    // * asked, unanswered: its stop lets it go all the same, its broker's word on it coming after
    let stopping = crate::testing::spawn(participant.stop());

    until(
        || {
            calling
                .calls()
                .contains(&"unsubscribe bead/s/interop".to_owned())
        },
        "its name let go of",
    )
    .await;
    assert!(calling.grant_name(), "its broker's word on it");
    until(|| calling.stopping() == 1, "its adapter's stop held").await;
    assert_eq!(
        publish_to(&asking, (["bead", "s", "interop"], vec![0])).await,
        BrokerPublished::NoSubscriber,
        "let go before its adapter's stop"
    );
    assert!(participant.names().is_empty(), "never held");
    assert!(
        !locked(&names).iter().any(|(_, is_held)| *is_held),
        "never told held"
    );
    assert!(calling.release_stop(), "released");
    stopping.await.expect("joined");
    starting.await.expect("joined").ok();
    participant.dispose().await;
}

// spec 15.21
#[tokio::test]
async fn reports_a_name_its_broker_refuses_to_let_go_at_its_stop_keeps_it_held_and_stops_all_the_same()
 {
    let broker = broker();
    let calling = Arc::new(Calling {
        holds_unsubscribes: true,
        holds_stops: true,
        ..Calling::of(adapter_of(&broker, "server"))
    });
    let (participant, server, _told, _client_told) = letting((&broker, &calling)).await;
    let reported = reporting(&participant);
    let names = naming(&participant);
    let stopping = crate::testing::spawn(participant.stop());

    until(|| calling.unsubscribing() == 1, "its name let go of").await;
    assert!(
        calling.settle_unsubscribe(Err(BrokerError::failed(
            "its broker refused to let bead/s/interop go: 0x80"
        ))),
        "refused"
    );

    // * reported, held still, and its adapter stopped all the same
    until(|| calling.stopping() == 1, "its adapter's stop held").await;
    assert_eq!(
        *locked(&reported),
        ["its broker refused to let bead/s/interop go: 0x80"],
        "reported"
    );
    assert_eq!(
        participant.names(),
        std::iter::once("interop".to_owned()).collect(),
        "held still"
    );
    assert_eq!(gauge_of(&server, "names"), Some(1), "counted");
    assert!(locked(&names).is_empty(), "told nothing");
    assert!(calling.release_stop(), "released");
    stopping.await.expect("joined");

    // * its stopped clears it
    assert!(participant.names().is_empty(), "none held once stopped");
    assert_eq!(gauge_of(&server, "names"), Some(0), "none counted");
    participant.dispose().await;
}

// spec 15.21
#[tokio::test]
async fn tells_nothing_of_a_name_its_link_lost_as_it_stopped() {
    let broker = broker();
    let calling = Arc::new(Calling {
        holds_unsubscribes: true,
        holds_stops: true,
        ..Calling::of(adapter_of(&broker, "server"))
    });
    let (participant, _server, _told, _client_told) = letting((&broker, &calling)).await;
    let reported = reporting(&participant);
    let names = naming(&participant);
    let stopping = crate::testing::spawn(participant.stop());

    until(|| calling.unsubscribing() == 1, "its name let go of").await;

    // * its link lost as it lets its name go: what fails then is that loss, reported by none
    calling.inner.lose();
    until(|| !calling.inner.is_linked(), "its link lost").await;
    settle().await;
    assert!(
        calling.settle_unsubscribe(Err(BrokerError::failed("the link of server is not up"))),
        "failed"
    );
    until(|| calling.stopping() == 1, "its adapter's stop held").await;
    assert!(locked(&reported).is_empty(), "nothing reported");
    assert!(locked(&names).is_empty(), "told nothing");
    assert!(calling.release_stop(), "released");
    stopping.await.expect("joined");
    assert!(participant.names().is_empty(), "none held once stopped");
    assert!(
        locked(&reported).is_empty(),
        "nothing reported once stopped"
    );

    // * its link lost as it lets its name go, its broker letting it go after: told nothing all the
    // same, and held until its stop settles
    participant.start().await.expect("started");
    until(
        || participant.names().len() == 1,
        "its name held at its next link",
    )
    .await;
    locked(&names).clear();

    let restopping = crate::testing::spawn(participant.stop());

    until(|| calling.unsubscribing() == 1, "its name let go of again").await;
    calling.inner.lose();
    until(|| !calling.inner.is_linked(), "its link lost again").await;
    settle().await;
    assert!(calling.settle_unsubscribe(Ok(())), "let go");
    until(|| calling.stopping() == 1, "its adapter's stop held again").await;
    assert!(locked(&names).is_empty(), "told nothing, let go");
    assert_eq!(participant.names().len(), 1, "held until its stop settles");
    assert!(calling.release_stop(), "released again");
    restopping.await.expect("joined");
    assert!(
        participant.names().is_empty(),
        "none held once stopped again"
    );
    assert!(locked(&reported).is_empty(), "nothing reported, let go");
    participant.dispose().await;
}
