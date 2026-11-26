#![expect(
    clippy::arithmetic_side_effects,
    reason = "a test's own walk through the bytes a meter hands, its offsets bounded by them"
)]

use std::io::Cursor;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tungstenite::protocol::{Message as Received, Role, WebSocket};

use super::*;
use crate::testing::{patience, platform_clock};
use crate::websocket::budget::{MessageBounds, MessageBudget};

const PATIENCE: core::time::Duration = core::time::Duration::from_secs(10);

const KEY: [u8; 4] = [0x37, 0xfa, 0x21, 0x3d];

// a frame as a client writes it: `fin` and `opcode`, its length in 7, 16 or 64 bits as it needs,
// masked by KEY
fn masked(opcode: u8, (payload, fin): (&[u8], bool)) -> Vec<u8> {
    let mut frame = head_of(
        (fin, opcode),
        (u64::try_from(payload.len()).unwrap(), Some(KEY)),
    )
    .as_bytes()
    .to_vec();

    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ KEY[index % 4]),
    );
    frame
}

// a frame as a server writes it, unmasked
fn plain(opcode: u8, (payload, fin): (&[u8], bool)) -> Vec<u8> {
    let mut frame = head_of((fin, opcode), (u64::try_from(payload.len()).unwrap(), None))
        .as_bytes()
        .to_vec();

    frame.extend_from_slice(payload);
    frame
}

fn server_meter() -> FrameMeter {
    FrameMeter::new(&FrameMeterOptions::new(true))
}

// what a meter hands for `pieces`, each given in turn as a read, and the verdict it drew
fn handed_of(meter: &mut FrameMeter, pieces: &[&[u8]]) -> (Vec<u8>, Option<MeterVerdict>) {
    let mut handed = Vec::new();

    for piece in pieces {
        let mut at = 0;

        loop {
            let input = &piece[at..];

            if input.is_empty() && !meter.is_piece_due() {
                break;
            }

            let step = meter.step(input);

            match step.handed {
                Handed::Held => {}
                Handed::AsCame => handed.extend_from_slice(&input[..step.taken]),
                Handed::Head(head) => handed.extend_from_slice(head.as_bytes()),
                Handed::Verdict(verdict) => return (handed, Some(verdict)),
            }

            at += step.taken;
        }
    }

    (handed, None)
}

// a socket of bytes to read, whose writes go nowhere
struct Readable(Cursor<Vec<u8>>);

impl io::Read for Readable {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        io::Read::read(&mut self.0, buffer)
    }
}

