//! Its listens (spec 15.9, 15.10): what the server sends of its own, heard by a listen at its
//! connection's URL, a listen lost listened again, and what ends its connection.

use super::*;
use crate::clock::Timer;
use crate::http::fields::{FAILURE, RESULT};

// how a clock bends a stepping one: its timers end a millisecond early, or its readings leap an
// hour at each, or stand still
#[derive(Debug, Clone, Copy)]
enum Bend {
    Hasty,
    Leaping,
    Standing,
}

#[derive(Debug)]
struct Bent {
    clock: Arc<SteppingClock>,
    bend: Bend,
    readings: Mutex<u32>,
}

impl Bent {
    fn of(clock: &Arc<SteppingClock>, bend: Bend) -> SharedClock {
        Arc::new(Self {
            clock: Arc::clone(clock),
            bend,
            readings: Mutex::new(0),
        })
    }

    // how far its readings stand from the stepping clock's
    fn leap(&self) -> Duration {
        let mut readings = locked(&self.readings);

        *readings = readings.saturating_add(1);

        Duration::from_secs(3_600).saturating_mul(*readings)
    }
}

impl crate::clock::Clock for Bent {
    fn monotonic(&self) -> Duration {
        match self.bend {
            Bend::Hasty => self.clock.monotonic(),
            Bend::Leaping => self.clock.monotonic().saturating_add(self.leap()),
            Bend::Standing => Duration::ZERO,
        }
    }

    fn wall(&self) -> SystemTime {
        match self.bend {
            Bend::Hasty => self.clock.wall(),
            Bend::Leaping => self.clock.wall().checked_add(self.leap()).unwrap(),
            Bend::Standing => SystemTime::UNIX_EPOCH,
        }
    }

    fn arm(
        &self,
        schedule: Schedule,
        callback: crate::clock::TimerCallback,
    ) -> Result<Arc<dyn Timer>, ProgrammerError> {
        let schedule = match (self.bend, schedule) {
            (Bend::Hasty, Schedule::Once(due)) if due > Duration::from_millis(1) => {
                Schedule::Once(due.saturating_sub(Duration::from_millis(1)))
            }
            (_, schedule) => schedule,
        };

        self.clock.arm(schedule, callback)
    }
}

// a client that listens on a server of the tests' own, on `clock`
async fn listening_on(clock: &Arc<SteppingClock>, options: &HttpTransportClientOptions) -> Faked {
    connected_listening(&HttpTransportClientOptions {
        clock: Some(on_clock(clock)),
        ..options.clone()
    })
    .await
}

// a client of `options` on a server whose first `lost` listens are lost, connected
async fn losing_on(lost: usize, options: &HttpTransportClientOptions) -> Faked {
    connected(
        fake_of(&losing(lost)).await,
        &HttpTransportClientOptions {
            is_listening: Some(true),
            ..options.clone()
        },
    )
    .await
}

// once `count` timers are live on `clock`
async fn armed(clock: &SteppingClock, count: usize) {
    until(|| clock.dues().len() == count).await;
}

// half of `wait`
fn half(wait: Duration) -> Duration {
    wait.checked_div(2).unwrap()
}

// a batch's head, its envelopes `body`, the first numbered `first`
fn batch_bodied(first: &str, body: &[u8]) -> Answer {
    Answer::of(200)
        .with("content-type", BEAD_BATCH_MEDIA_TYPE)
        .with(SEQUENCE_HEADER, first)
        .carrying(body)
}

// spec 15.10
#[tokio::test]
async fn says_at_connect_that_it_listens_then_listens_a_batch_heard_in_order_acknowledged_by_the_next_listen()
 {
    let faked = connected_listening(&HttpTransportClientOptions {
        wait: Some(Duration::from_secs(1)),
        ..HttpTransportClientOptions::default()
    })
    .await;
    let first = pushed(1);
    let second = envelope_of(0x10, (2, 2));
    let listen = faked.fake.call_of(1).await;

    assert_eq!(
        faked.fake.call_of(0).await.field(LISTEN_HEADER),
        Some("?1"),
        "said at connect"
    );
    assert_eq!(
        (
            listen.method.as_str(),
            listen.target.as_str(),
            listen.field(AFTER_HEADER),
            listen.field(CONNECTION_TOKEN_HEADER),
            listen.field(WAIT_HEADER)
        ),
        ("GET", "/bead", Some("0"), Some(TOKEN), Some("1000")),
        "its listen"
    );

    listen.answer(&batch(1, &[&first, &second]));

    assert_eq!(
        faked.fake.call_of(2).await.field(AFTER_HEADER),
        Some("2"),
        "acknowledged"
    );
    // what a listen brings back carries no credential
    assert_eq!(
        (
            faked.told.heard(),
            faked
                .told
                .messages()
                .iter()
                .map(|message| message.credential.clone())
                .collect::<Vec<Option<String>>>()
        ),
        (vec![first, second], vec![None, None]),
        "heard in order"
    );

    // nothing, and it listens again at the same point
    faked.fake.call_of(2).await.answer(&Answer::of(204));

    let next = faked.fake.call_of(3).await;

    assert_eq!(next.field(AFTER_HEADER), Some("2"), "at the same point");
    disconnected(&faked.client, &quick()).await;
    assert!(next.is_aborted().await, "its listen let go of");
    assert_eq!(WAIT, Duration::from_secs(25), "its wait");
}

