//! A socket closed in stages once the answer written on it ends (RFC 9112 §9.6), as the other
//! sides' `lingerOn` and Kestrel close one: its write side shut, then what still comes read and
//! dropped until its client closes, or [`LINGER`] passes on the platform's clock, which bounds the
//! platform's own close; closing it at once would reset a client still sending, and may erase the
//! answer it has not read yet.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;

use crate::clock::{Schedule, SharedClock};
use crate::net::bounds::LINGER;
use crate::transport::first_of;

#[cfg(test)]
mod tests;

// what a lingering socket reads at once, and drops
const DRAINED_BYTES: usize = 4_096;

/// Closes `socket` in stages on `clock`, the platform's: its write side shut, then what comes read
/// and dropped until its client ends it, it fails, or [`LINGER`] passes; settles once it may be
/// dropped.
pub(crate) async fn close_in_stages<S>(mut socket: S, clock: &SharedClock)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // a socket that takes no shutdown is gone already
    if socket.shutdown().await.is_err() {
        return;
    }

    let (woken, wait) = oneshot::channel::<()>();
    let mut woken = Some(woken);
    // a clock that arms no timer lingers until its client ends the socket
    let timer = clock
        .arm(
            Schedule::Once(LINGER),
            Box::new(move || {
                if let Some(woken) = woken.take() {
                    woken.send(()).ok();
                }
            }),
        )
        .ok();
    let draining = async {
        let mut drained = [0_u8; DRAINED_BYTES];

        while matches!(socket.read(&mut drained).await, Ok(read) if read > 0) {}
    };

    first_of((draining, wait)).await;

    if let Some(timer) = timer {
        timer.cancel();
    }
}
