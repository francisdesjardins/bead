//! hyper's glue (decision 0049): a connection served by hyper's HTTP/1.1, its head bounded by
//! `headers_timeout` on hyper's timer, the platform's; driven without its shutdown, so that the
//! transport ends its socket itself: a head that did not come in time answered 408, a socket whose
//! answer went before its request's body was whole closed in stages, any other let go. An answer's
//! body is the transport's own, whole or handed on as it comes, cut where the transport cuts it.

use core::error::Error;
use core::fmt;
use core::future::{Future, poll_fn};
use core::pin::Pin;
use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use core::task::{Context, Poll};
use core::time::Duration;
use std::io;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::clock::{HyperTimer, SharedClock};
use crate::judgement::head::{MAXIMUM_HEAD_BYTES, MAXIMUM_HEAD_FIELDS};
use crate::net::bounds::SendPace;
use crate::net::linger::close_in_stages;
use crate::net::listening::{unless_cancelled, unmarked};
use crate::platform::Handle;

/// What an exchange's socket is cut with: an answer's body ended before its end, or an exchange
/// whose socket the transport drops before its head.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Cut;

impl fmt::Display for Cut {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the exchange is cut")
    }
}

impl Error for Cut {}

/// What one socket's connection holds that its exchanges and its end read: whether its socket
/// still holds what was written to it, whether an answer went before its request's body was whole,
/// and the heads read and the answers begun.
#[derive(Debug, Default)]
pub(crate) struct Flow {
    blocked: AtomicBool,
    lingers: AtomicBool,
    heads: AtomicU64,
    answered: AtomicU64,
    settled: AtomicU64,
    stop: CancellationToken,
    abort: CancellationToken,
    // the paces its answers are held to, each until it judges nothing waits
    paces: Mutex<Vec<SendPace>>,
}

impl Flow {
    /// Whether its socket held the last bytes written to it, unwritten.
    pub(crate) fn is_blocked(&self) -> bool {
        self.blocked.load(Ordering::SeqCst)
    }

    /// An answer went before its request's body was whole: its socket closes in stages once its
    /// connection ends.
    pub(crate) fn linger(&self) {
        self.lingers.store(true, Ordering::SeqCst);
    }

    /// A request's head read.
    pub(crate) fn head_read(&self) {
        self.heads.fetch_add(1, Ordering::SeqCst);
    }

    /// An answer begun, its head handed to hyper.
    pub(crate) fn answer_begun(&self) {
        self.answered.fetch_add(1, Ordering::SeqCst);
    }

    /// Its connection ends once what it serves ended, or at once when it serves nothing: its
    /// server stops.
    pub(crate) fn stop(&self) {
        self.stop.cancel();
    }

    /// Its connection ends at once, its socket let go: an answer it could not write is lost.
    pub(crate) fn abort(&self) {
        self.abort.cancel();
        self.stop.cancel();
    }

    /// Holds `pace` until its connection ends, or it judges nothing waits.
    pub(crate) fn pace(&self, pace: SendPace) {
        let mut paces = self.paces.lock().unwrap_or_else(PoisonError::into_inner);

        paces.retain(SendPace::is_running);
        paces.push(pace);
    }

    fn stop_paces(&self) {
        let paces =
            core::mem::take(&mut *self.paces.lock().unwrap_or_else(PoisonError::into_inner));

        for pace in paces {
            pace.stop();
        }
    }

    // * a head read whose answer hyper has not let go of yet: one handed to it, unwritten, among
    // them
    fn is_answering(&self) -> bool {
        self.heads.load(Ordering::SeqCst) > self.settled.load(Ordering::SeqCst)
    }
}

// a socket whose writes its flow watches
struct Watched {
    socket: TcpStream,
    flow: Arc<Flow>,
}

impl Watched {
    // what a write gave: a socket that takes nothing is blocked until it takes again
    fn watched<T>(&self, poll: Poll<io::Result<T>>) -> Poll<io::Result<T>> {
        self.flow.blocked.store(poll.is_pending(), Ordering::SeqCst);

        poll
    }
}

impl AsyncRead for Watched {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().socket).poll_read(context, buffer)
    }
}

impl AsyncWrite for Watched {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.socket).poll_write(context, buffer);

        this.watched(poll)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.socket).poll_write_vectored(context, buffers);

        this.watched(poll)
    }

    fn is_write_vectored(&self) -> bool {
        self.socket.is_write_vectored()
    }

    // a socket's flush holds nothing of its own, and says nothing of what it holds
    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().socket).poll_flush(context)
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().socket).poll_shutdown(context)
    }
}

