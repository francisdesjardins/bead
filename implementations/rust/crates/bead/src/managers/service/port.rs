//! The port beneath a service manager: what the manager asks of the router it runs over, a server's
//! or a client's (decision 0044). Bead's two routers take it each through a wrapper of its own, as a
//! client's router takes a relay's `RelayRouter` through one, so the port stays the crate's own; a
//! router of the application's own, its `ServiceRouter` variant and the answerer its resolvers are
//! handed, are the matrix's row ahead.

use core::fmt;
use std::sync::Arc;

use bytes::Bytes;

use super::{Maker, ServiceRouter};
use crate::clock::SharedClock;
use crate::constants::RouterSide;
use crate::errors::{CallError, ProgrammerError};
use crate::identity::Procedure;
use crate::metrics::ProcedureSeries;
use crate::router::client::{NotificationLike, RouterClient, UnregisterNotificationOptions};
use crate::router::core::Handler;
use crate::router::server::{Call, RouterServer};
use crate::router::types::{BoxFuture, ConnectionHandle, RouterError, RouterLimits, RouterRequest};

/// The router a service manager runs over, as the manager reads it. Each operation takes effect as
/// it is made, and the future it gives only waits: dropped, it cancels nothing.
pub(crate) trait RouterLike: Send + Sync + fmt::Debug {
    /// Its side, whose makers its manager offers.
    fn side(&self) -> RouterSide;

    /// Its limits, which bound a refusal's detail.
    fn limits(&self) -> RouterLimits;

    /// The clock it runs on.
    fn clock(&self) -> SharedClock;

    /// Reports what went wrong that no call waits on, with the connection it came with: a server's
    /// names it, a client's has one alone.
    fn report(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>);

    /// Declares a requester of `procedure` as it is made: the series each of its calls counts into,
    /// none for a router that counts nothing.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure the router refuses to declare.
    fn declare_requester(
        &self,
        procedure: &Procedure,
    ) -> Result<Option<ProcedureSeries>, ProgrammerError>;

    /// Registers the resolver of `procedure`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure the router refuses: a second resolver of it, say.
    fn register_resolver(
        &self,
        procedure: &Procedure,
        handler: Handler,
    ) -> Result<(), ProgrammerError>;

    /// Makes a call, sent as it is made. Its `on_call_id` hears the id the router draws, or is
    /// dropped unfired by a router that draws none, so what waits on it reads none.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a call the router refuses as it is made.
    fn request(&self, payload: Bytes, request: RouterRequest) -> Result<Call, ProgrammerError>;

    /// Spawns `future`, counted as the router's work.
    fn cover(&self, future: BoxFuture<()>);

    /// Whether it holds `notification`, this one and not another of its procedure: a server's
    /// holds none.
    fn has_notification(&self, _notification: &Arc<dyn NotificationLike>) -> bool {
        false
    }

    /// Registers `notification`, held as it is made; its future settles as its subscription does,
    /// at once for a router whose subscription is its call alone. A server's hears none.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a notification the router refuses to hold: one already registered
    /// for its procedure, say.
    fn register_notification(
        &self,
        _notification: Arc<dyn NotificationLike>,
    ) -> Result<BoxFuture<Result<(), CallError>>, ProgrammerError> {
        Err(ProgrammerError::new(Maker::Notification.refusal()))
    }

    /// Lets go of `notification` as it is made, its subscription cancelled at the other end unless
    /// `options` says otherwise; its future waits for what follows. A server's holds none.
    fn unregister_notification(
        &self,
        _notification: &Arc<dyn NotificationLike>,
        _options: &UnregisterNotificationOptions,
    ) -> BoxFuture<()> {
        Box::pin(async {})
    }
}

/// The port of the router `router` names.
pub(super) fn port_of(router: &ServiceRouter) -> Arc<dyn RouterLike> {
    match router {
        ServiceRouter::Server(router) => Arc::new(OfServer(router.clone())),
        ServiceRouter::Client(router) => Arc::new(OfClient(router.clone())),
    }
}

// a server's router, through the port
#[derive(Debug)]
struct OfServer(RouterServer);

impl RouterLike for OfServer {
    fn side(&self) -> RouterSide {
        RouterSide::Server
    }

    fn limits(&self) -> RouterLimits {
        self.0.limits()
    }

    fn clock(&self) -> SharedClock {
        self.0.clock()
    }

    fn report(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        self.0.report(error, connection_handle);
    }

    fn declare_requester(
        &self,
        procedure: &Procedure,
    ) -> Result<Option<ProcedureSeries>, ProgrammerError> {
        self.0.declare_requester(procedure)
    }

    fn register_resolver(
        &self,
        procedure: &Procedure,
        handler: Handler,
    ) -> Result<(), ProgrammerError> {
        self.0.register_resolver((procedure, handler))
    }

    fn request(&self, payload: Bytes, request: RouterRequest) -> Result<Call, ProgrammerError> {
        self.0.request(payload, request)
    }

    fn cover(&self, future: BoxFuture<()>) {
        self.0.owner().cover(future);
    }
}

// a client's router, through the port
#[derive(Debug)]
struct OfClient(RouterClient);

impl RouterLike for OfClient {
    fn side(&self) -> RouterSide {
        RouterSide::Client
    }

    fn limits(&self) -> RouterLimits {
        self.0.limits()
    }

    fn clock(&self) -> SharedClock {
        self.0.clock()
    }

    // a client's router has one connection, its server's, which it reports with
    fn report(&self, error: &RouterError, _connection_handle: Option<&ConnectionHandle>) {
        self.0.report(error);
    }

    fn declare_requester(
        &self,
        procedure: &Procedure,
    ) -> Result<Option<ProcedureSeries>, ProgrammerError> {
        self.0.declare_requester(procedure)
    }

    fn register_resolver(
        &self,
        procedure: &Procedure,
        handler: Handler,
    ) -> Result<(), ProgrammerError> {
        self.0.register_resolver((procedure, handler))
    }

    fn request(&self, payload: Bytes, request: RouterRequest) -> Result<Call, ProgrammerError> {
        self.0.request(payload, request)
    }

    fn cover(&self, future: BoxFuture<()>) {
        self.0.owner().cover(future);
    }

    fn has_notification(&self, notification: &Arc<dyn NotificationLike>) -> bool {
        self.0.has_notification(notification)
    }

    // held as it is made, or refused: its subscription is its call, so nothing is left to wait on
    fn register_notification(
        &self,
        notification: Arc<dyn NotificationLike>,
    ) -> Result<BoxFuture<Result<(), CallError>>, ProgrammerError> {
        self.0.register_notification(notification)?;

        Ok(Box::pin(async { Ok(()) }))
    }

    fn unregister_notification(
        &self,
        notification: &Arc<dyn NotificationLike>,
        options: &UnregisterNotificationOptions,
    ) -> BoxFuture<()> {
        self.0.unregister_notification(notification, options)
    }
}
