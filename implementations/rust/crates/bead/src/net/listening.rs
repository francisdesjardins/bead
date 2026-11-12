//! What a server over a socket does alike before its protocol speaks (decision 0049): it binds
//! where its start says, `localhost`'s two loopbacks or one IP address, accepts what comes there
//! until its stop, bounds a wait by a timeout on a clock or a token's cancel, and writes the answers
//! HTTP gives of its own, a head and no body.

use core::future::{Future, poll_fn};
use core::pin::pin;
use core::task::{Context, Poll};
use core::time::Duration;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::clock::{Schedule, SharedClock};
use crate::errors::{ProgrammerError, TransportError};
use crate::judgement::handshake::AnswerField;
use crate::judgement::hosts::assert_listening_address;
use crate::net::loopbacks::{LOCALHOST, LoopbackBinding, bind_loopbacks, listener_on};
use crate::platform::{self, Handle, JoinHandle};
use crate::router::types::{BoxFuture, RouterError};
use crate::transport::{TransportServerAddress, TransportServerStartOptions};

#[cfg(test)]
mod tests;

// the port a start names none of listens on, HTTP's
const PORT: u16 = 80;

/// What an io error stands for, as a start reports it.
pub(crate) fn io_error(error: io::Error) -> RouterError {
    RouterError::Other(Arc::new(error))
}

/// What an application's misuse stands for, as a start reports it.
pub(crate) fn misuse(error: ProgrammerError) -> RouterError {
    RouterError::Other(Arc::new(error))
}

/// `future`'s output, or none once `token` is cancelled first.
pub(crate) async fn unless_cancelled<F: Future>(
    token: &CancellationToken,
    future: F,
) -> Option<F::Output> {
    let mut cancelled = pin!(token.cancelled());
    let mut future = pin!(future);

    poll_fn(|context| {
        if cancelled.as_mut().poll(context).is_ready() {
            return Poll::Ready(None);
        }

        future.as_mut().poll(context).map(Some)
    })
    .await
}

/// `future`'s output, or none once `timeout` passed on `clock` first.
pub(crate) async fn within<F: Future>(
    clock: &SharedClock,
    (timeout, future): (Duration, F),
) -> Option<F::Output> {
    let (woken, wait) = oneshot::channel::<()>();
    let mut woken = Some(woken);
    let timer = clock
        .arm(
            Schedule::Once(timeout),
            Box::new(move || {
                if let Some(woken) = woken.take() {
                    woken.send(()).ok();
                }
            }),
        )
        .ok();
    let mut wait = pin!(wait);
    let mut future = pin!(future);
    let outcome = poll_fn(|context| {
        if let Poll::Ready(output) = future.as_mut().poll(context) {
            return Poll::Ready(Some(output));
        }

        // a clock that arms no timer waits without end
        if timer.is_some() && wait.as_mut().poll(context).is_ready() {
            return Poll::Ready(None);
        }

        Poll::Pending
    })
    .await;

    if let Some(timer) = timer {
        timer.cancel();
    }

    outcome
}

/// An answer's head: its status line, its date when it has one, then `fields` in their order.
pub(crate) fn answer_of(status: u16, (date, fields): (Option<String>, &[AnswerField])) -> String {
    let reason = ::http::StatusCode::from_u16(status)
        .ok()
        .and_then(|code| code.canonical_reason())
        .unwrap_or_default();
    let mut answer = format!("HTTP/1.1 {status} {reason}\r\n");

    if let Some(date) = date {
        answer.push_str("date: ");
        answer.push_str(&date);
        answer.push_str("\r\n");
    }

    for field in fields {
        answer.push_str(field.name);
        answer.push_str(": ");
        answer.push_str(field.value);
        answer.push_str("\r\n");
    }

    answer.push_str("\r\n");
    answer
}

