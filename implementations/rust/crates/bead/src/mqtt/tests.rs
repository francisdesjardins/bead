//! The MQTT 5 adapter against a scripted MQTT 5 peer, `testing::mqtt_script`, which writes each
//! answer itself and reads every packet as it goes; and, in `fixture`, a link through the Mosquitto
//! `BEAD_MQTT_URL` names. The TypeScript side's `createMqttBrokerAdapter` tests and the C# side's
//! `MqttBrokerAdapterTests` play the same sentences.

use core::time::Duration;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::broker::adapter::{
    BrokerAdapter, BrokerCapabilities, BrokerDelivery, BrokerDown, BrokerError, BrokerListener,
    BrokerMessage, BrokerPublication, BrokerPublished, BrokerStart, BrokerSubscription,
};
use crate::broker::participant::{BrokerParticipant, BrokerParticipantOptions};
use crate::broker::server::BrokerTransportServerOptions;
use crate::duration::NEVER;
use crate::mqtt::adapter::{MqttBrokerAdapter, MqttBrokerAdapterOptions, TRANSPORT_MQTT};
use crate::mqtt::packets::{
    LARGEST_PACKET_SIZE, MAXIMUM_PACKET_SIZE, MqttPublishShapeOptions, largest_payload,
};
use crate::net::credential::{CredentialProvider, CredentialProviderError};
use crate::router::types::BoxFuture;
use crate::testing::mqtt_script::{
    Connack, Kind, MqttScript, MqttScriptOptions, Publish, Scripted, ScriptedLink, connack,
    disconnect, pingresp, puback, publish, suback, unsuback, unsubscribe_bytes,
};
use crate::testing::parcels::{self, ParcelFields, ParcelReading};
use crate::testing::{Instant, rest, spawn, tls};

mod fixture;
mod reading;
mod websocket;

const ID: &str = "ada";
const PASSWORD: &str = "secret";
const PATIENCE: Duration = Duration::from_secs(5);

fn topic(tokens: &[&str]) -> Vec<String> {
    tokens.iter().map(|token| (*token).to_owned()).collect()
}

fn inbox() -> Vec<String> {
    topic(&["bead", "i", ID])
}

fn name() -> Vec<String> {
    topic(&["bead", "s", "interop"])
}

async fn script() -> MqttScript {
    MqttScript::new(&MqttScriptOptions::default())
        .await
        .unwrap()
}

/// The options of an adapter of `ID` to `script`, its password `PASSWORD`.
fn options_of(script: &MqttScript) -> MqttBrokerAdapterOptions {
    let mut options = MqttBrokerAdapterOptions::new(script.url(), ID);

    options.password = Some(PASSWORD.to_owned());

    options
}

fn adapter_of(options: &MqttBrokerAdapterOptions) -> MqttBrokerAdapter {
    MqttBrokerAdapter::new(options).unwrap()
}

fn group(name: &str) -> BrokerSubscription {
    BrokerSubscription {
        group: Some(name.to_owned()),
        signal: None,
    }
}

fn publication(topic: Vec<String>, payload: &[u8]) -> BrokerPublication {
    BrokerPublication::new(topic, Bytes::copy_from_slice(payload))
}

fn message_of(error: &BrokerError) -> String {
    error.to_string()
}

/// `adapter` started, its link the script's next, answered by `answer`.
async fn link_up(
    (adapter, script): (&MqttBrokerAdapter, &MqttScript),
    (answer, will): (&Connack, Option<BrokerPublication>),
) -> ScriptedLink {
    let starting = adapter.start(BrokerStart { will, signal: None });
    let link = script.link(PATIENCE).await.unwrap();

    link.send(connack(answer));
    starting.await.unwrap();

    link
}

/// A SUBACK of `code` to the next SUBSCRIBE `link` reads, which it gives back.
async fn suback_of(link: &ScriptedLink, code: u8) -> Scripted {
    let subscribe = link.next(Some(Kind::Subscribe), PATIENCE).await.unwrap();

    link.send(suback(subscribe.identifier(), code));

    subscribe
}

/// `stopping` settled, each UNSUBSCRIBE `link` reads meanwhile answered by an UNSUBACK of 0x00; the
/// filters they named, in their order.
async fn unsubacked_of(link: &ScriptedLink, stopping: BoxFuture<()>) -> Vec<String> {
    let stopping = spawn(stopping);
    let mut filters = Vec::new();

    while !stopping.is_finished() {
        if let Ok(unsubscribe) = link
            .next(Some(Kind::Unsubscribe), Duration::from_millis(20))
            .await
        {
            filters.extend(unsubscribe.filters());
            link.send(unsuback(unsubscribe.identifier(), 0));
        }
    }

    stopping.await.unwrap();

    filters
}

/// The messages and the downs an adapter tells, as they come.
#[derive(Default)]
struct Heard {
    messages: Mutex<Vec<BrokerMessage>>,
    downs: Mutex<Vec<BrokerDown>>,
}

impl BrokerListener for Heard {
    fn on_message(&self, message: &BrokerMessage) {
        self.messages.lock().unwrap().push(message.clone());
    }

    fn on_down(&self, down: BrokerDown) {
        self.downs.lock().unwrap().push(down);
    }
}

impl Heard {
    fn messages(&self) -> Vec<BrokerMessage> {
        self.messages.lock().unwrap().clone()
    }

    fn downs(&self) -> Vec<BrokerDown> {
        self.downs.lock().unwrap().clone()
    }
}

fn heard_of(adapter: &MqttBrokerAdapter) -> Arc<Heard> {
    let heard = Arc::new(Heard::default());

    adapter.listen(Arc::<Heard>::clone(&heard));

    heard
}

/// Polls `is_done` on the real clock until it holds, within five seconds.
async fn until<F: Fn() -> bool>(is_done: F) {
    let started = Instant::now();

    while !is_done() && started.elapsed() < PATIENCE {
        rest(Duration::from_millis(5)).await;
    }
}

fn down(is_taken_over: bool) -> BrokerDown {
    BrokerDown::new(is_taken_over)
}

/// A provider that hands what `answer` gives, counting each ask.
fn provider_of<F>(answer: F) -> CredentialProvider
where
    F: Fn(CancellationToken) -> BoxFuture<Result<String, CredentialProviderError>>
        + Send
        + Sync
        + 'static,
{
    Arc::new(answer)
}

fn kinds_of(link: &ScriptedLink) -> Vec<Kind> {
    link.kinds()
}

fn sent_of(link: &ScriptedLink) -> Vec<Scripted> {
    link.of(Kind::Publish)
}

fn payloads_of(packets: &[Scripted]) -> Vec<u8> {
    packets
        .iter()
        .filter_map(|packet| packet.publish()?.payload.first().copied())
        .collect()
}

// ── Its link ─────────────────────────────────────────────────────────────────────────────────

// spec 15.26
#[tokio::test]
async fn connects_a_link_that_keeps_no_session_its_id_its_client_identifier_its_password_under_its_id_or_none_under_a_certificate_topic_alias_maximum_0_its_maximum_packet_size_and_its_keep_alive()
 {
    let script = script().await;
    let asked = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&asked);
    let mut options = MqttBrokerAdapterOptions::new(script.url(), ID);

    options.keep_alive = Some(Duration::from_millis(1_500));
    options.maximum_packet_size = Some(2_048);
    options.password_provider = Some(provider_of(move |_signal| {
        let asked = counted.fetch_add(1, Ordering::SeqCst).saturating_add(1);

        Box::pin(async move { Ok(format!("{PASSWORD}-{asked}")) })
    }));

    let adapter = adapter_of(&options);
    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;
    let connect = link.connect();

    assert!(connect.clean_start, "Clean Start");
    assert_eq!(connect.client_identifier, ID, "its id");
    assert_eq!(connect.keep_alive, 2, "its Keep Alive, rounded up");
    assert_eq!(
        connect.maximum_packet_size,
        Some(2_048),
        "its Maximum Packet Size"
    );
    assert_eq!(connect.receive_maximum, Some(65_535), "its Receive Maximum");
    assert_eq!(
        connect.topic_alias_maximum,
        Some(0),
        "its Topic Alias Maximum"
    );
    assert_eq!(connect.protocol_level, 5, "MQTT 5");
    assert_eq!(connect.user_name.as_deref(), Some(ID), "its User Name");
    assert_eq!(
        connect.password.as_deref(),
        Some(format!("{PASSWORD}-1").as_bytes()),
        "its Password"
    );
    assert_eq!(
        connect.session_expiry_interval.unwrap_or_default(),
        0,
        "no session kept"
    );
    assert_eq!(adapter.transport_type(), TRANSPORT_MQTT, "its type");
    adapter.stop().await;

    // * a password asked at each link's start, renewed with each incarnation
    let again = link_up((&adapter, &script), (&Connack::default(), None)).await;

    assert_eq!(
        again.connect().password.as_deref(),
        Some(format!("{PASSWORD}-2").as_bytes()),
        "renewed"
    );
    adapter.stop().await;

    // under a client certificate its broker ties to its id, over TLS: neither User Name nor
    // Password
    let secured_options = MqttScriptOptions {
        tls: Some(tls::server_config().unwrap()),
    };

    let secured = MqttScript::new(&secured_options).await.unwrap();
    let mut certified = MqttBrokerAdapterOptions::new(secured.url(), ID);

    certified.tls = Some(tls::certified_client_config().unwrap());

    let certified = adapter_of(&certified);
    let bare = link_up((&certified, &secured), (&Connack::default(), None)).await;

    assert_eq!(bare.connect().client_identifier, ID, "its id");
    assert_eq!(bare.connect().user_name, None, "no User Name");
    assert_eq!(bare.connect().password, None, "no Password");
    assert!(certified.is_secure(), "secure");
    certified.stop().await;

    // a certificate in the clear is refused as it is built
    let mut clear = MqttBrokerAdapterOptions::new(script.url(), ID);

    clear.tls = Some(tls::certified_client_config().unwrap());

    let refused = MqttBrokerAdapter::new(&clear).unwrap_err();

    assert!(
        refused
            .message()
            .contains("a TLS client certificate is carried over mqtts or wss"),
        "{refused}"
    );
}

// spec 15.26
#[tokio::test]
async fn fails_its_start_on_a_connack_whose_maximum_qos_is_0_naming_it() {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let heard = heard_of(&adapter);
    let starting = adapter.start(BrokerStart::default());
    let link = script.link(PATIENCE).await.unwrap();

    link.send(connack(&Connack {
        maximum_qos: Some(0),
        ..Connack::default()
    }));

    let failed = starting.await.unwrap_err();

    assert!(message_of(&failed).contains("Maximum QoS 0"), "{failed}");
    assert_eq!(heard.downs(), Vec::new(), "no down");

    // * a start that fails sends nothing: no DISCONNECT
    assert!(link.closed(PATIENCE).await, "closed");
    assert_eq!(link.kinds(), vec![Kind::Connect], "no DISCONNECT");

    // a CONNACK that refuses fails it too, naming its reason
    let starting = adapter.start(BrokerStart::default());
    let refused = script.link(PATIENCE).await.unwrap();

    refused.send(connack(&Connack {
        reason_code: 0x86,
        ..Connack::default()
    }));

    let failed = starting.await.unwrap_err();

    assert!(
        message_of(&failed).contains("Bad User Name or Password"),
        "{failed}"
    );

    // and so does no CONNACK within its connect timeout
    let mut options = options_of(&script);

    options.connect_timeout = Some(Duration::from_millis(200));

    let waiting = adapter_of(&options);
    let failed = waiting.start(BrokerStart::default()).await.unwrap_err();

    assert!(
        message_of(&failed).contains("no CONNACK within 200 ms"),
        "{failed}"
    );
}

