//! A listen, the outbox it brings back and the bounds on it (spec 15.9), the twin of the listening
//! tests of `http-transport-server.test.ts` and `HttpTransportServerTests`.

use core::time::Duration;
use std::sync::Arc;
use std::time::SystemTime;

use super::super::{
    HttpTransportServer, HttpTransportServerOptions, MAXIMUM_BODY_BYTES, MAXIMUM_OUTBOX_BYTES,
    MAXIMUM_WAIT,
};
use crate::constants::EnvelopeKind;
use crate::http::fields::{
    BEAD_BATCH_MEDIA_TYPE, CONNECTION_TOKEN_HEADER, HTTP_REFUSALS, LISTEN_HEADER, SEQUENCE_HEADER,
};
use crate::http::peer::*;
use crate::testing::SteppingClock;
use crate::transport::ServerTransport;
use crate::{BODY_BYTES_BUDGET, MAXIMUM_CONNECTIONS, MAXIMUM_CONNECTIONS_PER_ADDRESS, NEVER};

// a notification of `extra` bytes past its prefix
fn notification((call_id, extra): (u32, usize)) -> Vec<u8> {
    envelope_of(EnvelopeKind::Notification.byte(), (call_id, extra))
}

// a server on a stepping clock, its options besides
async fn stepped(clock: &Arc<SteppingClock>, options: &HttpTransportServerOptions) -> Started {
    started(&HttpTransportServerOptions {
        clock: Some(Arc::<SteppingClock>::clone(clock)),
        ..options.clone()
    })
    .await
}

// what a listen is answered: its status, its first's number and its body
async fn answered(listen: &crate::testing::wire::Exchange) -> (u16, Option<String>, Vec<u8>) {
    let response = listen.response(PATIENCE).await.expect("its answer");

    (
        response.head.status,
        response.head.fields.get(SEQUENCE_HEADER).cloned(),
        response.body,
    )
}

// spec 15.9
#[tokio::test]
async fn brings_back_what_the_server_sent_of_its_own_in_order_and_numbered_again_until_a_listen_acknowledges_it()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let drawn = posted(
        port,
        &Post {
            fields: vec![format!("{LISTEN_HEADER}: ?1")],
            ..Post::default()
        },
    )
    .await;
    let token = drawn.head.fields[CONNECTION_TOKEN_HEADER].clone();
    let handle = Arc::clone(&started.server.clients()[0].connection_handle);
    let first = notification((1, 0));
    let second = envelope_of(REQUEST, (2, 3));

    // the listen taken, said back
    assert_eq!(
        (
            drawn.head.fields.get(LISTEN_HEADER).map(String::as_str),
            started.server.is_two_way(&handle)
        ),
        (Some("?1"), true),
        "it listens"
    );

    started.send(&first, &handle).await.unwrap();
    started.send(&second, &handle).await.unwrap();

    let brought = listen_of(port, (&token, (Some("0"), Some("0"))))
        .await
        .response(PATIENCE)
        .await
        .unwrap();

    assert_eq!(
        (
            brought.head.status,
            brought.head.fields.get("content-type").map(String::as_str),
            brought.head.fields.get(SEQUENCE_HEADER).map(String::as_str),
            brought.head.fields.get("cache-control").map(String::as_str)
        ),
        (
            200,
            Some(BEAD_BATCH_MEDIA_TYPE),
            Some("1"),
            Some("no-store")
        ),
        "a batch"
    );
    assert_eq!(brought.body, batch_of(&[&first, &second]), "both, in order");
    // not acknowledged: brought back again
    assert_eq!(
        answered(&listen_of(port, (&token, (Some("0"), None))).await)
            .await
            .2,
        batch_of(&[&first, &second]),
        "again"
    );
    // acknowledged: gone, and nothing left
    assert_eq!(
        answered(&listen_of(port, (&token, (Some("2"), Some("0")))).await).await,
        (204, None, Vec::new()),
        "acknowledged"
    );
    started.stop().await;
}

