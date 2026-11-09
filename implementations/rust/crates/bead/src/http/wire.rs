//! hyper's glue (decision 0049): a connection served by hyper's HTTP/1.1, its head bounded by
//! `headers_timeout` on hyper's timer, the platform's; driven without its shutdown, so that the
//! transport ends its socket itself: a head that did not come in time answered 408, a socket whose
//! answer went before its request's body was whole closed in stages, any other let go. Under TLS,
//! its handshake first, within `headers_timeout` on the platform's clock, then HTTP/2 or HTTP/1.1 as
//! ALPN chose (RFC 7301), HTTP/2 by hyper's, its streams spawned through the platform; a request
//! HTTP refuses of its own resets its stream there, `PROTOCOL_ERROR`, writing nothing. An answer's
//! body is the transport's own, whole or handed on as it comes, cut where the transport cuts it.

use core::error::Error;
use core::fmt;
use core::future::{Future, poll_fn};
use core::pin::{Pin, pin};
use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use core::task::{Context, Poll};
use core::time::Duration;
use std::io;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::server::conn::{http1, http2};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use rustls::ServerConfig;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;

use crate::clock::{HyperTimer, Schedule, SharedClock};
use crate::judgement::head::{MAXIMUM_HEAD_BYTES, MAXIMUM_HEAD_FIELDS};
use crate::net::bounds::{LINGER, SendPace};
use crate::net::linger::close_in_stages;
use crate::net::listening::{unless_cancelled, unmarked, within};
use crate::net::tls::H2;
use crate::platform::{self, Handle};
use crate::router::types::BoxFuture;

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
    is_http2: AtomicBool,
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
    /// Whether its socket serves an HTTP/2 session.
    pub(crate) fn is_http2(&self) -> bool {
        self.is_http2.load(Ordering::SeqCst)
    }

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

/// What a response HTTP answers of its own carries, 400 unmarked over HTTP/1: over HTTP/2 its
/// stream is reset instead, `PROTOCOL_ERROR`, nothing written (RFC 9113 §8.1.1).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Malformed;

/// How a socket's connection is served: on which runtime, its head bounded by `headers_timeout`
/// on the platform's clock, which bounds its linger and its TLS handshake too; under `tls` when
/// given, in clear otherwise.
pub(crate) struct WireOptions {
    pub(crate) runtime: Handle,
    pub(crate) platform: SharedClock,
    pub(crate) headers_timeout: Duration,
    pub(crate) tls: Option<Arc<ServerConfig>>,
}

/// What an exchange is given: the request hyper read, and its connection's flow.
pub(crate) trait Exchange:
    Fn(Request<Incoming>, &Arc<Flow>) -> Answered + Send + Sync + Unpin + 'static
{
}

impl<F> Exchange for F where
    F: Fn(Request<Incoming>, &Arc<Flow>) -> Answered + Send + Sync + Unpin + 'static
{
}

// hyper's executor over the platform: each HTTP/2 stream spawned on the server's runtime
#[derive(Clone)]
struct Spawner {
    runtime: Handle,
}

impl<F> hyper::rt::Executor<F> for Spawner
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    fn execute(&self, future: F) {
        drop(platform::spawn(&self.runtime, future));
    }
}

/// Serves `socket` as `options` says, each request handed to `exchange` with its connection's
/// flow, until its client ends it, hyper fails it, or its flow's stop: in clear by hyper's
/// HTTP/1.1; under TLS, once its handshake is done within `headers_timeout`, by HTTP/2 or HTTP/1.1
/// as ALPN chose. A socket whose handshake does not end in time, or fails, is closed without a word.
pub(crate) async fn serve<F: Exchange>(
    (socket, flow): (TcpStream, Arc<Flow>),
    (options, exchange): (WireOptions, F),
) {
    socket.set_nodelay(true).ok();

    let watched = Watched {
        socket,
        flow: Arc::clone(&flow),
    };
    let Some(config) = options.tls.clone() else {
        let served: BoxFuture<()> = Box::pin(serve_http1((watched, flow), (options, exchange)));

        return served.await;
    };
    // * hyper's head timer arms only once hyper reads: the handshake has a deadline of its own
    let accepted = unless_cancelled(
        &flow.stop,
        within(
            &options.platform,
            (
                options.headers_timeout,
                TlsAcceptor::from(config).accept(watched),
            ),
        ),
    )
    .await;
    let Some(Some(Ok(secured))) = accepted else {
        return;
    };

    // * each served as a future of its own, its socket's type named
    let served: BoxFuture<()> = if secured.get_ref().1.alpn_protocol() == Some(H2) {
        flow.is_http2.store(true, Ordering::SeqCst);
        Box::pin(serve_http2((secured, flow), (options, exchange)))
    } else {
        Box::pin(serve_http1((secured, flow), (options, exchange)))
    };

    served.await;
}