#[tokio::test]
async fn fails_its_start_where_its_broker_cannot_be_reached_over_tcp_tls_or_a_websocket_naming_why()
{
    // a port no one listens on any more
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    drop(listener);

    // * and a host no name resolves to (RFC 6761 §6.4), on the port of its scheme
    for url in [
        format!("mqtt://127.0.0.1:{port}"),
        format!("mqtts://127.0.0.1:{port}"),
        format!("ws://127.0.0.1:{port}/mqtt"),
        format!("wss://127.0.0.1:{port}/mqtt"),
        "mqtt://broker.invalid".to_owned(),
        "mqtts://broker.invalid".to_owned(),
    ] {
        // * given up within a second, so that a slow resolver fails it rather than the test
        let mut options = MqttBrokerAdapterOptions::new(&url, ID);

        options.password = Some(PASSWORD.to_owned());
        options.connect_timeout = Some(Duration::from_secs(1));

        let adapter = adapter_of(&options);
        let heard = heard_of(&adapter);
        let failed = message_of(&adapter.start(BrokerStart::default()).await.unwrap_err());

        assert!(
            failed.starts_with("the link of ada ended before its CONNACK")
                || failed.starts_with("the link of ada had no CONNACK within 1000 ms"),
            "{url}: {failed}"
        );
        assert!(!adapter.is_linked(), "{url}: not linked");
        assert_eq!(heard.downs(), Vec::new(), "{url}: no down");
    }
}

#[tokio::test]
async fn fails_its_start_over_tls_where_its_brokers_certificate_chains_to_no_authority_it_trusts() {
    let secured_options = MqttScriptOptions {
        tls: Some(tls::server_config().unwrap()),
    };

    let secured = MqttScript::new(&secured_options).await.unwrap();
    let mut options = MqttBrokerAdapterOptions::new(secured.url(), ID);

    options.tls = Some(tls::untrusting_client_config().unwrap());

    let untrusting = adapter_of(&options);
    let failed = untrusting.start(BrokerStart::default()).await.unwrap_err();

    assert!(
        message_of(&failed).contains("the link of ada ended before its CONNACK"),
        "{failed}"
    );
    // * no CONNECT went: its broker's certificate was refused before it
    assert!(
        secured.link(Duration::from_millis(200)).await.is_err(),
        "no link came"
    );
}

// spec 15.26
#[tokio::test]
async fn keeps_a_server_keep_alive_shorter_than_its_own_a_pingreq_once_nothing_went_for_that_long()
{
    let script = script().await;
    let mut options = options_of(&script);

    options.keep_alive = Some(Duration::from_secs(30));

    let adapter = adapter_of(&options);
    let link = link_up(
        (&adapter, &script),
        (
            &Connack {
                server_keep_alive: Some(1),
                ..Connack::default()
            },
            None,
        ),
    )
    .await;
    let started = Instant::now();

    link.next(Some(Kind::Pingreq), Duration::from_secs(3))
        .await
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(2_500),
        "within its Server Keep Alive"
    );
    link.send(pingresp());
    adapter.stop().await;
}

// spec 15.26
#[tokio::test]
async fn leaves_a_will_of_its_gone_qos_1_retain_0_and_a_will_delay_interval_of_0_and_stops_with_a_disconnect_of_0x00()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let gone = parcels::encode(&ParcelFields {
        layout: 0xB1,
        kind: 9,
        flags: Some(0),
        opener: "00 00 00 00 00 00 00 00".to_owned(),
        acceptor: "00 00 00 00 00 00 00 00".to_owned(),
        sequence: 0,
        id: Some(ID.to_owned()),
        incarnation: Some("07070707070707070707070707070707".to_owned()),
        bound: None,
        status: None,
        layouts: None,
        credential: None,
        carried: None,
        answers: None,
        code: None,
    })
    .unwrap();
    let link = link_up(
        (&adapter, &script),
        (
            &Connack::default(),
            Some(publication(topic(&["bead", "d", ID]), &gone)),
        ),
    )
    .await;
    let will = link.connect().will.clone().unwrap();

    assert_eq!(will.delay, Some(0), "a Will Delay Interval of 0");
    assert_eq!(will.qos, 1, "QoS 1");
    assert!(!will.retain, "RETAIN 0");
    assert_eq!(will.topic, "bead/d/ada", "its departure");
    assert_eq!(will.payload, gone, "its GONE");

    let heard = heard_of(&adapter);
    // what its stop finds unsettled fails, nothing of it left to a later link
    let pending = spawn(adapter.subscribe(&inbox(), BrokerSubscription::default()));

    link.next(Some(Kind::Subscribe), PATIENCE).await.unwrap();
    // * its SUBSCRIBE under way let go before its DISCONNECT
    assert_eq!(
        unsubacked_of(&link, adapter.stop()).await,
        vec!["bead/i/ada".to_owned()],
        "let go"
    );
    assert_eq!(
        message_of(&pending.await.unwrap().unwrap_err()),
        "the link of ada stopped",
        "failed"
    );

    let disconnected = link.next(Some(Kind::Disconnect), PATIENCE).await.unwrap();

    assert_eq!(
        disconnected,
        Scripted::Disconnect { reason: 0 },
        "a DISCONNECT of 0x00"
    );
    assert!(link.closed(PATIENCE).await, "closed");
    assert_eq!(heard.downs(), Vec::new(), "no down");
}

// spec 15.21
#[tokio::test]
async fn ends_a_participants_link_with_a_disconnect_of_0x00_when_its_stop_meets_its_inboxs_subscribe()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let options = BrokerParticipantOptions {
        heartbeat: Some(NEVER),
        ..BrokerParticipantOptions::default()
    };

    let participant = BrokerParticipant::new(Arc::new(adapter), &options).unwrap();
    let starting = spawn(participant.start());
    let link = script.link(PATIENCE).await.unwrap();

    link.send(connack(&Connack::default()));
    // * its inbox's SUBSCRIBE left unanswered: its adapter's stop ends it, no signal of the stop
    link.next(Some(Kind::Subscribe), PATIENCE).await.unwrap();
    assert_eq!(
        unsubacked_of(&link, participant.stop()).await,
        vec!["bead/i/ada".to_owned()],
        "let go"
    );
    assert_eq!(
        message_of(&starting.await.unwrap().unwrap_err()),
        "the participant ada stopped as it started",
        "its start ended"
    );
    assert_eq!(
        link.next(Some(Kind::Disconnect), PATIENCE).await.unwrap(),
        Scripted::Disconnect { reason: 0 },
        "a DISCONNECT of 0x00"
    );
    assert!(link.closed(PATIENCE).await, "closed");
    assert_eq!(
        kinds_of(&link),
        vec![
            Kind::Connect,
            Kind::Subscribe,
            Kind::Unsubscribe,
            Kind::Disconnect
        ],
        "its packets"
    );
}

/// An OPEN of bob's to `interop` for each of `openers`, each ACCEPT its participant answers
/// acknowledged: a connection half-open of each.
async fn half_opened(link: &ScriptedLink, openers: u8) {
    for opener in 1..=openers {
        let open = parcels::encode(&ParcelFields {
            layout: 0xB1,
            kind: 1,
            flags: Some(0),
            opener: format!("00 00 00 00 00 00 00 {opener:02X}"),
            acceptor: "00 00 00 00 00 00 00 00".to_owned(),
            sequence: 1,
            id: Some("bob".to_owned()),
            incarnation: Some("00000000000000000000000000000B0B".to_owned()),
            bound: Some(65_536),
            status: None,
            layouts: None,
            credential: None,
            carried: None,
            answers: None,
            code: None,
        })
        .unwrap();

        link.send(publish(&Publish {
            topic: "bead/s/interop".to_owned(),
            identifier: Some(u16::from(opener)),
            retain: false,
            payload: open,
        }));

        let accept = link.next(Some(Kind::Publish), PATIENCE).await.unwrap();

        assert_eq!(accept.publish().unwrap().topic, "bead/i/bob", "an ACCEPT");
        link.send(puback(accept.identifier(), 0));
    }
}

// spec 15.21
#[tokio::test]
async fn sends_each_connections_close_of_1001_before_its_adapters_disconnect_past_its_brokers_receive_maximum()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let options = BrokerParticipantOptions {
        heartbeat: Some(NEVER),
        ..BrokerParticipantOptions::default()
    };
    let participant = BrokerParticipant::new(Arc::new(adapter), &options).unwrap();
    let server = participant
        .server(&BrokerTransportServerOptions::new(["interop".to_owned()]))
        .unwrap();
    let starting = spawn(server.start());
    let link = script.link(PATIENCE).await.unwrap();

    link.send(connack(&Connack {
        receive_maximum: Some(1),
        ..Connack::default()
    }));
    suback_of(&link, 1).await;
    suback_of(&link, 1).await;
    starting.await.unwrap().unwrap();
    half_opened(&link, 3).await;

    let stopping = spawn(participant.stop());
    let name_let_go = link.next(Some(Kind::Unsubscribe), PATIENCE).await.unwrap();

    assert_eq!(
        name_let_go.filters(),
        vec!["bead/s/interop".to_owned()],
        "its name let go"
    );
    link.send(unsuback(name_let_go.identifier(), 0));

    // * one CLOSE at a time, its PUBACK given late, each before its adapter's DISCONNECT
    let mut closes = Vec::new();

    for _ in 1..=3 {
        let close = link.next(Some(Kind::Publish), PATIENCE).await.unwrap();
        let sent = close.publish().unwrap();

        assert_eq!(sent.topic, "bead/i/bob", "to its peer");
        closes.push(parcels::read(&sent.payload));
        rest(Duration::from_millis(50)).await;
        assert!(!stopping.is_finished(), "its stop waits");
        assert_eq!(
            link.of(Kind::Publish)
                .iter()
                .filter(|packet| packet
                    .publish()
                    .is_some_and(|sent| sent.topic == "bead/i/bob"))
                .count(),
            3 + closes.len(),
            "one CLOSE alone in flight"
        );
        link.send(puback(close.identifier(), 0));
    }

    let inbox_let_go = link.next(Some(Kind::Unsubscribe), PATIENCE).await.unwrap();

    assert_eq!(
        inbox_let_go.filters(),
        vec!["bead/i/ada".to_owned()],
        "its inbox let go"
    );
    link.send(unsuback(inbox_let_go.identifier(), 0));
    assert_eq!(
        link.next(Some(Kind::Disconnect), PATIENCE).await.unwrap(),
        Scripted::Disconnect { reason: 0 },
        "a DISCONNECT of 0x00"
    );
    stopping.await.unwrap();

    let mut openers: Vec<_> = closes
        .into_iter()
        .map(|reading| match reading {
            ParcelReading::Parcel(parcel) => {
                assert_eq!(
                    (parcel.kind, parcel.code),
                    (7, Some(1_001)),
                    "a CLOSE of 1001"
                );
                parcel.opener
            }
            other @ (ParcelReading::NoParcel(_) | ParcelReading::DoesNotRead(..)) => {
                panic!("no CLOSE: {other:?}")
            }
        })
        .collect();

    openers.sort();
    assert_eq!(
        openers,
        ["01", "02", "03"].map(|opener| format!("00 00 00 00 00 00 00 {opener}")),
        "each connection's"
    );
}

// spec 15.26
#[tokio::test]
async fn tells_its_link_taken_over_on_a_disconnect_of_0x8e_and_lost_on_any_other_end() {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let heard = heard_of(&adapter);
    let first = link_up((&adapter, &script), (&Connack::default(), None)).await;

    first.send(disconnect(0x8E));
    first.end();
    until(|| !heard.downs().is_empty()).await;
    assert_eq!(heard.downs(), vec![down(true)], "taken over");

    // a DISCONNECT of another reason, and a cut, are a link lost
    let second = link_up((&adapter, &script), (&Connack::default(), None)).await;

    second.send(disconnect(0x95));
    second.end();
    until(|| heard.downs().len() > 1).await;

    let third = link_up((&adapter, &script), (&Connack::default(), None)).await;

    third.cut();
    until(|| heard.downs().len() > 2).await;
    assert_eq!(
        heard.downs(),
        vec![down(true), down(false), down(false)],
        "lost"
    );
}

// ── Its subscriptions ────────────────────────────────────────────────────────────────────────

