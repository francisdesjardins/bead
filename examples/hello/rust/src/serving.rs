//! `HelloService`'s Rust server, over WebSocket on 127.0.0.1. The other halves serve a gateway
//! beside it; this one serves none, the Rust target's gateway being ahead.

use std::io::{self, Read, Write};
use std::sync::Arc;

use bead::{
    ConnectionHandle, RouterError, TransportServerStartOptions, WebSocketServer,
    WebSocketServerOptions,
};
use tokio::runtime::Builder;

use crate::resolvers::offer_hello;

// the address it listens on, which its clients connect to
const HOST: &str = "127.0.0.1";

// a router's error, on the standard error, as the C# server writes it
fn report(error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
    let handle = connection_handle.map_or("no connection", |handle| &**handle);

    writeln!(io::stderr().lock(), "{handle}: {error}").ok();
}

// the server, `HelloService` offered on it, started on `port`, any free one when 0, and the port it
// listens on
async fn started(port: u16) -> Result<(WebSocketServer, u16), String> {
    // its bounds by default, a WebSocket server's under the router's default limits
    let server = WebSocketServer::new(&WebSocketServerOptions::default())
        .map_err(|error| error.to_string())?;

    server.router().on_error(Arc::new(report));
    offer_hello(server.server()).map_err(|error| error.to_string())?;

    let mut start = TransportServerStartOptions::default();

    start.address = Some(HOST.to_owned());
    start.port = Some(port);
    start.find_open_port = Some(port == 0);

    let address = server
        .transport()
        .start(&start)
        .await
        .map_err(|error| error.to_string())?;

    Ok((server, address.port))
}

/// Serves `HelloService` on `port`, any free one when 0: its first line on the standard output says
/// it, as `{"port":n}`; it serves until its standard input closes.
///
/// # Errors
///
/// What failed, in words: the runtime, the server refusing its service or its start, the port
/// unsaid, the input unread, or the server not stopped.
pub(crate) fn serve(port: u16) -> Result<(), String> {
    let runtime = Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("no runtime: {error}"))?;
    let (server, port) = runtime.block_on(started(port))?;
    let mut said = io::stdout().lock();

    // LF, as the other halves write it, on every platform
    writeln!(said, r#"{{"port":{port}}}"#)
        .and_then(|()| said.flush())
        .map_err(|error| format!("its port not said: {error}"))?;
    drop(said);

    // * served on the runtime's workers while this thread waits until whoever started it lets go
    // of its input
    let mut input = Vec::new();

    io::stdin()
        .lock()
        .read_to_end(&mut input)
        .map_err(|error| format!("its input not read: {error}"))?;

    runtime
        .block_on(server.dispose())
        .map_err(|error| format!("not stopped: {error}"))
}
