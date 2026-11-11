//! A peer of the test's own over HTTP/1.1, as `spec/transports.json` plays one.
//!
//! As the TypeScript side's `http-peer.ts` and the C# side's `TransportsTests.cs`: each exchange on
//! a socket of its own, its request written in exact octets, its response read as its bytes come,
//! by its length or de-chunked; an exchange answered 101 goes on as a WebSocket, whose frames the
//! peer writes, masked as a client's, and reads itself (RFC 6455 §5).

use core::time::Duration;
use std::collections::{BTreeMap, VecDeque};
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::Notify;

use crate::testing::{patience, spawn};

const CRLF: &[u8] = b"\r\n";
const HEAD_END: &[u8] = b"\r\n\r\n";

/// A WebSocket frame's opcode, RFC 6455 §5.2: a message's continuation.
pub const CONTINUATION: u8 = 0x0;
/// A text message's first frame.
pub const TEXT: u8 = 0x1;
/// A binary message's first frame.
pub const BINARY: u8 = 0x2;
/// A close.
pub const CLOSE: u8 = 0x8;
/// A ping.
pub const PING: u8 = 0x9;
/// A pong.
pub const PONG: u8 = 0xA;

// the masking key of RFC 6455's examples, §5.7: fixed, so what the peer writes is the same each run
const MASK: [u8; 4] = [0x37, 0xFA, 0x21, 0x3D];

// a close that carries no code, RFC 6455 §7.1.5
const NO_STATUS: u16 = 1_005;

// what a socket is read by at once
const READ_BYTES: usize = 16_384;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn find(bytes: &[u8], (needle, from): (&[u8], usize)) -> Option<usize> {
    bytes
        .get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .and_then(|at| at.checked_add(from))
}

/// `text`'s characters as octets, each its code point (ISO-8859-1), as a case writes a head; none
/// for a character past U+00FF.
#[must_use]
pub fn latin1_of(text: &str) -> Option<Vec<u8>> {
    text.chars().map(|each| u8::try_from(each).ok()).collect()
}

/// `bytes` as text, each octet the character of its code point (ISO-8859-1).
#[must_use]
pub fn text_of_latin1(bytes: &[u8]) -> String {
    bytes.iter().copied().map(char::from).collect()
}

// ── A response ─────────────────────────────────────────────────────────────────────────────────

/// A response's head: its status, and its fields by their names in lower case, a field named twice
/// its values joined as RFC 9110 §5.3 reads them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResponseHead {
    /// Its status.
    pub status: u16,
    /// Its fields.
    pub fields: BTreeMap<String, String>,
}

/// A response read whole: its head, and its body, de-chunked.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Response {
    /// Its head.
    pub head: ResponseHead,
    /// Its body.
    pub body: Vec<u8>,
}

// how a body is framed, RFC 9112 §6.3
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Framing {
    Chunked,
    ToEnd,
    Length(usize),
}

// a head's status line and fields
fn head_of(text: &str) -> Result<ResponseHead, String> {
    let mut lines = text.split("\r\n");
    let line = lines.next().unwrap_or_default();
    let status = line
        .strip_prefix("HTTP/1.1 ")
        .or_else(|| line.strip_prefix("HTTP/1.0 "))
        .and_then(|rest| {
            let (digits, after) = rest.split_at_checked(3)?;

            (digits.bytes().all(|byte| byte.is_ascii_digit())
                && (after.is_empty() || after.starts_with(' ')))
            .then(|| digits.parse::<u16>().ok())
            .flatten()
        })
        .ok_or_else(|| format!("no status line: {line}"))?;
    let mut fields: BTreeMap<String, String> = BTreeMap::new();

    for each in lines {
        let (name, value) = each.split_once(':').unwrap_or((each, ""));
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim().to_owned();

        fields
            .entry(name)
            .and_modify(|before| {
                before.push_str(", ");
                before.push_str(&value);
            })
            .or_insert(value);
    }

    Ok(ResponseHead { status, fields })
}

