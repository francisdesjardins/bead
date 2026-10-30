//! A client: a transport client, its router and its services, built together.

use core::fmt;
use std::sync::Arc;

use tokio::runtime::Handle;

use crate::clock::SharedClock;
use crate::credentials::Credentials;
use crate::errors::ProgrammerError;
use crate::managers::service::{ServiceManager, ServiceManagerOptions, ServiceRouter};
use crate::metrics::MetricsRegistry;
use crate::router::client::{RouterClient, RouterClientOptions};
use crate::router::types::{BoxFuture, RequestCredential, RouterLimitsOptions};
use crate::transport::ClientTransport;

/// How a client is built, beyond its transport.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct ClientOptions {
    /// The runtime its owner runs on: the current one when none.
    pub runtime: Option<Handle>,
    /// The credential every call presents but one that gives its own.
    pub credential: Option<RequestCredential>,
    /// What resolves a command's `JWT` and `ELSEWHERE`.
    pub credentials: Option<Credentials>,
    /// Its router's limits.
    pub limits: Option<RouterLimitsOptions>,
    /// What its router counts its calls into.
    pub metrics_registry: Option<MetricsRegistry>,
}

impl fmt::Debug for ClientOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClientOptions")
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

/// A client: its transport, its router and its services, on its transport's clock.
#[derive(Clone)]
pub struct Client {
    router: RouterClient,
    services: ServiceManager,
    transport: Arc<dyn ClientTransport>,
}

impl fmt::Debug for Client {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Client").finish_non_exhaustive()
    }
}

impl Client {
    /// A client over `transport`, on its clock.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] as its router or its services refuse their options.
    pub fn new(
        transport: Arc<dyn ClientTransport>,
        options: &ClientOptions,
    ) -> Result<Self, ProgrammerError> {
        let clock: Option<SharedClock> = transport.clock();
        let router_options = RouterClientOptions {
            clock,
            runtime: options.runtime.clone(),
            credential: options.credential.clone(),
            credentials: options.credentials.clone(),
            limits: options.limits.clone(),
            metrics_registry: options.metrics_registry.clone(),
        };

        let router = RouterClient::new(Arc::clone(&transport), &router_options)?;
        let services = ServiceManager::new(
            ServiceRouter::Client(router.clone()),
            &ServiceManagerOptions::default(),
        )?;

        Ok(Self {
            router,
            services,
            transport,
        })
    }

    /// Its router.
    #[must_use]
    pub const fn router(&self) -> &RouterClient {
        &self.router
    }

    /// Its services.
    #[must_use]
    pub const fn services(&self) -> &ServiceManager {
        &self.services
    }

    /// Its transport.
    #[must_use]
    pub fn transport(&self) -> Arc<dyn ClientTransport> {
        Arc::clone(&self.transport)
    }

    /// Disposes of its router: every call ends, and nothing more goes out; its transport is the
    /// application's to close.
    pub fn dispose(&self) -> BoxFuture<()> {
        self.router.dispose()
    }
}
