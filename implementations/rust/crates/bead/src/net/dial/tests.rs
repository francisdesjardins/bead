//! The client's IO wrapper over TCP and rustls: bytes in both directions, a flushed write, and a
//! write-side end that leaves its read side open. The socket layer is Rust's own platform seam.

use core::time::Duration;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use super::dial;
use crate::clock::SystemClock;
use crate::net::racing::RacingOptions;
use crate::testing::{patience, spawn, tls};

const PATIENCE: Duration = Duration::from_secs(5);

async fn answer<S: AsyncRead + AsyncWrite + Unpin>(mut socket: S) {
    let mut request = [0; 3];

    socket.read_exact(&mut request).await.unwrap();
    assert_eq!(&request, b"ask", "the client's bytes arrive whole");
    socket.write_all(b"answer").await.unwrap();
    socket.flush().await.unwrap();
    socket.shutdown().await.unwrap();

    let mut rest = Vec::new();

    socket.read_to_end(&mut rest).await.unwrap();
    assert!(
        rest.is_empty(),
        "the client ends its write side after its request"
    );
}

#[tokio::test]
async fn carries_bytes_both_ways_and_half_closes_its_socket_in_the_clear_and_under_tls() {
    for secured in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let peer = spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();

            if secured {
                let socket = TlsAcceptor::from(tls::server_config().unwrap())
                    .accept(socket)
                    .await
                    .unwrap();

                answer(socket).await;
            } else {
                answer(socket).await;
            }
        });
        let config = secured.then(|| tls::client_config().unwrap());
        let racing = RacingOptions::on(Arc::new(SystemClock::current().unwrap()));
        let mut socket = patience(
            PATIENCE,
            dial(("127.0.0.1", port), (&racing, config.as_ref())),
        )
        .await
        .unwrap()
        .unwrap();

        socket.write_all(b"ask").await.unwrap();
        socket.flush().await.unwrap();
        socket.shutdown().await.unwrap();

        let mut response = Vec::new();

        patience(PATIENCE, socket.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            response, b"answer",
            "secured {secured}: the read side stays open"
        );
        patience(PATIENCE, peer).await.unwrap().unwrap();
    }
}
