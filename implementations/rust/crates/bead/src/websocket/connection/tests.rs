use std::sync::Mutex;

use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

use super::*;
use crate::clock::SystemClock;
use crate::testing::{patience, spawn};

const PATIENCE: Duration = Duration::from_secs(10);

type Delivered = Arc<Mutex<Vec<(Vec<u8>, bool)>>>;

fn bounds_of(pacing: Option<Pacing>, close_timeout: Duration) -> ConnectionBounds {
    ConnectionBounds {
        maximum_message_bytes: 64,
        close_timeout,
        pacing,
        platform: Arc::new(SystemClock::current().unwrap()),
    }
}

fn paced() -> Pacing {
    Pacing {
        maximum_unsent_bytes: 64,
        pace: SendPaceOptions {
            minimum_send_bytes_per_second: 0,
            send_grace_period: Duration::ZERO,
        },
    }
}

fn hooks_of(delivered: &Delivered) -> ConnectionHooks {
    let delivered = Arc::clone(delivered);

    ConnectionHooks {
        deliver: Box::new(move |bytes: Bytes, is_text: bool| {
            delivered.lock().unwrap().push((bytes.to_vec(), is_text));
        }),
        answered: Box::new(|| {}),
    }
}

// a server's connection over one end of a pipe of `capacity` bytes, its peer the other end
async fn opened(
    bounds: ConnectionBounds,
    capacity: usize,
) -> (Connection<DuplexStream>, Commands, DuplexStream) {
    let (server, peer) = tokio::io::duplex(capacity);
    let (connection, commands) =
        Connection::open((server, Vec::new()), (Role::Server, bounds)).await;

    (connection, commands, peer)
}

// a frame a client sends, masked, its payload under 126 bytes
fn masked_frame(opcode: u8, (payload, fin): (&[u8], bool)) -> Vec<u8> {
    let mask = [0x37_u8, 0xfa, 0x21, 0x3d];
    let mut frame = vec![
        opcode | if fin { 0x80 } else { 0 },
        0x80 | u8::try_from(payload.len()).unwrap(),
    ];

    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    frame
}

// what the server wrote of its own, read to its end
async fn read_all(peer: &mut DuplexStream) -> Vec<u8> {
    let mut read = Vec::new();

    patience(PATIENCE, peer.read_to_end(&mut read))
        .await
        .unwrap()
        .ok();

    read
}

#[tokio::test]
async fn settles_a_send_after_its_connection_ends_without_writing_or_holding_bytes() {
    for pacing in [None, Some(paced())] {
        let (connection, commands, peer) = opened(bounds_of(pacing, NEVER), 1_024).await;

        // its peer gone: it ends
        drop(peer);

        let ended = patience(PATIENCE, connection.run(hooks_of(&Delivered::default())))
            .await
            .unwrap();

        commands.send(Bytes::from_static(&[1, 2, 3]));
        commands.close(NORMAL);
        patience(PATIENCE, commands.ended()).await.unwrap();

        assert_eq!(commands.unsent_bytes(), 0, "nothing held");
        assert!(!ended.is_ended_here, "not ended here");
        assert_eq!(ended.failure, None, "no failure");
    }
}

#[tokio::test]
async fn settles_queued_sends_and_releases_their_byte_count_when_its_socket_fails() {
    // * a pipe of 4 bytes its peer never reads: the first send blocks in it
    let (connection, commands, peer) = opened(bounds_of(Some(paced()), NEVER), 4).await;
    let running = spawn(connection.run(hooks_of(&Delivered::default())));

    commands.send(Bytes::from_static(&[1, 2, 3]));
    commands.send(Bytes::from_static(&[4, 5]));
    commands.send(Bytes::from_static(&[6]));

    assert_eq!(commands.unsent_bytes(), 6, "what waits for its socket");

    drop(peer);

    let ended = patience(PATIENCE, running).await.unwrap().unwrap();

    assert_eq!(commands.unsent_bytes(), 0, "its byte count released");
    assert!(!ended.is_ended_here, "not ended here");
    assert_eq!(ended.failure, None, "no failure");
}

