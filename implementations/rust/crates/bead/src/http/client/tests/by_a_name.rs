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

// spec 13.4.2
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

// spec 13.4.2, 15.39
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

// spec 13.4.2
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

// spec 13.4.2
#[tokio::test]
async fn connects_a_host_written_127_0_0_1_or_127_1_to_the_loopback_asking_no_resolver_and_names_it_127_0_0_1()
 {
    for host in ["127.0.0.1.", "127.1"] {
        let fake = fake().await;
        let asked: Arc<Mutex<Vec<String>>> = Arc::default();
        let client = resolving_client(&asked, &not_listening());
        let connecting = client.connect(&HttpTransportClientConnectOptions::new(host, fake.port));
        let call = fake.call_of(0).await;

        call.answer(&drawn(false));
        settled(connecting).await.unwrap();
        assert_eq!(
            call.field("host").map(str::to_owned),
            Some(format!("127.0.0.1:{}", fake.port)),
            "{host}: named 127.0.0.1"
        );
        assert_eq!(*locked(&asked), Vec::<String>::new(), "{host}: none asked");
        client.dispose();
    }
}

// spec 13.4
#[tokio::test]
async fn refuses_a_host_the_url_standard_fails_on_foo_123_or_x_20_localhost_before_any_socket_opens()
 {
    let fake = fake().await;

    for host in ["foo.123", "x%20.localhost"] {
        let asked: Arc<Mutex<Vec<String>>> = Arc::default();
        let client = resolving_client(&asked, &not_listening());
        let failed =
            settled(client.connect(&HttpTransportClientConnectOptions::new(host, fake.port))).await;

        assert!(
            matches!(&failed, Err(TransportError::Connect(error)) if error.message() == format!("{host} is no host a URL can name")),
            "{host}: {failed:?}"
        );
        assert_eq!(*locked(&asked), Vec::<String>::new(), "{host}: none asked");
        client.dispose();
    }

    assert!(
        fake.makes_no_call_of(0).await,
        "no socket opened to its server"
    );
}

// spec 13.4.2; RFC 7301: its socket raced, the TLS and ALPN laid over it are what an IP literal's are
#[tokio::test]
async fn negotiates_the_http_version_with_a_localhost_name_that_it_negotiates_with_127_0_0_1() {
    // * a server that offers HTTP/2 first by ALPN, then HTTP/1.1
    let mut config = (*crate::testing::tls::server_config().unwrap()).clone();

    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let mut negotiated = Vec::new();

    for host in [HOST, "localhost"] {
        let listener = TcpListener::bind((HOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = client_of(&HttpTransportClientOptions {
            client_config: Some(crate::testing::tls::client_config().unwrap()),
            ..not_listening()
        });
        let connecting = client.connect(&HttpTransportClientConnectOptions {
            secured: Some(true),
            ..HttpTransportClientConnectOptions::new(host, port)
        });
        let (socket, _) = within(listener.accept()).await.unwrap();
        let mut secured = within(acceptor.accept(socket)).await.unwrap();
        let protocol = secured
            .get_ref()
            .1
            .alpn_protocol()
            .map(|protocol| String::from_utf8_lossy(protocol).into_owned());
        let (read, _) = within(request_of(&mut secured)).await.unwrap();
        let line = String::from_utf8_lossy(&read)
            .lines()
            .next()
            .unwrap_or_default()
            .to_owned();

        negotiated.push((
            protocol,
            line.rsplit(' ').next().unwrap_or_default().to_owned(),
        ));
        drop(secured);
        drop(listener);
        drop(settled(connecting).await);
        client.dispose();
    }

    assert_eq!(
        negotiated,
        [
            (Some("http/1.1".to_owned()), "HTTP/1.1".to_owned()),
            (Some("http/1.1".to_owned()), "HTTP/1.1".to_owned())
        ],
        "HTTP/1.1 by both, as it offers it alone"
    );
}
