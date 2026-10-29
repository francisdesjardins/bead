//! A broker connection's heartbeat (spec 15.21), the twin of the other sides': on the platform's
//! timer, in real time, whatever clock the side is given (decision 0011).

use core::sync::atomic::{AtomicUsize, Ordering};
use core::time::Duration;
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

use super::{locked, until};
use crate::broker::heartbeat::{Heartbeat, HeartbeatHooks};
use crate::clock::{SharedClock, SystemClock};
use crate::duration::NEVER;

fn platform() -> SharedClock {
    Arc::new(SystemClock::current().expect("a runtime"))
}

fn counting(count: &Arc<AtomicUsize>) -> Arc<dyn Fn() + Send + Sync> {
    let count = Arc::clone(count);

    Arc::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
    })
}

fn heartbeat_of(
    beat: Duration,
    (pings, drops): (&Arc<AtomicUsize>, &Arc<AtomicUsize>),
) -> Heartbeat {
    Heartbeat::start(
        beat,
        (
            platform(),
            HeartbeatHooks {
                ping: counting(pings),
                drop: counting(drops),
            },
        ),
    )
}

#[tokio::test]
async fn pings_a_connection_silent_for_its_heartbeat_on_the_platform_s_timer_and_drops_one_that_answered_nothing_by_the_next()
 {
    let beat = Duration::from_millis(200);
    let (pings, drops) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let started = Instant::now();
    let heartbeat = heartbeat_of(beat, (&pings, &drops));

    // silent for a heartbeat: pinged, no sooner
    until(|| pings.load(Ordering::SeqCst) == 1, "pinged").await;
    assert!(
        started.elapsed() >= beat.saturating_sub(Duration::from_millis(20)),
        "pinged at {:?}",
        started.elapsed()
    );

    // answered nothing by the next: dropped, and beats no more
    until(|| drops.load(Ordering::SeqCst) == 1, "dropped").await;
    tokio::time::sleep(beat * 3).await;
    assert_eq!(
        (pings.load(Ordering::SeqCst), drops.load(Ordering::SeqCst)),
        (1, 1),
        "one ping, one drop"
    );
    heartbeat.stop();

    // a connection heard from every tenth of its heartbeat is never pinged
    let heard = Arc::new(AtomicUsize::new(0));
    let talking = heartbeat_of(beat * 10, (&heard, &heard));

    for _ in 0..10 {
        tokio::time::sleep(beat).await;
        talking.heard();
    }

    talking.stop();
    assert_eq!(heard.load(Ordering::SeqCst), 0, "never pinged");

    // anything heard answers the ping, and none beats once stopped
    let (answered_pings, answered_drops) =
        (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let answered = heartbeat_of(Duration::from_secs(1), (&answered_pings, &answered_drops));
    let told = || {
        (
            answered_pings.load(Ordering::SeqCst),
            answered_drops.load(Ordering::SeqCst),
        )
    };

    until(|| answered_pings.load(Ordering::SeqCst) == 1, "pinged").await;
    assert_eq!(told(), (1, 0), "pinged, not dropped");
    answered.heard();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(told(), (1, 0), "answered");
    answered.stop();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(told(), (1, 0), "stopped");

    // without end, it arms nothing
    let never = heartbeat_of(NEVER, (&heard, &heard));

    tokio::time::sleep(beat * 2).await;
    never.stop();
    assert_eq!(heard.load(Ordering::SeqCst), 0, "nothing beaten");
}

#[tokio::test]
async fn starts_a_fresh_silence_after_anything_heard_answers_its_ping_then_drops_a_ping_left_unanswered()
 {
    let heard: Arc<Mutex<Vec<&str>>> = Arc::default();
    let (pinging, dropping) = (Arc::clone(&heard), Arc::clone(&heard));
    let heartbeat = Heartbeat::start(
        Duration::from_millis(100),
        (
            platform(),
            HeartbeatHooks {
                ping: Arc::new(move || locked(&pinging).push("ping")),
                drop: Arc::new(move || locked(&dropping).push("drop")),
            },
        ),
    );

    until(|| !locked(&heard).is_empty(), "pinged").await;
    assert_eq!(*locked(&heard), ["ping"], "pinged once");
    heartbeat.heard();
    until(|| locked(&heard).len() >= 3, "pinged anew and dropped").await;
    assert_eq!(*locked(&heard), ["ping", "ping", "drop"], "a fresh silence");
    heartbeat.stop();
}

#[tokio::test]
async fn beats_no_more_once_its_own_ping_stopped_it() {
    let (pings, drops) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let beating: Arc<Mutex<Weak<Heartbeat>>> = Arc::default();
    let stopping = Arc::clone(&beating);
    let counted = Arc::clone(&pings);
    // * a ping that ends its connection, as one past what may wait for its broker does
    let heartbeat = Arc::new(Heartbeat::start(
        Duration::from_millis(100),
        (
            platform(),
            HeartbeatHooks {
                ping: Arc::new(move || {
                    counted.fetch_add(1, Ordering::SeqCst);

                    let heartbeat = locked(&stopping).upgrade();

                    if let Some(heartbeat) = heartbeat {
                        heartbeat.stop();
                    }
                }),
                drop: counting(&drops),
            },
        ),
    ));

    *locked(&beating) = Arc::downgrade(&heartbeat);
    until(|| pings.load(Ordering::SeqCst) == 1, "pinged").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        (pings.load(Ordering::SeqCst), drops.load(Ordering::SeqCst)),
        (1, 0),
        "no more beats"
    );
}