#[tokio::test]
async fn holds_a_listen_until_something_comes_within_its_wait_no_longer_than_its_limit_and_ends_it_empty_past_it()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = stepped(
        &clock,
        &HttpTransportServerOptions {
            inactivity_timeout: Some(NEVER),
            maximum_wait: Some(Duration::from_secs(1)),
            ..HttpTransportServerOptions::default()
        },
    )
    .await;
    let port = started.port;
    let (handle, token) = connect_listening(&started).await;
    let lapsing = listen_of(port, (&token, (Some("0"), Some("60000")))).await;

    // waiting, as long as the server lets it
    until(|| clock.dues() == [Duration::from_secs(1)]).await;
    clock.advance(Duration::from_secs(1)).await;

    assert_eq!(answered(&lapsing).await.0, 204, "ended empty");

    let held = listen_of(port, (&token, (Some("0"), Some("500")))).await;
    let envelope = notification((1, 0));

    until(|| clock.dues() == [Duration::from_millis(500)]).await;
    started.send(&envelope, &handle).await.unwrap();

    assert_eq!(
        answered(&held).await,
        (200, Some("1".to_owned()), batch_of(&[&envelope])),
        "brought back as it came"
    );
    // its timer went with it
    assert!(clock.dues().is_empty(), "no timer left: {:?}", clock.dues());
    started.stop().await;
}

#[tokio::test]
async fn lets_a_second_listen_take_the_place_of_the_first_which_ends_empty_a_listen_lost_closes_nothing_and_what_it_carried_comes_again()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let (handle, token) = connect_listening(&started).await;
    let first = listen_of(port, (&token, (Some("0"), Some("20000")))).await;

    until(|| gauge(&started.server, "listens") == 1).await;

    let second = listen_of(port, (&token, (Some("0"), Some("20000")))).await;

    assert_eq!(
        answered(&first).await,
        (204, None, Vec::new()),
        "the first, empty"
    );
    assert_eq!(gauge(&started.server, "listens"), 1, "one held");

    // what the second brings back goes nowhere: it is lost, and brought back to the next
    let envelope = notification((1, 0));

    second.destroy();
    started.send(&envelope, &handle).await.unwrap();

    let third = listen_of(port, (&token, (Some("0"), Some("0")))).await;

    assert_eq!(
        answered(&third).await,
        (200, Some("1".to_owned()), batch_of(&[&envelope])),
        "again"
    );

    // a listen held, lost: what comes next waits for the one after it
    let dropped = listen_of(port, (&token, (Some("1"), Some("20000")))).await;

    until(|| gauge(&started.server, "listens") == 1).await;
    dropped.destroy();
    until(|| gauge(&started.server, "listens") == 0).await;
    started.send(&envelope, &handle).await.unwrap();

    let next = listen_of(port, (&token, (Some("1"), Some("0")))).await;

    assert_eq!(
        answered(&next).await,
        (200, Some("2".to_owned()), batch_of(&[&envelope])),
        "the next"
    );
    assert!(started.recorder.told().closes.is_empty(), "nothing closed");
    started.stop().await;
}

