//! How a server binds `localhost`, as each transport server does alike (spec 15.12), as the other
//! sides' `listenOn` and `Loopbacks` bind it: the IPv4 loopback, `127.0.0.1`, first, on the port it
//! is given or on one drawn there, then the IPv6 one, `::1`, on that port, taking no IPv4 there. A
//! port another socket holds on either fails the start; a port drawn is drawn again, at most
//! [`MAXIMUM_DRAWS`] times. Where the IPv6 loopback is absent, its bind refused for want of the
//! address or of the family, it listens on `127.0.0.1` alone and reports it.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};

use socket2::{Domain, Protocol, Socket, Type};

#[cfg(test)]
mod tests;

/// The name an address takes besides an IP literal: both loopbacks, never resolved.
pub(crate) const LOCALHOST: &str = "localhost";

/// The most ports a start on `localhost` draws before it fails with the last one's error.
pub(crate) const MAXIMUM_DRAWS: u32 = 8;

// the backlog a listener keeps, as Node's does
const BACKLOG: i32 = 511;

// what the platform names a family it does not offer: WSAEAFNOSUPPORT on Windows, EAFNOSUPPORT
// elsewhere, which std reads as no kind of its own
const FAMILY_NOT_SUPPORTED: i32 = if cfg!(windows) {
    10_047
} else if cfg!(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd"
)) {
    47
} else {
    97
};

/// What draws a port free on the IPv4 loopback.
pub(crate) type DrawPort = Box<dyn Fn() -> io::Result<u16> + Send + Sync>;

/// What refuses the IPv6 loopback's bind on a port in place of the platform: the tests' way to
/// start where it is absent, or where another socket holds a port drawn.
pub(crate) type Ipv6Refusal = Box<dyn Fn(u16) -> Option<io::Error> + Send + Sync>;

/// Where a start on `localhost` binds, and the tests' ways into it.
pub(crate) struct LoopbackBinding {
    /// The port it is given, when it draws none.
    pub(crate) port: u16,
    /// Whether it draws a port free on the IPv4 loopback.
    pub(crate) find_open_port: bool,
    /// What draws a port: [`draw_port`], but in a test.
    pub(crate) draw_port: DrawPort,
    /// What refuses the IPv6 loopback's bind on a port, in place of the platform; none, the
    /// platform binds it.
    pub(crate) ipv6_refusal: Option<Ipv6Refusal>,
}

impl LoopbackBinding {
    /// A binding on `port`, or on one the platform draws when `find_open_port`.
    pub(crate) fn new(port: u16, find_open_port: bool) -> Self {
        Self {
            port,
            find_open_port,
            draw_port: Box::new(draw_port),
            ipv6_refusal: None,
        }
    }
}

/// What a bind on `localhost` started, and the address it reports: `localhost`, or `127.0.0.1`
/// where the IPv6 loopback is absent.
#[derive(Debug)]
pub(crate) struct LoopbacksBound<T> {
    pub(crate) started: T,
    pub(crate) address: &'static str,
}

/// A port free on the IPv4 loopback, as the system draws one: a socket bound there to port 0, then
/// closed.
///
/// # Errors
///
/// What the platform refuses the bind with.
pub(crate) fn draw_port() -> io::Result<u16> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;

    socket.bind(&SocketAddr::from((Ipv4Addr::LOCALHOST, 0)).into())?;
    socket
        .local_addr()?
        .as_socket()
        .map(|address| address.port())
        .ok_or_else(|| io::Error::other("a socket bound on the IPv4 loopback names no port"))
}

/// Whether a bind failed on a port another socket holds.
pub(crate) fn is_in_use(reason: &io::Error) -> bool {
    reason.kind() == io::ErrorKind::AddrInUse
}

/// Whether a bind failed for want of its address or of its family: the IPv6 loopback absent, as in
/// a container with IPv6 off, or a kernel without IPv6.
pub(crate) fn is_absent(reason: &io::Error) -> bool {
    reason.kind() == io::ErrorKind::AddrNotAvailable
        || reason.raw_os_error() == Some(FAMILY_NOT_SUPPORTED)
}

/// A listener bound on `address` and `port`, as a server's is: the IPv6 loopback takes no IPv4, and on
/// Unix an address the last listener left in `TIME_WAIT` is taken again, as Node's is; never on
/// Windows, where that would let another socket take a port in use.
///
/// # Errors
///
/// What the platform refuses the bind with.
pub(crate) fn listener_on(address: IpAddr, port: u16) -> io::Result<TcpListener> {
    let domain = if address.is_ipv6() {
        Domain::IPV6
    } else {
        Domain::IPV4
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;

    // * the IPv6 loopback takes no IPv4, which the IPv4 loopback's own socket takes; every IPv6
    // interface, `::`, takes IPv4 too, as Node's and Kestrel's do
    if address.is_ipv6() {
        socket.set_only_v6(!address.is_unspecified())?;
    }

    if cfg!(unix) {
        socket.set_reuse_address(true)?;
    }

    socket.bind(&SocketAddr::new(address, port).into())?;
    socket.listen(BACKLOG)?;
    socket.set_nonblocking(true)?;

    Ok(socket.into())
}

/// Binds `localhost` by `listen`, which starts a server on the addresses and the port it is handed
/// and lets go of what it built when it fails: both loopbacks, or, where the IPv6 one is absent,
/// `127.0.0.1` alone. Gives what it started and the address it reports.
///
/// # Errors
///
/// What the last bind failed with: a port another socket holds on either loopback, given or drawn
/// [`MAXIMUM_DRAWS`] times; or anything else the platform refuses.
pub(crate) fn bind_loopbacks<T, L>(
    mut listen: L,
    binding: &LoopbackBinding,
) -> io::Result<LoopbacksBound<T>>
where
    L: FnMut(&[IpAddr], u16) -> io::Result<T>,
{
    let mut draw = 1_u32;

    loop {
        let port = if binding.find_open_port {
            (binding.draw_port)()?
        } else {
            binding.port
        };
        let refused = binding
            .ipv6_refusal
            .as_ref()
            .and_then(|refusal| refusal(port));
        let bound = refused.map_or_else(
            || {
                listen(
                    &[
                        IpAddr::V4(Ipv4Addr::LOCALHOST),
                        IpAddr::V6(Ipv6Addr::LOCALHOST),
                    ],
                    port,
                )
            },
            Err,
        );

        match bound {
            Ok(started) => {
                return Ok(LoopbacksBound {
                    started,
                    address: LOCALHOST,
                });
            }
            // ! no process can take ::1 where there is none, so the IPv4 loopback alone leaves no
            // capture; a port taken there is never this, and fails the start
            Err(reason) if is_absent(&reason) => {
                return listen(&[IpAddr::V4(Ipv4Addr::LOCALHOST)], port).map(|started| {
                    LoopbacksBound {
                        started,
                        address: "127.0.0.1",
                    }
                });
            }
            // a port drawn on IPv4 that another socket holds on IPv6, or that another took between
            // the draw and the bind: drawn again
            Err(reason) if binding.find_open_port && draw < MAXIMUM_DRAWS && is_in_use(&reason) => {
                draw = draw.saturating_add(1);
            }
            Err(reason) => return Err(reason),
        }
    }
}
