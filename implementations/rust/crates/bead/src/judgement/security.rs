//! Whether a transport is secure (spec 13.4).
//!
//! Judged by what it is given, never by what a name resolves to: under TLS, its scheme `wss` or `https`; or on the loopback — a client by the host it
//! names, as the WHATWG URL Standard's host parser reads it, `localhost` or a name that ends in
//! `.localhost`, compared in ASCII lower case, an IPv4 address in 127.0.0.0/8, or `::1`, as the
//! W3C's Secure Contexts judges an origin potentially trustworthy; a server by the address it
//! listens on, an IP address written bare (spec 15.12), in 127.0.0.0/8 or `::1`, which that parser
//! reads alike. Any other leaves the machine in the clear, which a bearer credential never crosses
//! (RFC 6750 §5.3). As the other sides' `secure.ts` and `TransportSecurity.cs` judge it.

use crate::judgement::url_host::url_host_of;

#[cfg(test)]
mod tests;

/// Whether a host is on the loopback as the URL Standard's host parser reads it.
///
/// An IPv6 one is bracketed first when it is bare. On the loopback: `localhost`, a name that ends in `.localhost`, an IPv4 address
/// in 127.0.0.0/8, `127.0.0.1.` and `127.1` among them, or `::1`; never `localhost.`, which the
/// parser keeps as given, nor a host it fails on, one followed by a space among them, nor an IPv4
/// address mapped into IPv6, which no origin names so.
#[must_use]
pub fn is_loopback_host(host: &str) -> bool {
    let bracketed = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let Some(parsed) = url_host_of(&bracketed) else {
        return false;
    };
    let parts: Vec<&str> = parsed.split('.').collect();
    let is_ipv4 = parts.len() == 4
        && parts.iter().all(|part| {
            (1..=3).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_digit())
        });

    parsed == "localhost"
        || parsed.ends_with(".localhost")
        || parsed == "[::1]"
        || (is_ipv4 && parts.first() == Some(&"127"))
}

/// Whether a transport given these is secure: under TLS, or its host on the loopback.
#[must_use]
pub fn is_secure(is_tls: bool, host: Option<&str>) -> bool {
    is_tls || host.is_some_and(is_loopback_host)
}