// a socket's connection served by hyper's HTTP/1.1
async fn serve_http1<S, F>((socket, flow): (S, Arc<Flow>), (options, exchange): (WireOptions, F))
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    F: Exchange,
{
    let WireOptions {
        runtime,
        platform,
        headers_timeout,
        ..
    } = options;
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
        TokioIo::new(socket),
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
    let mut socket = parts.io.into_inner();

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

/// What ends an HTTP/2 stream the transport ends itself: a reset of its reason, which hyper finds
/// as this error's source.
#[derive(Debug)]
pub(crate) struct Reset(h2::Error);

impl fmt::Display for Reset {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "the stream is reset: {}", self.0)
    }
}

impl Error for Reset {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&self.0)
    }
}

// what hyper is given of an exchange over HTTP/2: a response HTTP answers of its own resets its
// stream instead, `PROTOCOL_ERROR`, nothing written; a cut resets it, as its socket would be cut
fn reset_of(answered: Result<Response<AnswerBody>, Cut>) -> Result<Response<AnswerBody>, Reset> {
    match answered {
        Ok(response) if response.extensions().get::<Malformed>().is_some() => {
            Err(Reset(h2::Reason::PROTOCOL_ERROR.into()))
        }
        Ok(response) => Ok(response),
        Err(Cut) => Err(Reset(h2::Reason::INTERNAL_ERROR.into())),
    }
}

// a session served by hyper's HTTP/2, its streams spawned through the platform; its server's stop
// tells it so, GOAWAY, and ends it once what it answers went, or within its linger when it
// answers nothing
async fn serve_http2<S, F>((socket, flow): (S, Arc<Flow>), (options, exchange): (WireOptions, F))
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    F: Exchange,
{
    let WireOptions {
        runtime, platform, ..
    } = options;
    let serving = Arc::clone(&flow);
    let mut builder = http2::Builder::new(Spawner {
        runtime: runtime.clone(),
    });

    builder
        .timer(HyperTimer::on(runtime))
        .max_header_list_size(u32::try_from(MAXIMUM_HEAD_BYTES).unwrap_or(u32::MAX));

    let mut connection = pin!(builder.serve_connection(
        TokioIo::new(socket),
        service_fn(move |request: Request<Incoming>| {
            serving.head_read();

            let answered = exchange(request, &serving);
            let streamed: BoxFuture<Result<Response<AnswerBody>, Reset>> =
                Box::pin(async move { reset_of(answered.await) });

            streamed
        }),
    ));

    if unless_cancelled(
        &flow.stop,
        poll_fn(|context| connection.as_mut().poll(context)),
    )
    .await
    .is_none()
        && !flow.abort.is_cancelled()
    {
        // its end once aborted, or past its linger when it answers nothing
        let ended = flow.abort.child_token();
        let lingering = (!flow.is_answering())
            .then(|| {
                let ending = ended.clone();

                platform
                    .arm(Schedule::Once(LINGER), Box::new(move || ending.cancel()))
                    .ok()
            })
            .flatten();

        connection.as_mut().graceful_shutdown();
        unless_cancelled(&ended, poll_fn(|context| connection.as_mut().poll(context))).await;

        if let Some(timer) = lingering {
            timer.cancel();
        }
    }

    flow.stop_paces();
}