// spec 15.9
#[tokio::test]
async fn listens_at_its_connection_s_url_alone_its_cursor_in_bead_after_and_its_wait_in_bead_wait()
{
    let fake = fake().await;
    let client = client_of(&HttpTransportClientOptions {
        wait: Some(Duration::ZERO),
        ..HttpTransportClientOptions::default()
    });
    let connecting = client.connect(&HttpTransportClientConnectOptions {
        pathname: Some("/api/bead".to_owned()),
        ..to(fake.port)
    });

    fake.call_of(0).await.answer(&drawn(true));
    settled(connecting).await.unwrap();
    fake.call_of(1).await.answer(&batch(1, &[&pushed(1)]));
    fake.call_of(2).await.answer(&Answer::of(204));
    fake.call_of(3).await;
    disconnected(&client, &quick()).await;
    fake.call_of(4).await;

    // the connect, the listens, the DELETE: one URL, which a browser's preflight cache keys
    let calls = fake.calls();

    assert_eq!(
        calls
            .iter()
            .map(|call| call.target.clone())
            .collect::<std::collections::BTreeSet<String>>(),
        std::iter::once("/api/bead".to_owned()).collect(),
        "one URL"
    );
    assert_eq!(
        calls[1..4]
            .iter()
            .map(|call| (call.field(AFTER_HEADER), call.field(WAIT_HEADER)))
            .collect::<Vec<(Option<&str>, Option<&str>)>>(),
        vec![
            (Some("0"), Some("0")),
            (Some("1"), Some("0")),
            (Some("1"), Some("0")),
        ],
        "its cursor and its wait"
    );
}

#[tokio::test]
async fn reads_the_201_s_bead_listen_and_a_batch_s_bead_sequence_as_rfc_9651_items_their_parameters_ignored()
 {
    let fake = fake().await;
    let client = client_of(&HttpTransportClientOptions::default());
    let told = recorded(&client);
    let connecting = client.connect(&to(fake.port));
    let envelope = pushed(1);

    fake.call_of(0)
        .await
        .answer(&drawn(false).with(LISTEN_HEADER, "?1;x"));
    settled(connecting).await.unwrap();
    fake.call_of(1)
        .await
        .answer(&batch_bodied("1;x=2", &batch_of(&[&envelope])));

    assert_eq!(
        fake.call_of(2).await.field(AFTER_HEADER),
        Some("1"),
        "acknowledged"
    );
    assert_eq!(told.heard(), vec![envelope], "heard");
    disconnected(&client, &quick()).await;
}

#[tokio::test]
async fn marks_what_a_listen_brings_back_as_what_may_overtake_and_never_what_a_post_s_body_brings()
{
    let faked = connected_listening(&HttpTransportClientOptions {
        wait: Some(Duration::from_secs(1)),
        ..HttpTransportClientOptions::default()
    })
    .await;
    let call_by = async |method: &str| {
        let fake = &faked.fake;

        until(|| {
            fake.calls()
                .iter()
                .skip(1)
                .any(|call| call.method == method)
        })
        .await;
        fake.calls()
            .into_iter()
            .skip(1)
            .find(|call| call.method == method)
            .unwrap()
    };
    let sending = sending(&faked.client, request(1));

    call_by("POST")
        .await
        .answer(&bead(&envelope_of(RESULT, (1, 0))));
    within(sending).await.unwrap();
    until(|| faked.told.messages().len() == 1).await;
    call_by("GET").await.answer(&batch(
        1,
        &[
            &envelope_of(RESULT, (3, 0)),
            &envelope_of(FAILURE, (3, 0)),
            &pushed(1),
        ],
    ));
    until(|| faked.told.messages().len() == 4).await;

    assert_eq!(
        faked
            .told
            .messages()
            .iter()
            .map(|message| message.may_overtake)
            .collect::<Vec<bool>>(),
        [false, true, true, true],
        "its marks"
    );
    disconnected(&faked.client, &quick()).await;
}