// none after a 1xx, a 204 or a 304; chunked as the last coding names it; by its length; or to the
// end of the stream
fn framing_of(head: &ResponseHead) -> Result<Framing, String> {
    if head.status < 200 || head.status == 204 || head.status == 304 {
        return Ok(Framing::Length(0));
    }

    let is_chunked = head
        .fields
        .get("transfer-encoding")
        .and_then(|codings| codings.rsplit(',').next())
        .is_some_and(|last| last.trim().eq_ignore_ascii_case("chunked"));

    if is_chunked {
        return Ok(Framing::Chunked);
    }

    head.fields
        .get("content-length")
        .map_or(Ok(Framing::ToEnd), |length| {
            length
                .parse()
                .map(Framing::Length)
                .map_err(|error| format!("a content-length is no number, {length}: {error}"))
        })
}

// a body in chunks, de-chunked, and where it ends; none while its last chunk and the trailers after
// it are to come
fn dechunk(bytes: &[u8]) -> Result<Option<(Vec<u8>, usize)>, String> {
    let mut body = Vec::new();
    let mut at = 0_usize;

    loop {
        let Some(line_end) = find(bytes, (CRLF, at)) else {
            return Ok(None);
        };
        let line = text_of_latin1(bytes.get(at..line_end).unwrap_or_default());
        let digits = line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(digits, 16)
            .map_err(|error| format!("a chunk's size is no number, {digits}: {error}"))?;

        at = line_end.saturating_add(CRLF.len());

        // the last chunk: its trailers, each a line, end at an empty one
        if size == 0 {
            while let Some(end) = find(bytes, (CRLF, at)) {
                if end == at {
                    return Ok(Some((body, end.saturating_add(CRLF.len()))));
                }

                at = end.saturating_add(CRLF.len());
            }

            return Ok(None);
        }

        let end = at.saturating_add(size);

        if bytes.len() < end.saturating_add(CRLF.len()) {
            return Ok(None);
        }

        body.extend_from_slice(bytes.get(at..end).unwrap_or_default());
        at = end.saturating_add(CRLF.len());
    }
}

/// A reader of one HTTP/1.1 response, fed its bytes as they come, in whatever reads they come.
#[derive(Debug, Default)]
pub struct ResponseReader {
    pending: Vec<u8>,
    head: Option<(ResponseHead, Framing)>,
    whole: Option<Response>,
    // what came past a whole response, which a 101 hands to the protocol it switched to
    rest: Vec<u8>,
    failed: Option<String>,
    is_ended: bool,
    is_lost: bool,
}

impl ResponseReader {
    /// A reader that read nothing yet.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads `bytes`, as they came after what it read before.
    pub fn feed(&mut self, bytes: &[u8]) {
        if self.whole.is_some() {
            self.rest.extend_from_slice(bytes);

            return;
        }

        if self.failed.is_some() || self.is_ended {
            return;
        }

        self.pending.extend_from_slice(bytes);

        if let Err(error) = self.advance() {
            self.failed = Some(error);
        }
    }

    // the head once it is in, then the body once it is whole
    fn advance(&mut self) -> Result<(), String> {
        if self.head.is_none() {
            let Some(at) = find(&self.pending, (HEAD_END, 0)) else {
                return Ok(());
            };
            let head = head_of(&text_of_latin1(self.pending.get(..at).unwrap_or_default()))?;
            let framing = framing_of(&head)?;

            self.pending.drain(..at.saturating_add(HEAD_END.len()));
            self.head = Some((head, framing));
        }

        let Some((head, framing)) = self.head.clone() else {
            return Ok(());
        };

        match framing {
            Framing::Chunked => {
                if let Some((body, end)) = dechunk(&self.pending)? {
                    let rest = self.pending.split_off(end.min(self.pending.len()));

                    self.settle((head, body), rest);
                }
            }
            Framing::Length(length) if self.pending.len() >= length => {
                let rest = self.pending.split_off(length);
                let body = core::mem::take(&mut self.pending);

                self.settle((head, body), rest);
            }
            Framing::Length(_) | Framing::ToEnd => {}
        }

        Ok(())
    }

