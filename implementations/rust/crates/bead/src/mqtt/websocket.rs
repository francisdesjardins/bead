//! MQTT 5 over a WebSocket of subprotocol `mqtt` (MQTT 5.0 §6; spec 15.25): its upgrade asks for
//! that subprotocol, and its server must answer it; each packet the client writes is one binary
//! message, one frame, never fragmented; what it reads is each binary message's bytes in their
//! order, a packet across messages read whole, a text message failing the link.

use std::io;

use bytes::Bytes;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use http::HeaderValue;
use http::header::SEC_WEBSOCKET_PROTOCOL;
use tokio_tungstenite::WebSocketStream;
use tungstenite::Message;
use tungstenite::client::IntoClientRequest;
use tungstenite::protocol::WebSocketConfig;

use crate::mqtt::link::Address;
use crate::net::dial::ClientSocket;

// the subprotocol MQTT names over a WebSocket (MQTT 5.0 §6)
const SUBPROTOCOL: &str = "mqtt";

// the bytes a WebSocket frame's head takes past its payload at most: 2, 8 of length, 4 of mask
const FRAME_HEAD: usize = 14;

/// What a WebSocket of an MQTT link is written by.
pub(crate) type WebSocketWriter = SplitSink<WebSocketStream<ClientSocket>, Message>;

/// What a WebSocket of an MQTT link is read by.
pub(crate) type WebSocketReader = SplitStream<WebSocketStream<ClientSocket>>;

/// The WebSocket of subprotocol `mqtt` to `address` over `socket`, its upgrade done, its messages
/// bounded by `maximum_packet_size`, the largest packet its broker sends it.
pub(crate) async fn open(
    (address, socket): (&Address, ClientSocket),
    maximum_packet_size: u32,
) -> io::Result<(WebSocketWriter, WebSocketReader)> {
    let scheme = if address.scheme.is_tls() { "wss" } else { "ws" };
    let url = format!(
        "{scheme}://{}:{}{}",
        address.host, address.port, address.path
    );
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(io::Error::other)?;

    request.headers_mut().insert(
        SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(SUBPROTOCOL),
    );

    let maximum = usize::try_from(maximum_packet_size)
        .unwrap_or(usize::MAX)
        .saturating_add(FRAME_HEAD);
    let config = WebSocketConfig::default()
        .max_message_size(Some(maximum))
        .max_frame_size(Some(maximum))
        .accept_unmasked_frames(false);
    // ! no redirect followed: tungstenite fails an upgrade answered with anything but 101, and one
    // that answers no subprotocol asked
    let (stream, response) =
        tokio_tungstenite::client_async_with_config(request, socket, Some(config))
            .await
            .map_err(io::Error::other)?;
    let answered = response
        .headers()
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok());

    if answered != Some(SUBPROTOCOL) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "its broker's upgrade answered no subprotocol mqtt",
        ));
    }

    Ok(stream.split())
}

/// The next binary message's bytes; none once the WebSocket closed.
pub(crate) async fn next(reader: &mut WebSocketReader) -> io::Result<Option<Bytes>> {
    loop {
        match reader.next().await {
            None | Some(Ok(Message::Close(_))) => return Ok(None),
            Some(Ok(Message::Binary(bytes))) => return Ok(Some(bytes)),
            Some(Ok(Message::Text(_))) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "a text message, which MQTT over a WebSocket never sends",
                ));
            }
            // a ping, answered by tungstenite as it writes next, or a pong
            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
            Some(Err(error)) => return Err(io::Error::other(error)),
        }
    }
}

/// Writes `packet` as one binary message, one frame.
pub(crate) async fn send(writer: &mut WebSocketWriter, packet: Vec<u8>) -> io::Result<()> {
    writer
        .send(Message::Binary(Bytes::from(packet)))
        .await
        .map_err(io::Error::other)
}

/// Closes the WebSocket once what was written went, normal closure.
pub(crate) async fn close(writer: &mut WebSocketWriter) {
    writer.close().await.ok();
}
