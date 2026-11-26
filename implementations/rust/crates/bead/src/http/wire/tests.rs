//! hyper's glue: an answer under way settles once on every path, and a session with none under
//! way ends past its headers timeout.

use core::time::Duration;
use std::sync::Arc;

use rustls::pki_types::ServerName;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;

use super::*;
use crate::net::tls::serving_config_of;
use crate::platform::{JoinHandle, runtime_of};
use crate::testing::{patience, platform_clock, rest};

// how long a test waits for what it expects
const PATIENCE: Duration = Duration::from_secs(10);

const HOST: &str = "127.0.0.1";

// the heads its flow read and the answers it settled
fn counted(flow: &Flow) -> (u64, u64) {
    (
        flow.heads.load(Ordering::SeqCst),
        flow.settled.load(Ordering::SeqCst),
    )
}

// waits until its flow counted `heads` and `settled`
async fn until_counted(flow: &Flow, (heads, settled): (u64, u64)) {
    patience(PATIENCE, async {
        while counted(flow) != (heads, settled) {
            rest(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_late| panic!("{:?}, not {:?}", counted(flow), (heads, settled)));
}

// one socket of a listener on the loopback served as `tls` says, its headers timeout
// `headers_timeout`, each exchange `exchange`'s: its flow, and its serving's end
async fn served<F: Exchange>(
    (tls, headers_timeout): (Option<Arc<ServerConfig>>, Duration),
    exchange: F,
) -> (Arc<Flow>, JoinHandle<()>, u16) {
    let listener = TcpListener::bind((HOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let flow = Arc::new(Flow::default());
    let serving = Arc::clone(&flow);
    let options = WireOptions {
        runtime: runtime_of(None, "a test").unwrap(),
        platform: Arc::new(platform_clock().unwrap()),
        headers_timeout,
        tls,
    };
    let ended = crate::testing::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();

        serve((socket, serving), (options, exchange)).await;
    });

    (flow, ended, port)
}

#[test]
fn settles_a_head_once_by_the_body_it_is_handed_to_or_as_it_is_dropped() {
    let flow = Arc::new(Flow::default());
    let answered = flow
        .head_read()
        .answered(response_of(200, (&[], AnswerBody::whole(None))));

    assert_eq!(counted(&flow), (1, 0), "under way while its body is held");
    assert!(flow.is_answering(), "answering");
    drop(answered);
    assert_eq!(counted(&flow), (1, 1), "settled as its body is dropped");

    drop(flow.head_read());
    assert_eq!(
        counted(&flow),
        (2, 2),
        "settled as it is dropped, answered none"
    );
    assert!(!flow.is_answering(), "answering nothing");
}

#[tokio::test]
async fn settles_a_head_whose_exchange_is_cut() {
    let (flow, ended, port) = served(
        (None, Duration::from_secs(10)),
        |_request: Request<Incoming>, _flow: &Arc<Flow>| -> Answered {
            Box::pin(async { Err(Cut) })
        },
    )
    .await;
    let mut socket = TcpStream::connect((HOST, port)).await.unwrap();

    socket
        .write_all(format!("GET / HTTP/1.1\r\nHost: {HOST}:{port}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    patience(PATIENCE, ended).await.unwrap().unwrap();
    assert_eq!(counted(&flow), (1, 1), "its head settled");
    assert!(!flow.is_answering(), "answering nothing");
}

#[tokio::test]
async fn settles_a_head_whose_stream_its_client_resets_before_an_answer_and_ends_its_session_past_headers_timeout_after_it()
 {
    let headers_timeout = Duration::from_millis(500);
    let (flow, ended, port) = served(
        (
            Some(serving_config_of(
                &crate::testing::tls::server_config().unwrap(),
            )),
            headers_timeout,
        ),
        |_request: Request<Incoming>, _flow: &Arc<Flow>| -> Answered {
            Box::pin(core::future::pending())
        },
    )
    .await;
    let mut config = rustls::ClientConfig::clone(&crate::testing::tls::client_config().unwrap());

    config.alpn_protocols = vec![H2.to_vec()];

    let socket = TcpStream::connect((HOST, port)).await.unwrap();
    let stream = TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from(HOST.to_owned()).unwrap(), socket)
        .await
        .unwrap();
    let (session, connection) = h2::client::handshake(stream).await.unwrap();
    let driven = crate::testing::spawn(async move { connection.await.is_ok() });
    let request = ::http::Request::builder()
        .method("GET")
        .uri(format!("https://{HOST}:{port}/"))
        .body(())
        .unwrap();
    let mut ready = session.clone().ready().await.unwrap();
    let (_response, mut sending) = ready.send_request(request, true).unwrap();

    until_counted(&flow, (1, 0)).await;
    // * its answer waits past its headers timeout: a session answering is kept
    rest(headers_timeout.saturating_mul(2)).await;
    assert!(!ended.is_finished(), "its session kept while it answers");
    sending.send_reset(h2::Reason::CANCEL);
    until_counted(&flow, (1, 1)).await;
    assert!(!flow.is_answering(), "answering nothing");
    patience(PATIENCE, ended).await.unwrap().unwrap();
    drop(session);
    patience(PATIENCE, driven).await.unwrap().ok();
}
