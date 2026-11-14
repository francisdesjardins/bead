//! The WebSocket client's `tls` (spec 15.39), the twins of `websocket-transport-client.test.ts`'s
//! and `WebSocketTransportClientTests`': the test kit's TLS front before the transport's own server
//! in the clear, under Bead's test PKI.

use rustls::ProtocolVersion;

use super::*;
use crate::router::types::ConnectionHandle;
use crate::testing::tls::{PkiServerOptions, TlsFront, pki, pki_client};
use crate::transport::ServerListener;

// what the transport's own server heard: each message, and the connection it came on
#[derive(Default)]
struct Heard {
    messages: Mutex<Vec<(Bytes, ConnectionHandle)>>,
}

impl ServerListener for Heard {
    fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
        self.messages
            .lock()
            .unwrap()
            .push((message.data, Arc::clone(connection_handle)));
    }
}

// the transport's own server, in the clear on the loopback, and what it heard
struct Served {
    server: WebSocketTransportServer,
    port: u16,
    heard: Arc<Heard>,
}

async fn served() -> Served {
    let server = WebSocketTransportServer::new(&WebSocketTransportServerOptions {
        close_timeout: Some(Duration::from_millis(100)),
        ..WebSocketTransportServerOptions::default()
    })
    .unwrap();
    let heard = Arc::new(Heard::default());

    server.listen(Arc::<Heard>::clone(&heard));

    let TransportServerAddress { port, .. } = patience(
        PATIENCE,
        server.start(&TransportServerStartOptions {
            address: Some(LOOPBACK.to_owned()),
            find_open_port: Some(true),
            ..TransportServerStartOptions::default()
        }),
    )
    .await
    .unwrap()
    .unwrap();

    Served {
        server,
        port,
        heard,
    }
}

async fn front_of(served: &Served, options: &PkiServerOptions) -> TlsFront {
    TlsFront::to(served.port, options).await.unwrap()
}

fn highest(version: ProtocolVersion) -> PkiServerOptions {
    PkiServerOptions {
        highest: Some(version),
        ..PkiServerOptions::default()
    }
}

fn secured_to(port: u16) -> WebSocketTransportClientConnectOptions {
    WebSocketTransportClientConnectOptions {
        secured: Some(true),
        ..to(port)
    }
}

fn tls_client(tls: &TlsOptions) -> WebSocketTransportClient {
    client_of(&WebSocketTransportClientOptions {
        tls: Some(tls.clone()),
        ..WebSocketTransportClientOptions::default()
    })
}

// the PKI's `certificate` and `key`, its authorities `authorities`, each a file of it where given
fn tls_of(
    (authorities, certificate): (Option<&str>, Option<&str>),
    key: Option<&str>,
) -> TlsOptions {
    TlsOptions {
        authorities: authorities.map(|name| pki(name).unwrap()),
        certificate: certificate.map(|name| pki(name).unwrap()),
        key: key.map(|name| pki(name).unwrap()),
    }
}

