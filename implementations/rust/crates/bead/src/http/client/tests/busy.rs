//! A server busy or a router behind (spec 15.6, 15.12): an envelope that is no request sent again
//! once its `Retry-After` passed, and a client paused by its router.

use super::*;
use crate::clock::Clock;
use crate::duration::LONGEST_TIMER;

// a refusal `busy`, its `Retry-After` as given
fn busy(status: u16, retry_after: &str) -> Answer {
    refusal(status, HTTP_REFUSALS.busy).with("retry-after", retry_after)
}

// a client on `clock` of `options`, connected to a server of the tests' own
async fn on_clock_of(clock: &Arc<SteppingClock>, options: &HttpTransportClientOptions) -> Faked {
    connected(
        fake().await,
        &HttpTransportClientOptions {
            clock: Some(on_clock(clock)),
            ..options.clone()
        },
    )
    .await
}

// once a timer of `due` is live on `clock`
async fn armed_for(clock: &SteppingClock, due: Duration) {
    until(|| clock.dues().contains(&due)).await;
}

// a listener that pauses its client as it hears its first message, within the hand
struct Pausing {
    client: HttpTransportClient,
    heard: Mutex<usize>,
}

impl ClientListener for Pausing {
    fn on_message(&self, _message: TransportMessage) {
        let mut heard = locked(&self.heard);

        *heard = heard.saturating_add(1);

        if *heard == 1 {
            drop(heard);
            self.client.pause();
        }
    }
}

// spec 15.6, 15.7, 15.12.8
#[tokio::test]
async fn a_client_sends_again_a_non_request_refused_busy_once_its_retry_after_passed() {
    let clock = stepping_from_2026();
    let faked = on_clock_of(
        &clock,
        &HttpTransportClientOptions {
            exchange_timeout: Some(Duration::from_secs(10)),
            ..not_listening()
        },
    )
    .await;
    let fake = &faked.fake;

    // * a cancel refused 429, then 503 with a date: sent again each time its Retry-After passed
    let cancelled = envelope_of(crate::http::fields::CANCEL, (1, 0));
    let is_settled = Arc::new(Mutex::new(false));
    let settling = Arc::clone(&is_settled);
    let resending = sending(&faked.client, envelope(cancelled.clone()));
    let resending = spawn(async move {
        let outcome = resending.await;

        *locked(&settling) = true;
        outcome
    });

    fake.call_of(1).await.answer(&busy(429, "2"));
    armed_for(&clock, Duration::from_secs(2)).await;
    clock.advance(Duration::from_millis(1_999)).await;

    assert_eq!((fake.count(), *locked(&is_settled)), (2, false), "not yet");

    clock.advance(Duration::from_millis(1)).await;

    let in_three =
        httpdate::fmt_http_date(clock.wall().checked_add(Duration::from_secs(3)).unwrap());

    fake.call_of(2).await.answer(&busy(503, &in_three));
    armed_for(&clock, Duration::from_secs(3)).await;
    clock.advance(Duration::from_secs(3)).await;
    // * a date far off waits no longer than what is left of its exchange's time
    fake.call_of(3)
        .await
        .answer(&busy(503, "Thu, 01 Jan 2099 00:00:00 GMT"));
    armed_for(&clock, Duration::from_secs(5)).await;
    clock.advance(Duration::from_millis(4_999)).await;

    assert_eq!((fake.count(), *locked(&is_settled)), (4, false), "not yet");

    clock.advance(Duration::from_millis(1)).await;
    fake.call_of(4).await.answer(&Answer::of(204));
    within(resending).await.unwrap().unwrap();

    assert_eq!(
        fake.calls()[1..]
            .iter()
            .map(|call| (call.method.clone(), call.body.clone()))
            .collect::<Vec<(String, Vec<u8>)>>(),
        vec![("POST".to_owned(), cancelled); 4],
        "sent again each time"
    );

    // a request refused busy rejects its send at once: the application decides
    let refused = sending(&faked.client, request(3));

    fake.call_of(5).await.answer(&busy(429, "1"));

    let refused = within(refused).await;

    assert!(
        matches!(&refused, Err(error) if error.to_string() == "the server refused the exchange: 429 busy"),
        "{refused:?}"
    );

    clock.advance(Duration::from_secs(5)).await;

    assert!(fake.makes_no_call_of(6).await, "never sent again");
    assert_eq!(faked.client.ready_state(), ReadyState::Open, "open");

    // * still refused past its exchange timeout from its first send: its exchange lost, and the
    // connection with it
    let lost = sending(&faked.client, cancel(5));

    // * the first with no Retry-After, which waits the server's own second (RFC 9110 §10.2.3)
    for index in 6..17 {
        fake.call_of(index).await.answer(&if index == 6 {
            refusal(429, HTTP_REFUSALS.busy)
        } else {
            busy(429, "1")
        });

        if index < 16 {
            armed_for(&clock, Duration::from_secs(1)).await;
        }

        clock.advance(Duration::from_secs(1)).await;
    }

    let lost = within(lost).await;

    assert!(
        matches!(&lost, Err(error) if error.to_string() == "the server refused the exchange: 429 busy"),
        "{lost:?}"
    );
    assert_eq!(faked.told.closed(1).await, vec![(false, false)], "lost");
    assert_eq!(fake.call_of(17).await.method, "DELETE", "the server told");
}