impl io::Write for Readable {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// what tungstenite reads of `bytes`, as `role`: each message and control frame, then the error that
// ended it, its stream's end among them
fn read_by_tungstenite(bytes: &[u8], role: Role) -> (Vec<Received>, String) {
    let mut socket = WebSocket::from_raw_socket(Readable(Cursor::new(bytes.to_vec())), role, None);
    let mut read = Vec::new();

    loop {
        match socket.read() {
            Ok(message) => read.push(message),
            Err(error) => return (read, error.to_string()),
        }
    }
}

// ── Its heads ────────────────────────────────────────────────────────────────────────────────

// a stream of a client's frames: lengths of 7, 16 and 64 bits, a message in fragments with a
// ping, a pong and an empty frame between them, then a close
fn stream() -> Vec<u8> {
    let mut bytes = Vec::new();

    bytes.extend(masked(TEXT, (b"bead", true)));
    bytes.extend(masked(BINARY, (&[0x5a; 300], true)));
    bytes.extend(masked(BINARY, (&vec![0xa5; 70_000], true)));
    bytes.extend(masked(BINARY, (&[1, 2, 3], false)));
    bytes.extend(masked(0x9, (b"beat", true)));
    bytes.extend(masked(CONTINUATION, (&[], false)));
    bytes.extend(masked(0xA, (&[], true)));
    bytes.extend(masked(CONTINUATION, (&[4; 200], true)));
    bytes.extend(masked(CLOSE, (&1000_u16.to_be_bytes(), true)));
    bytes
}

#[test]
fn reads_frame_heads_split_across_reads_lengths_of_7_16_and_64_bits_control_frames_between_fragments_and_an_empty_frame_as_its_platform_reads_them()
 {
    let stream = stream();
    let (expected, _) = read_by_tungstenite(&stream, Role::Server);

    assert_eq!(
        expected.len(),
        7,
        "four messages, a ping, a pong and a close"
    );

    let mut cuts: Vec<Vec<&[u8]>> = vec![vec![&stream]];

    // every cut through the first frames, the 64-bit head among them, and about its first piece's
    // end; then a byte a read, and 7
    for at in (1..stream.len()).filter(|at| *at < 340 || (65_860..65_876).contains(at)) {
        cuts.push(vec![&stream[..at], &stream[at..]]);
    }

    cuts.push(stream.chunks(1).collect());
    cuts.push(stream.chunks(7).collect());

    for pieces in cuts {
        let mut meter = server_meter();
        let (handed, verdict) = handed_of(&mut meter, &pieces);

        assert_eq!(verdict, None, "no verdict");
        assert_eq!(
            read_by_tungstenite(&handed, Role::Server).0,
            expected,
            "read as tungstenite reads it, cut in {} reads",
            pieces.len()
        );
    }
}

#[test]
fn splits_a_data_frame_past_64_kib_into_frames_of_64_kib_at_most_each_masked_by_its_key_turned_by_its_offset()
 {
    let payload: Vec<u8> = (0..(2 * 65_536 + 3_u32))
        .map(|at| u8::try_from(at % 251).unwrap())
        .collect();
    let frame = masked(BINARY, (&payload, true));
    let mut meter = server_meter();
    let (handed, verdict) = handed_of(&mut meter, &[&frame]);

    assert_eq!(verdict, None, "no verdict");

    // its pieces: each head, then its payload as it came
    let mut at = 0;
    let mut pieces = Vec::new();

    while at < handed.len() {
        let first = handed[at];
        let (length, extended) = match handed[at + 1] & 0x7F {
            126 => (
                u64::from(u16::from_be_bytes([handed[at + 2], handed[at + 3]])),
                2,
            ),
            127 => (
                u64::from_be_bytes(handed[at + 2..at + 10].try_into().unwrap()),
                8,
            ),
            short => (u64::from(short), 0),
        };
        let key: [u8; 4] = handed[at + 2 + extended..at + 6 + extended]
            .try_into()
            .unwrap();
        let start = at + 6 + extended;
        let end = start + usize::try_from(length).unwrap();

        pieces.push((first, length, key, handed[start..end].to_vec()));
        at = end;
    }

    assert_eq!(
        pieces
            .iter()
            .map(|(first, length, _, _)| (*first, *length))
            .collect::<Vec<_>>(),
        vec![(BINARY, 65_536), (CONTINUATION, 65_536), (0x80, 3)],
        "frames of 64 KiB at most, the first its opcode, the last alone final"
    );
    assert!(
        pieces.iter().all(|(_, _, key, _)| *key == KEY),
        "each masked by its key turned by an offset of 64 KiB, which turns it by none"
    );
    assert_eq!(
        pieces
            .iter()
            .flat_map(|(_, _, _, bytes)| bytes.clone())
            .collect::<Vec<_>>(),
        frame[14..].to_vec(),
        "the payload as it came"
    );
    assert_eq!(
        read_by_tungstenite(&handed, Role::Server).0,
        vec![Received::Binary(payload.into())],
        "one message, as it was sent"
    );

    // * a key turned by an offset that is no multiple of 4 unmasks there as the frame's key does
    for offset in 0..8 {
        let turned = turned(KEY, offset);

        for index in 0..8 {
            assert_eq!(
                turned[index % 4],
                KEY[(usize::try_from(offset).unwrap() + index) % 4],
                "turned by {offset}"
            );
        }
    }
}

#[test]
fn hands_a_client_a_server_s_frame_past_64_kib_in_pieces_unmasked() {
    let payload = vec![0x42_u8; 65_536 + 10];
    let frame = plain(TEXT, (&payload, true));
    let mut meter = FrameMeter::new(&FrameMeterOptions::new(false));
    let (handed, verdict) = handed_of(&mut meter, &[&frame[..5], &frame[5..]]);

    assert_eq!(verdict, None, "no verdict");
    assert_eq!(
        read_by_tungstenite(&handed, Role::Client).0,
        vec![Received::Text(String::from_utf8(payload).unwrap().into())],
        "one text message, as it was sent"
    );
}

// ── Its verdicts ─────────────────────────────────────────────────────────────────────────────

#[test]
fn fails_with_1009_at_its_head_a_frame_that_takes_its_message_past_its_bound_a_continuation_s_among_them()
 {
    let options = FrameMeterOptions {
        maximum_message_bytes: Some(64),
        ..FrameMeterOptions::new(true)
    };

    // a head alone, its payload never sent
    let mut meter = FrameMeter::new(&options);
    let head = head_of((true, BINARY), (100, Some(KEY)));

    assert_eq!(
        handed_of(&mut meter, &[head.as_bytes()]),
        (Vec::new(), Some(MeterVerdict::TooBig(64))),
        "1009 at its head"
    );

    // a continuation whose head takes its message past
    let mut meter = FrameMeter::new(&options);
    let mut bytes = masked(BINARY, (&[0; 40], false));

    bytes.extend_from_slice(head_of((true, CONTINUATION), (25, Some(KEY))).as_bytes());

    let (handed, verdict) = handed_of(&mut meter, &[&bytes]);

    assert_eq!(verdict, Some(MeterVerdict::TooBig(64)), "1009 at its head");
    assert_eq!(
        handed,
        masked(BINARY, (&[0; 40], false)),
        "its first frame handed"
    );
}

#[test]
fn fails_with_1008_the_frame_past_its_bound_at_its_head_an_empty_frame_counting_a_control_frame_not()
 {
    let options = FrameMeterOptions {
        maximum_message_frames: Some(2),
        ..FrameMeterOptions::new(true)
    };
    let mut bytes = masked(BINARY, (&[1], false));

    bytes.extend(masked(0x9, (&[], true)));
    bytes.extend(masked(CONTINUATION, (&[], false)));

    let before = bytes.clone();

    bytes.push(0x80);

    let mut meter = FrameMeter::new(&options);

    assert_eq!(
        handed_of(&mut meter, &[&bytes]),
        (before, Some(MeterVerdict::TooManyFrames(2))),
        "1008 at the first byte of the third frame's head"
    );
}

#[test]
fn fails_with_1002_each_head_rfc_6455_forbids_at_the_byte_that_draws_it() {
    let reasons = [
        (vec![0xC2, 0x80], "a reserved bit set"),
        (vec![0x83, 0x80], "a reserved opcode, 3"),
        (vec![0x8B, 0x80], "a reserved opcode, 11"),
        (vec![0x09, 0x80], "a control frame not final"),
        (vec![0x80, 0x80], "a continuation with no message under way"),
        // a control frame's length judged in its 7 bits, whatever value a longer form gives
        (vec![0x89, 0xFE], "a control frame longer than 125 bytes"),
        (vec![0x8A, 0xFF], "a control frame longer than 125 bytes"),
        (vec![0x82, 0x00], "an unmasked frame"),
        (
            vec![0x82, 0xFF, 0x80],
            "a 64-bit length with its top bit set",
        ),
    ];

    for (bytes, reason) in reasons {
        let mut meter = server_meter();

        assert_eq!(
            handed_of(&mut meter, &[&bytes]),
            (Vec::new(), Some(MeterVerdict::Protocol(reason.to_owned()))),
            "{bytes:02x?}"
        );
    }

    // a data frame that is not a continuation while a message is under way
    let mut bytes = masked(BINARY, (&[1], false));
    let first = bytes.clone();

    bytes.push(0x82);

    let mut meter = server_meter();

    assert_eq!(
        handed_of(&mut meter, &[&bytes]),
        (
            first,
            Some(MeterVerdict::Protocol(
                "a data frame that is not a continuation while a message is under way".to_owned()
            ))
        ),
        "1002 at its first byte"
    );

    // a client's meter fails a masked frame
    let mut meter = FrameMeter::new(&FrameMeterOptions::new(false));

    assert_eq!(
        handed_of(&mut meter, &[&masked(BINARY, (&[1], true))]),
        (
            Vec::new(),
            Some(MeterVerdict::Protocol("a masked frame".to_owned()))
        ),
        "a server's frames are not masked"
    );
}

#[test]
fn takes_a_length_not_in_its_minimal_form_as_tungstenite_takes_it() {
    let mut frame = vec![0x82, 0xFF, 0, 0, 0, 0, 0, 0, 0, 3];

    frame.extend_from_slice(&KEY);
    frame.extend([1_u8, 2, 3].iter().zip(KEY).map(|(byte, key)| byte ^ key));

    let mut meter = server_meter();
    let (handed, verdict) = handed_of(&mut meter, &[&frame]);

    assert_eq!(verdict, None, "no verdict");
    assert_eq!(handed, frame, "handed as it came");
}

// ── Its charges ──────────────────────────────────────────────────────────────────────────────

#[test]
fn charges_each_byte_of_a_message_partway_and_128_a_head_a_pong_between_its_frames_among_it() {
    let mut meter = server_meter();
    let mut charged = 0;
    let mut payload = 0;
    let mut begun = 0;
    let mut ended = 0;
    let mut bytes = masked(0x9, (&[], true));

    bytes.extend(masked(BINARY, (&[0; 12], false)));
    bytes.extend(masked(0xA, (b"beat", true)));
    bytes.extend(masked(CONTINUATION, (&[0; 3], true)));
    bytes.extend(masked(0x9, (&[], true)));

    let mut at = 0;

    while at < bytes.len() {
        let step = meter.step(&bytes[at..=at]);

        charged += step.charge;
        payload += step.payload;
        begun += u32::from(step.begins);
        ended += u32::from(step.ends);
        at += step.taken;
    }

    assert_eq!(
        charged,
        (6 + 12 + 128) + (6 + 4 + 128) + (6 + 3 + 128),
        "its frames' bytes, the pong's between them, and 128 a head; the pings around it none"
    );
    assert_eq!(payload, 15, "its payload alone counted for its rate");
    assert_eq!((begun, ended), (1, 1), "one message, begun then ended");
}

// ── Its socket ───────────────────────────────────────────────────────────────────────────────

fn metering(is_upgrading: bool) -> Metering {
    Metering {
        read: Vec::new(),
        reads: Reads::new(Arc::new(platform_clock().unwrap())),
        frames: FrameMeterOptions::new(!is_upgrading),
        holding: None,
        is_upgrading,
    }
}

#[tokio::test]
async fn hands_a_client_s_upgrade_up_to_its_head_s_end_and_meters_what_came_with_it() {
    let (socket, mut peer) = tokio::io::duplex(1 << 20);
    let mut meter = Meter::new(socket, metering(true));
    let head = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n";
    let mut written = head.to_vec();

    written.extend(plain(BINARY, (&vec![7; 70_000], true)));
    peer.write_all(&written).await.unwrap();

    let mut read = vec![0_u8; head.len() + 100];
    let came = patience(PATIENCE, meter.read(&mut read))
        .await
        .unwrap()
        .unwrap();

    assert_eq!(&read[..came], head, "its head alone");

    let mut rest = Vec::new();

    // * its two pieces' heads: 64 KiB's in 64 bits, the rest's in 16
    while rest.len() < 70_000 + 10 + 4 {
        let mut chunk = vec![0_u8; 200_000];
        let came = patience(PATIENCE, meter.read(&mut chunk))
            .await
            .unwrap()
            .unwrap();

        rest.extend_from_slice(&chunk[..came]);
    }

    assert_eq!(
        read_by_tungstenite(&rest, Role::Client).0,
        vec![Received::Binary(vec![7; 70_000].into())],
        "what came with it, in pieces"
    );
}

#[tokio::test]
async fn hands_what_precedes_a_verdict_in_one_read_then_tells_its_reader_and_drops_the_rest() {
    let (socket, mut peer) = tokio::io::duplex(1 << 16);
    let mut meter = Meter::new(socket, metering(false));
    let whole = masked(BINARY, (b"whole", true));
    let mut written = whole.clone();

    written.extend_from_slice(&[0x83, 0x80, 1, 2, 3, 4]);
    peer.write_all(&written).await.unwrap();

    let mut read = vec![0_u8; 1_024];
    let came = patience(PATIENCE, meter.read(&mut read))
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        &read[..came],
        whole.as_slice(),
        "the message whole ahead of it"
    );
    assert!(
        patience(PATIENCE, meter.read(&mut read))
            .await
            .unwrap()
            .is_err(),
        "then its verdict"
    );
    assert_eq!(
        meter.verdict(),
        Some(&Verdict::Head(MeterVerdict::Protocol(
            "a reserved opcode, 3".to_owned()
        ))),
        "a reserved opcode"
    );