// one envelope each way on `client`'s open connection, through whatever is before `served`
async fn round_trip(client: &WebSocketTransportClient, served: &Served) {
    let recorder = recorded(client);

    client.send(binary(b"hello")).unwrap();

    let (data, handle) = patience(PATIENCE, async {
        loop {
            let first = served.heard.messages.lock().unwrap().first().cloned();

            if let Some(first) = first {
                return first;
            }

            crate::testing::rest(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();

    assert_eq!(data, Bytes::from_static(b"hello"), "heard by its server");
    served.server.send(binary(b"again"), &handle).unwrap();
    patience(PATIENCE, async {
        while recorder.messages().is_empty() {
            crate::testing::rest(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        recorder.messages(),
        vec![Bytes::from_static(b"again")],
        "heard by its client"
    );
}

// spec 15.39
#[tokio::test]
async fn connects_presenting_a_client_certificate_under_an_intermediate_to_a_server_that_requires_one_trusting_the_server_by_the_authorities_it_is_given_over_tls_1_2_and_tls_1_3()
 {
    for version in [ProtocolVersion::TLSv1_2, ProtocolVersion::TLSv1_3] {
        let served = served().await;
        let front = front_of(&served, &highest(version)).await;
        // * root.pem its authorities, client-chain.pem its certificate and its intermediate
        let client = tls_client(&pki_client().unwrap());

        settled(client.connect(&secured_to(front.port())))
            .await
            .unwrap();
        assert!(client.is_secure(), "{version:?}: secure");
        round_trip(&client, &served).await;
        assert_eq!(front.versions(), vec![version], "{version:?}: its version");
        client.dispose();
        patience(PATIENCE, served.server.stop())
            .await
            .unwrap()
            .unwrap();
    }
}

// spec 15.39
#[tokio::test]
async fn fails_its_connect_presenting_a_client_certificate_its_server_does_not_trust_or_none_over_tls_1_2_and_tls_1_3()
 {
    for version in [ProtocolVersion::TLSv1_2, ProtocolVersion::TLSv1_3] {
        let served = served().await;
        let front = front_of(&served, &highest(version)).await;

        for tls in [
            tls_of(
                (Some("root.pem"), Some("stranger-client.pem")),
                Some("stranger-client.key"),
            ),
            tls_of((Some("root.pem"), None), None),
        ] {
            let client = tls_client(&tls);
            let outcome = settled(client.connect(&secured_to(front.port()))).await;

            assert!(outcome.is_err(), "{version:?}: failed, {outcome:?}");
            assert!(
                !is_state(&client, ReadyState::Open),
                "{version:?}: not open"
            );
            client.dispose();
        }

        assert!(
            served.heard.messages.lock().unwrap().is_empty(),
            "nothing heard"
        );
        patience(PATIENCE, served.server.stop())
            .await
            .unwrap()
            .unwrap();
    }
}

// spec 15.39
#[tokio::test]
async fn fails_its_connect_to_a_server_under_no_authority_it_trusts_given_or_of_its_platform() {
    let served = served().await;
    // a server under the stranger root, judged by the root alone
    let stranger = front_of(
        &served,
        &PkiServerOptions {
            is_stranger: Some(true),
            ..PkiServerOptions::default()
        },
    )
    .await;
    let client = tls_client(&pki_client().unwrap());
    let outcome = settled(client.connect(&secured_to(stranger.port()))).await;

    assert!(outcome.is_err(), "given: {outcome:?}");
    client.dispose();

    // a server under the root, judged by the platform's roots, which know no root of Bead's
    let front = front_of(&served, &PkiServerOptions::default()).await;
    let client = tls_client(&tls_of(
        (None, Some("client-chain.pem")),
        Some("client.key"),
    ));
    let outcome = settled(client.connect(&secured_to(front.port()))).await;

    assert!(outcome.is_err(), "of its platform: {outcome:?}");
    client.dispose();
    patience(PATIENCE, served.server.stop())
        .await
        .unwrap()
        .unwrap();
}

// spec 15.39
#[tokio::test]
async fn connects_in_the_clear_with_tls_given_which_a_secured_connect_alone_uses() {
    let served = served().await;
    let client = tls_client(&pki_client().unwrap());

    settled(client.connect(&to(served.port))).await.unwrap();
    assert!(is_state(&client, ReadyState::Open), "open");
    round_trip(&client, &served).await;
    client.dispose();
    patience(PATIENCE, served.server.stop())
        .await
        .unwrap()
        .unwrap();
}

// spec 15.39
#[tokio::test]
async fn refuses_tls_beside_what_it_is_given_that_keeps_a_tls_of_its_own() {
    let refused = WebSocketTransportClient::new(&WebSocketTransportClientOptions {
        client_config: Some(crate::testing::tls::client_config().unwrap()),
        tls: Some(pki_client().unwrap()),
        ..WebSocketTransportClientOptions::default()
    })
    .unwrap_err();

    assert_eq!(
        refused.message(),
        "tls is refused beside a client_config, which keeps a TLS of its own",
        "refused"
    );

    // * and one that does not read, as it is built
    let refused = WebSocketTransportClient::new(&WebSocketTransportClientOptions {
        tls: Some(tls_of((None, Some("client-chain.pem")), None)),
        ..WebSocketTransportClientOptions::default()
    })
    .unwrap_err();

    assert_eq!(
        refused.message(),
        "a TLS client certificate is given with its key, and a key with its certificate",
        "unpaired"
    );
}