    fn settle(&mut self, (head, body): (ResponseHead, Vec<u8>), rest: Vec<u8>) {
        self.whole = Some(Response { head, body });
        self.pending.clear();
        self.rest = rest;
    }

    /// Reads that the stream ended: a body framed to its end is whole, any other cut short; with
    /// no status line come whole, the exchange is lost.
    pub fn end(&mut self) {
        if self.whole.is_some() || self.failed.is_some() || self.is_ended {
            return;
        }

        self.is_ended = true;

        if let Some((head, Framing::ToEnd)) = self.head.clone() {
            let body = core::mem::take(&mut self.pending);

            self.settle((head, body), Vec::new());

            return;
        }

        // * lost: no status line came whole before the stream ended, as the other sides' peers
        // read it
        self.is_lost = self.head.is_none() && find(&self.pending, (CRLF, 0)).is_none();
        self.failed = Some(if self.head.is_none() {
            "the stream ended before the head was whole".to_owned()
        } else {
            "the stream ended before the body was whole".to_owned()
        });
    }

    /// Its head, once read.
    #[must_use]
    pub fn head(&self) -> Option<&ResponseHead> {
        self.head.as_ref().map(|(head, _)| head)
    }

    /// Its response, once whole.
    #[must_use]
    pub const fn response(&self) -> Option<&Response> {
        self.whole.as_ref()
    }

    /// Why it read no response: what it could not read, or the stream's end before it was whole.
    #[must_use]
    pub fn failed(&self) -> Option<&str> {
        self.failed.as_deref()
    }

    /// Whether the stream ended before any status line: the exchange is lost.
    #[must_use]
    pub const fn is_lost(&self) -> bool {
        self.is_lost
    }

    /// What came past its whole response, taken from it.
    pub fn take_rest(&mut self) -> Vec<u8> {
        core::mem::take(&mut self.rest)
    }
}

// ── WebSocket's frames ─────────────────────────────────────────────────────────────────────────

/// A WebSocket frame, RFC 6455 §5.2: its opcode, whether it ends its message, and its payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// Whether it ends its message.
    pub fin: bool,
    /// Its opcode.
    pub opcode: u8,
    /// Its payload.
    pub payload: Vec<u8>,
}

impl Frame {
    /// A frame that ends its message.
    #[must_use]
    pub const fn whole(opcode: u8, payload: Vec<u8>) -> Self {
        Self {
            fin: true,
            opcode,
            payload,
        }
    }

    /// A close and its code, RFC 6455 §5.5.1.
    #[must_use]
    pub fn close(code: u16) -> Self {
        Self::whole(CLOSE, code.to_be_bytes().to_vec())
    }

    /// Its bytes as a client writes them, RFC 6455 §5.2: masked, its length in 7, 16 or 64 bits as
    /// it needs.
    #[must_use]
    pub fn masked(&self) -> Vec<u8> {
        let length = self.payload.len();
        let mut frame = vec![if self.fin { 0x80 } else { 0 } | (self.opcode & 0x0F)];

        if let Ok(short) = u8::try_from(length)
            && short < 126
        {
            frame.push(0x80 | short);
        } else if let Ok(medium) = u16::try_from(length) {
            frame.push(0x80 | 0x7E);
            frame.extend_from_slice(&medium.to_be_bytes());
        } else {
            frame.push(0x80 | 0x7F);
            frame.extend_from_slice(&u64::try_from(length).unwrap_or(u64::MAX).to_be_bytes());
        }

        frame.extend_from_slice(&MASK);
        frame.extend(
            self.payload
                .iter()
                .zip(MASK.iter().cycle())
                .map(|(byte, key)| byte ^ key),
        );

        frame
    }
}

/// What a server sends on a WebSocket, each as it comes: a message whole, a close, a ping, a pong,
/// the end; or what the peer could not read, which ends the socket.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Heard {
    /// A binary message.
    Binary(Vec<u8>),
    /// A text message.
    Text(String),
    /// A close and its code, 1005 for none.
    Close(u16),
    /// A ping and its payload.
    Ping(Vec<u8>),
    /// A pong and its payload.
    Pong(Vec<u8>),
    /// The socket ended.
    End,
    /// What the peer could not read: a frame of a reserved opcode.
    Failed(String),
}

