//! A relay's timeout on its leg B, including the id's reservation and an unbounded relay.

use core::time::Duration;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use super::super::locked;
use super::super::server::{Served, first};
use super::{Relayed, RelayedOptions, admitting, procedure, request};
use crate::clock::{Clock, Schedule, SharedClock, Timer, TimerCallback};
use crate::constants::ProtocolCode;
use crate::envelope::Envelope;
use crate::errors::ProgrammerError;
use crate::memory::MemoryTransportClient;
use crate::router::client::{RouterClient, RouterClientOptions};
use crate::router::relay::DestinationOptions;
use crate::router::server::RouterServerOptions;
use crate::router::types::{RouterError, SignalReason, TransportMessage};
use crate::testing::{Activity, SteppingClock};
use crate::transport::{ClientListener, ReadyState, RouterClientTransport, Sent};

#[derive(Debug)]
struct RecordingClock {
    step: Arc<SteppingClock>,
    armed: Mutex<Vec<Schedule>>,
}

impl Clock for RecordingClock {
    fn monotonic(&self) -> Duration {
        self.step.monotonic()
    }

    fn wall(&self) -> SystemTime {
        self.step.wall()
    }

    fn arm(
        &self,
        schedule: Schedule,
        callback: TimerCallback,
    ) -> Result<Arc<dyn Timer>, ProgrammerError> {
        locked(&self.armed).push(schedule);
        self.step.arm(schedule, callback)
    }

    fn activity(&self) -> Option<Arc<Activity>> {
        Some(self.step.work())
    }
}

#[derive(Debug)]
struct RecordedClient {
    memory: MemoryTransportClient,
    clock: SharedClock,
}

impl RouterClientTransport for RecordedClient {
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError> {
        self.memory.send(message)
    }

    fn listen(&self, listener: Arc<dyn ClientListener>) {
        self.memory.listen(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ClientListener>) {
        self.memory.unlisten(listener);
    }

    fn pause(&self) {
        self.memory.pause();
    }

    fn resume(&self) {
        self.memory.resume();
    }

    fn clock(&self) -> Option<SharedClock> {
        Some(Arc::clone(&self.clock))
    }

    fn ready_state(&self) -> ReadyState {
        self.memory.ready_state()
    }

    fn is_secure(&self) -> bool {
        self.memory.is_secure()
    }
}

struct Timed {
    device: Relayed,
    served: Served,
    client: RouterClient,
    clock: Arc<RecordingClock>,
}

impl Timed {
    async fn new(timeout: Option<Duration>) -> Self {
        let device = Relayed::new(&RelayedOptions {
            relay: admitting(),
            ..RelayedOptions::default()
        })
        .await;
        // Only the recording router listens to leg B's client transport.
        device.device.client.router().dispose().await;
        device.served.router.dispose().await;
        let clock = Arc::new(RecordingClock {
            step: Arc::clone(&device.device.clock),
            armed: Mutex::default(),
        });
        let shared: SharedClock = Arc::<RecordingClock>::clone(&clock);
        let client = RouterClient::new(
            Arc::new(RecordedClient {
                memory: device.device.transport.clone(),
                clock: Arc::clone(&shared),
            }),
            &RouterClientOptions::default(),
        )
        .expect("the recording client router");
        let served = Served::on(
            (shared, Arc::clone(&device.device.clock)),
            &RouterServerOptions {
                relay: Some(crate::router::relay::RelayOptions {
                    timeout,
                    ..admitting()
                }),
                ..RouterServerOptions::default()
            },
        );
        served.transport.open(&first(), true);
        served
            .router
            .register_destination(
                client.as_relay_target(),
                &DestinationOptions {
                    destination_id: Some(7),
                    ..DestinationOptions::default()
                },
            )
            .expect("the timed destination registered");
        served.settle().await;
        Self {
            device,
            served,
            client,
            clock,
        }
    }

    fn call(&self) {
        self.served
            .transport
            .deliver(&request((1, 7), (&procedure((3, "held")), "")), &first());
    }

    async fn dispose(&self) {
        self.served.router.dispose().await;
        self.client.dispose().await;
        self.device.dispose().await;
    }
}

#[tokio::test]
async fn ends_leg_b_past_the_relays_timeout_cancelling_it_at_the_target_and_answers_lost_no_timer_without_one()
 {
    let timed = Timed::new(Some(Duration::from_millis(250))).await;
    timed.call();
    timed.served.settle().await;
    assert_eq!(
        *locked(&timed.clock.armed),
        [Schedule::Once(Duration::from_millis(250))]
    );
    timed.clock.step.advance(Duration::from_millis(249)).await;
    assert_eq!(timed.served.transport.take(), []);
    assert!(locked(&timed.device.aborted).is_empty());
    timed.clock.step.advance(Duration::from_millis(1)).await;
    assert_eq!(
        *locked(&timed.clock.armed),
        [Schedule::Once(Duration::from_millis(250)); 2]
    );
    assert_eq!(
        *locked(&timed.device.aborted),
        [Some(SignalReason::Cancelled)]
    );
    let sent = timed.served.transport.take();
    assert_eq!(sent.len(), 1);
    let (handle, Envelope::Failure { header, failure }) = &sent[0] else {
        panic!("leg A hears destination lost")
    };
    assert_eq!(handle, &first());
    assert_eq!(header.call_id, 1);
    assert_eq!(failure.code, ProtocolCode::DESTINATION_LOST.get());
    assert_eq!(failure.relays, 0);
    {
        let reports = locked(&timed.served.reports);
        assert_eq!(reports.len(), 1);
        assert!(reports[0].0.to_string().contains("250"));
        assert_eq!(reports[0].1, Some(first()));
    }
    timed.dispose().await;

    let unbounded = Timed::new(None).await;
    unbounded.call();
    unbounded.served.settle().await;
    assert!(locked(&unbounded.clock.armed).is_empty());
    assert_eq!(unbounded.served.transport.take(), []);
    unbounded.dispose().await;
}