// spec 15.27
#[tokio::test]
async fn subscribes_at_qos_1_no_local_0_retain_as_published_0_and_retain_handling_2_a_group_as_its_shared_subscription_held_once_its_suback_grants_qos_1_and_refused_otherwise()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;
    let subscribing = spawn(adapter.subscribe(&inbox(), BrokerSubscription::default()));
    let subscribe = link.next(Some(Kind::Subscribe), PATIENCE).await.unwrap();

    assert_eq!(
        subscribe,
        Scripted::Subscribe {
            identifier: subscribe.identifier(),
            filters: vec![("bead/i/ada".to_owned(), 0b0010_0001)],
        },
        "QoS 1, No Local 0, Retain As Published 0, Retain Handling 2"
    );
    rest(Duration::from_millis(50)).await;
    assert!(!subscribing.is_finished(), "held once its SUBACK came");
    link.send(suback(subscribe.identifier(), 1));
    subscribing.await.unwrap().unwrap();

    // * a group's own filter, which its UNSUBSCRIBE names again
    let grouped = spawn(adapter.subscribe(&name(), group("interop")));
    let shared = suback_of(&link, 1).await;

    grouped.await.unwrap().unwrap();
    assert_eq!(
        shared.filters(),
        vec!["$share/interop/bead/s/interop".to_owned()],
        "its shared subscription"
    );

    let leaving = spawn(adapter.unsubscribe(&name()));
    let unsubscribe = link.next(Some(Kind::Unsubscribe), PATIENCE).await.unwrap();

    assert_eq!(
        unsubscribe.filters(),
        vec!["$share/interop/bead/s/interop".to_owned()],
        "named again"
    );
    link.send(unsuback(unsubscribe.identifier(), 0));
    leaving.await.unwrap().unwrap();

    // QoS 0 granted is refused, as a failure is
    let downgraded =
        spawn(adapter.subscribe(&topic(&["bead", "d", "bob"]), BrokerSubscription::default()));

    suback_of(&link, 0).await;
    assert!(
        message_of(&downgraded.await.unwrap().unwrap_err()).contains("0x00"),
        "QoS 0 refused"
    );

    let failed =
        spawn(adapter.subscribe(&topic(&["bead", "d", "eve"]), BrokerSubscription::default()));

    suback_of(&link, 0x87).await;
    assert!(
        message_of(&failed.await.unwrap().unwrap_err()).contains("0x87"),
        "0x87 refused"
    );
    // * its stop lets go of what its broker holds, QoS 0 granted among it, and of nothing refused
    assert_eq!(
        unsubacked_of(&link, adapter.stop()).await,
        vec!["bead/i/ada".to_owned(), "bead/d/bob".to_owned()],
        "let go"
    );
}

// spec 15.27
#[tokio::test]
async fn lets_a_subscription_go_once_its_unsuback_came_naming_the_topic_itself_where_it_held_none_and_refuses_it_on_a_code_of_0x80_or_more()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;
    let answered = async |(peer, code): (&str, u8)| -> Result<Vec<String>, BrokerError> {
        let leaving = spawn(adapter.unsubscribe(&topic(&["bead", "d", peer])));
        let unsubscribe = link.next(Some(Kind::Unsubscribe), PATIENCE).await.unwrap();

        link.send(unsuback(unsubscribe.identifier(), code));
        leaving.await.unwrap()?;

        Ok(unsubscribe.filters())
    };

    // * one its broker held none of is let go all the same, 0x11
    assert_eq!(
        answered(("bob", 0x11)).await.unwrap(),
        vec!["bead/d/bob".to_owned()],
        "0x11"
    );
    assert_eq!(
        answered(("bob", 0x00)).await.unwrap(),
        vec!["bead/d/bob".to_owned()],
        "0x00"
    );
    assert!(
        message_of(&answered(("eve", 0x87)).await.unwrap_err()).contains("0x87"),
        "0x87"
    );
    assert!(
        message_of(&answered(("eve", 0x80)).await.unwrap_err()).contains("0x80"),
        "0x80"
    );
    // its link kept
    assert!(adapter.is_linked(), "kept");
    adapter.stop().await;
}

// spec 15.27
#[tokio::test]
async fn fails_an_unsubscription_whose_unsuback_has_not_come_within_connect_timeout_its_link_kept_and_no_will_gone_then_reads_the_late_unsuback()
 {
    let script = script().await;
    let mut options = options_of(&script);

    options.connect_timeout = Some(Duration::from_millis(300));

    let adapter = adapter_of(&options);
    let heard = heard_of(&adapter);
    let link = link_up(
        (&adapter, &script),
        (
            &Connack::default(),
            Some(publication(topic(&["bead", "d", ID]), &[1])),
        ),
    )
    .await;
    let other = topic(&["bead", "s", "other"]);

    for each in [name(), other.clone()] {
        let subscribing = spawn(adapter.subscribe(&each, BrokerSubscription::default()));

        suback_of(&link, 1).await;
        subscribing.await.unwrap().unwrap();
    }

    // * neither UNSUBACK comes within its connect timeout: each fails, naming it, its link kept
    let started = Instant::now();
    let leaving = [
        spawn(adapter.unsubscribe(&name())),
        spawn(adapter.unsubscribe(&other)),
    ];
    let first = link.next(Some(Kind::Unsubscribe), PATIENCE).await.unwrap();

    link.next(Some(Kind::Unsubscribe), PATIENCE).await.unwrap();

    for each in leaving {
        let failed = message_of(&each.await.unwrap().unwrap_err());

        assert!(
            failed.contains("within 300 ms, its connectTimeout"),
            "naming its connect timeout: {failed}"
        );
    }

    assert!(
        started.elapsed() >= Duration::from_millis(250),
        "its connect timeout waited"
    );
    assert!(adapter.is_linked() && !link.is_closed(), "its link kept");
    assert_eq!(heard.downs(), Vec::new(), "no down");

    // * the late UNSUBACK of the first read, which lets its filter go; the second's kept for its stop
    link.send(unsuback(first.identifier(), 0));
    rest(Duration::from_millis(50)).await;
    assert!(
        adapter.is_linked() && !link.is_closed(),
        "read, its link kept"
    );
    assert_eq!(
        unsubacked_of(&link, adapter.stop()).await,
        vec!["bead/s/other".to_owned()],
        "its stop lets the second go"
    );
    assert_eq!(
        link.next(Some(Kind::Disconnect), PATIENCE).await.unwrap(),
        Scripted::Disconnect { reason: 0 },
        "its DISCONNECT, no will"
    );
    assert_eq!(heard.downs(), Vec::new(), "no loss told");
}

// spec 15.25
#[tokio::test]
async fn refuses_a_group_once_its_connack_says_shared_subscription_available_0_or_its_suback_0x9e()
{
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let link = link_up(
        (&adapter, &script),
        (
            &Connack {
                shared_subscription_available: Some(false),
                ..Connack::default()
            },
            None,
        ),
    )
    .await;
    let refused = adapter
        .subscribe(&name(), group("interop"))
        .await
        .unwrap_err();

    assert!(
        message_of(&refused).contains("no shared subscription"),
        "{refused}"
    );
    rest(Duration::from_millis(50)).await;
    assert!(link.of(Kind::Subscribe).is_empty(), "no SUBSCRIBE sent");
    adapter.stop().await;

    // its SUBACK's 0x9E refuses that group, and every one after it on that link
    let again = link_up((&adapter, &script), (&Connack::default(), None)).await;
    let first = spawn(adapter.subscribe(&name(), group("interop")));

    suback_of(&again, 0x9E).await;
    assert!(
        message_of(&first.await.unwrap().unwrap_err()).contains("0x9E"),
        "0x9E"
    );
    assert!(
        message_of(
            &adapter
                .subscribe(&name(), group("interop"))
                .await
                .unwrap_err()
        )
        .contains("no shared subscription"),
        "none after it"
    );
    adapter.stop().await;

    // and an adapter told its broker offers none states it, and refuses one as asked
    let mut options = options_of(&script);

    options.groups = Some(false);

    let none = adapter_of(&options);

    assert!(
        !none.capabilities().contains(BrokerCapabilities::GROUPS),
        "none"
    );
    assert!(
        adapter.capabilities().contains(BrokerCapabilities::GROUPS),
        "groups"
    );
    assert!(
        matches!(
            none.subscribe(&name(), group("interop")).await,
            Err(BrokerError::Refused(_))
        ),
        "refused as asked"
    );
}

// ── Its publications ─────────────────────────────────────────────────────────────────────────

// spec 15.28
#[tokio::test]
async fn publishes_at_qos_1_and_retain_0_a_life_in_whole_seconds_rounded_up_where_one_is_asked_and_no_other_property()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;

    for (life, seconds) in [
        (None, None),
        (Some(1), Some(1)),
        (Some(1_000), Some(1)),
        (Some(1_001), Some(2)),
        (Some(60_000), Some(60)),
    ] {
        let mut asked = publication(inbox(), &[1, 2, 3]);

        asked.expires_after = life.map(Duration::from_millis);

        let publishing = spawn(adapter.publish(asked));
        let sent = link.next(Some(Kind::Publish), PATIENCE).await.unwrap();

        link.send(puback(sent.identifier(), 0));
        assert_eq!(
            publishing.await.unwrap().unwrap(),
            BrokerPublished::Taken,
            "taken"
        );

        let sent = sent.publish().unwrap();

        assert_eq!(sent.payload, vec![1, 2, 3], "its payload");
        assert_eq!(sent.qos, 1, "QoS 1");
        assert!(!sent.retain, "RETAIN 0");
        assert_eq!(sent.topic, "bead/i/ada", "its topic");
        assert_eq!(sent.message_expiry_interval, seconds, "{life:?}: its life");
        assert_eq!(
            sent.properties,
            if seconds.is_some() {
                vec![0x02]
            } else {
                vec![]
            },
            "no other property"
        );
    }

    adapter.stop().await;

    // at most once, each of QoS 0, which no PUBACK answers
    let mut options = options_of(&script);

    options.delivery = Some(BrokerDelivery::AtMostOnce);

    let quick = adapter_of(&options);
    let quick_link = link_up((&quick, &script), (&Connack::default(), None)).await;

    assert_eq!(quick.delivery(), BrokerDelivery::AtMostOnce, "at most once");

    // its bound counts no Packet Identifier, which a QoS 0 PUBLISH has none of
    let shape = MqttPublishShapeOptions {
        is_at_most_once: Some(true),
        ..MqttPublishShapeOptions::default()
    };

    assert_eq!(
        Some(quick.maximum_payload_bytes(&inbox())),
        largest_payload("bead/i/ada", u64::from(LARGEST_PACKET_SIZE), &shape),
        "no Packet Identifier counted"
    );
    assert!(
        !quick
            .capabilities()
            .contains(BrokerCapabilities::NO_SUBSCRIBER),
        "no word of a subscriber"
    );
    assert_eq!(
        quick
            .publish(publication(inbox(), &[1, 2, 3]))
            .await
            .unwrap(),
        BrokerPublished::Taken,
        "taken as it went"
    );
    assert_eq!(
        quick_link
            .next(Some(Kind::Publish), PATIENCE)
            .await
            .unwrap()
            .publish()
            .unwrap()
            .qos,
        0,
        "QoS 0"
    );
    quick.stop().await;
}

// spec 15.28
#[tokio::test]
async fn holds_its_qos_1_publications_to_its_connacks_receive_maximum_the_next_one_going_once_a_puback_came_and_delays_no_other_packet_for_them()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let link = link_up(
        (&adapter, &script),
        (
            &Connack {
                receive_maximum: Some(2),
                ..Connack::default()
            },
            None,
        ),
    )
    .await;
    let publishing: Vec<_> = (1..=5_u8)
        .map(|index| spawn(adapter.publish(publication(inbox(), &[index]))))
        .collect();

    rest(Duration::from_millis(100)).await;
    assert_eq!(sent_of(&link).len(), 2, "two in flight");

    // * a SUBSCRIBE goes past them, its quota none of theirs
    let subscribing =
        spawn(adapter.subscribe(&topic(&["bead", "d", "bob"]), BrokerSubscription::default()));

    suback_of(&link, 1).await;
    subscribing.await.unwrap().unwrap();
    assert_eq!(sent_of(&link).len(), 2, "still two");

    for expected in 3..=5_usize {
        let oldest = sent_of(&link)[expected.saturating_sub(3)].identifier();

        link.send(puback(oldest, 0));
        until(|| sent_of(&link).len() == expected).await;
        assert_eq!(sent_of(&link).len(), expected, "one more");
    }

    for sent in sent_of(&link).iter().skip(3) {
        link.send(puback(sent.identifier(), 0));
    }

    for each in publishing {
        assert_eq!(
            each.await.unwrap().unwrap(),
            BrokerPublished::Taken,
            "taken"
        );
    }

    assert_eq!(
        payloads_of(&sent_of(&link)),
        vec![1, 2, 3, 4, 5],
        "in their order"
    );
    assert_eq!(
        unsubacked_of(&link, adapter.stop()).await,
        vec!["bead/d/bob".to_owned()],
        "let go"
    );
}

