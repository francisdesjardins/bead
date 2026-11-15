//! Its `tls` (spec 15.39), the twins of `http-transport-client.test.ts`'s and
//! `HttpTransportClientTests`': the test kit's TLS front before the transport's own server in the
//! clear, under Bead's test PKI.

use rustls::ProtocolVersion;

use super::*;
use crate::http::peer::Started;
use crate::http::server::HttpTransportServer;
use crate::router::types::ConnectionHandle;
use crate::testing::tls::{PkiServerOptions, TlsFront, pki, pki_client};

fn handle_of(server: &HttpTransportServer) -> ConnectionHandle {
    Arc::clone(
        &server
            .clients()
            .last()
            .expect("a connection drawn")
            .connection_handle,
    )
}

async fn front_of(served: &Started, options: &PkiServerOptions) -> TlsFront {
    TlsFront::to(served.port, options).await.unwrap()
}

fn highest(version: ProtocolVersion) -> PkiServerOptions {
    PkiServerOptions {
        highest: Some(version),
        ..PkiServerOptions::default()
    }
}

fn secured_to(port: u16) -> HttpTransportClientConnectOptions {
    HttpTransportClientConnectOptions {
        secured: Some(true),
        ..to(port)
    }
}

fn tls_client(tls: &TlsOptions) -> HttpTransportClient {
    client_of(&HttpTransportClientOptions {
        tls: Some(tls.clone()),
        ..not_listening()
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
async fn round_trip(client: &HttpTransportClient, served: &Started) {
    let told = recorded(client);
    let request = envelope_of(REQUEST, (1, 0));
    let result = envelope_of(crate::http::fields::RESULT, (1, 2));

    sent(client, envelope(request.clone())).await.unwrap();
    assert_eq!(
        served.recorder.messages(1).await[0].0.data,
        Bytes::from(request),
        "heard by its server"
    );
    served
        .send(&result, &handle_of(&served.server))
        .await
        .unwrap();
    until(|| told.messages().len() == 1).await;
    assert_eq!(
        told.messages()[0].data,
        Bytes::from(result),
        "heard by its client"
    );
}

// spec 15.39
#[tokio::test]
async fn connects_presenting_a_client_certificate_under_an_intermediate_to_a_server_that_requires_one_trusting_the_server_by_the_authorities_it_is_given_over_tls_1_2_and_tls_1_3()
 {
    for version in [ProtocolVersion::TLSv1_2, ProtocolVersion::TLSv1_3] {
        let served = started(&HttpTransportServerOptions::default()).await;
        let front = front_of(&served, &highest(version)).await;
        // * root.pem its authorities, client-chain.pem its certificate and its intermediate
        let client = tls_client(&pki_client().unwrap());

        settled(client.connect(&secured_to(front.port())))
            .await
            .unwrap();
        assert!(client.is_secure(), "{version:?}: secure");
        round_trip(&client, &served).await;
        assert_eq!(front.versions(), vec![version], "{version:?}: its version");
        disconnected(&client, &quick()).await;
        served.stop().await;
    }
}

// spec 15.39
#[tokio::test]
async fn fails_its_connect_presenting_a_client_certificate_its_server_does_not_trust_or_none_over_tls_1_2_and_tls_1_3()
 {
    for version in [ProtocolVersion::TLSv1_2, ProtocolVersion::TLSv1_3] {
        let served = started(&HttpTransportServerOptions::default()).await;
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

            // * a connect's failure, under TLS 1.3 too, where its request was written before the
            // refusal came: never a connection drawn, then lost
            assert!(
                matches!(&outcome, Err(TransportError::Connect(_))),
                "{version:?}: failed, {outcome:?}"
            );
            assert_ne!(
                client.ready_state(),
                ReadyState::Open,
                "{version:?}: not open"
            );
        }

        assert!(
            served.server.clients().is_empty(),
            "{version:?}: none drawn"
        );
        served.stop().await;
    }
}

// spec 15.39
#[tokio::test]
async fn fails_its_connect_to_a_server_under_no_authority_it_trusts_given_or_of_its_platform() {
    let served = started(&HttpTransportServerOptions::default()).await;
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

    // a server under the root, judged by the platform's roots, which know no root of Bead's
    let front = front_of(&served, &PkiServerOptions::default()).await;
    let client = tls_client(&tls_of(
        (None, Some("client-chain.pem")),
        Some("client.key"),
    ));
    let outcome = settled(client.connect(&secured_to(front.port()))).await;

    assert!(outcome.is_err(), "of its platform: {outcome:?}");
    served.stop().await;
}

// spec 15.39
#[tokio::test]
async fn connects_in_the_clear_with_tls_given_which_a_secured_connect_alone_uses() {
    let served = started(&HttpTransportServerOptions::default()).await;
    let client = tls_client(&pki_client().unwrap());

    settled(client.connect(&to(served.port))).await.unwrap();
    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    round_trip(&client, &served).await;
    disconnected(&client, &quick()).await;
    served.stop().await;
}

// spec 15.39
#[tokio::test]
async fn refuses_tls_beside_what_it_is_given_that_keeps_a_tls_of_its_own() {
    let refused = HttpTransportClient::new(&HttpTransportClientOptions {
        client_config: Some(crate::testing::tls::client_config().unwrap()),
        tls: Some(pki_client().unwrap()),
        ..HttpTransportClientOptions::default()
    })
    .unwrap_err();

    assert_eq!(
        refused.message(),
        "tls is refused beside a client_config, which keeps a TLS of its own",
        "refused"
    );

    // * and one that does not read, as it is built
    let refused = HttpTransportClient::new(&HttpTransportClientOptions {
        tls: Some(tls_of((None, Some("client-chain.pem")), None)),
        ..HttpTransportClientOptions::default()
    })
    .unwrap_err();

    assert_eq!(
        refused.message(),
        "a TLS client certificate is given with its key, and a key with its certificate",
        "unpaired"
    );
}
