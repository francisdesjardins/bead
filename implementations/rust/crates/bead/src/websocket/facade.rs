//! The WebSocket server and client an application starts from, as the other sides'
//! `createWebSocketServer`, `createWebSocketClient`, `WebSocketServer` and `WebSocketClient` build
//! them: a [`Server`] or a [`Client`] over a WebSocket transport, its message and unsent bounds
//! drawn from its router's limits.

use core::fmt;
use std::sync::Arc;

use futures_util::future::{Either, select};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::client::{Client, ClientOptions};
use crate::errors::{ProgrammerError, TransportError};
use crate::managers::service::{ServiceManagerClient, ServiceManagerServer};
use crate::platform::{self, Handle};
use crate::router::client::RouterClient;
use crate::router::server::RouterServer;
use crate::router::types::{BoxFuture, RouterError, RouterLimits, limits_of};
use crate::server::{Health, Server, ServerGauges, ServerOptions, SessionManager};
use crate::transport::{
    Connect, TransportClientDisconnectOptions, TransportClientReconnectOptions,
};
use crate::websocket::client::{
    WebSocketTransportClient, WebSocketTransportClientConnectOptions,
    WebSocketTransportClientOptions,
};
use crate::websocket::server::{WebSocketTransportServer, WebSocketTransportServerOptions};

#[cfg(test)]
mod tests;

// what a peer that keeps every rule can be owed at once under `limits` (spec 15.12): a chunk a
// call each way, a window a transfer, and two envelopes of this side's own
fn unsent_bytes_of(limits: &RouterLimits) -> u64 {
    limits
        .maximum_answering_calls
        .saturating_mul(limits.chunk_bytes)
        .saturating_mul(2)
        .saturating_add(limits.maximum_transfers.saturating_mul(limits.window_bytes))
        .saturating_add(limits.maximum_envelope_bytes.saturating_mul(2))
}

// the message bound `given` says, or an envelope's under `limits`; less is refused, since the
// socket would cut off envelopes the router takes
fn message_bytes_of(given: Option<u64>, limits: &RouterLimits) -> Result<u64, ProgrammerError> {
    let maximum_message_bytes = given.unwrap_or(limits.maximum_envelope_bytes);

    if maximum_message_bytes < limits.maximum_envelope_bytes {
        return Err(ProgrammerError::new(format!(
            "maximumMessageBytes is an envelope's limit at least, {} bytes, not {maximum_message_bytes}",
            limits.maximum_envelope_bytes
        )));
    }

    Ok(maximum_message_bytes)
}

// ── The server ─────────────────────────────────────────────────────────────────────────────────

/// How a WebSocket server is built: its server's options and its transport's.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct WebSocketServerOptions {
    /// The server's: its limits, its pacing, its relay, its sessions and its timeouts. Its clock,
    /// where it gives one, is its transport's.
    pub server: Option<ServerOptions>,
    /// The transport's. A message is an envelope at most, the server's limits', unless it says
    /// more; less is a [`ProgrammerError`]. What waits for a client's socket is held to what a peer
    /// that keeps every rule can be owed at once under those limits, unless it says otherwise. Its
    /// clock is every layer's.
    pub transport: Option<WebSocketTransportServerOptions>,
}

/// A server over WebSocket: a [`Server`] with a WebSocket transport server, not yet started, as its
/// bottom layer. What an application starts from: it starts its transport.
#[derive(Clone)]
pub struct WebSocketServer {
    server: Server,
    transport: WebSocketTransportServer,
}

impl fmt::Debug for WebSocketServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebSocketServer")
            .finish_non_exhaustive()
    }
}

