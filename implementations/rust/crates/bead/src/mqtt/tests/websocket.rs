//! The MQTT 5 adapter over a WebSocket of a peer of the test's own, which answers its upgrade and
//! writes each message itself, its frames among them, or each byte of its answer (MQTT 5.0 §6; spec
//! 15.25). The Rust side's frames are its own, read as they come and written whole; the other sides
//! leave their WebSocket to `MQTT.js` and `MQTTnet`, and meet the fixture over it, as `fixture` does.

use futures_util::{SinkExt, StreamExt};
use http::HeaderValue;
use http::header::{SEC_WEBSOCKET_EXTENSIONS, SEC_WEBSOCKET_PROTOCOL};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tungstenite::handshake::derive_accept_key;
use tungstenite::handshake::server::{Callback, ErrorResponse, Request, Response};
use tungstenite::protocol::Message;
use tungstenite::protocol::frame::Frame;
use tungstenite::protocol::frame::coding::{Data, OpCode};

use super::*;
use crate::testing::patience;

/// What an upgrade's request offered: its subprotocols, and its extensions.
#[derive(Debug)]
struct Offer {
    subprotocol: Option<String>,
    extensions: Option<String>,
}

/// An upgrade answered with `subprotocol`, none where it is none, its request's offer noted.
struct Answered {
    subprotocol: Option<&'static str>,
    offered: mpsc::UnboundedSender<Offer>,
}

impl Callback for Answered {
    fn on_request(
        self,
        request: &Request,
        mut answer: Response,
    ) -> Result<Response, ErrorResponse> {
        let field = |name| {
            request
                .headers()
                .get(name)
                .and_then(|offered: &HeaderValue| offered.to_str().ok())
                .map(ToOwned::to_owned)
        };

        self.offered
            .send(Offer {
                subprotocol: field(SEC_WEBSOCKET_PROTOCOL),
                extensions: field(SEC_WEBSOCKET_EXTENSIONS),
            })
            .ok();

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

/// The WebSocket `listener` takes next, its upgrade answered with subprotocol `mqtt`.
async fn accepted(
    listener: &TcpListener,
    offered: mpsc::UnboundedSender<Offer>,
) -> tokio_tungstenite::WebSocketStream<TcpStream> {
    let (socket, _) = listener.accept().await.unwrap();

    tokio_tungstenite::accept_hdr_async(
        socket,
        Answered {
            subprotocol: Some("mqtt"),
            offered,
        },
    )
    .await
    .unwrap()
}

/// The upgrade's request `socket` reads, whole, and the `Sec-WebSocket-Accept` its key asks.
async fn request_on(socket: &mut TcpStream) -> (String, String) {
    let mut request = Vec::new();

    while !request.ends_with(b"\r\n\r\n") {
        let mut byte = [0];

        socket.read_exact(&mut byte).await.unwrap();
        request.extend_from_slice(&byte);
    }

    let request = String::from_utf8(request).unwrap();
    let key = request
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("sec-websocket-key"))
                .map(|(_, key)| key.trim().to_owned())
        })
        .unwrap();
    let accept = derive_accept_key(key.as_bytes());

    (request, accept)
}

/// `payload` as one final, unmasked binary frame, as a server writes one.
fn frame_of(payload: &[u8]) -> Vec<u8> {
    let mut frame = vec![0x82, u8::try_from(payload.len()).unwrap()];

    frame.extend_from_slice(payload);
    frame
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
        let mut peer = accepted(&listener, offered).await;
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
        offers.recv().await.unwrap().subprotocol.as_deref(),
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
async fn reads_a_packet_across_two_websocket_messages_whole() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let adapter = adapter_of(&options_over(&listener));
    let (offered, _offers) = mpsc::unbounded_channel();
    let peer = spawn(async move {
        let mut peer = accepted(&listener, offered).await;

        assert_eq!(binary_of(&mut peer).await[0], 0x10, "a CONNECT");

        let answer = connack(&Connack::default());
        let (opening, closing) = answer.split_at(3);

        peer.send(Message::Binary(Bytes::copy_from_slice(opening)))
            .await
            .unwrap();
        peer.send(Message::Binary(Bytes::copy_from_slice(closing)))
            .await
            .unwrap();

        while let Some(Ok(_)) = peer.next().await {}
    });

    adapter.start(BrokerStart::default()).await.unwrap();
    assert!(
        adapter.is_linked(),
        "its CONNACK read whole across two messages"
    );
    adapter.stop().await;
    patience(PATIENCE, peer).await.unwrap().unwrap();
}

