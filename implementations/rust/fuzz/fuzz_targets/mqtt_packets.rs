//! `mqtt-packets`: raw bytes, as a broker sends them, read by the MQTT 5 client's packet reader
//! (spec 15.29, decision 0050), which gives a packet, the want of more bytes or a refusal, and
//! never panics. A packet it reads takes no more bytes than it was given, and is refused past a
//! bound one byte short of it; a PUBLISH it reads is written again in exactly the bytes spec 15.30
//! counts, which read as the same PUBLISH. The Rust side's alone: its client is Bead's own, where
//! the other sides' are MQTT.js and MQTTnet.

#![no_main]

use bead::internal::{
    LARGEST_PACKET_SIZE, MqttPacket, MqttPublishShapeOptions, MqttReading, MqttRefusal,
    publish_bytes, read_packet, write_publish,
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let (packet, length) = match read_packet(data, LARGEST_PACKET_SIZE) {
        Ok(MqttReading::Packet { packet, length }) => (packet, length),
        Ok(MqttReading::Partial) | Err(MqttRefusal::Malformed(_)) => return,
        Err(refused) => panic!("refused past the largest packet: {refused}"),
    };

    assert!(length <= data.len(), "took {length} bytes of {}", data.len());

    let short = u32::try_from(length.saturating_sub(1)).unwrap_or(u32::MAX);

    assert!(
        matches!(
            read_packet(data, short),
            Err(MqttRefusal::PastMaximum { .. })
        ),
        "read within {short} bytes: {packet:?}"
    );

    let MqttPacket::Publish(publish) = packet else {
        return;
    };
    let mut shape = MqttPublishShapeOptions::default();

    shape.is_at_most_once = Some(publish.packet_identifier.is_none());
    shape.has_life = Some(publish.message_expiry_interval.is_some());

    let counted = publish_bytes(
        u64::try_from(publish.topic.len()).unwrap_or(u64::MAX),
        u64::try_from(publish.payload.len()).unwrap_or(u64::MAX),
        &shape,
    );
    let written = write_publish(&publish).expect("a PUBLISH read is written again");

    assert_eq!(
        u64::try_from(written.len()).ok(),
        Some(counted),
        "written in the bytes counted: {publish:?}"
    );
    assert!(
        matches!(
            read_packet(&written, LARGEST_PACKET_SIZE),
            Ok(MqttReading::Packet { packet: MqttPacket::Publish(again), length })
                if again == publish && length == written.len()
        ),
        "what it wrote reads as the same PUBLISH: {publish:?}"
    );
});