/// A reader of the frames a server sends, RFC 6455 §5: a message's frames put together, each thing
/// heard handed on as it comes whole.
#[derive(Debug, Default)]
pub struct FrameReader {
    pending: Vec<u8>,
    message: Option<(u8, Vec<u8>)>,
}

impl FrameReader {
    /// A reader that read nothing yet.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Reads `bytes`, as they came after what it read before: each control frame, whole, as the
    /// frame it is, beside what it heard of it.
    ///
    /// # Errors
    ///
    /// A frame of a reserved opcode, which fails the connection (RFC 6455 §5.2).
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<(Heard, Option<Frame>)>, String> {
        self.pending.extend_from_slice(bytes);

        let mut heard = Vec::new();

        while let Some(frame) = self.next_frame() {
            if let Some(each) = self.on_frame(&frame)? {
                let is_control = frame.opcode >= CLOSE;

                heard.push((each, is_control.then_some(frame)));
            }
        }

        Ok(heard)
    }

    // the next frame whole, its length in 7, 16 or 64 bits, unmasked when masked
    fn next_frame(&mut self) -> Option<Frame> {
        let first = *self.pending.first()?;
        let second = *self.pending.get(1)?;
        let short = second & 0x7F;
        let extended: usize = match short {
            126 => 2,
            127 => 8,
            _ => 0,
        };
        let is_masked = second & 0x80 != 0;
        let key_at = extended.checked_add(2)?;
        let at = key_at.checked_add(if is_masked { MASK.len() } else { 0 })?;
        let lengths = self.pending.get(2..key_at)?;
        let length = match extended {
            0 => usize::from(short),
            _ => lengths.iter().try_fold(0_usize, |length, byte| {
                length.checked_mul(256)?.checked_add(usize::from(*byte))
            })?,
        };
        let end = at.checked_add(length)?;
        let payload = self.pending.get(at..end)?;
        let key = self.pending.get(key_at..at).unwrap_or_default().to_vec();
        let payload = if is_masked {
            payload
                .iter()
                .zip(key.iter().cycle())
                .map(|(byte, key)| byte ^ key)
                .collect()
        } else {
            payload.to_vec()
        };

        self.pending.drain(..end);

        Some(Frame {
            fin: first & 0x80 != 0,
            opcode: first & 0x0F,
            payload,
        })
    }

    fn on_frame(&mut self, frame: &Frame) -> Result<Option<Heard>, String> {
        match frame.opcode {
            CLOSE => {
                let code = match frame.payload.as_slice() {
                    [high, low, ..] => u16::from_be_bytes([*high, *low]),
                    _ => NO_STATUS,
                };

                Ok(Some(Heard::Close(code)))
            }
            PING => Ok(Some(Heard::Ping(frame.payload.clone()))),
            PONG => Ok(Some(Heard::Pong(frame.payload.clone()))),
            BINARY | TEXT | CONTINUATION => {
                if frame.opcode != CONTINUATION {
                    self.message = Some((frame.opcode, Vec::new()));
                }

                let Some((opcode, parts)) = self.message.as_mut() else {
                    return Ok(None);
                };

                parts.extend_from_slice(&frame.payload);

                if !frame.fin {
                    return Ok(None);
                }

                let (opcode, bytes) = (*opcode, core::mem::take(parts));

                self.message = None;

                Ok(Some(if opcode == TEXT {
                    Heard::Text(String::from_utf8_lossy(&bytes).into_owned())
                } else {
                    Heard::Binary(bytes)
                }))
            }
            reserved => Err(format!(
                "the server sent a frame of reserved opcode {reserved:#x}"
            )),
        }
    }
}

// ── An exchange ────────────────────────────────────────────────────────────────────────────────

