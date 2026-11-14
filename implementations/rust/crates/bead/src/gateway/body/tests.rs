//! A gateway's bodies: a body a mounted gateway is handed, judged by hyper's hints before its first
//! byte and by its count at its end (7.6.27), each clause and what none of them takes; and a body
//! read under its bound, the budget of every body, and its rate.

use core::pin::Pin;
use core::task::{Context, Poll};
use core::time::Duration;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use bytes::Bytes;
use http_body::{Body, Frame, SizeHint};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::clock::SystemClock;

// a body of its own: the frames it gives, then its end or its failure, and the hints it shows, or
// none where it forwards none
struct Handed {
    frames: VecDeque<Bytes>,
    is_end_stream: Option<bool>,
    exact: Option<u64>,
    // whether it never ends, a reader that sends nothing more
    is_stalled: bool,
    fails: bool,
}

impl Handed {
    fn of(frames: &[&'static [u8]]) -> Self {
        Self {
            frames: frames
                .iter()
                .map(|frame| Bytes::from_static(frame))
                .collect(),
            is_end_stream: None,
            exact: None,
            is_stalled: false,
            fails: false,
        }
    }

    fn hinting(mut self, (is_end_stream, exact): (bool, Option<u64>)) -> Self {
        self.is_end_stream = Some(is_end_stream);
        self.exact = exact;
        self
    }
}

#[derive(Debug)]
struct Failed;

impl fmt::Display for Failed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("failed")
    }
}

impl Error for Failed {}

impl Body for Handed {
    type Data = Bytes;
    type Error = Failed;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Failed>>> {
        if let Some(frame) = self.frames.pop_front() {
            return Poll::Ready(Some(Ok(Frame::data(frame))));
        }

        if self.is_stalled {
            return Poll::Pending;
        }

        if self.fails {
            return Poll::Ready(Some(Err(Failed)));
        }

        Poll::Ready(None)
    }

    fn is_end_stream(&self) -> bool {
        self.is_end_stream.unwrap_or(false)
    }

    fn size_hint(&self) -> SizeHint {
        self.exact
            .map_or_else(SizeHint::default, SizeHint::with_exact)
    }
}

const fn head(declared: Option<u64>, (is_coded, is_http2): (bool, bool)) -> BodyHead {
    BodyHead {
        declared,
        is_coded,
        is_http2,
    }
}

#[test]
fn takes_a_body_read_before_it_by_hyper_s_hints_before_its_first_byte_clauses_a_b_and_c() {
    let length = head(Some(10), (false, false));
    let chunked = head(None, (true, false));
    let http2 = head(None, (false, true));

    // (a) a content-length past 0, its body ended or shorter than it
    assert!(
        is_taken_before(&Handed::of(&[]).hinting((true, Some(0))), &length),
        "read whole and handed on, or replaced by an ended body"
    );
    assert!(
        is_taken_before(&Handed::of(&[]).hinting((false, Some(5))), &length),
        "one frame of it read"
    );
    // (b) a transfer-encoding and its end
    assert!(
        is_taken_before(&Handed::of(&[]).hinting((true, Some(0))), &chunked),
        "a chunked body put back or replaced"
    );
    // (c) over HTTP/2, no content-length, its end and no exact size
    assert!(
        is_taken_before(&Handed::of(&[]).hinting((true, None)), &http2),
        "an HTTP/2 body polled to its end and handed on"
    );
}

#[test]
fn takes_no_body_its_hints_do_not_tell_read_a_size_it_does_not_know_never_under_a_length() {
    let length = head(Some(10), (false, false));
    let chunked = head(None, (true, false));
    let http2 = head(None, (false, true));
    let none = head(None, (false, false));

    assert!(
        !is_taken_before(&Handed::of(&[]).hinting((false, Some(10))), &length),
        "untouched, or put back whole with its length"
    );
    assert!(
        !is_taken_before(&Handed::of(&[]), &length),
        "a wrapper that forwards neither hint"
    );
    assert!(
        !is_taken_before(&Handed::of(&[]).hinting((false, None)), &chunked),
        "an untouched chunked body"
    );
    assert!(
        !is_taken_before(&Handed::of(&[]).hinting((true, Some(0))), &http2),
        "an HTTP/2 request with no body shows an exact 0"
    );
    assert!(
        !is_taken_before(&Handed::of(&[]).hinting((true, Some(0))), &none),
        "a request with no body over HTTP/1.1, through a wrapper that forwards its end alone"
    );
    assert!(
        !is_taken_before(
            &Handed::of(&[]).hinting((true, Some(0))),
            &head(Some(0), (false, false))
        ),
        "a content-length of 0, read as empty"
    );
}