// ! what a body hands hyper at once: a platform's socket may take a whole answer in one write,
// whatever its client reads, which would hide its pace
const PIECE_BYTES: usize = 65_536;

/// The next piece of `bytes`, [`PIECE_BYTES`] at most, none left once the last is taken.
pub(crate) fn piece_of(bytes: &mut Option<Bytes>) -> Option<Bytes> {
    match bytes {
        Some(rest) if rest.len() > PIECE_BYTES => Some(rest.split_to(PIECE_BYTES)),
        _ => bytes.take(),
    }
}

/// What a streamed answer's body is handed, piece by piece.
#[derive(Debug)]
pub(crate) enum Piece {
    /// Its bytes.
    Data(Bytes),
    /// Its end: whole.
    End,
}

/// What an answer's body tells as hyper lets it go: whether it was taken whole.
pub(crate) type Closed = Box<dyn FnOnce(bool) + Send>;

// what an answer carries
enum Carried {
    Whole(Option<Bytes>),
    // * a sender dropped before its end cuts the exchange
    Streamed(mpsc::UnboundedReceiver<Piece>),
}

/// An answer's body, whole or streamed, telling once whether hyper took it whole.
pub(crate) struct AnswerBody {
    carried: Carried,
    is_whole: bool,
    closed: Option<Closed>,
    // the flow it settles as hyper lets it go
    flow: Option<Arc<Flow>>,
}

impl fmt::Debug for AnswerBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AnswerBody")
            .field("is_whole", &self.is_whole)
            .finish_non_exhaustive()
    }
}

impl AnswerBody {
    /// A body of `bytes`, none when empty.
    pub(crate) fn whole(bytes: Option<Bytes>) -> Self {
        let bytes = bytes.filter(|bytes| !bytes.is_empty());

        Self {
            // an empty one hyper never polls
            is_whole: bytes.is_none(),
            carried: Carried::Whole(bytes),
            closed: None,
            flow: None,
        }
    }

    /// A body handed on as it comes, and what hands it on.
    pub(crate) fn streamed() -> (Self, mpsc::UnboundedSender<Piece>) {
        let (sender, receiver) = mpsc::unbounded_channel();

        (
            Self {
                carried: Carried::Streamed(receiver),
                is_whole: false,
                closed: None,
                flow: None,
            },
            sender,
        )
    }

    /// Itself, settling `flow` as hyper lets it go.
    pub(crate) fn settling(mut self, flow: &Arc<Flow>) -> Self {
        self.flow = Some(Arc::clone(flow));
        self
    }

    /// Itself, telling `closed` whether it was taken whole once hyper lets it go.
    pub(crate) fn telling(mut self, closed: Closed) -> Self {
        self.closed = Some(closed);
        self
    }

    fn ended(&mut self) {
        self.is_whole = true;

        if let Some(closed) = self.closed.take() {
            closed(true);
        }
    }
}

impl Drop for AnswerBody {
    fn drop(&mut self) {
        if let Some(flow) = self.flow.take() {
            flow.settled.fetch_add(1, Ordering::SeqCst);
        }

        if let Some(closed) = self.closed.take() {
            closed(self.is_whole);
        }
    }
}

impl Body for AnswerBody {
    type Data = Bytes;
    type Error = Cut;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Cut>>> {
        let this = self.get_mut();
        let polled = match &mut this.carried {
            // * a whole body is taken whole as hyper takes its last piece, which it may never poll
            // past
            Carried::Whole(bytes) => {
                let piece = piece_of(bytes);

                if bytes.is_none() {
                    this.ended();
                }

                return Poll::Ready(piece.map(|piece| Ok(Frame::data(piece))));
            }
            Carried::Streamed(receiver) => receiver.poll_recv(context),
        };

        match polled {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(Piece::Data(bytes))) => Poll::Ready(Some(Ok(Frame::data(bytes)))),
            Poll::Ready(Some(Piece::End)) => {
                this.ended();

                Poll::Ready(None)
            }
            Poll::Ready(None) => Poll::Ready(Some(Err(Cut))),
        }
    }

    fn is_end_stream(&self) -> bool {
        matches!(self.carried, Carried::Whole(None))
    }

    fn size_hint(&self) -> SizeHint {
        match &self.carried {
            Carried::Whole(bytes) => SizeHint::with_exact(
                bytes
                    .as_ref()
                    .map_or(0, |bytes| u64::try_from(bytes.len()).unwrap_or(u64::MAX)),
            ),
            Carried::Streamed(_) => SizeHint::default(),
        }
    }
}

