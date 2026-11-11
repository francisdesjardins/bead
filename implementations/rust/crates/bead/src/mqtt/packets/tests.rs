//! MQTT 5's packets as the client writes and reads them: each packet a broker sends read, in its
//! every shape MQTT 5.0 allows; each malformed one, or one no client reads, refused; a packet past
//! its bound refused as its Remaining Length is read; each packet the client writes, to its byte.

use bytes::Bytes;

use super::{
    Connect, LARGEST_PACKET_SIZE, MqttAcknowledgement, MqttConnack, MqttDisconnect, MqttPacket,
    MqttPublish, MqttPublishShapeOptions, MqttReading, MqttRefusal, Will, group_filter_of,
    largest_payload, publish_bytes, read_packet, reason_name_of, topic_of, write_connect,
    write_disconnect, write_pingreq, write_puback, write_publish, write_subscribe,
    write_unsubscribe,
};

fn read(bytes: &[u8]) -> Result<MqttReading, MqttRefusal> {
    read_packet(bytes, LARGEST_PACKET_SIZE)
}

fn packet(bytes: &[u8]) -> MqttPacket {
    match read(bytes) {
        Ok(MqttReading::Packet { packet, length }) => {
            assert_eq!(length, bytes.len(), "the whole packet taken");

            packet
        }
        other => panic!("read as {other:?}"),
    }
}

fn refusal(bytes: &[u8]) -> String {
    match read(bytes) {
        Err(MqttRefusal::Malformed(why)) => why,
        other => panic!("read as {other:?}"),
    }
}

#[test]
fn reads_a_connack_its_properties_in_any_order() {
    // Receive Maximum 2, Shared Subscription Available 0, Maximum Packet Size 1,024, a User
    // Property, Maximum QoS 1, Server Keep Alive 1, Topic Alias Maximum 10
    let bytes = [
        0x20, 0x1C, 0x00, 0x00, 0x19, 0x21, 0x00, 0x02, 0x2A, 0x00, 0x27, 0x00, 0x00, 0x04, 0x00,
        0x26, 0x00, 0x01, b'k', 0x00, 0x01, b'v', 0x24, 0x01, 0x13, 0x00, 0x01, 0x22, 0x00, 0x0A,
    ];

    assert_eq!(
        packet(&bytes),
        MqttPacket::Connack(MqttConnack {
            session_present: false,
            reason_code: 0,
            receive_maximum: Some(2),
            maximum_qos: Some(1),
            maximum_packet_size: Some(1_024),
            shared_subscription_available: Some(false),
            server_keep_alive: Some(1),
            reason_string: None,
        }),
        "each property kept"
    );
}

#[test]
fn reads_a_refusing_connack_and_names_its_reason() {
    assert_eq!(
        packet(&[0x20, 0x03, 0x00, 0x86, 0x00]),
        MqttPacket::Connack(MqttConnack {
            reason_code: 0x86,
            ..MqttConnack::default()
        }),
        "its Reason Code"
    );
    assert_eq!(
        reason_name_of(0x86),
        "Bad User Name or Password",
        "its name"
    );
}

#[test]
fn reads_a_publish_of_qos_0_and_1_its_life_and_its_retain() {
    // QoS 1, RETAIN 1, bead/i/ada, identifier 7, a Message Expiry Interval of 60, payload 09
    let publish = packet(&[
        0x33, 0x15, 0x00, 0x0A, b'b', b'e', b'a', b'd', b'/', b'i', b'/', b'a', b'd', b'a', 0x00,
        0x07, 0x05, 0x02, 0x00, 0x00, 0x00, 0x3C, 0x09,
    ]);

    assert_eq!(
        publish,
        MqttPacket::Publish(MqttPublish {
            topic: "bead/i/ada".to_owned(),
            packet_identifier: Some(7),
            retain: true,
            dup: false,
            message_expiry_interval: Some(60),
            payload: Bytes::from_static(&[9]),
        }),
        "at QoS 1"
    );
    assert_eq!(
        packet(&[0x30, 0x06, 0x00, 0x01, b'x', 0x00, 0x08, 0x07]),
        MqttPacket::Publish(MqttPublish {
            topic: "x".to_owned(),
            payload: Bytes::from_static(&[8, 7]),
            ..MqttPublish::default()
        }),
        "at QoS 0, no identifier"
    );
}

