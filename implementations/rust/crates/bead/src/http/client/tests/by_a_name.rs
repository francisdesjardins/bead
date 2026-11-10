//! By a name: a host's addresses raced (RFC 8305).

use std::net::Ipv6Addr;

use super::*;
use crate::http::server::HttpTransportServer;
use crate::transport::{ServerTransport, TransportServerStartOptions};

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
