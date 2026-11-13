//! The MQTT 5 WebSocket's own frames and upgrade: each frame RFC 6455 refuses from a server
//! refused, a binary message's payload given as its bytes come, a control frame held until whole
//! and nothing held past it, and a 101 judged as RFC 6455 §4.1 has a client judge one.

use std::io::{self, Cursor};

use bytes::{Bytes, BytesMut};
use tungstenite::handshake::derive_accept_key;
use tungstenite::protocol::frame::FrameHeader;
use tungstenite::protocol::frame::coding::{Control, Data, OpCode};

use super::{
    MqttFrameEvent, MqttFrameReader, MqttFrameRefusal, binary_of, close_of, judged, pong_of,
    request_of,
};
use crate::judgement::head::{MAXIMUM_HEAD_BYTES, MAXIMUM_HEAD_FIELDS};
use crate::mqtt::link::address_of;

const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";

// every event `bytes` gives a fresh reader, then what ended them: the want of more, or a refusal
fn events_of(bytes: &[u8]) -> (Vec<MqttFrameEvent>, Option<MqttFrameRefusal>, BytesMut) {
    let mut reader = MqttFrameReader::new();
    let mut buffer = BytesMut::from(bytes);
    let mut events = Vec::new();

    loop {
        match reader.read(&mut buffer) {
            Ok(Some(event)) => events.push(event),
            Ok(None) => return (events, None, buffer),
            Err(refusal) => return (events, Some(refusal), buffer),
        }
    }
}

fn piece(bytes: &[u8]) -> MqttFrameEvent {
    MqttFrameEvent::Bytes(Bytes::copy_from_slice(bytes))
}

#[test]
fn refuses_each_frame_rfc_6455_refuses_from_a_server_and_a_text_frame() {
    let refused = [
        (
            &[0x82, 0x81, 1, 2, 3, 4, 0xAA][..],
            MqttFrameRefusal::Masked,
        ),
        (&[0xC2, 0x00][..], MqttFrameRefusal::ReservedBits),
        (&[0xA2, 0x00][..], MqttFrameRefusal::ReservedBits),
        (&[0x92, 0x00][..], MqttFrameRefusal::ReservedBits),
        (&[0x83, 0x00][..], MqttFrameRefusal::ReservedOpcode(0x3)),
        (&[0x8B, 0x00][..], MqttFrameRefusal::ReservedOpcode(0xB)),
        (
            &[0x82, 0x7F, 0x80, 0, 0, 0, 0, 0, 0, 0][..],
            MqttFrameRefusal::LengthPastItsBound,
        ),
        (&[0x09, 0x00][..], MqttFrameRefusal::FragmentedControl),
        (&[0x89, 0x7E, 0x00, 0x7E][..], MqttFrameRefusal::LongControl),
        (
            &[0x80, 0x00][..],
            MqttFrameRefusal::ContinuationOutsideAMessage,
        ),
        (
            &[0x00, 0x00][..],
            MqttFrameRefusal::ContinuationOutsideAMessage,
        ),
        (&[0x81, 0x00][..], MqttFrameRefusal::Text),
    ];

    for (bytes, refusal) in refused {
        assert_eq!(
            events_of(bytes).1,
            Some(refusal),
            "{bytes:02X?} refused as {refusal}"
        );
    }

    let (events, refusal, _) = events_of(&[0x02, 0x01, 0xAA, 0x82, 0x00]);

    assert_eq!(events, vec![piece(&[0xAA])], "its first fragment given");
    assert_eq!(
        refusal,
        Some(MqttFrameRefusal::DataInsideAMessage),
        "a binary frame inside a fragmented message refused"
    );
    assert_eq!(
        events_of(&[0x02, 0x01, 0xAA, 0x81, 0x00]).1,
        Some(MqttFrameRefusal::Text),
        "a text frame inside one refused as text"
    );
    assert_eq!(
        events_of(&[0x89, 0x7E, 0x00, 0x7E]).2.len(),
        4,
        "a control frame past 125 bytes refused at its head, before its payload comes"
    );
}