// spec 15.10
#[tokio::test]
async fn listens_again_from_where_it_was_when_a_listen_is_lost_at_once_then_later_and_later_drawn_apart_and_one_that_reaches_the_server_ends_the_losses()
 {
    let clock = stepping();
    let faked = listening_on(&clock, &HttpTransportClientOptions::default()).await;
    let fake = &faked.fake;
    let envelope = pushed(1);
    // what the listens arm: the inactivity timeout at the first loss of each count, then the waits
    // between, each read as it is armed
    let mut delays = Vec::new();

    // each wait drawn between half of what it may be and all of it: short of its half, no listen;
    // at all of it, the next
    let wait_out = async |wait: Duration, delays: &mut Vec<Duration>| {
        let calls = fake.count();

        armed(&clock, 2).await;
        delays.push(clock.dues()[1]);
        clock
            .advance(half(wait).saturating_sub(Duration::from_millis(1)))
            .await;

        assert_eq!(fake.count(), calls, "none short of its half");

        clock
            .advance(half(wait).saturating_add(Duration::from_millis(1)))
            .await;
        fake.call_of(calls).await;
    };

    fake.call_of(1).await.fail();
    fake.call_of(2).await;
    armed(&clock, 1).await;
    delays.push(clock.dues()[0]);

    for (losses, wait) in [
        (2, 1_000),
        (3, 2_000),
        (4, 4_000),
        (5, 8_000),
        (6, 16_000),
        (7, 30_000),
        (8, 30_000),
    ] {
        let last = fake.call_of(fake.count().saturating_sub(1)).await;

        // a batch cut before anything came whole is a loss as well
        if losses == 3 {
            let framed = batch_of(&[&envelope]);

            last.answer(
                &batch_bodied("1", &[])
                    .with("content-length", &framed.len().to_string())
                    .ending(Ending::Cut),
            );
        } else {
            last.fail();
        }

        wait_out(Duration::from_millis(wait), &mut delays).await;
    }

    // a 200 of another type — a proxy's page — is lost too, its body unread: one never ended,
    // which a client that read it would wait on
    fake.call_of(fake.count().saturating_sub(1)).await.answer(
        &Answer::of(200)
            .with("content-type", "text/html")
            .carrying(b"<html>")
            .later(),
    );
    wait_out(Duration::from_secs(30), &mut delays).await;

    // it reaches the server: the losses end, and the next is listened again at once
    fake.call_of(10).await.answer(&Answer::of(204));
    fake.call_of(11).await.fail();
    fake.call_of(12).await;
    armed(&clock, 1).await;
    delays.push(clock.dues()[0]);

    let waits =
        [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000].map(Duration::from_millis);

    assert_eq!(
        (delays[0], *delays.last().unwrap(), delays.len()),
        (INACTIVITY_TIMEOUT, INACTIVITY_TIMEOUT, 10),
        "the inactivity timeout armed at the first loss of each count"
    );
    assert!(
        delays[1..9]
            .iter()
            .zip(waits)
            .all(|(delay, wait)| *delay >= half(wait) && *delay <= wait),
        "each within its bounds: {delays:?}"
    );
    assert!(
        delays[1..9].iter().zip(waits).any(|(delay, wait)| {
            *delay > half(wait).saturating_add(Duration::from_millis(1)) && *delay < wait
        }),
        "drawn apart: {delays:?}"
    );
    assert_eq!(
        (faked.client.ready_state(), fake.count()),
        (ReadyState::Open, 13),
        "open"
    );

    // what was cut on its way comes whole at last, and is heard once
    fake.call_of(12).await.answer(&batch(1, &[&envelope]));

    assert_eq!(
        fake.call_of(13).await.field(AFTER_HEADER),
        Some("1"),
        "from there"
    );
    assert_eq!(faked.told.heard(), vec![envelope], "heard once");
    assert_eq!(
        (FIRST_RETRY, RETRY_CEILING),
        (Duration::from_secs(1), Duration::from_secs(30)),
        "its retries"
    );
    disconnected(&faked.client, &quick()).await;
}