// spec 15.24, 15.28
#[tokio::test]
async fn sends_what_waits_on_its_brokers_receive_maximum_before_its_stops_disconnect_within_its_connect_timeout_and_fails_what_has_not_gone_by_then()
 {
    let script = script().await;
    let mut options = options_of(&script);

    options.connect_timeout = Some(Duration::from_secs(1));

    let adapter = adapter_of(&options);
    let heard = heard_of(&adapter);
    let one = Connack {
        receive_maximum: Some(1),
        ..Connack::default()
    };
    let link = link_up((&adapter, &script), (&one, None)).await;
    let publishing: Vec<_> = (1..=3_u8)
        .map(|index| spawn(adapter.publish(publication(inbox(), &[index]))))
        .collect();

    until(|| sent_of(&link).len() == 1).await;

    // * its stop takes no publication, and sends what waits first, one PUBACK at a time
    let stopping = spawn(adapter.stop());
    let refused = adapter
        .publish(publication(inbox(), &[4]))
        .await
        .unwrap_err();

    assert_eq!(
        message_of(&refused),
        "the link of ada is not up",
        "none taken once it stops"
    );

    for index in 0..3 {
        until(|| sent_of(&link).len() == index + 1).await;
        assert_eq!(sent_of(&link).len(), index + 1, "one at a time");
        link.send(puback(sent_of(&link)[index].identifier(), 0));
    }

    stopping.await.unwrap();

    for each in publishing {
        assert_eq!(
            each.await.unwrap().unwrap(),
            BrokerPublished::Taken,
            "each taken"
        );
    }

    assert_eq!(
        link.next(Some(Kind::Disconnect), PATIENCE).await.unwrap(),
        Scripted::Disconnect { reason: 0 },
        "no will"
    );
    assert_eq!(
        link.packets()
            .iter()
            .filter(|packet| matches!(packet.kind(), Kind::Publish | Kind::Disconnect))
            .map(Scripted::kind)
            .collect::<Vec<_>>(),
        vec![
            Kind::Publish,
            Kind::Publish,
            Kind::Publish,
            Kind::Disconnect
        ],
        "each sent before its DISCONNECT"
    );
    assert_eq!(
        payloads_of(&sent_of(&link)),
        vec![1, 2, 3],
        "in their order"
    );

    // * its broker answers none: past its connect timeout, what has not gone fails, and its
    // DISCONNECT goes
    let silent = link_up((&adapter, &script), (&one, None)).await;
    let unanswered: Vec<_> = [5_u8, 6]
        .into_iter()
        .map(|index| spawn(adapter.publish(publication(inbox(), &[index]))))
        .collect();

    silent.next(Some(Kind::Publish), PATIENCE).await.unwrap();

    let started = Instant::now();

    adapter.stop().await;
    assert!(
        started.elapsed() >= Duration::from_millis(900),
        "its connect timeout waited"
    );

    for each in unanswered {
        assert_eq!(
            message_of(&each.await.unwrap().unwrap_err()),
            "the link of ada stopped",
            "each failed"
        );
    }

    assert_eq!(
        silent.next(Some(Kind::Disconnect), PATIENCE).await.unwrap(),
        Scripted::Disconnect { reason: 0 },
        "its DISCONNECT, no will"
    );
    assert_eq!(sent_of(&silent).len(), 1, "the second never sent");
    assert_eq!(heard.downs(), Vec::new(), "no loss told");
}

// spec 15.24, 15.26
#[tokio::test]
async fn lets_go_at_its_stop_of_each_subscription_its_link_holds_once_what_it_was_handed_went_one_unsubscribe_per_filter_sent_at_once_and_their_unsubacks_of_0x00_or_0x11_awaited_together_then_sends_its_disconnect_of_0x00()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let heard = heard_of(&adapter);
    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;

    // * its inbox, a name of its group and a peer's departure
    for (each, grouped) in [
        (inbox(), None),
        (name(), Some("interop")),
        (topic(&["bead", "d", "bob"]), None),
    ] {
        let subscription = grouped.map_or_else(BrokerSubscription::default, group);
        let subscribing = spawn(adapter.subscribe(&each, subscription));

        suback_of(&link, 1).await;
        subscribing.await.unwrap().unwrap();
    }

    let publishing = spawn(adapter.publish(publication(topic(&["bead", "i", "bob"]), &[1])));
    let sent = link.next(Some(Kind::Publish), PATIENCE).await.unwrap();
    let stopping = spawn(adapter.stop());

    rest(Duration::from_millis(100)).await;
    assert!(
        link.of(Kind::Unsubscribe).is_empty(),
        "none while what it was handed awaits its PUBACK"
    );
    link.send(puback(sent.identifier(), 0));
    assert_eq!(
        publishing.await.unwrap().unwrap(),
        BrokerPublished::Taken,
        "taken"
    );

    // * each read before any UNSUBACK is sent: all of them at once
    let mut unsubscribes = Vec::new();

    for _ in 0..3 {
        unsubscribes.push(link.next(Some(Kind::Unsubscribe), PATIENCE).await.unwrap());
    }

    assert_eq!(
        unsubscribes
            .iter()
            .map(Scripted::filters)
            .collect::<Vec<_>>(),
        vec![
            vec!["bead/i/ada".to_owned()],
            vec!["$share/interop/bead/s/interop".to_owned()],
            vec!["bead/d/bob".to_owned()],
        ],
        "one filter each"
    );

    // * 0x11, none held, lets one go as 0x00 does
    for (index, unsubscribe) in unsubscribes.iter().enumerate() {
        rest(Duration::from_millis(50)).await;
        assert!(
            link.of(Kind::Disconnect).is_empty(),
            "its DISCONNECT once every UNSUBACK came"
        );
        link.send(unsuback(
            unsubscribe.identifier(),
            if index == 1 { 0x11 } else { 0x00 },
        ));
    }

    stopping.await.unwrap();
    assert_eq!(
        link.next(Some(Kind::Disconnect), PATIENCE).await.unwrap(),
        Scripted::Disconnect { reason: 0 },
        "its DISCONNECT"
    );
    assert_eq!(
        kinds_of(&link),
        vec![
            Kind::Connect,
            Kind::Subscribe,
            Kind::Subscribe,
            Kind::Subscribe,
            Kind::Publish,
            Kind::Unsubscribe,
            Kind::Unsubscribe,
            Kind::Unsubscribe,
            Kind::Disconnect,
        ],
        "its packets"
    );
    assert_eq!(heard.downs(), Vec::new(), "no loss told");
}

// spec 15.26, 15.30
#[tokio::test]
async fn sends_its_stops_disconnect_of_0x00_all_the_same_where_an_unsuback_refuses_or_none_comes_what_it_was_handed_and_its_unsubacks_awaited_within_one_connect_timeout_of_its_call()
 {
    let script = script().await;
    let mut options = options_of(&script);

    options.connect_timeout = Some(Duration::from_secs(1));

    let adapter = adapter_of(&options);
    let heard = heard_of(&adapter);
    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;

    for each in [inbox(), topic(&["bead", "d", "bob"])] {
        let subscribing = spawn(adapter.subscribe(&each, BrokerSubscription::default()));

        suback_of(&link, 1).await;
        subscribing.await.unwrap().unwrap();
    }

    let publishing = spawn(adapter.publish(publication(topic(&["bead", "i", "bob"]), &[1])));
    let sent = link.next(Some(Kind::Publish), PATIENCE).await.unwrap();
    let started = Instant::now();
    let stopping = spawn(adapter.stop());

    // * most of its connect timeout spent on what it was handed
    rest(Duration::from_millis(700)).await;
    link.send(puback(sent.identifier(), 0));
    assert_eq!(
        publishing.await.unwrap().unwrap(),
        BrokerPublished::Taken,
        "taken"
    );

    let refused = link.next(Some(Kind::Unsubscribe), PATIENCE).await.unwrap();

    link.next(Some(Kind::Unsubscribe), PATIENCE).await.unwrap();
    // the second's UNSUBACK withheld
    link.send(unsuback(refused.identifier(), 0x80));
    stopping.await.unwrap();

    let waited = started.elapsed();

    assert!(
        waited >= Duration::from_millis(950),
        "its connect timeout waited: {waited:?}"
    );
    assert!(
        waited < Duration::from_millis(1_500),
        "one connect timeout from its call, not one after its drain: {waited:?}"
    );
    assert_eq!(
        link.next(Some(Kind::Disconnect), PATIENCE).await.unwrap(),
        Scripted::Disconnect { reason: 0 },
        "its DISCONNECT, no will"
    );
    assert_eq!(heard.downs(), Vec::new(), "no loss told");
}

// spec 15.26, 15.27
#[tokio::test]
async fn lets_each_filter_go_at_its_stop_in_an_unsubscribe_of_its_own_none_past_its_connacks_maximum_packet_size()
 {
    let maximum_packet_size = 64;
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let link = link_up(
        (&adapter, &script),
        (
            &Connack {
                maximum_packet_size: Some(maximum_packet_size),
                ..Connack::default()
            },
            None,
        ),
    )
    .await;
    let padding = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    let departures: Vec<Vec<String>> = ["amy", "bea", "cyd", "dot", "eve"]
        .iter()
        .map(|peer| topic(&["bead", "d", &format!("{peer}-{padding}")]))
        .collect();

    for each in &departures {
        let subscribing = spawn(adapter.subscribe(each, BrokerSubscription::default()));

        suback_of(&link, 1).await;
        subscribing.await.unwrap().unwrap();
    }

    let filters = unsubacked_of(&link, adapter.stop()).await;
    let unsubscribes = link.of(Kind::Unsubscribe);

    assert_eq!(
        filters,
        departures
            .iter()
            .map(|each| each.join("/"))
            .collect::<Vec<_>>(),
        "each let go"
    );
    assert_eq!(
        unsubscribes
            .iter()
            .map(|each| each.filters().len())
            .collect::<Vec<_>>(),
        vec![1, 1, 1, 1, 1],
        "one filter each"
    );

    for unsubscribe in &unsubscribes {
        assert!(
            unsubscribe_bytes(unsubscribe.identifier(), &unsubscribe.filters())
                <= usize::try_from(maximum_packet_size).unwrap(),
            "within its bound"
        );
    }

    // * one packet of them all would pass it, which its broker ends the link for, its will sent
    assert!(
        unsubscribe_bytes(1, &filters) > usize::try_from(maximum_packet_size).unwrap(),
        "one of them all past it"
    );
}

// spec 15.27
#[tokio::test]
async fn lets_go_at_its_stop_of_a_filter_whose_subscribe_went_with_no_suback_yet_its_subscription_failed()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;
    let subscribing = spawn(adapter.subscribe(&name(), group("interop")));
    let subscribe = link.next(Some(Kind::Subscribe), PATIENCE).await.unwrap();
    let stopping = spawn(adapter.stop());
    let unsubscribe = link.next(Some(Kind::Unsubscribe), PATIENCE).await.unwrap();

    assert_eq!(
        unsubscribe.filters(),
        vec!["$share/interop/bead/s/interop".to_owned()],
        "let go"
    );
    // * its SUBACK, come behind, holds nothing: its broker read the UNSUBSCRIBE after it
    link.send(suback(subscribe.identifier(), 1));
    link.send(unsuback(unsubscribe.identifier(), 0));
    stopping.await.unwrap();
    assert_eq!(
        message_of(&subscribing.await.unwrap().unwrap_err()),
        "the link of ada stopped",
        "failed"
    );
    assert_eq!(
        link.next(Some(Kind::Disconnect), PATIENCE).await.unwrap(),
        Scripted::Disconnect { reason: 0 },
        "its DISCONNECT"
    );
}