#[test]
fn reads_a_frame_head_split_across_reads() {
    let mut reader = MqttFrameReader::new();
    let mut buffer = BytesMut::new();
    let mut events = Vec::new();

    for (index, byte) in [0x82, 0x7E, 0x00, 0x03, 1, 2, 3].into_iter().enumerate() {
        buffer.extend_from_slice(&[byte]);

        while let Some(event) = reader.read(&mut buffer).unwrap() {
            events.push(event);
        }

        if index < 3 {
            assert_eq!(buffer.len(), index + 1, "nothing taken of a head not whole");
        } else {
            assert!(
                buffer.is_empty(),
                "its head taken once whole, then its payload"
            );
        }
    }

    assert_eq!(
        events,
        vec![piece(&[1]), piece(&[2]), piece(&[3])],
        "its payload as it came, once its head is whole"
    );
}

#[test]
fn gives_a_binary_frame_s_payload_in_pieces_as_its_bytes_come() {
    let mut reader = MqttFrameReader::new();
    let mut buffer = BytesMut::from(&[0x82, 0x05, 1, 2][..]);

    assert_eq!(
        reader.read(&mut buffer),
        Ok(Some(piece(&[1, 2]))),
        "what came of its payload"
    );
    assert_eq!(reader.read(&mut buffer), Ok(None), "the rest wanted");
    buffer.extend_from_slice(&[3, 4, 5, 0x82, 0x01, 6]);
    assert_eq!(
        reader.read(&mut buffer),
        Ok(Some(piece(&[3, 4, 5]))),
        "the rest of its payload, no further"
    );
    assert_eq!(
        reader.read(&mut buffer),
        Ok(Some(piece(&[6]))),
        "the next frame's"
    );
    assert_eq!(reader.read(&mut buffer), Ok(None), "nothing left");
}

#[test]
fn reads_a_fragmented_message_a_ping_between_its_fragments_and_an_empty_frame_passed() {
    let mut bytes = vec![0x02, 0x01, 0xAA, 0x89, 0x04];

    bytes.extend_from_slice(b"beat");
    bytes.extend_from_slice(&[
        0x00, 0x00, 0x80, 0x01, 0xBB, 0x8A, 0x00, 0x82, 0x00, 0x88, 0x00,
    ]);

    let (events, refusal, rest) = events_of(&bytes);

    assert_eq!(
        events,
        vec![
            piece(&[0xAA]),
            MqttFrameEvent::Ping(Bytes::from_static(b"beat")),
            piece(&[0xBB]),
            MqttFrameEvent::Pong,
            MqttFrameEvent::Close,
        ],
        "each event in its order, an empty fragment and an empty frame giving none"
    );
    assert_eq!(refusal, None, "none refused");
    assert!(rest.is_empty(), "every byte taken");
}

#[test]
fn holds_a_control_frame_until_its_payload_is_whole_and_nothing_past_it() {
    let mut reader = MqttFrameReader::new();
    let mut buffer = BytesMut::from(&[0x89, 0x04, b'b'][..]);

    assert_eq!(reader.read(&mut buffer), Ok(None), "its payload not whole");
    assert_eq!(buffer.len(), 3, "its head and what came held");
    buffer.extend_from_slice(b"eat");
    assert_eq!(
        reader.read(&mut buffer),
        Ok(Some(MqttFrameEvent::Ping(Bytes::from_static(b"beat")))),
        "its ping once whole"
    );
    assert!(buffer.is_empty(), "nothing held past it");
}

#[test]
fn reserves_nothing_at_the_head_of_a_frame_announcing_2_62_bytes() {
    let mut reader = MqttFrameReader::new();
    let mut buffer = BytesMut::from(&[0x82, 0x7F, 0x40, 0, 0, 0, 0, 0, 0, 0][..]);

    assert_eq!(reader.read(&mut buffer), Ok(None), "its payload wanted");
    assert!(buffer.is_empty(), "its head's 10 bytes taken, nothing held");
    buffer.extend_from_slice(&[0x30, 0x00]);
    assert_eq!(
        reader.read(&mut buffer),
        Ok(Some(piece(&[0x30, 0x00]))),
        "its payload given as it comes"
    );
}

