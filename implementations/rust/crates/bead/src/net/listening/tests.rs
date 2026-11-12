use core::time::Duration;
use std::collections::VecDeque;
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use super::*;
use crate::clock::SharedClock;
use crate::testing::{SteppingClock, patience, yield_now};

const PATIENCE: Duration = Duration::from_secs(10);

// what a test's listener gives, in order: a socket, numbered, or a failure; the last given again
// once nothing more is scripted
struct Scripted {
    script: Arc<Mutex<VecDeque<io::Result<u32>>>>,
    last: io::ErrorKind,
    attempts: Arc<AtomicUsize>,
    _alive: Arc<()>,
}

impl Accept for Scripted {
    type Socket = u32;

    fn poll_accept(&mut self, _context: &mut Context<'_>) -> Poll<io::Result<(u32, SocketAddr)>> {
        self.attempts.fetch_add(1, Ordering::SeqCst);

        let next = self
            .script
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()
            .unwrap_or_else(|| Err(io::Error::from(self.last)));

        Poll::Ready(next.map(|socket| (socket, SocketAddr::from(([127, 0, 0, 1], 9)))))
    }
}

// what a test sees of accepting: its attempts, the sockets it took, and its failures reported
struct Watched {
    // held by its listener as long as it lives
    alive: Arc<()>,
    attempts: Arc<AtomicUsize>,
    taken: Arc<Mutex<Vec<u32>>>,
    reported: Arc<Mutex<Vec<io::ErrorKind>>>,
    listening: Listening,
}

fn accepting_on(
    stepping: &Arc<SteppingClock>,
    (script, last): (Vec<io::Result<u32>>, io::ErrorKind),
) -> Watched {
    let platform: SharedClock = Arc::<SteppingClock>::clone(stepping);
    let alive = Arc::new(());
    let attempts = Arc::new(AtomicUsize::new(0));
    let taken = Arc::new(Mutex::new(Vec::new()));
    let reported = Arc::new(Mutex::new(Vec::new()));
    let taking = Arc::clone(&taken);
    let reporting = Arc::clone(&reported);
    let listening = accepting(
        &platform::runtime_of(None, "a listening test").expect("a runtime"),
        Acceptance {
            listener: Scripted {
                script: Arc::new(Mutex::new(script.into())),
                last,
                attempts: Arc::clone(&attempts),
                _alive: Arc::clone(&alive),
            },
            take: move |(socket, _peer): (u32, SocketAddr), _serving: &Arc<AtomicBool>| {
                taking
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(socket);

                true
            },
            platform,
            report: Box::new(move |error: io::Error| {
                reporting
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(error.kind());
            }),
        },
    );

    Watched {
        alive,
        attempts,
        taken,
        reported,
        listening,
    }
}

async fn until<F: Fn() -> bool + Send + Sync>(condition: F) {
    patience(PATIENCE, async {
        while !condition() {
            yield_now().await;
        }
    })
    .await
    .expect("in time");
}

#[tokio::test]
async fn pauses_a_second_on_the_platform_s_clock_after_a_failure_not_of_one_connection_reporting_the_first_of_a_run_alone()
 {
    let stepping = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let watched = accepting_on(&stepping, (Vec::new(), io::ErrorKind::Other));

    until(|| stepping.dues() == [ACCEPT_PAUSE]).await;
    assert_eq!(
        watched.attempts.load(Ordering::SeqCst),
        1,
        "no accept again before its pause"
    );

    stepping.advance(ACCEPT_PAUSE).await;
    until(|| watched.attempts.load(Ordering::SeqCst) == 2 && stepping.dues() == [ACCEPT_PAUSE])
        .await;
    assert_eq!(
        *watched
            .reported
            .lock()
            .unwrap_or_else(PoisonError::into_inner),
        [io::ErrorKind::Other],
        "the first of the run reported, alone"
    );

    // * its stop ends its pause at once
    watched.listening.let_go();
    patience(PATIENCE, watched.listening.ended())
        .await
        .expect("ended within its pause");
    assert!(stepping.dues().is_empty(), "its pause disarmed");
}

#[tokio::test]
async fn accepts_again_at_once_after_a_connection_gone_before_it_was_taken_and_reports_a_new_run_once_one_was_taken()
 {
    let stepping = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let watched = accepting_on(
        &stepping,
        (
            vec![
                Err(io::Error::from(io::ErrorKind::ConnectionAborted)),
                Err(io::Error::from(io::ErrorKind::ConnectionReset)),
                Ok(1),
                Err(io::Error::from(io::ErrorKind::OutOfMemory)),
            ],
            io::ErrorKind::Other,
        ),
    );

    until(|| stepping.dues() == [ACCEPT_PAUSE]).await;
    assert_eq!(
        *watched.taken.lock().unwrap_or_else(PoisonError::into_inner),
        [1],
        "taken past the connections gone, with no pause"
    );
    assert_eq!(
        watched.attempts.load(Ordering::SeqCst),
        4,
        "paused at the first failure of its own"
    );

    stepping.advance(ACCEPT_PAUSE).await;
    until(|| watched.attempts.load(Ordering::SeqCst) == 5).await;
    assert_eq!(
        *watched
            .reported
            .lock()
            .unwrap_or_else(PoisonError::into_inner),
        [io::ErrorKind::OutOfMemory],
        "the connections gone told nothing, the run once"
    );

    watched.listening.let_go();
    patience(PATIENCE, watched.listening.ended())
        .await
        .expect("ended");
}

#[tokio::test]
async fn ends_its_accepting_and_lets_its_listener_go_once_dropped_without_its_stop() {
    let stepping = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let watched = accepting_on(&stepping, (Vec::new(), io::ErrorKind::Other));

    until(|| stepping.dues() == [ACCEPT_PAUSE]).await;
    assert_eq!(Arc::strong_count(&watched.alive), 2, "its listener held");

    drop(watched.listening);
    until(|| Arc::strong_count(&watched.alive) == 1).await;
    assert!(stepping.dues().is_empty(), "its pause disarmed");
}
