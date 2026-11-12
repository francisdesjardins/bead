//! An MQTT 5 link's network connection (spec 15.25): its broker's URL read — `mqtt`, `mqtts`, `ws`
//! or `wss` — its socket dialled over the core's socket layer, its addresses raced, under TLS where
//! it is secured, and a WebSocket of subprotocol `mqtt` over it where the URL says so; then its two
//! halves, one a task reads, one a task writes, and what resets it at once.

use core::time::Duration;
use std::io;
use std::sync::Arc;

use bytes::{Bytes, BytesMut};
use futures_util::stream::{SplitSink, SplitStream};
use rustls::ClientConfig;
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio_tungstenite::WebSocketStream;
use tungstenite::Message;

use crate::judgement::security::is_secure;
use crate::net::dial::{ClientSocket, dial};
use crate::net::racing::{RacingOptions, host_of};
use crate::net::tls::{http1_config_of, platform_client_config};

// what a read takes from its socket at most at once
const READ_BYTES: usize = 65_536;

/// A broker's scheme (spec 15.25): MQTT over TCP, or under TLS, or over a WebSocket, or a secure one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scheme {
    Mqtt,
    Mqtts,
    Ws,
    Wss,
}

impl Scheme {
    /// Whether its connection is under TLS.
    pub(crate) const fn is_tls(self) -> bool {
        matches!(self, Self::Mqtts | Self::Wss)
    }

    /// Whether it carries its packets over a WebSocket.
    pub(crate) const fn is_websocket(self) -> bool {
        matches!(self, Self::Ws | Self::Wss)
    }

    // the port its URL names when it names none: IANA's for MQTT, RFC 6455's for a WebSocket
    const fn port(self) -> u16 {
        match self {
            Self::Mqtt => 1_883,
            Self::Mqtts => 8_883,
            Self::Ws => 80,
            Self::Wss => 443,
        }
    }
}

/// A broker's address, as its URL names it.
#[derive(Debug, Clone)]
pub(crate) struct Address {
    pub(crate) scheme: Scheme,
    /// Its host as a URL writes it, an IPv6 address bracketed.
    pub(crate) host: String,
    /// Its host bare, what is resolved or connected to.
    pub(crate) bare: String,
    pub(crate) port: u16,
    /// Its path and query, over a WebSocket: `/` when none.
    pub(crate) path: String,
}

impl Address {
    /// Whether its leg is secure: under TLS, or to the loopback (spec 15.22).
    pub(crate) fn is_secure(&self) -> bool {
        is_secure(self.scheme.is_tls(), Some(&self.host))
    }
}

/// The address `url` names: `mqtt://`, `mqtts://`, `ws://` or `wss://`, a host, and a port where
/// not its scheme's; none for any other, or one that names a user.
pub(crate) fn address_of(url: &str) -> Option<Address> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = match scheme.to_ascii_lowercase().as_str() {
        "mqtt" => Scheme::Mqtt,
        "mqtts" => Scheme::Mqtts,
        "ws" => Scheme::Ws,
        "wss" => Scheme::Wss,
        _ => return None,
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at_checked(end)?;

    if authority.is_empty() || authority.contains('@') {
        return None;
    }

    let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let (inner, after) = bracketed.split_once(']')?;
        // * after an IP literal, its port or the authority's end alone (RFC 3986 §3.2.2, §3.2.3)
        let port = if after.is_empty() {
            None
        } else {
            Some(after.strip_prefix(':')?)
        };

        (format!("[{inner}]"), port)
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host.to_owned(), Some(port)),
            None => (authority.to_owned(), None),
        }
    };
    let port = match port {
        None | Some("") => scheme.port(),
        Some(port) => port.parse::<u16>().ok().filter(|port| *port != 0)?,
    };
    let (host, bare) = host_of(&host).ok()?;
    let path = path.split('#').next().unwrap_or_default();
    let path = if path.is_empty() {
        "/".to_owned()
    } else if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("/{path}")
    };

    Some(Address {
        scheme,
        host,
        bare,
        port,
        path,
    })
}

/// What a link's network connection is read by.
pub(crate) enum Reader {
    Stream(ReadHalf<ClientSocket>),
    WebSocket(SplitStream<WebSocketStream<ClientSocket>>),
}

