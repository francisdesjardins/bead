//! The HTTP server and client an application starts from, as the other sides' `createHTTPServer`,
//! `createHTTPClient`, `HttpServer` and `BeadHttpClient` build them: a [`Server`] or a [`Client`]
//! over an HTTP transport, one envelope per exchange, its router's limits whole envelopes and no
//! transfer, its transport's body bound their envelope.

use core::fmt;
use core::time::Duration;
use std::sync::Arc;

use futures_util::future::{Either, select};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::client::{Client, ClientOptions};
use crate::errors::{ProgrammerError, TransportError};
use crate::http::client::{
    HttpTransportClient, HttpTransportClientConnectOptions, HttpTransportClientOptions,
};
use crate::http::server::{HttpTransportServer, HttpTransportServerOptions};
use crate::managers::service::{ServiceManagerClient, ServiceManagerServer};
use crate::platform::{self, Handle};
use crate::router::client::RouterClient;
use crate::router::server::RouterServer;
use crate::router::types::{
    BoxFuture, RouterError, RouterLimits, RouterLimitsOptions, limits_of, whole_envelope_limits_of,
};
use crate::server::{Health, Server, ServerGauges, ServerOptions, SessionManager};
use crate::transport::{
    Connect, TransportClientDisconnectOptions, TransportClientReconnectOptions,
};

#[cfg(test)]
mod tests;

/// How long, by default, a connection with no session may stay silent over HTTP: a connection is
/// drawn by any `POST`, so one never used goes within 30 s (spec 13.7).
pub const CONNECTION_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(30);

// the router's limits over HTTP, whole envelopes and no transfer: as they are given on, and as they
// hold
fn whole_limits_of(
    given: &RouterLimitsOptions,
) -> Result<(RouterLimitsOptions, RouterLimits), ProgrammerError> {
    let whole = whole_envelope_limits_of(given)?;
    let limits = limits_of(&whole)?;

    Ok((whole, limits))
}

// ── The server ─────────────────────────────────────────────────────────────────────────────────

/// How an HTTP server is built: its server's options and its transport's.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct HttpServerOptions {
    /// The server's. Its limits carry whole envelopes and no transfer, a transfer asked for a
    /// [`ProgrammerError`]; its connection inactivity timeout is [`CONNECTION_INACTIVITY_TIMEOUT`]
    /// when it gives none. Its clock, where it gives one, is its transport's.
    pub server: Option<ServerOptions>,
    /// The transport's. The largest body is the limits' envelope, which they set, whatever it
    /// says; the requests waiting on one connection are the limits' `maximum_answering_calls`
    /// unless it says otherwise. Its clock is every layer's.
    pub transport: Option<HttpTransportServerOptions>,
}

/// A server over HTTP: a [`Server`] with an HTTP transport server, not yet started, as its bottom
/// layer, one envelope per exchange. What an application starts from: it starts its transport.
///
/// Its router takes no transfer — a request's body reaches it before its answer goes, so no
/// credit could come back — and a payload is what one envelope holds. What it sends of its own
/// reaches a client that listens; a client that does not is refused a subscription, and a command
/// to it fails.
#[derive(Clone)]
pub struct HttpServer {
    server: Server,
    transport: HttpTransportServer,
}

impl fmt::Debug for HttpServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("HttpServer").finish_non_exhaustive()
    }
}

