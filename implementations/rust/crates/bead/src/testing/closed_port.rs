//! A port nothing listens on, held for as long as a test keeps it, as the TypeScript side's
//! `closedPort` and the C# side's `ClosedPort` are: a socket bound on `127.0.0.1` and one on `::1`,
//! where this machine has it, both on the same port and neither listening, so that a connect to
//! either is refused. Bound without `SO_REUSEADDR`, they keep any other bind of that port off
//! meanwhile, a draw or a bind by its number.

use std::io;
#[cfg(any(feature = "websocket", feature = "http"))]
use std::net::IpAddr;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};

#[cfg(any(feature = "websocket", feature = "http"))]
use std::sync::Arc;

use socket2::{Domain, Protocol, Socket, Type};

#[cfg(any(feature = "websocket", feature = "http"))]
use crate::net::loopbacks::is_in_use;
#[cfg(any(feature = "websocket", feature = "http"))]
use crate::router::types::{BoxFuture, RouterError};
#[cfg(any(feature = "websocket", feature = "http"))]
use crate::transport::{TransportServerAddress, TransportServerStartOptions};

// ! a port let go before its connect is one another test's listener may take in the meantime, and
// a connect then reaches it: keep this alive across the connect, never only its number
/// The port, refused at both loopbacks while it lives.
pub(crate) struct ClosedPort {
    port: u16,
    held: Vec<Socket>,
}

impl ClosedPort {
    /// The port.
    pub(crate) const fn port(&self) -> u16 {
        self.port
    }
}

fn bound(address: SocketAddr) -> io::Result<Socket> {
    let socket = Socket::new(
        Domain::for_address(address),
        Type::STREAM,
        Some(Protocol::TCP),
    )?;

    // * no SO_REUSEADDR: another socket's bind to the port fails while it is held
    socket.bind(&address.into())?;

    Ok(socket)
}

/// A port bound on `127.0.0.1`, and on `::1` where this machine has it, and listened on by neither.
pub(crate) fn closed_port() -> io::Result<ClosedPort> {
    loop {
        let ipv4 = bound(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
        let port = ipv4
            .local_addr()?
            .as_socket()
            .ok_or_else(|| io::Error::other("no socket address"))?
            .port();

        match bound(SocketAddr::from((Ipv6Addr::LOCALHOST, port))) {
            Ok(ipv6) => {
                return Ok(ClosedPort {
                    port,
                    held: vec![ipv4, ipv6],
                });
            }
            // * taken on ::1 already: another port
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {}
            // * a machine without the IPv6 loopback refuses its connect there all the same
            Err(_) => {
                return Ok(ClosedPort {
                    port,
                    held: vec![ipv4],
                });
            }
        }
    }
}

/// A port drawn free on both loopbacks and held on `loopback` alone: a listener of the other family
/// alone takes it there, and a connect to this one is refused.
#[cfg(any(feature = "websocket", feature = "http"))]
pub(crate) fn closed_port_on(loopback: IpAddr) -> io::Result<ClosedPort> {
    let mut closed = closed_port()?;

    closed.held.retain(|socket| {
        socket
            .local_addr()
            .ok()
            .and_then(|address| address.as_socket())
            .is_some_and(|address| address.ip() == loopback)
    });

    Ok(closed)
}

// ! a draw of port 0 gives a port free on its own family only, which another test's listener may
// hold on the other loopback. A localhost name's connect tries the IPv4 one first and reaches that
// listener
/// Starts a server by `start` on the loopback `address` alone, on a port drawn free on both
/// loopbacks, and gives that port held on the other one until dropped, as the C# side's
/// `StartedAloneOn` and the TypeScript side's `startedAloneOn` do: drawn again where another socket
/// took it between.
#[cfg(any(feature = "websocket", feature = "http"))]
pub(crate) async fn started_alone_on<F>(start: F, address: &str) -> Result<ClosedPort, RouterError>
where
    F: Fn(&TransportServerStartOptions) -> BoxFuture<Result<TransportServerAddress, RouterError>>,
{
    let other = if address == "::1" {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        IpAddr::V6(Ipv6Addr::LOCALHOST)
    };

    let mut attempt = 0_u32;

    loop {
        let held = closed_port_on(other).map_err(|error| RouterError::Other(Arc::new(error)))?;

        match start(&TransportServerStartOptions {
            address: Some(address.to_owned()),
            port: Some(held.port),
            ..TransportServerStartOptions::default()
        })
        .await
        {
            Ok(_) => return Ok(held),
            // * taken on the loopback given: another draw
            Err(RouterError::Other(error))
                if attempt < 64 && error.downcast_ref::<io::Error>().is_some_and(is_in_use) =>
            {
                attempt = attempt.saturating_add(1);
            }
            Err(error) => return Err(error),
        }
    }
}