// spec 15.27
#[tokio::test]
async fn keeps_a_subscription_asked_again_while_its_unsubscribe_awaits_its_unsuback_which_its_stop_then_lets_go()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;
    let subscribing = spawn(adapter.subscribe(&name(), group("interop")));

    suback_of(&link, 1).await;
    subscribing.await.unwrap().unwrap();

    // * let go, then asked again before that UNSUBACK came
    let leaving = spawn(adapter.unsubscribe(&name()));
    let unsubscribe = link.next(Some(Kind::Unsubscribe), PATIENCE).await.unwrap();
    let again = spawn(adapter.subscribe(&name(), group("interop")));
    let subscribe = link.next(Some(Kind::Subscribe), PATIENCE).await.unwrap();

    link.send(unsuback(unsubscribe.identifier(), 0));
    link.send(suback(subscribe.identifier(), 1));
    leaving.await.unwrap().unwrap();
    again.await.unwrap().unwrap();
    assert_eq!(
        unsubacked_of(&link, adapter.stop()).await,
        vec!["$share/interop/bead/s/interop".to_owned()],
        "the second let go"
    );
}

// spec 15.26, 15.28
#[tokio::test]
async fn sends_no_unsubscribe_at_its_stop_ahead_of_a_publication_that_waits_on_its_brokers_receive_maximum()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let link = link_up(
        (&adapter, &script),
        (
            &Connack {
                receive_maximum: Some(2),
                ..Connack::default()
            },
            None,
        ),
    )
    .await;
    let subscribing = spawn(adapter.subscribe(&inbox(), BrokerSubscription::default()));

    suback_of(&link, 1).await;
    subscribing.await.unwrap().unwrap();

    // * a peer's CLOSE each, as a participant's stop hands them on
    let publishing: Vec<_> = (1..=4_u8)
        .map(|index| spawn(adapter.publish(publication(topic(&["bead", "i", "bob"]), &[index]))))
        .collect();

    until(|| sent_of(&link).len() == 2).await;

    let stopping = spawn(adapter.stop());

    for index in 0..4 {
        until(|| sent_of(&link).len() == (index + 2).min(4)).await;
        rest(Duration::from_millis(20)).await;
        assert!(
            link.of(Kind::Unsubscribe).is_empty(),
            "none while one waits"
        );
        link.send(puback(sent_of(&link)[index].identifier(), 0));
    }

    assert_eq!(
        unsubacked_of(&link, Box::pin(async move { stopping.await.unwrap() })).await,
        vec!["bead/i/ada".to_owned()],
        "its inbox let go"
    );

    for each in publishing {
        assert_eq!(
            each.await.unwrap().unwrap(),
            BrokerPublished::Taken,
            "taken"
        );
    }

    link.next(Some(Kind::Disconnect), PATIENCE).await.unwrap();
    assert_eq!(
        kinds_of(&link),
        vec![
            Kind::Connect,
            Kind::Subscribe,
            Kind::Publish,
            Kind::Publish,
            Kind::Publish,
            Kind::Publish,
            Kind::Unsubscribe,
            Kind::Disconnect,
        ],
        "its packets"
    );
}

// spec 15.28
#[tokio::test]
async fn reads_a_puback_of_0x10_as_no_subscriber_under_0x80_as_taken_and_0x80_or_more_as_refused() {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;
    let answered = async |code: u8| -> Result<BrokerPublished, BrokerError> {
        let publishing = spawn(adapter.publish(publication(name(), &[1])));
        let sent = link.next(Some(Kind::Publish), PATIENCE).await.unwrap();

        link.send(puback(sent.identifier(), code));

        publishing.await.unwrap()
    };

    assert_eq!(
        answered(0x10).await.unwrap(),
        BrokerPublished::NoSubscriber,
        "0x10"
    );
    assert_eq!(
        answered(0x00).await.unwrap(),
        BrokerPublished::Taken,
        "0x00"
    );
    assert!(
        message_of(&answered(0x87).await.unwrap_err()).contains("0x87"),
        "0x87"
    );
    assert!(
        message_of(&answered(0x80).await.unwrap_err()).contains("0x80"),
        "0x80"
    );
    assert!(
        adapter
            .capabilities()
            .contains(BrokerCapabilities::NO_SUBSCRIBER),
        "it offers no subscriber"
    );
    adapter.stop().await;
}

// spec 15.28
#[tokio::test]
async fn refuses_a_publication_past_its_connacks_maximum_packet_size_before_it_goes() {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let link = link_up(
        (&adapter, &script),
        (
            &Connack {
                maximum_packet_size: Some(1_024),
                ..Connack::default()
            },
            None,
        ),
    )
    .await;
    let room = adapter.maximum_payload_bytes(&inbox());

    // its bound counts a life, whatever the publication
    assert_eq!(
        Some(room),
        largest_payload("bead/i/ada", 1_024, &MqttPublishShapeOptions::default()),
        "a life counted"
    );

    let mut fits = BrokerPublication::new(
        inbox(),
        Bytes::from(vec![0; usize::try_from(room).unwrap()]),
    );

    fits.expires_after = Some(Duration::from_secs(1));

    let fitting = spawn(adapter.publish(fits));
    let sent = link.next(Some(Kind::Publish), PATIENCE).await.unwrap();

    link.send(puback(sent.identifier(), 0));
    assert_eq!(
        fitting.await.unwrap().unwrap(),
        BrokerPublished::Taken,
        "taken"
    );

    let mut past = BrokerPublication::new(
        inbox(),
        Bytes::from(vec![0; usize::try_from(room).unwrap().saturating_add(1)]),
    );

    past.expires_after = Some(Duration::from_secs(1));

    let refused = adapter.publish(past).await.unwrap_err();

    assert!(
        message_of(&refused).contains("past its broker's Maximum Packet Size, 1024 bytes"),
        "{refused}"
    );
    rest(Duration::from_millis(50)).await;
    assert_eq!(sent_of(&link).len(), 1, "never sent");
    adapter.stop().await;
}

// spec 15.28
#[tokio::test]
async fn reports_no_payload_room_where_its_connacks_maximum_packet_size_cannot_hold_a_publish_to_the_topic_and_refuses_even_an_empty_publication()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let link = link_up(
        (&adapter, &script),
        (
            &Connack {
                maximum_packet_size: Some(16),
                ..Connack::default()
            },
            None,
        ),
    )
    .await;

    assert_eq!(adapter.maximum_payload_bytes(&inbox()), 0, "no room");

    let refused = adapter
        .publish(BrokerPublication::new(inbox(), Bytes::new()))
        .await
        .unwrap_err();

    assert!(
        message_of(&refused).contains("past its broker's Maximum Packet Size, 16 bytes"),
        "{refused}"
    );
    assert!(adapter.is_linked(), "its link kept");
    rest(Duration::from_millis(50)).await;
    assert!(sent_of(&link).is_empty(), "never sent");
    adapter.stop().await;
}

// spec 15.30
#[tokio::test]
async fn tells_its_link_up_once_its_connack_came_and_bounds_what_it_publishes_by_that_connacks_maximum_packet_size_the_last_links_while_it_is_down()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let read = || (adapter.is_linked(), adapter.maximum_payload_bytes(&inbox()));
    let bound_of = |size: u32| {
        largest_payload(
            "bead/i/ada",
            u64::from(size),
            &MqttPublishShapeOptions::default(),
        )
        .unwrap()
    };

    // * before any link, what MQTT 5 writes at most
    assert_eq!(
        read(),
        (false, bound_of(LARGEST_PACKET_SIZE)),
        "before any link"
    );

    let first = link_up(
        (&adapter, &script),
        (
            &Connack {
                maximum_packet_size: Some(1_024),
                ..Connack::default()
            },
            None,
        ),
    )
    .await;

    assert_eq!(read(), (true, bound_of(1_024)), "its CONNACK's");
    first.cut();
    until(|| !adapter.is_linked()).await;

    // the last link's while it is down, and while the next one starts
    assert_eq!(read(), (false, bound_of(1_024)), "the last link's");

    let starting = adapter.start(BrokerStart::default());
    let second = script.link(PATIENCE).await.unwrap();

    assert_eq!(read(), (false, bound_of(1_024)), "as it starts");
    second.send(connack(&Connack::default()));
    starting.await.unwrap();
    assert_eq!(
        read(),
        (true, bound_of(LARGEST_PACKET_SIZE)),
        "its next CONNACK's"
    );
    adapter.stop().await;
    assert_eq!(
        read(),
        (false, bound_of(LARGEST_PACKET_SIZE)),
        "once stopped"
    );
}

// ── What it is handed ────────────────────────────────────────────────────────────────────────

// spec 15.29
#[tokio::test]
async fn hands_each_message_on_before_its_puback_which_goes_once_it_is_settled_and_once() {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let heard = heard_of(&adapter);
    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;

    link.send(publish(&Publish {
        topic: "bead/i/ada".to_owned(),
        identifier: Some(7),
        payload: vec![9],
        ..Publish::default()
    }));
    until(|| !heard.messages().is_empty()).await;

    let messages = heard.messages();

    assert_eq!(messages.len(), 1, "one");
    assert_eq!(messages[0].payload().as_ref(), [9], "its payload");
    assert_eq!(messages[0].topic(), inbox().as_slice(), "its topic");
    assert_eq!(adapter.unsettled(), 1, "unsettled");
    rest(Duration::from_millis(50)).await;
    assert!(link.of(Kind::Puback).is_empty(), "no PUBACK yet");

    messages[0].settle();
    messages[0].settle();

    assert_eq!(
        link.next(Some(Kind::Puback), PATIENCE).await.unwrap(),
        Scripted::Puback {
            identifier: 7,
            reason: 0,
        },
        "its PUBACK of 0x00"
    );
    until(|| adapter.unsettled() == 0).await;
    assert_eq!(adapter.unsettled(), 0, "settled");
    rest(Duration::from_millis(50)).await;
    assert_eq!(link.of(Kind::Puback).len(), 1, "once");
    assert_eq!(heard.messages().len(), 1, "handed on once");

    // * one of QoS 0, which no PUBACK answers, handed on with nothing to acknowledge
    link.send(publish(&Publish {
        topic: "bead/i/ada".to_owned(),
        payload: vec![8],
        ..Publish::default()
    }));
    until(|| heard.messages().len() > 1).await;
    heard.messages()[1].settle();
    assert_eq!(heard.messages()[1].payload().as_ref(), [8], "its payload");
    assert_eq!(adapter.unsettled(), 0, "nothing to acknowledge");
    adapter.stop().await;
}

// spec 15.29
#[tokio::test]
async fn drops_a_message_whose_retain_is_1_acknowledging_it() {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let unsettled = adapter.clone();
    let options = BrokerParticipantOptions {
        heartbeat: Some(NEVER),
        ..BrokerParticipantOptions::default()
    };

    let participant = BrokerParticipant::new(Arc::new(adapter), &options).unwrap();
    let errors = Arc::new(Mutex::new(Vec::new()));
    let told = Arc::clone(&errors);

    participant.on_error(Arc::new(move |error| {
        told.lock().unwrap().push(error.to_string());
    }));

    let starting = spawn(participant.start());
    let link = script.link(PATIENCE).await.unwrap();

    link.send(connack(&Connack::default()));
    suback_of(&link, 1).await;
    starting.await.unwrap().unwrap();
    link.send(publish(&Publish {
        topic: "bead/i/ada".to_owned(),
        identifier: Some(3),
        retain: true,
        payload: vec![0xFF],
    }));
    assert_eq!(
        link.next(Some(Kind::Puback), PATIENCE).await.unwrap(),
        Scripted::Puback {
            identifier: 3,
            reason: 0,
        },
        "acknowledged"
    );
    assert_eq!(unsettled.unsettled(), 0, "settled");
    assert_eq!(*errors.lock().unwrap(), Vec::<String>::new(), "no error");
    assert_eq!(
        unsubacked_of(&link, participant.stop()).await,
        vec!["bead/i/ada".to_owned()],
        "let go"
    );
}