// spec 15.10
#[tokio::test]
async fn counts_its_connection_lost_once_its_listens_were_lost_for_its_inactivity_timeout_and_tells_the_server()
 {
    let clock = stepping();
    let options = HttpTransportClientOptions {
        clock: Some(on_clock(&clock)),
        inactivity_timeout: Some(Duration::from_millis(40)),
        ..HttpTransportClientOptions::default()
    };
    let faked = losing_on(usize::MAX, &options).await;

    // its last wait ends at its timeout, never after it
    until(|| faked.fake.listens() == 2).await;
    armed(&clock, 2).await;
    clock.advance(Duration::from_millis(39)).await;

    assert_eq!(
        (faked.client.ready_state(), faked.fake.listens()),
        (ReadyState::Open, 2),
        "open"
    );

    clock.advance(Duration::from_millis(1)).await;

    assert_eq!(faked.told.closed(1).await, vec![(false, false)], "lost");

    // at once, then no later than its timeout, then no more
    until(|| faked.fake.methods().last().map(String::as_str) == Some("DELETE")).await;
    assert_eq!(faked.fake.listens(), 3, "three listens");
    assert_eq!(INACTIVITY_TIMEOUT, Duration::from_secs(300), "its default");
    armed(&clock, 0).await;

    // a timeout within the second wait's range: whichever is drawn, it ends at its timeout
    for _ in 0..20 {
        let drawn = losing_on(
            usize::MAX,
            &HttpTransportClientOptions {
                inactivity_timeout: Some(Duration::from_millis(700)),
                ..options.clone()
            },
        )
        .await;

        until(|| drawn.fake.listens() == 2).await;
        armed(&clock, 2).await;
        clock.advance(Duration::from_millis(699)).await;

        assert_eq!(drawn.client.ready_state(), ReadyState::Open, "open");

        clock.advance(Duration::from_millis(1)).await;

        assert_eq!(drawn.told.closed(1).await, vec![(false, false)], "lost");
        armed(&clock, 0).await;
    }
}

#[tokio::test]
async fn times_its_inactivity_on_a_timer_never_on_a_reading_of_the_wall_clock_whether_that_leaps_or_goes_back_the_connection_is_lost_at_its_timeout()
 {
    for leap in [3_600_000, -3_600_000] {
        // a wall clock moved an hour at each step — a machine woken from sleep, a clock set — buys
        // nothing and costs nothing: three listens, the last at its timeout
        let clock = stepping_from_2026();
        let faked = losing_on(
            usize::MAX,
            &HttpTransportClientOptions {
                clock: Some(on_clock(&clock)),
                inactivity_timeout: Some(Duration::from_millis(40)),
                ..HttpTransportClientOptions::default()
            },
        )
        .await;

        until(|| faked.fake.listens() == 2).await;
        armed(&clock, 2).await;

        for _ in 0..39 {
            clock.wall_by(leap);
            clock.advance(Duration::from_millis(1)).await;
        }

        assert_eq!(
            (faked.client.ready_state(), faked.fake.listens()),
            (ReadyState::Open, 2),
            "{leap}: open"
        );

        clock.wall_by(leap);
        clock.advance(Duration::from_millis(1)).await;

        assert_eq!(
            faked.told.closed(1).await,
            vec![(false, false)],
            "{leap}: lost"
        );
        until(|| faked.fake.methods().last().map(String::as_str) == Some("DELETE")).await;
        assert_eq!(faked.fake.listens(), 3, "{leap}: three listens");
    }
}

#[tokio::test]
async fn times_its_inactivity_on_a_timer_never_on_its_clock_whether_the_clock_leaps_or_stands_still()
 {
    // a clock that leaps an hour at each reading buys nothing and costs nothing: three listens,
    // the last at its timeout
    let time = stepping();
    let leaping = losing_on(
        usize::MAX,
        &HttpTransportClientOptions {
            clock: Some(Bent::of(&time, Bend::Leaping)),
            inactivity_timeout: Some(Duration::from_millis(40)),
            ..HttpTransportClientOptions::default()
        },
    )
    .await;

    until(|| leaping.fake.listens() == 2).await;
    armed(&time, 2).await;
    time.advance(Duration::from_millis(39)).await;

    assert_eq!(
        (leaping.client.ready_state(), leaping.fake.listens()),
        (ReadyState::Open, 2),
        "open on leaps"
    );

    time.advance(Duration::from_millis(1)).await;

    assert_eq!(
        leaping.told.closed(1).await,
        vec![(false, false)],
        "lost on leaps"
    );
    until(|| leaping.fake.methods().last().map(String::as_str) == Some("DELETE")).await;
    assert_eq!(leaping.fake.listens(), 3, "three listens on leaps");

    // one that stands still holds nothing open past its timeout: whichever wait is drawn, the one
    // under way then is cut, and the listen after it is the last
    let still = stepping();
    let standing = losing_on(
        usize::MAX,
        &HttpTransportClientOptions {
            clock: Some(Bent::of(&still, Bend::Standing)),
            inactivity_timeout: Some(Duration::from_millis(700)),
            ..HttpTransportClientOptions::default()
        },
    )
    .await;

    until(|| standing.fake.listens() == 2).await;
    armed(&still, 2).await;
    still.advance(Duration::from_millis(699)).await;

    assert_eq!(
        standing.client.ready_state(),
        ReadyState::Open,
        "open standing still"
    );

    still.advance(Duration::from_millis(1)).await;

    assert_eq!(
        standing.told.closed(1).await,
        vec![(false, false)],
        "lost standing still"
    );
    until(|| standing.fake.methods().last().map(String::as_str) == Some("DELETE")).await;
}