#[test]
fn takes_at_its_end_a_body_short_of_its_length_and_a_chunked_one_that_gave_no_byte_clauses_d_and_e()
{
    assert!(
        is_taken_at_end(&head(Some(10), (false, false)), 0),
        "(d) a stream of nothing under a content-length"
    );
    assert!(
        !is_taken_at_end(&head(Some(10), (false, false)), 10),
        "whole"
    );
    assert!(
        is_taken_at_end(&head(None, (true, false)), 0),
        "(e) a chunked body read to its end before it, or one that came empty"
    );
    assert!(
        !is_taken_at_end(&head(None, (true, false)), 5),
        "what is left of a chunked body read in part"
    );
    assert!(
        !is_taken_at_end(&head(None, (false, true)), 0),
        "an HTTP/2 body read as empty"
    );
}

// a reading of `maximum` bytes at most, under `budget`, at `rate` past `grace`
fn reading_of(maximum: u64, (budget, rate): (u64, u64)) -> Reading {
    Reading {
        maximum_body_bytes: maximum,
        body_bytes_budget: budget,
        budget: Arc::new(AtomicU64::new(0)),
        minimum_body_bytes_per_second: rate,
        body_grace_period: Duration::from_millis(50),
        clock: Arc::new(SystemClock::current().expect("a runtime")),
        ended: CancellationToken::new(),
        judged: None,
    }
}

#[tokio::test]
async fn reads_a_body_whole_its_charge_given_back() {
    let reading = reading_of(16, (1_024, 240));

    assert_eq!(
        read_body(Handed::of(&[b"ab", b"cd"]), &reading).await,
        Ok(Bytes::from_static(b"abcd")),
        "its frames in order"
    );
    assert_eq!(
        reading.budget.load(Ordering::SeqCst),
        0,
        "its charge given back"
    );
}

#[tokio::test]
async fn refuses_a_body_past_its_bound_past_the_budget_behind_its_rate_or_failed() {
    let reading = reading_of(3, (1_024, 240));

    assert_eq!(
        read_body(Handed::of(&[b"ab", b"cd"]), &reading).await,
        Err(Unread::TooLarge),
        "past maximumBodyBytes"
    );

    let reading = reading_of(16, (3, 240));

    assert_eq!(
        read_body(Handed::of(&[b"ab", b"cd"]), &reading).await,
        Err(Unread::Busy),
        "past bodyBytesBudget"
    );
    assert_eq!(
        reading.budget.load(Ordering::SeqCst),
        0,
        "its charge given back"
    );

    let reading = reading_of(16, (1_024, 240));
    let mut stalled = Handed::of(&[b"a"]);

    stalled.is_stalled = true;
    assert_eq!(
        read_body(stalled, &reading).await,
        Err(Unread::TooSlow),
        "behind its rate once its grace passed"
    );

    let mut failed = Handed::of(&[b"a"]);

    failed.fails = true;
    assert_eq!(
        read_body(failed, &reading).await,
        Err(Unread::Gone),
        "failed"
    );
}

#[tokio::test]
async fn reads_a_held_body_past_its_grace_when_its_rate_is_0_until_its_exchange_ends() {
    let reading = reading_of(16, (1_024, 0));
    let mut stalled = Handed::of(&[b"a"]);
    let ending = reading.ended.clone();

    stalled.is_stalled = true;

    let read = read_body(stalled, &reading);
    let ended = async move {
        crate::testing::rest(Duration::from_millis(200)).await;
        ending.cancel();
    };
    let (read, ()) = tokio::join!(read, ended);

    assert_eq!(
        read,
        Err(Unread::Gone),
        "no rate held, its exchange's end alone"
    );
}

#[tokio::test]
async fn refuses_at_its_end_a_body_its_count_tells_was_read_before_it() {
    let mut reading = reading_of(16, (1_024, 240));

    reading.judged = Some(head(Some(4), (false, false)));
    assert_eq!(
        read_body(Handed::of(&[b"ab"]), &reading).await,
        Err(Unread::Taken),
        "short of its length"
    );
    assert_eq!(
        read_body(Handed::of(&[b"ab", b"cd"]), &reading).await,
        Ok(Bytes::from_static(b"abcd")),
        "whole"
    );
}
