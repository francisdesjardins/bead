//! A broker's server transport (spec 15.18, 15.22): its handles, drawn at the third leg, its
//! refusals told, what it reports of its own, the credential it never carries, and its names held
//! from its broker's word to its broker's word.

#![expect(
    clippy::too_many_lines,
    reason = "a twin plays its sentence whole, as the other sides' twins do"
)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use super::{
    AtServer, BrokerPair, BrokerPairOptions, ServerTold, adapter_of, broker, locked,
    participant_of, peer_of, publish_to, until,
};
use crate::broker::adapter::{
    BrokerAdapter, BrokerCapabilities, BrokerDelivery, BrokerError, BrokerListener,
    BrokerPublication, BrokerPublished, BrokerStart, BrokerSubscription,
};
use crate::broker::client::{BrokerClientOptions, BrokerConnectOptions};
use crate::broker::memory::{MemoryBrokerAdapter, MemoryBrokerAdapterOptions};
use crate::broker::parcel::{Parcel, encode_parcel, kinds, write_parcel};
use crate::broker::participant::{BrokerParticipant, BrokerParticipantOptions, BrokerRefusedError};
use crate::broker::server::BrokerServerOptions;
use crate::call_session::{Carriage, uncarried_of};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::Credential;
use crate::errors::TransportError;
use crate::router::types::{BoxFuture, ConnectionHandle, RouterError, TransportMessage};
use crate::transport::{
    ClientTransport, DisconnectOptions, ReadyState, ServerListener, ServerTransport,
};

type Settled = oneshot::Sender<Result<(), BrokerError>>;

// an adapter that holds each subscription and unsubscription of a server's name until the test
// settles it, and passes every other call on
#[derive(Debug)]
struct Holding {
    inner: MemoryBrokerAdapter,
    subscribing: Mutex<VecDeque<Settled>>,
    unsubscribing: Mutex<VecDeque<Settled>>,
}

impl Holding {
    fn of(inner: MemoryBrokerAdapter) -> Self {
        Self {
            inner,
            subscribing: Mutex::default(),
            unsubscribing: Mutex::default(),
        }
    }

    fn settle(queue: &Mutex<VecDeque<Settled>>, outcome: Result<(), BrokerError>) {
        let settling = locked(queue).pop_front().expect("one held");

        settling.send(outcome).expect("settled");
    }

    fn held(
        queue: &Mutex<VecDeque<Settled>>,
        then: BoxFuture<Result<(), BrokerError>>,
    ) -> BoxFuture<Result<(), BrokerError>> {
        let (settling, settled) = oneshot::channel();

        locked(queue).push_back(settling);

        Box::pin(async move {
            settled
                .await
                .unwrap_or_else(|_dropped| Err(BrokerError::failed("let go")))?;

            then.await
        })
    }
}

impl BrokerAdapter for Holding {
    fn transport_type(&self) -> &str {
        self.inner.transport_type()
    }

    fn id(&self) -> &str {
        self.inner.id()
    }

    fn capabilities(&self) -> BrokerCapabilities {
        self.inner.capabilities()
    }

    fn delivery(&self) -> BrokerDelivery {
        self.inner.delivery()
    }

    fn is_secure(&self) -> bool {
        self.inner.is_secure()
    }

    fn receive_bound(&self, topic: &[String]) -> u64 {
        self.inner.receive_bound(topic)
    }

    fn maximum_payload_bytes(&self, topic: &[String]) -> u64 {
        self.inner.maximum_payload_bytes(topic)
    }

