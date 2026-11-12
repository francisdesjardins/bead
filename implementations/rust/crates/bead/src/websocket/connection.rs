//! One WebSocket connection, either end's, as the C# side's `WebSocketConnection` holds it: what
//! goes out on it, in order, one message at a time; what comes in, each message whole and bounded;
//! and its close — the peer's answered at once, this side's waited for within its timeout, then
//! dropped.
//!
//! One task owns it, its socket and its timers' word among it: what the side asks of it comes by
//! its [`Commands`], and what it hears goes to its [`ConnectionHooks`], called within that task's
//! turn. A message past its bound fails it with 1009 (RFC 6455 §7.1.7), which tungstenite does not
//! send: it is sent here, and what comes after is read and dropped to the peer's end, or to the
//! close timeout, then the socket is dropped, its close unclean whatever the peer answers.

use core::fmt;
use core::future::poll_fn;
use core::pin::Pin;
use core::task::{Context, Poll};
use core::time::Duration;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;
use futures_util::{Sink, Stream};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::WebSocketStream;
use tungstenite::error::{CapacityError, Error as WsError, ProtocolError};
use tungstenite::protocol::frame::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::{Message, Role, WebSocketConfig};

use crate::clock::{Schedule, SharedClock, Timer};
use crate::duration::NEVER;
use crate::net::bounds::{SendPace, SendPaceHooks, SendPaceOptions};

#[cfg(test)]
mod tests;

/// How long, by default, a close this side begins waits for its peer's answer before the socket is
/// dropped: 5 seconds.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// The largest message by default: a router's largest envelope by default (spec 15.3).
pub const MAXIMUM_MESSAGE_BYTES: u64 = 16_778_240;

/// A close's status: the peer's going away, its stop's (RFC 6455 §7.4.1).
pub(crate) const GOING_AWAY: u16 = 1001;

/// A close's status: its end by its own word.
pub(crate) const NORMAL: u16 = 1000;

// what a close with no status reads as, and a socket that ended with none (RFC 6455 §7.1.5)
const NO_STATUS: u16 = 1005;
const ABNORMAL: u16 = 1006;

// the statuses this side fails a connection with (RFC 6455 §7.4.1)
const PROTOCOL_ERROR: u16 = 1002;
const TOO_BIG: u16 = 1009;

// what a failed connection reads at once of its socket, and drops
const DRAINED_BYTES: usize = 16_384;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A socket a connection runs over: one it can drop at once, with no closing handshake, its peer
/// reset (RFC 6455 §7.1.7).
pub(crate) trait Wire: AsyncRead + AsyncWrite + Unpin + Send + 'static {
    /// Readies its drop: once dropped, its peer is reset rather than ended.
    fn abort(&self) {}
}

impl Wire for tokio::net::TcpStream {
    fn abort(&self) {
        // a socket that takes no linger is dropped as it would be
        socket2::SockRef::from(self)
            .set_linger(Some(Duration::ZERO))
            .ok();
    }
}

#[cfg(test)]
impl Wire for tokio::io::DuplexStream {}

/// What a connection holds what waits for its socket to, a server's (spec 15.12): its bound, and
/// its pace past its grace, 0 holding none.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Pacing {
    pub(crate) maximum_unsent_bytes: u64,
    pub(crate) pace: SendPaceOptions,
}

/// What a connection reads and closes within, and what holds what waits for its socket.
#[derive(Clone)]
pub(crate) struct ConnectionBounds {
    /// The largest message it reads, and the largest frame.
    pub(crate) maximum_message_bytes: u64,
    /// How long a close this side begins waits for its peer; [`NEVER`] waits without end.
    pub(crate) close_timeout: Duration,
    /// What holds what waits for its socket, a server's; none, nothing does.
    pub(crate) pacing: Option<Pacing>,
    /// The platform's clock, which its close timeout and its pace run on.
    pub(crate) platform: SharedClock,
}

/// What a connection tells of itself, within its task's turn.
pub(crate) struct ConnectionHooks {
    /// A message whole: its bytes, and whether it came as text.
    pub(crate) deliver: Box<dyn FnMut(Bytes, bool) + Send>,
    /// Its peer answered a ping.
    pub(crate) answered: Box<dyn FnMut() + Send>,
}