/// A response of `status`, its `fields` in their order, carrying `body`.
pub(crate) fn response_of(
    status: u16,
    (fields, body): (&[(&str, String)], AnswerBody),
) -> Response<AnswerBody> {
    let mut response = Response::new(body);

    *response.status_mut() =
        ::http::StatusCode::from_u16(status).unwrap_or(::http::StatusCode::INTERNAL_SERVER_ERROR);

    for (name, value) in fields {
        if let (Ok(name), Ok(value)) = (
            ::http::header::HeaderName::from_bytes(name.as_bytes()),
            ::http::HeaderValue::from_str(value),
        ) {
            response.headers_mut().append(name, value);
        }
    }

    response
}

/// What an exchange's future gives hyper: its response, or a cut, which ends its socket with
/// nothing written.
pub(crate) type Answered = Pin<Box<dyn Future<Output = Result<Response<AnswerBody>, Cut>> + Send>>;

/// How a socket's connection is served: on which runtime, its head bounded by `headers_timeout`
/// on the platform's clock, which bounds its linger too.
pub(crate) struct WireOptions {
    pub(crate) runtime: Handle,
    pub(crate) platform: SharedClock,
    pub(crate) headers_timeout: Duration,
}

/// Serves `socket` by hyper's HTTP/1.1 as `options` says, each request handed to `exchange` with
/// its connection's flow, until its client ends it, hyper fails it, or its flow's stop.
pub(crate) async fn serve<F>(
    (socket, flow): (TcpStream, Arc<Flow>),
    (options, exchange): (WireOptions, F),
) where
    F: Fn(Request<Incoming>, &Arc<Flow>) -> Answered + Send + Sync + Unpin + 'static,
{
    socket.set_nodelay(true).ok();

    let WireOptions {
        runtime,
        platform,
        headers_timeout,
    } = options;
    let watched = Watched {
        socket,
        flow: Arc::clone(&flow),
    };
    let serving = Arc::clone(&flow);
    let mut builder = http1::Builder::new();

    // ! a header read timeout is always set, on a timer of Bead's: hyper panics at one without a
    // timer, and arms 30 s by default
    builder
        .timer(HyperTimer::on(runtime))
        .header_read_timeout(Some(headers_timeout))
        .max_header_size(MAXIMUM_HEAD_BYTES)
        .max_headers(MAXIMUM_HEAD_FIELDS)
        .keep_alive(true);

    let mut connection = builder.serve_connection(
        TokioIo::new(watched),
        service_fn(move |request: Request<Incoming>| {
            serving.head_read();
            exchange(request, &serving)
        }),
    );
    let stopped = unless_cancelled(
        &flow.stop,
        poll_fn(|context| connection.poll_without_shutdown(context)),
    )
    .await;
    let outcome = match stopped {
        Some(outcome) => outcome,
        // * its server stopped: a connection answering ends once its answers went, any other at
        // once, as one aborted
        None if flow.is_answering() && !flow.abort.is_cancelled() => {
            Pin::new(&mut connection).graceful_shutdown();

            let ended = unless_cancelled(
                &flow.abort,
                poll_fn(|context| connection.poll_without_shutdown(context)),
            )
            .await;

            match ended {
                Some(outcome) => outcome,
                None => return flow.stop_paces(),
            }
        }
        None => return flow.stop_paces(),
    };

    flow.stop_paces();

    let parts = connection.into_parts();
    let has_read = !parts.read_buf.is_empty();
    let mut socket = parts.io.into_inner().socket;

    match outcome {
        // a head that did not come within its timeout, on a connection that answered none or with
        // a head under way, answered 408, unmarked, telling nothing (spec 15.12); a kept-alive one
        // gone idle let go without a word
        Err(error)
            if error.is_timeout() && (flow.answered.load(Ordering::SeqCst) == 0 || has_read) =>
        {
            if socket.write_all(unmarked(408).as_bytes()).await.is_ok() {
                close_in_stages(socket, &platform).await;
            }
        }
        // what hyper refused of its own, 400 or 431, it answered already
        Err(error) if error.is_parse() => close_in_stages(socket, &platform).await,
        _ if flow.lingers.load(Ordering::SeqCst) => close_in_stages(socket, &platform).await,
        _ => {}
    }
}