#[tokio::test]
async fn delivers_a_fragmented_message_whole_then_the_next_message_separately() {
    let (connection, _commands, mut peer) = opened(bounds_of(None, NEVER), 1_024).await;
    let delivered = Delivered::default();
    let mut frames = masked_frame(0x2, (&[1, 2], false));

    frames.extend(masked_frame(0x0, (&[3], true)));
    frames.extend(masked_frame(0x2, (&[4], true)));
    frames.extend(masked_frame(0x8, (&[0x03, 0xe8], true)));
    peer.write_all(&frames).await.unwrap();

    let ended = patience(PATIENCE, connection.run(hooks_of(&delivered)))
        .await
        .unwrap();

    assert_eq!(
        *delivered.lock().unwrap(),
        vec![(vec![1, 2, 3], false), (vec![4], false)],
        "each whole, as bytes"
    );
    assert!(ended.is_clean(), "its peer's close, answered");
    // its answer, an unmasked close of 1000
    assert_eq!(
        read_all(&mut peer).await,
        vec![0x88, 0x02, 0x03, 0xe8],
        "answered"
    );
}

#[tokio::test]
async fn ends_a_read_without_delivering_data_once_the_socket_is_closed_or_closing() {
    let (connection, commands, mut peer) = opened(bounds_of(None, NEVER), 1_024).await;
    let delivered = Delivered::default();

    // this side closes before anything is read: what comes is read to the peer's close, dropped
    commands.close(NORMAL);

    let mut frames = masked_frame(0x2, (&[1, 2], true));

    frames.extend(masked_frame(0x8, (&[0x03, 0xe8], true)));
    peer.write_all(&frames).await.unwrap();

    let ended = patience(PATIENCE, connection.run(hooks_of(&delivered)))
        .await
        .unwrap();

    commands.send(Bytes::from_static(&[3]));

    assert!(delivered.lock().unwrap().is_empty(), "nothing delivered");
    assert_eq!(
        read_all(&mut peer).await,
        vec![0x88, 0x02, 0x03, 0xe8],
        "its close alone"
    );
    assert!(!ended.is_ended_here, "not ended here");
    assert_eq!(commands.unsent_bytes(), 0, "nothing held");
}

#[tokio::test]
async fn discards_more_data_after_a_message_passes_its_bound_before_the_peer_answers_its_close() {
    let (connection, _commands, mut peer) = opened(bounds_of(None, NEVER), 1_024).await;
    let delivered = Delivered::default();
    let mut frames = vec![0x82, 0xfe, 0x00, 0x41, 0, 0, 0, 0];

    frames.extend([0_u8; 65]);
    frames.extend(masked_frame(0x2, (&[1], true)));
    peer.write_all(&frames).await.unwrap();

    let hooks = hooks_of(&delivered);
    let running = spawn(connection.run(hooks));
    // the peer reads its 1009, then ends
    let mut close = [0_u8; 4];

    patience(PATIENCE, peer.read_exact(&mut close))
        .await
        .unwrap()
        .unwrap();
    drop(peer);

    let ended = patience(PATIENCE, running).await.unwrap().unwrap();

    assert_eq!(close, [0x88, 0x02, 0x03, 0xf1], "1009");
    assert!(delivered.lock().unwrap().is_empty(), "nothing delivered");
    assert_eq!(ended.failure, Some(Failed::TooBig(64)), "too big");
    assert!(ended.is_ended_here, "ended here");
}

#[tokio::test]
async fn settles_a_send_after_its_queue_bound_drops_the_socket_without_aborting_twice() {
    let (connection, commands, mut peer) = opened(bounds_of(Some(paced()), NEVER), 1_024).await;
    let running = spawn(connection.run(hooks_of(&Delivered::default())));

    commands.send(Bytes::from(vec![0; 65]));
    commands.send(Bytes::from_static(&[1]));

    let ended = patience(PATIENCE, running).await.unwrap().unwrap();

    assert!(read_all(&mut peer).await.is_empty(), "nothing written");
    assert_eq!(commands.unsent_bytes(), 0, "nothing held");
    assert!(ended.is_ended_here, "ended here");
    assert_eq!(
        ended.failure,
        Some(Failed::Dropped(
            "what waits for its socket would pass maximumUnsentBytes, 64 bytes".to_owned()
        )),
        "dropped, once"
    );
}