#[tokio::test]
async fn brings_back_all_that_waits_in_one_batch_however_large_numbered_from_its_first() {
    let started = started(&HttpTransportServerOptions {
        maximum_body_bytes: Some(32),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let (handle, token) = connect_listening(&started).await;
    let envelopes: Vec<Vec<u8>> = [(1, 8), (3, 8), (5, 32)]
        .into_iter()
        .map(notification)
        .collect();

    for envelope in &envelopes {
        started.send(envelope, &handle).await.unwrap();
    }

    // past the body limit together, and one alone: a batch is read as it comes, each bounded alone
    let all = answered(&listen_of(port, (&token, (Some("0"), Some("0")))).await).await;
    let rest = listen_of(port, (&token, (Some("1"), Some("0"))))
        .await
        .response(PATIENCE)
        .await
        .unwrap();

    assert_eq!(
        all,
        (
            200,
            Some("1".to_owned()),
            batch_of(&[&envelopes[0], &envelopes[1], &envelopes[2]])
        ),
        "all"
    );
    assert_eq!(
        (
            rest.head.fields.get(SEQUENCE_HEADER).cloned(),
            rest.body,
            rest.head.fields.get("content-length").cloned()
        ),
        (
            Some("2".to_owned()),
            batch_of(&[&envelopes[1], &envelopes[2]]),
            Some((4 + 16 + 4 + 40).to_string())
        ),
        "the rest"
    );
    started.stop().await;
}

#[tokio::test]
async fn keeps_for_a_listen_an_answer_whose_exchange_ended_and_anything_else_the_server_sends_one_that_does_not_listen_drops_the_one_and_rejects_the_other()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (listening, token) = connect_listening(&started).await;
    let (deaf, _) = connect(&started).await;
    let late = envelope_of(RESULT, (1, 0));
    let command = envelope_of(REQUEST, (2, 0));

    started.send(&late, &listening).await.unwrap();
    started.send(&command, &listening).await.unwrap();
    started.send(&late, &deaf).await.expect("dropped");

    assert_eq!(
        started.send(&command, &deaf).await.unwrap_err().to_string(),
        "this connection does not listen: an envelope of kind 0x10 goes nowhere",
        "rejected"
    );
    assert_eq!(
        answered(&listen_of(started.port, (&token, (Some("0"), Some("0")))).await)
            .await
            .2,
        batch_of(&[&late, &command]),
        "both kept"
    );

    let nobody: crate::router::types::ConnectionHandle =
        Arc::from("type=HTTP;ip=127.0.0.1;ordinal=99");

    assert_eq!(
        [
            started.server.is_two_way(&listening),
            started.server.is_two_way(&deaf),
            started.server.is_two_way(&nobody)
        ],
        [true, false, false],
        "which carries both ways"
    );
    started.stop().await;
}

#[tokio::test]
async fn refuses_a_listen_where_none_was_declared_409_and_one_that_asks_what_it_cannot_400_a_connect_that_says_it_listens_in_any_other_way()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let (_, listening) = connect_listening(&started).await;
    let (_, deaf) = connect(&started).await;
    let status_of = async |request: Vec<u8>| {
        let answer = raw_answer_of(port, &request).await;

        (answer.status, answer.refusal)
    };
    let listen = |token: &str, fields: &[&str]| {
        let token_field = format!("{CONNECTION_TOKEN_HEADER}: {token}");
        let mut lines = vec![token_field.as_str()];

        lines.extend_from_slice(fields);
        head_of(("GET", "/bead"), (port, &lines)).into_bytes()
    };
    let malformed = (400, Some(HTTP_REFUSALS.malformed.to_owned()));
    let mut with_body = listen(&listening, &["bead-after: 0", "Content-Length: 8"]);

    with_body.extend_from_slice(&[7; 8]);

    assert_eq!(
        vec![
            status_of(listen(&deaf, &["bead-after: 0"])).await,
            status_of(with_body).await,
            status_of(listen(&listening, &["bead-after: one"])).await,
            status_of(listen(&listening, &["bead-after: 0", "bead-wait: -1"])).await,
            status_of(listen(&listening, &["bead-after: 1"])).await,
            status_of(
                Post {
                    fields: vec![format!("{LISTEN_HEADER}: yes")],
                    ..Post::default()
                }
                .request(port)
            )
            .await,
            status_of(head_of(("GET", "/bead"), (port, &[])).into_bytes()).await,
        ],
        vec![
            (409, Some(HTTP_REFUSALS.listen_undeclared.to_owned())),
            malformed.clone(),
            malformed.clone(),
            malformed.clone(),
            malformed.clone(),
            malformed.clone(),
            malformed,
        ],
        "each refused"
    );

    // `?0` says it does not
    let declined = posted(
        port,
        &Post {
            fields: vec![format!("{LISTEN_HEADER}: ?0")],
            ..Post::default()
        },
    )
    .await;

    assert_eq!(
        (
            declined.head.status,
            declined.head.fields.get(LISTEN_HEADER).cloned()
        ),
        (201, None),
        "declined"
    );
    assert!(
        !started
            .server
            .is_two_way(&started.server.clients().last().unwrap().connection_handle),
        "one way"
    );
    started.stop().await;
}