impl WebSocketServer {
    /// A server, not yet started; its options as [`WebSocketServerOptions`] says.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for limits that do not hold, a message bound below an envelope's, and
    /// what its transport, its router, its sessions or its services refuse their options with.
    pub fn new(options: &WebSocketServerOptions) -> Result<Self, ProgrammerError> {
        let server_options = options.server.clone().unwrap_or_default();
        let limits = limits_of(&server_options.limits.clone().unwrap_or_default())?;
        let mut transport_options = options.transport.clone().unwrap_or_default();

        // ! every layer runs on its transport's clock: a server given another, its transport on the
        // platform's, would come apart from it
        if let Some(given) = server_options.clock.as_ref()
            && transport_options.clock.is_none()
        {
            return Err(ProgrammerError::new(format!(
                "a WebSocket server runs on the clock of its transport, the platform's, and was given another, {}",
                given.description()
            )));
        }

        // * every layer on one runtime: the transport's own where its options name one, else the
        // server's
        if transport_options.runtime.is_none() {
            transport_options
                .runtime
                .clone_from(&server_options.runtime);
        }

        transport_options.maximum_message_bytes = Some(message_bytes_of(
            transport_options.maximum_message_bytes,
            &limits,
        )?);
        // * what waits for a client's socket is held above what a peer that keeps every rule can
        // be owed at once under the router's limits, unless given (spec 15.12)
        transport_options.maximum_unsent_bytes = Some(
            transport_options
                .maximum_unsent_bytes
                .unwrap_or_else(|| unsent_bytes_of(&limits)),
        );

        let transport = WebSocketTransportServer::new(&transport_options)?;
        let server = Server::new(Arc::new(transport.clone()), &server_options)?;

        Ok(Self { server, transport })
    }

    /// The server it builds on, which every server's code takes.
    #[must_use]
    pub const fn server(&self) -> &Server {
        &self.server
    }

    /// Its router.
    #[must_use]
    pub fn router(&self) -> &RouterServer {
        self.server.router()
    }

    /// Its services.
    #[must_use]
    pub fn services(&self) -> &ServiceManagerServer {
        self.server.services()
    }

    /// Its sessions.
    #[must_use]
    pub fn sessions(&self) -> &SessionManager {
        self.server.sessions()
    }

    /// Its transport, which the application starts.
    #[must_use]
    pub const fn transport(&self) -> &WebSocketTransportServer {
        &self.transport
    }

    /// What each layer holds, as [`Server::gauges`] gives it.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] when two parts name the same count.
    pub fn gauges(&self) -> BoxFuture<Result<ServerGauges, ProgrammerError>> {
        self.server.gauges()
    }

    /// The verdict on its gauges, as [`Server::health`] gives it.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] when two parts name the same count.
    pub fn health(&self) -> BoxFuture<Result<Health, ProgrammerError>> {
        self.server.health()
    }

    /// Lets go of its layers in the reverse of the order they were built in, then stops its
    /// transport, as [`Server::dispose`] does.
    ///
    /// # Errors
    ///
    /// What its transport refuses its stop with: one still starting, say.
    pub fn dispose(&self) -> BoxFuture<Result<(), RouterError>> {
        self.server.dispose()
    }
}

// ── The client ─────────────────────────────────────────────────────────────────────────────────

/// How a WebSocket client is built: its client's options and its transport's.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct WebSocketClientOptions {
    /// The client's: its router's limits, its credential, its credentials, its metrics and its
    /// intake.
    pub client: Option<ClientOptions>,
    /// The transport's. A message is an envelope at most, the client's limits', unless it says
    /// more; less is a [`ProgrammerError`]. Its clock is every layer's.
    pub transport: Option<WebSocketTransportClientOptions>,
}

/// A client over WebSocket: a [`Client`] with a WebSocket transport client as its bottom layer, all
/// on its transport's clock. What an application starts from.
#[derive(Clone)]
pub struct WebSocketClient {
    client: Client,
    transport: WebSocketTransportClient,
    runtime: Handle,
    // ends with the client: a reconnection it started must not outlive it
    lifetime: CancellationToken,
}

impl fmt::Debug for WebSocketClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebSocketClient")
            .finish_non_exhaustive()
    }
}