/// How a connection ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Ended {
    /// The status its peer's close carried: 1005 for one with none, 1006 for no close at all.
    pub(crate) code: u16,
    /// Whether this side ended it of its own: dropped behind a bound, failed, or dropped past its
    /// close timeout. Its close is unclean, whatever the peer answered.
    pub(crate) is_ended_here: bool,
    /// What failed it: a message past its bound, a protocol error, why it was dropped behind a
    /// bound; none when it ended as a connection does.
    pub(crate) failure: Option<Failed>,
}

impl Ended {
    /// Whether it closed by its peer's own word: a close of 1000, nothing failing it.
    pub(crate) fn is_clean(&self) -> bool {
        self.code == NORMAL && !self.is_ended_here
    }
}

/// What failed a connection, as its side reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Failed {
    /// A message past its bound, which it was failed with 1009 for.
    TooBig(u64),
    /// Its peer broke the protocol, which it was failed with 1002 for, in tungstenite's words.
    Protocol(String),
    /// Dropped behind a bound of its pace, and why, naming the bound and its value.
    Dropped(String),
}

enum Command {
    Send(Bytes),
    Ping,
    Close(u16),
    Drop,
    Resume,
}

// what the side and the connection's task share
struct Shared {
    unsent: AtomicU64,
    paused: AtomicBool,
    is_ended: AtomicBool,
    dropped: Mutex<Option<String>>,
}

/// What the side asks of a connection: each takes effect as it is made, carried out by its task.
#[derive(Clone)]
pub(crate) struct Commands {
    sender: mpsc::UnboundedSender<Command>,
    shared: Arc<Shared>,
    pacing: Option<Pacing>,
    pace: Option<SendPace>,
    ended: watch::Receiver<bool>,
}

impl fmt::Debug for Commands {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Commands")
            .field("unsent", &self.unsent_bytes())
            .finish_non_exhaustive()
    }
}

impl Commands {
    /// Sends `bytes`, behind what was sent before: nothing once the connection ended or is ending;
    /// held to its pace and its bound, when it has one: what would take what waits past its bound
    /// drops the connection, and goes nowhere.
    pub(crate) fn send(&self, bytes: Bytes) {
        if self.shared.is_ended.load(Ordering::SeqCst) {
            return;
        }

        let length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);

        if let Some(pacing) = &self.pacing {
            let held = self.shared.unsent.load(Ordering::SeqCst);

            // * what waits for the socket, held (spec 15.12): an envelope that would take it past
            // its bound drops the connection
            if held.saturating_add(length) > pacing.maximum_unsent_bytes {
                self.drop_behind(format!(
                    "what waits for its socket would pass maximumUnsentBytes, {} bytes",
                    pacing.maximum_unsent_bytes
                ));

                return;
            }

            self.shared.unsent.fetch_add(length, Ordering::SeqCst);

            if let Some(pace) = &self.pace {
                pace.hand(length);
            }
        }

        if self.sender.send(Command::Send(bytes)).is_err() && self.pacing.is_some() {
            self.shared.unsent.fetch_sub(length, Ordering::SeqCst);
        }
    }

    /// Pings its peer, behind what was sent before, unless it closes.
    pub(crate) fn ping(&self) {
        self.sender.send(Command::Ping).ok();
    }

    /// Drops it at once, its close unclean, no error told: its heartbeat's word.
    pub(crate) fn drop_now(&self) {
        self.sender.send(Command::Drop).ok();
    }

    /// Closes it with `code`, behind what was sent before it, then waits for its peer's answer
    /// within its close timeout; nothing once it ended or is ending.
    pub(crate) fn close(&self, code: u16) {
        self.sender.send(Command::Close(code)).ok();
    }

    // drops it behind a bound, `why` naming it; the first why alone is kept
    fn drop_behind(&self, why: String) {
        {
            let mut dropped = locked(&self.shared.dropped);

            if dropped.is_some() || self.shared.is_ended.load(Ordering::SeqCst) {
                return;
            }

            *dropped = Some(why);
        }

        if let Some(pace) = &self.pace {
            pace.stop();
        }

        self.sender.send(Command::Drop).ok();
    }

    /// Reads no message more, its router behind (spec 15.12): what its socket holds stays there,
    /// until a resume. Nothing once it closes, which reads on. It takes no lock.
    pub(crate) fn pause(&self) {
        self.shared.paused.store(true, Ordering::SeqCst);
    }

    /// Reads again, from its task's own step, never within this call.
    pub(crate) fn resume(&self) {
        if self.shared.paused.swap(false, Ordering::SeqCst) {
            self.sender.send(Command::Resume).ok();
        }
    }

    /// What waits for its socket right now, in bytes, a server's: what it was handed and the
    /// socket has not taken yet.
    pub(crate) fn unsent_bytes(&self) -> u64 {
        self.shared.unsent.load(Ordering::SeqCst)
    }

    /// Settles once it ended.
    pub(crate) async fn ended(&self) {
        let mut ended = self.ended.clone();

        ended.wait_for(|is_ended| *is_ended).await.ok();
    }
}

