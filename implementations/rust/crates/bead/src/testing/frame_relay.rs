//! A relay on the loopback between a client and a WebSocket server, which notes each frame the
//! client sends.
//!
//! As the TypeScript side's `frame-relay` and the C# side's `FrameRelay` are: what the client sends
//! piped to the server, its upgrade's head passed as it is and each frame after it read for its FIN
//! bit and its opcode (RFC 6455 §5.2), what the server sends piped back as it is; so that a test
//! tells whether each message went as one frame.

use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use crate::testing::spawn;

// a message's continuation, RFC 6455 §5.2
const CONTINUATION: u8 = 0x0;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A frame the client sent: whether it ends its message, and its opcode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct NotedFrame {
    /// Its FIN bit.
    pub fin: bool,
    /// Its opcode.
    pub opcode: u8,
}

/// The frames of `frames` that are no message whole: one that ends no message, or one that
/// continues one.
#[must_use]
pub fn unwhole_of(frames: &[NotedFrame]) -> Vec<NotedFrame> {
    frames
        .iter()
        .filter(|frame| !frame.fin || frame.opcode == CONTINUATION)
        .copied()
        .collect()
}

// what a client's bytes are read as: its upgrade's head, then its frames' heads, each payload passed
#[derive(Default)]
struct Noting {
    pending: Vec<u8>,
    is_upgraded: bool,
    // the payload's bytes left to pass of the frame read last
    passing: usize,
}

impl Noting {
    fn feed(&mut self, (bytes, frames): (&[u8], &Mutex<Vec<NotedFrame>>)) {
        self.pending.extend_from_slice(bytes);

        if !self.is_upgraded {
            let Some(end) = self
                .pending
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
            else {
                return;
            };

            self.pending.drain(..end.saturating_add(4));
            self.is_upgraded = true;
        }

        loop {
            if self.passing > 0 {
                let passed = self.passing.min(self.pending.len());

                self.pending.drain(..passed);
                self.passing = self.passing.saturating_sub(passed);

                if self.passing > 0 {
                    return;
                }
            }

            let (Some(&first), Some(&second)) = (self.pending.first(), self.pending.get(1)) else {
                return;
            };
            let (extended, length): (usize, Option<usize>) = match second & 0x7F {
                126 => (
                    2,
                    self.pending
                        .get(2..4)
                        .and_then(|bytes| bytes.try_into().ok())
                        .map(|bytes| usize::from(u16::from_be_bytes(bytes))),
                ),
                127 => (
                    8,
                    self.pending
                        .get(2..10)
                        .and_then(|bytes| bytes.try_into().ok())
                        .and_then(|bytes| usize::try_from(u64::from_be_bytes(bytes)).ok()),
                ),
                short => (0, Some(usize::from(short))),
            };
            let mask = if second & 0x80 == 0 { 0 } else { 4 };
            let head = 2_usize.saturating_add(extended).saturating_add(mask);
            let Some(length) = length else {
                return;
            };

            if self.pending.len() < head {
                return;
            }

            locked(frames).push(NotedFrame {
                fin: first & 0x80 != 0,
                opcode: first & 0x0F,
            });
            self.pending.drain(..head);
            self.passing = length;
        }
    }
}

/// The relay: where a client connects through it, and the frames it noted.
pub struct FrameRelay {
    url: String,
    frames: Arc<Mutex<Vec<NotedFrame>>>,
    accepting: JoinHandle<()>,
}

impl core::fmt::Debug for FrameRelay {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("FrameRelay")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

impl FrameRelay {
    /// A relay to the WebSocket server at `host` and `port`, listening on 127.0.0.1; a client
    /// connects through it at `path`, over `ws`.
    ///
    /// # Errors
    ///
    /// Where it cannot listen.
    pub async fn to((host, port): (&str, u16), path: &str) -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let local = listener.local_addr()?.port();
        let frames: Arc<Mutex<Vec<NotedFrame>>> = Arc::default();
        let noted = Arc::clone(&frames);
        let server = (host.trim_matches(['[', ']']).to_owned(), port);
        let accepting = spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let Ok(far) = TcpStream::connect((server.0.as_str(), server.1)).await else {
                    continue;
                };
                let (mut client_reading, mut client_writing) = client.into_split();
                let (mut far_reading, mut far_writing) = far.into_split();
                let noted = Arc::clone(&noted);

                drop(spawn(async move {
                    let mut noting = Noting::default();
                    let mut buffer = vec![0_u8; 65_536];

                    loop {
                        let read = client_reading.read(&mut buffer).await.unwrap_or_default();
                        let Some(bytes) = buffer.get(..read).filter(|bytes| !bytes.is_empty())
                        else {
                            far_writing.shutdown().await.ok();

                            return;
                        };

                        noting.feed((bytes, &noted));

                        if far_writing.write_all(bytes).await.is_err() {
                            return;
                        }
                    }
                }));
                drop(spawn(async move {
                    tokio::io::copy(&mut far_reading, &mut client_writing)
                        .await
                        .ok();
                    client_writing.shutdown().await.ok();
                }));
            }
        });

        Ok(Self {
            url: format!("ws://127.0.0.1:{local}{path}"),
            frames,
            accepting,
        })
    }

    /// Where a client connects through it.
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Each frame the clients sent through it, in its order.
    #[must_use]
    pub fn frames(&self) -> Vec<NotedFrame> {
        locked(&self.frames).clone()
    }
}

impl Drop for FrameRelay {
    fn drop(&mut self) {
        self.accepting.abort();
    }
}