#[test]
fn writes_each_frame_final_and_masked_its_payload_as_given() {
    let frames = [
        (
            binary_of(vec![0x30, 0x02, 0x00, 0x00]),
            OpCode::Data(Data::Binary),
            &[0x30, 0x02, 0x00, 0x00][..],
        ),
        (
            pong_of(Bytes::from_static(b"beat")),
            OpCode::Control(Control::Pong),
            &b"beat"[..],
        ),
        (close_of(), OpCode::Control(Control::Close), &[][..]),
    ];

    for (written, opcode, payload) in frames {
        let written = written.unwrap();
        let mut cursor = Cursor::new(written.as_slice());
        let (head, length) = FrameHeader::parse(&mut cursor).unwrap().unwrap();
        let at = usize::try_from(cursor.position()).unwrap();
        let mask = head.mask.expect("masked, a client's frame (RFC 6455 §5.3)");
        let unmasked: Vec<u8> = written[at..]
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4])
            .collect();

        assert!(head.is_final, "{opcode}: final");
        assert_eq!(head.opcode, opcode, "{opcode}: its opcode");
        assert_eq!(
            length,
            u64::try_from(payload.len()).unwrap(),
            "{opcode}: its length"
        );
        assert_eq!(unmasked, payload, "{opcode}: its payload");
    }
}

#[test]
fn asks_its_upgrade_of_subprotocol_mqtt_offering_no_extension_its_host_with_a_port_not_its_scheme_s()
 {
    let request = request_of(&address_of("ws://broker.test/mqtt?x=1").unwrap(), KEY).unwrap();

    assert_eq!(
        request,
        format!(
            "GET /mqtt?x=1 HTTP/1.1\r\nHost: broker.test\r\nUpgrade: websocket\r\n\
             Connection: Upgrade\r\nSec-WebSocket-Key: {KEY}\r\nSec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Protocol: mqtt\r\n\r\n"
        ),
        "its request whole"
    );
    assert!(
        request_of(&address_of("wss://[::1]:8443/").unwrap(), KEY)
            .unwrap()
            .contains("\r\nHost: [::1]:8443\r\n"),
        "a port not its scheme's named"
    );
    assert!(
        request_of(&address_of("wss://broker.test:443").unwrap(), KEY)
            .unwrap()
            .contains("\r\nHost: broker.test\r\n"),
        "its scheme's port left out"
    );
    assert_eq!(
        request_of(&address_of("ws://broker.test/a b").unwrap(), KEY).map_err(|error| error.kind()),
        Err(io::ErrorKind::InvalidInput),
        "a path that would split its request refused"
    );
}

// a 101 answering `KEY`, its fields as given, then `behind`
fn answer_of(fields: &[&str], behind: &[u8]) -> Vec<u8> {
    let mut answer = String::from("HTTP/1.1 101 Switching Protocols\r\n");

    for field in fields {
        answer.push_str(field);
        answer.push_str("\r\n");
    }

    answer.push_str("\r\n");

    let mut answer = answer.into_bytes();

    answer.extend_from_slice(behind);
    answer
}

fn accepted() -> String {
    format!(
        "Sec-WebSocket-Accept: {}",
        derive_accept_key(KEY.as_bytes())
    )
}

// what `bytes` is judged, its error's message where it fails
fn judgement_of(bytes: &[u8]) -> Result<Option<usize>, String> {
    judged(bytes, &derive_accept_key(KEY.as_bytes())).map_err(|error| error.to_string())
}

#[test]
fn judges_its_upgrade_s_answer_as_rfc_6455_has_a_client_judge_one() {
    let accept = accepted();
    let whole = answer_of(
        &[
            "Upgrade: WebSocket",
            "Connection: keep-alive, Upgrade",
            &accept,
            "Sec-WebSocket-Protocol: mqtt",
        ],
        &[],
    );
    let mut behind = whole.clone();

    behind.extend_from_slice(&[0x82, 0x00]);

    assert_eq!(
        judgement_of(&whole),
        Ok(Some(whole.len())),
        "a 101 of its key and subprotocol, upgrade among Connection's tokens"
    );
    assert_eq!(
        judgement_of(&behind),
        Ok(Some(whole.len())),
        "what came behind it left to its frames"
    );
    assert_eq!(
        judgement_of(&whole[..whole.len() - 1]),
        Ok(None),
        "its head not whole yet"
    );
}

