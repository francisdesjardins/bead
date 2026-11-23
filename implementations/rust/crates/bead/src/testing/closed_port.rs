//! A port nothing listens on, held for as long as a test keeps it, as the TypeScript side's
//! `closedPort` and the C# side's `ClosedPort` are: a socket bound on `127.0.0.1` and one on `::1`,
//! where this machine has it, both on the same port and neither listening, so that a connect to
//! either is refused and no other test's listener is given that port meanwhile.

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};

use socket2::{Domain, Protocol, Socket, Type};

// ! a port let go before its connect is one another test's listener may take in the meantime, and
// a connect then reaches it: keep this alive across the connect, never only its number
/// The port, refused at both loopbacks while it lives.
pub(crate) struct ClosedPort {
    port: u16,
    _held: Vec<Socket>,
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
                    _held: vec![ipv4, ipv6],
                });
            }
            // * taken on ::1 already: another port
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {}
            // * a machine without the IPv6 loopback refuses its connect there all the same
            Err(_) => {
                return Ok(ClosedPort {
                    port,
                    _held: vec![ipv4],
                });
            }
        }
    }
}