// its timeout ends on its own timer, so a timer that ends early ends it early, and buys no listen
// more
#[tokio::test]
async fn listens_three_times_within_its_inactivity_timeout_even_on_timers_that_end_early_and_never_a_fourth()
 {
    // a fourth is one too many: told gone, so that a burst ends there
    let time = stepping();
    let faked = losing_on(
        3,
        &HttpTransportClientOptions {
            clock: Some(Bent::of(&time, Bend::Hasty)),
            inactivity_timeout: Some(Duration::from_millis(40)),
            ..HttpTransportClientOptions::default()
        },
    )
    .await;

    until(|| faked.fake.listens() == 2).await;
    armed(&time, 2).await;
    time.advance(Duration::from_millis(38)).await;

    assert_eq!(
        (faked.client.ready_state(), faked.fake.listens()),
        (ReadyState::Open, 2),
        "open"
    );

    time.advance(Duration::from_millis(1)).await;

    assert_eq!(faked.told.closed(1).await, vec![(false, false)], "lost");

    // and nothing after it
    until(|| faked.fake.methods().last().map(String::as_str) == Some("DELETE")).await;
    time.advance(Duration::from_secs(60)).await;
    rest(WHILE).await;

    assert_eq!(
        (
            faked.fake.listens(),
            faked.fake.methods().last().map(String::as_str)
        ),
        (3, Some("DELETE")),
        "never a fourth"
    );
}

#[tokio::test]
async fn a_listen_heard_ends_the_count_and_its_inactivity_timeout_runs_again_from_the_next_first_loss()
 {
    let clock = stepping();
    let faked = listening_on(
        &clock,
        &HttpTransportClientOptions {
            inactivity_timeout: Some(Duration::from_millis(40)),
            ..HttpTransportClientOptions::default()
        },
    )
    .await;
    let fake = &faked.fake;

    // lost, listened again at once, and heard 30 ms later
    fake.call_of(1).await.fail();
    fake.call_of(2).await;
    armed(&clock, 1).await;
    clock.advance(Duration::from_millis(30)).await;
    fake.call_of(2).await.answer(&batch(1, &[&pushed(1)]));
    fake.call_of(3).await;
    armed(&clock, 0).await;

    // past where the first count would have ended, lost twice again
    clock.advance(Duration::from_millis(20)).await;
    fake.call_of(3).await.fail();
    fake.call_of(4).await.fail();
    armed(&clock, 2).await;

    // 40 ms from this first loss, not from the one before
    clock.advance(Duration::from_millis(39)).await;

    assert_eq!(
        (faked.client.ready_state(), fake.count()),
        (ReadyState::Open, 5),
        "open"
    );

    clock.advance(Duration::from_millis(1)).await;
    fake.call_of(5).await.fail();

    assert_eq!(faked.told.closed(1).await, vec![(false, false)], "lost");
    assert_eq!(fake.call_of(6).await.method, "DELETE", "the server told");
}