#[test]
fn reads_each_acknowledgement_its_reason_code_left_out_or_given() {
    assert_eq!(
        packet(&[0x40, 0x02, 0x00, 0x05]),
        MqttPacket::Puback(MqttAcknowledgement {
            packet_identifier: 5,
            reason_codes: vec![0],
            reason_string: None,
        }),
        "a PUBACK of 0x00, its code left out"
    );
    assert_eq!(
        packet(&[0x40, 0x03, 0x00, 0x05, 0x10]),
        MqttPacket::Puback(MqttAcknowledgement {
            packet_identifier: 5,
            reason_codes: vec![0x10],
            reason_string: None,
        }),
        "a PUBACK of 0x10, no property"
    );
    assert_eq!(
        packet(&[0x40, 0x08, 0x00, 0x05, 0x87, 0x04, 0x1F, 0x00, 0x01, b'n']),
        MqttPacket::Puback(MqttAcknowledgement {
            packet_identifier: 5,
            reason_codes: vec![0x87],
            reason_string: Some("n".to_owned()),
        }),
        "a PUBACK of 0x87, its Reason String"
    );
    assert_eq!(
        packet(&[0x90, 0x04, 0x00, 0x01, 0x00, 0x01]),
        MqttPacket::Suback(MqttAcknowledgement {
            packet_identifier: 1,
            reason_codes: vec![1],
            reason_string: None,
        }),
        "a SUBACK granting QoS 1"
    );
    assert_eq!(
        packet(&[0xB0, 0x04, 0x00, 0x02, 0x00, 0x11]),
        MqttPacket::Unsuback(MqttAcknowledgement {
            packet_identifier: 2,
            reason_codes: vec![0x11],
            reason_string: None,
        }),
        "an UNSUBACK of 0x11"
    );
    assert_eq!(packet(&[0xD0, 0x00]), MqttPacket::Pingresp, "a PINGRESP");
    assert_eq!(
        packet(&[0xE0, 0x00]),
        MqttPacket::Disconnect(MqttDisconnect::default()),
        "a DISCONNECT of 0x00, its code left out"
    );
    assert_eq!(
        packet(&[0xE0, 0x01, 0x8E]),
        MqttPacket::Disconnect(MqttDisconnect {
            reason_code: 0x8E,
            reason_string: None,
        }),
        "a DISCONNECT of 0x8E"
    );
}

#[test]
fn wants_more_bytes_until_a_packet_is_whole_and_takes_it_alone() {
    let bytes = [0x40, 0x02, 0x00, 0x05, 0xD0, 0x00];

    for length in 0..4 {
        assert_eq!(
            read(&bytes[..length]),
            Ok(MqttReading::Partial),
            "{length} bytes"
        );
    }

    assert_eq!(
        read(&bytes),
        Ok(MqttReading::Packet {
            packet: MqttPacket::Puback(MqttAcknowledgement {
                packet_identifier: 5,
                reason_codes: vec![0],
                reason_string: None,
            }),
            length: 4,
        }),
        "the first alone"
    );
}