// spec 15.25
#[tokio::test]
async fn offers_no_extension_in_its_websocket_s_upgrade_to_its_broker_permessage_deflate_among_them()
 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let adapter = adapter_of(&options_over(&listener));
    let (offered, mut offers) = mpsc::unbounded_channel();
    let peer = spawn(async move {
        let mut peer = accepted(&listener, offered).await;

        assert_eq!(binary_of(&mut peer).await[0], 0x10, "a CONNECT");
        peer.send(Message::Binary(Bytes::from(connack(&Connack::default()))))
            .await
            .unwrap();

        while let Some(Ok(_)) = peer.next().await {}
    });

    adapter.start(BrokerStart::default()).await.unwrap();

    let offer = offers.recv().await.unwrap();

    assert_eq!(offer.extensions, None, "no extension offered");
    assert_eq!(
        offer.subprotocol.as_deref(),
        Some("mqtt"),
        "its subprotocol asked alone"
    );
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

    // * its own judgement of the 101 refuses it
    assert!(
        message_of(&failure).starts_with("the link of ada ended before its CONNACK: ")
            && message_of(&failure).to_lowercase().contains("subprotocol"),
        "{failure}"
    );
    assert!(!adapter.is_linked(), "down");
    adapter.stop().await;
    patience(PATIENCE, peer).await.unwrap().unwrap();
}

// RFC 6455 §4.1
#[tokio::test]
async fn fails_its_start_over_a_websocket_whose_upgrade_is_no_101_accepts_another_key_or_names_an_extension()
 {
    let answers = [
        ("a 200", "200, not 101"),
        ("another key", "no Sec-WebSocket-Accept of its key"),
        (
            "an extension",
            "the extension permessage-deflate, none offered",
        ),
    ];

    for (answer, said) in answers {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let adapter = adapter_of(&options_over(&listener));
        let peer = spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (_, accept) = request_on(&mut socket).await;
            let written = match answer {
                "a 200" => "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_owned(),
                "another key" => "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\
                                  Connection: Upgrade\r\n\
                                  Sec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n\
                                  Sec-WebSocket-Protocol: mqtt\r\n\r\n"
                    .to_owned(),
                _ => format!(
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\
                     Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\
                     Sec-WebSocket-Protocol: mqtt\r\n\
                     Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n"
                ),
            };

            socket.write_all(written.as_bytes()).await.unwrap();

            let mut rest = Vec::new();

            socket.read_to_end(&mut rest).await.ok();
        });
        let failure = adapter.start(BrokerStart::default()).await.unwrap_err();

        assert!(
            message_of(&failure).starts_with("the link of ada ended before its CONNACK: ")
                && message_of(&failure).contains(said),
            "{answer}: {failure}"
        );
        assert!(!adapter.is_linked(), "{answer}: down");
        adapter.stop().await;
        patience(PATIENCE, peer).await.unwrap().unwrap();
    }
}

// RFC 6455 §4.1, RFC 9110 §7.6.1
#[tokio::test]
async fn opens_its_websocket_on_a_101_whose_connection_lists_upgrade_among_other_tokens_reading_what_came_behind_it()
 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let adapter = adapter_of(&options_over(&listener));
    let (requested, mut request) = mpsc::unbounded_channel::<String>();
    let peer = spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let (asked, accept) = request_on(&mut socket).await;
        let mut written = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\
             Connection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\
             Sec-WebSocket-Protocol: mqtt\r\n\r\n"
        )
        .into_bytes();

        requested.send(asked).ok();
        // * its CONNACK in the same write as its 101
        written.extend_from_slice(&frame_of(&connack(&Connack::default())));
        socket.write_all(&written).await.unwrap();

        let mut rest = Vec::new();

        socket.read_to_end(&mut rest).await.ok();
    });

    adapter.start(BrokerStart::default()).await.unwrap();
    assert!(adapter.is_linked(), "linked on the CONNACK behind its 101");

    let asked = request.recv().await.unwrap();

    assert!(
        asked.starts_with("GET /mqtt HTTP/1.1\r\n")
            && asked.contains("\r\nUpgrade: websocket\r\n")
            && asked.contains("\r\nConnection: Upgrade\r\n")
            && asked.contains("\r\nSec-WebSocket-Version: 13\r\n")
            && asked.contains("\r\nSec-WebSocket-Protocol: mqtt\r\n"),
        "its upgrade asked as RFC 6455 §4.1 has it: {asked}"
    );
    adapter.stop().await;
    patience(PATIENCE, peer).await.unwrap().unwrap();
}

