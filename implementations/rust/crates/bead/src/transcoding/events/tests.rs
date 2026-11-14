use core::fmt;
use core::future::Future;
use core::pin::Pin;
use core::sync::atomic::{AtomicBool, Ordering};
use core::task::{Context, Waker};
use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use tokio::sync::oneshot;

use super::{
    EventHeartbeat, EventSink, EventStream, HEARTBEAT_COMMENT, ServerSentEvent, Taken,
    bytes_of_base64, raw_data_of, text_data_of,
};
use crate::broker::participant::HEARTBEAT;
use crate::clock::{Clock, Schedule, SharedClock, Timer, TimerCallback};
use crate::duration::NEVER;
use crate::errors::ProgrammerError;
use crate::transcoding::problems::Problem;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ── A clock the test fires ───────────────────────────────────────────────────

#[derive(Debug, Default)]
struct Armed {
    cancelled: AtomicBool,
}

impl Timer for Armed {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct FiredClock {
    armed: Mutex<Vec<(Duration, Arc<Armed>, TimerCallback)>>,
}

impl fmt::Debug for FiredClock {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("FiredClock").finish_non_exhaustive()
    }
}

impl FiredClock {
    // the delays of the timers armed and not cancelled
    fn delays(&self) -> Vec<Duration> {
        locked(&self.armed)
            .iter()
            .filter(|(_, timer, _)| !timer.cancelled.load(Ordering::SeqCst))
            .map(|(delay, _, _)| *delay)
            .collect()
    }

    // fires each live timer armed so far, once
    fn fire(&self) {
        let armed = core::mem::take(&mut *locked(&self.armed));

        for (_, timer, mut callback) in armed {
            if !timer.cancelled.load(Ordering::SeqCst) {
                callback();
            }
        }
    }
}

impl Clock for FiredClock {
    fn monotonic(&self) -> Duration {
        Duration::ZERO
    }

    fn wall(&self) -> SystemTime {
        SystemTime::UNIX_EPOCH
    }

    fn arm(
        &self,
        schedule: Schedule,
        callback: TimerCallback,
    ) -> Result<Arc<dyn Timer>, ProgrammerError> {
        let delay = match schedule {
            Schedule::Once(delay) | Schedule::Every(delay) => delay,
        };
        let timer = Arc::new(Armed::default());

        locked(&self.armed).push((delay, Arc::clone(&timer), callback));

        Ok(timer)
    }
}

// ── A sink the test reads ────────────────────────────────────────────────────

#[derive(Default)]
struct Read {
    written: Vec<String>,
    told: Vec<String>,
    // each write's taking, which the test settles
    pending: Vec<oneshot::Sender<bool>>,
}

#[derive(Clone, Default)]
struct Sink {
    read: Arc<Mutex<Read>>,
    // whether each write is taken at once, or refused after the first, as a socket that closed
    refuses_after_first: bool,
}

impl EventSink for Sink {
    fn answer(&mut self, problem: Problem) {
        locked(&self.read)
            .told
            .push(format!("answer {} {}", problem.status, problem.body));
    }

    fn end(&mut self) {
        locked(&self.read).told.push("end".to_owned());
    }

    fn open(&mut self) {
        locked(&self.read).told.push("open".to_owned());
    }

    fn write(&mut self, text: String) -> Taken {
        let mut read = locked(&self.read);

        read.written.push(text);

        if self.refuses_after_first {
            let is_taken = read.written.len() == 1;

            drop(read);
            return Box::pin(async move { is_taken });
        }

        let (taking, taken) = oneshot::channel();

        read.pending.push(taking);
        drop(read);

        Box::pin(async move { taken.await.unwrap_or(false) })
    }
}

impl Sink {
    fn written(&self) -> Vec<String> {
        locked(&self.read).written.clone()
    }

    fn told(&self) -> Vec<String> {
        locked(&self.read).told.clone()
    }

    fn pending(&self) -> usize {
        locked(&self.read).pending.len()
    }

