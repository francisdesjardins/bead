//! A participant's parcel trace, by the other sides' sentences (debugging 13).

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use bytes::Bytes;

use super::{ParcelVerdict, ParticipantDebugEvent, ParticipantDebugListener};
use crate::broker::adapter::{
    BrokerAdapter, BrokerDown, BrokerListener, BrokerMessage, BrokerPublication, BrokerSubscription,
};
use crate::broker::client::{BrokerClient, BrokerClientOptions, BrokerConnectOptions};
use crate::broker::memory::{
    MemoryBroker, MemoryBrokerAdapter, MemoryBrokerAdapterOptions, MemoryBrokerOptions,
};
use crate::broker::parcel::{
    Parcel, ParcelRead, encode_parcel, flags, kinds, read_parcel, write_parcel,
};
use crate::broker::participant::{BrokerParticipant, BrokerParticipantOptions};
use crate::broker::server::{BrokerServer, BrokerServerOptions};
use crate::clock::SharedClock;
use crate::debug::DebugDirection;
use crate::duration::NEVER;
use crate::router::types::TransportMessage;
use crate::testing::SteppingClock;
use crate::transport::{ClientTransport, ReconnectDelay, ReconnectOptions, ServerTransport};

type Events = Arc<Mutex<Vec<ParticipantDebugEvent>>>;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn hear(events: &Events) -> ParticipantDebugListener {
    let events = Arc::clone(events);

    Arc::new(move |event| locked(&events).push(event.clone()))
}

struct Accepting(Arc<Mutex<Option<Parcel>>>);

impl BrokerListener for Accepting {
    fn on_message(&self, message: &BrokerMessage) {
        if let ParcelRead::Parcel(parcel) = read_parcel(message.payload())
            && parcel.kind == kinds::ACCEPT
        {
            *locked(&self.0) = Some(parcel);
        }
    }

    fn on_down(&self, _down: BrokerDown) {}
}

struct TracePair {
    clock: Arc<SteppingClock>,
    server_clock: Arc<SteppingClock>,
    client_adapter: MemoryBrokerAdapter,
    server_adapter: MemoryBrokerAdapter,
    client_participant: BrokerParticipant,
    server_participant: BrokerParticipant,
    client: BrokerClient,
    server: BrokerServer,
    events: Events,
    server_events: Events,
    listener: ParticipantDebugListener,
    accept: Parcel,
}

impl TracePair {
    async fn of() -> Self {
        let clock = SteppingClock::new(crate::testing::instants::new_year());
        let server_clock = SteppingClock::new(crate::testing::instants::new_year());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let broker = MemoryBroker::new(&MemoryBrokerOptions {
            clock: Some(Arc::<SteppingClock>::clone(&server_clock)),
            ..MemoryBrokerOptions::default()
        })
        .expect("a broker");
        let client_adapter = broker
            .adapter(&MemoryBrokerAdapterOptions::of("client"))
            .expect("an adapter");
        let server_adapter = broker
            .adapter(&MemoryBrokerAdapterOptions::of("server"))
            .expect("an adapter");
        let client_participant = BrokerParticipant::new(
            Arc::new(client_adapter.clone()),
            &BrokerParticipantOptions {
                clock: Some(Arc::clone(&shared)),
                heartbeat: Some(NEVER),
                reconnect: Some(ReconnectOptions {
                    delay: Some(ReconnectDelay::Fixed(Duration::ZERO)),
                    ..ReconnectOptions::default()
                }),
                ..BrokerParticipantOptions::default()
            },
        )
        .expect("a participant");
        // * a separate clock: the client's reading counter measures its participant alone
        let server_participant = BrokerParticipant::new(
            Arc::new(server_adapter.clone()),
            &BrokerParticipantOptions {
                clock: Some(Arc::<SteppingClock>::clone(&server_clock)),
                heartbeat: Some(NEVER),
                ..BrokerParticipantOptions::default()
            },
        )
        .expect("a participant");
        let events = Events::default();
        let server_events = Events::default();
        let listener = hear(&events);
        let accepted = Arc::new(Mutex::new(None));

        client_adapter.listen(Arc::new(Accepting(Arc::clone(&accepted))));

        client_participant.on_debug(Arc::clone(&listener));
        server_participant.on_debug(hear(&server_events));

        let server = server_participant
            .server(&BrokerServerOptions::of(["interop"]))
            .expect("a server");
        let client = client_participant
            .client(&BrokerClientOptions::default())
            .expect("a client");

        server.start().await.expect("started");
        client
            .connect(BrokerConnectOptions::of("interop"))
            .await
            .expect("connected");
        settle(&clock, &server_clock).await;

        // * the participant holds the exact pair it drew, without a test choosing either half
        let accept = locked(&accepted)
            .clone()
            .expect("the ACCEPT reaches the client");

        Self {
            clock,
            server_clock,
            client_adapter,
            server_adapter,
            client_participant,
            server_participant,
            client,
            server,
            events,
            server_events,
            listener,
            accept,
        }
    }