// spec 15.29
#[tokio::test]
async fn closes_its_link_no_disconnect_on_a_packet_past_its_own_maximum_packet_size_read_at_its_length()
 {
    let script = script().await;
    let mut options = options_of(&script);

    options.maximum_packet_size = Some(1_100);

    let adapter = adapter_of(&options);
    let heard = heard_of(&adapter);

    // a PUBLISH of 1,118 bytes in all, after its CONNACK
    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;

    link.send(publish(&Publish {
        topic: "bead/i/ada".to_owned(),
        identifier: Some(1),
        payload: vec![0; 1_100],
        ..Publish::default()
    }));
    assert!(link.closed(PATIENCE).await, "closed");
    until(|| !heard.downs().is_empty()).await;
    assert_eq!(heard.downs(), vec![down(false)], "lost");

    // a fixed header alone, announcing 16,777,221 bytes, after the CONNACK of a second link
    let second = link_up((&adapter, &script), (&Connack::default(), None)).await;

    second.send(vec![0x32, 0x80, 0x80, 0x80, 0x08]);
    assert!(second.closed(PATIENCE).await, "closed at its length");
    until(|| heard.downs().len() > 1).await;
    assert_eq!(heard.downs(), vec![down(false), down(false)], "lost too");

    // a CONNACK's fixed header alone, announcing 16,777,221 bytes: its start fails
    let starting = adapter.start(BrokerStart::default());
    let third = script.link(PATIENCE).await.unwrap();

    third.send(vec![0x20, 0x80, 0x80, 0x80, 0x08]);

    let failed = starting.await.unwrap_err();

    assert!(
        message_of(&failed).contains("past its Maximum Packet Size"),
        "{failed}"
    );
    assert!(third.closed(PATIENCE).await, "closed before its CONNACK");
    assert_eq!(
        heard.downs(),
        vec![down(false), down(false)],
        "no down for a start"
    );
    assert!(heard.messages().is_empty(), "nothing handed on");

    for each in [&link, &second, &third] {
        assert!(
            each.of(Kind::Disconnect).is_empty() && each.of(Kind::Puback).is_empty(),
            "no DISCONNECT, no PUBACK"
        );
    }
}

// spec 15.29
#[tokio::test]
async fn loses_its_link_once_on_a_packet_past_its_maximum_packet_size_beside_its_connack_in_one_read()
 {
    let script = script().await;
    let mut options = options_of(&script);

    options.maximum_packet_size = Some(1_100);

    let adapter = adapter_of(&options);
    let heard = heard_of(&adapter);
    let starting = adapter.start(BrokerStart::default());
    let link = script.link(PATIENCE).await.unwrap();
    let mut bytes = connack(&Connack::default());

    bytes.extend_from_slice(&[0x32, 0x80, 0x80, 0x80, 0x08]);
    link.send(bytes);
    assert!(
        link.closed(PATIENCE).await,
        "closed at its length, no body sent"
    );
    let outcome = crate::testing::patience(PATIENCE, starting).await.unwrap();

    assert!(
        outcome.is_ok(),
        "its CONNACK accepts its start: {outcome:?}"
    );
    assert_eq!(heard.downs(), vec![down(false)], "lost once");
    assert!(heard.messages().is_empty(), "nothing handed on");
    assert!(!adapter.is_linked(), "down");
    assert_eq!(
        link.kinds(),
        vec![Kind::Connect],
        "no DISCONNECT, no PUBACK"
    );
    adapter.stop().await;
    script.dispose();
}

// spec 15.29
#[tokio::test]
async fn loses_its_link_once_on_a_packet_past_its_maximum_packet_size_after_its_connack_before_its_caller_resumes()
 {
    let script = script().await;
    let mut options = options_of(&script);

    options.maximum_packet_size = Some(1_100);

    let adapter = adapter_of(&options);
    let heard = heard_of(&adapter);
    let starting = adapter.start(BrokerStart::default());
    let link = script.link(PATIENCE).await.unwrap();

    // * the owner accepts its CONNACK and marks its link up in one turn; the caller leaves its
    // start future unpolled until the later header loses the link
    link.send(connack(&Connack {
        maximum_packet_size: Some(1_024),
        ..Connack::default()
    }));
    until(|| adapter.is_linked()).await;
    assert!(
        adapter.is_linked(),
        "its CONNACK is accepted before the header"
    );
    link.send(vec![0x32, 0x80, 0x80, 0x80, 0x08]);
    assert!(
        link.closed(PATIENCE).await,
        "closed at its length, no body sent"
    );
    let outcome = crate::testing::patience(PATIENCE, starting).await.unwrap();

    assert!(
        outcome.is_ok(),
        "its accepted start keeps its outcome: {outcome:?}"
    );
    assert_eq!(heard.downs(), vec![down(false)], "lost once");
    assert!(heard.messages().is_empty(), "nothing handed on");
    assert!(!adapter.is_linked(), "down");
    assert_eq!(
        adapter.maximum_payload_bytes(&inbox()),
        largest_payload("bead/i/ada", 1_024, &MqttPublishShapeOptions::default()).unwrap(),
        "its CONNACK's bound, the last link's"
    );
    assert_eq!(
        link.kinds(),
        vec![Kind::Connect],
        "no DISCONNECT, no PUBACK"
    );
    adapter.stop().await;
    script.dispose();
}

// spec 15.26
#[tokio::test]
async fn loses_its_link_once_as_its_network_connection_ends_after_its_connack_before_its_caller_resumes()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let heard = heard_of(&adapter);
    let starting = adapter.start(BrokerStart::default());
    let link = script.link(PATIENCE).await.unwrap();

    // * the owner accepts its CONNACK and marks its link up in one turn; the caller leaves its
    // start future unpolled until the end of its network connection loses the link
    link.send(connack(&Connack::default()));
    until(|| adapter.is_linked()).await;
    assert!(
        adapter.is_linked(),
        "its CONNACK is accepted before the end"
    );
    link.end();
    until(|| !heard.downs().is_empty()).await;
    let outcome = crate::testing::patience(PATIENCE, starting).await.unwrap();

    assert!(
        outcome.is_ok(),
        "its accepted start keeps its outcome: {outcome:?}"
    );
    assert_eq!(heard.downs(), vec![down(false)], "lost once");
    assert!(heard.messages().is_empty(), "nothing handed on");
    assert!(!adapter.is_linked(), "down");
    assert_eq!(link.kinds(), vec![Kind::Connect], "no DISCONNECT");
    adapter.stop().await;
    script.dispose();
}

// spec 15.26, 15.29
#[tokio::test]
async fn fails_its_start_on_a_connack_that_refuses_or_says_maximum_qos_0_beside_a_packet_past_its_maximum_packet_size_in_one_read_naming_the_connack()
 {
    let script = script().await;
    let mut options = options_of(&script);

    options.maximum_packet_size = Some(1_100);

    let answers = [
        (
            Connack {
                reason_code: 0x86,
                ..Connack::default()
            },
            "0x86",
        ),
        (
            Connack {
                reason_code: 0x01,
                ..Connack::default()
            },
            "0x01",
        ),
        (
            Connack {
                maximum_qos: Some(0),
                ..Connack::default()
            },
            "Maximum QoS 0",
        ),
    ];

    for (answer, named) in answers {
        let adapter = adapter_of(&options);
        let heard = heard_of(&adapter);
        let starting = adapter.start(BrokerStart::default());
        let link = script.link(PATIENCE).await.unwrap();
        let mut bytes = connack(&answer);

        bytes.extend_from_slice(&[0x32, 0x80, 0x80, 0x80, 0x08]);
        link.send(bytes);

        let failed = crate::testing::patience(PATIENCE, starting)
            .await
            .unwrap()
            .unwrap_err();
        let message = message_of(&failed);

        assert!(message.contains(named), "{message}");
        assert!(
            !message.contains("past its Maximum Packet Size"),
            "its CONNACK names it, not the header: {message}"
        );
        assert!(link.closed(PATIENCE).await, "closed");
        assert_eq!(heard.downs(), Vec::new(), "no down");
        assert!(!adapter.is_linked(), "never up");
        assert_eq!(link.kinds(), vec![Kind::Connect], "no DISCONNECT");
        adapter.stop().await;
    }

    script.dispose();
}

// spec 15.26
#[tokio::test]
async fn stops_its_link_with_a_disconnect_of_0x00_after_its_connack_before_its_caller_resumes_its_start_succeeding_and_no_down_told()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let heard = heard_of(&adapter);
    let starting = adapter.start(BrokerStart::default());
    let link = script.link(PATIENCE).await.unwrap();

    // * the owner accepts its CONNACK and marks its link up in one turn; the caller stops it
    // before it polls its start future
    link.send(connack(&Connack::default()));
    until(|| adapter.is_linked()).await;
    assert!(
        adapter.is_linked(),
        "its CONNACK is accepted before the stop"
    );
    crate::testing::patience(PATIENCE, adapter.stop())
        .await
        .unwrap();
    let outcome = crate::testing::patience(PATIENCE, starting).await.unwrap();

    assert!(
        outcome.is_ok(),
        "its accepted start keeps its outcome: {outcome:?}"
    );
    assert_eq!(
        link.next(Some(Kind::Disconnect), PATIENCE).await.unwrap(),
        Scripted::Disconnect { reason: 0 },
        "a DISCONNECT of 0x00"
    );
    assert!(link.closed(PATIENCE).await, "closed");
    assert_eq!(
        link.kinds(),
        vec![Kind::Connect, Kind::Disconnect],
        "nothing else"
    );
    assert_eq!(heard.downs(), Vec::new(), "no down");
    script.dispose();
}

/// A listener whose first down starts its adapter again, keeping the future that start gives.
#[derive(Default)]
struct Restarting {
    adapter: Mutex<Option<MqttBrokerAdapter>>,
    downs: Mutex<Vec<BrokerDown>>,
    restarts: Mutex<Vec<BoxFuture<Result<(), BrokerError>>>>,
}

impl BrokerListener for Restarting {
    fn on_message(&self, _message: &BrokerMessage) {}

    fn on_down(&self, down: BrokerDown) {
        self.downs.lock().unwrap().push(down);

        let adapter = self.adapter.lock().unwrap().take();

        // * an operation takes effect as it is made: its future is kept, never polled here
        if let Some(adapter) = adapter {
            self.restarts
                .lock()
                .unwrap()
                .push(adapter.start(BrokerStart::default()));
        }
    }
}

// spec 15.26
#[tokio::test]
async fn takes_a_start_from_its_downs_listener_once_its_link_is_lost_beside_its_connack() {
    let script = script().await;
    let mut options = options_of(&script);

    options.maximum_packet_size = Some(1_100);

    let adapter = adapter_of(&options);
    let restarting = Arc::new(Restarting {
        adapter: Mutex::new(Some(adapter.clone())),
        ..Restarting::default()
    });

    adapter.listen(Arc::<Restarting>::clone(&restarting));

    let starting = adapter.start(BrokerStart::default());
    let link = script.link(PATIENCE).await.unwrap();
    let mut bytes = connack(&Connack::default());

    bytes.extend_from_slice(&[0x32, 0x80, 0x80, 0x80, 0x08]);
    link.send(bytes);
    assert!(link.closed(PATIENCE).await, "closed at its length");
    let outcome = crate::testing::patience(PATIENCE, starting).await.unwrap();

    assert!(
        outcome.is_ok(),
        "its CONNACK accepts its start: {outcome:?}"
    );
    assert_eq!(
        restarting.downs.lock().unwrap().clone(),
        vec![down(false)],
        "lost once"
    );

    // * the start its down's listener made was taken, not refused as up already: a second link
    // comes once its CONNECT is read
    let second = script.link(PATIENCE).await;

    assert!(
        second.is_ok_and(|link| link.connect().client_identifier == ID),
        "a CONNECT on a second link"
    );
    assert_eq!(restarting.restarts.lock().unwrap().len(), 1, "one restart");
    adapter.stop().await;
    restarting.restarts.lock().unwrap().clear();
    script.dispose();
}