// spec 15.6, 15.7, 15.12
#[tokio::test]
async fn a_client_whose_exchange_timeout_is_never_sends_again_a_non_request_refused_busy_past_2_31_minus_1_ms()
 {
    let clock = stepping_from_2026();
    let faked = on_clock_of(
        &clock,
        &HttpTransportClientOptions {
            exchange_timeout: Some(NEVER),
            ..not_listening()
        },
    )
    .await;
    let fake = &faked.fake;

    // * a cancel refused busy, its Retry-After past what a timer holds: each wait the longest a
    // timer holds, and sent again past it, its exchange never lost
    let cancelled = envelope_of(crate::http::fields::CANCEL, (1, 0));
    let is_settled = Arc::new(Mutex::new(false));
    let settling = Arc::clone(&is_settled);
    let resending = sending(&faked.client, envelope(cancelled.clone()));
    let resending = spawn(async move {
        let outcome = resending.await;

        *locked(&settling) = true;
        outcome
    });

    for index in 1..3 {
        fake.call_of(index).await.answer(&busy(429, "2147484"));
        until(|| clock.dues() == [LONGEST_TIMER]).await;
        clock
            .advance(LONGEST_TIMER.saturating_sub(Duration::from_millis(1)))
            .await;

        assert_eq!(
            (fake.count(), *locked(&is_settled)),
            (index.saturating_add(1), false),
            "not yet"
        );

        clock.advance(Duration::from_millis(1)).await;
    }

    fake.call_of(3).await.answer(&Answer::of(204));
    within(resending).await.unwrap().unwrap();

    assert_eq!(faked.client.ready_state(), ReadyState::Open, "open");
    assert_eq!(
        fake.calls()[1..]
            .iter()
            .map(|call| (call.method.clone(), call.body.clone()))
            .collect::<Vec<(String, Vec<u8>)>>(),
        vec![("POST".to_owned(), cancelled); 3],
        "sent again past it"
    );
}

// spec 15.12.17
#[tokio::test]
async fn a_paused_http_client_asks_no_listen_and_holds_the_rest_of_a_batch() {
    let faked = connected_listening(&HttpTransportClientOptions::default()).await;
    let envelopes: Vec<Vec<u8>> = [1, 3, 5]
        .into_iter()
        .map(|call_id| envelope_of(crate::http::fields::CANCEL, (call_id, 0)))
        .collect();

    // * a router at its bound pauses within the hand: the rest of the batch it read is held
    faked.client.listen(Arc::new(Pausing {
        client: faked.client.clone(),
        heard: Mutex::new(0),
    }));
    faked.fake.call_of(1).await.answer(&batch(
        1,
        &envelopes.iter().map(Vec::as_slice).collect::<Vec<&[u8]>>(),
    ));
    rest(Duration::from_millis(50)).await;

    assert_eq!(
        (faked.told.heard(), faked.fake.count()),
        (vec![envelopes[0].clone()], 2),
        "the rest held, no listen"
    );

    faked.client.resume();

    assert_eq!(
        faked.told.messages().len(),
        1,
        "handed on from a step of its own"
    );

    // what it held handed on in order, then its listen asked again, acknowledging the batch
    let next = faked.fake.call_of(2).await;

    assert_eq!(faked.told.heard(), envelopes, "in order");
    assert_eq!(next.field(AFTER_HEADER), Some("3"), "acknowledged");
    disconnected(&faked.client, &quick()).await;
}

// spec 15.6
#[tokio::test]
async fn a_non_request_waiting_its_retry_after_as_its_connection_goes_is_sent_no_more() {
    let clock = stepping_from_2026();
    let faked = on_clock_of(&clock, &not_listening()).await;
    let cancelling = sending(&faked.client, cancel(1));

    faked.fake.call_of(1).await.answer(&busy(429, "2"));
    armed_for(&clock, Duration::from_secs(2)).await;
    clock.advance(Duration::from_secs(1)).await;

    // * as any send whose connection drops: settled, and sent no more
    disconnected(&faked.client, &quick()).await;
    clock.advance(Duration::from_secs(5)).await;

    assert!(within(cancelling).await.is_ok(), "settled");

    faked.fake.call_of(2).await;
    rest(WHILE).await;

    assert_eq!(
        faked.fake.methods(),
        ["POST", "POST", "DELETE"],
        "sent no more"
    );
}

// spec 15.12.17
#[tokio::test]
async fn a_paused_http_client_whose_connection_goes_while_it_holds_a_batch_asks_no_listen_after_it()
{
    let faked = connected_listening(&HttpTransportClientOptions::default()).await;

    faked.client.pause();
    faked.fake.call_of(1).await.answer(&batch(
        1,
        &[&envelope_of(crate::http::fields::CANCEL, (1, 0))],
    ));
    rest(Duration::from_millis(50)).await;

    assert_eq!(
        (faked.told.messages().len(), faked.fake.count()),
        (0, 2),
        "held, no listen"
    );

    // * its listen waits on its pause, and ends with its connection: its DELETE alone goes after
    disconnected(&faked.client, &quick()).await;
    faked.client.resume();
    rest(Duration::from_millis(50)).await;

    assert_eq!(
        (faked.told.messages().len(), faked.fake.methods()),
        (
            0,
            vec!["POST".to_owned(), "GET".to_owned(), "DELETE".to_owned()]
        ),
        "its DELETE alone after"
    );
}