// RFC 6455 §5.5.2, §5.5.3
#[tokio::test]
async fn answers_a_ping_with_a_pong_of_its_payload_between_a_message_s_fragments() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let adapter = adapter_of(&options_over(&listener));
    let (offered, _offers) = mpsc::unbounded_channel();
    let (ponged, mut pong) = mpsc::unbounded_channel::<Bytes>();
    let peer = spawn(async move {
        let mut peer = accepted(&listener, offered).await;

        assert_eq!(binary_of(&mut peer).await[0], 0x10, "a CONNECT");

        let answer = connack(&Connack::default());
        let (opening, closing) = answer.split_at(2);

        peer.send(Message::Frame(Frame::message(
            opening.to_vec(),
            OpCode::Data(Data::Binary),
            false,
        )))
        .await
        .unwrap();
        peer.send(Message::Ping(Bytes::from_static(b"beat")))
            .await
            .unwrap();
        peer.send(Message::Frame(Frame::message(
            closing.to_vec(),
            OpCode::Data(Data::Continue),
            true,
        )))
        .await
        .unwrap();

        loop {
            match peer.next().await {
                Some(Ok(Message::Pong(payload))) => {
                    ponged.send(payload).ok();
                }
                Some(Ok(_)) => {}
                None | Some(Err(_)) => return,
            }
        }
    });

    adapter.start(BrokerStart::default()).await.unwrap();
    assert!(adapter.is_linked(), "its CONNACK read across its fragments");
    assert_eq!(
        pong.recv().await.unwrap(),
        Bytes::from_static(b"beat"),
        "its ping answered with the pong of its payload"
    );
    adapter.stop().await;
    patience(PATIENCE, peer).await.unwrap().unwrap();
}

#[tokio::test]
async fn loses_its_link_once_its_mqtt_websocket_peer_closes_or_ends_without_a_close_frame() {
    for clean in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let adapter = adapter_of(&options_over(&listener));
        let heard = heard_of(&adapter);
        let (offered, _offers) = mpsc::unbounded_channel();
        let (ending, ended) = tokio::sync::oneshot::channel::<()>();
        let peer = spawn(async move {
            let mut peer = accepted(&listener, offered).await;

            assert_eq!(binary_of(&mut peer).await[0], 0x10, "a CONNECT");
            peer.send(Message::Binary(Bytes::from(connack(&Connack::default()))))
                .await
                .unwrap();
            ended.await.unwrap();

            if clean {
                peer.close(None).await.unwrap();
                // * its close answered with a close, once what was written went (RFC 6455 §5.5.1)
                assert!(
                    matches!(peer.next().await, Some(Ok(Message::Close(None)))),
                    "its close answered"
                );
            }
        });

        adapter.start(BrokerStart::default()).await.unwrap();
        assert!(
            adapter.is_linked(),
            "clean {clean}: linked before its peer ends"
        );
        ending.send(()).unwrap();
        until(|| !heard.downs().is_empty()).await;
        assert_eq!(heard.downs(), vec![down(false)], "clean {clean}: lost once");
        assert!(
            !adapter.is_linked(),
            "clean {clean}: the connection ends its link"
        );
        adapter.stop().await;
        patience(PATIENCE, peer).await.unwrap().unwrap();
    }
}

// * a close whose reason is no UTF-8 ends the link as any close does, its reason never read, answered
// with a close of no body (RFC 6455 §5.5.1): `ws` sends 1007 for it, .NET 1002, a row of
// docs/support.md
#[tokio::test]
async fn answers_its_broker_s_close_whose_reason_is_no_utf_8_with_a_close_of_no_body_its_link_lost()
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let adapter = adapter_of(&options_over(&listener));
    let heard = heard_of(&adapter);
    let (offered, _offers) = mpsc::unbounded_channel();
    let (ending, ended) = tokio::sync::oneshot::channel::<()>();
    let peer = spawn(async move {
        let mut peer = accepted(&listener, offered).await;

        assert_eq!(binary_of(&mut peer).await[0], 0x10, "a CONNECT");
        peer.send(Message::Binary(Bytes::from(connack(&Connack::default()))))
            .await
            .unwrap();
        ended.await.unwrap();
        // a close of 1000 whose reason is no UTF-8, written raw, as a server sends one
        peer.get_mut()
            .write_all(&[0x88, 0x04, 0x03, 0xE8, 0xFF, 0xFE])
            .await
            .unwrap();

        assert!(
            matches!(peer.next().await, Some(Ok(Message::Close(None)))),
            "answered with a close of no body"
        );
    });

    adapter.start(BrokerStart::default()).await.unwrap();
    assert!(adapter.is_linked(), "linked before its broker closes");
    ending.send(()).unwrap();
    until(|| !heard.downs().is_empty()).await;
    assert_eq!(heard.downs(), vec![down(false)], "lost once");
    assert!(!adapter.is_linked(), "its close ends its link");
    adapter.stop().await;
    patience(PATIENCE, peer).await.unwrap().unwrap();
}

