//! A server and a client over a pair of the in-memory transport, on one stepping clock: what the
//! unit tests of the routers, the managers and the trace build their calls on.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use crate::client::{Client, ClientOptions};
use crate::clock::SharedClock;
use crate::constants::ProcedureKind;
use crate::identity::Procedure;
use crate::memory::{
    MemoryClient, MemoryClientOptions, MemoryConnectOptions, MemoryServer, MemoryServerOptions,
};
use crate::router::types::{ConnectionHandle, RouterError};
use crate::server::{Server, ServerOptions};
use crate::testing::SteppingClock;
use crate::transport::{ServerListener, ServerTransport};

/// What a server's router reported, each with its connection.
pub type ServerReports = Arc<Mutex<Vec<(RouterError, Option<ConnectionHandle>)>>>;

/// What a pair is built with: its server's options and its client's, their clock the pair's own.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct PairOptions {
    /// The server's.
    pub server: ServerOptions,
    /// The client's.
    pub client: ClientOptions,
}

// the handle the server drew last
struct Drawing {
    last: Arc<Mutex<Option<ConnectionHandle>>>,
}

impl ServerListener for Drawing {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        *self.last.lock().unwrap_or_else(PoisonError::into_inner) =
            Some(Arc::clone(connection_handle));
    }
}

/// A server and a client of it over the in-memory transport, connected.
#[derive(Debug)]
pub struct Pair {
    /// The clock both run on.
    pub clock: Arc<SteppingClock>,
    /// The server.
    pub server: Server,
    /// The server's transport.
    pub memory: MemoryServer,
    /// The client.
    pub client: Client,
    /// The client's transport.
    pub transport: MemoryClient,
    /// The handle the server drew for the client's connection.
    pub connection_handle: ConnectionHandle,
    /// What the server's router reported, each with its connection.
    pub server_reports: ServerReports,
    /// What the client's router reported.
    pub client_reports: Arc<Mutex<Vec<RouterError>>>,
}

/// The procedure every pair's tests call: service 2, procedure 1, `echo`, revision 3.
#[must_use]
pub fn echo() -> Procedure {
    Procedure {
        service_id: 2,
        id: 1,
        service_revision: 3,
        name: "echo".to_owned(),
        kind: Some(ProcedureKind::Request),
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

impl Pair {
    /// A pair built with `options`, started and connected, its wall clock at `start`.
    ///
    /// # Errors
    ///
    /// What building, starting or connecting it refuses.
    pub async fn connected((start, options): (SystemTime, PairOptions)) -> Result<Self, String> {
        let clock = SteppingClock::new(start);
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let memory = MemoryServer::new(&MemoryServerOptions {
            clock: Some(Arc::clone(&shared)),
            runtime: None,
        })
        .map_err(|error| error.to_string())?;
        let drawn = Arc::new(Mutex::new(None));

        memory.listen(Arc::new(Drawing {
            last: Arc::clone(&drawn),
        }));

        let mut server_options = options.server;

        server_options.clock = Some(Arc::clone(&shared));

        let server = Server::new(Arc::new(memory.clone()), &server_options)
            .map_err(|error| error.to_string())?;
        let transport = MemoryClient::new(&MemoryClientOptions {
            clock: Some(Arc::clone(&shared)),
            server: memory.clone(),
        })
        .map_err(|error| error.to_string())?;
        let client = Client::new(Arc::new(transport.clone()), &options.client)
            .map_err(|error| error.to_string())?;
        let server_reports: ServerReports = Arc::default();
        let client_reports: Arc<Mutex<Vec<RouterError>>> = Arc::default();
        let (to_server, to_client) = (Arc::clone(&server_reports), Arc::clone(&client_reports));

        server.router().on_error(Arc::new(
            move |error: &RouterError, handle: Option<&ConnectionHandle>| {
                to_server
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push((error.clone(), handle.cloned()));
            },
        ));
        client
            .router()
            .on_error(Arc::new(move |error: &RouterError| {
                to_client
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(error.clone());
            }));
        memory.start().await.map_err(|error| error.to_string())?;
        transport
            .connect(MemoryConnectOptions {
                address: Some("127.0.0.1".to_owned()),
                port: Some(50_001),
                signal: None,
                timeout: None,
            })
            .await
            .map_err(|error| error.to_string())?;
        clock.settle().await;

        let connection_handle = drawn
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or("the server drew no connection")?;

        Ok(Self {
            clock,
            server,
            memory,
            client,
            transport,
            connection_handle,
            server_reports,
            client_reports,
        })
    }

    /// Done once both ends did all they can without the clock moving.
    pub async fn settle(&self) {
        self.clock.settle().await;
    }
}