#[tokio::test]
async fn drops_a_connection_that_never_answers_its_close_once_close_timeout_has_passed_telling_no_error()
 {
    let (connection, commands, _peer) =
        opened(bounds_of(None, Duration::from_millis(1)), 1_024).await;

    commands.close(NORMAL);

    let ended = patience(PATIENCE, connection.run(hooks_of(&Delivered::default())))
        .await
        .unwrap();

    assert!(ended.is_ended_here, "dropped here");
    assert!(!ended.is_clean(), "unclean");
    assert_eq!(ended.failure, None, "no failure");
    assert_eq!(commands.unsent_bytes(), 0, "nothing held");
}

#[tokio::test]
async fn drops_a_server_s_connection_whose_peer_reads_nothing_but_pings_once_its_pongs_fill_what_waits_for_its_socket()
 {
    let bounds = ConnectionBounds {
        maximum_message_bytes: 1_024,
        pacing: Some(Pacing {
            maximum_unsent_bytes: 1_024,
            ..paced()
        }),
        ..bounds_of(None, NEVER)
    };
    let (connection, commands, mut peer) = opened(bounds, 1_024).await;
    let running = spawn(connection.run(hooks_of(&Delivered::default())));
    let pings: Vec<u8> = (0..2_000)
        .flat_map(|_| masked_frame(0x9, (&[7; 125], true)))
        .collect();

    // * its peer pings on and reads none of its pongs
    patience(PATIENCE, peer.write_all(&pings))
        .await
        .unwrap()
        .unwrap();
    commands.send(Bytes::from(vec![1; 200]));

    let ended = patience(PATIENCE, running).await.unwrap().unwrap();

    assert!(ended.is_ended_here, "ended here");
    assert_eq!(
        ended.failure,
        Some(Failed::Dropped(
            "what waits for its socket passed maximumUnsentBytes, 1024 bytes, its peer reading none of its pongs"
                .to_owned()
        )),
        "dropped, its bound named"
    );
    assert_eq!(commands.unsent_bytes(), 0, "nothing held");
}

#[test]
fn holds_a_server_s_write_buffer_to_its_bound_and_leaves_a_client_s_as_tungstenite_has_it() {
    let served = config_of(64, Some(1_024));
    let client = config_of(64, None);

    assert_eq!(served.write_buffer_size, 128 * 1_024, "its write buffer");
    assert_eq!(
        served.max_write_buffer_size,
        128 * 1_024 + 1_024 + 14 + 139,
        "its write buffer, the largest message its bound lets go, and a control frame"
    );
    assert_eq!(
        client.max_write_buffer_size,
        WebSocketConfig::default().max_write_buffer_size,
        "a client's, as tungstenite has it"
    );
}

fn shared() -> Shared {
    Shared {
        unsent: AtomicU64::new(0),
        paused: AtomicBool::new(false),
        is_ended: AtomicBool::new(false),
        dropped: Mutex::new(None),
    }
}

#[test]
fn holds_what_waits_for_its_socket_to_its_bound_judged_and_added_at_once() {
    let shared = shared();

    assert!(shared.hold((40, 64)), "held");
    assert!(!shared.hold((25, 64)), "past its bound: refused");
    assert_eq!(shared.unsent.load(Ordering::SeqCst), 40, "nothing added");
    assert!(shared.hold((24, 64)), "to its bound: held");
    assert!(!shared.hold((u64::MAX, u64::MAX)), "an overflow: refused");
    assert_eq!(shared.unsent.load(Ordering::SeqCst), 64, "its bound");
}

#[test]
fn releases_what_its_end_let_go_of_already_to_none_never_past_it() {
    let shared = shared();

    assert!(shared.hold((10, 64)), "held");
    // its end let go of everything, as a send's give-back comes
    shared.unsent.store(0, Ordering::SeqCst);
    shared.release(10);

    assert_eq!(
        shared.unsent.load(Ordering::SeqCst),
        0,
        "none, never wrapped"
    );
}