impl WebSocketClient {
    /// A client, not yet connected; its options as [`WebSocketClientOptions`] says.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for limits that do not hold, a message bound below an envelope's, and
    /// what its transport, its router or its services refuse their options with.
    pub fn new(options: &WebSocketClientOptions) -> Result<Self, ProgrammerError> {
        let client_options = options.client.clone().unwrap_or_default();
        let runtime = platform::runtime_of(client_options.runtime.as_ref(), "a WebSocket client")?;
        let limits = limits_of(&client_options.limits.clone().unwrap_or_default())?;
        let mut transport_options = options.transport.clone().unwrap_or_default();

        // * every layer on one runtime: the transport's own where its options name one, else the
        // client's
        transport_options.runtime = Some(
            transport_options
                .runtime
                .clone()
                .unwrap_or_else(|| runtime.clone()),
        );
        transport_options.maximum_message_bytes = Some(message_bytes_of(
            transport_options.maximum_message_bytes,
            &limits,
        )?);

        let transport = WebSocketTransportClient::new(&transport_options)?;
        let client = Client::new(Arc::new(transport.clone()), &client_options)?;

        Ok(Self {
            client,
            transport,
            runtime,
            lifetime: CancellationToken::new(),
        })
    }

    /// The client it builds on, which every client's code takes.
    #[must_use]
    pub const fn client(&self) -> &Client {
        &self.client
    }

    /// Its router.
    #[must_use]
    pub const fn router(&self) -> &RouterClient {
        self.client.router()
    }

    /// Its services.
    #[must_use]
    pub const fn services(&self) -> &ServiceManagerClient {
        self.client.services()
    }

    /// Its transport.
    #[must_use]
    pub const fn transport(&self) -> &WebSocketTransportClient {
        &self.transport
    }

    /// Connects its transport, as [`WebSocketTransportClient::connect`] does.
    pub fn connect(&self, options: &WebSocketTransportClientConnectOptions) -> Connect {
        self.transport.connect(options)
    }

    /// Closes its transport's connection, as [`WebSocketTransportClient::disconnect`] does.
    ///
    /// # Errors
    ///
    /// A [`TransportError::ReadyState`] when it is not open, refused as it is called.
    pub fn disconnect(
        &self,
        options: &TransportClientDisconnectOptions,
    ) -> Result<BoxFuture<()>, TransportError> {
        self.transport.disconnect(options)
    }

    /// Reconnects its transport, as [`WebSocketTransportClient::reconnect`] does; its dispose
    /// cancels it, as the signal given does.
    ///
    /// # Errors
    ///
    /// What its transport refuses the reconnection with, as it is called.
    pub fn reconnect(
        &self,
        options: &TransportClientReconnectOptions,
    ) -> Result<BoxFuture<Result<(), TransportError>>, TransportError> {
        let signal = self.lifetime.child_token();
        // * its end, once the reconnection settled: the signal given then moves nothing
        let finished = signal.child_token();

        if let Some(given) = options.signal.clone() {
            if given.is_cancelled() {
                signal.cancel();
            } else {
                let linked = signal.clone();
                let ended = finished.clone();

                drop(platform::spawn(&self.runtime, async move {
                    let given_up = core::pin::pin!(given.cancelled_owned());
                    let over = core::pin::pin!(ended.cancelled_owned());

                    if let Either::Left(_) = select(given_up, over).await {
                        linked.cancel();
                    }
                }));
            }
        }

        let mut linked = options.clone();

        linked.signal = Some(signal);

        let reconnecting = self.transport.reconnect(&linked).inspect_err(|_refused| {
            finished.cancel();
        })?;

        Ok(Box::pin(async move {
            let reconnected = reconnecting.await;

            finished.cancel();

            reconnected
        }))
    }

    /// Cancels a reconnection under way, so none reopens a connection nothing owns; then takes its
    /// layers apart in the reverse of the order they were built in: its router rejects what still
    /// waits, as disposed, then its transport closes, as [`WebSocketTransportClient::close`] does.
    /// It starts as it is called, the future only waiting for its end.
    pub fn dispose(&self) -> BoxFuture<()> {
        self.lifetime.cancel();

        let disposed = self.client.dispose();
        let transport = self.transport.clone();
        let (done, ended) = oneshot::channel();

        drop(platform::spawn(&self.runtime, async move {
            disposed.await;
            transport.close().await;
            done.send(()).ok();
        }));

        Box::pin(async move {
            ended.await.ok();
        })
    }
}