#[test]
fn fails_an_upgrade_s_answer_rfc_6455_has_a_client_fail_no_redirect_followed() {
    let accept = accepted();
    let refused = [
        (
            b"HTTP/1.1 200 OK\r\n\r\n".to_vec(),
            "its broker's upgrade answered 200, not 101",
        ),
        (
            b"HTTP/1.1 302 Found\r\nLocation: /elsewhere\r\n\r\n".to_vec(),
            "its broker's upgrade answered 302, not 101",
        ),
        (
            answer_of(
                &[
                    "Connection: Upgrade",
                    &accept,
                    "Sec-WebSocket-Protocol: mqtt",
                ],
                &[],
            ),
            "its broker's upgrade answered no Upgrade of websocket",
        ),
        (
            answer_of(
                &[
                    "Upgrade: websocket",
                    "Connection: keep-alive",
                    &accept,
                    "Sec-WebSocket-Protocol: mqtt",
                ],
                &[],
            ),
            "its broker's upgrade answered no Connection listing upgrade",
        ),
        (
            answer_of(
                &[
                    "Upgrade: websocket",
                    "Connection: Upgrade",
                    "Sec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                    "Sec-WebSocket-Protocol: mqtt",
                ],
                &[],
            ),
            "its broker's upgrade answered no Sec-WebSocket-Accept of its key",
        ),
        (
            answer_of(
                &[
                    "Upgrade: websocket",
                    "Connection: Upgrade",
                    &accept,
                    &accept,
                    "Sec-WebSocket-Protocol: mqtt",
                ],
                &[],
            ),
            "its broker's upgrade answered no Sec-WebSocket-Accept of its key",
        ),
        (
            answer_of(&["Upgrade: websocket", "Connection: Upgrade", &accept], &[]),
            "its broker's upgrade answered no subprotocol mqtt",
        ),
        (
            answer_of(
                &[
                    "Upgrade: websocket",
                    "Connection: Upgrade",
                    &accept,
                    "Sec-WebSocket-Protocol: MQTT",
                ],
                &[],
            ),
            "its broker's upgrade answered no subprotocol mqtt",
        ),
        (
            answer_of(
                &[
                    "Upgrade: websocket",
                    "Connection: Upgrade",
                    &accept,
                    "Sec-WebSocket-Protocol: mqtt",
                    "Sec-WebSocket-Extensions: permessage-deflate",
                ],
                &[],
            ),
            "its broker's upgrade answered the extension permessage-deflate, none offered",
        ),
        (
            b"SSH-2.0-OpenSSH\r\n\r\n".to_vec(),
            "its broker's upgrade answered no HTTP response, invalid HTTP version",
        ),
    ];

    for (answer, message) in refused {
        assert_eq!(
            judgement_of(&answer),
            Err(message.to_owned()),
            "{}",
            String::from_utf8_lossy(&answer)
        );
    }
}

#[test]
fn fails_an_upgrade_s_answer_past_the_bounds_of_a_head() {
    let long = format!(
        "X-Long: {}",
        core::iter::repeat_n('a', MAXIMUM_HEAD_BYTES).collect::<String>()
    );
    let many: Vec<String> = (0..=MAXIMUM_HEAD_FIELDS)
        .map(|index| format!("X-{index}: {index}"))
        .collect();
    let many: Vec<&str> = many.iter().map(String::as_str).collect();
    let mut partial = b"HTTP/1.1 101 Switching Protocols\r\nX-Long: ".to_vec();

    partial.resize(MAXIMUM_HEAD_BYTES, b'a');

    assert_eq!(
        judgement_of(&answer_of(&[&long], &[])),
        Err(format!(
            "its broker's upgrade answered a head past {MAXIMUM_HEAD_BYTES} bytes"
        )),
        "a head past its bytes"
    );
    assert_eq!(
        judgement_of(&partial),
        Err(format!(
            "its broker's upgrade answered a head past {MAXIMUM_HEAD_BYTES} bytes"
        )),
        "a head still coming at its bound"
    );
    assert_eq!(
        judgement_of(&answer_of(&many, &[])),
        Err(format!(
            "its broker's upgrade answered a head of more than {MAXIMUM_HEAD_FIELDS} fields"
        )),
        "a head past its fields"
    );
}
