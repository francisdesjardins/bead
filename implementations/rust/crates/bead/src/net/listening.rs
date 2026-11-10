//! What a server over a socket does alike before its protocol speaks (decision 0049): it binds
//! where its start says, `localhost`'s two loopbacks or one IP address, accepts what comes there
//! until its stop, bounds a wait by a timeout on a clock or a token's cancel, and writes the answers
//! HTTP gives of its own, a head and no body.

use core::future::{Future, poll_fn};
use core::pin::pin;
use core::task::Poll;
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
            &LoopbackBinding::new(port, find_open_port),
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

/// Accepts what comes to `listener` on `runtime` until its stop, each socket handed to `take` with
/// whether its listener still serves, which gives false once its server is gone.
pub(crate) fn accepting<F>(runtime: &Handle, (listener, take): (TcpListener, F)) -> Listening
where
    F: Fn((TcpStream, SocketAddr), &Arc<AtomicBool>) -> bool + Send + 'static,
{
    let serving = Arc::new(AtomicBool::new(true));
    let stop = CancellationToken::new();
    let accepted_serving = Arc::clone(&serving);
    let accepted_stop = stop.clone();
    let task = platform::spawn(runtime, async move {
        while let Some(accepted) = unless_cancelled(&accepted_stop, listener.accept()).await {
            match accepted {
                Ok((socket, peer)) => {
                    if !take((socket, peer), &accepted_serving) {
                        return;
                    }
                }
                // a socket gone before it was taken, or the system short of descriptors: the next
                // is taken in a later turn
                Err(_) => platform::yield_now().await,
            }
        }
    });

    Listening {
        serving,
        stop,
        task,
    }
}