    fn listen(&self, listener: Arc<dyn BrokerListener>) {
        self.inner.listen(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn BrokerListener>) {
        self.inner.unlisten(listener);
    }

    fn start(&self, options: BrokerStart) -> BoxFuture<Result<(), BrokerError>> {
        self.inner.start(options)
    }

    fn subscribe(
        &self,
        topic: &[String],
        options: BrokerSubscription,
    ) -> BoxFuture<Result<(), BrokerError>> {
        if topic.get(1).is_some_and(|place| place == "s") {
            let inner = self.inner.clone();
            let topic = topic.to_vec();

            return Self::held(
                &self.subscribing,
                Box::pin(async move { inner.subscribe(&topic, options).await }),
            );
        }

        self.inner.subscribe(topic, options)
    }

    fn unsubscribe(&self, topic: &[String]) -> BoxFuture<Result<(), BrokerError>> {
        if topic.get(1).is_some_and(|place| place == "s") {
            let inner = self.inner.clone();
            let topic = topic.to_vec();

            return Self::held(
                &self.unsubscribing,
                Box::pin(async move { inner.unsubscribe(&topic).await }),
            );
        }

        self.inner.unsubscribe(topic)
    }

    fn publish(
        &self,
        publication: BrokerPublication,
    ) -> BoxFuture<Result<BrokerPublished, BrokerError>> {
        self.inner.publish(publication)
    }

    fn stop(&self) -> BoxFuture<()> {
        self.inner.stop()
    }
}

fn names_of(server: &crate::broker::server::BrokerServer) -> Option<u64> {
    server
        .gauges()
        .and_then(|gauges| gauges.counts.get("names").copied())
}

fn open_of(opener: u64) -> Vec<u8> {
    write_parcel(&Parcel {
        opener,
        sequence: 1,
        id: Some("peer".to_owned()),
        incarnation: Some(7),
        bound: Some(65_536),
        ..Parcel::of(kinds::OPEN)
    })
    .expect("written")
    .to_vec()
}

#[tokio::test]
async fn draws_a_handle_of_its_adapter_type_for_each_connection_at_its_third_leg_and_gives_none_twice()
 {
    let pair = BrokerPair::of(BrokerPairOptions::default()).await;
    let (peer, heard) = peer_of(&pair.broker, ("peer", &[])).await;
    let taken = std::sync::atomic::AtomicUsize::new(0);
    let next = || async {
        let at = taken.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        until(|| heard.parcels().len() > at, "the next parcel").await;
        heard.parcels().remove(at)
    };
    let counted = |name: &str| {
        pair.server
            .gauges()
            .and_then(|gauges| gauges.counts.get(name).copied())
    };
    let opened = || {
        locked(&pair.told.opened)
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    };

    // * accepted, half-open: nothing told, no handle drawn, until its third leg
    for opener in [1_u64, 2, 3] {
        publish_to(&peer, (["bead", "s", "interop"], open_of(opener))).await;

        let accept = next().await;

        assert_eq!(
            (accept.kind, accept.opener),
            (kinds::ACCEPT, opener),
            "its ACCEPT"
        );

        if opener == 1 {
            super::settle().await;
            assert!(opened().is_empty(), "nothing told");
            assert_eq!(
                (counted("connections"), counted("halfOpen")),
                (Some(0), Some(1)),
                "half-open"
            );
        }

        publish_to(
            &peer,
            (
                ["bead", "i", "server"],
                write_parcel(&Parcel {
                    opener,
                    acceptor: accept.acceptor,
                    sequence: 2,
                    ..Parcel::of(kinds::PING)
                })
                .expect("written")
                .to_vec(),
            ),
        )
        .await;
        next().await;

        if opener == 1 {
            assert_eq!(
                opened(),
                ["type=BROKER;participant=peer;ordinal=1"],
                "told at its third leg"
            );
        }

        // each its own, by its adapter's type, the peer's id and its rank, never given again
        if opener == 2 {
            let first: ConnectionHandle = Arc::from("type=BROKER;participant=peer;ordinal=1");

            assert!(pair.server.close(&first).await, "closed");

            let close = next().await;

            assert_eq!(
                (close.kind, close.code),
                (kinds::CLOSE, Some(1_000)),
                "its CLOSE"
            );
        }
    }

    assert_eq!(
        opened(),
        [
            "type=BROKER;participant=peer;ordinal=1",
            "type=BROKER;participant=peer;ordinal=2",
            "type=BROKER;participant=peer;ordinal=3"
        ],
        "each its own"
    );
    assert_eq!(pair.server.transport_type(), Some("BROKER"), "its type");
    assert!(
        !pair
            .server
            .is_secure(&Arc::from("type=BROKER;participant=nobody;ordinal=1")),
        "none of its"
    );
    assert!(
        !pair
            .server
            .close(&Arc::from("type=BROKER;participant=peer;ordinal=1"))
            .await,
        "none held by that handle"
    );
    assert_eq!(
        pair.server
            .clients()
            .into_iter()
            .map(|(handle, address, port, _)| (handle.to_string(), address, port))
            .collect::<Vec<_>>(),
        [
            (
                "type=BROKER;participant=peer;ordinal=2".to_owned(),
                "peer".to_owned(),
                None
            ),
            (
                "type=BROKER;participant=peer;ordinal=3".to_owned(),
                "peer".to_owned(),
                None
            )
        ],
        "its clients"
    );

    // its bounds held as it is built
    for options in [
        BrokerServerOptions::of(Vec::<String>::new()),
        BrokerServerOptions::of(["a.b"]),
        BrokerServerOptions {
            accept_timeout: Some(crate::duration::NEVER),
            ..BrokerServerOptions::of(["other"])
        },
        BrokerServerOptions {
            maximum_connections: Some(0),
            ..BrokerServerOptions::of(["other"])
        },
    ] {
        assert!(
            pair.server_participant.server(&options).is_err(),
            "{options:?} refused"
        );
    }

    let plain = BrokerParticipant::new(
        Arc::new(
            pair.broker
                .adapter(&MemoryBrokerAdapterOptions {
                    capabilities: Some(BrokerCapabilities::WILL),
                    ..MemoryBrokerAdapterOptions::of("plain")
                })
                .expect("an adapter"),
        ),
        &BrokerParticipantOptions::default(),
    )
    .expect("a participant");

    assert_eq!(
        plain
            .server(&BrokerServerOptions {
                is_in_group: Some(true),
                ..BrokerServerOptions::of(["interop"])
            })
            .expect_err("refused")
            .message(),
        "a name served in a group needs an adapter that offers groups, and the adapter of plain does not",
        "a group refused"
    );
    pair.stop().await;
}

#[tokio::test]
async fn refuses_400_malformed_an_open_whose_id_is_empty_or_no_token_and_tells_it() {
    let broker = broker();
    let participant = participant_of(
        &adapter_of(&broker, "server"),
        &BrokerParticipantOptions::default(),
    );
    let server = participant
        .server(&BrokerServerOptions::of(["interop"]))
        .expect("a server");
    let (peer, heard) = peer_of(
        &broker,
        ("peer", &[&["bead", "i", ""], &["bead", "i", "a.b"]]),
    )
    .await;
    let told = Arc::new(ServerTold::default());

    server.listen(Arc::new(AtServer(Arc::clone(&told))));
    server.start().await.expect("started");

    // * each answered at the inbox it names, as its id
    for id in ["", "a.b"] {
        publish_to(
            &peer,
            (
                ["bead", "s", "interop"],
                encode_parcel(&Parcel {
                    opener: 0x0100_0000_0000_0001,
                    sequence: 1,
                    id: Some(id.to_owned()),
                    incarnation: Some(0),
                    bound: Some(65_536),
                    ..Parcel::of(kinds::OPEN)
                })
                .expect("encoded"),
            ),
        )
        .await;
    }

    until(
        || heard.parcels().len() == 2 && locked(&told.refusals).len() == 2,
        "both refused, and told",
    )
    .await;
    assert_eq!(
        locked(&told.refusals)
            .iter()
            .map(|refusal| (
                refusal.address.clone(),
                refusal.status,
                refusal.reason.clone()
            ))
            .collect::<Vec<_>>(),
        [
            (Some(String::new()), 400, "malformed".to_owned()),
            (Some("a.b".to_owned()), 400, "malformed".to_owned())
        ],
        "told"
    );
    assert_eq!(
        heard
            .messages()
            .into_iter()
            .map(|(topic, payload)| {
                let refuse = super::parcel_of(&payload).expect("a parcel");

                (topic, refuse.kind, refuse.status)
            })
            .collect::<Vec<_>>(),
        [
            ("bead/i/".to_owned(), kinds::REFUSE, Some(400)),
            ("bead/i/a.b".to_owned(), kinds::REFUSE, Some(400))
        ],
        "refused at the inbox each names"
    );
    server.stop().await;
    participant.stop().await;
}

#[tokio::test]
async fn reports_a_half_open_connection_it_lost_of_its_own_by_its_opener_s_id_with_no_handle_telling_no_connection()
 {
    let broker = broker();
    let participant = participant_of(
        &adapter_of(&broker, "server"),
        &BrokerParticipantOptions::default(),
    );
    let server = participant
        .server(&BrokerServerOptions {
            maximum_unsent_bytes: Some(1),
            ..BrokerServerOptions::of(["interop"])
        })
        .expect("a server");
    let (peer, heard) = peer_of(&broker, ("peer", &[])).await;
    let told = Arc::new(ServerTold::default());

    server.listen(Arc::new(AtServer(Arc::clone(&told))));
    server.start().await.expect("started");

    // * its ACCEPT would pass maximumUnsentBytes: the CLOSE that loses it goes alone
    publish_to(
        &peer,
        (["bead", "s", "interop"], open_of(0x0100_0000_0000_0001)),
    )
    .await;
    until(
        || heard.parcels().len() == 1 && locked(&told.errors).len() == 1,
        "its CLOSE, reported",
    )
    .await;
    assert_eq!(
        heard
            .parcels()
            .iter()
            .map(|parcel| (parcel.kind, parcel.sequence, parcel.code))
            .collect::<Vec<_>>(),
        [(kinds::CLOSE, 1, Some(4_000))],
        "its CLOSE alone"
    );
    assert_eq!(
        *locked(&told.errors),
        [(
            "a half-open connection of peer is closed with 4000: what waits for its broker would pass maximumUnsentBytes, 1 bytes".to_owned(),
            None
        )],
        "reported with no handle"
    );
    assert!(locked(&told.opened).is_empty(), "no connection told");
    assert_eq!(
        server.gauges().map(|gauges| (
            gauges.counts.get("connections").copied(),
            gauges.counts.get("halfOpen").copied()
        )),
        Some((Some(0), Some(0))),
        "none held"
    );
    server.stop().await;
    participant.stop().await;
}

#[tokio::test]
async fn reports_what_a_listener_of_its_events_threw_with_its_connection_s_handle_or_none_for_a_refusal()
 {
    struct Throwing;

    impl ServerListener for Throwing {
        fn on_connection(&self, _connection_handle: &ConnectionHandle) {
            panic!("a connection listener threw");
        }

        fn on_refusal(&self, _refusal: &crate::transport::TransportServerRefusal) {
            panic!("a refusal listener threw");
        }
    }

    let broker = broker();
    let participant = participant_of(
        &adapter_of(&broker, "server"),
        &BrokerParticipantOptions::default(),
    );
    let server = participant
        .server(&BrokerServerOptions {
            maximum_connections: Some(1),
            ..BrokerServerOptions::of(["interop"])
        })
        .expect("a server");
    let ada = participant_of(
        &adapter_of(&broker, "ada"),
        &BrokerParticipantOptions::default(),
    );
    let first = ada
        .client(&BrokerClientOptions::default())
        .expect("a client");
    let second = ada
        .client(&BrokerClientOptions::default())
        .expect("a client");
    let told = Arc::new(ServerTold::default());

    server.listen(Arc::new(Throwing));
    server.listen(Arc::new(AtServer(Arc::clone(&told))));
    server.start().await.expect("started");
    first
        .connect(BrokerConnectOptions::of("interop"))
        .await
        .expect("connected");
    until(
        || locked(&told.errors).len() == 1,
        "the connection listener's panic reported",
    )
    .await;

    // * past maximumConnections: refused 503, its listener's panic reported with no handle
    let refused = second.connect(BrokerConnectOptions::of("interop")).await;
    let refusal = match &refused {
        Err(TransportError::Connect(error)) => std::error::Error::source(error)
            .and_then(|source| source.downcast_ref::<BrokerRefusedError>())
            .cloned(),
        Ok(()) | Err(_) => None,
    }
    .expect("a refusal");

    assert_eq!(
        (refusal.reason(), refusal.status()),
        ("busy", Some(503)),
        "refused 503"
    );
    until(
        || locked(&told.errors).len() == 2,
        "the refusal listener's panic reported",
    )
    .await;
    assert_eq!(
        *locked(&told.errors),
        [
            (
                "a listener panicked: a connection listener threw".to_owned(),
                Some(Arc::from("type=BROKER;participant=ada;ordinal=1"))
            ),
            (
                "a listener panicked: a refusal listener threw".to_owned(),
                None
            )
        ],
        "each reported"
    );
    assert_eq!(first.ready_state(), ReadyState::Open, "kept");
    server.stop().await;
    ada.stop().await;
    participant.stop().await;
}

#[tokio::test]
async fn refuses_to_send_what_is_no_envelope_keeping_the_connection_and_holds_a_connection_secure_as_its_application_says_where_it_says()
 {
    let broker = broker();
    let participant = participant_of(
        &adapter_of(&broker, "server"),
        &BrokerParticipantOptions::default(),
    );
    let server = participant
        .server(&BrokerServerOptions {
            secure: Some(false),
            ..BrokerServerOptions::of(["interop"])
        })
        .expect("a server");
    let ada = participant_of(
        &adapter_of(&broker, "ada"),
        &BrokerParticipantOptions::default(),
    );
    let client = ada
        .client(&BrokerClientOptions::default())
        .expect("a client");
    let told = Arc::new(ServerTold::default());

    server.listen(Arc::new(AtServer(Arc::clone(&told))));
    server.start().await.expect("started");
    client
        .connect(BrokerConnectOptions::of("interop"))
        .await
        .expect("connected");
    until(
        || locked(&told.opened).len() == 1,
        "the server tells the connection open",
    )
    .await;

    let handle = locked(&told.opened).first().cloned().expect("a handle");

    // what it sends is an envelope's bytes, which its type holds alone: one goes, the connection kept
    server
        .send(
            TransportMessage {
                data: bytes::Bytes::from_static(&[0xA1]),
                ..TransportMessage::default()
            },
            &handle,
        )
        .expect("sent");

    // * both its legs in memory, secure; its application says its own is not, and its ACCEPT so
    assert_eq!(
        (
            client.ready_state(),
            server.is_secure(&handle),
            client.is_secure()
        ),
        (ReadyState::Open, false, false),
        "not secure"
    );
    server.stop().await;
    ada.stop().await;
    participant.stop().await;
}

#[tokio::test]
async fn carries_no_credential_toward_its_client_and_its_command_presenting_elsewhere_fails_before_it_goes()
 {
    let pair = BrokerPair::of(BrokerPairOptions::default()).await;
    let client = pair.connect().await;
    let handle = locked(&pair.told.opened)
        .first()
        .cloned()
        .expect("a handle");

    // ! secure, both legs in memory; yet nothing is carried toward a client (spec 15.22)
    assert_eq!(
        (
            pair.server.carries_credential(&handle),
            pair.server.is_secure(&handle)
        ),
        (false, true),
        "secure, carrying none"
    );

    let takes = |_: &str| pair.server.carries_credential(&handle);
    let uncarried = uncarried_of(
        Some(&Credential::Elsewhere),
        &Carriage {
            carried: None,
            takes: &takes,
            side: RouterSide::Server,
            is_secure: pair.server.is_secure(&handle),
        },
    );

    assert_eq!(
        uncarried.and_then(|failure| failure.protocol_code()),
        Some(ProtocolCode::DESTINATION_UNREACHABLE),
        "its command fails before it goes"
    );

    // while a client carries any field value toward its server
    assert!(client.carries("Bearer token"), "a field value carried");
    assert!(!client.carries(" Bearer"), "none padded");
    pair.stop().await;
}

#[tokio::test]
async fn starts_once_its_broker_holds_each_name_it_serves_fails_its_start_on_a_name_refused_and_stops_once_it_let_each_go()
 {
    let broker = broker();
    let holding = Arc::new(Holding::of(adapter_of(&broker, "server")));
    let adapter: Arc<dyn BrokerAdapter> = Arc::<Holding>::clone(&holding);
    let participant = BrokerParticipant::new(adapter, &BrokerParticipantOptions::default())
        .expect("a participant");
    let server = participant
        .server(&BrokerServerOptions::of(["interop", "echo"]))
        .expect("a server");
    let told = Arc::new(ServerTold::default());

    server.listen(Arc::new(AtServer(Arc::clone(&told))));

    // * its start asks each name at once and waits on each one's SUBACK, the gauge counting none
    // until its broker holds it
    let starting = tokio::spawn(server.start());

    until(
        || locked(&holding.subscribing).len() == 2,
        "each name asked of its broker",
    )
    .await;
    assert!(!starting.is_finished(), "not started");
    assert_eq!(names_of(&server), Some(0), "none held");
    Holding::settle(&holding.subscribing, Ok(()));
    until(|| names_of(&server) == Some(1), "the first name held").await;
    assert!(!starting.is_finished(), "not started");
    Holding::settle(&holding.subscribing, Ok(()));
    starting.await.expect("joined").expect("started");
    assert_eq!(names_of(&server), Some(2), "both held");

    // * its stop lets each go at once and waits on each one's UNSUBACK, the gauge counting it until
    // its broker let it go
    let stopping = tokio::spawn(server.stop());

    until(
        || locked(&holding.unsubscribing).len() == 2,
        "each name let go of",
    )
    .await;
    assert!(!stopping.is_finished(), "not stopped");
    assert_eq!(names_of(&server), Some(2), "both held");
    Holding::settle(&holding.unsubscribing, Ok(()));
    until(|| names_of(&server) == Some(1), "the first name let go").await;
    assert!(!stopping.is_finished(), "not stopped");

    // * one its broker refuses to let go is reported, and its stop settles all the same
    Holding::settle(
        &holding.unsubscribing,
        Err(BrokerError::failed(
            "its broker refused to let bead/s/echo go: 0x80",
        )),
    );
    stopping.await.expect("joined");
    assert_eq!(
        (server.ready_state(), names_of(&server)),
        (ReadyState::Closed, Some(0)),
        "stopped"
    );
    assert_eq!(
        locked(&told.errors)
            .iter()
            .map(|(message, _)| message.clone())
            .collect::<Vec<_>>(),
        ["its broker refused to let bead/s/echo go: 0x80"],
        "reported"
    );

    // * a name its broker refuses fails its start as it is refused, and is counted none
    let refusing = tokio::spawn(server.start());

    until(
        || locked(&holding.subscribing).len() == 2,
        "each name asked anew",
    )
    .await;
    Holding::settle(
        &holding.subscribing,
        Err(BrokerError::failed("its broker refused bead/s/interop")),
    );
    assert_eq!(
        refusing
            .await
            .expect("joined")
            .map_err(|error: RouterError| error.to_string())
            .expect_err("refused"),
        "its broker refused bead/s/interop",
        "its start fails"
    );
    let settling = locked(&holding.subscribing).pop_front();

    if let Some(settling) = settling {
        settling
            .send(Err(BrokerError::failed("its broker refused bead/s/echo")))
            .ok();
    }
    super::settle().await;
    assert_eq!(names_of(&server), Some(0), "none held");
    assert_eq!(locked(&told.errors).len(), 1, "nothing more reported");
    participant.stop().await;
}

#[tokio::test]
async fn serves_its_name_again_in_its_group_once_a_connection_closes_as_its_broker_lets_it_go_and_reports_a_name_its_broker_refuses_to_let_go_or_to_serve_again()
 {
    let broker = broker();
    let holding = Arc::new(Holding::of(adapter_of(&broker, "server")));
    let adapter: Arc<dyn BrokerAdapter> = Arc::<Holding>::clone(&holding);
    let participant = BrokerParticipant::new(adapter, &BrokerParticipantOptions::default())
        .expect("a participant");
    let server = participant
        .server(&BrokerServerOptions {
            is_in_group: Some(true),
            maximum_connections: Some(1),
            ..BrokerServerOptions::of(["interop"])
        })
        .expect("a server");
    let clients = participant_of(
        &adapter_of(&broker, "client"),
        &BrokerParticipantOptions::default(),
    );
    let told = Arc::new(ServerTold::default());
    let reported = || {
        locked(&told.errors)
            .iter()
            .map(|(message, _)| message.clone())
            .collect::<Vec<_>>()
    };

    server.listen(Arc::new(AtServer(Arc::clone(&told))));

    let starting = tokio::spawn(server.start());

    until(
        || locked(&holding.subscribing).len() == 1,
        "its name asked of its broker",
    )
    .await;
    Holding::settle(&holding.subscribing, Ok(()));
    starting.await.expect("joined").expect("started");
    clients.start().await.expect("started");

    // * full at its first connection: its name let go of, counted until its UNSUBACK came
    let first = clients
        .client(&BrokerClientOptions::default())
        .expect("a client");

    first
        .connect(BrokerConnectOptions::of("interop"))
        .await
        .expect("connected");
    until(
        || locked(&holding.unsubscribing).len() == 1,
        "its name let go of as it is full",
    )
    .await;

    // a connection that closes meanwhile asks nothing of a name its broker still holds, and asks it
    // anew once its broker let it go
    first
        .disconnect(DisconnectOptions::default())
        .expect("closed");
    until(|| !locked(&told.closed).is_empty(), "the connection closed").await;
    super::settle().await;
    assert!(locked(&holding.subscribing).is_empty(), "nothing asked");
    Holding::settle(&holding.unsubscribing, Ok(()));
    until(
        || locked(&holding.subscribing).len() == 1,
        "its name asked anew",
    )
    .await;
    Holding::settle(&holding.subscribing, Ok(()));
    until(|| names_of(&server) == Some(1), "its name served again").await;

    // * one its broker refuses to let go is reported
    let second = clients
        .client(&BrokerClientOptions::default())
        .expect("a client");

    second
        .connect(BrokerConnectOptions::of("interop"))
        .await
        .expect("connected");
    until(
        || locked(&holding.unsubscribing).len() == 1,
        "its name let go of as it is full again",
    )
    .await;
    Holding::settle(
        &holding.unsubscribing,
        Err(BrokerError::failed(
            "its broker refused to let bead/s/interop go: 0x80",
        )),
    );
    until(|| !reported().is_empty(), "the refusal reported").await;

    // and one its broker refuses to serve again is reported, and left unheld
    second
        .disconnect(DisconnectOptions::default())
        .expect("closed");
    until(
        || locked(&holding.subscribing).len() == 1,
        "its name asked anew once it holds fewer",
    )
    .await;
    Holding::settle(
        &holding.subscribing,
        Err(BrokerError::failed(
            "its broker refused the subscription to $share/interop/bead/s/interop: 0x87",
        )),
    );
    until(|| reported().len() == 2, "the second refusal reported").await;
    assert_eq!(
        reported(),
        [
            "its broker refused to let bead/s/interop go: 0x80",
            "the name interop is not served: its broker refused its subscription, its broker refused the subscription to $share/interop/bead/s/interop: 0x87"
        ],
        "each reported"
    );
    assert_eq!(names_of(&server), Some(0), "left unheld");
    clients.stop().await;
    participant.stop().await;
}