/// How an exchange's socket is opened, and whether it answers pings.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ExchangeOptions {
    /// Where its socket connects.
    pub address: SocketAddr,
    /// Whether it answers each ping with its pong: `true` when none.
    pub answers_pings: Option<bool>,
}

impl ExchangeOptions {
    /// An exchange with `address`, every other option its default.
    #[must_use]
    pub const fn new(address: SocketAddr) -> Self {
        Self {
            address,
            answers_pings: None,
        }
    }
}

// what came on an exchange's socket, as its reader keeps it
#[derive(Debug, Default)]
struct Read {
    reader: ResponseReader,
    frames: Option<FrameReader>,
    heard: VecDeque<Heard>,
    has_closed: bool,
    has_ended: bool,
}

#[derive(Debug)]
struct Shared {
    read: Mutex<Read>,
    changed: Notify,
    writer: tokio::sync::Mutex<Option<OwnedWriteHalf>>,
    answers_pings: bool,
}

impl Shared {
    // what came, read, and the answers it calls for: a ping's pong, a close's own
    fn take(&self, bytes: &[u8]) -> Vec<Frame> {
        let mut answers = Vec::new();
        let mut read = locked(&self.read);

        if read.frames.is_none() {
            read.reader.feed(bytes);

            let is_upgraded = read
                .reader
                .response()
                .is_some_and(|response| response.head.status == 101);

            if is_upgraded {
                let rest = read.reader.take_rest();

                read.frames = Some(FrameReader::new());
                answers = hear(&mut read, (&rest, self.answers_pings));
            }
        } else {
            answers = hear(&mut read, (bytes, self.answers_pings));
        }

        drop(read);

        answers
    }

    fn end(&self) {
        let mut read = locked(&self.read);

        read.reader.end();

        if !read.has_ended {
            read.has_ended = true;
            read.heard.push_back(Heard::End);
        }
    }

    async fn write(&self, frames: &[Frame]) -> io::Result<()> {
        let bytes: Vec<u8> = frames.iter().flat_map(Frame::masked).collect();
        let mut writer = self.writer.lock().await;
        let written = match writer.as_mut() {
            Some(writer) => writer.write_all(&bytes).await,
            None => Err(io::Error::from(io::ErrorKind::NotConnected)),
        };

        drop(writer);

        written
    }
}

// what a frame reader makes of `bytes`, heard in order; a ping answered with its pong unless told
// not to, a close answered with its own code unless the peer closed first (RFC 6455 §5.5.1)
fn hear(read: &mut Read, (bytes, answers_pings): (&[u8], bool)) -> Vec<Frame> {
    let mut answers = Vec::new();
    let Some(frames) = read.frames.as_mut() else {
        return answers;
    };

    match frames.feed(bytes) {
        Ok(heard) => {
            for (each, frame) in heard {
                match (&each, frame) {
                    (Heard::Ping(payload), Some(_)) if answers_pings => {
                        answers.push(Frame::whole(PONG, payload.clone()));
                    }
                    (Heard::Close(_), Some(frame)) if !read.has_closed => {
                        read.has_closed = true;
                        answers.push(frame);
                    }
                    _ => {}
                }

                read.heard.push_back(each);
            }
        }
        Err(error) => read.heard.push_back(Heard::Failed(error)),
    }

    answers
}

async fn read_on(shared: Arc<Shared>, mut socket: OwnedReadHalf) {
    let mut buffer = vec![0_u8; READ_BYTES];

    loop {
        let count = match socket.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        let answers = shared.take(buffer.get(..count).unwrap_or_default());

        shared.changed.notify_waiters();

        if locked(&shared.read)
            .heard
            .iter()
            .any(|heard| matches!(heard, Heard::Failed(_)))
        {
            break;
        }

        if !answers.is_empty() && shared.write(&answers).await.is_err() {
            break;
        }
    }

    shared.end();
    shared.changed.notify_waiters();
    shared.writer.lock().await.take();
}

/// One exchange: its socket, its response as it comes, and, once answered 101, its WebSocket.
#[derive(Debug)]
pub struct Exchange {
    shared: Arc<Shared>,
    local_port: u16,
    reading: tokio::task::JoinHandle<()>,
}