#[tokio::test]
async fn loses_the_connection_on_a_batch_that_does_not_read_and_on_a_refusal_of_its_listen_told_it_is_gone_it_tells_the_server_nothing()
 {
    let envelope = pushed(1);
    let framed = batch_of(&[&envelope]);
    let with = |tail: &[u8]| [framed.as_slice(), tail].concat();
    let answers = [
        Answer::of(200)
            .with("content-type", BEAD_BATCH_MEDIA_TYPE)
            .carrying(&framed),
        // numbered other than from the one after the last it heard
        batch_bodied("one", &framed),
        batch_bodied("1.0", &framed),
        batch_bodied("1, 1", &framed),
        batch_bodied("2", &framed),
        batch_bodied("1", &[[0, 0, 0, 0].as_slice(), &framed].concat()),
        batch_bodied("1", &[]),
        batch_bodied("1", &[]).in_pieces(Vec::new()),
        // ended in the middle of a length, or of an envelope
        batch_bodied("1", &with(&[0, 0])),
        batch_bodied("1", &with(&framed[..6])),
        // an envelope past the client's limit, however whole
        batch_bodied("1", &[[0, 0, 0, 25].as_slice(), &[0; 25]].concat()),
        refusal(409, HTTP_REFUSALS.listen_undeclared),
        refusal(404, HTTP_REFUSALS.connection_unknown),
    ];
    let mut told = Vec::new();
    let mut heard_of = Vec::new();

    for answer in &answers {
        let faked = connected_listening(&HttpTransportClientOptions {
            maximum_body_bytes: Some(24),
            ..HttpTransportClientOptions::default()
        })
        .await;

        faked.fake.call_of(1).await.answer(answer);

        assert_eq!(
            faked.told.closed(1).await,
            vec![(false, false)],
            "{:?}",
            answer.fields
        );
        rest(WHILE).await;
        heard_of.push(faked.told.messages().len());
        told.push(faked.fake.methods().iter().any(|method| method == "DELETE"));
    }

    assert_eq!(
        told,
        [
            true, true, true, true, true, true, true, true, true, true, true, true, false
        ],
        "the server told"
    );
    // what came whole before what does not read was heard, as it came
    assert_eq!(
        heard_of,
        [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0],
        "heard as it came"
    );

    // one of the limit exactly is heard
    let at_limit = connected_listening(&HttpTransportClientOptions {
        maximum_body_bytes: Some(24),
        ..HttpTransportClientOptions::default()
    })
    .await;
    let largest = envelope_of(0x13, (1, 16));

    at_limit
        .fake
        .call_of(1)
        .await
        .answer(&batch(1, &[&largest]));

    assert_eq!(
        at_limit.fake.call_of(2).await.field(AFTER_HEADER),
        Some("1"),
        "acknowledged"
    );
    assert_eq!(at_limit.told.heard(), vec![largest], "heard");
    disconnected(&at_limit.client, &quick()).await;
}

// spec 15.1
#[tokio::test]
async fn tells_an_envelope_past_maximum_body_bytes_an_answer_s_or_a_batch_s_on_error_before_its_close_naming_the_bound_and_its_value()
 {
    let mut told_of = Vec::new();

    for answer in [
        bead(&[0; 17]).with("content-length", "17"),
        bead(&[0; 17]).ending(Ending::Undeclared),
        // an answer of another type, a gateway's: its close alone
        Answer::of(200)
            .with("content-type", "text/html")
            .carrying(b"<html>"),
    ] {
        let faked = connected(
            fake().await,
            &HttpTransportClientOptions {
                maximum_body_bytes: Some(16),
                ..not_listening()
            },
        )
        .await;
        let sending = sending(&faked.client, request(1));

        faked.fake.call_of(1).await.answer(&answer);
        within(sending).await.unwrap();
        faked.told.closed(1).await;
        told_of.push(faked.told.events());
    }

    let listening = connected_listening(&HttpTransportClientOptions {
        maximum_body_bytes: Some(24),
        ..HttpTransportClientOptions::default()
    })
    .await;

    listening.fake.call_of(1).await.answer(&batch_bodied(
        "1",
        &[[0, 0, 0, 25].as_slice(), &[0; 25]].concat(),
    ));
    listening.told.closed(1).await;
    told_of.push(listening.told.events());

    let past_of = |bytes: u64| {
        vec![
            format!(
                "error the connection is closed: an envelope past its maximumBodyBytes, {bytes} bytes"
            ),
            "close false false".to_owned(),
        ]
    };

    assert_eq!(
        told_of,
        [
            past_of(16),
            past_of(16),
            vec!["close false false".to_owned()],
            past_of(24)
        ],
        "told before its close"
    );
}

// spec 15.1
#[tokio::test]
async fn tells_a_batch_that_does_not_read_on_error_before_its_close_saying_what_of_it_does_not_and_a_refusal_of_its_listen_by_its_close_alone()
 {
    let envelope = pushed(1);
    let framed = batch_of(&[&envelope]);
    let with = |tail: &[u8]| [framed.as_slice(), tail].concat();
    let answers = [
        Answer::of(200)
            .with("content-type", BEAD_BATCH_MEDIA_TYPE)
            .carrying(&framed),
        batch_bodied("2", &framed),
        batch_bodied("1", &[[0, 0, 0, 0].as_slice(), &framed].concat()),
        batch_bodied("1", &[]),
        batch_bodied("1", &[]).in_pieces(Vec::new()),
        batch_bodied("1", &with(&[0, 0])),
        batch_bodied("1", &with(&framed[..6])),
        refusal(409, HTTP_REFUSALS.listen_undeclared),
        refusal(404, HTTP_REFUSALS.connection_unknown),
    ];
    let mut told_of = Vec::new();

    for answer in &answers {
        let faked = connected_listening(&HttpTransportClientOptions {
            maximum_body_bytes: Some(24),
            ..HttpTransportClientOptions::default()
        })
        .await;

        faked.fake.call_of(1).await.answer(answer);
        faked.told.closed(1).await;
        told_of.push(faked.told.events());
    }

    let unread = |why: &str| {
        vec![
            format!("error the connection is closed: a batch that does not read, {why}"),
            "close false false".to_owned(),
        ]
    };

    assert_eq!(
        told_of,
        [
            unread("its bead-sequence not 1"),
            unread("its bead-sequence not 1"),
            unread("an envelope of 0 bytes"),
            unread("it holds no envelope"),
            unread("it holds no envelope"),
            unread("it ends within an envelope"),
            unread("it ends within an envelope"),
            vec!["close false false".to_owned()],
            vec!["close false false".to_owned()],
        ],
        "told before its close"
    );
}