    async fn send(&self, payload: Bytes) {
        self.server_adapter
            .publish(BrokerPublication::of(["bead", "i", "client"], payload))
            .await
            .expect("published");
        settle(&self.clock, &self.server_clock).await;
    }

    async fn publish(&self, payload: Bytes, place: &str) {
        self.client_adapter
            .publish(BrokerPublication::of(
                [
                    "bead",
                    place,
                    if place == "s" { "interop" } else { "client" },
                ],
                payload,
            ))
            .await
            .expect("published");
        settle(&self.clock, &self.server_clock).await;
    }

    async fn stop(&self) {
        self.client_participant.stop().await;
        self.server_participant.stop().await;
    }
}

async fn settle(clock: &SteppingClock, server_clock: &SteppingClock) {
    // * the server's owner has its own clock: settle across both owners and the broker
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    clock.settle().await;
    server_clock.settle().await;
    clock.settle().await;
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

fn written(parcel: &Parcel) -> Bytes {
    write_parcel(parcel).expect("written")
}

fn encoded(parcel: &Parcel) -> Bytes {
    encode_parcel(parcel).expect("encoded").into()
}

fn incoming(events: &Events) -> Vec<ParticipantDebugEvent> {
    locked(events)
        .iter()
        .filter(|event| event.direction == Some(DebugDirection::Rx))
        .cloned()
        .collect()
}

fn verdicts(events: &Events) -> Vec<Option<ParcelVerdict>> {
    incoming(events).iter().map(|event| event.verdict).collect()
}

#[expect(
    clippy::too_many_lines,
    reason = "the twin plays every incoming verdict in one connection's history"
)]
// debugging 13.2, 13.4
#[tokio::test]
async fn traces_each_incoming_verdict_once_after_judgment_and_names_a_loss_by_its_awaited_and_received_sequences()
 {
    let pair = TracePair::of().await;

    locked(&pair.events).clear();

    let parcel = Parcel {
        kind: kinds::PONG,
        answers: Some(2),
        sequence: 3,
        flags: Some(0),
        ..pair.accept.clone()
    };

    pair.send(written(&parcel)).await;
    pair.send(written(&parcel)).await;
    pair.send(encoded(&Parcel {
        kind: 0x80,
        flags: Some(0xff),
        sequence: 4,
        ..parcel.clone()
    }))
    .await;
    pair.send(written(&Parcel {
        sequence: 6,
        ..parcel.clone()
    }))
    .await;
    assert_eq!(
        verdicts(&pair.events),
        [
            Some(ParcelVerdict::Taken),
            Some(ParcelVerdict::Copy),
            Some(ParcelVerdict::Advisory),
            Some(ParcelVerdict::Loss)
        ],
        "each judgment once"
    );
    let received = incoming(&pair.events);
    let advisory = received
        .iter()
        .find(|event| event.verdict == Some(ParcelVerdict::Advisory))
        .expect("an advisory");
    let loss = received
        .iter()
        .find(|event| event.verdict == Some(ParcelVerdict::Loss))
        .expect("a loss");

    assert_eq!(advisory.flags, Some(0xff), "the raw flags");
    assert_eq!(
        (
            loss.awaited,
            loss.came,
            loss.connection,
            loss.connection_handle.as_deref()
        ),
        (Some(5), Some(6), Some(1), Some("server")),
        "the lost sequence and connection"
    );
    assert!(
        locked(&pair.events).iter().any(|event| event
            .report
            .as_ref()
            .is_some_and(|report| report.contains("a parcel lost: 5 was awaited, and 6 came"))),
        "the loss reported"
    );
    let report = locked(&pair.events)
        .iter()
        .find(|event| event.event == "report")
        .expect("the loss report")
        .clone();

    assert_eq!(
        (report.connection, report.connection_handle.as_deref()),
        (Some(1), Some("server")),
        "the report names its connection"
    );
    pair.send(written(&Parcel {
        sequence: 6,
        ..parcel.clone()
    }))
    .await;
    pair.send(Bytes::from_static(&[0])).await;
    pair.send(encoded(&Parcel {
        kind: 0x0a,
        sequence: 7,
        ..parcel.clone()
    }))
    .await;
    pair.server_adapter
        .publish_retained(BrokerPublication::of(
            ["bead", "i", "client"],
            written(&parcel),
        ))
        .await
        .expect("published");
    pair.client_adapter
        .subscribe(
            &["other".to_owned(), "i".to_owned(), "client".to_owned()],
            BrokerSubscription::default(),
        )
        .await
        .expect("subscribed");
    pair.server_adapter
        .publish(BrokerPublication::of(
            ["other", "i", "client"],
            written(&parcel),
        ))
        .await
        .expect("published");
    settle(&pair.clock, &pair.server_clock).await;
    assert_eq!(
        verdicts(&pair.events),
        [
            ParcelVerdict::Taken,
            ParcelVerdict::Copy,
            ParcelVerdict::Advisory,
            ParcelVerdict::Loss,
            ParcelVerdict::PairNotHeld,
            ParcelVerdict::NoParcel,
            ParcelVerdict::DoesNotRead,
            ParcelVerdict::Retained,
            ParcelVerdict::OffTopic
        ]
        .map(Some),
        "all incoming verdicts"
    );
    for event in incoming(&pair.events).iter().filter(|event| {
        matches!(
            event.verdict,
            Some(ParcelVerdict::Retained | ParcelVerdict::OffTopic | ParcelVerdict::NoParcel)
        )
    }) {
        assert_eq!(
            (event.layout, event.opener.as_ref()),
            (None, None),
            "unread messages have no prefix"
        );
    }
    pair.stop().await;
}

