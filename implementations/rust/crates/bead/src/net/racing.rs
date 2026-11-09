//! A connect by a name that races its addresses, as RFC 8305 (Happy Eyeballs v2) asks and as Node's
//! clients, the browsers and the C# side's `HappyEyeballs` do: the name resolved in the platform's
//! order (RFC 6724), the address families interleaved, the first family the first answer's (§4);
//! an attempt started every 250 milliseconds on the platform's clock, or at once when one fails,
//! until one connects (§5); the first connected kept, and the attempts left dropped, a socket one of
//! them connects after closed with it. A connect that tries each address in turn waits out the
//! refusal of a loopback family a server does not listen on, two seconds on Windows, before it
//! tries the other.

use core::fmt;
use core::future::Future;
use core::future::poll_fn;
use core::task::Poll;
use core::time::Duration;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use tokio::net::TcpStream;
use tokio::sync::oneshot;

use crate::clock::{Schedule, SharedClock};
use crate::router::types::BoxFuture;

#[cfg(test)]
mod tests;

/// How long an attempt goes unanswered before the next starts: RFC 8305 §5's default.
pub(crate) const ATTEMPT_DELAY: Duration = Duration::from_millis(250);

/// What answers a name with its addresses, in the platform's order.
pub(crate) type Resolve = Arc<dyn Fn(String) -> BoxFuture<io::Result<Vec<IpAddr>>> + Send + Sync>;

/// What makes one attempt at an address, a connected socket or a failure, given up once dropped.
pub(crate) type Attempt = Arc<dyn Fn(SocketAddr) -> BoxFuture<io::Result<TcpStream>> + Send + Sync>;

/// How a race resolves, connects and waits.
#[derive(Clone)]
pub(crate) struct RacingOptions {
    /// The platform's clock, which the delay between attempts runs on.
    pub(crate) clock: SharedClock,
    /// How long an attempt goes unanswered before the next starts: [`ATTEMPT_DELAY`].
    pub(crate) attempt_delay: Duration,
    /// What answers a name: the platform's resolver when none.
    pub(crate) resolve: Option<Resolve>,
    /// What makes an attempt: a TCP socket of its own when none. The tests' way to watch the race.
    pub(crate) attempt: Option<Attempt>,
}

impl fmt::Debug for RacingOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RacingOptions")
            .field("attempt_delay", &self.attempt_delay)
            .finish_non_exhaustive()
    }
}

impl RacingOptions {
    /// A race on `clock`, the platform's, every other option its default.
    pub(crate) fn on(clock: SharedClock) -> Self {
        Self {
            clock,
            attempt_delay: ATTEMPT_DELAY,
            resolve: None,
            attempt: None,
        }
    }
}

// the addresses in the order they are tried: the first answer's family first, then the families in
// turn, each in its own order (RFC 8305 §4)
fn interleaved(addresses: &[IpAddr]) -> Vec<IpAddr> {
    let Some(first) = addresses.first() else {
        return Vec::new();
    };
    let is_first_family = |address: &&IpAddr| address.is_ipv4() == first.is_ipv4();
    let mut preferred = addresses.iter().filter(is_first_family);
    let mut other = addresses.iter().filter(|address| !is_first_family(address));
    let mut ordered = Vec::with_capacity(addresses.len());

    loop {
        let (one, two) = (preferred.next(), other.next());

        if one.is_none() && two.is_none() {
            return ordered;
        }

        ordered.extend(one.into_iter().chain(two).copied());
    }
}

// the platform's resolver: the name's addresses, in the order it gives them
async fn resolved(host: String) -> io::Result<Vec<IpAddr>> {
    Ok(tokio::net::lookup_host((host.as_str(), 0))
        .await?
        .map(|address| address.ip())
        .collect())
}

// one attempt at an address, on a socket of its own, which goes with a failure
async fn attempted(address: SocketAddr) -> io::Result<TcpStream> {
    let socket = TcpStream::connect(address).await?;

    socket.set_nodelay(true)?;

    Ok(socket)
}

/// Connects to `host`, an IP address, bracketed or not, or a name in ASCII, and `port`: the name
/// resolved and its addresses raced; the socket of the first attempt that connects.
///
/// # Errors
///
/// When every attempt fails, the last failure; a name that resolves to none,
/// [`io::ErrorKind::NotFound`].
pub(crate) async fn connect_racing(
    (host, port): (&str, u16),
    options: &RacingOptions,
) -> io::Result<TcpStream> {
    let bare = host
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host);
    let found = match bare.parse::<IpAddr>() {
        Ok(literal) => vec![literal],
        Err(_name) => match &options.resolve {
            Some(resolve) => resolve(bare.to_owned()).await?,
            None => resolved(bare.to_owned()).await?,
        },
    };
    let addresses = interleaved(&found);
    let mut attempts = FuturesUnordered::new();
    let mut next = addresses.iter();
    let mut failure: Option<io::Error> = None;

    loop {
        if let Some(address) = next.next() {
            let at = SocketAddr::new(*address, port);

            attempts.push(match &options.attempt {
                Some(attempt) => attempt(at),
                None => Box::pin(attempted(at)),
            });
        }

        if attempts.is_empty() {
            break;
        }

        // the next attempt's wait, armed only while an address is left to try
        let delay = (next.len() > 0)
            .then(|| {
                let (woken, wait) = oneshot::channel::<()>();
                let mut woken = Some(woken);

                options
                    .clock
                    .arm(
                        Schedule::Once(options.attempt_delay),
                        Box::new(move || {
                            if let Some(woken) = woken.take() {
                                woken.send(()).ok();
                            }
                        }),
                    )
                    .ok()
                    .map(|timer| (timer, wait))
            })
            .flatten();
        let mut waiting = delay.map(|(timer, wait)| (timer, Box::pin(wait)));
        let settled = poll_fn(|context| {
            if let Poll::Ready(Some(settled)) = attempts.poll_next_unpin(context) {
                return Poll::Ready(Some(settled));
            }

            if let Some((_, wait)) = waiting.as_mut()
                && wait.as_mut().poll(context).is_ready()
            {
                return Poll::Ready(None);
            }

            Poll::Pending
        })
        .await;

        if let Some((timer, _)) = waiting {
            timer.cancel();
        }

        match settled {
            Some(Ok(socket)) => return Ok(socket),
            // * a failure starts the next attempt at once, not its delay after it
            Some(Err(error)) => failure = Some(error),
            None => {}
        }
    }

    Err(failure.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("{host} resolves to no address"),
        )
    }))
}
