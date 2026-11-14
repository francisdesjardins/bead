//! Scripted transports that leave their clock unspecified, as the generic transport traits allow.

use std::sync::Arc;

use crate::router::types::{BoxFuture, ConnectionHandle, RouterError, TransportMessage};
use crate::testing::scripted::{ScriptedClient, ScriptedServer};
use crate::transport::ReadyState;
use crate::transport::{
    ClientListener, RouterClientTransport, Sent, ServerListener, ServerTransport,
};

#[derive(Debug)]
pub(crate) struct Clockless<T>(pub(crate) Arc<T>);

impl RouterClientTransport for Clockless<ScriptedClient> {
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError> {
        self.0.send(message)
    }

    fn listen(&self, listener: Arc<dyn ClientListener>) {
        self.0.listen(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ClientListener>) {
        self.0.unlisten(listener);
    }

    fn pause(&self) {
        self.0.pause();
    }

    fn disconnect(&self) {
        self.0.disconnect();
    }

    fn resume(&self) {
        self.0.resume();
    }

    fn ready_state(&self) -> ReadyState {
        self.0.ready_state()
    }
}

impl ServerTransport for Clockless<ScriptedServer> {
    fn send(
        &self,
        message: TransportMessage,
        handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        self.0.send(message, handle)
    }

    fn close(&self, handle: &ConnectionHandle) -> BoxFuture<bool> {
        self.0.close(handle)
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        self.0.listen(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        self.0.unlisten(listener);
    }

    fn pause(&self, handle: &ConnectionHandle) {
        self.0.pause(handle);
    }

    fn resume(&self, handle: &ConnectionHandle) {
        self.0.resume(handle);
    }

    fn stop(&self) -> BoxFuture<Result<(), RouterError>> {
        self.0.stop()
    }
}