// debugging 13.3, 13.7
#[tokio::test]
async fn traces_parcel_attempts_and_third_leg_handles_without_carried_bytes_credentials_or_an_acceptor_s_half()
 {
    let pair = TracePair::of().await;

    pair.client
        .send(TransportMessage {
            credential: Some("trace-secret".to_owned()),
            data: Bytes::from_static(&[0xde, 0xad, 0xbe, 0xef]),
            ..TransportMessage::default()
        })
        .expect("sent");
    settle(&pair.clock, &pair.server_clock).await;
    let events = locked(&pair.events).clone();
    let server_events = locked(&pair.server_events).clone();
    let tx = events
        .iter()
        .find(|event| {
            event.direction == Some(DebugDirection::Tx) && event.kind.as_deref() == Some("DATA")
        })
        .expect("a DATA attempt");
    let rx = server_events
        .iter()
        .find(|event| {
            event.direction == Some(DebugDirection::Rx) && event.kind.as_deref() == Some("DATA")
        })
        .expect("a DATA taken");
    let handle = Arc::clone(&pair.server.clients().first().expect("a client").0);

    assert_eq!(
        (
            tx.carried_bytes,
            tx.connection,
            tx.connection_handle.as_deref(),
            tx.has_credential,
            tx.more
        ),
        (Some(4), Some(1), Some("server"), Some(true), Some(false)),
        "the attempted DATA"
    );
    assert_eq!(
        (
            rx.carried_bytes,
            rx.connection,
            rx.connection_handle.as_deref(),
            rx.has_credential,
            rx.verdict
        ),
        (
            Some(4),
            Some(1),
            Some(handle.as_ref()),
            Some(true),
            Some(ParcelVerdict::Taken)
        ),
        "the taken DATA"
    );
    assert_eq!(
        server_events
            .iter()
            .find(|event| event.kind.as_deref() == Some("ACCEPT")
                && event.direction == Some(DebugDirection::Tx))
            .expect("an ACCEPT")
            .connection_handle,
        None,
        "no handle before the third leg"
    );
    assert_eq!(
        server_events
            .iter()
            .find(|event| event.kind.as_deref() == Some("PING")
                && event.direction == Some(DebugDirection::Rx))
            .expect("the third leg")
            .connection_handle
            .as_deref(),
        Some(handle.as_ref()),
        "the third leg's handle"
    );
    let printed = format!("{events:?}{server_events:?}");

    for secret in [
        format!("{:016x}", pair.accept.acceptor),
        "trace-secret".to_owned(),
        "deadbeef".to_owned(),
        "acceptor".to_owned(),
    ] {
        assert!(!printed.contains(&secret), "the trace contains no {secret}");
    }
    let fields = ParticipantDebugEvent::parcel(&Parcel {
        kind: kinds::DATA,
        flags: Some(flags::CREDENTIAL | flags::MORE),
        carried: Some(Bytes::from_static(&[0; 4])),
        credential: Some("trace-secret".to_owned()),
        ..pair.accept.clone()
    });

    assert_eq!(
        (fields.carried_bytes, fields.has_credential, fields.more),
        (Some(4), Some(true), Some(true)),
        "the allowlist's DATA fields"
    );
    pair.stop().await;
}

