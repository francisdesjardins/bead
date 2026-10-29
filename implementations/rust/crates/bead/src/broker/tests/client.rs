//! A broker's client transport (spec 15.15, 15.18): its connect's ends, refused, timed out or
//! cancelled, and its reconnection, a new connection through the same name.

use core::time::Duration;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::{
    AtClient, BrokerPair, BrokerPairOptions, ClientTold, Heard, adapter_of, broker, locked,
    participant_of, peer_of, publish_to, until,
};
use crate::broker::adapter::{BrokerAdapter, BrokerPublication};
use crate::broker::client::{BrokerClientOptions, BrokerConnectOptions};
use crate::broker::memory::{MemoryBroker, MemoryBrokerOptions};
use crate::broker::parcel::{Parcel, flags, kinds, write_parcel};
use crate::broker::participant::{BrokerParticipantOptions, BrokerRefusedError};
use crate::clock::SharedClock;
use crate::errors::TransportError;
use crate::router::types::TransportMessage;
use crate::testing::SteppingClock;
use crate::transport::{
    ClientListener, ClientTransport, DisconnectOptions, ReadyState, ReconnectDelay,
    ReconnectOptions, ServerTransport,
};

const INBOX: [&str; 3] = ["bead", "i", "ada"];

// the half of the test's own server
const HALF: u64 = 0xA100_0000_0000_0001;

fn data(bytes: &[u8]) -> TransportMessage {
    TransportMessage {
        data: Bytes::copy_from_slice(bytes),
        ..TransportMessage::default()
    }
}

// the half of the connect whose OPEN the test's own server read first
async fn opener_of(heard: &Heard) -> u64 {
    until(|| !heard.parcels().is_empty(), "its OPEN reaches the name").await;

    heard
        .parcels()
        .first()
        .map(|open| open.opener)
        .unwrap_or_default()
}

// the ACCEPT its server answers the OPEN of `opener` with, its own half `HALF`
fn accept_of(opener: u64) -> Vec<u8> {
    write_parcel(&Parcel {
        flags: Some(flags::SECURE),
        opener,
        acceptor: HALF,
        sequence: 1,
        id: Some("acceptor".to_owned()),
        incarnation: Some(0),
        bound: Some(65_536),
        ..Parcel::of(kinds::ACCEPT)
    })
    .expect("written")
    .to_vec()
}

fn refusal_of(outcome: &Result<(), TransportError>) -> Option<BrokerRefusedError> {
    match outcome {
        Err(TransportError::Connect(error)) => std::error::Error::source(error)
            .and_then(|source| source.downcast_ref::<BrokerRefusedError>())
            .cloned(),
        Ok(()) | Err(_) => None,
    }
}