#[tokio::test]
async fn asks_the_server_to_wait_its_wait_held_a_fraction_rounded_to_the_nearest_whole_millisecond()
{
    let faked = connected_listening(&HttpTransportClientOptions {
        wait: Some(Duration::from_micros(1_500)),
        ..HttpTransportClientOptions::default()
    })
    .await;

    assert_eq!(
        faked.fake.call_of(1).await.field(WAIT_HEADER),
        Some("2"),
        "rounded"
    );
    disconnected(&faked.client, &quick()).await;
}

#[tokio::test]
async fn pauses_between_listens_that_bring_nothing_and_listens_no_more_once_its_connection_went() {
    let clock = stepping();
    let faked = listening_on(
        &clock,
        &HttpTransportClientOptions {
            pause: Some(Duration::from_millis(60)),
            wait: Some(Duration::ZERO),
            ..HttpTransportClientOptions::default()
        },
    )
    .await;
    let fake = &faked.fake;
    let first = fake.call_of(1).await;

    assert_eq!(first.field(WAIT_HEADER), Some("0"), "its wait");

    first.answer(&Answer::of(204));
    until(|| clock.dues().contains(&Duration::from_millis(60))).await;
    clock.advance(Duration::from_millis(20)).await;

    assert_eq!(fake.count(), 2, "paused");

    clock.advance(Duration::from_millis(39)).await;

    // not yet
    assert_eq!(fake.count(), 2, "not yet");

    clock.advance(Duration::from_millis(1)).await;
    fake.call_of(2).await;

    // gone while it listens: what its listen brings back is heard by nobody, and it listens no
    // more
    let lost = sending(&faked.client, request(1));

    fake.call_of(3).await.fail();
    within(lost).await.unwrap();
    faked.told.closed(1).await;
    fake.call_of(2).await.answer(&batch(1, &[&pushed(1)]));
    fake.call_of(4).await;
    rest(Duration::from_millis(20)).await;

    assert_eq!(
        fake.methods(),
        ["POST", "GET", "GET", "POST", "DELETE"],
        "no listen after"
    );
    assert!(faked.told.messages().is_empty(), "nothing heard");
}

#[tokio::test]
async fn hears_the_rest_of_a_batch_when_a_listener_throws_the_throw_reported() {
    let faked = connected_listening(&HttpTransportClientOptions::default()).await;

    faked.client.listen(Throwing::times(1));

    let told = recorded(&faked.client);

    faked
        .fake
        .call_of(1)
        .await
        .answer(&batch(1, &[&pushed(1), &pushed(3)]));
    until(|| faked.told.messages().len() == 2).await;

    // the listener after it told of both, the throw reported once
    assert_eq!(
        faked.fake.call_of(2).await.field(AFTER_HEADER),
        Some("2"),
        "acknowledged"
    );
    assert_eq!(
        (faked.told.messages().len(), told.messages().len()),
        (2, 2),
        "both heard"
    );
    assert_eq!(told.errors().len(), 1, "the throw reported once");
    assert!(
        told.errors()[0].contains("a listener that throws"),
        "{:?}",
        told.errors()
    );
    disconnected(&faked.client, &quick()).await;
}

#[tokio::test]
async fn hears_no_more_of_a_batch_once_its_connection_went_while_it_was_heard() {
    // a listener that disconnects at the first message it hears
    struct Leaving {
        client: HttpTransportClient,
        is_gone: Mutex<bool>,
    }

    impl ClientListener for Leaving {
        fn on_message(&self, _message: TransportMessage) {
            let mut is_gone = locked(&self.is_gone);

            if !*is_gone {
                *is_gone = true;
                drop(is_gone);
                drop(self.client.disconnect(&quick()));
            }
        }
    }

    let faked = connected_listening(&HttpTransportClientOptions::default()).await;
    let first = pushed(1);

    faked.client.listen(Arc::new(Leaving {
        client: faked.client.clone(),
        is_gone: Mutex::new(false),
    }));
    faked
        .fake
        .call_of(1)
        .await
        .answer(&batch(1, &[&first, &pushed(3)]));
    until(|| faked.client.ready_state() == ReadyState::Closed).await;
    rest(Duration::from_millis(20)).await;

    assert_eq!(faked.told.heard(), vec![first], "the first alone");
}

