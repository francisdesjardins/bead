//! By a name: a host's addresses raced (RFC 8305), a localhost name's the loopback's own, its
//! resolver never asked (spec 13.4).

use std::net::Ipv6Addr;

use super::*;
use crate::http::server::HttpTransportServer;
use crate::testing::tls::{PkiLeaf, PkiServerOptions, pki, pki_server_config};
use crate::transport::{ServerTransport, TransportServerStartOptions};

// a client of `options` whose resolver answers 192.0.2.7 and records each name it is asked
fn resolving_client(
    asked: &Arc<Mutex<Vec<String>>>,
    options: &HttpTransportClientOptions,
) -> HttpTransportClient {
    let runtime = platform::socket_runtime_of(None, "a test's client").unwrap();
    let platform: SharedClock = Arc::new(SystemClock::on(runtime.clone()));

    HttpTransportClient::resolving(
        (runtime, platform),
        Some(crate::net::racing::recording(asked)),
        options,
    )
    .unwrap()
}

#[tokio::test]
async fn connects_by_a_name_to_a_server_that_listens_on_one_loopback_family_alone_whichever_it_is()
{
    let mut addresses = vec![HOST];

    if TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).await.is_ok() {
        addresses.push("::1");
    }

    for address in addresses {
        let server = HttpTransportServer::new(&HttpTransportServerOptions::default()).unwrap();
        let port = within(server.start(&TransportServerStartOptions {
            address: Some(address.to_owned()),
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        }))
        .await
        .unwrap()
        .port;
        let client = client_of(&not_listening());
        let began = crate::testing::Instant::now();

        settled(client.connect(&HttpTransportClientConnectOptions::new("localhost", port)))
            .await
            .unwrap();

        // the families raced, as RFC 8305 asks: no wait on the one that is refused
        assert_eq!(
            (
                address,
                client.ready_state(),
                began.elapsed() < Duration::from_millis(1_500)
            ),
            (address, ReadyState::Open, true),
            "raced"
        );
        disconnected(&client, &TransportClientDisconnectOptions::default()).await;
        within(server.stop()).await.unwrap();
    }
}

// spec 13.4
#[tokio::test]
async fn reaches_a_localhost_name_on_the_loopback_whatever_the_platforms_resolver_answers() {
    let fake = fake().await;
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let client = resolving_client(&asked, &not_listening());
    let connecting = client.connect(&HttpTransportClientConnectOptions::new(
        "bead-probe.localhost",
        fake.port,
    ));
    let call = fake.call_of(0).await;

    call.answer(&drawn(false));
    settled(connecting).await.unwrap();
    assert_eq!(
        call.field("host").map(str::to_owned),
        Some(format!("bead-probe.localhost:{}", fake.port)),
        "its name kept"
    );
    assert_eq!(*locked(&asked), Vec::<String>::new(), "none asked");
    client.dispose();
}

// spec 13.4, 15.39
#[tokio::test]
async fn keeps_a_localhost_name_in_its_host_and_its_tls_server_name_while_it_connects_the_loopback()
{
    // * a certificate that names `localhost` alone: a handshake by any other server name fails
    let fake = fake_of(&ScriptOptions {
        tls: Some(
            pki_server_config(&PkiServerOptions {
                leaf: Some(PkiLeaf::Named),
                requires_certificate: Some(false),
                ..PkiServerOptions::default()
            })
            .unwrap(),
        ),
        ..ScriptOptions::default()
    })
    .await;
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let client = resolving_client(
        &asked,
        &HttpTransportClientOptions {
            tls: Some(TlsOptions {
                authorities: Some(pki("root.pem").unwrap()),
                ..TlsOptions::default()
            }),
            ..not_listening()
        },
    );
    let connecting = client.connect(&HttpTransportClientConnectOptions {
        secured: Some(true),
        ..HttpTransportClientConnectOptions::new("localhost", fake.port)
    });
    let call = fake.call_of(0).await;

    call.answer(&drawn(false));
    settled(connecting).await.unwrap();
    assert!(client.is_secure(), "secure");
    assert_eq!(
        call.field("host").map(str::to_owned),
        Some(format!("localhost:{}", fake.port)),
        "its Host"
    );
    assert_eq!(*locked(&asked), Vec::<String>::new(), "none asked");
    client.dispose();
}

// spec 13.4
#[tokio::test]
async fn says_that_a_localhost_name_it_could_not_connect_went_to_the_loopback_no_resolver_asked() {
    let closed = crate::testing::closed_port::closed_port().unwrap();
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let client = resolving_client(&asked, &not_listening());
    let failed = settled(client.connect(&HttpTransportClientConnectOptions::new(
        "bead-probe.localhost",
        closed.port(),
    )))
    .await;

    assert!(
        matches!(&failed, Err(TransportError::Connect(error)) if error.message().contains("no resolver asked")),
        "{failed:?}"
    );
    assert_eq!(*locked(&asked), Vec::<String>::new(), "none asked");
    client.dispose();
}