// debugging 13.1, 13.5, 13.8
#[tokio::test]
async fn tells_completed_link_transitions_and_held_names_by_push_and_keeps_levels_available_by_pull()
 {
    let pair = TracePair::of().await;

    assert_eq!(
        pair.server_participant.names(),
        std::iter::once("interop".to_owned()).collect(),
        "the broker holds its name"
    );
    assert!(
        locked(&pair.server_events)
            .iter()
            .any(|event| event.event == "names"
                && event.name.as_deref() == Some("interop")
                && event.is_held == Some(true)
                && event.group.is_none()),
        "the held name pushed"
    );
    let before = pair.client_participant.incarnation();

    pair.client_adapter.lose();
    for _ in 0..100 {
        settle(&pair.clock, &pair.server_clock).await;
        if locked(&pair.events)
            .iter()
            .filter(|event| event.state == Some("up"))
            .count()
            == 2
        {
            break;
        }
    }
    let links: Vec<_> = locked(&pair.events)
        .iter()
        .filter(|event| event.event == "link")
        .cloned()
        .collect();

    assert_eq!(
        links.iter().map(|event| event.state).collect::<Vec<_>>(),
        [Some("up"), Some("down"), Some("up")],
        "completed transitions"
    );
    assert_eq!(
        links.get(1).expect("down").ended,
        Some(vec![1]),
        "the ended connection"
    );
    assert_ne!(
        pair.client_participant.incarnation(),
        before,
        "a new incarnation"
    );
    assert_eq!(
        pair.client_participant.gauges().counts.get("connections"),
        Some(&0),
        "levels by pull"
    );
    pair.client
        .connect(BrokerConnectOptions::of("interop"))
        .await
        .expect("connected");
    settle(&pair.clock, &pair.server_clock).await;
    assert_eq!(
        locked(&pair.events)
            .iter()
            .rev()
            .find(|event| event.kind.as_deref() == Some("PING")
                && event.direction == Some(DebugDirection::Tx))
            .expect("a PING")
            .connection,
        Some(2),
        "ordinals never repeat"
    );
    pair.client_participant.stop().await;
    pair.server.stop().await;
    assert!(
        pair.server_participant.names().is_empty(),
        "the name let go"
    );
    assert_eq!(
        locked(&pair.server_events)
            .iter()
            .rev()
            .find(|event| event.event == "names")
            .expect("a name")
            .is_held,
        Some(false),
        "the name's release pushed"
    );
    let stopped = locked(&pair.events)
        .iter()
        .rev()
        .find(|event| event.event == "link")
        .expect("a link")
        .clone();

    assert_eq!(
        (stopped.state, stopped.ended),
        (Some("stopped"), Some(vec![2])),
        "stop completed"
    );
    pair.stop().await;
}

#[tokio::test]
async fn tells_a_takeover_once_after_clearing_names_and_connections_and_tells_no_later_link_transition()
 {
    let pair = TracePair::of().await;
    let completed = Arc::new(Mutex::new(false));
    let heard = Arc::clone(&completed);
    let participant = pair.server_participant.clone();

    pair.server_participant.on_debug(Arc::new(move |event| {
        if event.state == Some("taken-over") {
            *locked(&heard) = participant.names().is_empty()
                && participant.gauges().counts.get("connections") == Some(&0);
        }
    }));
    pair.server_adapter.take_over();
    settle(&pair.clock, &pair.server_clock).await;
    pair.server_participant.stop().await;
    assert!(*locked(&completed), "the takeover follows clearing");
    assert_eq!(
        locked(&pair.server_events)
            .iter()
            .filter(|event| event.event == "link")
            .map(|event| event.state)
            .collect::<Vec<_>>(),
        [Some("up"), Some("taken-over")],
        "takeover told once and no later transition"
    );
    pair.stop().await;
}

