//! A relay on the loopback between one participant's adapter and its broker, which a case's `lose`
//! cuts.
//!
//! As the C# side's `LinkRelay` and the TypeScript side's `link-relay` are: each network
//! connection through it piped both ways, and, cut, each reset at both its ends, so that the
//! adapter sees its link lost and the broker a link that ended without a clean end, its will
//! published where it left one. It keeps listening, so that a participant that links anew links
//! through it again. Given a delay, it holds each chunk that long each way, in its order, an end
//! behind what came before it, as a broker a round trip away.

use core::time::Duration;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::testing::{Instant, rest, spawn};

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How a relay holds what it pipes.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct LinkRelayOptions {
    /// How long each chunk is held each way, as a broker a round trip away: none when none.
    pub delay: Option<Duration>,
}

// one network connection through it: both its sockets, which a cut resets, and its pipes
struct Pair {
    resetters: Vec<socket2::Socket>,
    tasks: Vec<JoinHandle<()>>,
}

/// The relay: where an adapter links through it, and what cuts each link.
pub struct LinkRelay {
    port: u16,
    pairs: Arc<Mutex<Vec<Pair>>>,
    accepting: JoinHandle<()>,
}

impl core::fmt::Debug for LinkRelay {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("LinkRelay")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

// a chunk held, or the end of its way: its time, then its bytes, none for the end
type Held = (Instant, Option<Vec<u8>>);

// what comes on `from`, held its delay, written to `to` in its order, an end behind it
async fn pipe((mut from, mut to): (ReadHalf<TcpStream>, WriteHalf<TcpStream>), delay: Duration) {
    let (held, mut queue) = mpsc::unbounded_channel::<Held>();
    let writing = spawn(async move {
        while let Some((at, chunk)) = queue.recv().await {
            let left = delay.saturating_sub(at.elapsed());

            if !left.is_zero() {
                rest(left).await;
            }

            let Some(chunk) = chunk else {
                to.shutdown().await.ok();

                return;
            };

            if to.write_all(&chunk).await.is_err() {
                return;
            }
        }
    });
    let mut buffer = vec![0_u8; 65_536];

    loop {
        let read = from.read(&mut buffer).await.unwrap_or_default();
        let chunk = (read > 0).then(|| buffer.get(..read).unwrap_or_default().to_vec());
        let is_end = chunk.is_none();

        held.send((Instant::now(), chunk)).ok();

        if is_end {
            break;
        }
    }

    drop(held);
    writing.await.ok();
}

fn resetter_of(socket: &TcpStream) -> Option<socket2::Socket> {
    socket2::SockRef::from(socket).try_clone().ok()
}

impl LinkRelay {
    /// A relay to the broker at `host` and `port`, listening on 127.0.0.1, each chunk held
    /// `options`' delay each way where one is given.
    ///
    /// # Errors
    ///
    /// Where it cannot listen.
    pub async fn to((host, port): (&str, u16), options: &LinkRelayOptions) -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let local = listener.local_addr()?.port();
        let pairs: Arc<Mutex<Vec<Pair>>> = Arc::default();
        let held = Arc::clone(&pairs);
        let broker = (host.trim_matches(['[', ']']).to_owned(), port);
        let delay = options.delay.unwrap_or_default();
        let accepting = spawn(async move {
            while let Ok((near, _)) = listener.accept().await {
                let Ok(far) = TcpStream::connect((broker.0.as_str(), broker.1)).await else {
                    continue;
                };
                let resetters = [resetter_of(&near), resetter_of(&far)]
                    .into_iter()
                    .flatten()
                    .collect();
                let (near_reading, near_writing) = tokio::io::split(near);
                let (far_reading, far_writing) = tokio::io::split(far);
                let tasks = vec![
                    spawn(pipe((near_reading, far_writing), delay)),
                    spawn(pipe((far_reading, near_writing), delay)),
                ];

                locked(&held).push(Pair { resetters, tasks });
            }
        });

        Ok(Self {
            port: local,
            pairs,
            accepting,
        })
    }

    /// The port an adapter links to it by, on 127.0.0.1.
    #[must_use]
    pub const fn port(&self) -> u16 {
        self.port
    }

    /// Resets each network connection through it, at both its ends; it keeps listening.
    pub fn cut(&self) {
        let pairs: Vec<Pair> = locked(&self.pairs).drain(..).collect();

        for pair in pairs {
            for resetter in &pair.resetters {
                resetter.set_linger(Some(Duration::ZERO)).ok();
            }

            for task in &pair.tasks {
                task.abort();
            }
        }
    }

    /// Stops listening, and resets each network connection through it.
    pub fn dispose(&self) {
        self.accepting.abort();
        self.cut();
    }
}

impl Drop for LinkRelay {
    fn drop(&mut self) {
        self.dispose();
    }
}
