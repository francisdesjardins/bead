//! The MQTT 5 adapter against the Mosquitto `BEAD_MQTT_URL` and `BEAD_MQTT_WS_URL` name (`node
//! tools/mqtt-broker.mjs start`), linked as the broker's users with the run's password: skipped,
//! saying so, where none is given, and failed where `BEAD_MQTT_REQUIRED=1` asks for one. One at a
//! time, and beside nothing else of the broker's: a second link of an id takes over, and its groups
//! link the cases' own users.

use core::time::Duration;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use bytes::Bytes;
use tokio::sync::Mutex as AsyncMutex;

use super::{PATIENCE, topic, until};
use crate::broker::adapter::{
    BrokerAdapter, BrokerListener, BrokerMessage, BrokerPublication, BrokerPublished, BrokerStart,
    BrokerSubscription,
};
use crate::broker::client::{BrokerTransportClientConnectOptions, BrokerTransportClientOptions};
use crate::broker::participant::{BrokerParticipant, BrokerParticipantOptions, BrokerRefusedError};
use crate::broker::server::BrokerTransportServerOptions;
use crate::errors::TransportError;
use crate::mqtt::adapter::{MqttBrokerAdapter, MqttBrokerAdapterOptions};
use crate::mqtt::link::address_of;
use crate::testing::frame_relay::{FrameRelay, unwhole_of};
use crate::testing::link_relay::{LinkRelay, LinkRelayOptions};
use crate::testing::parcels::{self, ParcelFields, ParcelReading};
use crate::testing::{rest, spawn, wall_now};
use crate::transport::TransportClientDisconnectOptions;

const NO_BROKER: &str =
    "skipped: no broker, BEAD_MQTT_URL is not set (node tools/mqtt-broker.mjs start)";

// the user the WebSocket legs link as, which no case and no interop leg is
const FIXTURE_USER: &str = "fixture";

// ! users of the broker's that read every name, each linked by one test alone: a link of an id a
// case links meanwhile would take it over
const GROUP_USERS: [&str; 3] = ["quiet", "late", "flagged"];

// ! one test of the broker's at a time, as the other sides run them on one worker
static SERIAL: AsyncMutex<()> = AsyncMutex::const_new(());

/// The URL `variable` names, and the run's password; none, saying so, where none is given and none
/// is asked for.
fn broker_of(variable: &str) -> Option<(String, String)> {
    let password = std::env::var("BEAD_MQTT_PASSWORD").unwrap_or_default();

    if let Ok(url) = std::env::var(variable) {
        return Some((url, password));
    }

    assert!(
        std::env::var("BEAD_MQTT_REQUIRED").as_deref() != Ok("1"),
        "{NO_BROKER}"
    );
    println!("{NO_BROKER}");

    None
}

fn linked_as((url, password): (&str, &str), id: &str) -> MqttBrokerAdapter {
    let mut options = MqttBrokerAdapterOptions::new(url, id);

    options.password = Some(password.to_owned());

    MqttBrokerAdapter::new(&options).unwrap()
}