// debugging 13.6, 13.9
#[tokio::test]
async fn reports_a_debug_listener_s_throw_and_calls_later_listeners_while_the_participant_carries_on()
 {
    let broker = MemoryBroker::new(&MemoryBrokerOptions::default()).expect("a broker");
    let adapter = broker
        .adapter(&MemoryBrokerAdapterOptions::of("client"))
        .expect("an adapter");
    let participant =
        BrokerParticipant::new(Arc::new(adapter), &BrokerParticipantOptions::default())
            .expect("a participant");
    let errors = Arc::new(Mutex::new(Vec::new()));
    let heard = Arc::clone(&errors);
    let events = Events::default();
    let throwing: ParticipantDebugListener = Arc::new(|_| panic!("debug listener"));

    participant.on_error(Arc::new(move |error| {
        locked(&heard).push(error.to_string());
    }));
    assert!(!participant.is_debugging(), "unwatched");
    participant.on_debug(Arc::clone(&throwing));
    participant.on_debug(hear(&events));
    assert!(participant.is_debugging(), "watched");
    participant.start().await.expect("started");
    assert!(participant.is_linked(), "the participant carries on");
    assert_eq!(
        locked(&events)
            .iter()
            .map(|event| event.event)
            .collect::<Vec<_>>(),
        ["link"],
        "later listeners hear it and no recursive report"
    );
    assert_eq!(
        *locked(&errors),
        ["a listener panicked: debug listener"],
        "the panic reported in the Rust idiom"
    );
    participant.off_debug(&throwing);
    participant.stop().await;
    assert_eq!(
        locked(&events)
            .iter()
            .map(|event| event.state)
            .collect::<Vec<_>>(),
        [Some("up"), Some("stopped")],
        "the participant stops"
    );
}

// debugging 13.10
#[tokio::test]
async fn reads_no_clock_and_builds_no_trace_while_nobody_watches_a_parcel_taken_or_sent() {
    let pair = TracePair::of().await;

    pair.client_participant.off_debug(&pair.listener);
    assert!(!pair.client_participant.is_debugging(), "unwatched");
    let before = pair.clock.readings();
    let held = locked(&pair.events).len();

    pair.send(written(&Parcel {
        kind: kinds::PONG,
        answers: Some(2),
        sequence: 3,
        flags: Some(0),
        ..pair.accept.clone()
    }))
    .await;
    pair.client
        .send(TransportMessage {
            data: Bytes::from_static(&[1]),
            ..TransportMessage::default()
        })
        .expect("sent");
    settle(&pair.clock, &pair.server_clock).await;
    assert_eq!(locked(&pair.events).len(), held, "no trace built");
    assert_eq!(pair.clock.readings(), before, "no clock read");
    // * a closure that panics proves that the construction gate itself stays closed
    pair.client_participant
        .config()
        .debug(|| panic!("an unwatched trace is never built"));
    pair.client_participant.on_debug(Arc::clone(&pair.listener));
    pair.send(written(&Parcel {
        kind: kinds::PONG,
        answers: Some(2),
        sequence: 4,
        flags: Some(0),
        ..pair.accept.clone()
    }))
    .await;
    pair.client
        .send(TransportMessage {
            data: Bytes::from_static(&[2]),
            ..TransportMessage::default()
        })
        .expect("sent");
    settle(&pair.clock, &pair.server_clock).await;
    assert_eq!(
        locked(&pair.events)
            .iter()
            .skip(held)
            .map(|event| event.direction)
            .collect::<Vec<_>>(),
        [Some(DebugDirection::Rx), Some(DebugDirection::Tx)],
        "watched again"
    );
    pair.stop().await;
}

