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

#[tokio::test]
async fn keeps_an_attempt_that_has_not_connected_by_its_delay_while_the_next_one_starts_the_first_to_connect_winning_and_the_other_closed()
 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (told, given_up) = oneshot::channel::<()>();
    let told = Arc::new(Mutex::new(Some(told)));
    let (started, second_started) = oneshot::channel::<()>();
    let started = Arc::new(Mutex::new(Some(started)));
    let second_started = Arc::new(Mutex::new(Some(second_started)));
    let options = RacingOptions {
        attempt_delay: Duration::from_millis(50),
        attempt: Some(Arc::new(move |address: SocketAddr| {
            if address.is_ipv6() {
                // * the second attempt, started at the first's delay, connects to nothing
                let guard = Dropped(told.lock().unwrap().take());

                let starting = started.lock().unwrap().take();

                if let Some(started) = starting {
                    started.send(()).ok();
                }

                return Box::pin(async move {
                    let _guard = guard;

                    core::future::pending::<io::Result<TcpStream>>().await
                });
            }

            // * the first attempt connects once the second started, past its delay
            let waited = second_started.lock().unwrap().take();

            Box::pin(async move {
                if let Some(waited) = waited {
                    waited.await.ok();
                }

                TcpStream::connect(address).await
            })
        })),
        ..RacingOptions::on(platform())
    };
    let socket = patience(PATIENCE, connect_racing(("localhost", port), &options))
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        socket.peer_addr().unwrap().ip(),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        "the first attempt, kept while the second started, connected"
    );
    assert!(
        patience(PATIENCE, given_up).await.unwrap().is_ok(),
        "the second closed"
    );
}

#[tokio::test]
async fn ends_every_attempt_leaving_no_socket_once_its_connect_is_given_up() {
    let (told, ended) = oneshot::channel::<()>();
    let told: Arc<Mutex<Vec<oneshot::Sender<()>>>> = Arc::new(Mutex::new(vec![told]));
    let (second, second_ended) = oneshot::channel::<()>();

    told.lock().unwrap().push(second);

    let attempts: Arc<Mutex<Vec<IpAddr>>> = Arc::default();
    let recording = Arc::clone(&attempts);
    let options = RacingOptions {
        attempt_delay: Duration::from_millis(50),
        attempt: Some(Arc::new(move |address: SocketAddr| {
            recording.lock().unwrap().push(address.ip());

            // * each attempt pends, nothing answering it, until it is given up
            let guard = Dropped(told.lock().unwrap().pop());

            Box::pin(async move {
                let _guard = guard;

                core::future::pending::<io::Result<TcpStream>>().await
            })
        })),
        ..RacingOptions::on(platform())
    };

    // given up by its patience, once both attempts started
    let given_up = patience(
        Duration::from_millis(300),
        connect_racing(("localhost", 9), &options),
    )
    .await;

    assert!(given_up.is_err(), "given up");
    assert_eq!(
        *attempts.lock().unwrap(),
        [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::LOCALHOST)
        ],
        "both started"
    );
    assert!(
        patience(PATIENCE, ended).await.unwrap().is_ok()
            && patience(PATIENCE, second_ended).await.unwrap().is_ok(),
        "each ended"
    );
}

// spec 13.4.2
#[tokio::test]
async fn connects_a_localhost_name_to_the_loopback_asking_its_resolver_nothing() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let options = RacingOptions {
        resolve: Some(recording(&asked)),
        ..RacingOptions::on(platform())
    };

    for host in ["localhost", "bead-probe.localhost", "Bead-Probe.LOCALHOST"] {
        let socket = patience(PATIENCE, connect_racing((host, port), &options))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            socket.peer_addr().unwrap().ip(),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            "{host}: the loopback's"
        );
    }

    assert_eq!(*asked.lock().unwrap(), Vec::<String>::new(), "none asked");
}

// spec 13.4.2
#[tokio::test]
async fn tries_the_ipv4_loopback_first_for_a_localhost_name_then_the_ipv6_one_an_attempt_delay_after()
 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let started = Instant::now();
    let attempts: Arc<Mutex<Vec<(IpAddr, Duration)>>> = Arc::default();
    let recording = Arc::clone(&attempts);
    let options = RacingOptions {
        attempt: Some(Arc::new(move |address: SocketAddr| {
            recording
                .lock()
                .unwrap()
                .push((address.ip(), started.elapsed()));

            Box::pin(async move {
                if address.is_ipv4() {
                    // an attempt nothing answers, until it is given up
                    core::future::pending::<()>().await;
                }

                // * the IPv6 one taken on the IPv4 listener, which a machine without ::1 has too
                TcpStream::connect((Ipv4Addr::LOCALHOST, address.port())).await
            })
        })),
        ..RacingOptions::on(platform())
    };

    patience(
        PATIENCE,
        connect_racing(("bead-probe.localhost", port), &options),
    )
    .await
    .unwrap()
    .unwrap();

    let tried = attempts.lock().unwrap().clone();

    assert_eq!(
        tried
            .iter()
            .map(|(address, _)| *address)
            .collect::<Vec<_>>(),
        [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::LOCALHOST)
        ],
        "IPv4 first"
    );

    let gap = tried[1].1.saturating_sub(tried[0].1);

    assert!(
        (Duration::from_millis(240)..=Duration::from_secs(2)).contains(&gap),
        "250 ms apart: {gap:?}"
    );
}

// spec 13.4.2
#[tokio::test]
async fn asks_its_resolver_for_any_other_name_localhost_with_a_trailing_dot_among_them() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let names = [
        "localhost.",
        "a.localhost.",
        "localhost.example",
        "bead.test",
    ];
    let options = RacingOptions {
        resolve: Some(recording(&asked)),
        // * each answer's address taken on the loopback's listener
        attempt: Some(Arc::new(|address: SocketAddr| {
            Box::pin(async move { TcpStream::connect((Ipv4Addr::LOCALHOST, address.port())).await })
        })),
        ..RacingOptions::on(platform())
    };

    for name in names {
        patience(PATIENCE, connect_racing((name, port), &options))
            .await
            .unwrap()
            .unwrap();
    }

    assert_eq!(*asked.lock().unwrap(), names, "each asked");
}

// spec 13.4.2
#[tokio::test]
async fn says_that_a_localhost_name_it_could_not_connect_went_to_the_loopback_no_resolver_asked() {
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let options = RacingOptions {
        resolve: Some(recording(&asked)),
        attempt: Some(Arc::new(|_address| {
            Box::pin(async { Err(io::Error::from(io::ErrorKind::ConnectionRefused)) })
        })),
        ..RacingOptions::on(platform())
    };
    let failed = patience(
        PATIENCE,
        connect_racing(("bead-probe.localhost", 9), &options),
    )
    .await
    .unwrap()
    .unwrap_err();

    assert_eq!(
        failed.kind(),
        io::ErrorKind::ConnectionRefused,
        "the platform's cause kept"
    );
    assert!(
        failed.to_string().contains(
            "bead-probe.localhost names the loopback: connected to 127.0.0.1 and ::1, no resolver asked"
        ),
        "{failed}"
    );
    assert_eq!(*asked.lock().unwrap(), Vec::<String>::new(), "none asked");
}
