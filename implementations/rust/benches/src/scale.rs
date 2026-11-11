//! The scale of a message's cost (`--scale`): a server's router, and a `Server` over it, each holding
//! 1, 1,000 and 10,000 connections, then handed 20,000 CANCELs for no call (dropped in silence,
//! spec 10.2) spread over them, timed until its owner took them all. A message's cost holds flat in
//! the connections held, or the bench fails.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use bead::internal::{Envelope, write_envelope};
use bead::{
    BoxFuture, CancelHeader, ConnectionHandle, RouterError, RouterServer, RouterServerOptions,
    Sent, Server, ServerListener, ServerOptions, ServerTransport, SharedClock, SystemClock,
    TransportMessage,
};

// the messages a round hands its server
const MESSAGES: usize = 20_000;

// the connections a round holds
const CONNECTIONS: [usize; 3] = [1, 1_000, 10_000];

// the rounds at each count, the fastest kept, so a pause of the machine's own weighs nothing
const ROUNDS: usize = 3;

// ! the most a message may cost at 10,000 connections over its cost at 1: a lookup in a list grows
// it some thirty to sixty times, a hashed one a few at most, as caches miss
const FLAT: f64 = 4.0;

/// A server's transport that only opens connections and hands their messages over: nothing it is
/// sent is kept, so the bench measures the router alone.
struct Stage {
    clock: SharedClock,
    listeners: Mutex<Vec<Arc<dyn ServerListener>>>,
}

impl std::fmt::Debug for Stage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Stage").finish_non_exhaustive()
    }
}

impl Stage {
    fn tell<C: Fn(&dyn ServerListener)>(&self, call: C) {
        let listeners = self
            .listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();

        for listener in listeners {
            call(listener.as_ref());
        }
    }
}

impl ServerTransport for Stage {
    fn send(
        &self,
        _message: TransportMessage,
        _connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        Ok(Sent::Done)
    }

    fn close(&self, _connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        Box::pin(async { false })
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|held| !Arc::ptr_eq(held, listener));
    }

    // a pause holds nothing here: the bench hands each message as it measures it
    fn pause(&self, _connection_handle: &ConnectionHandle) {}

    fn resume(&self, _connection_handle: &ConnectionHandle) {}

    fn clock(&self) -> Option<SharedClock> {
        Some(Arc::clone(&self.clock))
    }

    fn stop(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }
}

/// What a round measured: opening its connections, and a message's cost.
#[derive(Clone, Copy)]
struct Round {
    opening: Duration,
    per_message: f64,
}

/// The layer a round measures.
#[derive(Clone, Copy)]
enum Layer {
    Router,
    Server,
}

impl Layer {
    const fn name(self) -> &'static str {
        match self {
            Self::Router => "RouterServer",
            Self::Server => "Server",
        }
    }
}

/// The router a round drives, alone or under its `Server`.
enum Driven {
    Router(RouterServer),
    Server(Server),
}

impl Driven {
    // its gauges, read on its owner: done once the owner took all handed before
    async fn settled(&self) {
        match self {
            Self::Router(router) => drop(router.gauges().await),
            Self::Server(server) => drop(server.gauges().await),
        }
    }

    async fn dispose(self) -> Result<(), String> {
        match self {
            Self::Router(router) => {
                router.dispose().await;

                Ok(())
            }
            Self::Server(server) => server.dispose().await.map_err(|error| error.to_string()),
        }
    }
}

// the handle of connection `ordinal`, as a WebSocket server's transport draws one
fn handle_of(ordinal: usize) -> ConnectionHandle {
    Arc::from(format!(
        "type=WS;ip=127.0.0.1;port={};ordinal={ordinal}",
        40_000_usize.saturating_add(ordinal.checked_rem(20_000).unwrap_or_default())
    ))
}

async fn round((layer, connections): (Layer, usize)) -> Result<Round, String> {
    let clock: SharedClock = Arc::new(SystemClock::current().map_err(|error| error.to_string())?);
    let stage = Arc::new(Stage {
        clock,
        listeners: Mutex::default(),
    });
    let carried: Arc<dyn ServerTransport> = Arc::<Stage>::clone(&stage);
    let driven = match layer {
        Layer::Router => Driven::Router(
            RouterServer::new(carried, &RouterServerOptions::default())
                .map_err(|error| error.to_string())?,
        ),
        Layer::Server => {
            let mut options = ServerOptions::default();

            // * a server that closes a silent connection, as a deployment sets it: each message
            // arms its connection's timer anew
            options.connection_inactivity_timeout = Some(Duration::from_secs(600));

            Driven::Server(Server::new(carried, &options).map_err(|error| error.to_string())?)
        }
    };
    let handles: Vec<ConnectionHandle> = (0..connections).map(handle_of).collect();
    let mut message = TransportMessage::default();

    message.data = write_envelope(
        &Envelope::Cancel {
            header: CancelHeader { call_id: 1 },
        },
        1_024,
    )
    .map_err(|error| error.to_string())?;
    let opening = Instant::now();

    for handle in &handles {
        stage.tell(|listener| listener.on_connection(handle));
    }

    driven.settled().await;

    let opened = opening.elapsed();
    let taking = Instant::now();

    for handle in handles.iter().cycle().take(MESSAGES) {
        stage.tell(|listener| listener.on_message(message.clone(), handle));
    }

    driven.settled().await;

    let taken = taking.elapsed();

    driven.dispose().await?;

    Ok(Round {
        opening: opened,
        per_message: taken.as_secs_f64() * 1_000_000.0 / crate::double_of(MESSAGES),
    })
}

// the fastest of a count's rounds
async fn fastest((layer, connections): (Layer, usize)) -> Result<Round, String> {
    let mut kept: Option<Round> = None;

    for _ in 0..ROUNDS {
        let measured = round((layer, connections)).await?;

        kept = Some(kept.map_or(measured, |held| Round {
            opening: held.opening.min(measured.opening),
            per_message: held.per_message.min(measured.per_message),
        }));
    }

    kept.ok_or_else(|| "a count is measured in at least one round".to_owned())
}

/// Measures each layer at each count, writes a line for each, and fails when a message's cost does
/// not hold flat.
pub(crate) async fn scale() -> Result<(), String> {
    let mut steep = Vec::new();

    for layer in [Layer::Server, Layer::Router] {
        let mut first: Option<f64> = None;
        let mut last = 0.0;

        for connections in CONNECTIONS {
            let measured = fastest((layer, connections)).await?;

            println!(
                "| {} | {connections} | {:.1} ms | {:.2} us |",
                layer.name(),
                measured.opening.as_secs_f64() * 1_000.0,
                measured.per_message
            );

            first.get_or_insert(measured.per_message);
            last = measured.per_message;
        }

        let ratio = first.map_or(0.0, |first| last / first);

        if ratio > FLAT {
            steep.push(format!(
                "{}: a message costs {ratio:.1} times as much at {} connections as at {}",
                layer.name(),
                CONNECTIONS.last().copied().unwrap_or_default(),
                CONNECTIONS.first().copied().unwrap_or_default()
            ));
        }
    }

    if steep.is_empty() {
        Ok(())
    } else {
        Err(steep.join("; "))
    }
}