#[tokio::test]
async fn traces_malformed_held_parcels_copies_and_gaps_of_a_kind_to_come_and_a_layout_to_come_before_their_connection_ends()
 {
    for scenario in ["malformed", "next-kind", "gap-kind", "next-layout"] {
        let pair = TracePair::of().await;

        locked(&pair.events).clear();
        let parcel = Parcel {
            kind: kinds::PING,
            flags: Some(0),
            sequence: 3,
            ..pair.accept.clone()
        };

        if scenario == "next-kind" {
            pair.send(encoded(&Parcel {
                kind: 0x0a,
                sequence: 1,
                ..parcel.clone()
            }))
            .await;
        }
        let mut payload = encode_parcel(&Parcel {
            kind: if matches!(scenario, "next-kind" | "gap-kind") {
                0x0a
            } else {
                kinds::PING
            },
            sequence: if scenario == "gap-kind" { 5 } else { 3 },
            layout: if scenario == "next-layout" {
                0xb2
            } else {
                0xb1
            },
            flags: Some(if scenario == "next-layout" { 0xff } else { 0 }),
            ..parcel
        })
        .expect("encoded");

        if scenario == "malformed" {
            *payload.get_mut(3).expect("the kept byte") = 1;
        }
        pair.send(payload.into()).await;
        let expected = match scenario {
            "next-kind" => vec![Some(ParcelVerdict::Copy), Some(ParcelVerdict::DoesNotRead)],
            "gap-kind" => vec![Some(ParcelVerdict::Loss)],
            "next-layout" => vec![Some(ParcelVerdict::Taken)],
            _ => vec![Some(ParcelVerdict::DoesNotRead)],
        };

        assert_eq!(verdicts(&pair.events), expected, "{scenario}'s verdicts");
        let rx = incoming(&pair.events).pop().expect("an incoming parcel");

        assert_eq!(
            (rx.flags, rx.connection),
            (
                Some(if scenario == "next-layout" { 0xff } else { 0 }),
                Some(1)
            ),
            "raw flags and held connection"
        );
        assert_eq!(
            locked(&pair.events)
                .iter()
                .find(|event| event.direction == Some(DebugDirection::Tx)
                    && event.kind.as_deref() == Some("CLOSE"))
                .expect("a CLOSE")
                .code,
            Some(if scenario == "gap-kind" { 4000 } else { 1002 }),
            "the connection's close"
        );
        assert_eq!(
            locked(&pair.events)
                .iter()
                .filter(|event| event.event == "report")
                .count(),
            1,
            "one report"
        );
        assert!(!pair.client.is_open(), "its connection ends");
        pair.stop().await;
    }
}

#[tokio::test]
async fn traces_held_names_and_departures_by_their_verdict_without_inventing_a_connection() {
    let pair = TracePair::of().await;

    locked(&pair.server_events).clear();
    pair.publish(Bytes::from_static(&[0]), "s").await;
    let open = Parcel {
        opener: pair.accept.opener,
        sequence: 1,
        flags: Some(0),
        id: Some("client".to_owned()),
        incarnation: Some(pair.client_participant.incarnation()),
        bound: Some(1024),
        ..Parcel::of(kinds::OPEN)
    };
    let mut malformed = encode_parcel(&open).expect("encoded");

    *malformed.get_mut(3).expect("the kept byte") = 1;
    pair.publish(malformed.into(), "s").await;
    pair.publish(
        encoded(&Parcel {
            kind: 0x80,
            flags: Some(0xff),
            ..open.clone()
        }),
        "s",
    )
    .await;
    pair.publish(
        encoded(&Parcel {
            layout: 0xb2,
            flags: Some(0xff),
            ..open
        }),
        "s",
    )
    .await;
    pair.publish(Bytes::from_static(&[0]), "d").await;
    pair.publish(
        written(&Parcel {
            id: Some("client".to_owned()),
            incarnation: Some(u128::from_be_bytes([1; 16])),
            ..Parcel::of(kinds::GONE)
        }),
        "d",
    )
    .await;
    let rx = incoming(&pair.server_events);

    assert_eq!(
        verdicts(&pair.server_events),
        [
            ParcelVerdict::NoParcel,
            ParcelVerdict::DoesNotRead,
            ParcelVerdict::Advisory,
            ParcelVerdict::Taken,
            ParcelVerdict::NoParcel,
            ParcelVerdict::Taken
        ]
        .map(Some),
        "names and departures judged"
    );
    assert_eq!(
        (
            rx.get(2).expect("an advisory").flags,
            rx.get(3).expect("a layout to come").flags
        ),
        (Some(0xff), Some(0xff)),
        "raw flags"
    );
    assert!(
        rx.iter().all(|event| event.connection.is_none()),
        "no connection invented"
    );
    assert_eq!(
        locked(&pair.server_events)
            .iter()
            .filter(|event| event.event == "report")
            .count(),
        2,
        "the malformed name messages reported"
    );
    assert_eq!(
        locked(&pair.server_events)
            .iter()
            .find(|event| event.kind.as_deref() == Some("REFUSE"))
            .expect("a REFUSE")
            .status,
        Some(426),
        "the layout refused"
    );
    assert_eq!(
        pair.server
            .gauges()
            .expect("gauges")
            .counts
            .get("connections"),
        Some(&1),
        "the held connection stands"
    );
    pair.stop().await;
}

