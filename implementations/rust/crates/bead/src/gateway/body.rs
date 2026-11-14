//! A gateway's bodies (spec/transcoding.md 6, 7.6.27, 10.1's step 10): the one it answers with,
//! [`HttpGatewayBody`], its frames its outlet's slices; and the one it is handed, read as it comes
//! under its bounds and its rate, and, where it is mounted, judged before its first byte by
//! hyper's hints and at its end by its count, so a body the server it is mounted on read before it
//! is refused before any binding, its call never made.

use core::error::Error;
use core::fmt;
use core::future::poll_fn;
use core::pin::Pin;
use core::task::{Context, Poll};
use core::time::Duration;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use bytes::{Bytes, BytesMut};
use http_body::{Body, Frame, SizeHint};
use tokio_util::sync::CancellationToken;

use crate::clock::{Schedule, SharedClock, Timer};
use crate::gateway::pace::{OutletShared, Polled};
use crate::http::wire::Cut;

#[cfg(test)]
mod tests;

/// What a gateway answers with: the body of the response [`HttpGateway::answer`] gives, written
/// as its exchange goes, paced by its host's polls, its error a cut, which ends its response
/// before its end.
///
/// [`HttpGateway::answer`]: crate::HttpGateway::answer
pub struct HttpGatewayBody {
    shared: Option<Arc<OutletShared>>,
    is_cut: bool,
}

impl fmt::Debug for HttpGatewayBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpGatewayBody")
            .field("is_end_stream", &self.is_ended())
            .finish_non_exhaustive()
    }
}

/// What ends a gateway's body before its end: its response dropped, past a bound or its
/// gateway's stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BodyCut;

impl fmt::Display for BodyCut {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the gateway's response is cut")
    }
}

impl Error for BodyCut {}

impl HttpGatewayBody {
    /// The body `shared` feeds.
    pub(crate) const fn over(shared: Arc<OutletShared>) -> Self {
        Self {
            shared: Some(shared),
            is_cut: false,
        }
    }

    /// A body ended before its first frame.
    pub(crate) const fn ended() -> Self {
        Self {
            shared: None,
            is_cut: false,
        }
    }

    /// A body cut before its first frame.
    pub(crate) const fn cut() -> Self {
        Self {
            shared: None,
            is_cut: true,
        }
    }

    fn is_ended(&self) -> bool {
        !self.is_cut
            && self
                .shared
                .as_ref()
                .is_none_or(|shared| shared.is_end_stream())
    }

    // its next frame, or its cut
    fn poll_next(&self, context: &Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Cut>>> {
        let Some(shared) = &self.shared else {
            return Poll::Ready(self.is_cut.then_some(Err(Cut)));
        };

        match shared.poll(context.waker()) {
            Polled::Slice(bytes) => Poll::Ready(Some(Ok(Frame::data(bytes)))),
            Polled::Ended => Poll::Ready(None),
            Polled::Cut => Poll::Ready(Some(Err(Cut))),
            Polled::Pending => Poll::Pending,
        }
    }
}

impl Drop for HttpGatewayBody {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.take() {
            shared.gone();
        }
    }
}

impl Body for HttpGatewayBody {
    type Data = Bytes;
    type Error = Box<dyn Error + Send + Sync>;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        self.poll_next(context).map(|polled| {
            polled.map(|frame| frame.map_err(|Cut| -> Self::Error { Box::new(BodyCut) }))
        })
    }

    fn is_end_stream(&self) -> bool {
        self.is_ended()
    }

    fn size_hint(&self) -> SizeHint {
        if self.is_ended() {
            SizeHint::with_exact(0)
        } else {
            SizeHint::default()
        }
    }
}

/// A gateway's body as its own listener hands it to hyper: its error the transport's cut.
pub(crate) struct OwnBody(pub(crate) HttpGatewayBody);

impl Body for OwnBody {
    type Data = Bytes;
    type Error = Cut;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Cut>>> {
        self.0.poll_next(context)
    }

    fn is_end_stream(&self) -> bool {
        self.0.is_ended()
    }

