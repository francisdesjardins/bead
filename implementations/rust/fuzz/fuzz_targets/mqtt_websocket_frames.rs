//! `mqtt-websocket-frames`: raw bytes, as a server sends them over an MQTT 5 WebSocket, read by the
//! MQTT 5 client's frame reader (spec 15.25, decision 0050), which gives an event, the want of more
//! bytes or a refusal, and never panics. It gives the same events, a binary message's pieces
//! joined, and the same refusal, whether its input comes whole or cut where the input's first byte
//! says; and once it wants more bytes, what it holds is less than a whole frame head, or a control
//! frame's head and less than its payload. The Rust side's alone: its client is Bead's own, where
//! the other sides' are MQTT.js and MQTTnet.

#![no_main]

use bead::internal::{MqttFrameEvent, MqttFrameReader, MqttFrameRefusal};
use bytes::BytesMut;
use libfuzzer_sys::fuzz_target;

// the bytes a frame's head takes at most, and a control frame's payload (RFC 6455 §5.2, §5.5)
const HEAD_BYTES: usize = 14;
const CONTROL_BYTES: usize = 125;

// what a read gives, a binary message's pieces joined, and the refusal that ended it
#[derive(Debug, Default, PartialEq, Eq)]
struct Read {
    events: Vec<(&'static str, Vec<u8>)>,
    refusal: Option<MqttFrameRefusal>,
}

impl Read {
    fn push(&mut self, event: MqttFrameEvent) {
        let (kind, bytes) = match event {
            MqttFrameEvent::Bytes(bytes) => ("bytes", bytes.to_vec()),
            MqttFrameEvent::Ping(payload) => ("ping", payload.to_vec()),
            MqttFrameEvent::Pong => ("pong", Vec::new()),
            MqttFrameEvent::Close => ("close", Vec::new()),
        };

        match self.events.last_mut() {
            Some(("bytes", joined)) if kind == "bytes" => joined.extend_from_slice(&bytes),
            _ => self.events.push((kind, bytes)),
        }
    }
}

// each piece of `pieces` given to one reader in turn, read until it wants more or refuses
fn read_of(pieces: &[&[u8]]) -> Read {
    let mut reader = MqttFrameReader::new();
    let mut buffer = BytesMut::new();
    let mut read = Read::default();

    for piece in pieces {
        buffer.extend_from_slice(piece);

        loop {
            match reader.read(&mut buffer) {
                Ok(Some(event)) => read.push(event),
                Ok(None) => break,
                Err(refusal) => {
                    read.refusal = Some(refusal);

                    return read;
                }
            }
        }

        let is_control = buffer.first().is_some_and(|first| first & 0x08 != 0);

        assert!(
            buffer.len() < HEAD_BYTES || (is_control && buffer.len() < HEAD_BYTES + CONTROL_BYTES),
            "{} bytes held once it wanted more",
            buffer.len()
        );
    }

    read
}

fuzz_target!(|data: &[u8]| {
    let whole = read_of(&[data]);
    let at = data
        .first()
        .map_or(0, |first| usize::from(*first) % data.len().saturating_add(1));
    let pieces: [&[u8]; 2] = data.split_at(at.min(data.len())).into();
    let cut = read_of(&pieces);

    assert_eq!(whole, cut, "the same read whole and cut at {at}");
});
