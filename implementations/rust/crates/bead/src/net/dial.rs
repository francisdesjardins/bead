//! A client's socket, dialled: its host's addresses raced (RFC 8305), then TLS where it is secured
//! (RFC 8446), as a WebSocket client and a broker adapter both open theirs.

use core::pin::Pin;
use core::task::{Context, Poll};
use std::io;
use std::sync::Arc;

use rustls::ClientConfig;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;

use crate::net::racing::{RacingOptions, connect_racing};
use crate::net::tls::connect_tls;

#[cfg(test)]
mod tests;

/// A client's socket: in the clear, or under TLS.
#[derive(Debug)]
pub(crate) enum ClientSocket {
    /// In the clear.
    Plain(TcpStream),
    /// Under TLS.
    Secured(Box<TlsStream<TcpStream>>),
}

impl ClientSocket {
    /// Readies its drop: once dropped, its peer is reset rather than ended, `SO_LINGER` 0.
    #[cfg(feature = "websocket")]
    pub(crate) fn reset_on_drop(&self) {
        let socket = match self {
            Self::Plain(socket) => socket,
            Self::Secured(socket) => socket.get_ref().0,
        };

        // a socket that takes no linger is dropped as it would be
        socket2::SockRef::from(socket)
            .set_linger(Some(core::time::Duration::ZERO))
            .ok();
    }
}

impl AsyncRead for ClientSocket {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(socket) => Pin::new(socket).poll_read(context, buffer),
            Self::Secured(socket) => Pin::new(socket.as_mut()).poll_read(context, buffer),
        }
    }
}

impl AsyncWrite for ClientSocket {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(socket) => Pin::new(socket).poll_write(context, bytes),
            Self::Secured(socket) => Pin::new(socket.as_mut()).poll_write(context, bytes),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(socket) => Pin::new(socket).poll_flush(context),
            Self::Secured(socket) => Pin::new(socket.as_mut()).poll_flush(context),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(socket) => Pin::new(socket).poll_shutdown(context),
            Self::Secured(socket) => Pin::new(socket.as_mut()).poll_shutdown(context),
        }
    }
}

/// A socket to `host`, bare, a name in ASCII or an IP address, and `port`: its addresses raced as
/// `racing` says, then under TLS by `tls` where it is given, in the clear otherwise.
///
/// # Errors
///
/// What the race or the TLS handshake failed with.
pub(crate) async fn dial(
    (host, port): (&str, u16),
    (racing, tls): (&RacingOptions, Option<&Arc<ClientConfig>>),
) -> io::Result<ClientSocket> {
    let socket = connect_racing((host, port), racing).await?;

    match tls {
        Some(config) => Ok(ClientSocket::Secured(Box::new(
            connect_tls((socket, host), config).await?,
        ))),
        None => Ok(ClientSocket::Plain(socket)),
    }
}
