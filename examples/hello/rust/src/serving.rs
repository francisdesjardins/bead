//! `HelloService`'s Rust server, over WebSocket on 127.0.0.1, and its gateway beside it: one
//! server, `HelloService` offered on it once, which takes its connections from its WebSocket
//! transport and from an in-memory one, joined, the gateway's calls crossing the second (decision
//! 0037).

use std::io::{self, Read, Write};
use std::sync::Arc;

use bead::{
    ConnectionHandle, HttpGateway, HttpGatewayOptions, HttpGatewayStartOptions,
    JoinedServerTransport, MemoryTransportServer, MemoryTransportServerOptions, RouterError,
    Server, ServerOptions, ServerTransport, TransportServerStartOptions, WebSocketTransportServer,
    WebSocketTransportServerOptions,
};
use tokio::runtime::Builder;

use crate::generated::bead_http::{HTTP_PROBLEM_TYPES, HttpRoutes, OPENAPI_DOCUMENT};
use crate::resolvers::offer_hello;

// the address it listens on, which its clients connect to, and its gateway's callers
const HOST: &str = "127.0.0.1";

// what it serves with: the server, over its two transports joined, and its gateway
struct Serving {
    server: Server,
    gateway: HttpGateway,
}

// a router's error, on the standard error, as the C# server writes it
fn report(error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
    let handle = connection_handle.map_or("no connection", |handle| &**handle);

    writeln!(io::stderr().lock(), "{handle}: {error}").ok();
}

// what its gateway reports, on the standard error, as the other halves write it
fn report_gateway(error: &RouterError) {
    writeln!(io::stderr().lock(), "gateway: {error}").ok();
}

// the server, `HelloService` offered on it, its WebSocket transport started on `port`, any free
// one when 0, its gateway on any free one, and the port each listens on
async fn started(port: u16) -> Result<(Serving, u16, u16), String> {
    // its bounds by default, a WebSocket server's under the router's default limits
    let web_socket = WebSocketTransportServer::new(&WebSocketTransportServerOptions::default())
        .map_err(|error| error.to_string())?;
    let memory = MemoryTransportServer::new(&MemoryTransportServerOptions::default())
        .map_err(|error| error.to_string())?;
    let transports: Vec<Arc<dyn ServerTransport>> =
        vec![Arc::new(web_socket.clone()), Arc::new(memory.clone())];
    let joined = JoinedServerTransport::new(transports).map_err(|error| error.to_string())?;
    let server = Server::new(Arc::new(joined), &ServerOptions::default())
        .map_err(|error| error.to_string())?;

    server.router().on_error(Arc::new(report));
    offer_hello(&server).map_err(|error| error.to_string())?;

    // * the gateway answers each procedure's routes as one more client of this server, one
    // connection an exchange, over the in-memory transport the server takes beside WebSocket
    let routes = HttpRoutes::get().map_err(|error| error.to_string())?;
    let mut options = HttpGatewayOptions::new(memory.clone(), routes.all.clone());

    options.document = Some(OPENAPI_DOCUMENT.as_bytes().into());
    options.problem_types = HTTP_PROBLEM_TYPES.map(str::to_owned);

    let gateway = HttpGateway::new(&options).map_err(|error| error.to_string())?;

    gateway.on_error(Arc::new(report_gateway));
    memory.start().await.map_err(|error| error.to_string())?;

    let mut start = TransportServerStartOptions::default();

    start.address = Some(HOST.to_owned());
    start.port = Some(port);
    start.find_open_port = Some(port == 0);

    let address = web_socket
        .start(&start)
        .await
        .map_err(|error| error.to_string())?;
    let mut gateway_start = HttpGatewayStartOptions::default();

    gateway_start.address = Some(HOST.to_owned());
    gateway_start.find_open_port = Some(true);

    let gateway_address = gateway
        .start(&gateway_start)
        .await
        .map_err(|error| error.to_string())?;

    Ok((
        Serving { server, gateway },
        address.port,
        gateway_address.port,
    ))
}

// its gateway, then the server, which stops both its transports, each disposed in turn: the first
// refusal, once both were asked
async fn disposed(serving: Serving) -> Result<(), RouterError> {
    let gateway = serving.gateway.dispose().await;
    let server = serving.server.dispose().await;

    gateway.and(server)
}

/// Serves `HelloService` on `port`, any free one when 0, and its gateway on any free port: its
/// first line on the standard output says both, as `{"port":n,"gateway":m}`; it serves until its
/// standard input closes.
///
/// # Errors
///
/// What failed, in words: the runtime, the server or its gateway refusing their service or their
/// start, the ports unsaid, the input unread, or the server not stopped.
pub(crate) fn serve(port: u16) -> Result<(), String> {
    let runtime = Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("no runtime: {error}"))?;
    let (serving, port, gateway) = runtime.block_on(started(port))?;
    let mut said = io::stdout().lock();

    // LF, as the other halves write it, on every platform
    writeln!(said, r#"{{"port":{port},"gateway":{gateway}}}"#)
        .and_then(|()| said.flush())
        .map_err(|error| format!("its ports not said: {error}"))?;
    drop(said);

    // * served on the runtime's workers while this thread waits until whoever started it lets go
    // of its input
    let mut input = Vec::new();

    io::stdin()
        .lock()
        .read_to_end(&mut input)
        .map_err(|error| format!("its input not read: {error}"))?;

    runtime
        .block_on(disposed(serving))
        .map_err(|error| format!("not stopped: {error}"))
}
