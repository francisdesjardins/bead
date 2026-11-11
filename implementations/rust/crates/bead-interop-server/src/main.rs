//! `bead-interop-server`, the Rust server of Bead's interop service, on 127.0.0.1, over WebSocket
//! and over HTTP, each a server of its own, and over MQTT 5 where `BEAD_MQTT_URL` names a broker,
//! its participant `rs-server`, linked with the password `BEAD_MQTT_PASSWORD` gives, serving
//! `interop-rs` alone and `interop-both` in a group with the other sides'; each given the service's
//! credentials on the system's clock, which is theirs: its first line on the standard output says
//! their ports and those names, as `{"port":n,"httpPort":m,"mqtt":[…]}`; it serves until its
//! standard input closes. A port given as its one argument is the WebSocket server's; none, any
//! free one. The HTTP server takes any free one. Each names the origins `BEAD_INTEROP_ORIGINS`
//! lists, separated by spaces, none when it is not set: a page of another origin calls them so. A
//! router's error goes to its standard error. The TypeScript and C# sides' interop servers do the
//! same, so each side's client calls the others' server; AMQP 1.0 and the HTTP/JSON gateway they
//! serve beside are ahead on this side.
//!
//! `cargo run --locked -p francisdesjardins-bead-interop-server -- [port]`

use std::io::{self, Read, Write};
use std::process::ExitCode;
use std::sync::Arc;

use bead::{
    BrokerParticipant, BrokerParticipantOptions, BrokerTransportServer,
    BrokerTransportServerOptions, ConnectionHandle, HttpServer, HttpServerOptions,
    HttpTransportServerOptions, MqttBrokerAdapter, MqttBrokerAdapterOptions, RouterError,
    RouterLimitsOptions, Server, ServerOptions, ServerTransport, SharedClock, SystemClock,
    TransportServerStartOptions, WebSocketServer, WebSocketServerOptions,
    WebSocketTransportServerOptions,
};
use bead_interop::{interop_credentials_of, offer_interop};

// the address both servers listen on
const HOST: &str = "127.0.0.1";

// its participant's id over a broker, and the names it serves there: its own alone, and the one
// every side serves in a group
const BROKER_ID: &str = "rs-server";
const BROKER_NAMES: [&str; 2] = ["interop-rs", "interop-both"];

// the servers, started, and the ports they listen on; over MQTT 5, its participant and its servers
struct Served {
    server: WebSocketServer,
    http_server: HttpServer,
    port: u16,
    http_port: u16,
    mqtt: Option<Brokered>,
}

// a participant over a broker, and a server over each of its transports
struct Brokered {
    participant: BrokerParticipant,
    servers: Vec<(Server, BrokerTransportServer)>,
}

// over MQTT 5 where `BEAD_MQTT_URL` names a broker: a participant of its own, its name alone, and
// the one every side serves in a group, each its server, the interop offered on it
async fn brokered(server_options: &ServerOptions) -> Result<Option<Brokered>, String> {
    let Some(url) = std::env::var("BEAD_MQTT_URL")
        .ok()
        .filter(|url| !url.is_empty())
    else {
        return Ok(None);
    };
    let mut options = MqttBrokerAdapterOptions::new(url, BROKER_ID);

    options.password = std::env::var("BEAD_MQTT_PASSWORD").ok();

    let adapter = MqttBrokerAdapter::new(&options).map_err(|error| error.to_string())?;
    let participant =
        BrokerParticipant::new(Arc::new(adapter), &BrokerParticipantOptions::default())
            .map_err(|error| error.to_string())?;
    let mut servers = Vec::new();

    for (index, name) in BROKER_NAMES.into_iter().enumerate() {
        let mut transport_options = BrokerTransportServerOptions::new([name]);

        transport_options.is_in_group = Some(index == 1);

        let transport = participant
            .server(&transport_options)
            .map_err(|error| error.to_string())?;
        let server = Server::new(Arc::new(transport.clone()), server_options)
            .map_err(|error| error.to_string())?;

        server.router().on_error(Arc::new(report));
        offer_interop(&server).map_err(|error| error.to_string())?;
        servers.push((server, transport));
    }

    for (_, transport) in &servers {
        transport.start().await.map_err(|error| error.to_string())?;
    }

    Ok(Some(Brokered {
        participant,
        servers,
    }))
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

    http_options.server = Some(server_options.clone());
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

    let mqtt = brokered(&server_options).await?;

    Ok(Served {
        server,
        http_server,
        port: address.port,
        http_port: http_address.port,
        mqtt,
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

    // * the names it serves over MQTT 5, where it serves there
    let mqtt = if served.mqtt.is_some() {
        format!(r#","mqtt":["{}"]"#, BROKER_NAMES.join(r#"",""#))
    } else {
        String::new()
    };

    writeln!(
        said,
        r#"{{"port":{},"httpPort":{}{mqtt}}}"#,
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
        let mut broker_outcome = Ok(());

        // * over MQTT 5, each server let go, then its participant, so that its broker publishes no
        // will
        if let Some(brokered) = served.mqtt {
            for (server, transport) in &brokered.servers {
                broker_outcome = broker_outcome.and(transport.stop().await);
                broker_outcome = broker_outcome.and(server.dispose().await);
            }

            brokered.participant.dispose().await;
        }

        outcome
            .and(http_outcome)
            .and(broker_outcome)
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