// where its close stands
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Closing {
    // open
    No,
    // this side's close sent, or queued, reading on to the peer's
    ByUs,
    // failed with its status: what comes is read raw and dropped, to the peer's end or the timeout
    Failing,
}

// where its writing stands
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Writing {
    // nothing handed waits for its flush
    Idle,
    // what was handed is being flushed
    Flushing,
    // its socket went as something went out: it takes nothing more
    Broken,
}

/// One connection, owned by the task that runs it.
pub(crate) struct Connection<S: Wire> {
    socket: WebSocketStream<S>,
    receiver: mpsc::UnboundedReceiver<Command>,
    shared: Arc<Shared>,
    pace: Option<SendPace>,
    bounds: ConnectionBounds,
    ended: watch::Sender<bool>,
    // what waits to be handed to the socket, and what was handed and not flushed yet
    queue: VecDeque<(Message, u64)>,
    in_flight: u64,
    writing: Writing,
    closing: Closing,
    // the status its peer's close carried, once it came, and whether its socket gave its last
    peer_code: Option<u16>,
    is_done: bool,
    // whether its side let go of it, so its commands are heard no more
    is_unheard: bool,
    failure: Option<Failed>,
    is_ended_here: bool,
    // its close timeout's word, once armed
    timer: Option<Arc<dyn Timer>>,
    timed_out: Option<oneshot::Receiver<()>>,
}

impl<S: Wire> fmt::Debug for Connection<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Connection")
            .field("closing", &self.closing)
            .finish_non_exhaustive()
    }
}

// what one step of its task met
enum Step {
    Command(Option<Command>),
    Written(Result<u64, WsError>),
    Read(Option<Result<Message, WsError>>),
    Drained(bool),
    TimedOut,
}

impl<S: Wire> Connection<S> {
    /// A connection over `socket`, its upgrade done and `read` what came past its head, within
    /// `bounds`, and what the side asks of it by.
    pub(crate) async fn open(
        (socket, read): (S, Vec<u8>),
        (role, bounds): (Role, ConnectionBounds),
    ) -> (Self, Commands) {
        let config = config_of(
            bounds.maximum_message_bytes,
            bounds.pacing.map(|pacing| pacing.maximum_unsent_bytes),
        );
        let socket = WebSocketStream::from_partially_read(socket, read, role, Some(config)).await;

        Self::over(socket, bounds)
    }