#[tokio::test]
async fn ends_its_mqtt_websocket_with_a_close_frame_after_its_disconnect_packet() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let adapter = adapter_of(&options_over(&listener));
    let heard = heard_of(&adapter);
    let (offered, _offers) = mpsc::unbounded_channel();
    let peer = spawn(async move {
        let mut peer = accepted(&listener, offered).await;

        assert_eq!(binary_of(&mut peer).await[0], 0x10, "a CONNECT");
        peer.send(Message::Binary(Bytes::from(connack(&Connack::default()))))
            .await
            .unwrap();
        assert_eq!(
            binary_of(&mut peer).await,
            [0xE0, 0],
            "its clean DISCONNECT"
        );
        assert_eq!(
            peer.next().await.unwrap().unwrap(),
            Message::Close(None),
            "its WebSocket close follows"
        );
    });

    adapter.start(BrokerStart::default()).await.unwrap();
    adapter.stop().await;
    patience(PATIENCE, peer).await.unwrap().unwrap();
    assert!(!adapter.is_linked(), "stopped");
    assert!(
        heard.downs().is_empty(),
        "its own stop reports no lost link"
    );
}

// [MQTT-6.0.0-2] lets a WebSocket message hold several packets: each held to its Maximum Packet
// Size alone, on every side
#[tokio::test]
async fn reads_a_websocket_message_of_two_packets_past_its_maximum_packet_size_together_each_within_it()
 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut options = options_over(&listener);

    options.maximum_packet_size = Some(1_024);

    let adapter = adapter_of(&options);
    let heard = heard_of(&adapter);
    let (offered, _offers) = mpsc::unbounded_channel();
    let (sending, sent) = tokio::sync::oneshot::channel::<()>();
    let packet = publish(&Publish {
        topic: "bead/i/ada".to_owned(),
        payload: vec![0; 680],
        ..Publish::default()
    });
    let two = Bytes::from([packet.as_slice(), packet.as_slice()].concat());

    assert!(
        packet.len() < 1_024 && two.len() > 1_024 + 14,
        "two packets past it together, each within it"
    );

    let peer = spawn(async move {
        let mut peer = accepted(&listener, offered).await;

        assert_eq!(binary_of(&mut peer).await[0], 0x10, "a CONNECT");
        peer.send(Message::Binary(Bytes::from(connack(&Connack::default()))))
            .await
            .unwrap();
        sent.await.unwrap();
        peer.send(Message::Binary(two)).await.unwrap();

        while let Some(Ok(_)) = peer.next().await {}
    });

    adapter.start(BrokerStart::default()).await.unwrap();
    sending.send(()).unwrap();
    until(|| heard.messages().len() == 2).await;
    assert!(heard.downs().is_empty(), "its link kept");
    assert!(adapter.is_linked(), "linked");
    adapter.stop().await;
    patience(PATIENCE, peer).await.unwrap().unwrap();
}

// * a packet past its Maximum Packet Size judged at its Remaining Length, as its bytes come, before
// its message's next fragment (spec 15.29): a row of docs/support.md
#[tokio::test]
async fn loses_its_link_on_the_first_fragment_of_a_websocket_message_holding_a_packet_past_its_maximum_packet_size_read_at_its_remaining_length()
 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut options = options_over(&listener);

    options.maximum_packet_size = Some(1_024);

    let adapter = adapter_of(&options);
    let heard = heard_of(&adapter);
    let (offered, _offers) = mpsc::unbounded_channel();
    let (sending, sent) = tokio::sync::oneshot::channel::<()>();
    let peer = spawn(async move {
        let mut peer = accepted(&listener, offered).await;

        assert_eq!(binary_of(&mut peer).await[0], 0x10, "a CONNECT");
        peer.send(Message::Binary(Bytes::from(connack(&Connack::default()))))
            .await
            .unwrap();
        sent.await.unwrap();
        // * a PUBLISH of 2,003 bytes announced, its message's first fragment alone, never ended
        peer.send(Message::Frame(Frame::message(
            vec![0x30, 0xD0, 0x0F, 0x00, 0x09],
            OpCode::Data(Data::Binary),
            false,
        )))
        .await
        .unwrap();

        while let Some(Ok(message)) = peer.next().await {
            assert!(
                !matches!(message, Message::Binary(_)),
                "no DISCONNECT on the failed connection"
            );
        }
    });

    adapter.start(BrokerStart::default()).await.unwrap();
    sending.send(()).unwrap();
    until(|| !heard.downs().is_empty()).await;
    assert_eq!(
        heard.downs(),
        vec![down(false)],
        "its packet past its bound loses the link once, its message never ended"
    );
    assert!(heard.messages().is_empty(), "nothing of it handed on");
    assert!(!adapter.is_linked(), "down");
    adapter.stop().await;
    patience(PATIENCE, peer).await.unwrap().unwrap();
}