#[test]
fn refuses_a_packet_past_its_bound_as_its_remaining_length_is_read() {
    // a PUBLISH of 1,000 bytes, its Remaining Length alone come
    assert_eq!(
        read_packet(&[0x32, 0xE5, 0x07], 999),
        Err(MqttRefusal::PastMaximum {
            size: 1_000,
            maximum: 999,
        }),
        "refused before its body"
    );
    assert_eq!(
        read_packet(&[0x32, 0xE5, 0x07], 1_000),
        Ok(MqttReading::Partial),
        "within it, its body awaited"
    );

    // the same header one byte a read: awaited until its length is whole, then refused
    assert_eq!(read_packet(&[0x32], 999), Ok(MqttReading::Partial), "32");
    assert_eq!(
        read_packet(&[0x32, 0xE5], 999),
        Ok(MqttReading::Partial),
        "32 E5"
    );
    assert_eq!(
        read_packet(&[0x32, 0xE5, 0x07], 999),
        Err(MqttRefusal::PastMaximum {
            size: 1_000,
            maximum: 999,
        }),
        "refused at 07"
    );

    // a packet within the bound, then that header, in one read: the first taken whole
    let bytes = [0xD0, 0x00, 0x32, 0xE5, 0x07];

    assert_eq!(
        read_packet(&bytes, 999),
        Ok(MqttReading::Packet {
            packet: MqttPacket::Pingresp,
            length: 2,
        }),
        "the first whole"
    );
    assert_eq!(
        read_packet(&bytes[2..], 999),
        Err(MqttRefusal::PastMaximum {
            size: 1_000,
            maximum: 999,
        }),
        "then the second refused"
    );
}

#[test]
fn refuses_a_packet_past_its_bound_whatever_its_kind() {
    // a first byte of the reserved type 0, its length 16,777,221 bytes in all
    assert_eq!(
        read_packet(&[0x00, 0x80, 0x80, 0x80, 0x08], 1_100),
        Err(MqttRefusal::PastMaximum {
            size: 16_777_221,
            maximum: 1_100,
        }),
        "past its bound, not malformed"
    );

    // within the bound, its kind refused as before
    assert!(
        matches!(
            read_packet(&[0x00, 0x00], 1_100),
            Err(MqttRefusal::Malformed(_))
        ),
        "malformed within it"
    );
    assert!(
        matches!(read_packet(&[0x00], 1_100), Err(MqttRefusal::Malformed(_))),
        "malformed alone, its length not yet read"
    );
}

#[test]
fn reads_a_packet_at_its_bound_and_the_next_in_the_same_read_as_they_came() {
    // a PUBLISH of 1,100 bytes in all: 1, 2 of its Remaining Length, 1,097 of its body
    let mut bytes = vec![0x30, 0xC9, 0x08, 0x00, 0x01, b'x', 0x00];

    bytes.resize(1_100, 0xAB);
    bytes.extend_from_slice(&[0xD0, 0x00]);

    match read_packet(&bytes, 1_100) {
        Ok(MqttReading::Packet {
            packet: MqttPacket::Publish(publish),
            length,
        }) => {
            assert_eq!(length, 1_100, "the packet at its bound, whole");
            assert_eq!(publish.payload.len(), 1_093, "its payload");
        }
        other => panic!("read as {other:?}"),
    }

    assert_eq!(
        read_packet(&bytes[1_100..], 1_100),
        Ok(MqttReading::Packet {
            packet: MqttPacket::Pingresp,
            length: 2,
        }),
        "then the PINGRESP"
    );

    // a Remaining Length of five bytes
    assert!(
        matches!(
            read_packet(&[0x32, 0x80, 0x80, 0x80, 0x80, 0x01], 1_100),
            Err(MqttRefusal::Malformed(_))
        ),
        "malformed"
    );
}