    /// A connection over `socket`, its upgrade done by tungstenite under [`config_of`]'s config,
    /// within `bounds`, and what the side asks of it by.
    pub(crate) fn over(socket: WebSocketStream<S>, bounds: ConnectionBounds) -> (Self, Commands) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (ended, watched) = watch::channel(false);
        let shared = Arc::new(Shared {
            unsent: AtomicU64::new(0),
            paused: AtomicBool::new(false),
            is_ended: AtomicBool::new(false),
            dropped: Mutex::new(None),
        });
        let pacing = bounds.pacing;
        let pace = pacing.map(|pacing| {
            let unsent = Arc::downgrade(&shared);
            let late = Arc::downgrade(&shared);
            let dropping = sender.downgrade();

            SendPace::new(
                SendPaceHooks {
                    unsent: Box::new(move || {
                        unsent
                            .upgrade()
                            .map_or(0, |shared| shared.unsent.load(Ordering::SeqCst))
                    }),
                    // what waits past its deadline drops the connection, but one dropped, ended
                    // or gone already
                    late: Box::new(move || {
                        let (Some(shared), Some(sender)) = (late.upgrade(), dropping.upgrade())
                        else {
                            return;
                        };
                        {
                            let mut dropped = locked(&shared.dropped);

                            if dropped.is_some()
                                || shared.is_ended.load(Ordering::SeqCst)
                                || shared.unsent.load(Ordering::SeqCst) == 0
                            {
                                return;
                            }

                            *dropped = Some(crate::net::bounds::late_of(&pacing.pace));
                        }

                        sender.send(Command::Drop).ok();
                    }),
                },
                (pacing.pace, Arc::clone(&bounds.platform)),
            )
        });
        let commands = Commands {
            sender,
            shared: Arc::clone(&shared),
            pacing,
            pace: pace.clone(),
            ended: watched,
        };
        let connection = Self {
            socket,
            receiver,
            shared,
            pace,
            bounds,
            ended,
            queue: VecDeque::new(),
            in_flight: 0,
            writing: Writing::Idle,
            closing: Closing::No,
            peer_code: None,
            is_done: false,
            is_unheard: false,
            failure: None,
            is_ended_here: false,
            timer: None,
            timed_out: None,
        };