// spec 15.21, 15.26
#[tokio::test]
async fn tells_its_link_taken_over_its_start_succeeding_on_a_disconnect_of_0x8e_beside_its_connack_in_one_read()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let heard = heard_of(&adapter);
    let starting = adapter.start(BrokerStart::default());
    let link = script.link(PATIENCE).await.unwrap();
    let mut bytes = connack(&Connack::default());

    bytes.extend_from_slice(&disconnect(0x8E));
    link.send(bytes);
    link.end();
    until(|| !heard.downs().is_empty()).await;
    let outcome = crate::testing::patience(PATIENCE, starting).await.unwrap();

    assert!(
        outcome.is_ok(),
        "its CONNACK accepts its start: {outcome:?}"
    );
    assert_eq!(heard.downs(), vec![down(true)], "taken over");
    assert!(heard.messages().is_empty(), "nothing handed on");
    assert!(!adapter.is_linked(), "down");
    assert_eq!(link.kinds(), vec![Kind::Connect], "no DISCONNECT");
    adapter.stop().await;
    script.dispose();
}

// spec 15.30
#[tokio::test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test repeats its own string a bounded number of times"
)]
async fn announces_as_its_receive_bound_the_largest_payload_of_a_message_to_its_inbox_within_its_maximum_packet_size_a_life_counted()
 {
    let script = script().await;

    assert_eq!(
        adapter_of(&options_of(&script)).receive_bound(&topic(&["bead", "i", "server"])),
        16_777_188,
        "by default"
    );

    let mut options = options_of(&script);

    options.maximum_packet_size = Some(4_096);

    assert_eq!(
        adapter_of(&options).receive_bound(&topic(&["bead", "i", "peer"])),
        4_072,
        "its own"
    );
    // * a topic whose PUBLISH alone passes the bound leaves no payload any room
    assert_eq!(
        adapter_of(&options).receive_bound(&topic(&["bead", "i", &"p".repeat(4_096)])),
        0,
        "no room"
    );
    assert_eq!(MAXIMUM_PACKET_SIZE, 16_777_216, "16 MiB");

    // a bound whose receive bound is under 1,024 is refused as its participant is built, and one
    // past what MQTT 5 writes as the adapter is
    options.maximum_packet_size = Some(1_000);

    let refused = BrokerParticipant::new(
        Arc::new(adapter_of(&options)),
        &BrokerParticipantOptions::default(),
    )
    .unwrap_err();

    assert!(
        refused
            .message()
            .contains("a participant's inbox takes a parcel of 1,024 bytes at least"),
        "{refused}"
    );

    options.maximum_packet_size = Some(268_435_461);

    assert!(
        MqttBrokerAdapter::new(&options).is_err(),
        "past what MQTT 5 writes"
    );
}

// spec 15.26
#[tokio::test]
async fn tells_its_link_lost_once_and_nothing_of_a_lost_link_reaches_the_next_no_message_no_acknowledgement_no_pubacks_reason_no_quota()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let heard = heard_of(&adapter);
    let one = Connack {
        receive_maximum: Some(1),
        ..Connack::default()
    };
    let first = link_up((&adapter, &script), (&one, None)).await;

    first.send(publish(&Publish {
        topic: "bead/i/ada".to_owned(),
        identifier: Some(5),
        payload: vec![1],
        ..Publish::default()
    }));
    until(|| !heard.messages().is_empty()).await;

    let pending = spawn(adapter.publish(publication(inbox(), &[1])));
    let waiting = spawn(adapter.publish(publication(inbox(), &[2])));
    let sent = first.next(Some(Kind::Publish), PATIENCE).await.unwrap();

    first.cut();
    assert!(pending.await.unwrap().is_err(), "the one sent failed");
    assert!(waiting.await.unwrap().is_err(), "the one waiting failed");
    until(|| !heard.downs().is_empty()).await;
    rest(Duration::from_millis(50)).await;
    assert_eq!(heard.downs(), vec![down(false)], "lost");

    // * the next link's quota is its own, and the former's message is acknowledged on none
    let second = link_up((&adapter, &script), (&one, None)).await;

    heard.messages()[0].settle();
    assert_eq!(adapter.unsettled(), 0, "none unsettled");
    // a PUBACK of the former's packet identifier taken as no reason of the next
    second.send(puback(sent.identifier(), 0x10));

    let next = spawn(adapter.publish(publication(inbox(), &[3])));
    let published = second.next(Some(Kind::Publish), PATIENCE).await.unwrap();

    second.send(puback(published.identifier(), 0));
    assert_eq!(
        next.await.unwrap().unwrap(),
        BrokerPublished::Taken,
        "taken"
    );
    rest(Duration::from_millis(50)).await;
    assert!(
        second.of(Kind::Puback).is_empty(),
        "no PUBACK of the former's"
    );
    assert_eq!(heard.downs().len(), 1, "told once");

    // a listener let go hears no loss after
    let later = Arc::new(Heard::default());
    let listener: Arc<dyn BrokerListener> = Arc::<Heard>::clone(&later);

    adapter.listen(Arc::clone(&listener));
    adapter.unlisten(&listener);
    second.cut();
    until(|| heard.downs().len() > 1).await;
    assert!(later.downs().is_empty(), "let go");
}

// spec 15.26
#[tokio::test]
async fn refuses_what_is_asked_while_its_link_is_down_and_leaves_no_library_to_reconnect_subscribe_again_or_hold_a_publication()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let heard = heard_of(&adapter);
    let not_up = "the link of ada is not up";

    assert_eq!(
        message_of(
            &adapter
                .publish(publication(inbox(), &[1]))
                .await
                .unwrap_err()
        ),
        not_up,
        "no publication"
    );
    assert_eq!(
        message_of(
            &adapter
                .subscribe(&inbox(), BrokerSubscription::default())
                .await
                .unwrap_err()
        ),
        not_up,
        "no subscription"
    );
    assert_eq!(
        message_of(&adapter.unsubscribe(&inbox()).await.unwrap_err()),
        not_up,
        "no unsubscription"
    );

    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;
    let subscribing = spawn(adapter.subscribe(&inbox(), BrokerSubscription::default()));

    // one link at a time: a start of a link up is refused
    assert_eq!(
        message_of(&adapter.start(BrokerStart::default()).await.unwrap_err()),
        "the link of ada is up already",
        "one link at a time"
    );
    suback_of(&link, 1).await;
    subscribing.await.unwrap().unwrap();
    link.cut();
    until(|| !heard.downs().is_empty()).await;
    assert_eq!(
        message_of(
            &adapter
                .publish(publication(inbox(), &[1]))
                .await
                .unwrap_err()
        ),
        not_up,
        "none once lost"
    );

    // no link comes of its own, and the next one subscribes nothing nor sends what was refused
    assert!(
        script.link(Duration::from_millis(1_500)).await.is_err(),
        "no link came"
    );

    let next = link_up((&adapter, &script), (&Connack::default(), None)).await;

    rest(Duration::from_millis(100)).await;
    assert_eq!(
        kinds_of(&next),
        vec![Kind::Connect],
        "nothing but its CONNECT"
    );
    adapter.stop().await;
}

fn signalled(publication: BrokerPublication, signal: &CancellationToken) -> BrokerPublication {
    let mut publication = publication;

    publication.signal = Some(signal.clone());

    publication
}

fn cancelled() -> CancellationToken {
    let signal = CancellationToken::new();

    signal.cancel();

    signal
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "each give up of the sentence played in its order, as the other sides play it"
)]
async fn gives_up_a_start_a_subscription_or_a_publication_its_signal_aborts_a_publication_that_waits_on_its_quota_leaving_it_unsent_and_retires_its_link_where_what_it_asked_may_have_gone()
 {
    let script = script().await;
    let adapter = adapter_of(&options_of(&script));
    let heard = heard_of(&adapter);
    let given = CancellationToken::new();
    let starting = spawn(adapter.start(BrokerStart {
        will: None,
        signal: Some(given.clone()),
    }));

    let _held = script.link(PATIENCE).await.unwrap();
    given.cancel();
    assert!(starting.await.unwrap().is_err(), "given up");
    assert!(heard.downs().is_empty(), "no down");
    assert!(
        adapter
            .start(BrokerStart {
                will: None,
                signal: Some(cancelled()),
            })
            .await
            .is_err(),
        "given up already"
    );

    // a stop before its CONNACK ends the start, and one as it asks its password, too
    let stopped_early = spawn(adapter.start(BrokerStart::default()));

    let _held = script.link(PATIENCE).await.unwrap();
    adapter.stop().await;
    assert!(
        message_of(&stopped_early.await.unwrap().unwrap_err()).contains("before its CONNACK"),
        "ended"
    );

    let (answer, asking) = tokio::sync::watch::channel(None::<String>);
    let mut options = MqttBrokerAdapterOptions::new(script.url(), ID);

    options.password_provider = Some(provider_of(move |_signal| {
        let mut asking = asking.clone();

        Box::pin(async move {
            let answered = asking.wait_for(Option::is_some).await;

            Ok(answered
                .map(|held| held.clone().unwrap_or_default())
                .unwrap_or_default())
        })
    }));

    let asked = adapter_of(&options);
    let asked_start = spawn(asked.start(BrokerStart::default()));

    rest(Duration::from_millis(20)).await;
    asked.stop().await;
    answer.send(Some(PASSWORD.to_owned())).ok();
    assert_eq!(
        message_of(&asked_start.await.unwrap().unwrap_err()),
        "the link of ada stopped as it started",
        "ended as it asked"
    );

    let link = link_up(
        (&adapter, &script),
        (
            &Connack {
                receive_maximum: Some(1),
                ..Connack::default()
            },
            None,
        ),
    )
    .await;
    let first = spawn(adapter.publish(publication(inbox(), &[1])));
    let leaving = CancellationToken::new();
    let waiting = spawn(adapter.publish(signalled(publication(inbox(), &[2]), &leaving)));

    link.next(Some(Kind::Publish), PATIENCE).await.unwrap();
    leaving.cancel();
    assert!(waiting.await.unwrap().is_err(), "given up");

    // * its link kept: the first still awaits its PUBACK, and the next goes after it
    link.send(puback(sent_of(&link)[0].identifier(), 0));
    assert_eq!(
        first.await.unwrap().unwrap(),
        BrokerPublished::Taken,
        "taken"
    );
    rest(Duration::from_millis(50)).await;
    assert_eq!(sent_of(&link).len(), 1, "the second never sent");
    assert!(heard.downs().is_empty(), "no down");

    // a subscription given up once its SUBSCRIBE went retires its link
    let cancelling = CancellationToken::new();
    let subscribing = spawn(adapter.subscribe(
        &inbox(),
        BrokerSubscription {
            group: None,
            signal: Some(cancelling.clone()),
        },
    ));

    link.next(Some(Kind::Subscribe), PATIENCE).await.unwrap();
    cancelling.cancel();
    assert!(subscribing.await.unwrap().is_err(), "given up");
    until(|| !heard.downs().is_empty()).await;
    assert_eq!(heard.downs(), vec![down(false)], "retired");
    assert!(link.closed(PATIENCE).await, "closed");

    // and a signal cancelled already sends nothing
    let again = link_up((&adapter, &script), (&Connack::default(), None)).await;

    assert!(
        adapter
            .subscribe(
                &inbox(),
                BrokerSubscription {
                    group: None,
                    signal: Some(cancelled()),
                }
            )
            .await
            .is_err(),
        "no subscription"
    );
    assert!(
        adapter
            .publish(signalled(publication(inbox(), &[1]), &cancelled()))
            .await
            .is_err(),
        "no publication"
    );
    rest(Duration::from_millis(50)).await;
    assert_eq!(kinds_of(&again), vec![Kind::Connect], "nothing sent");

    // and a publication given up once its PUBLISH went retires its link, too
    let abandoned = CancellationToken::new();
    let publishing = spawn(adapter.publish(signalled(publication(inbox(), &[3]), &abandoned)));

    again.next(Some(Kind::Publish), PATIENCE).await.unwrap();
    abandoned.cancel();
    assert!(publishing.await.unwrap().is_err(), "given up");
    until(|| heard.downs().len() > 1).await;
    assert_eq!(heard.downs(), vec![down(false), down(false)], "retired");
    assert!(again.closed(PATIENCE).await, "closed");
    adapter.stop().await;
}