#[test]
fn refuses_what_is_malformed_and_what_no_client_reads() {
    let cases: [(&[u8], &str); 16] = [
        (&[0xF0, 0x00], "an AUTH"),
        (&[0x10, 0x00], "a CONNECT"),
        (&[0x82, 0x00], "a SUBSCRIBE"),
        (&[0x00, 0x00], "reserved type 0"),
        (&[0x60, 0x00], "a QoS 2 acknowledgement"),
        (&[0x41, 0x02, 0x00, 0x01], "reserved flags"),
        (&[0x40, 0x80, 0x00], "more bytes than its value needs"),
        (&[0x40, 0xFF, 0xFF, 0xFF, 0xFF], "past four bytes"),
        (&[0x34, 0x05, 0x00, 0x01, b'x', 0x00, 0x01], "QoS 2"),
        (&[0x36, 0x05, 0x00, 0x01, b'x', 0x00, 0x01], "QoS 3"),
        (&[0x38, 0x04, 0x00, 0x01, b'x', 0x00], "QoS 0 marked DUP"),
        (&[0x30, 0x04, 0x00, 0x01, b'#', 0x00], "a wildcard"),
        (
            &[0x30, 0x06, 0x00, 0x01, b'x', 0x03, 0x23, 0x00],
            "it ends before",
        ),
        (&[0x40, 0x02, 0x00, 0x00], "a Packet Identifier of 0"),
        (&[0x90, 0x03, 0x00, 0x01, 0x00], "no filter"),
        (&[0xD0, 0x01, 0x00], "bytes past"),
    ];

    for (bytes, said) in cases {
        let why = refusal(bytes);

        assert!(why.contains(said), "{bytes:02X?}: {why}");
    }

    let properties: [(&[u8], &str); 6] = [
        // a Topic Alias, which its CONNECT's Topic Alias Maximum of 0 refuses
        (
            &[0x30, 0x07, 0x00, 0x01, b'x', 0x03, 0x23, 0x00, 0x01],
            "a Topic Alias",
        ),
        // a Receive Maximum of 0, a Maximum QoS of 2, a property twice, one MQTT 5 has not, one
        // its packet does not carry
        (
            &[0x20, 0x06, 0x00, 0x00, 0x03, 0x21, 0x00, 0x00],
            "a Receive Maximum of 0",
        ),
        (
            &[0x20, 0x05, 0x00, 0x00, 0x02, 0x24, 0x02],
            "a Maximum QoS of 2",
        ),
        (
            &[0x20, 0x07, 0x00, 0x00, 0x04, 0x24, 0x01, 0x24, 0x01],
            "twice",
        ),
        (
            &[0x20, 0x05, 0x00, 0x00, 0x02, 0x7F, 0x00],
            "which MQTT 5 has not",
        ),
        (
            &[
                0x40, 0x09, 0x00, 0x01, 0x00, 0x05, 0x02, 0x00, 0x00, 0x00, 0x01,
            ],
            "which its packet does not carry",
        ),
    ];

    for (bytes, said) in properties {
        let why = refusal(bytes);

        assert!(why.contains(said), "{bytes:02X?}: {why}");
    }

    // a string that is no UTF-8, or holds U+0000
    assert!(
        refusal(&[0x30, 0x04, 0x00, 0x01, 0xFF, 0x00]).contains("no UTF-8"),
        "no UTF-8"
    );
    assert!(
        refusal(&[0x30, 0x04, 0x00, 0x01, 0x00, 0x00]).contains("U+0000"),
        "U+0000"
    );
}

#[test]
fn writes_a_connect_that_keeps_no_session_its_will_and_its_password() {
    let written = write_connect(&Connect {
        client_identifier: "ada".to_owned(),
        user_name: Some("ada".to_owned()),
        password: Some("pw".to_owned()),
        keep_alive: 30,
        maximum_packet_size: 2_048,
        will: Some(Will {
            topic: "bead/d/ada".to_owned(),
            payload: Bytes::from_static(&[1, 2]),
        }),
    })
    .unwrap();
    let expected: Vec<u8> = [
        // CONNECT, a Remaining Length of 58
        &[0x10, 0x3A][..],
        // MQTT, version 5, User Name, Password, Will QoS 1, Will, Clean Start, Keep Alive 30
        &[0x00, 0x04, b'M', b'Q', b'T', b'T', 0x05, 0xCE, 0x00, 0x1E],
        // Receive Maximum 65,535, Maximum Packet Size 2,048, Topic Alias Maximum 0
        &[
            0x0B, 0x21, 0xFF, 0xFF, 0x27, 0x00, 0x00, 0x08, 0x00, 0x22, 0x00, 0x00,
        ],
        &[0x00, 0x03, b'a', b'd', b'a'],
        // its will: a Will Delay Interval of 0, its topic, its payload
        &[0x05, 0x18, 0x00, 0x00, 0x00, 0x00],
        &[
            0x00, 0x0A, b'b', b'e', b'a', b'd', b'/', b'd', b'/', b'a', b'd', b'a',
        ],
        &[0x00, 0x02, 0x01, 0x02],
        &[0x00, 0x03, b'a', b'd', b'a'],
        &[0x00, 0x02, b'p', b'w'],
    ]
    .concat();

    assert_eq!(written, expected, "to its byte");

    // under a certificate: neither User Name nor Password, no will
    let bare = write_connect(&Connect {
        client_identifier: "ada".to_owned(),
        user_name: None,
        password: None,
        keep_alive: 1,
        maximum_packet_size: 2_048,
        will: None,
    })
    .unwrap();

    assert_eq!(bare.get(9), Some(&0x02), "Clean Start alone");
}

