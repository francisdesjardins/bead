//! An exchange of one envelope, its body read under its bounds and its rate, the twin of
//! `http-request-exchange.test.ts` and `HttpTransportServerTests.RequestExchange`.

use core::time::Duration;
use std::sync::Arc;

use crate::http::fields::HTTP_REFUSALS;
use crate::http::peer::*;
use crate::http::server::HttpTransportServerOptions;
use crate::testing::SteppingClock;
use crate::transport::ServerTransport;

// what a server tells of the messages it handed on, by kind
fn kinds_of(told: &Told) -> Vec<u8> {
    told.messages
        .iter()
        .map(|(message, _)| message.data[1])
        .collect()
}

#[tokio::test]
async fn refuses_a_post_with_two_authorization_fields_400_malformed_before_reading_its_body_and_hands_the_router_nothing()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (_, token) = connect(&started).await;

    for second in [BEARER, ""] {
        let response = posted(
            started.port,
            &Post {
                token: Some(&token),
                fields: vec![
                    format!("Authorization: {BEARER}"),
                    format!("Authorization: {second}"),
                ],
                body: envelope_of(REQUEST, (1, 0)),
                ..Post::default()
            },
        )
        .await;

        assert_eq!(
            (
                refusal_of(&response.head),
                response.head.fields.get("connection").cloned()
            ),
            (
                (400, Some(HTTP_REFUSALS.malformed.to_owned())),
                Some("close".to_owned())
            ),
            "two Authorization fields, the second {second:?}"
        );
    }

    assert!(
        started.recorder.told().messages.is_empty(),
        "nothing handed on"
    );
    started.stop().await;
}