// ── Its password ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn fails_its_start_once_its_password_provider_outlives_its_connect_timeout_and_takes_no_late_answer()
 {
    let script = script().await;
    let (late, answered) = tokio::sync::watch::channel(None::<String>);
    let mut options = MqttBrokerAdapterOptions::new(script.url(), ID);

    options.connect_timeout = Some(Duration::from_millis(200));
    options.password_provider = Some(provider_of(move |_signal| {
        let mut answered = answered.clone();

        Box::pin(async move {
            let answer = answered.wait_for(Option::is_some).await;

            Ok(answer
                .map(|held| held.clone().unwrap_or_default())
                .unwrap_or_default())
        })
    }));

    let adapter = adapter_of(&options);
    let heard = heard_of(&adapter);
    let failed = adapter.start(BrokerStart::default()).await.unwrap_err();

    assert!(matches!(failed, BrokerError::Failed { .. }), "failed");
    assert_eq!(
        message_of(&failed),
        "the link of ada had no password within 200 ms, its connectTimeout",
        "naming its connect timeout"
    );

    // * its answer, come too late, opens no network connection
    late.send(Some(PASSWORD.to_owned())).ok();
    assert!(
        script.link(Duration::from_millis(300)).await.is_err(),
        "no link came"
    );
    assert!(
        !adapter.is_linked() && heard.downs().is_empty(),
        "not linked"
    );

    // * one connect timeout from its start's call: its CONNACK waits what its ask left of it
    let mut slow = MqttBrokerAdapterOptions::new(script.url(), ID);

    slow.connect_timeout = Some(Duration::from_millis(600));
    slow.password_provider = Some(provider_of(|_signal| {
        Box::pin(async {
            rest(Duration::from_millis(450)).await;

            Ok(PASSWORD.to_owned())
        })
    }));

    let slow = adapter_of(&slow);
    let began = Instant::now();
    let waiting = spawn(slow.start(BrokerStart::default()));

    let _held = script.link(PATIENCE).await.unwrap();

    let failed = message_of(&waiting.await.unwrap().unwrap_err());

    assert!(
        failed.contains("the link of ada had no CONNACK within 600 ms, its connectTimeout"),
        "{failed}"
    );
    assert!(
        began.elapsed() < Duration::from_millis(900),
        "one connect timeout"
    );
}

#[tokio::test]
async fn ends_its_start_once_stopped_as_its_password_is_asked_and_links_at_the_next_start_asked_anew()
 {
    let script = script().await;
    let asked = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&asked);
    let mut options = MqttBrokerAdapterOptions::new(script.url(), ID);

    options.password_provider = Some(provider_of(move |_signal| {
        let asked = counted.fetch_add(1, Ordering::SeqCst).saturating_add(1);

        // * the first ask never answers, nor hears its signal
        if asked == 1 {
            Box::pin(core::future::pending())
        } else {
            Box::pin(async move { Ok(format!("{PASSWORD}-{asked}")) })
        }
    }));

    let adapter = adapter_of(&options);
    let starting = spawn(adapter.start(BrokerStart::default()));

    until(|| asked.load(Ordering::SeqCst) == 1).await;
    adapter.stop().await;

    let failed = starting.await.unwrap().unwrap_err();

    assert!(matches!(failed, BrokerError::Failed { .. }), "failed");
    assert_eq!(
        message_of(&failed),
        "the link of ada stopped as it started",
        "ended"
    );
    assert!(
        script.link(Duration::from_millis(200)).await.is_err(),
        "no link came"
    );

    let link = link_up((&adapter, &script), (&Connack::default(), None)).await;

    assert_eq!(
        link.connect().password.as_deref(),
        Some(format!("{PASSWORD}-2").as_bytes()),
        "asked anew"
    );
    assert_eq!(
        (asked.load(Ordering::SeqCst), adapter.is_linked()),
        (2, true),
        "linked"
    );
    adapter.stop().await;
}

#[tokio::test]
async fn ends_its_start_at_its_own_cancellation_as_its_password_is_asked() {
    let script = script().await;
    let signals = Arc::new(Mutex::new(Vec::<CancellationToken>::new()));
    let held = Arc::clone(&signals);
    let mut options = MqttBrokerAdapterOptions::new(script.url(), ID);

    options.password_provider = Some(provider_of(move |signal| {
        held.lock().unwrap().push(signal);

        Box::pin(core::future::pending())
    }));

    let adapter = adapter_of(&options);
    let given = CancellationToken::new();
    let starting = spawn(adapter.start(BrokerStart {
        will: None,
        signal: Some(given.clone()),
    }));

    until(|| signals.lock().unwrap().len() == 1).await;
    assert!(
        !signals.lock().unwrap()[0].is_cancelled(),
        "live while it asks"
    );
    given.cancel();
    assert!(
        message_of(&starting.await.unwrap().unwrap_err()).contains("was cancelled"),
        "cancelled"
    );
    // * its provider's signal cancelled with it
    until(|| signals.lock().unwrap()[0].is_cancelled()).await;
    assert!(
        signals.lock().unwrap()[0].is_cancelled(),
        "cancelled with it"
    );
    assert!(
        script.link(Duration::from_millis(200)).await.is_err(),
        "no link came"
    );

    // and a signal cancelled already asks nothing
    assert!(
        message_of(
            &adapter
                .start(BrokerStart {
                    will: None,
                    signal: Some(cancelled()),
                })
                .await
                .unwrap_err()
        )
        .contains("was cancelled"),
        "cancelled already"
    );
    assert_eq!(signals.lock().unwrap().len(), 1, "asked once");
}

#[derive(Debug)]
struct VaultDown;

impl core::fmt::Display for VaultDown {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str("the vault is down")
    }
}

impl std::error::Error for VaultDown {}

#[tokio::test]
async fn fails_its_start_when_its_password_provider_throws_its_throw_the_cause() {
    let script = script().await;

    // * as it is called, or as it answers
    for provider in [
        provider_of(|_signal| Box::pin(core::future::ready(Err(Box::new(VaultDown).into())))),
        provider_of(|_signal| {
            Box::pin(async {
                rest(Duration::from_millis(10)).await;

                Err(Box::new(VaultDown).into())
            })
        }),
    ] {
        let mut options = MqttBrokerAdapterOptions::new(script.url(), ID);

        options.password_provider = Some(provider);

        let adapter = adapter_of(&options);
        let failed = adapter.start(BrokerStart::default()).await.unwrap_err();

        assert_eq!(
            message_of(&failed),
            "the password provider failed",
            "failed"
        );
        assert_eq!(
            std::error::Error::source(&failed).map(ToString::to_string),
            Some("the vault is down".to_owned()),
            "its throw the cause"
        );
        assert!(!adapter.is_linked(), "not linked");
    }

    assert!(
        script.link(Duration::from_millis(200)).await.is_err(),
        "no link came"
    );
}

#[tokio::test]
async fn refuses_a_password_that_is_empty_or_holds_a_nul_as_built_or_as_answered() {
    let script = script().await;
    let refusal = "a password is a non-empty string holding no NUL";

    for password in [String::new(), format!("{PASSWORD}\0")] {
        let mut options = MqttBrokerAdapterOptions::new(script.url(), ID);

        options.password = Some(password.clone());

        let built = MqttBrokerAdapter::new(&options).unwrap_err();

        assert_eq!(built.message(), refusal, "as built");

        let mut answering = MqttBrokerAdapterOptions::new(script.url(), ID);

        answering.password_provider = Some(provider_of(move |_signal| {
            let password = password.clone();

            Box::pin(async move { Ok(password) })
        }));

        let answered = adapter_of(&answering)
            .start(BrokerStart::default())
            .await
            .unwrap_err();

        assert!(
            matches!(&answered, BrokerError::Refused(refused) if refused.message() == refusal),
            "as answered: {answered}"
        );
    }

    assert!(
        script.link(Duration::from_millis(200)).await.is_err(),
        "no link came"
    );
}

#[tokio::test]
async fn aborts_its_password_providers_signal_once_its_start_ends_linked_or_not() {
    let script = script().await;
    let signals = Arc::new(Mutex::new(Vec::<CancellationToken>::new()));
    let held = Arc::clone(&signals);
    let mut options = MqttBrokerAdapterOptions::new(script.url(), ID);

    options.password_provider = Some(provider_of(move |signal| {
        held.lock().unwrap().push(signal);

        Box::pin(async { Ok(PASSWORD.to_owned()) })
    }));

    let adapter = adapter_of(&options);
    let starting = spawn(adapter.start(BrokerStart::default()));
    let link = script.link(PATIENCE).await.unwrap();

    // * live while its start is under way
    assert!(!signals.lock().unwrap()[0].is_cancelled(), "live");
    link.send(connack(&Connack::default()));
    starting.await.unwrap().unwrap();
    until(|| signals.lock().unwrap()[0].is_cancelled()).await;
    assert!(
        signals.lock().unwrap()[0].is_cancelled() && adapter.is_linked(),
        "cancelled, linked"
    );
    adapter.stop().await;

    // and a start its CONNACK refuses
    let refusing = spawn(adapter.start(BrokerStart::default()));
    let refused = script.link(PATIENCE).await.unwrap();

    refused.send(connack(&Connack {
        reason_code: 0x86,
        ..Connack::default()
    }));
    assert!(
        message_of(&refusing.await.unwrap().unwrap_err()).contains("Bad User Name or Password"),
        "refused"
    );
    until(|| {
        signals
            .lock()
            .unwrap()
            .get(1)
            .is_some_and(CancellationToken::is_cancelled)
    })
    .await;
    assert_eq!(
        signals
            .lock()
            .unwrap()
            .iter()
            .map(CancellationToken::is_cancelled)
            .collect::<Vec<_>>(),
        vec![true, true],
        "each cancelled"
    );
}

#[tokio::test]
async fn refuses_a_password_beside_a_client_certificate_and_both_a_password_and_its_provider() {
    let script = script().await;
    let secured = "mqtts://127.0.0.1:8883";
    let provider = provider_of(|_signal| Box::pin(async { Ok(PASSWORD.to_owned()) }));
    let certificate = tls::certified_client_config().unwrap();
    let refusals: Vec<String> = [
        (true, false, true),
        (false, true, true),
        (true, true, false),
        // * both, and a certificate: the first refusal, in one order on every side
        (true, true, true),
    ]
    .into_iter()
    .map(|(password, provided, certified)| {
        let mut options = MqttBrokerAdapterOptions::new(secured, ID);

        options.password = password.then(|| PASSWORD.to_owned());
        options.password_provider = provided.then(|| Arc::clone(&provider));
        options.tls = certified.then(|| Arc::clone(&certificate));

        MqttBrokerAdapter::new(&options)
            .unwrap_err()
            .message()
            .to_owned()
    })
    .collect();

    assert_eq!(
        refusals,
        vec![
            "a link authenticates by its client certificate or by a password, not both",
            "a link authenticates by its client certificate or by a password, not both",
            "a link takes a password or a password provider, not both",
            "a link takes a password or a password provider, not both",
        ],
        "each refused"
    );

    // neither: its User Name, its id, with no Password
    let bare = adapter_of(&MqttBrokerAdapterOptions::new(script.url(), ID));
    let link = link_up((&bare, &script), (&Connack::default(), None)).await;

    assert_eq!(
        link.connect().user_name.as_deref(),
        Some(ID),
        "its User Name"
    );
    assert_eq!(link.connect().password, None, "no Password");
    bare.stop().await;
}

#[tokio::test]
async fn is_secure_over_mqtts_and_wss_and_over_mqtt_and_ws_to_the_loopback_alone() {
    let secure_of = |url: &str| adapter_of(&MqttBrokerAdapterOptions::new(url, ID)).is_secure();

    assert_eq!(
        [
            "mqtts://broker.example:8883",
            "wss://broker.example/mqtt",
            "mqtt://127.0.0.1:1883",
            "ws://localhost:9001/mqtt",
            "mqtt://[::1]:1883",
            "mqtt://broker.example:1883",
            "ws://broker.example/mqtt",
        ]
        .map(secure_of),
        [true, true, true, true, true, false, false],
        "secure"
    );

    // what is none of its four is refused as it is built, and so is an id that is none
    for (id, url) in [
        (ID, "http://broker.example"),
        (ID, "no url"),
        ("", "mqtt://127.0.0.1"),
    ] {
        assert!(
            MqttBrokerAdapter::new(&MqttBrokerAdapterOptions::new(url, id)).is_err(),
            "{url}: refused"
        );
    }
}