#[tokio::test]
async fn fails_a_connect_refused_or_past_its_time_or_cancelled_and_refuses_what_it_cannot_take() {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let broker = MemoryBroker::new(&MemoryBrokerOptions {
        clock: Some(Arc::clone(&shared)),
        ..MemoryBrokerOptions::default()
    })
    .expect("a broker");
    let ada = participant_of(
        &adapter_of(&broker, "ada"),
        &BrokerParticipantOptions {
            clock: Some(Arc::clone(&shared)),
            ..BrokerParticipantOptions::default()
        },
    );
    let client = ada
        .client(&BrokerClientOptions::default())
        .expect("a client");

    // nothing serves the name: its broker says so, and the connect fails at once, its refusal the
    // source
    let failed = client.connect(BrokerConnectOptions::of("nobody")).await;
    let refused = refusal_of(&failed).expect("a refusal");

    assert_eq!(
        (refused.reason(), refused.status()),
        (BrokerRefusedError::NO_SUBSCRIBER, None),
        "no subscriber"
    );
    assert_eq!(
        refused.to_string(),
        "no participant serves the name: no-subscriber",
        "named"
    );

    // one that serves it and never answers: past its time, on the clock given
    let (_silent, heard) = peer_of(&broker, ("silent", &[&["bead", "s", "interop"]])).await;
    let timing = tokio::spawn(client.connect(BrokerConnectOptions {
        timeout: Some(Duration::from_secs(1)),
        ..BrokerConnectOptions::of("interop")
    }));

    assert_eq!(clock.dues(), [Duration::from_secs(1)], "its time armed");
    until(|| heard.parcels().len() == 1, "its OPEN reaches the name").await;
    clock.advance(Duration::from_secs(1)).await;
    assert!(
        matches!(
            timing.await.expect("joined"),
            Err(TransportError::TimedOut(timeout)) if timeout == Duration::from_secs(1)
        ),
        "timed out"
    );

    // then given up by its signal
    let cancelling = CancellationToken::new();
    let cancelled = tokio::spawn(client.connect(BrokerConnectOptions {
        signal: Some(cancelling.clone()),
        ..BrokerConnectOptions::of("interop")
    }));

    until(|| heard.parcels().len() == 2, "its OPEN reaches the name").await;
    cancelling.cancel();
    assert!(
        matches!(
            cancelled.await.expect("joined"),
            Err(TransportError::Cancelled(_))
        ),
        "cancelled"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");

    // what it cannot take, refused before anything moves
    let longest = "x".repeat(65);

    for server in ["", "a.b", &longest] {
        assert!(
            matches!(
                client.connect(BrokerConnectOptions::of(server)).await,
                Err(TransportError::Refused(_))
            ),
            "{server} refused"
        );
    }

    assert!(client.send(data(&[1])).is_err(), "nothing to send on");
    assert!(
        client.disconnect(DisconnectOptions::default()).is_err(),
        "nothing to close"
    );
    assert_eq!(
        (client.carries("Bearer token"), client.carries(" padded")),
        (true, false),
        "a field value carried"
    );
    assert_eq!(heard.parcels().len(), 2, "two OPENs went");
    ada.stop().await;
}

#[tokio::test]
async fn reconnects_through_the_name_it_serves_a_pair_drawn_anew() {
    let pair = BrokerPair::of(BrokerPairOptions::default()).await;
    let client = pair.connect().await;
    let before = client.pair().expect("a pair");
    let told = Arc::new(ClientTold::default());

    client.listen(Arc::new(AtClient(Arc::clone(&told))));
    client
        .reconnect(ReconnectOptions::default())
        .expect("reconnecting")
        .await
        .expect("reconnected");
    until(
        || locked(&pair.told.opened).len() == 2 && locked(&pair.told.closed).len() == 1,
        "the server tells the new connection open, and the one it replaced closed",
    )
    .await;

    let after = client.pair().expect("a pair");

    // * a new connection through the same name, both its halves drawn anew
    assert_eq!(
        (client.ready_state(), *locked(&told.reconnects)),
        (ReadyState::Open, 1),
        "reconnected, told once"
    );
    assert_ne!(before.0, after.0, "its opener's half drawn anew");
    assert_ne!(before.1, after.1, "its acceptor's half drawn anew");
    assert_eq!(
        locked(&pair.told.opened)
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        [
            "type=BROKER;participant=client;ordinal=1",
            "type=BROKER;participant=client;ordinal=2"
        ],
        "each told open"
    );
    assert_eq!(
        locked(&pair.told.closed)
            .iter()
            .map(|(is_clean, handle)| (*is_clean, handle.to_string()))
            .collect::<Vec<_>>(),
        [(false, "type=BROKER;participant=client;ordinal=1".to_owned())],
        "the one replaced closed"
    );
    assert_eq!(
        pair.server
            .gauges()
            .and_then(|gauges| gauges.counts.get("connections").copied()),
        Some(1),
        "one held"
    );
    pair.stop().await;
}

#[tokio::test]
async fn hands_on_an_envelope_its_server_sent_as_it_accepted_once_its_connect_opened() {
    // what it tells, and where it stood as it told it
    type Told = Arc<Mutex<Vec<(ReadyState, Vec<u8>)>>>;

    struct Standing {
        client: crate::broker::client::BrokerClient,
        told: Told,
    }

    impl ClientListener for Standing {
        fn on_message(&self, message: TransportMessage) {
            locked(&self.told).push((self.client.ready_state(), message.data.to_vec()));
        }
    }

    let broker = broker();
    let ada = participant_of(
        &adapter_of(&broker, "ada"),
        &BrokerParticipantOptions::default(),
    );
    let (peer, heard) = peer_of(&broker, ("acceptor", &[&["bead", "s", "interop"]])).await;
    let client = ada
        .client(&BrokerClientOptions::default())
        .expect("a client");
    let told: Told = Arc::default();

    client.listen(Arc::new(Standing {
        client: client.clone(),
        told: Arc::clone(&told),
    }));

    let connecting = tokio::spawn(client.connect(BrokerConnectOptions::of("interop")));
    let opener = opener_of(&heard).await;

    // * its ACCEPT and an envelope after it, published in one turn: the envelope comes before its
    // connect returned, and is told once it opened
    let accepting = publish_to(&peer, (INBOX, accept_of(opener)));
    let sending = publish_to(
        &peer,
        (
            INBOX,
            write_parcel(&Parcel {
                opener,
                acceptor: HALF,
                sequence: 2,
                carried: Some(Bytes::from_static(&[0xA1, 0x16])),
                ..Parcel::of(kinds::DATA)
            })
            .expect("written")
            .to_vec(),
        ),
    );

    accepting.await;
    sending.await;
    connecting.await.expect("joined").expect("connected");
    until(|| !locked(&told).is_empty(), "the envelope told").await;
    assert_eq!(
        *locked(&told),
        [(ReadyState::Open, vec![0xA1, 0x16])],
        "told once open"
    );
    ada.stop().await;
}

#[tokio::test]
async fn fails_a_connect_its_server_refused_as_malformed_or_closed_as_it_opened_telling_no_close_and_tells_one_once_it_opened()
 {
    let broker = broker();
    let ada = participant_of(
        &adapter_of(&broker, "ada"),
        &BrokerParticipantOptions::default(),
    );
    let (peer, heard) = peer_of(&broker, ("acceptor", &[&["bead", "s", "interop"]])).await;
    let client = ada
        .client(&BrokerClientOptions::default())
        .expect("a client");
    let told = Arc::new(ClientTold::default());

    client.listen(Arc::new(AtClient(Arc::clone(&told))));

    // refused 400: its refusal the source, named as section 15.6 names it
    let refusing = tokio::spawn(client.connect(BrokerConnectOptions::of("interop")));
    let opener = opener_of(&heard).await;

    publish_to(
        &peer,
        (
            INBOX,
            write_parcel(&Parcel {
                opener,
                sequence: 1,
                status: Some(400),
                ..Parcel::of(kinds::REFUSE)
            })
            .expect("written")
            .to_vec(),
        ),
    )
    .await;

    let refused = refusal_of(&refusing.await.expect("joined")).expect("a refusal");

    assert_eq!(
        (refused.to_string(), refused.reason(), refused.status()),
        (
            "the server refused the connection: 400 malformed".to_owned(),
            "malformed",
            Some(400)
        ),
        "refused 400"
    );

    // * accepted, then closed in the same turn, before its connect returned: the connect fails, and
    // no close is told
    locked(&heard.messages).clear();

    let closing = tokio::spawn(client.connect(BrokerConnectOptions::of("interop")));
    let opener = opener_of(&heard).await;
    // each publish takes effect as it is made: both go before either is awaited
    let accepting = peer.publish(BrokerPublication::of(INBOX, Bytes::from(accept_of(opener))));
    let closed = peer.publish(BrokerPublication::of(
        INBOX,
        write_parcel(&Parcel {
            opener,
            acceptor: HALF,
            sequence: 2,
            code: Some(1_000),
            ..Parcel::of(kinds::CLOSE)
        })
        .expect("written"),
    ));

    accepting.await.expect("published");
    closed.await.expect("published");
    assert_eq!(
        closing
            .await
            .expect("joined")
            .expect_err("failed")
            .to_string(),
        "the server closed the connection as it opened",
        "closed as it opened"
    );
    super::settle().await;
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    assert!(locked(&told.closes).is_empty(), "no close told");

    // once it opened, its server's close is told, unclean but for 1000
    locked(&heard.messages).clear();

    let opening = tokio::spawn(client.connect(BrokerConnectOptions::of("interop")));
    let lasting = opener_of(&heard).await;

    publish_to(&peer, (INBOX, accept_of(lasting))).await;
    opening.await.expect("joined").expect("connected");
    publish_to(
        &peer,
        (
            INBOX,
            write_parcel(&Parcel {
                opener: lasting,
                acceptor: HALF,
                sequence: 2,
                code: Some(1_001),
                ..Parcel::of(kinds::CLOSE)
            })
            .expect("written")
            .to_vec(),
        ),
    )
    .await;
    until(|| !locked(&told.closes).is_empty(), "its close told").await;
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    assert_eq!(*locked(&told.closes), [(false, false)], "unclean");
    ada.stop().await;
}

#[tokio::test]
async fn refuses_to_send_a_credential_no_field_carries_or_what_is_no_envelope_keeping_its_connection_and_closes_it_by_a_reset_where_its_disconnect_is_not_clean()
 {
    let pair = BrokerPair::of(BrokerPairOptions::default()).await;
    let client = pair.connect().await;

    assert_eq!(
        client
            .send(TransportMessage {
                credential: Some(" padded".to_owned()),
                ..data(&[0xA1])
            })
            .expect_err("refused")
            .to_string(),
        "a credential holds visible ASCII, spaces and tabs alone, none first or last",
        "refused"
    );
    assert_eq!(client.ready_state(), ReadyState::Open, "kept");

    // * not clean: a RESET, its server told unclean
    client
        .disconnect(DisconnectOptions {
            is_clean: Some(false),
            ..DisconnectOptions::default()
        })
        .expect("closed");
    until(
        || locked(&pair.told.closed).len() == 1,
        "the server tells the connection closed",
    )
    .await;
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    assert_eq!(
        locked(&pair.told.closed)
            .iter()
            .map(|(is_clean, handle)| (*is_clean, handle.to_string()))
            .collect::<Vec<_>>(),
        [(false, "type=BROKER;participant=client;ordinal=1".to_owned())],
        "told unclean"
    );
    pair.stop().await;
}

#[tokio::test]
async fn fails_a_connect_under_way_once_disposed_its_link_up_or_not_yet() {
    let broker = broker();
    let ada = participant_of(
        &adapter_of(&broker, "ada"),
        &BrokerParticipantOptions::default(),
    );
    let (_peer, heard) = peer_of(&broker, ("acceptor", &[&["bead", "s", "interop"]])).await;
    let disposed = "the transport client was disposed as it connected";

    // * disposed before its link is up: no OPEN goes
    let early = ada
        .client(&BrokerClientOptions::default())
        .expect("a client");
    let linking = early.connect(BrokerConnectOptions::of("interop"));

    early.dispose();
    assert_eq!(
        linking.await.expect_err("failed").to_string(),
        disposed,
        "disposed as its link came up"
    );

    // disposed as its OPEN awaits its answer, the one OPEN that went
    let client = ada
        .client(&BrokerClientOptions::default())
        .expect("a client");
    let connecting = tokio::spawn(client.connect(BrokerConnectOptions::of("interop")));

    opener_of(&heard).await;
    assert_eq!(heard.parcels().len(), 1, "one OPEN went");
    client.dispose();
    assert_eq!(
        connecting
            .await
            .expect("joined")
            .expect_err("failed")
            .to_string(),
        disposed,
        "disposed as it awaited its answer"
    );
    ada.stop().await;
}

#[tokio::test]
async fn reports_what_a_listener_of_its_events_threw_and_tells_the_listeners_after_it() {
    struct Throwing;

    impl ClientListener for Throwing {
        fn on_message(&self, _message: TransportMessage) {
            panic!("a message listener threw");
        }
    }

    let pair = BrokerPair::of(BrokerPairOptions::default()).await;
    let client = pair.connect().await;
    let told = Arc::new(ClientTold::default());

    client.listen(Arc::new(Throwing));
    client.listen(Arc::new(AtClient(Arc::clone(&told))));

    let handle = locked(&pair.told.opened)
        .first()
        .cloned()
        .expect("a handle");

    pair.server
        .send(
            data(&[0xA1, 0x16, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01]),
            &handle,
        )
        .expect("sent");
    until(
        || locked(&told.messages).len() == 1 && locked(&told.errors).len() == 1,
        "the envelope told, and the throw reported",
    )
    .await;
    assert_eq!(
        *locked(&told.errors),
        ["a listener panicked: a message listener threw"],
        "reported"
    );
    assert_eq!(
        locked(&told.messages)
            .iter()
            .map(|message| message.data.len())
            .collect::<Vec<_>>(),
        [8],
        "told the listener after it"
    );
    assert_eq!(client.ready_state(), ReadyState::Open, "kept");
    pair.stop().await;
}

#[tokio::test]
async fn refuses_a_connect_while_one_is_under_way_or_one_given_up_already() {
    let broker = broker();
    let ada = participant_of(
        &adapter_of(&broker, "ada"),
        &BrokerParticipantOptions::default(),
    );
    let (_peer, heard) = peer_of(&broker, ("acceptor", &[&["bead", "s", "interop"]])).await;
    let client = ada
        .client(&BrokerClientOptions::default())
        .expect("a client");

    // none held: not secure
    assert_eq!(
        (client.is_secure(), client.pair()),
        (false, None),
        "none held"
    );

    // given up already: refused, nothing sent
    let given_up = CancellationToken::new();

    given_up.cancel();
    assert!(
        matches!(
            client
                .connect(BrokerConnectOptions {
                    signal: Some(given_up),
                    ..BrokerConnectOptions::of("interop")
                })
                .await,
            Err(TransportError::Cancelled(_))
        ),
        "cancelled already"
    );
    assert_eq!(
        client.ready_state(),
        ReadyState::Uninitialized,
        "nothing moved"
    );

    let connecting = tokio::spawn(client.connect(BrokerConnectOptions::of("interop")));

    // * one under way: a second is refused, and the first goes on
    assert_eq!(
        client
            .connect(BrokerConnectOptions::of("interop"))
            .await
            .expect_err("refused")
            .to_string(),
        "the transport client is already connecting",
        "refused"
    );
    opener_of(&heard).await;
    client.dispose();
    assert!(
        matches!(
            connecting.await.expect("joined"),
            Err(TransportError::Connect(_))
        ),
        "the first fails once disposed"
    );
    ada.stop().await;
}

#[tokio::test]
async fn refuses_a_reconnection_never_connected_under_way_while_it_connects_or_given_up_already_and_ends_closed_once_its_attempts_run_out()
 {
    let pair = BrokerPair::of(BrokerPairOptions::default()).await;
    let client = pair
        .client_participant
        .client(&BrokerClientOptions::default())
        .expect("a client");
    let (_silent, _heard) = peer_of(&pair.broker, ("silent", &[&["bead", "s", "quiet"]])).await;
    let refusal =
        |outcome: Result<_, TransportError>| outcome.map(drop).expect_err("refused").to_string();

    assert_eq!(
        refusal(client.reconnect(ReconnectOptions::default())),
        "the transport client was never connected",
        "never connected"
    );

    // a connect to a name nobody answers, given up once refused its reconnection
    let giving = CancellationToken::new();
    let connecting = tokio::spawn(client.connect(BrokerConnectOptions {
        signal: Some(giving.clone()),
        ..BrokerConnectOptions::of("quiet")
    }));

    tokio::task::yield_now().await;
    assert_eq!(
        refusal(client.reconnect(ReconnectOptions::default())),
        "the transport client cannot reconnect while connecting",
        "while it connects"
    );
    giving.cancel();
    assert!(
        matches!(
            connecting.await.expect("joined"),
            Err(TransportError::Cancelled(_))
        ),
        "cancelled"
    );

    // given up already: the open connection left alone
    client
        .connect(BrokerConnectOptions::of("interop"))
        .await
        .expect("connected");

    let given_up = CancellationToken::new();

    given_up.cancel();
    assert!(
        matches!(
            client.reconnect(ReconnectOptions {
                signal: Some(given_up),
                ..ReconnectOptions::default()
            }),
            Err(TransportError::Cancelled(_))
        ),
        "given up already"
    );
    assert_eq!(client.ready_state(), ReadyState::Open, "left alone");

    // * nothing serves the name any more: a reconnection under way refuses another, and ends
    // closed once its attempts run out
    pair.server.stop().await;
    until(
        || client.ready_state() == ReadyState::Closed,
        "its server's stop closes its connection",
    )
    .await;

    let reconnecting = client
        .reconnect(ReconnectOptions {
            delay: Some(ReconnectDelay::Fixed(Duration::from_millis(100))),
            maximum_attempts: Some(2),
            ..ReconnectOptions::default()
        })
        .expect("reconnecting");

    assert_eq!(
        refusal(client.reconnect(ReconnectOptions::default())),
        "the transport client is already reconnecting",
        "under way"
    );
    assert_eq!(
        reconnecting.await.expect_err("ran out").to_string(),
        "attempt 2 reached",
        "its attempts ran out"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    pair.stop().await;
}