#[tokio::test]
async fn fails_a_peer_s_close_of_a_status_no_end_sends_as_a_protocol_error_answered_1002() {
    for status in [1_005_u16, 1_006, 999] {
        let (connection, _commands, mut peer) = opened(bounds_of(None, NEVER), 1_024).await;

        peer.write_all(&masked_frame(0x8, (&status.to_be_bytes(), true)))
            .await
            .unwrap();

        let ended = patience(PATIENCE, connection.run(hooks_of(&Delivered::default())))
            .await
            .unwrap();
        let answered = read_all(&mut peer).await;

        assert_eq!(
            answered.get(2..4),
            Some(&1_002_u16.to_be_bytes()[..]),
            "{status}: answered 1002"
        );
        assert_eq!(
            ended.failure,
            Some(Failed::Protocol(
                "its peer's close carried a status no end sends".to_owned()
            )),
            "{status}: a protocol error"
        );
    }

    // a status an end sends is no error
    let (connection, _commands, mut peer) = opened(bounds_of(None, NEVER), 1_024).await;

    peer.write_all(&masked_frame(0x8, (&1_002_u16.to_be_bytes(), true)))
        .await
        .unwrap();

    let ended = patience(PATIENCE, connection.run(hooks_of(&Delivered::default())))
        .await
        .unwrap();

    assert_eq!(ended.failure, None, "a peer's own 1002: no error");
}

#[tokio::test]
async fn fails_a_text_message_or_a_close_s_reason_that_is_no_utf_8_answered_1007() {
    for (index, frame) in [
        masked_frame(0x1, (&[0xff, 0xfe], true)),
        masked_frame(0x8, (&[0x03, 0xe8, 0xff, 0xfe], true)),
    ]
    .into_iter()
    .enumerate()
    {
        let (connection, _commands, mut peer) = opened(bounds_of(None, NEVER), 1_024).await;
        let delivered = Delivered::default();

        peer.write_all(&frame).await.unwrap();

        let running = spawn(connection.run(hooks_of(&delivered)));
        // the peer reads its 1007, then ends
        let mut close = [0_u8; 4];

        patience(PATIENCE, peer.read_exact(&mut close))
            .await
            .unwrap()
            .unwrap();
        drop(peer);

        let ended = patience(PATIENCE, running).await.unwrap().unwrap();

        assert_eq!(close, [0x88, 0x02, 0x03, 0xef], "case {index}: 1007");
        assert!(
            matches!(ended.failure, Some(Failed::InvalidPayload(_))),
            "case {index}: no UTF-8, {:?}",
            ended.failure
        );
        assert!(ended.is_ended_here, "case {index}: failed here");
        assert!(
            delivered.lock().unwrap().is_empty(),
            "case {index}: nothing delivered"
        );
    }
}

#[tokio::test]
async fn shuts_its_write_side_once_its_failing_close_went_so_a_peer_that_answers_and_waits_ends_it()
{
    let (connection, _commands, mut peer) = opened(bounds_of(None, NEVER), 1_024).await;
    let mut frames = vec![0x82, 0xfe, 0x00, 0x41, 0, 0, 0, 0];

    frames.extend([0_u8; 65]);
    peer.write_all(&frames).await.unwrap();

    let running = spawn(connection.run(hooks_of(&Delivered::default())));

    // * its peer answers its close and waits on the server's end, as a client does
    let mut close = [0_u8; 4];

    patience(PATIENCE, peer.read_exact(&mut close))
        .await
        .unwrap()
        .unwrap();
    peer.write_all(&masked_frame(0x8, (&[0x03, 0xf1], true)))
        .await
        .unwrap();

    assert_eq!(close, [0x88, 0x02, 0x03, 0xf1], "1009");
    assert!(
        read_all(&mut peer).await.is_empty(),
        "its end, nothing after"
    );
    drop(peer);

    let ended = patience(PATIENCE, running).await.unwrap().unwrap();

    assert_eq!(ended.failure, Some(Failed::TooBig(64)), "too big");
}