#[tokio::test]
async fn refuses_a_body_past_its_limit_413_declared_or_counted_and_hands_the_router_nothing() {
    let started = started(&HttpTransportServerOptions {
        maximum_body_bytes: Some(64),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let (_, token) = connect(&started).await;
    let declared = posted(
        started.port,
        &Post {
            token: Some(&token),
            body: envelope_of(REQUEST, (1, 57)),
            ..Post::default()
        },
    )
    .await;
    let mut counted = RawSocket::on(started.port).await;

    counted
        .write(chunked_head_of(started.port, &token).as_bytes())
        .await
        .unwrap();
    counted
        .write(&chunk_of(&envelope_of(REQUEST, (3, 40))))
        .await
        .ok();
    counted.write(&chunk_of(&[0; 40])).await.ok();

    let counted_head = counted.head(PATIENCE).await;

    assert_eq!(
        refusal_of(&declared.head),
        (413, Some(HTTP_REFUSALS.too_large.to_owned())),
        "declared past it"
    );
    // the socket closes behind a 413 on HTTP/1.1: its client may see it, or the reset
    assert!(
        counted_head.as_ref().is_none_or(|head| head.status == 413),
        "counted past it: {counted_head:?}"
    );
    assert!(
        started.recorder.told().messages.is_empty(),
        "nothing handed on"
    );
    started.stop().await;
}

#[tokio::test]
async fn puts_a_body_together_from_as_many_pieces_as_it_comes_in_and_hands_on_one_envelope() {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (_, token) = connect(&started).await;
    let envelope = envelope_of(REQUEST, (1, 70_000));
    let mut socket = RawSocket::on(started.port).await;

    socket
        .write(post_head_of(started.port, (&token, envelope.len())).as_bytes())
        .await
        .unwrap();

    for piece in envelope.chunks(1_000) {
        socket.write(piece).await.unwrap();
    }

    let messages = started.recorder.messages(1).await;

    assert_eq!(
        messages
            .iter()
            .map(|(message, _)| message.data.to_vec())
            .collect::<Vec<_>>(),
        vec![envelope],
        "one envelope"
    );
    started.stop().await;
}

#[tokio::test]
async fn ends_an_upload_whose_cancel_came_as_it_came_never_handing_it_on_and_one_past_its_limit_reading_no_more_of_it()
 {
    let started = started(&HttpTransportServerOptions {
        maximum_body_bytes: Some(64),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let (_, token) = connect(&started).await;
    let request = envelope_of(REQUEST, (1, 40));
    let cancel = || Post {
        token: Some(&token),
        body: envelope_of(CANCEL, (1, 0)),
        ..Post::default()
    };
    let mut upload = RawSocket::on(started.port).await;

    upload
        .write(post_head_of(started.port, (&token, request.len())).as_bytes())
        .await
        .unwrap();
    upload.write(&request[..16]).await.unwrap();
    until(|| gauge(&started.server, "waitingExchanges") == 1).await;

    let cancelled = posted(started.port, &cancel()).await;

    upload.write(&request[16..]).await.unwrap();

    assert_eq!(
        (
            cancelled.head.status,
            upload.head(PATIENCE).await.map(|head| head.status)
        ),
        (204, Some(204)),
        "the cancel and its upload, each 204"
    );

    // cancelled, and still coming past the limit: refused, its socket closed in stages, and what
    // comes after dropped
    for size in [40, 64] {
        let mut endless = RawSocket::on(started.port).await;

        endless
            .write(chunked_head_of(started.port, &token).as_bytes())
            .await
            .unwrap();
        endless.write(&chunk_of(&request[..16])).await.unwrap();
        until(|| gauge(&started.server, "waitingExchanges") == 1).await;

        assert_eq!(
            posted(started.port, &cancel()).await.head.status,
            204,
            "its cancel"
        );

        endless.write(&chunk_of(&vec![0; size])).await.unwrap();

        if size == 40 {
            until(|| gauge(&started.server, "bodyBytes") == 56).await;
        }

        endless.write(&chunk_of(&vec![0; size])).await.ok();

        let head = endless.head(PATIENCE).await.expect("its refusal");

        assert_eq!(
            (refusal_of(&head), head.fields.get("connection").cloned()),
            (
                (413, Some(HTTP_REFUSALS.too_large.to_owned())),
                Some("close".to_owned())
            ),
            "refused past its limit, {size} bytes a chunk"
        );
        // * its socket closes in stages: still written to as it lingers
        assert!(
            endless.write(&chunk_of(&[0; 8])).await.is_ok(),
            "its socket open as it lingers"
        );
    }

    assert_eq!(
        kinds_of(&started.recorder.told()),
        vec![CANCEL, CANCEL, CANCEL],
        "the cancels alone handed on"
    );
    started.stop().await;
}

// spec 15.12.4
#[tokio::test]
async fn reads_a_body_up_to_its_limit_exactly_declared_or_counted_refuses_one_declared_past_it_before_any_of_it_and_gives_back_the_bytes_each_held()
 {
    let started = started(&HttpTransportServerOptions {
        body_bytes_budget: Some(24),
        maximum_body_bytes: Some(16),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let (_, token) = connect(&started).await;
    let mut declared = RawSocket::on(port).await;
    let mut past = RawSocket::on(port).await;

    declared
        .write(post_head_of(port, (&token, 16)).as_bytes())
        .await
        .unwrap();
    past.write(post_head_of(port, (&token, 17)).as_bytes())
        .await
        .unwrap();

    // the one past its limit is refused as it comes; the one at it waits for its body
    assert_eq!(
        past.head(PATIENCE).await.map(|head| head.status),
        Some(413),
        "past its limit"
    );
    assert!(
        declared.head(Duration::from_millis(100)).await.is_none(),
        "the one at its limit waits"
    );

    declared.write(&envelope_of(REQUEST, (1, 8))).await.unwrap();

    // counted, with no length declared: its 16 bytes, once the first 16 were given back
    let mut counted = RawSocket::on(port).await;

    counted
        .write(chunked_head_of(port, &token).as_bytes())
        .await
        .unwrap();
    counted
        .write(&chunk_of(&envelope_of(REQUEST, (3, 0))))
        .await
        .unwrap();
    counted.write(&chunk_of(&[0; 8])).await.unwrap();
    counted.write(b"0\r\n\r\n").await.unwrap();

    assert_eq!(
        (
            declared.head(PATIENCE).await.map(|head| head.status),
            counted.head(PATIENCE).await.map(|head| head.status)
        ),
        (Some(200), Some(200)),
        "each handed on, its head going 40 ms after"
    );
    assert_eq!(started.recorder.messages(2).await.len(), 2, "two handed on");

    // up to the budget exactly, across exchanges: 8 bytes held, and 16 more
    let mut holding = RawSocket::on(port).await;

    holding
        .write(post_head_of(port, (&token, 16)).as_bytes())
        .await
        .unwrap();
    holding.write(&envelope_of(REQUEST, (5, 0))).await.unwrap();
    until(|| gauge(&started.server, "bodyBytes") == 8).await;

    let mut filling = RawSocket::on(port).await;

    filling
        .write(post_head_of(port, (&token, 16)).as_bytes())
        .await
        .unwrap();
    filling.write(&envelope_of(REQUEST, (7, 8))).await.unwrap();

    assert_eq!(
        filling.head(PATIENCE).await.map(|head| head.status),
        Some(200),
        "filling the budget"
    );
    until(|| gauge(&started.server, "bodyBytes") == 8).await;
    assert_eq!(
        started.recorder.messages(3).await.len(),
        3,
        "three handed on"
    );

    holding.write(&[0; 8]).await.unwrap();

    assert_eq!(
        holding.head(PATIENCE).await.map(|head| head.status),
        Some(200),
        "the one held, whole"
    );
    until(|| gauge(&started.server, "bodyBytes") == 0).await;
    assert_eq!(
        started.recorder.messages(4).await.len(),
        4,
        "four handed on"
    );
    started.stop().await;
}

#[tokio::test]
async fn answers_a_request_an_answer_comes_for_as_its_body_still_comes_at_once_never_handing_it_on()
{
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;
    let request = envelope_of(REQUEST, (1, 8));
    let answer = envelope_of(RESULT, (1, 0));
    let mut socket = RawSocket::on(started.port).await;

    socket
        .write(post_head_of(started.port, (&token, request.len())).as_bytes())
        .await
        .unwrap();
    socket.write(&request[..12]).await.unwrap();
    until(|| gauge(&started.server, "waitingExchanges") == 1).await;
    started.send(&answer, &handle).await.unwrap();

    let response = socket.response(PATIENCE).await.expect("its answer");

    assert_eq!(
        (
            response.head.status,
            response.body.clone(),
            response.head.fields.get("connection").cloned()
        ),
        (200, answer, Some("close".to_owned())),
        "answered at once, its socket closing"
    );

    // the rest of it changes nothing: it is never handed on
    socket.write(&request[12..]).await.ok();

    assert!(socket.ended(PATIENCE).await, "its socket closed in stages");
    assert!(
        started.recorder.told().messages.is_empty(),
        "nothing handed on"
    );
    started.stop().await;
}

#[tokio::test]
async fn finishes_an_exchange_with_two_authorization_fields_400_one_declared_past_its_limit_413_and_one_its_connection_cannot_take_429_before_it_reads_a_byte()
 {
    let started = started(&HttpTransportServerOptions {
        maximum_body_bytes: Some(16),
        maximum_waiting_exchanges: Some(1),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let (_, token) = connect(&started).await;
    let head_with = |fields: &[&str]| {
        let mut lines = vec![
            format!("Content-Type: {BEAD_MEDIA_TYPE}"),
            format!("{CONNECTION_TOKEN_HEADER}: {token}"),
        ];

        lines.extend(fields.iter().map(|field| (*field).to_owned()));

        head_of(
            ("POST", "/bead"),
            (port, &lines.iter().map(String::as_str).collect::<Vec<_>>()),
        )
    };
    let twice = format!("Authorization: {BEARER}");
    let mut ends = Vec::new();

    for fields in [
        vec![twice.as_str(), twice.as_str(), "Content-Length: 16"],
        vec!["Content-Length: 17"],
    ] {
        let mut socket = RawSocket::on(port).await;

        socket.write(head_with(&fields).as_bytes()).await.unwrap();
        ends.push(refusal_of(&socket.head(PATIENCE).await.expect("its end")));
    }

    // two exchanges under way, which its connection takes at most, each before a byte of it
    let mut open = Vec::new();

    for _ in 0..2 {
        let mut socket = RawSocket::on(port).await;

        socket
            .write(head_with(&["Content-Length: 16"]).as_bytes())
            .await
            .unwrap();
        open.push(socket);
    }

    until(|| gauge(&started.server, "bodyBytes") == 0).await;

    let mut third = RawSocket::on(port).await;

    third
        .write(head_with(&["Content-Length: 16"]).as_bytes())
        .await
        .unwrap();

    let busy = third.head(PATIENCE).await.expect("its refusal");

    ends.push(refusal_of(&busy));
    drop(open);

    assert_eq!(
        ends,
        vec![
            (400, Some(HTTP_REFUSALS.malformed.to_owned())),
            (413, Some(HTTP_REFUSALS.too_large.to_owned())),
            (429, Some(HTTP_REFUSALS.busy.to_owned())),
        ],
        "each finished before a byte"
    );
    // * told when to come back, which a client waits for before it sends again (spec 15.6)
    assert_eq!(
        busy.fields.get("retry-after").map(String::as_str),
        Some("1"),
        "its Retry-After"
    );
    started.stop().await;
}

#[tokio::test]
async fn refuses_408_too_slow_a_body_that_comes_slower_than_its_rate_once_its_grace_passed_its_client_reading_the_408_as_it_goes_on_sending_and_keeps_its_connection_a_body_at_its_rate_taken()
 {
    let clock = SteppingClock::new(std::time::SystemTime::UNIX_EPOCH);
    let started = started(&HttpTransportServerOptions {
        body_grace_period: Some(Duration::from_secs(1)),
        clock: Some(Arc::<SteppingClock>::clone(&clock)),
        minimum_body_bytes_per_second: Some(1_000),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let (handle, token) = connect(&started).await;
    let body_bytes = || gauge(&started.server, "bodyBytes");
    let trickled = envelope_of(REQUEST, (1, 4_000));
    let mut slow = RawSocket::on(port).await;

    slow.write(post_head_of(port, (&token, trickled.len())).as_bytes())
        .await
        .unwrap();
    slow.write(&trickled[..12]).await.unwrap();
    until(|| body_bytes() == 12).await;

    // its grace passed with 12 bytes: refused as it goes on sending
    clock.advance(Duration::from_secs(1)).await;
    slow.write(&trickled[12..2_000]).await.ok();

    let head = slow.head(PATIENCE).await.expect("its refusal");

    assert_eq!(
        (refusal_of(&head), head.fields.get("connection").cloned()),
        (
            (408, Some(HTTP_REFUSALS.too_slow.to_owned())),
            Some("close".to_owned())
        ),
        "too slow"
    );

    slow.write(&trickled[2_000..]).await.ok();

    assert!(slow.ended(PATIENCE).await, "its socket closed");

    let told = started.recorder.told();

    assert_eq!(
        told.refusals
            .iter()
            .map(|refusal| (refusal.status, refusal.reason.clone()))
            .collect::<Vec<_>>(),
        vec![(408, HTTP_REFUSALS.too_slow.to_owned())],
        "the refusal told"
    );
    assert_eq!(
        (body_bytes(), told.messages.len(), told.closes.len()),
        (0, 0, 0),
        "nothing held, handed on or closed"
    );

    // its Bead connection kept: a body that comes at its rate is taken, and answered
    let request = envelope_of(REQUEST, (3, 3_000));
    let mut paced = RawSocket::on(port).await;

    paced
        .write(post_head_of(port, (&token, request.len())).as_bytes())
        .await
        .unwrap();
    paced.write(&request[..1_000]).await.unwrap();
    until(|| body_bytes() == 1_000).await;
    clock.advance(Duration::from_millis(900)).await;
    paced.write(&request[1_000..2_000]).await.unwrap();
    until(|| body_bytes() == 2_000).await;
    clock.advance(Duration::from_secs(1)).await;
    paced.write(&request[2_000..]).await.unwrap();
    started.recorder.messages(1).await;
    started
        .send(&envelope_of(RESULT, (3, 0)), &handle)
        .await
        .unwrap();

    assert_eq!(
        paced.head(PATIENCE).await.map(|head| head.status),
        Some(200),
        "taken at its rate"
    );
    assert_eq!(started.recorder.told().refusals.len(), 1, "one refusal");
    started.stop().await;
}

#[tokio::test]
async fn closes_in_stages_every_answer_written_before_its_body_is_whole_so_a_client_that_sends_at_full_speed_reads_it_and_its_connection_then_answers_a_post()
 {
    let started = started(&HttpTransportServerOptions {
        maximum_body_bytes: Some(16_000_000),
        ..HttpTransportServerOptions::default()
    })
    .await;
    let port = started.port;
    let (handle, token) = connect(&started).await;

    // a 413 to a body declared past its limit, written before any of it is read
    let mut large = Pumped::on(
        port,
        (
            post_head_of(port, (&token, 67_108_864)).as_bytes(),
            67_108_864,
        ),
    )
    .await;
    let head = large.head(PATIENCE).await.expect("its 413");

    assert_eq!(
        (head.status, head.fields.get("connection").cloned()),
        (413, Some("close".to_owned())),
        "refused before its body"
    );
    assert!(large.ended(PATIENCE).await, "its socket closed in stages");

    // its connection answers a POST after it
    let answered = posting(
        port,
        &Post {
            token: Some(&token),
            body: envelope_of(REQUEST, (1, 0)),
            ..Post::default()
        },
    )
    .await;

    started.recorder.messages(1).await;
    started
        .send(&envelope_of(RESULT, (1, 0)), &handle)
        .await
        .unwrap();

    assert_eq!(
        answered.response(PATIENCE).await.unwrap().head.status,
        200,
        "answered after it"
    );

    // a 404 to a body still coming as its connection closes
    let request = envelope_of(REQUEST, (3, 0));
    let mut head = post_head_of(port, (&token, 15_000_000)).into_bytes();

    head.extend_from_slice(&request);

    let mut coming = Pumped::on(port, (&head, 14_000_000)).await;

    until(|| gauge(&started.server, "bodyBytes") >= 8).await;
    started.server.close(&handle).await;

    let head = coming.head(PATIENCE).await.expect("its 404");

    assert_eq!(
        (refusal_of(&head), head.fields.get("connection").cloned()),
        (
            (404, Some(HTTP_REFUSALS.connection_unknown.to_owned())),
            Some("close".to_owned())
        ),
        "its connection gone"
    );
    assert!(coming.ended(PATIENCE).await, "its socket closed in stages");
    started.stop().await;
}

#[tokio::test]
async fn answers_a_body_whose_read_fails_a_malformed_chunked_one_the_status_of_its_failure_unmarked_its_connection_closed_never_200_and_empty()
 {
    let started = started(&HttpTransportServerOptions::default()).await;
    let (handle, token) = connect(&started).await;
    let mut socket = RawSocket::on(started.port).await;

    socket
        .write(chunked_head_of(started.port, &token).as_bytes())
        .await
        .unwrap();
    socket.write(b"8\r\n").await.unwrap();
    socket.write(&envelope_of(REQUEST, (1, 0))).await.unwrap();
    until(|| gauge(&started.server, "bodyBytes") == 8).await;
    // a chunk size that is none
    socket.write(b"\r\nzz\r\n").await.unwrap();

    let head = socket.head(PATIENCE).await.expect("its 400");

    assert_eq!(refusal_of(&head), (400, None), "unmarked");
    assert!(socket.ended(PATIENCE).await, "its socket closed");
    // the exchange lost, as a dropped socket's, which closes its connection; nothing handed on
    assert_eq!(
        started.recorder.closes(1).await,
        vec![(false, handle)],
        "its connection closed"
    );
    assert_eq!(
        (
            started.recorder.told().messages.len(),
            gauge(&started.server, "bodyBytes")
        ),
        (0, 0),
        "nothing handed on or held"
    );
    started.stop().await;
}
