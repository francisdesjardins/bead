//! The manager's requester, resolver and notification twins, on the test kit's clock.

use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;

use super::{DebugEvent, ServiceManager, ServiceManagerOptions, ServiceRouter, TracedError};
use crate::clock::SharedClock;
use crate::envelope::{FailureRecord, RequestHeader};
use crate::errors::CallError;
use crate::router::core::{Answerer, ResolverProps};
use crate::router::server::{RouterServer, RouterServerOptions};
use crate::router::types::{BoxFuture, RouterAnswer, Signal};
use crate::testing::SteppingClock;
use crate::testing::scripted::{ScriptedServer, handle_of};

mod admissions;
mod arrival;
mod notification_endings;
mod notification_unit;
mod notifications;
mod notifier;
mod requester;
mod resolver;
mod resolver_edges;
mod sessions;
mod validation;

type Heard = Arc<Mutex<Vec<(Option<String>, DebugEvent)>>>;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Fixture {
    clock: Arc<SteppingClock>,
    transport: Arc<ScriptedServer>,
    router: RouterServer,
    manager: ServiceManager,
}

impl Fixture {
    fn new() -> Self {
        Self::with(&RouterServerOptions::default())
    }

    fn with(options: &RouterServerOptions) -> Self {
        let clock = SteppingClock::new(crate::testing::instants::new_year());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let transport = ScriptedServer::new(shared);
        let carried: Arc<dyn crate::transport::ServerTransport> =
            Arc::<ScriptedServer>::clone(&transport);
        let router = RouterServer::new(carried, options).expect("a server router");
        let manager = ServiceManager::new(
            ServiceRouter::Server(router.clone()),
            &ServiceManagerOptions::default(),
        )
        .expect("a manager");
        Self {
            clock,
            transport,
            router,
            manager,
        }
    }

    fn heard(&self) -> Heard {
        let heard: Heard = Arc::default();
        let hearing = Arc::clone(&heard);
        self.manager
            .on_debug(Arc::new(move |error: Option<&TracedError>, event| {
                locked(&hearing).push((error.map(ToString::to_string), event.clone()));
            }));
        heard
    }
}

#[derive(Debug, Default)]
struct Recording {
    subscriptions: Mutex<usize>,
    answers: Mutex<Vec<RouterAnswer>>,
    attempts: Mutex<Vec<RouterAnswer>>,
    refuse_payload: Mutex<Option<CallError>>,
    delay: Mutex<Option<(Arc<SteppingClock>, Duration)>>,
}

impl Recording {
    fn answers(&self) -> Vec<RouterAnswer> {
        locked(&self.answers).clone()
    }
}

impl Answerer for Recording {
    fn respond(&self, answer: RouterAnswer) -> BoxFuture<Result<(), CallError>> {
        locked(&self.attempts).push(answer.clone());
        let refusal = if matches!(answer, RouterAnswer::Result(_)) {
            locked(&self.refuse_payload).clone()
        } else {
            None
        };
        if refusal.is_none() {
            locked(&self.answers).push(answer);
        }
        let delay = locked(&self.delay).clone();
        Box::pin(async move {
            if let Some(reason) = refusal {
                if let Some((clock, delay)) = delay {
                    clock.advance(delay).await;
                }
                return Err(reason);
            }
            Ok(())
        })
    }

    fn answered(&self) -> BoxFuture<Option<FailureRecord>> {
        Box::pin(async { None })
    }

    fn subscribe(&self) -> BoxFuture<Result<u32, CallError>> {
        let mut subscriptions = locked(&self.subscriptions);
        *subscriptions = subscriptions.saturating_add(1);
        drop(subscriptions);
        Box::pin(async { Ok(7) })
    }
}

fn header() -> RequestHeader {
    RequestHeader {
        call_id: 7,
        service_id: 2,
        procedure_id: 1,
        destination_id: None,
        opens_subscription: false,
        paced: false,
        total: None,
        credential: None,
    }
}

fn props(recording: &Arc<Recording>, payload: &[u8]) -> ResolverProps {
    ResolverProps {
        is_admitted: true,
        connection_handle: handle_of(1),
        header: header(),
        payload: Bytes::copy_from_slice(payload),
        session: None,
        signal: Signal::new(),
        answerer: Arc::<Recording>::clone(recording),
        carried: None,
    }
}
struct ClientFixture {
    clock: Arc<SteppingClock>,
    transport: Arc<crate::testing::scripted::ScriptedClient>,
    router: crate::router::client::RouterClient,
    manager: ServiceManager,
}

impl ClientFixture {
    fn new() -> Self {
        let clock = SteppingClock::new(crate::testing::instants::new_year());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let transport = crate::testing::scripted::ScriptedClient::new(shared);
        let carried: Arc<dyn crate::transport::ClientTransport> =
            Arc::<crate::testing::scripted::ScriptedClient>::clone(&transport);
        let router = crate::router::client::RouterClient::new(
            carried,
            &crate::router::client::RouterClientOptions::default(),
        )
        .expect("a client router");
        let manager = ServiceManager::new(
            ServiceRouter::Client(router.clone()),
            &ServiceManagerOptions::default(),
        )
        .expect("a manager");
        Self {
            clock,
            transport,
            router,
            manager,
        }
    }
}