    fn size_hint(&self) -> SizeHint {
        self.0.size_hint()
    }
}

// ── The body it is handed ─────────────────────────────────────────────────────────────────────

/// What a request's head says of its body, which a mounted gateway judges it by (7.6.27).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BodyHead {
    /// Its `content-length`, where it gives one.
    pub(crate) declared: Option<u64>,
    /// Whether it gives a `transfer-encoding`.
    pub(crate) is_coded: bool,
    /// Whether it came over HTTP/2.
    pub(crate) is_http2: bool,
}

/// Whether the server a gateway is mounted on read `body` before it, by hyper's hints, before its
/// first byte is awaited: (a) a `content-length` past 0 that it ended short of, or that its exact
/// size falls under; (b) a `transfer-encoding` and its end; (c) over HTTP/2, no `content-length`,
/// its end and no exact size. A size it does not know is never under a length.
pub(crate) fn is_taken_before<B: Body>(body: &B, head: &BodyHead) -> bool {
    let hint = body.size_hint();
    let is_ended = body.is_end_stream();

    match head.declared {
        Some(declared) if declared > 0 => {
            is_ended || hint.exact().is_some_and(|exact| exact < declared)
        }
        Some(_) => false,
        None if head.is_coded => is_ended,
        None => head.is_http2 && is_ended && hint.exact().is_none(),
    }
}

/// Whether a body that ended, having given `received` bytes, was read before the gateway took it:
/// (d) short of its `content-length`, whatever wrapped it; (e) over HTTP/1.1, under a
/// `transfer-encoding`, none given, which an untouched chunked body that came empty shows alike.
pub(crate) const fn is_taken_at_end(head: &BodyHead, received: u64) -> bool {
    match head.declared {
        Some(declared) => received < declared,
        None => head.is_coded && !head.is_http2 && received == 0,
    }
}

/// What a body is read under (10.1, step 10): its bound, the budget of every body under way, and
/// its rate past its grace, on its gateway's clock.
pub(crate) struct Reading {
    /// The largest body it takes.
    pub(crate) maximum_body_bytes: u64,
    /// What every body under way may hold together.
    pub(crate) body_bytes_budget: u64,
    /// What every body under way holds, counted as it comes.
    pub(crate) budget: Arc<AtomicU64>,
    /// The slowest a body may come once its grace passed; 0 holds none.
    pub(crate) minimum_body_bytes_per_second: u64,
    /// How long a body comes before its rate is held.
    pub(crate) body_grace_period: Duration,
    /// The clock its rate is held on.
    pub(crate) clock: SharedClock,
    /// What ends its reading, its exchange gone.
    pub(crate) ended: CancellationToken,
    /// Its head, where a mounted gateway judges it at its end.
    pub(crate) judged: Option<BodyHead>,
}

/// Why a body read no whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Unread {
    /// Past `maximumBodyBytes`: 413.
    TooLarge,
    /// Past the budget of every body under way: 503.
    Busy,
    /// Slower than its rate once its grace passed: 408.
    TooSlow,
    /// Read before the gateway took it, as its end shows.
    Taken,
    /// Its request gone, cut short, or its exchange ended.
    Gone,
    /// What HTTP cannot frame, a malformed chunk among it: 400, as HTTP answers it.
    Malformed,
}

// whether a body's error is HTTP's refusal of its framing, which is answered, and not its request
// cut short or gone, which is not: as the HTTP transport tells them apart
fn is_malformed(error: Box<dyn Error + Send + Sync>) -> bool {
    error.downcast::<hyper::Error>().is_ok_and(|error| {
        let is_cut = Error::source(&*error)
            .and_then(|source| source.downcast_ref::<std::io::Error>())
            .is_some_and(|error| error.kind() == std::io::ErrorKind::UnexpectedEof);

        !error.is_incomplete_message() && !is_cut
    })
}

// what a body holds of the budget, given back as it settles
struct Charge {
    budget: Arc<AtomicU64>,
    held: u64,
}

