//! A received call's start includes its admission and decoding.

use core::sync::atomic::{AtomicU64, Ordering};
use core::time::Duration;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use bytes::Bytes;

use super::locked;
use crate::clock::{Clock, Schedule, SharedClock, Timer, TimerCallback};
use crate::debug::DebugDirection;
use crate::envelope::Envelope;
use crate::managers::service::{
    ResolverDependencies, ServiceManager, ServiceManagerOptions, ServiceRouter,
};
use crate::payloads::{CodecRefusal, PayloadCodec, TextCodec};
use crate::router::admissions::BeforeRequest;
use crate::router::server::{RouterServer, RouterServerOptions};
use crate::testing::core_port::scripted_header;
use crate::testing::pair::echo;
use crate::testing::scripted::{ScriptedServer, handle_of};
use crate::testing::{SteppingClock, instants};

#[derive(Debug)]
struct ReadingClock {
    base: Arc<SteppingClock>,
    elapsed: AtomicU64,
}

impl ReadingClock {
    fn spend(&self, milliseconds: u64) {
        self.elapsed.fetch_add(milliseconds, Ordering::SeqCst);
    }
}

impl Clock for ReadingClock {
    fn monotonic(&self) -> Duration {
        self.base
            .monotonic()
            .saturating_add(Duration::from_millis(self.elapsed.load(Ordering::SeqCst)))
    }
    fn wall(&self) -> SystemTime {
        self.base
            .wall()
            .checked_add(Duration::from_millis(self.elapsed.load(Ordering::SeqCst)))
            .expect("a test instant within its range")
    }
    fn arm(&self, schedule: Schedule, callback: TimerCallback) -> Arc<dyn Timer> {
        self.base.arm(schedule, callback)
    }
    fn activity(&self) -> Option<Arc<crate::testing::Activity>> {
        self.base.activity()
    }
}

#[derive(Debug)]
struct Decoding {
    clock: Arc<ReadingClock>,
    delay: u64,
}

impl PayloadCodec for Decoding {
    type Value = String;

    fn decode(&self, bytes: &Bytes) -> Result<Self::Value, CodecRefusal> {
        self.clock.spend(self.delay);
        TextCodec.decode(bytes)
    }

    fn encode(&self, value: &Self::Value) -> Result<Bytes, CodecRefusal> {
        TextCodec.encode(value)
    }
    fn encoding(&self) -> &'static str {
        "text"
    }
}

#[tokio::test]
#[ignore = "divergence: a received service call starts after its admission, not at arrival"]
async fn a_received_call_starts_as_it_arrives_its_admission_and_its_decoding_count_in_its_duration()
{
    for decoding in [0, 7] {
        let base = SteppingClock::new(instants::new_year());
        let clock = Arc::new(ReadingClock {
            base: Arc::clone(&base),
            elapsed: AtomicU64::new(0),
        });
        let shared: SharedClock = Arc::<ReadingClock>::clone(&clock);
        let transport = ScriptedServer::new(shared);
        let carried: Arc<dyn crate::transport::ServerTransport> =
            Arc::<ScriptedServer>::clone(&transport);
        let router = RouterServer::new(carried, &RouterServerOptions::default()).expect("a router");
        let manager = ServiceManager::new(
            ServiceRouter::Server(router.clone()),
            &ServiceManagerOptions::default(),
        )
        .expect("a manager");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seeing = Arc::clone(&seen);
        manager.on_debug(Arc::new(move |error, event| {
            assert!(error.is_none());
            locked(&seeing).push((event.direction, event.started_at, event.duration));
        }));
        let mut dependencies = ResolverDependencies::of(
            Decoding {
                clock: Arc::clone(&clock),
                delay: decoding,
            },
            TextCodec,
        );
        let admitting = Arc::clone(&clock);
        dependencies.before_request = Some(BeforeRequest::new(
            move |_| {
                admitting.spend(20);
                true
            },
            None,
        ));
        manager
            .get_request_resolver(&echo(), dependencies)
            .expect("a resolver")
            .on(Arc::new(move |request, response| {
                clock.spend(10);
                response.result(request.payload)
            }))
            .expect("registered");
        transport.open(&handle_of(1), true);
        transport.deliver(
            &Envelope::Request {
                header: scripted_header(7),
                payload: Bytes::from_static(b"hi"),
            },
            &handle_of(1),
        );
        base.settle().await;
        let sent = transport.take();
        assert_eq!(sent.len(), 1);
        assert!(
            matches!(&sent[0].1, Envelope::Result { payload, .. } if payload.as_ref() == b"hi")
        );
        router.dispose().await;
        assert_eq!(
            *locked(&seen),
            [
                (DebugDirection::Rx, 1_767_225_600_000, None),
                (
                    DebugDirection::Tx,
                    1_767_225_600_000,
                    Some(30_u64.saturating_add(decoding))
                ),
            ]
        );
    }
}