fn now_millis() -> u128 {
    wall_now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

// what settles each message as it is taken, as the core does, noting its first byte
struct Settling(Mutex<Vec<u8>>);

impl BrokerListener for Settling {
    fn on_message(&self, message: &BrokerMessage) {
        self.0
            .lock()
            .unwrap()
            .push(message.payload().first().copied().unwrap_or_default());
        message.settle();
    }
}

fn settling(adapter: &MqttBrokerAdapter) -> Arc<Settling> {
    let heard = Arc::new(Settling(Mutex::new(Vec::new())));

    adapter.listen(Arc::<Settling>::clone(&heard));

    heard
}

// spec 15.21, 15.26
#[tokio::test(flavor = "multi_thread")]
async fn lets_one_member_of_a_group_go_at_its_stop_a_name_the_others_serve_still_taken_and_finds_no_subscriber_for_its_inbox_once_it_stopped_nor_for_the_name_once_the_last_did()
 {
    let _serial = SERIAL.lock().await;
    let Some((url, password)) = broker_of("BEAD_MQTT_URL") else {
        return;
    };
    let [leaving, staying, caller] = GROUP_USERS.map(|id| linked_as((&url, &password), id));
    let name = topic(&["bead", "s", &format!("stopping-{}", now_millis())]);
    let grouped = || BrokerSubscription {
        group: Some("stopping".to_owned()),
        signal: None,
    };

    settling(&leaving);

    let heard = settling(&staying);
    let played = async {
        staying.start(BrokerStart::default()).await.unwrap();
        caller.start(BrokerStart::default()).await.unwrap();
        staying.subscribe(&name, grouped()).await.unwrap();

        // * at once after each stop, as the race the stop closes was
        for round in 0..5_u8 {
            leaving.start(BrokerStart::default()).await.unwrap();
            leaving
                .subscribe(
                    &topic(&["bead", "i", "quiet"]),
                    BrokerSubscription::default(),
                )
                .await
                .unwrap();
            leaving.subscribe(&name, grouped()).await.unwrap();
            leaving.stop().await;
            assert_eq!(
                caller
                    .publish(BrokerPublication::new(
                        topic(&["bead", "i", "quiet"]),
                        Bytes::from_static(&[1])
                    ))
                    .await
                    .unwrap(),
                BrokerPublished::NoSubscriber,
                "its inbox, round {round}"
            );
            assert_eq!(
                caller
                    .publish(BrokerPublication::new(
                        name.clone(),
                        Bytes::copy_from_slice(&[round])
                    ))
                    .await
                    .unwrap(),
                BrokerPublished::Taken,
                "the name, round {round}"
            );
        }

        // * each taken by the member that stays
        until(|| heard.0.lock().unwrap().len() == 5).await;
        assert_eq!(*heard.0.lock().unwrap(), vec![0, 1, 2, 3, 4], "each taken");
        staying.stop().await;
        assert_eq!(
            caller
                .publish(BrokerPublication::new(
                    name.clone(),
                    Bytes::from_static(&[1])
                ))
                .await
                .unwrap(),
            BrokerPublished::NoSubscriber,
            "none once the last stopped"
        );
    };

    played.await;

    for adapter in [&leaving, &staying, &caller] {
        adapter.stop().await;
    }
}

// what a connect settled to: opened by a member, refused 503 by the stopping one, or lost
fn outcome_of(outcome: &Result<(), TransportError>) -> String {
    match outcome {
        Ok(()) => "opened".to_owned(),
        Err(TransportError::Connect(error))
            if std::error::Error::source(error)
                .and_then(|source| source.downcast_ref::<BrokerRefusedError>())
                .is_some_and(|refused| refused.status() == Some(503)) =>
        {
            "refused 503".to_owned()
        }
        Err(other) => format!("lost: {other}"),
    }
}

// spec 15.21
#[tokio::test(flavor = "multi_thread")]
async fn a_group_members_stop_answers_each_open_that_comes_during_it_by_another_member_or_refuses_it_503_none_lost()
 {
    let _serial = SERIAL.lock().await;
    let Some((url, password)) = broker_of("BEAD_MQTT_URL") else {
        return;
    };
    let broker = address_of(&url).unwrap();
    // * the stopping member a round trip of 300 ms away, as the window its stop closes was
    let relayed = LinkRelayOptions {
        delay: Some(Duration::from_millis(150)),
    };

    let relay = LinkRelay::to((&broker.bare, broker.port), &relayed)
        .await
        .unwrap();
    let relay_url = format!("mqtt://127.0.0.1:{}", relay.port());
    let participants: Vec<BrokerParticipant> = GROUP_USERS
        .iter()
        .enumerate()
        .map(|(index, id)| {
            let at = if index == 0 {
                relay_url.as_str()
            } else {
                url.as_str()
            };

            BrokerParticipant::new(
                Arc::new(linked_as((at, &password), id)),
                &BrokerParticipantOptions::default(),
            )
            .unwrap()
        })
        .collect();
    let [stopping, twin, calling] = [0, 1, 2].map(|index| participants[index].clone());
    let served = format!("stopping-{}", now_millis());
    let outcomes = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut serving = BrokerTransportServerOptions::new([served.clone()]);

    serving.is_in_group = Some(true);

    let stopping_server = stopping.server(&serving).unwrap();
    let twin_server = twin.server(&serving).unwrap();

    stopping_server.start().await.unwrap();
    twin_server.start().await.unwrap();
    calling.start().await.unwrap();

    let connect_once = || {
        let calling = calling.clone();
        let served = served.clone();
        let outcomes = Arc::clone(&outcomes);

        spawn(async move {
            let client = calling
                .client(&BrokerTransportClientOptions::default())
                .unwrap();
            let mut options = BrokerTransportClientConnectOptions::new(served);

            options.timeout = Some(Duration::from_secs(3));

            let outcome = client.connect(&options).await;

            outcomes.lock().unwrap().push(outcome_of(&outcome));

            if outcome.is_ok() {
                client
                    .disconnect(&TransportClientDisconnectOptions::default())
                    .ok();
            }

            client.dispose();
        })
    };

    for _ in 0..2 {
        let mut connects = Vec::new();
        let stopped = spawn(stopping.stop());

        // * a connect at once, then every 20 ms through its stop and a round trip past it
        while !stopped.is_finished() {
            connects.push(connect_once());
            rest(Duration::from_millis(20)).await;
        }

        for _ in 0..15 {
            connects.push(connect_once());
            rest(Duration::from_millis(20)).await;
        }

        stopped.await.unwrap();

        for connect in connects {
            connect.await.unwrap();
        }

        stopping.start().await.unwrap();
    }

    for participant in [&calling, &twin, &stopping] {
        participant.dispose().await;
    }

    relay.dispose();

    // * each answered: by another member, or refused 503 by the stopping one, none waiting out its
    // connect
    let outcomes = outcomes.lock().unwrap().clone();
    let lost: Vec<&String> = outcomes
        .iter()
        .filter(|outcome| outcome.starts_with("lost"))
        .collect();

    assert!(lost.is_empty(), "none lost: {lost:?}");
    assert!(outcomes.len() > 20, "each connect made: {}", outcomes.len());
}

// the parcel kind each message reads as, each settled as it is taken
struct Kinds(Mutex<Vec<u8>>);

impl BrokerListener for Kinds {
    fn on_message(&self, message: &BrokerMessage) {
        let kind = match parcels::read(message.payload()) {
            ParcelReading::Parcel(fields) => fields.kind,
            ParcelReading::NoParcel(_) | ParcelReading::DoesNotRead(..) => 0,
        };

        self.0.lock().unwrap().push(kind);
        message.settle();
    }
}

// spec 15.25
#[tokio::test(flavor = "multi_thread")]
async fn carries_a_link_over_a_websocket_of_subprotocol_mqtt() {
    let _serial = SERIAL.lock().await;
    let Some((url, password)) = broker_of("BEAD_MQTT_WS_URL") else {
        return;
    };
    let adapter = linked_as((&url, &password), FIXTURE_USER);
    let fixture_inbox = topic(&["bead", "i", FIXTURE_USER]);
    let kinds = Arc::new(Kinds(Mutex::new(Vec::new())));

    adapter.listen(Arc::<Kinds>::clone(&kinds));
    adapter.start(BrokerStart::default()).await.unwrap();
    adapter
        .subscribe(&fixture_inbox, BrokerSubscription::default())
        .await
        .unwrap();

    let reset = parcels::encode(&ParcelFields {
        layout: 0xB1,
        kind: 8,
        flags: Some(0),
        opener: "01 02 03 04 05 06 07 08".to_owned(),
        acceptor: "08 07 06 05 04 03 02 01".to_owned(),
        sequence: 0,
        id: None,
        incarnation: None,
        bound: None,
        status: None,
        layouts: None,
        credential: None,
        carried: None,
        answers: None,
        code: None,
    })
    .unwrap();
    let mut publication = BrokerPublication::new(fixture_inbox.clone(), Bytes::from(reset.clone()));

    publication.expires_after = Some(Duration::from_secs(5));
    assert_eq!(
        adapter.publish(publication).await.unwrap(),
        BrokerPublished::Taken,
        "taken"
    );
    until(|| !kinds.0.lock().unwrap().is_empty()).await;
    assert_eq!(*kinds.0.lock().unwrap(), vec![8], "a RESET");
    assert_eq!(adapter.unsettled(), 0, "settled");
    // an inbox no one reads is the broker's 0x10
    assert_eq!(
        adapter
            .publish(BrokerPublication::new(
                topic(&["bead", "i", "nobody"]),
                Bytes::from(reset)
            ))
            .await
            .unwrap(),
        BrokerPublished::NoSubscriber,
        "no subscriber"
    );
    adapter.stop().await;
}

// each payload handed on, settled as it is taken
struct Payloads(Arc<Mutex<Vec<Bytes>>>);

impl BrokerListener for Payloads {
    fn on_message(&self, message: &BrokerMessage) {
        self.0.lock().unwrap().push(message.payload().clone());
        message.settle();
    }
}

// spec 15.25
#[tokio::test(flavor = "multi_thread")]
async fn sends_each_websocket_message_to_its_broker_as_one_binary_frame_a_burst_past_64_kib_among_them()
 {
    let _serial = SERIAL.lock().await;
    let Some((url, password)) = broker_of("BEAD_MQTT_WS_URL") else {
        return;
    };
    let broker = address_of(&url).unwrap();
    let relay = FrameRelay::to((&broker.bare, broker.port), &broker.path)
        .await
        .unwrap();
    let adapter = linked_as((relay.url(), &password), FIXTURE_USER);
    let fixture_inbox = topic(&["bead", "i", FIXTURE_USER]);
    let heard = Arc::new(Mutex::new(Vec::<Bytes>::new()));
    let noted = Arc::clone(&heard);

    adapter.listen(Arc::new(Payloads(noted)));
    adapter.start(BrokerStart::default()).await.unwrap();
    adapter
        .subscribe(&fixture_inbox, BrokerSubscription::default())
        .await
        .unwrap();

    // * each the largest its broker takes, together past 64 KiB, all asked at once
    let size = usize::try_from(adapter.maximum_payload_bytes(&fixture_inbox)).unwrap();
    let count = 196_608_usize.div_ceil(size);
    let payloads: Vec<Bytes> = (0..count)
        .map(|index| Bytes::from(vec![u8::try_from(index % 256).unwrap(); size]))
        .collect();
    let publishing: Vec<_> = payloads
        .iter()
        .map(|payload| {
            adapter.publish(BrokerPublication::new(
                fixture_inbox.clone(),
                payload.clone(),
            ))
        })
        .collect();

    for each in publishing {
        assert_eq!(each.await.unwrap(), BrokerPublished::Taken, "taken");
    }

    let started = crate::testing::Instant::now();

    while heard.lock().unwrap().len() < count && started.elapsed() < PATIENCE {
        rest(Duration::from_millis(5)).await;
    }

    assert_eq!(*heard.lock().unwrap(), payloads, "each handed on whole");
    assert!(adapter.is_linked(), "its link kept");
    // * what its client sent, each message one frame: none ends no message, none continues one
    assert!(relay.frames().len() > count, "each sent");
    assert_eq!(unwhole_of(&relay.frames()), Vec::new(), "each one frame");
    adapter.stop().await;
}