    // takes the write `at`
    fn take(&self, at: usize) {
        let (taking, _) = oneshot::channel();
        let taking = core::mem::replace(
            locked(&self.read).pending.get_mut(at).expect("a write"),
            taking,
        );

        taking.send(true).ok();
    }
}

fn problem(status: u16, body: &str) -> Problem {
    Problem {
        status,
        fields: vec![],
        body: body.to_owned(),
    }
}

// whether `future` is ready, polled once
fn is_settled<F: Future + Unpin>(future: &mut F) -> bool {
    let mut context = Context::from_waker(Waker::noop());

    Pin::new(future).poll(&mut context).is_ready()
}

fn stream_on(sink: &Sink, (clock, heartbeat): (&Arc<FiredClock>, Duration)) -> EventStream {
    let shared: SharedClock = Arc::<FiredClock>::clone(clock);

    EventStream::new(
        Box::new(sink.clone()),
        EventHeartbeat {
            clock: shared,
            every: heartbeat,
        },
    )
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[test]
fn writes_the_result_then_each_notification_as_a_message_then_the_failure_that_ends_them_each_event_an_id()
 {
    let clock = Arc::new(FiredClock::default());
    let sink = Sink::default();
    let stream = stream_on(&sink, (&clock, HEARTBEAT));

    // * one before the result is held, then written after it, in its order
    drop(
        stream
            .notification("{\"remaining\":2}".to_owned())
            .expect("a notification"),
    );
    assert!(sink.written().is_empty(), "held before the result");
    stream
        .result("{\"ticks\":3}".to_owned())
        .expect("its result");
    drop(
        stream
            .notification("{}".to_owned())
            .expect("a notification"),
    );
    clock.fire();
    stream.failure(problem(429, "{\"status\":429}"));

    assert_eq!(sink.told(), ["open", "end"], "opened, then ended");
    assert_eq!(
        sink.written().concat(),
        "event: result\nid: 1\ndata: {\"ticks\":3}\n\nid: 2\ndata: {\"remaining\":2}\n\nid: 3\ndata: {}\n\n:\nevent: failure\nid: 4\ndata: {\"status\":429}\n\n",
        "its events"
    );
    assert!(stream.is_ended(), "ended");
    assert_eq!(
        ServerSentEvent::new(9, "1".to_owned()).text(),
        "id: 9\ndata: 1\n\n",
        "a plain event"
    );
    assert_eq!(
        text_data_of(b"h\n\r").as_deref(),
        Some("\"h\\n\\r\""),
        "a text payload's data"
    );
    assert_eq!(
        raw_data_of(&[0, 0xff, 0xfe]),
        "\"AP/+\"",
        "a raw payload's data"
    );
    assert_eq!(
        bytes_of_base64("AP/+"),
        Some(vec![0, 0xff, 0xfe]),
        "read again"
    );
    assert_eq!(bytes_of_base64("AP/="), None, "a bit past its bytes");

    // a failure before the result is a problem, the notifications it held dropped
    let early = Sink::default();
    let refused = stream_on(&early, (&clock, HEARTBEAT));
    let mut dropped = refused
        .notification("{}".to_owned())
        .expect("a notification");

    refused.failure(problem(401, "{\"status\":401}"));
    assert_eq!(early.told(), ["answer 401 {\"status\":401}"], "answered");
    assert!(early.written().is_empty(), "nothing written");
    assert!(is_settled(&mut dropped), "the held one settled");

    // a quiet stream's comment, and none once it closed
    let quiet = Sink::default();
    let open = stream_on(&quiet, (&clock, HEARTBEAT));

    open.result("{}".to_owned()).expect("its result");
    clock.fire();
    assert_eq!(
        quiet.written().last().map(String::as_str),
        Some(HEARTBEAT_COMMENT),
        "a comment"
    );
    open.close();
    clock.fire();
    clock.fire();
    assert_eq!(quiet.written().len(), 2, "none once closed");
    assert!(clock.delays().is_empty(), "no timer left");
}

#[test]
fn credits_each_notification_once_the_event_before_it_was_taken() {
    let clock = Arc::new(FiredClock::default());
    let sink = Sink::default();
    let stream = stream_on(&sink, (&clock, NEVER));
    let mut held = stream
        .notification("{\"remaining\":2}".to_owned())
        .expect("a notification");

    stream.result("{}".to_owned()).expect("its result");

    // the result's write and the held notification's, neither taken yet
    assert_eq!(sink.pending(), 2, "two writes");
    assert!(!is_settled(&mut held), "not yet");
    sink.take(0);
    assert!(!is_settled(&mut held), "the result's alone");
    sink.take(1);
    assert!(is_settled(&mut held), "its own taken");

    let mut next = stream
        .notification("{\"remaining\":1}".to_owned())
        .expect("a notification");

    assert!(!is_settled(&mut next), "not yet");
    sink.take(2);
    assert!(is_settled(&mut next), "taken");

    // one after the end is dropped, and settles at once
    stream.close();

    let mut late = stream.notification("{}".to_owned()).expect("dropped");

    assert!(is_settled(&mut late), "settled at once");
    assert_eq!(sink.pending(), 3, "nothing written");
}

#[test]
fn refuses_a_second_result_and_a_result_or_a_notification_once_its_failure_ended_it_as_its_caller_s_bug()
 {
    let clock = Arc::new(FiredClock::default());
    let sink = Sink::default();
    let stream = stream_on(&sink, (&clock, NEVER));

    stream
        .result("{\"ticks\":1}".to_owned())
        .expect("its result");
    assert_eq!(
        stream
            .result("{\"ticks\":2}".to_owned())
            .map_err(|error| error.message().to_owned()),
        Err("a stream has one result, before its end".to_owned()),
        "a second result"
    );
    assert_eq!(sink.told(), ["open"], "opened");
    assert_eq!(
        sink.written(),
        ["event: result\nid: 1\ndata: {\"ticks\":1}\n\n"],
        "its result"
    );

    // * its failure ends it: a result or a notification after it is its caller's bug, a failure
    // nothing
    stream.failure(problem(429, "{\"code\":2}"));
    stream.failure(problem(429, "{\"code\":3}"));
    assert!(stream.result("{}".to_owned()).is_err(), "a result after it");
    assert_eq!(
        stream
            .notification("{}".to_owned())
            .err()
            .map(|error| error.message().to_owned()),
        Some("a notification after the stream ended".to_owned()),
        "a notification after it"
    );
    assert_eq!(sink.told(), ["open", "end"], "ended once");
    assert_eq!(sink.written().len(), 2, "its failure once");

    // closed, its client gone: what comes after is dropped, written and told nothing
    let closed = Sink::default();
    let early = stream_on(&closed, (&clock, NEVER));

    early.close();
    early.result("{}".to_owned()).expect("dropped");
    early.failure(problem(500, "{\"status\":500}"));

    let mut dropped = early.notification("{}".to_owned()).expect("dropped");

    assert!(is_settled(&mut dropped), "settled at once");
    assert!(closed.told().is_empty(), "told nothing");
    assert!(closed.written().is_empty(), "wrote nothing");
}

#[test]
fn settles_a_held_notification_whose_event_its_response_could_not_take_its_credit_moot() {
    let clock = Arc::new(FiredClock::default());
    // * the result taken, the notification after it refused, as a socket that closed
    let sink = Sink {
        refuses_after_first: true,
        ..Sink::default()
    };
    let stream = stream_on(&sink, (&clock, NEVER));
    let mut held = stream
        .notification("{\"remaining\":1}".to_owned())
        .expect("a notification");

    stream.result("{}".to_owned()).expect("its result");
    assert!(is_settled(&mut held), "settled, its credit moot");

    let mut next = stream
        .notification("{\"remaining\":0}".to_owned())
        .expect("a notification");

    assert!(is_settled(&mut next), "settled, its credit moot");
}