#[test]
fn writes_each_packet_it_sends_to_its_byte() {
    assert_eq!(
        write_puback(7),
        [0x40, 0x02, 0x00, 0x07],
        "a PUBACK of 0x00"
    );
    assert_eq!(
        write_subscribe((1, "bead/i/ada")).unwrap(),
        [
            0x82, 0x10, 0x00, 0x01, 0x00, 0x00, 0x0A, b'b', b'e', b'a', b'd', b'/', b'i', b'/',
            b'a', b'd', b'a', 0x21,
        ],
        "a SUBSCRIBE of QoS 1, No Local 0, Retain As Published 0, Retain Handling 2"
    );
    assert_eq!(
        write_unsubscribe((2, "x")).unwrap(),
        [0xA2, 0x06, 0x00, 0x02, 0x00, 0x00, 0x01, b'x'],
        "an UNSUBSCRIBE of one filter"
    );
    assert_eq!(write_pingreq(), [0xC0, 0x00], "a PINGREQ");
    assert_eq!(write_disconnect(), [0xE0, 0x00], "a DISCONNECT of 0x00");
}

#[test]
fn writes_a_publish_in_the_bytes_its_count_says_and_reads_it_back() {
    let options = MqttPublishShapeOptions::default();
    let at_most_once = MqttPublishShapeOptions {
        is_at_most_once: Some(true),
        has_life: Some(false),
    };

    for (publish, shape) in [
        (
            MqttPublish {
                topic: "bead/i/ada".to_owned(),
                packet_identifier: Some(1),
                message_expiry_interval: Some(60),
                payload: Bytes::from(vec![7; 200]),
                ..MqttPublish::default()
            },
            &options,
        ),
        (
            MqttPublish {
                topic: "bead/i/ada".to_owned(),
                payload: Bytes::from(vec![7; 20_000]),
                ..MqttPublish::default()
            },
            &at_most_once,
        ),
    ] {
        let written = write_publish(&publish).unwrap();
        let counted = publish_bytes(
            u64::try_from(publish.topic.len()).unwrap(),
            u64::try_from(publish.payload.len()).unwrap(),
            shape,
        );

        assert_eq!(u64::try_from(written.len()).unwrap(), counted, "counted");
        assert_eq!(packet(&written), MqttPacket::Publish(publish), "read back");
    }
}

#[test]
fn finds_the_largest_payload_within_a_bound_or_none() {
    let options = MqttPublishShapeOptions::default();

    assert_eq!(
        largest_payload("bead/i/server", 16_777_216, &options),
        Some(16_777_188),
        "its inbox's receive bound"
    );
    assert_eq!(
        largest_payload("bead/i/server", 10, &options),
        None,
        "none where an empty one does not fit"
    );
    assert_eq!(
        topic_of(&["bead".to_owned(), "i".to_owned(), "ada".to_owned()]),
        "bead/i/ada",
        "a topic"
    );
    assert_eq!(
        group_filter_of(
            "interop",
            &["bead".to_owned(), "s".to_owned(), "interop".to_owned()]
        ),
        "$share/interop/bead/s/interop",
        "a group's shared subscription"
    );
}