#[tokio::test]
async fn stamps_a_connection_s_activity_as_an_exchange_of_an_envelope_or_a_listen_begins_never_at_its_connect_nor_at_a_listen_refused()
 {
    let at = SystemTime::UNIX_EPOCH
        .checked_add(Duration::from_millis(1_000_250))
        .unwrap();
    let clock = SteppingClock::new(at);
    let started = stepped(&clock, &HttpTransportServerOptions::default()).await;
    let port = started.port;
    let stamps_of = || {
        started
            .server
            .clients()
            .iter()
            .map(|client| client.last_activity)
            .collect::<Vec<_>>()
    };
    let (_, deaf) = connect(&started).await;
    let (_, listening) = connect_listening(&started).await;

    assert_eq!(
        (
            answered(&listen_of(port, (&deaf, (Some("0"), None))).await)
                .await
                .0,
            stamps_of()
        ),
        (409, vec![None, None]),
        "neither stamped"
    );

    // an envelope's, as its exchange begins: not as its body ends
    clock.advance(Duration::from_secs(1)).await;

    let mut coming = RawSocket::on(port).await;

    coming
        .write(post_head_of(port, (&listening, 8)).as_bytes())
        .await
        .unwrap();
    until(|| stamps_of()[1].is_some()).await;
    clock.advance(Duration::from_secs(1)).await;
    coming.write(&envelope_of(RESULT, (2, 0))).await.unwrap();

    let after = |milliseconds: u64| at.checked_add(Duration::from_millis(milliseconds));

    assert_eq!(
        (
            coming.head(PATIENCE).await.map(|head| head.status),
            stamps_of()
        ),
        (Some(204), vec![None, after(1_000)]),
        "stamped as it began"
    );

    // a listen's, as it is held
    clock.advance(Duration::from_secs(1)).await;
    answered(&listen_of(port, (&listening, (Some("0"), Some("0")))).await).await;

    assert_eq!(
        stamps_of(),
        vec![None, after(3_000)],
        "stamped by its listen"
    );
    started.stop().await;
}

#[tokio::test]
async fn tells_a_listen_held_once_past_its_refusals_and_its_end_while_its_connection_stands_one_refused_tells_nothing_and_restarts_nothing_and_a_second_and_the_first_it_replaces_each_tell_theirs()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = stepped(
        &clock,
        &HttpTransportServerOptions {
            inactivity_timeout: Some(Duration::from_secs(2)),
            ..HttpTransportServerOptions::default()
        },
    )
    .await;
    let port = started.port;
    let (_, deaf) = connect(&started).await;
    let (handle, token) = connect_listening(&started).await;
    let rested = clock.dues();

    // undeclared, 409, and asking what it cannot, 400: no timer stopped nor armed
    let mut refused = Vec::new();

    for (token, counts) in [
        (deaf.as_str(), (Some("0"), None)),
        (token.as_str(), (Some("0"), Some("soon"))),
        (token.as_str(), (Some("1"), None)),
    ] {
        let listen = listen_of(port, (token, counts)).await;
        let head = listen.head(PATIENCE).await.unwrap();

        refused.push(refusal_of(&head));
    }

    assert_eq!(
        refused,
        vec![
            (409, Some(HTTP_REFUSALS.listen_undeclared.to_owned())),
            (400, Some(HTTP_REFUSALS.malformed.to_owned())),
            (400, Some(HTTP_REFUSALS.malformed.to_owned())),
        ],
        "refused"
    );
    assert_eq!(
        (started.recorder.told().listens, clock.dues()),
        (Vec::new(), rested),
        "nothing told, no timer touched"
    );

    // a second in the place of the first, which ends empty: each tells its own, the second first,
    // so a server's count never falls to none between them
    let first = listen_of(port, (&token, (Some("0"), Some("20000")))).await;

    started
        .recorder
        .until(|told| (told.listens.len() == 1).then_some(()))
        .await;

    let second = listen_of(port, (&token, (Some("0"), Some("20000")))).await;

    assert_eq!(answered(&first).await.0, 204, "the first, empty");
    assert_eq!(
        started
            .recorder
            .until(|told| (told.listens.len() >= 3).then(|| told.listens.clone()))
            .await,
        vec![
            (true, Arc::clone(&handle)),
            (true, Arc::clone(&handle)),
            (false, Arc::clone(&handle))
        ],
        "each told"
    );

    // its connection closed: the listen it held ends untold
    assert!(started.server.close(&handle).await, "closed");
    assert_eq!(answered(&second).await.0, 404, "the second learns it");
    crate::testing::rest(Duration::from_millis(50)).await;
    assert_eq!(
        started.recorder.told().listens.len(),
        3,
        "nothing more told"
    );
    started.stop().await;
}