        (connection, commands)
    }

    /// Runs it to its end, telling `hooks` what it hears; the socket is dropped as it returns,
    /// reset when this side ended it of its own.
    pub(crate) async fn run(mut self, mut hooks: ConnectionHooks) -> Ended {
        while !self.is_done {
            let step = poll_fn(|context| self.poll_step(context)).await;

            self.take(step, &mut hooks);
        }

        self.end()
    }

    fn poll_step(&mut self, context: &mut Context<'_>) -> Poll<Step> {
        if !self.is_unheard
            && let Poll::Ready(command) = self.receiver.poll_recv(context)
        {
            return Poll::Ready(Step::Command(command));
        }

        if let Some(timed_out) = self.timed_out.as_mut()
            && Pin::new(timed_out).poll(context).is_ready()
        {
            self.timed_out = None;

            return Poll::Ready(Step::TimedOut);
        }

        if self.writing != Writing::Broken
            && let Poll::Ready(written) = self.poll_write(context)
        {
            return Poll::Ready(Step::Written(written));
        }

        match self.closing {
            Closing::Failing => {
                let mut drained = [0_u8; DRAINED_BYTES];
                let mut buffer = ReadBuf::new(&mut drained);

                match Pin::new(self.socket.get_mut()).poll_read(context, &mut buffer) {
                    Poll::Ready(Ok(())) => Poll::Ready(Step::Drained(!buffer.filled().is_empty())),
                    Poll::Ready(Err(_)) => Poll::Ready(Step::Drained(false)),
                    Poll::Pending => Poll::Pending,
                }
            }
            // * no message read while its router paused it but once this side closes, which
            // reads on to its peer's close (spec 15.12)
            Closing::No if self.shared.paused.load(Ordering::SeqCst) => Poll::Pending,
            Closing::No | Closing::ByUs => Pin::new(&mut self.socket)
                .poll_next(context)
                .map(Step::Read),
        }
    }

    // hands what waits to the socket, one message after another, and flushes it: what it flushed
    // is what the socket took
    fn poll_write(&mut self, context: &mut Context<'_>) -> Poll<Result<u64, WsError>> {
        while !self.queue.is_empty() {
            match Pin::new(&mut self.socket).poll_ready(context) {
                Poll::Ready(Ok(())) => {}
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Pending => break,
            }

            let Some((message, length)) = self.queue.pop_front() else {
                break;
            };

            self.in_flight = self.in_flight.saturating_add(length);
            self.writing = Writing::Flushing;

            if let Err(error) = Pin::new(&mut self.socket).start_send(message) {
                return Poll::Ready(Err(error));
            }
        }

        if self.writing != Writing::Flushing {
            return Poll::Pending;
        }

        Pin::new(&mut self.socket)
            .poll_flush(context)
            .map(|flushed| {
                self.writing = Writing::Idle;

                flushed.map(|()| core::mem::take(&mut self.in_flight))
            })
    }

    fn take(&mut self, step: Step, hooks: &mut ConnectionHooks) {
        match step {
            Step::Command(Some(command)) => self.command(command),
            // its side let it go: it goes, as a stop's
            Step::Command(None) => {
                self.is_unheard = true;
                self.close(GOING_AWAY);
            }
            Step::Written(Ok(taken)) => self.taken(taken),
            // * its write buffer full of pongs to a peer that reads nothing but pings: what waits
            // for its socket passed its bound (spec 15.12)
            Step::Written(Err(WsError::WriteBufferFull(_))) => {
                let held = self
                    .bounds
                    .pacing
                    .map_or(u64::MAX, |pacing| pacing.maximum_unsent_bytes);

                self.failure.get_or_insert_with(|| {
                    Failed::Dropped(format!(
                        "what waits for its socket passed maximumUnsentBytes, {held} bytes, its peer reading none of its pongs"
                    ))
                });
                self.is_ended_here = true;
                self.is_done = true;
            }
            Step::Written(Err(_)) => {
                // ! a socket that went as this went out takes nothing more: its read says the rest
                self.writing = Writing::Broken;
                let in_flight = core::mem::take(&mut self.in_flight);

                self.taken(in_flight);
                self.queue.clear();
                self.shared.unsent.store(0, Ordering::SeqCst);
            }
            Step::Read(read) => self.read(read, hooks),
            Step::Drained(true) => {}
            Step::Drained(false) => self.is_done = true,
            Step::TimedOut => {
                // ! marked before it ends: this side's own drop, no error
                self.is_ended_here = true;
                self.is_done = true;
            }
        }
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Send(bytes) => {
                let length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);

                if self.closing == Closing::No && self.writing != Writing::Broken {
                    self.queue.push_back((Message::Binary(bytes), length));
                } else {
                    self.taken(length);
                }
            }
            Command::Ping => {
                if self.closing == Closing::No && self.writing != Writing::Broken {
                    self.queue.push_back((Message::Ping(Bytes::new()), 0));
                }
            }
            Command::Close(code) => self.close(code),
            Command::Drop => {
                let why = locked(&self.shared.dropped).clone();

                if let Some(why) = why {
                    self.failure.get_or_insert(Failed::Dropped(why));
                }

                self.is_ended_here = true;
                self.is_done = true;
            }
            // its read's gate opened: its next step reads
            Command::Resume => {}
        }
    }

    // what the socket took: what waits is less
    fn taken(&self, bytes: u64) {
        if self.pace.is_some() {
            self.shared
                .unsent
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |held| {
                    Some(held.saturating_sub(bytes))
                })
                .ok();
        }
    }

    // a close sent behind what was sent before it, the peer's answer waited for within the close
    // timeout; nothing once it closes already
    fn close(&mut self, code: u16) {
        if self.closing != Closing::No {
            return;
        }

        self.closing = Closing::ByUs;
        self.queue.push_back((close_of(code), 0));
        self.arm_close_timeout();
    }

    // fails it with `code`: its close sent, what comes read raw and dropped
    fn fail(&mut self, (code, failed): (u16, Failed)) {
        self.failure.get_or_insert(failed);
        self.is_ended_here = true;

        if self.closing == Closing::No {
            self.queue.push_back((close_of(code), 0));
            self.arm_close_timeout();
        }

        self.closing = Closing::Failing;
    }

    // its close timeout armed on the platform's clock, which bounds the platform's own close
    // against a peer that does not answer; never, none
    fn arm_close_timeout(&mut self) {
        if self.bounds.close_timeout == NEVER || self.timer.is_some() {
            return;
        }

        let (woken, wait) = oneshot::channel::<()>();
        let mut woken = Some(woken);
        let armed = self.bounds.platform.arm(
            Schedule::Once(self.bounds.close_timeout),
            Box::new(move || {
                if let Some(woken) = woken.take() {
                    woken.send(()).ok();
                }
            }),
        );

        if let Ok(timer) = armed {
            self.timer = Some(timer);
            self.timed_out = Some(wait);
        }
    }

    fn read(&mut self, read: Option<Result<Message, WsError>>, hooks: &mut ConnectionHooks) {
        match read {
            Some(Ok(Message::Binary(bytes))) => {
                if self.closing == Closing::No {
                    (hooks.deliver)(bytes, false);
                }
            }
            Some(Ok(Message::Text(text))) => {
                if self.closing == Closing::No {
                    (hooks.deliver)(Bytes::from(text), true);
                }
            }
            Some(Ok(Message::Pong(_))) => (hooks.answered)(),
            // tungstenite answers it, and its close, of its own, flushed as it reads on
            Some(Ok(Message::Ping(_) | Message::Frame(_))) => {}
            // * its answer flushed by its next read, which ends it
            Some(Ok(Message::Close(frame))) => {
                if self.closing == Closing::No {
                    self.closing = Closing::ByUs;
                }

                self.peer_code = Some(frame.map_or(NO_STATUS, |frame| u16::from(frame.code)));
            }
            None
            | Some(Err(
                WsError::ConnectionClosed
                | WsError::AlreadyClosed
                | WsError::Io(_)
                | WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake),
            )) => self.is_done = true,
            Some(Err(WsError::Capacity(
                CapacityError::MessageTooLong { .. } | CapacityError::TooManyHeaders,
            ))) => {
                self.fail((TOO_BIG, Failed::TooBig(self.bounds.maximum_message_bytes)));
            }
            Some(Err(error)) => self.fail((PROTOCOL_ERROR, Failed::Protocol(error.to_string()))),
        }
    }

    // its end, told once however it went: what waits on it settles, the socket dropped, reset when
    // this side ended it of its own
    fn end(mut self) -> Ended {
        self.shared.is_ended.store(true, Ordering::SeqCst);
        self.shared.unsent.store(0, Ordering::SeqCst);
        self.receiver.close();

        if let Some(timer) = self.timer.take() {
            timer.cancel();
        }

        if let Some(pace) = &self.pace {
            pace.stop();
        }

        if self.is_ended_here {
            self.socket.get_ref().abort();
        }

        self.ended.send_replace(true);

        Ended {
            code: self.peer_code.unwrap_or(ABNORMAL),
            is_ended_here: self.is_ended_here,
            failure: self.failure,
        }
    }
}