impl HttpServer {
    /// A server, not yet started; its options as [`HttpServerOptions`] says.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for limits that do not hold or ask for a transfer, and what its
    /// transport, its router, its sessions or its services refuse their options with: a
    /// connection inactivity timeout of 0 among them, which its default does not stand in for.
    pub fn new(options: &HttpServerOptions) -> Result<Self, ProgrammerError> {
        let mut server_options = options.server.clone().unwrap_or_default();
        let (whole, limits) = whole_limits_of(&server_options.limits.clone().unwrap_or_default())?;
        let mut transport_options = options.transport.clone().unwrap_or_default();

        // ! every layer runs on its transport's clock: a server given another, its transport on the
        // platform's, would come apart from it
        if let Some(given) = server_options.clock.as_ref()
            && transport_options.clock.is_none()
        {
            return Err(ProgrammerError::new(format!(
                "an HTTP server runs on the clock of its transport, the platform's, and was given another, {}",
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

        transport_options.maximum_body_bytes = Some(limits.maximum_envelope_bytes);
        // * one number for one thing: an honest client, holding itself to the calls its server
        // answers at once, never meets the transport's 429
        transport_options.maximum_waiting_exchanges = Some(
            transport_options
                .maximum_waiting_exchanges
                .unwrap_or(limits.maximum_answering_calls),
        );
        server_options.limits = Some(whole);
        server_options.connection_inactivity_timeout = Some(
            server_options
                .connection_inactivity_timeout
                .unwrap_or(CONNECTION_INACTIVITY_TIMEOUT),
        );

        let transport = HttpTransportServer::new(&transport_options)?;
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
    pub const fn transport(&self) -> &HttpTransportServer {
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

/// How an HTTP client is built: its client's options and its transport's.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct HttpClientOptions {
    /// The client's: its router's limits, whole envelopes and no transfer, a transfer asked for a
    /// [`ProgrammerError`]; its credential, its credentials, its metrics and its intake.
    pub client: Option<ClientOptions>,
    /// The transport's. The largest answer is the limits' envelope, which they set, whatever it
    /// says. Its clock is every layer's.
    pub transport: Option<HttpTransportClientOptions>,
}

/// A client over HTTP: a [`Client`] with an HTTP transport client as its bottom layer, all on its
/// transport's clock, one envelope per exchange. What an application starts from.
///
/// It sends no transfer, and a payload is what one envelope holds. It listens for what the server
/// sends of its own — a subscription's notifications, a command — unless its transport is told
/// not to.
#[derive(Clone)]
pub struct HttpClient {
    client: Client,
    transport: HttpTransportClient,
    runtime: Handle,
    // ends with the client: a reconnection it started must not outlive it
    lifetime: CancellationToken,
}

impl fmt::Debug for HttpClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("HttpClient").finish_non_exhaustive()
    }
}

impl HttpClient {
    /// A client, not yet connected; its options as [`HttpClientOptions`] says.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for limits that do not hold or ask for a transfer, and what its
    /// transport, its router or its services refuse their options with.
    pub fn new(options: &HttpClientOptions) -> Result<Self, ProgrammerError> {
        let mut client_options = options.client.clone().unwrap_or_default();
        let runtime = platform::runtime_of(client_options.runtime.as_ref(), "an HTTP client")?;
        let (whole, limits) = whole_limits_of(&client_options.limits.clone().unwrap_or_default())?;
        let mut transport_options = options.transport.clone().unwrap_or_default();

        // * every layer on one runtime: the transport's own where its options name one, else the
        // client's
        transport_options.runtime = Some(
            transport_options
                .runtime
                .clone()
                .unwrap_or_else(|| runtime.clone()),
        );
        transport_options.maximum_body_bytes = Some(limits.maximum_envelope_bytes);
        client_options.limits = Some(whole);

        let transport = HttpTransportClient::new(&transport_options)?;
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
    pub const fn transport(&self) -> &HttpTransportClient {
        &self.transport
    }

    /// Connects its transport, as [`HttpTransportClient::connect`] does.
    pub fn connect(&self, options: &HttpTransportClientConnectOptions) -> Connect {
        self.transport.connect(options)
    }

    /// Closes its transport's connection, as [`HttpTransportClient::disconnect`] does.
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

    /// Reconnects its transport, as [`HttpTransportClient::reconnect`] does; its dispose cancels
    /// it, as the signal given does.
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

        // * settled by a task of its own, as it is called: its future only waits, and dropping
        // it leaves the watch on the signal given to end with the reconnection
        let (done, settled) = oneshot::channel();

        drop(platform::spawn(&self.runtime, async move {
            let reconnected = reconnecting.await;

            finished.cancel();
            done.send(reconnected).ok();
        }));

        Ok(Box::pin(async move {
            settled.await.unwrap_or_else(|_gone| {
                Err(TransportError::cancelled(
                    "the reconnection ended with its runtime",
                ))
            })
        }))
    }

    /// Cancels a reconnection under way, so none reopens a connection nothing owns; then takes its
    /// layers apart in the reverse of the order they were built in: its router rejects what still
    /// waits, as disposed, then its transport closes, as [`HttpTransportClient::close`] does. It
    /// starts as it is called, the future only waiting for its end.
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