impl Exchange {
    /// Opens a socket as `options` says and writes `request` on it at once; what comes is read as
    /// it comes, by a task of its own. Answered 101, the socket goes on as a WebSocket.
    ///
    /// # Errors
    ///
    /// What the platform refuses the connect or the write with.
    pub async fn open(request: &[u8], options: &ExchangeOptions) -> io::Result<Self> {
        let socket = TcpStream::connect(options.address).await?;
        let local_port = socket.local_addr()?.port();
        let (reading, mut writing) = socket.into_split();

        writing.write_all(request).await?;

        let shared = Arc::new(Shared {
            read: Mutex::new(Read::default()),
            changed: Notify::new(),
            writer: tokio::sync::Mutex::new(Some(writing)),
            answers_pings: options.answers_pings.unwrap_or(true),
        });
        let reading = spawn(read_on(Arc::clone(&shared), reading));

        Ok(Self {
            shared,
            local_port,
            reading,
        })
    }

    /// The port of its socket's own end, which names its connection on the server.
    #[must_use]
    pub const fn local_port(&self) -> u16 {
        self.local_port
    }

    // waits, until `deadline`, for what `found` reads of what came
    async fn until<T, F>(&self, (found, within): (F, Duration)) -> Option<T>
    where
        F: Fn(&mut Read) -> Option<T> + Send + Sync,
        T: Send,
    {
        let waiting = async {
            loop {
                let changed = self.shared.changed.notified();
                let mut changed = core::pin::pin!(changed);

                changed.as_mut().enable();

                let seen = found(&mut locked(&self.shared.read));

                if let Some(seen) = seen {
                    return seen;
                }

                changed.await;
            }
        };

        patience(within, waiting).await.ok()
    }

    /// Its response's head, once read within `within`; or why none came: a stream that ended
    /// before it, what could not be read, or nothing in time.
    ///
    /// # Errors
    ///
    /// Why no head came.
    pub async fn head(&self, within: Duration) -> Result<ResponseHead, String> {
        self.until((
            |read: &mut Read| {
                read.reader
                    .head()
                    .cloned()
                    .map(Ok)
                    .or_else(|| read.reader.failed().map(|failed| Err(failed.to_owned())))
            },
            within,
        ))
        .await
        .unwrap_or_else(|| Err(format!("no head within {} ms", within.as_millis())))
    }

    /// Its response whole, once read within `within`.
    ///
    /// # Errors
    ///
    /// Why no response came whole.
    pub async fn response(&self, within: Duration) -> Result<Response, String> {
        self.until((
            |read: &mut Read| {
                read.reader
                    .response()
                    .cloned()
                    .map(Ok)
                    .or_else(|| read.reader.failed().map(|failed| Err(failed.to_owned())))
            },
            within,
        ))
        .await
        .unwrap_or_else(|| Err(format!("no response within {} ms", within.as_millis())))
    }

    /// Whether its stream ended before any status line: the exchange is lost.
    #[must_use]
    pub fn is_lost(&self) -> bool {
        locked(&self.shared.read).reader.is_lost()
    }

    /// The next thing its server sends on its WebSocket, or none within `within`.
    pub async fn next(&self, within: Duration) -> Option<Heard> {
        self.until((|read: &mut Read| read.heard.pop_front(), within))
            .await
    }

    /// Writes `frames` on its WebSocket, each masked, as a client's must be.
    ///
    /// # Errors
    ///
    /// What the platform refuses the write with, or a socket ended already.
    pub async fn send(&self, frames: &[Frame]) -> io::Result<()> {
        if frames.iter().any(|frame| frame.opcode == CLOSE) {
            locked(&self.shared.read).has_closed = true;
        }

        self.shared.write(frames).await
    }

    /// Ends its socket at once.
    pub fn destroy(&self) {
        self.reading.abort();

        if let Ok(mut writer) = self.shared.writer.try_lock() {
            writer.take();
        }
    }
}

impl Drop for Exchange {
    fn drop(&mut self) {
        self.reading.abort();
    }
}