/// What a link's network connection is written by.
pub(crate) enum Writer {
    Stream(WriteHalf<ClientSocket>),
    WebSocket(SplitSink<WebSocketStream<ClientSocket>, Message>),
}

/// A link's network connection, open: its halves, and what resets it at once.
pub(crate) struct Opened {
    pub(crate) reader: Reader,
    pub(crate) writer: Writer,
    /// A handle on its socket, which readies it to be reset once its halves are dropped.
    pub(crate) resetter: Option<socket2::Socket>,
}

impl Reader {
    /// The next bytes its broker sent; none once its connection ended cleanly.
    pub(crate) async fn next(&mut self) -> io::Result<Option<Bytes>> {
        match self {
            Self::Stream(reader) => {
                let mut buffer = BytesMut::with_capacity(READ_BYTES);
                let read = reader.read_buf(&mut buffer).await?;

                Ok((read > 0).then(|| buffer.freeze()))
            }
            Self::WebSocket(reader) => crate::mqtt::websocket::next(reader).await,
        }
    }
}

impl Writer {
    /// Writes one packet: over a WebSocket, one binary message, one frame (spec 15.25).
    pub(crate) async fn send(&mut self, packet: Vec<u8>) -> io::Result<()> {
        match self {
            Self::Stream(writer) => {
                writer.write_all(&packet).await?;
                writer.flush().await
            }
            Self::WebSocket(writer) => crate::mqtt::websocket::send(writer, packet).await,
        }
    }

    /// Ends its side of the connection once what was written went: over a WebSocket, its close.
    pub(crate) async fn close(&mut self) {
        match self {
            Self::Stream(writer) => {
                writer.shutdown().await.ok();
            }
            Self::WebSocket(writer) => crate::mqtt::websocket::close(writer).await,
        }
    }
}

/// Readies `opened`'s socket to be reset, `SO_LINGER` 0, as a link ended with no clean end is: once
/// its halves are dropped, its broker reads a reset.
pub(crate) fn ready_reset(resetter: Option<&socket2::Socket>) {
    if let Some(resetter) = resetter {
        resetter.set_linger(Some(Duration::ZERO)).ok();
    }
}

// a handle on the TCP socket under `socket`, which shares its options
fn resetter_of(socket: &ClientSocket) -> Option<socket2::Socket> {
    let tcp = match socket {
        ClientSocket::Plain(tcp) => tcp,
        ClientSocket::Secured(tls) => tls.get_ref().0,
    };

    socket2::SockRef::from(tcp).try_clone().ok()
}

/// How a link's network connection is opened: its race, its TLS and the largest message it reads.
pub(crate) struct OpenOptions<'options> {
    pub(crate) racing: &'options RacingOptions,
    pub(crate) tls: Option<&'options Arc<ClientConfig>>,
    pub(crate) maximum_packet_size: u32,
}

/// A link's network connection to `address`, open: over TCP, under TLS for `mqtts` and `wss`, and a
/// WebSocket of subprotocol `mqtt` for `ws` and `wss`.
pub(crate) async fn open(address: &Address, options: &OpenOptions<'_>) -> io::Result<Opened> {
    let tls = if address.scheme.is_tls() {
        let config = match (address.scheme, options.tls) {
            // * a WebSocket's upgrade speaks HTTP/1.1, which its ALPN offers alone
            (Scheme::Wss, given) => http1_config_of(given).map_err(io::Error::other)?,
            (_, Some(given)) => Arc::clone(given),
            (_, None) => Arc::new(platform_client_config().map_err(io::Error::other)?),
        };

        Some(config)
    } else {
        None
    };
    let socket = dial(
        (&address.bare, address.port),
        (options.racing, tls.as_ref()),
    )
    .await?;
    let resetter = resetter_of(&socket);

    if address.scheme.is_websocket() {
        let (writer, reader) =
            crate::mqtt::websocket::open((address, socket), options.maximum_packet_size).await?;

        return Ok(Opened {
            reader: Reader::WebSocket(reader),
            writer: Writer::WebSocket(writer),
            resetter,
        });
    }

    let (reader, writer) = tokio::io::split(socket);

    Ok(Opened {
        reader: Reader::Stream(reader),
        writer: Writer::Stream(writer),
        resetter,
    })
}