// tungstenite's write buffer, its default: what it holds before it writes to its socket
const WRITE_BUFFER_BYTES: usize = 128 * 1024;

// a frame's longest head, a client's masked (RFC 6455 §5.2), and a control frame's longest
const FRAME_HEAD_BYTES: usize = 14;
const CONTROL_FRAME_BYTES: usize = 125 + FRAME_HEAD_BYTES;

/// What tungstenite reads a connection under: no message nor frame past `maximum_message_bytes`, no
/// frame of a client's unmasked. A server's holds unwritten no more than its write buffer, the
/// largest message `maximum_unsent_bytes` lets go, and a control frame: what it holds of the
/// side's own at most, so past it only pongs to a peer that reads nothing, which wait the last
/// alone, and a message that comes then drops the connection (spec 15.12).
pub(crate) fn config_of(
    maximum_message_bytes: u64,
    maximum_unsent_bytes: Option<u64>,
) -> WebSocketConfig {
    let maximum = usize::try_from(maximum_message_bytes).unwrap_or(usize::MAX);
    let config = WebSocketConfig::default()
        .max_message_size(Some(maximum))
        .max_frame_size(Some(maximum))
        .write_buffer_size(WRITE_BUFFER_BYTES)
        .accept_unmasked_frames(false);

    maximum_unsent_bytes.map_or(config, |unsent| {
        config.max_write_buffer_size(write_bound_of(unsent))
    })
}

// what tungstenite holds unwritten at most under `maximum_unsent_bytes`: always past its write
// buffer, as tungstenite asserts
fn write_bound_of(maximum_unsent_bytes: u64) -> usize {
    WRITE_BUFFER_BYTES
        .saturating_add(usize::try_from(maximum_unsent_bytes).unwrap_or(usize::MAX))
        .saturating_add(FRAME_HEAD_BYTES)
        .saturating_add(CONTROL_FRAME_BYTES)
}

// a close frame of `code`, no reason
fn close_of(code: u16) -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::from(code),
        reason: tungstenite::Utf8Bytes::default(),
    }))
}
