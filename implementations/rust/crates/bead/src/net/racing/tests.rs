use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;

use tokio::net::TcpListener;

use super::*;
use crate::clock::SystemClock;
use crate::testing::{Instant, patience};

const PATIENCE: Duration = Duration::from_secs(10);

// an address of TEST-NET-1 (RFC 5737), which no host answers
const UNANSWERED: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));

// a resolver that answers every name with the addresses given, in their order
fn answering(addresses: &[IpAddr]) -> Resolve {
    let addresses = addresses.to_vec();

    Arc::new(move |_name| {
        let addresses = addresses.clone();

        Box::pin(async move { Ok(addresses) })
    })
}

fn platform() -> SharedClock {
    Arc::new(SystemClock::current().unwrap())
}

// says once it is dropped: an attempt given up
struct Dropped(Option<oneshot::Sender<()>>);

impl Drop for Dropped {
    fn drop(&mut self) {
        if let Some(told) = self.0.take() {
            told.send(()).ok();
        }
    }
}

#[tokio::test]
async fn connects_by_the_next_family_250_ms_after_an_attempt_that_has_not_connected() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let started = Instant::now();
    let attempts: Arc<Mutex<Vec<(IpAddr, Duration)>>> = Arc::default();
    let recording = Arc::clone(&attempts);
    let options = RacingOptions {
        // TEST-NET-1 first, an IPv6 one as a resolver may answer, then the loopback: the families
        // interleaved, the first answer's first
        resolve: Some(answering(&[
            UNANSWERED,
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 2)),
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        ])),
        attempt: Some(Arc::new(move |address: SocketAddr| {
            recording
                .lock()
                .unwrap()
                .push((address.ip(), started.elapsed()));

            Box::pin(async move {
                if !address.ip().is_loopback() {
                    // an attempt nothing answers, until it is given up
                    core::future::pending::<()>().await;
                }

                TcpStream::connect(address).await
            })
        })),
        ..RacingOptions::on(platform())
    };
    let socket = patience(PATIENCE, connect_racing(("bead.test", port), &options))
        .await
        .unwrap()
        .unwrap();
    let tried = attempts.lock().unwrap().clone();

    assert_eq!(
        socket.peer_addr().unwrap().ip(),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        "the loopback's"
    );
    assert_eq!(
        tried
            .iter()
            .map(|(address, _)| *address)
            .collect::<Vec<_>>(),
        [
            UNANSWERED,
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 2)),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        ],
        "the families interleaved"
    );

    // each attempt 250 milliseconds after the one before it, which had not connected
    for pair in tried.windows(2) {
        let gap = pair[1].1.saturating_sub(pair[0].1);

        assert!(
            (Duration::from_millis(240)..=Duration::from_secs(2)).contains(&gap),
            "250 ms apart: {gap:?}"
        );
    }
}

#[tokio::test]
async fn cancels_the_attempts_left_once_one_connects() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (told, given_up) = oneshot::channel::<()>();
    let told = Arc::new(Mutex::new(Some(told)));
    let failed: Arc<Mutex<Vec<IpAddr>>> = Arc::default();
    let failing = Arc::clone(&failed);
    let options = RacingOptions {
        resolve: Some(answering(&[
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            UNANSWERED,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        ])),
        attempt_delay: Duration::from_millis(50),
        attempt: Some(Arc::new(move |address: SocketAddr| {
            let failing = Arc::clone(&failing);
            let guard = (address.ip() == UNANSWERED).then(|| Dropped(told.lock().unwrap().take()));

            Box::pin(async move {
                if address.ip() == IpAddr::V6(Ipv6Addr::LOCALHOST) {
                    // a failure starts the next attempt at once
                    failing.lock().unwrap().push(address.ip());

                    return Err(io::Error::from(io::ErrorKind::ConnectionRefused));
                }

                if let Some(guard) = guard {
                    let _guard = guard;

                    core::future::pending::<()>().await;
                }

                TcpStream::connect(address).await
            })
        })),
        ..RacingOptions::on(platform())
    };
    let socket = patience(PATIENCE, connect_racing(("bead.test", port), &options))
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        socket.peer_addr().unwrap().ip(),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        "the loopback's"
    );
    assert_eq!(
        *failed.lock().unwrap(),
        [IpAddr::V6(Ipv6Addr::LOCALHOST)],
        "the failed one"
    );
    assert!(
        patience(PATIENCE, given_up).await.unwrap().is_ok(),
        "the unanswered one given up"
    );

    // every attempt failed: the last failure; a name that resolves to none: not found
    let refused = connect_racing(
        ("bead.test", port),
        &RacingOptions {
            resolve: Some(answering(&[IpAddr::V6(Ipv6Addr::LOCALHOST)])),
            attempt: Some(Arc::new(|_address| {
                Box::pin(async { Err(io::Error::from(io::ErrorKind::ConnectionRefused)) })
            })),
            ..RacingOptions::on(platform())
        },
    )
    .await
    .unwrap_err();
    let unknown = connect_racing(
        ("bead.test", port),
        &RacingOptions {
            resolve: Some(answering(&[])),
            ..RacingOptions::on(platform())
        },
    )
    .await
    .unwrap_err();

    assert_eq!(
        (refused.kind(), unknown.kind()),
        (io::ErrorKind::ConnectionRefused, io::ErrorKind::NotFound),
        "the last failure, then none found"
    );
}
