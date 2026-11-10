//! `bead-interop-server`, the Rust server of Bead's interop service, on 127.0.0.1, over WebSocket
//! and over HTTP, each a server of its own, each given the service's credentials on the system's
//! clock, which is theirs: its first line on the standard output says their ports, as
//! `{"port":n,"httpPort":m}`; it serves until its standard input closes. A port given as its one
//! argument is the WebSocket server's; none, any free one. The HTTP server takes any free one. Each
//! names the origins `BEAD_INTEROP_ORIGINS` lists, separated by spaces, none when it is not set: a
//! page of another origin calls them so. A router's error goes to its standard error. The
//! TypeScript and C# sides' interop servers do the same, so each side's client calls the others'
//! server; the brokers and the HTTP/JSON gateway they serve beside are ahead on this side.
//!
//! `cargo run --locked -p francisdesjardins-bead-interop-server -- [port]`

use std::io::{self, Read, Write};
use std::process::ExitCode;
use std::sync::Arc;

use bead::{
    ConnectionHandle, HttpServer, HttpServerOptions, HttpTransportServerOptions, RouterError,
    RouterLimitsOptions, ServerOptions, SharedClock, SystemClock, TransportServerStartOptions,
    WebSocketServer, WebSocketServerOptions, WebSocketTransportServerOptions,
};
use bead_interop::{interop_credentials_of, offer_interop};

// the address both servers listen on
const HOST: &str = "127.0.0.1";

// both servers, started, and the ports they listen on
struct Served {
    server: WebSocketServer,
    http_server: HttpServer,
    port: u16,
    http_port: u16,
}

// a router's error, on the standard error, as the other sides' interop servers write it
fn report(error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
    let handle = connection_handle.map_or("no connection", |handle| &**handle);

    writeln!(io::stderr().lock(), "{handle}: {error}").ok();
}

// the WebSocket server's port: the one argument given, else 0, any free one
fn port_of_arguments() -> Result<u16, String> {
    std::env::args().nth(1).map_or(Ok(0), |given| {
        given
            .parse::<u16>()
            .map_err(|error| format!("the port {given} does not read: {error}"))
    })
}

// the origins `BEAD_INTEROP_ORIGINS` lists, separated by spaces, none when it is not set
fn origins_of_environment() -> Vec<String> {
    std::env::var("BEAD_INTEROP_ORIGINS")
        .unwrap_or_default()
        .split(' ')
        .filter(|origin| !origin.is_empty())
        .map(str::to_owned)
        .collect()
}

// both servers, the interop service offered on each, started on the loopback: the WebSocket one on
// `port`, any free one where it is 0, the HTTP one on any free one
async fn served(port: u16) -> Result<Served, String> {
    let origins = origins_of_environment();
    // the interop service's credentials, on the clock both servers run on, the platform's
    let clock: SharedClock = Arc::new(SystemClock::current().map_err(|error| error.to_string())?);
    let credentials = interop_credentials_of(&clock, &RouterLimitsOptions::default())
        .map_err(|error| error.to_string())?;
    let mut server_options = ServerOptions::default();

    server_options.credentials = Some(credentials);

    let mut transport = WebSocketTransportServerOptions::default();

    transport.origins = Some(origins.clone());

    let mut options = WebSocketServerOptions::default();

    options.server = Some(server_options.clone());
    options.transport = Some(transport);

    let server = WebSocketServer::new(&options).map_err(|error| error.to_string())?;
    let mut http_transport = HttpTransportServerOptions::default();

    http_transport.origins = Some(origins);

    let mut http_options = HttpServerOptions::default();

    http_options.server = Some(server_options);
    http_options.transport = Some(http_transport);

    let http_server = HttpServer::new(&http_options).map_err(|error| error.to_string())?;

    for each in [server.server(), http_server.server()] {
        each.router().on_error(Arc::new(report));
        offer_interop(each).map_err(|error| error.to_string())?;
    }

    let mut start = TransportServerStartOptions::default();

    start.address = Some(HOST.to_owned());
    start.port = Some(port);
    start.find_open_port = Some(port == 0);

    let address = server
        .transport()
        .start(&start)
        .await
        .map_err(|error| error.to_string())?;
    let mut http_start = TransportServerStartOptions::default();

    http_start.address = Some(HOST.to_owned());
    http_start.find_open_port = Some(true);

    let http_address = http_server
        .transport()
        .start(&http_start)
        .await
        .map_err(|error| error.to_string())?;

    Ok(Served {
        server,
        http_server,
        port: address.port,
        http_port: http_address.port,
    })
}

// serves until whoever started it lets go of its input, then lets both servers go
fn serve() -> Result<(), String> {
    let port = port_of_arguments()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("no runtime: {error}"))?;
    let served = runtime.block_on(served(port))?;
    let mut said = io::stdout().lock();

    writeln!(
        said,
        r#"{{"port":{},"httpPort":{}}}"#,
        served.port, served.http_port
    )
    .and_then(|()| said.flush())
    .map_err(|error| format!("its ports not said: {error}"))?;
    drop(said);

    // * served on the runtime's workers while this thread waits for its input's end
    let mut input = Vec::new();

    io::stdin()
        .lock()
        .read_to_end(&mut input)
        .map_err(|error| format!("its input not read: {error}"))?;

    runtime.block_on(async {
        let disposed = served.server.dispose();
        let http_disposed = served.http_server.dispose();
        let outcome = disposed.await;
        let http_outcome = http_disposed.await;

        outcome
            .and(http_outcome)
            .map_err(|error| format!("not stopped: {error}"))
    })
}

fn main() -> ExitCode {
    match serve() {
        Ok(()) => ExitCode::SUCCESS,
        Err(reason) => {
            writeln!(io::stderr().lock(), "bead-interop-server: {reason}").ok();

            ExitCode::FAILURE
        }
    }
}