fn check_verdict_names() {
    for (verdict, name) in [
        (ParcelVerdict::Taken, "taken"),
        (ParcelVerdict::Copy, "copy"),
        (ParcelVerdict::Loss, "loss"),
        (ParcelVerdict::Advisory, "advisory"),
        (ParcelVerdict::PairNotHeld, "pair-not-held"),
        (ParcelVerdict::DoesNotRead, "does-not-read"),
        (ParcelVerdict::NoParcel, "no-parcel"),
        (ParcelVerdict::OffTopic, "off-topic"),
        (ParcelVerdict::Retained, "retained"),
    ] {
        assert_eq!(verdict.as_str(), name, "the companion's verdict names");
    }
}

#[test]
fn keeps_only_each_parcel_kind_s_body_fields_and_the_prefix_when_no_body_reads() {
    check_verdict_names();

    let sample = Parcel {
        flags: Some(7),
        opener: 0x0102_0304_0506_0708,
        acceptor: 0x0807_0605_0403_0201,
        sequence: 3,
        id: Some("ada".to_owned()),
        incarnation: Some(u128::from_be_bytes([1; 16])),
        bound: Some(1024),
        status: Some(503),
        carried: Some(Bytes::from_static(&[1, 2])),
        credential: Some("trace-secret".to_owned()),
        answers: Some(2),
        code: Some(1000),
        ..Parcel::of(kinds::OPEN)
    };

    for kind in [1, 2, 3, 4, 5, 6, 7, 8, 9, 0x0a, 0x80] {
        let event = ParticipantDebugEvent::parcel(&Parcel {
            kind,
            ..sample.clone()
        });
        let mut expected = ParticipantDebugEvent {
            event: "parcel",
            layout: Some(0xb1),
            flags: Some(7),
            opener: Some("0102030405060708".to_owned()),
            sequence: Some(3),
            kind: Some(
                match kind {
                    1 => "OPEN",
                    2 => "ACCEPT",
                    3 => "REFUSE",
                    4 => "DATA",
                    5 => "PING",
                    6 => "PONG",
                    7 => "CLOSE",
                    8 => "RESET",
                    9 => "GONE",
                    0x80 => "advisory 128",
                    _ => "0x0A",
                }
                .to_owned(),
            ),
            ..ParticipantDebugEvent::default()
        };

        match kind {
            1 | 2 => {
                expected.id = Some("ada".to_owned());
                expected.incarnation = Some("01".repeat(16));
                expected.bound = Some(1024);
                expected.secure = Some(true);
            }
            3 => expected.status = Some(503),
            4 => {
                expected.carried_bytes = Some(2);
                expected.more = Some(true);
                expected.has_credential = Some(true);
            }
            6 => expected.answers = Some(2),
            7 => expected.code = Some(1000),
            9 => {
                expected.id = Some("ada".to_owned());
                expected.incarnation = Some("01".repeat(16));
            }
            _ => {}
        }
        assert_eq!(event, expected, "the allowlist for {kind}");
    }
    for kind in [kinds::OPEN, kinds::DATA] {
        let prefix = Parcel {
            opener: sample.opener,
            sequence: sample.sequence,
            acceptor: sample.acceptor,
            ..Parcel::of(kind)
        };
        let event = ParticipantDebugEvent::parcel(&prefix);

        assert_eq!(
            (
                event.id,
                event.incarnation,
                event.secure,
                event.carried_bytes,
                event.has_credential,
                event.more
            ),
            (None, None, None, None, None, None),
            "a prefix has no body fields"
        );
    }
}