/// What HTTP answers of its own, unmarked, its connection closed: a head past its bounds, one that
/// does not read, or one that did not come within its timeout.
pub(crate) fn unmarked(status: u16) -> String {
    answer_of(
        status,
        (
            None,
            &[
                AnswerField {
                    name: "connection",
                    value: "close",
                },
                AnswerField {
                    name: "content-length",
                    value: "0",
                },
            ],
        ),
    )
}

/// One address a server listens on: whether that listener still serves what comes, and its
/// accepting, which its stop ends.
pub(crate) struct Listening {
    pub(crate) serving: Arc<AtomicBool>,
    stop: CancellationToken,
    task: JoinHandle<()>,
}

impl Listening {
    /// Its listener lets go: nothing more is served, and its accepting ends.
    pub(crate) fn let_go(&self) {
        self.serving.store(false, Ordering::SeqCst);
        self.stop.cancel();
    }

    /// Settles once its accepting ended.
    pub(crate) fn ended(self) -> BoxFuture<()> {
        Box::pin(async move {
            self.task.await.ok();
        })
    }
}

/// What a server's start bound: each listener, and where it listens.
pub(crate) struct Bound {
    pub(crate) listeners: Vec<TcpListener>,
    pub(crate) address: TransportServerAddress,
}

/// Binds where `options` says, on `runtime`: `localhost`'s two loopbacks on one port, or one IP
/// address written bare (spec 15.12).
///
/// # Errors
///
/// A [`ProgrammerError`] for an address that is no bare IP address nor `localhost`; a start its
/// signal gave up; what the platform refuses the bind with.
pub(crate) fn bind(
    runtime: &Handle,
    options: &TransportServerStartOptions,
) -> Result<Bound, RouterError> {
    bind_with_loopback(
        runtime,
        (
            options,
            &LoopbackBinding::new(
                options.port.unwrap_or(PORT),
                options.find_open_port.unwrap_or(false),
            ),
        ),
    )
}

/// Binds a server with the loopback binding its tests supply.
pub(crate) fn bind_with_loopback(
    runtime: &Handle,
    (options, binding): (&TransportServerStartOptions, &LoopbackBinding),
) -> Result<Bound, RouterError> {
    let address = options
        .address
        .clone()
        .unwrap_or_else(|| LOCALHOST.to_owned());

    assert_listening_address(&address).map_err(misuse)?;

    if options
        .signal
        .as_ref()
        .is_some_and(CancellationToken::is_cancelled)
    {
        return Err(RouterError::Other(Arc::new(TransportError::cancelled(
            "the start was cancelled",
        ))));
    }

    let port = options.port.unwrap_or(PORT);
    let find_open_port = options.find_open_port.unwrap_or(false);
    let (bound, reported) = if address == LOCALHOST {
        let bound = bind_loopbacks(
            |addresses: &[IpAddr], port| {
                addresses
                    .iter()
                    .map(|address| listener_on(*address, port))
                    .collect::<io::Result<Vec<_>>>()
            },
            binding,
        )
        .map_err(io_error)?;

        (bound.started, bound.address.to_owned())
    } else {
        let ip: IpAddr = address.parse().map_err(|_unparsed| {
            misuse(ProgrammerError::new(format!(
                "a server listens on an IP address, or on localhost, not \"{address}\""
            )))
        })?;
        let listener = listener_on(ip, if find_open_port { 0 } else { port }).map_err(io_error)?;

        (vec![listener], address)
    };
    let port = bound
        .first()
        .map(std::net::TcpListener::local_addr)
        .transpose()
        .map_err(io_error)?
        .map_or(port, |local| local.port());
    let _entered = runtime.enter();
    let listeners = bound
        .into_iter()
        .map(TcpListener::from_std)
        .collect::<io::Result<Vec<_>>>()
        .map_err(io_error)?;

    Ok(Bound {
        listeners,
        address: TransportServerAddress::new(reported, port),
    })
}