    // * stopped, what comes passes raw
    meter.stop();
    peer.write_all(&[0xFF, 0xFF]).await.unwrap();

    let came = patience(PATIENCE, meter.read(&mut read))
        .await
        .unwrap()
        .unwrap();

    assert_eq!(&read[..came], &[0xFF, 0xFF], "raw, parsed by none");
}

// a server's metering, its holding the one connection of a budget of `budget` bytes
fn holding_metering(budget: u64) -> (Metering, Arc<MessageBudget>) {
    let clock: crate::clock::SharedClock = Arc::new(platform_clock().unwrap());
    let budget = MessageBudget::new(MessageBounds {
        message_bytes_budget: budget,
        minimum_body_bytes_per_second: 240,
        body_grace_period: core::time::Duration::from_secs(5),
        clock: Arc::clone(&clock),
    });
    let metering = Metering {
        read: Vec::new(),
        reads: Reads::new(clock),
        frames: FrameMeterOptions::new(true),
        holding: Some(budget.holding()),
        is_upgrading: false,
    };

    (metering, budget)
}

// spec 15.3 and 15.12.19
#[tokio::test]
async fn charges_a_frame_s_head_once_whole_so_a_head_that_draws_a_verdict_charges_nothing_and_a_cast_off_at_an_earlier_byte_wins_over_it()
 {
    // * a head given a byte at a time: nothing charged until its last, then its bytes and 128
    let mut meter = server_meter();
    let frame = masked(BINARY, (&[0; 300], false));
    let charges: Vec<u64> = (0..8)
        .map(|at| meter.step(&frame[at..=at]).charge)
        .collect();

    assert_eq!(
        charges,
        [0, 0, 0, 0, 0, 0, 0, 8 + 128],
        "at its last byte alone"
    );

    // a ping whose 7 bits say 126 between its frames: judged at its second byte, charged nothing
    let first = meter.step(&frame[8..]);
    let ping = meter.step(&[0x89]);
    let judged = meter.step(&[0x80 | 0x7E]);

    assert_eq!(first.charge, 300, "the payload as it came");
    assert_eq!(
        (ping.charge, judged.charge),
        (0, 0),
        "the judged head's bytes"
    );
    assert_eq!(
        judged.handed,
        Handed::Verdict(protocol("a control frame longer than 125 bytes")),
        "1002"
    );

    // * what a read brought before a judged head is charged first: 600 bytes then a head of
    // opcode 3, whole or partway, are cast off; exactly 500 then a ping of 126 fail with 1002
    let whole = masked(BINARY, (&[0x78; 600 - 8 - 128], true));
    let partway = masked(BINARY, (&[0x78; 600 - 8 - 128], false));
    let edge = masked(BINARY, (&[0x78; 500 - 8 - 128], false));
    let plays = [
        ("whole", whole, vec![0x83, 0x80], Verdict::CastOff(500)),
        ("partway", partway, vec![0x83, 0x80], Verdict::CastOff(500)),
        (
            "edge",
            edge,
            vec![0x89, 0x80 | 0x7E],
            Verdict::Head(protocol("a control frame longer than 125 bytes")),
        ),
    ];

    for (name, mut written, judged, verdict) in plays {
        let (socket, mut peer) = tokio::io::duplex(1 << 16);
        let (metering, budget) = holding_metering(500);
        let mut meter = Meter::new(socket, metering);
        let mut read = vec![0_u8; 4_096];

        written.extend(judged);
        peer.write_all(&written).await.unwrap();

        loop {
            match patience(PATIENCE, meter.read(&mut read)).await.unwrap() {
                Ok(0) => panic!("{name}: its end, not its verdict"),
                Ok(_) => {}
                Err(_) => break,
            }
        }

        assert_eq!(meter.verdict(), Some(&verdict), "{name}");
        assert_eq!(budget.held(), 0, "{name}: its charge released");
    }
}