#[tokio::test]
async fn closes_a_connection_whose_outbox_holds_more_than_its_bound_and_its_listen_learns_it_is_gone()
 {
    let started = started(&HttpTransportServerOptions {
        maximum_outbox_bytes: Some(20),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let (handle, token) = connect_listening(&started).await;
    let envelope = notification((1, 2));

    // 10 bytes, then 20: held
    started.send(&envelope, &handle).await.unwrap();
    started.send(&envelope, &handle).await.unwrap();

    assert!(started.recorder.told().closes.is_empty(), "held");

    // acknowledged, 10 bytes again; then 30: past it
    answered(&listen_of(port, (&token, (Some("2"), Some("0")))).await).await;
    started.send(&envelope, &handle).await.unwrap();

    let held = listen_of(port, (&token, (Some("3"), Some("20000")))).await;

    until(|| gauge(&started.server, "listens") == 1).await;
    started.send(&envelope, &handle).await.unwrap();

    assert_eq!(answered(&held).await.0, 200, "brought back");

    started.send(&envelope, &handle).await.unwrap();
    started.send(&envelope, &handle).await.unwrap();

    assert_eq!(
        started.recorder.closes(1).await,
        vec![(false, handle)],
        "dropped"
    );

    // a listen held as its connection closes learns it is gone
    let (other, other_token) = connect_listening(&started).await;
    let waiting = listen_of(port, (&other_token, (Some("0"), Some("20000")))).await;

    until(|| gauge(&started.server, "listens") == 1).await;
    started.server.close(&other).await;

    assert_eq!(
        refusal_of(&waiting.head(PATIENCE).await.unwrap()),
        (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
        "its listen learns it"
    );
    assert_eq!(
        (MAXIMUM_OUTBOX_BYTES, MAXIMUM_WAIT),
        (2 * MAXIMUM_BODY_BYTES, Duration::from_secs(30)),
        "its defaults"
    );
    started.stop().await;
}

// * what waits is a copy by its type: the bytes a send hands over change no more
#[tokio::test]
async fn answers_a_listen_held_once_what_comes_after_or_its_wait_running_out_before_its_response_closes_waits_for_the_next()
 {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = stepped(
        &clock,
        &HttpTransportServerOptions {
            inactivity_timeout: Some(NEVER),
            ..HttpTransportServerOptions::default()
        },
    )
    .await;
    let port = started.port;
    let (handle, token) = connect_listening(&started).await;
    let held = listen_of(port, (&token, (Some("0"), Some("20000")))).await;
    let first = notification((1, 0));
    let second = notification((3, 0));
    let third = notification((5, 0));

    until(|| gauge(&started.server, "listens") == 1).await;
    started.send(&first, &handle).await.unwrap();
    started.send(&second, &handle).await.unwrap();

    assert_eq!(
        answered(&held).await.2,
        batch_of(&[&first]),
        "the first alone"
    );
    assert!(
        clock.dues().is_empty(),
        "its wait stopped: {:?}",
        clock.dues()
    );

    started.send(&third, &handle).await.unwrap();

    assert_eq!(
        answered(&listen_of(port, (&token, (Some("1"), Some("0")))).await)
            .await
            .2,
        batch_of(&[&second, &third]),
        "the rest, for the next"
    );
    started.stop().await;
}

#[tokio::test]
async fn ends_a_listen_asked_not_to_wait_at_once_with_nothing_arming_no_timer() {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = stepped(
        &clock,
        &HttpTransportServerOptions {
            inactivity_timeout: Some(NEVER),
            ..HttpTransportServerOptions::default()
        },
    )
    .await;
    let (_, token) = connect_listening(&started).await;

    assert_eq!(
        answered(&listen_of(started.port, (&token, (Some("0"), Some("0")))).await)
            .await
            .0,
        204,
        "at once"
    );
    assert!(clock.dues().is_empty(), "no timer: {:?}", clock.dues());
    started.stop().await;
}

#[tokio::test]
async fn keeps_a_notification_for_a_listen_even_on_the_call_id_of_a_request_still_waiting_which_it_never_answers()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let port = started.port;
    let (handle, token) = connect_listening(&started).await;
    let asking = posting(
        port,
        &Post {
            token: Some(&token),
            body: envelope_of(REQUEST, (1, 0)),
            ..Post::default()
        },
    )
    .await;
    let kept = notification((1, 0));

    assert_eq!(asking.head(PATIENCE).await.unwrap().status, 200, "its head");

    started.send(&kept, &handle).await.unwrap();

    assert_eq!(
        answered(&listen_of(port, (&token, (Some("0"), Some("0")))).await)
            .await
            .2,
        batch_of(&[&kept]),
        "kept for a listen"
    );
    assert!(
        asking.response(Duration::from_millis(100)).await.is_err(),
        "its request unanswered"
    );
    started.stop().await;
}

#[tokio::test]
async fn does_not_rest_a_connection_whose_listen_is_held_when_another_of_its_exchanges_ends() {
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = stepped(
        &clock,
        &HttpTransportServerOptions {
            inactivity_timeout: Some(Duration::from_secs(2)),
            ..HttpTransportServerOptions::default()
        },
    )
    .await;
    let port = started.port;
    let (_, token) = connect_listening(&started).await;
    let _held = listen_of(port, (&token, (Some("0"), Some("20000")))).await;

    until(|| clock.dues() == [Duration::from_secs(20)]).await;

    // a cancel, handed on and ended at once: the listen still holds the connection awake, and its
    // body's pace went once it was whole
    let cancel = posted(
        port,
        &Post {
            token: Some(&token),
            body: envelope_of(CANCEL, (1, 0)),
            ..Post::default()
        },
    )
    .await;

    assert_eq!(cancel.head.status, 204, "its cancel");

    let mut dues = clock.dues();

    dues.sort();

    assert_eq!(
        dues,
        vec![Duration::from_secs(5), Duration::from_secs(20)],
        "its burial and its listen's wait, no rest"
    );
    started.stop().await;
}

#[tokio::test]
async fn counts_a_listen_held_as_an_exchange_under_way_its_connection_does_not_rest_while_it_waits()
{
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let started = stepped(
        &clock,
        &HttpTransportServerOptions {
            inactivity_timeout: Some(Duration::from_secs(2)),
            ..HttpTransportServerOptions::default()
        },
    )
    .await;
    let port = started.port;
    let (handle, token) = connect_listening(&started).await;

    assert_eq!(clock.dues(), vec![Duration::from_secs(2)], "its rest");

    let held = listen_of(port, (&token, (Some("0"), Some("20000")))).await;

    // its wait alone, no rest
    until(|| clock.dues() == [Duration::from_secs(20)]).await;
    started.send(&notification((1, 0)), &handle).await.unwrap();

    // answered: the connection rests
    assert_eq!(answered(&held).await.0, 200, "answered");
    until(|| clock.dues() == [Duration::from_secs(2)]).await;
    started.stop().await;
}

#[expect(
    clippy::too_many_lines,
    reason = "each thing it keeps made, then counted, as the other sides' twins count them"
)]
#[tokio::test]
async fn counts_what_it_keeps_of_its_connections_at_the_ceilings_it_has() {
    let started = started(&HttpTransportServerOptions {
        maximum_outbox_bytes: Some(64),
        trusted_proxies: Some(vec![HOST.to_owned()]),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let from = |address: &str, listens: bool| {
        let mut fields = vec![format!("X-Forwarded-For: {address}")];

        if listens {
            fields.push(format!("{LISTEN_HEADER}: ?1"));
        }

        Post {
            fields,
            ..Post::default()
        }
    };
    let drawn = async |post: Post<'_>| {
        let response = posted(port, &post).await;
        let handle = Arc::clone(&started.server.clients().last().unwrap().connection_handle);

        (
            handle,
            response.head.fields[CONNECTION_TOKEN_HEADER].clone(),
        )
    };
    let (listening, listening_token) = connect_listening(&started).await;
    let (queued, _) = drawn(from("10.0.0.1", true)).await;
    let (other, other_token) = drawn(from("10.0.0.2", false)).await;
    let (smaller, _) = drawn(from("10.0.0.1", true)).await;
    // a request waiting, a cancel before its request, a body still coming, a listen held, and an
    // outbox of two envelopes
    let asking = posting(
        port,
        &Post {
            token: Some(&other_token),
            body: envelope_of(REQUEST, (1, 0)),
            ..Post::default()
        },
    )
    .await;

    asking.head(PATIENCE).await.unwrap();
    posted(
        port,
        &Post {
            token: Some(&other_token),
            body: envelope_of(CANCEL, (3, 0)),
            ..Post::default()
        },
    )
    .await;

    let mut coming = RawSocket::on(port).await;

    coming
        .write(post_head_of(port, (&other_token, 8)).as_bytes())
        .await
        .unwrap();
    coming.write(&[0xA1, 0x10, 0, 0]).await.unwrap();

    let _held = listen_of(port, (&listening_token, (Some("0"), Some("20000")))).await;

    started.send(&notification((1, 0)), &queued).await.unwrap();
    started.send(&notification((3, 4)), &queued).await.unwrap();
    started.send(&notification((5, 0)), &smaller).await.unwrap();
    until(|| gauge(&started.server, "bodyBytes") == 4 && gauge(&started.server, "listens") == 1)
        .await;

    let gauges = started.server.gauges().unwrap();
    let mut handles = vec![listening, queued, other, smaller];
    let mut kept: Vec<_> = gauges.connection_handles.into_iter().collect();

    handles.sort();
    kept.sort();

    assert_eq!(
        gauges
            .ceilings
            .into_iter()
            .collect::<std::collections::BTreeMap<_, _>>(),
        [
            ("bodyBytes", BODY_BYTES_BUDGET),
            ("connections", MAXIMUM_CONNECTIONS),
            ("largestAddressConnections", MAXIMUM_CONNECTIONS_PER_ADDRESS),
            ("largestOutboxBytes", 64),
        ]
        .into_iter()
        .collect(),
        "its ceilings"
    );
    assert_eq!(kept, handles, "its connections");
    assert_eq!(
        gauges
            .counts
            .into_iter()
            .collect::<std::collections::BTreeMap<_, _>>(),
        [
            ("addresses", 3),
            ("bodyBytes", 4),
            ("buriedCallIds", 1),
            ("connections", 4),
            ("http2Sessions", 0),
            ("largestAddressConnections", 2),
            ("largestOutboxBytes", 20),
            ("listens", 1),
            ("outboxBytes", 28),
            ("outboxEnvelopes", 3),
            ("waitingExchanges", 1),
        ]
        .into_iter()
        .collect(),
        "its counts"
    );

    // what a body held goes back as its request ends; what the connections held goes with them
    drop(coming);
    started.stop().await;
    until(|| gauge(&started.server, "bodyBytes") == 0).await;

    let counts = started.server.gauges().unwrap().counts;

    assert_eq!(
        [
            "addresses",
            "connections",
            "largestAddressConnections",
            "listens",
            "outboxBytes",
            "waitingExchanges"
        ]
        .map(|name| counts[name]),
        [0; 6],
        "nothing kept"
    );
}

#[tokio::test]
async fn refuses_a_listen_on_a_connection_gone_404_as_any_exchange_on_it() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (listening, listening_token) = connect_listening(&started).await;
    let (deaf, deaf_token) = connect(&started).await;

    started.server.close(&listening).await;
    started.server.close(&deaf).await;

    for token in [listening_token, deaf_token] {
        let head = listen_of(started.port, (&token, (Some("0"), Some("20000"))))
            .await
            .head(PATIENCE)
            .await
            .unwrap();

        assert_eq!(
            refusal_of(&head),
            (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
            "gone"
        );
    }

    started.stop().await;
}

#[tokio::test]
async fn drops_a_connection_whose_client_reads_its_listen_s_batch_slower_than_minimum_send_bytes_per_second_and_reports_it()
 {
    let started = started(&HttpTransportServerOptions {
        maximum_outbox_bytes: Some(1 << 30),
        minimum_send_bytes_per_second: Some(1_000_000_000),
        send_grace_period: Some(Duration::from_millis(200)),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let (handle, token) = connect_listening(&started).await;
    // * its client takes nothing of a batch larger than what a loopback's buffers hold
    let mut stalled = RawSocket::reading_little(port).await;

    stalled
        .write(
            head_of(
                ("GET", "/bead"),
                (
                    port,
                    &[
                        &format!("{CONNECTION_TOKEN_HEADER}: {token}"),
                        "bead-after: 0",
                        "bead-wait: 20000",
                    ],
                ),
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    until(|| gauge(&started.server, "listens") == 1).await;
    started
        .send(&notification((2, 67_108_864)), &handle)
        .await
        .unwrap();

    assert_eq!(
        started.recorder.closes(1).await,
        vec![(false, Arc::clone(&handle))],
        "dropped"
    );
    assert_eq!(
        started.recorder.told().errors,
        vec![(
            format!(
                "{handle} is dropped: what waits for its socket was not taken by its deadline, at minimumSendBytesPerSecond 1000000000 past sendGracePeriod 200 ms"
            ),
            Some(Arc::clone(&handle))
        )],
        "reported"
    );

    // its exchange lost at its client's end, its connection gone at the server's (spec 15.7)
    assert_eq!(
        refusal_of(
            &listen_of(port, (&token, (Some("0"), Some("0"))))
                .await
                .head(PATIENCE)
                .await
                .unwrap()
        ),
        (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
        "gone"
    );
    drop(stalled);
    started.stop().await;
}

#[tokio::test]
async fn reports_an_outbox_that_passes_maximum_outbox_bytes_as_it_closes_its_connection() {
    let started = started(&HttpTransportServerOptions {
        maximum_outbox_bytes: Some(64),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let (handle, _) = connect_listening(&started).await;

    started.send(&notification((2, 40)), &handle).await.unwrap();
    started.send(&notification((2, 40)), &handle).await.unwrap();
    started.recorder.closes(1).await;

    let told = started.recorder.told();

    assert_eq!(
        (
            told.errors,
            told.closes,
            &told.order[told.order.len() - 2..]
        ),
        (
            vec![(
                format!("{handle} is dropped: its outbox would pass maximumOutboxBytes, 64 bytes"),
                Some(Arc::clone(&handle))
            )],
            vec![(false, Arc::clone(&handle))],
            &["error", "close"][..]
        ),
        "its error, then its close"
    );
    started.stop().await;
}

// spec 15.1
// * an error listener that panics is caught as it tells and its panic dropped, as every side drops
// it: the send settles as with no listener, and the listener after it, its recorder, hears the
// error alone
#[tokio::test]
async fn drops_behind_maximum_outbox_bytes_a_connection_whose_error_listener_throws_telling_its_close_all_the_same_and_dropping_what_it_threw()
 {
    struct Throwing;

    impl crate::transport::ServerListener for Throwing {
        fn on_error(
            &self,
            _error: &crate::router::types::RouterError,
            _connection_handle: Option<&crate::router::types::ConnectionHandle>,
        ) {
            panic!("an error listener that throws");
        }
    }

    let server = HttpTransportServer::new(&HttpTransportServerOptions {
        maximum_outbox_bytes: Some(64),
        ..HttpTransportServerOptions::default()
    })
    .unwrap();
    let recorder = Arc::new(Recorder::default());

    server.listen(Arc::new(Throwing));
    server.listen(Arc::<Recorder>::clone(&recorder));

    let port = server
        .start(&crate::transport::TransportServerStartOptions {
            address: Some(HOST.to_owned()),
            find_open_port: Some(true),
            ..crate::transport::TransportServerStartOptions::default()
        })
        .await
        .unwrap()
        .port;
    let started = Started {
        server,
        recorder,
        port,
    };
    let (handle, token) = connect_listening(&started).await;

    started.send(&notification((2, 40)), &handle).await.unwrap();
    started
        .send(&notification((2, 40)), &handle)
        .await
        .expect("settled");
    started.recorder.closes(1).await;

    let told = started.recorder.told();

    assert_eq!(
        (told.errors, told.closes),
        (
            vec![(
                format!("{handle} is dropped: its outbox would pass maximumOutboxBytes, 64 bytes"),
                Some(Arc::clone(&handle))
            )],
            vec![(false, Arc::clone(&handle))]
        ),
        "its error, then its close"
    );
    assert!(started.server.clients().is_empty(), "gone");
    assert_eq!(
        refusal_of(
            &posted(
                port,
                &Post {
                    token: Some(&token),
                    body: envelope_of(REQUEST, (3, 0)),
                    ..Post::default()
                }
            )
            .await
            .head
        ),
        (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
        "after it"
    );
    started.stop().await;
}