#[tokio::test]
async fn listens_again_after_a_status_nothing_marked_a_gateway_s_502_as_after_a_listen_lost() {
    let faked = connected_listening(&HttpTransportClientOptions::default()).await;
    let envelope = pushed(1);

    faked.fake.call_of(1).await.answer(&Answer::of(502));
    faked.fake.call_of(2).await.answer(&batch(1, &[&envelope]));

    assert_eq!(
        faked.fake.call_of(3).await.field(AFTER_HEADER),
        Some("1"),
        "from there"
    );
    assert_eq!(
        (faked.told.heard(), faked.client.ready_state()),
        (vec![envelope], ReadyState::Open),
        "heard, open"
    );
    disconnected(&faked.client, &quick()).await;
}

#[tokio::test]
async fn reads_a_batch_as_it_comes_a_byte_at_a_time_each_envelope_heard_as_soon_as_it_is_whole() {
    let faked = connected_listening(&HttpTransportClientOptions::default()).await;
    let first = pushed(1);
    let second = envelope_of(0x13, (3, 5));
    let pieces: Vec<Vec<u8>> = batch_of(&[&first, &second])
        .into_iter()
        .map(|byte| vec![byte])
        .collect();
    // the first envelope's length and bytes, then the batch ends
    let cut = first.len().saturating_add(4);

    faked
        .fake
        .call_of(1)
        .await
        .answer(&batch_bodied("1", &[]).in_pieces(pieces[..cut].to_vec()));
    until(|| faked.told.heard() == vec![first.clone()]).await;

    // the rest, in the next listen: from the one after the first
    let next = faked.fake.call_of(2).await;

    assert_eq!(next.field(AFTER_HEADER), Some("1"), "from the first");

    next.answer(&batch_bodied("2", &[]).in_pieces(pieces[cut..].to_vec()));
    until(|| faked.told.heard() == vec![first.clone(), second.clone()]).await;

    assert_eq!(
        faked.fake.call_of(3).await.field(AFTER_HEADER),
        Some("2"),
        "from the second"
    );
    disconnected(&faked.client, &quick()).await;
}

#[tokio::test]
async fn hears_what_came_whole_of_a_batch_cut_on_its_way_and_listens_again_from_there_as_no_loss() {
    let faked = connected_listening(&HttpTransportClientOptions::default()).await;
    let first = pushed(1);
    let framed = batch_of(&[&first, &pushed(3)]);

    faked.fake.call_of(1).await.answer(
        &batch_bodied("1", &framed[..first.len().saturating_add(6)])
            .with("content-length", &framed.len().to_string())
            .ending(Ending::Cut),
    );

    let next = faked.fake.call_of(2).await;

    assert_eq!(next.field(AFTER_HEADER), Some("1"), "from there");

    // one loss after it is the first in a row: listened again
    next.fail();

    assert_eq!(
        faked.fake.call_of(3).await.field(AFTER_HEADER),
        Some("1"),
        "again from there"
    );
    assert_eq!(
        (faked.told.heard(), faked.client.ready_state()),
        (vec![first], ReadyState::Open),
        "heard, open"
    );
    disconnected(&faked.client, &quick()).await;
}

#[tokio::test]
async fn never_listens_where_the_server_did_not_say_its_listen_back() {
    let fake = fake().await;
    let client = client_of(&HttpTransportClientOptions::default());
    let connecting = client.connect(&to(fake.port));

    fake.call_of(0).await.answer(&drawn(false));
    settled(connecting).await.unwrap();

    assert!(fake.makes_no_call_of(1).await, "no listen");
    assert_eq!(
        (fake.call_of(0).await.field(LISTEN_HEADER), fake.count()),
        (Some("?1"), 1),
        "asked, never listened"
    );
    disconnected(&client, &quick()).await;
}

#[tokio::test]
async fn says_nothing_of_listening_and_never_listens_when_told_not_to() {
    let fake = fake().await;
    let client = client_of(&not_listening());
    let connecting = client.connect(&to(fake.port));

    // a server that says a listen back all the same takes none from a client that asked for none
    fake.call_of(0).await.answer(&drawn(true));
    settled(connecting).await.unwrap();

    assert!(fake.makes_no_call_of(1).await, "no listen");
    assert_eq!(
        (fake.count(), fake.call_of(0).await.field(LISTEN_HEADER)),
        (1, None),
        "never asked"
    );
    disconnected(&client, &quick()).await;
}