impl Drop for Charge {
    fn drop(&mut self) {
        self.budget.fetch_sub(self.held, Ordering::SeqCst);
    }
}

// the rate's timer, re-armed as each piece comes
struct Slow {
    token: CancellationToken,
    timer: Option<Arc<dyn Timer>>,
}

impl Slow {
    fn rearm(&mut self, (reading, due): (&Reading, Duration)) {
        if let Some(timer) = self.timer.take() {
            timer.cancel();
        }

        if reading.minimum_body_bytes_per_second == 0 {
            return;
        }

        // ! a millisecond at least, counted whole: Bead arms no timer for less (decision 0011)
        let left = due.saturating_sub(reading.clock.monotonic());
        let wait = Duration::from_millis(
            u64::try_from(left.as_nanos().div_ceil(1_000_000))
                .unwrap_or(u64::MAX)
                .max(1),
        );
        let token = self.token.clone();

        self.timer = reading
            .clock
            .arm(Schedule::Once(wait), Box::new(move || token.cancel()))
            .ok();
    }
}

impl Drop for Slow {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.cancel();
        }
    }
}

// when a body of `received` bytes from `head_at` is due: the longer of its grace and what its
// bytes take at its rate
fn due_of(reading: &Reading, (head_at, received): (Duration, u64)) -> Duration {
    let rate = reading.minimum_body_bytes_per_second.max(1);
    let takes = Duration::from_millis(received.saturating_mul(1_000).div_ceil(rate));

    head_at.saturating_add(reading.body_grace_period.max(takes))
}

/// `body` read whole as it comes, under `reading`'s bounds, its charge given back as it settles.
pub(crate) async fn read_body<B>(body: B, reading: &Reading) -> Result<Bytes, Unread>
where
    B: Body<Data = Bytes> + Send,
    B::Error: Into<Box<dyn Error + Send + Sync>>,
{
    let mut body = Box::pin(body);
    let head_at = reading.clock.monotonic();
    let mut slow = Slow {
        token: CancellationToken::new(),
        timer: None,
    };
    let mut charge = Charge {
        budget: Arc::clone(&reading.budget),
        held: 0,
    };
    let mut buffer = BytesMut::new();
    let mut received: u64 = 0;

    slow.rearm((reading, due_of(reading, (head_at, 0))));

    loop {
        let next = {
            let slowed = slow.token.cancelled();
            let ended = reading.ended.cancelled();
            let mut slowed = core::pin::pin!(slowed);
            let mut ended = core::pin::pin!(ended);

            poll_fn(|context| {
                if ended.as_mut().poll(context).is_ready() {
                    return Poll::Ready(Err(Unread::Gone));
                }

                if slowed.as_mut().poll(context).is_ready() {
                    return Poll::Ready(Err(Unread::TooSlow));
                }

                body.as_mut().poll_frame(context).map(Ok)
            })
            .await?
        };

        match next {
            Some(Ok(frame)) => {
                let Ok(piece) = frame.into_data() else {
                    continue;
                };
                let count = u64::try_from(piece.len()).unwrap_or(u64::MAX);

                received = received.saturating_add(count);
                charge.held = charge.held.saturating_add(count);

                let held = reading
                    .budget
                    .fetch_add(count, Ordering::SeqCst)
                    .saturating_add(count);

                if received > reading.maximum_body_bytes {
                    return Err(Unread::TooLarge);
                }

                if held > reading.body_bytes_budget {
                    return Err(Unread::Busy);
                }

                buffer.extend_from_slice(&piece);
                slow.rearm((reading, due_of(reading, (head_at, received))));
            }
            Some(Err(error)) => {
                return Err(if is_malformed(error.into()) {
                    Unread::Malformed
                } else {
                    Unread::Gone
                });
            }
            None => {
                if reading
                    .judged
                    .as_ref()
                    .is_some_and(|head| is_taken_at_end(head, received))
                {
                    return Err(Unread::Taken);
                }

                drop(charge);

                return Ok(buffer.freeze());
            }
        }
    }
}
