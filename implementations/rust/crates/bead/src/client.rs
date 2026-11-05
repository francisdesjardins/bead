//! A client: a transport client, its router and its services, built together.

use core::fmt;
use std::sync::Arc;

use tokio::runtime::Handle;

use crate::clock::SharedClock;
use crate::credentials::Credentials;
use crate::errors::ProgrammerError;
use crate::managers::service::{ServiceManagerClient, ServiceManagerOptions};
use crate::metrics::MetricsRegistry;
use crate::router::client::{RouterClient, RouterClientOptions};
use crate::router::types::{
    BoxFuture, IntakeLimitsOptions, RequestCredential, RouterLimitsOptions,
};
use crate::transport::RouterClientTransport;

#[cfg(test)]
mod tests;

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
    /// What its router holds untaken of what its server sent, past which it pauses its transport
    /// (spec 15.12).
    pub intake: Option<IntakeLimitsOptions>,
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
    services: ServiceManagerClient,
    transport: Arc<dyn RouterClientTransport>,
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
        transport: Arc<dyn RouterClientTransport>,
        options: &ClientOptions,
    ) -> Result<Self, ProgrammerError> {
        let clock: Option<SharedClock> = transport.clock();
        let router_options = RouterClientOptions {
            last_call_id: None,
            clock,
            runtime: options.runtime.clone(),
            credential: options.credential.clone(),
            credentials: options.credentials.clone(),
            limits: options.limits.clone(),
            metrics_registry: options.metrics_registry.clone(),
            intake: options.intake.clone(),
        };

        let router = RouterClient::new(Arc::clone(&transport), &router_options)?;
        let services =
            ServiceManagerClient::new(router.clone(), &ServiceManagerOptions::default())?;

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
    pub const fn services(&self) -> &ServiceManagerClient {
        &self.services
    }

    /// Its transport.
    #[must_use]
    pub fn transport(&self) -> Arc<dyn RouterClientTransport> {
        Arc::clone(&self.transport)
    }

    /// Disposes of its router: every call ends, and nothing more goes out; its transport is the
    /// application's to close.
    pub fn dispose(&self) -> BoxFuture<()> {
        self.router.dispose()
    }
}