/// What a server accepts its sockets from: its listener, or a test's.
pub(crate) trait Accept: Send + 'static {
    /// What it accepts.
    type Socket: Send + 'static;

    /// The next socket accepted, and its peer's address; or why none was.
    fn poll_accept(
        &mut self,
        context: &mut Context<'_>,
    ) -> Poll<io::Result<(Self::Socket, SocketAddr)>>;
}

impl Accept for TcpListener {
    type Socket = TcpStream;

    fn poll_accept(
        &mut self,
        context: &mut Context<'_>,
    ) -> Poll<io::Result<(TcpStream, SocketAddr)>> {
        Self::poll_accept(self, context)
    }
}

/// How long accepting pauses after a failure that is not of one connection: a second, as hyper's
/// and axum's servers pause.
pub(crate) const ACCEPT_PAUSE: Duration = Duration::from_secs(1);

/// What accepting takes: where it accepts, what it hands each socket to, the clock it pauses on and
/// what it reports a failure to.
pub(crate) struct Acceptance<A: Accept, F> {
    /// Where it accepts.
    pub(crate) listener: A,
    /// What it hands each socket to, with whether its listener still serves; false once its
    /// server is gone, which ends it.
    pub(crate) take: F,
    /// The platform's clock, which its pause runs on.
    pub(crate) platform: SharedClock,
    /// What it reports the first failure of a run to, its server's errors.
    pub(crate) report: Box<dyn Fn(io::Error) + Send>,
}

// whether a failed accept is one connection's, gone before it was taken: the next is taken at once
fn is_of_one_connection(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionRefused
            | io::ErrorKind::Interrupted
    )
}

// pauses `pause` on `clock`, or a turn when it arms no timer; true once `stop` ended it first
async fn paused(clock: &SharedClock, (pause, stop): (Duration, &CancellationToken)) -> bool {
    let (woken, wait) = oneshot::channel::<()>();
    let mut woken = Some(woken);
    let Ok(timer) = clock.arm(
        Schedule::Once(pause),
        Box::new(move || {
            if let Some(woken) = woken.take() {
                woken.send(()).ok();
            }
        }),
    ) else {
        platform::yield_now().await;

        return stop.is_cancelled();
    };
    let stopped = unless_cancelled(stop, wait).await.is_none();

    timer.cancel();

    stopped
}

/// Accepts what comes to its listener on `runtime` until its stop, each socket handed to its
/// `take`. A failure of one connection, gone before it was taken, accepts again at once; any
/// other, the process short of descriptors say, pauses [`ACCEPT_PAUSE`] on the platform's clock
/// before the next, the first of a run reported.
pub(crate) fn accepting<A, F>(runtime: &Handle, acceptance: Acceptance<A, F>) -> Listening
where
    A: Accept,
    F: Fn((A::Socket, SocketAddr), &Arc<AtomicBool>) -> bool + Send + 'static,
{
    let Acceptance {
        mut listener,
        take,
        platform: clock,
        report,
    } = acceptance;
    let serving = Arc::new(AtomicBool::new(true));
    let stop = CancellationToken::new();
    let accepted_serving = Arc::clone(&serving);
    let accepted_stop = stop.clone();
    let task = platform::spawn(runtime, async move {
        let mut is_failing = false;

        while let Some(accepted) = unless_cancelled(
            &accepted_stop,
            poll_fn(|context| listener.poll_accept(context)),
        )
        .await
        {
            match accepted {
                Ok((socket, peer)) => {
                    is_failing = false;

                    if !take((socket, peer), &accepted_serving) {
                        return;
                    }
                }
                Err(error) if is_of_one_connection(&error) => platform::yield_now().await,
                // ! never accepted again at once: a failure of the process' own fails the next
                // too, and would spin its thread
                Err(error) => {
                    if !is_failing {
                        is_failing = true;
                        report(error);
                    }

                    if paused(&clock, (ACCEPT_PAUSE, &accepted_stop)).await {
                        return;
                    }
                }
            }
        }
    });

    Listening {
        serving,
        stop,
        task,
    }
}
