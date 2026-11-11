//! The MQTT 5 adapter over a WebSocket of a peer of the test's own, which answers its upgrade and
//! writes each message itself (MQTT 5.0 §6; spec 15.25). The Rust side's alone: the other sides
//! leave their WebSocket to `MQTT.js` and `MQTTnet`, and meet the fixture over it, as `fixture` does.

use futures_util::{SinkExt, StreamExt};
use http::HeaderValue;
use http::header::SEC_WEBSOCKET_PROTOCOL;
use tokio::sync::mpsc;
use tungstenite::handshake::server::{Callback, ErrorResponse, Request, Response};
use tungstenite::protocol::Message;

use super::*;
use crate::testing::patience;

/// An upgrade answered with `subprotocol`, none where it is none, its request's offer noted.
struct Answered {
    subprotocol: Option<&'static str>,
    offered: mpsc::UnboundedSender<Option<String>>,
}

impl Callback for Answered {
    fn on_request(
        self,
        request: &Request,
        mut answer: Response,
    ) -> Result<Response, ErrorResponse> {
        let offered = request
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .and_then(|offered| offered.to_str().ok())
            .map(ToOwned::to_owned);

        self.offered.send(offered).ok();

        if let Some(subprotocol) = self.subprotocol {
            answer.headers_mut().insert(
                SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_static(subprotocol),
            );
        }

        Ok(answer)
    }
}

/// The options of an adapter of `ID` to the WebSocket `listener` takes, at `/mqtt`.
fn options_over(listener: &TcpListener) -> MqttBrokerAdapterOptions {
    let port = listener.local_addr().unwrap().port();
    let mut options = MqttBrokerAdapterOptions::new(format!("ws://127.0.0.1:{port}/mqtt"), ID);

    options.password = Some(PASSWORD.to_owned());

    options
}

/// The next binary message `peer` reads, the others passed.
async fn binary_of<S>(peer: &mut S) -> Vec<u8>
where
    S: StreamExt<Item = Result<Message, tungstenite::Error>> + Unpin,
{
    loop {
        match peer.next().await {
            Some(Ok(Message::Binary(bytes))) => return bytes.to_vec(),
            Some(Ok(_)) => {}
            other => panic!("no binary message: {other:?}"),
        }
    }
}

// spec 15.25
#[tokio::test]
async fn links_over_a_websocket_of_subprotocol_mqtt_each_packet_one_binary_message_a_packet_across_messages_read_whole_and_a_text_message_its_link_lost()
 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let adapter = adapter_of(&options_over(&listener));
    let heard = heard_of(&adapter);
    let (offered, mut offers) = mpsc::unbounded_channel();
    let (went, mut sent) = mpsc::unbounded_channel::<Vec<u8>>();
    let (texting, mut text) = mpsc::unbounded_channel::<()>();
    let peer = spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut peer = tokio_tungstenite::accept_hdr_async(
            socket,
            Answered {
                subprotocol: Some("mqtt"),
                offered,
            },
        )
        .await
        .unwrap();
        let connect = binary_of(&mut peer).await;

        went.send(connect).ok();

        // * a ping between, and the CONNACK across two messages, read whole
        let answer = connack(&Connack::default());
        let (opening, closing) = answer.split_at(2);

        peer.send(Message::Ping(Bytes::new())).await.unwrap();
        peer.send(Message::Binary(Bytes::copy_from_slice(opening)))
            .await
            .unwrap();
        peer.send(Message::Binary(Bytes::copy_from_slice(closing)))
            .await
            .unwrap();

        let published = binary_of(&mut peer).await;
        let at = 4_usize.saturating_add(usize::from(published[3]));
        let identifier = u16::from_be_bytes([published[at], published[at.saturating_add(1)]]);

        went.send(published).ok();
        peer.send(Message::Binary(Bytes::from(puback(identifier, 0))))
            .await
            .unwrap();
        text.recv().await;
        peer.send(Message::Text("no packet".into())).await.ok();
        // its end read to its close
        while let Some(Ok(_)) = peer.next().await {}
    });

    adapter.start(BrokerStart::default()).await.unwrap();
    assert_eq!(
        offers.recv().await.unwrap().as_deref(),
        Some("mqtt"),
        "its subprotocol asked"
    );
    assert_eq!(
        sent.recv().await.unwrap()[0],
        0x10,
        "a CONNECT, one message"
    );
    assert!(adapter.is_linked(), "linked");
    assert_eq!(
        adapter.publish(publication(inbox(), b"one")).await.unwrap(),
        BrokerPublished::Taken,
        "its PUBACK read"
    );
    assert_eq!(
        sent.recv().await.unwrap()[0],
        0x32,
        "a PUBLISH, one message"
    );

    texting.send(()).unwrap();
    until(|| !heard.downs().is_empty()).await;
    assert_eq!(heard.downs(), vec![down(false)], "its link lost");
    assert!(!adapter.is_linked(), "down");
    adapter.stop().await;
    patience(PATIENCE, peer).await.unwrap().unwrap();
}

// spec 15.25
#[tokio::test]
async fn fails_its_start_over_a_websocket_whose_upgrade_answers_no_subprotocol_mqtt() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let adapter = adapter_of(&options_over(&listener));
    let (offered, _offers) = mpsc::unbounded_channel();
    let peer = spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();

        if let Ok(mut peer) = tokio_tungstenite::accept_hdr_async(
            socket,
            Answered {
                subprotocol: None,
                offered,
            },
        )
        .await
        {
            while let Some(Ok(_)) = peer.next().await {}
        }
    });
    let failure = adapter.start(BrokerStart::default()).await.unwrap_err();

    // * tungstenite refuses the upgrade first, Bead's own check behind it
    assert!(
        message_of(&failure).starts_with("the link of ada ended before its CONNACK: ")
            && message_of(&failure).to_lowercase().contains("subprotocol"),
        "{failure}"
    );
    assert!(!adapter.is_linked(), "down");
    adapter.stop().await;
    patience(PATIENCE, peer).await.unwrap().unwrap();
}
