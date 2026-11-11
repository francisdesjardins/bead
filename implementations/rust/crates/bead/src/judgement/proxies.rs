//! The proxies a server believes `X-Forwarded-For` from, over HTTP or over WebSocket alike, and the
//! client's address it reads past them (spec 15.12).
//!
//! As the other sides' `trusted-proxies.ts` and `TrustedProxies.cs` read it: each proxy an IP address in the form a server listens on, or a
//! network, that address, `/` and its prefix's length (RFC 4632 §3.1, RFC 4291 §2.3), from 1, its
//! bits past the prefix zero; and as many proxies besides as it counts, those it does not name.
//! While the address reached is one they hold, or one they do not while fewer than the count were
//! passed, the next entry from the right is the client's, when it is an address in one of RFC 7239
//! §6's node forms, unquoted, its port dropped; any other entry ends the walk, as nginx's
//! `real_ip_recursive` and Express's `trust proxy` walk it. Every address so read, and the
//! socket's, is held in one form: an IPv4-mapped one as its IPv4 address (RFC 4291 §2.5.5.2), an
//! IPv6 one in RFC 5952 §4's text, hexadecimal throughout.

use core::fmt::Write as _;
use core::net::{Ipv4Addr, Ipv6Addr};

use crate::errors::ProgrammerError;
use crate::judgement::hosts::{is_ip_address, is_ipv4_address, is_ipv6_address};

#[cfg(test)]
mod tests;

/// The most proxies a server counts that `trusted_proxies` does not name (spec 15.12): past any
/// path a platform documents, a tripwire against the count of every hop.
pub const MAXIMUM_UNNAMED_PROXIES: u64 = 8;

// the bits of each family's address
const IPV4_BITS: u32 = 32;
const IPV6_BITS: u32 = 128;

// an address in its one form: an IPv4-mapped one as its IPv4 address
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Address {
    V4(u32),
    V6(u128),
}

impl Address {
    // an address RFC 3986's grammar takes, IPv4 or IPv6 with no zone; none for any other
    fn of(text: &str) -> Option<Self> {
        if is_ipv4_address(text) {
            return text
                .parse::<Ipv4Addr>()
                .ok()
                .map(|ipv4| Self::V4(ipv4.to_bits()));
        }

        if !is_ipv6_address(text) {
            return None;
        }

        text.parse::<Ipv6Addr>().ok().map(|ipv6| {
            ipv6.to_ipv4_mapped()
                .map_or_else(|| Self::V6(ipv6.to_bits()), |ipv4| Self::V4(ipv4.to_bits()))
        })
    }

    // its text: four decimal numbers, or RFC 5952 §4's
    fn text(self) -> String {
        match self {
            Self::V4(bits) => Ipv4Addr::from_bits(bits).to_string(),
            Self::V6(bits) => ipv6_text_of(bits),
        }
    }
}

// an IPv6 address as RFC 5952 §4 writes it: each group in lower-case hexadecimal without its
// leading zeros, the longest run of two zero groups or more, the first of equals, as `::`
fn ipv6_text_of(bits: u128) -> String {
    let groups = Ipv6Addr::from_bits(bits).segments();
    let mut run: Option<(usize, usize)> = None;
    let mut index = 0_usize;

    while let Some(rest) = groups.get(index..) {
        if rest.is_empty() {
            break;
        }

        let length = rest.iter().take_while(|group| **group == 0).count();

        if length > 1 && run.is_none_or(|(_, longest)| length > longest) {
            run = Some((index, length));
        }

        index = index.saturating_add(length.max(1));
    }

    let mut text = String::new();
    let mut index = 0_usize;

    while let Some(group) = groups.get(index) {
        if let Some((start, length)) = run.filter(|(start, _)| *start == index) {
            text.push_str("::");
            index = start.saturating_add(length);

            continue;
        }

        if !text.is_empty() && !text.ends_with(':') {
            text.push(':');
        }

        write!(text, "{group:x}").ok();
        index = index.saturating_add(1);
    }

    text
}

// a network: its address, and its prefix's length, from 1 to its family's bits
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Network {
    address: Address,
    prefix: u32,
}

impl Network {
    // whether it holds an address of its own family
    fn holds(self, address: Address) -> bool {
        match (self.address, address) {
            (Address::V4(network), Address::V4(held)) => (network ^ held)
                .checked_shr(IPV4_BITS.saturating_sub(self.prefix))
                .is_none_or(|differing| differing == 0),
            (Address::V6(network), Address::V6(held)) => (network ^ held)
                .checked_shr(IPV6_BITS.saturating_sub(self.prefix))
                .is_none_or(|differing| differing == 0),
            (Address::V4(_), Address::V6(_)) | (Address::V6(_), Address::V4(_)) => false,
        }
    }
}

/// The proxies a server trusts, as it is built: the networks it names, and how many proxies on
/// every path to it they do not name, which it counts.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrustedProxies {
    networks: Vec<Network>,
    unnamed: u64,
}

impl TrustedProxies {
    /// The proxies on every path to the server that the networks do not hold, `unnamed_proxies`.
    #[must_use]
    pub const fn unnamed(&self) -> u64 {
        self.unnamed
    }
}

/// How a client's address is read past its proxies, as [`client_address_of`] takes it.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct ClientAddressOptions<'a> {
    /// An `X-Forwarded-For`'s lines, joined by commas: none when the request carries none.
    pub forwarded: Option<&'a str>,
    /// The proxies the server trusts: none trusts no proxy, the loopback among them.
    pub trusted_proxies: Option<&'a TrustedProxies>,
}

// a field entry without the spaces and tabs around it (RFC 9110 §5.6.3)
fn trimmed(value: &str) -> &str {
    value.trim_matches(|character| character == ' ' || character == '\t')
}

// whether a string is a port as RFC 7239 §6 writes a node's: 1 to 5 ASCII digits
fn is_port(text: &str) -> bool {
    (1..6).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// An address in the one form a server holds it in (spec 15.12), for its bound, its handle and its
/// refusals.
///
/// An IPv4 address as written; an IPv4-mapped IPv6 address as that IPv4 address (RFC 4291
/// §2.5.5.2), in any of its forms; any other IPv6 address in the text RFC 5952 §4 recommends,
/// hexadecimal throughout, its zone, a link-local socket's, left out. One that is no address stays
/// as it came.
#[must_use]
pub fn held_address_of(address: &str) -> String {
    if is_ipv4_address(address) {
        return address.to_owned();
    }

    let bare = address.split_once('%').map_or(address, |(bare, _)| bare);

    match Address::of(bare) {
        Some(held) if is_ipv6_address(bare) => held.text(),
        Some(_) | None => address.to_owned(),
    }
}

/// The address an `X-Forwarded-For` entry names (spec 15.12), in [`held_address_of`]'s form, once
/// the spaces and tabs around it are removed.
///
/// One of RFC 7239 §6's node forms, unquoted and not obfuscated — a bare IPv4 address, or one
/// followed by `:` and a port; a bare IPv6 address without a zone, or one in brackets, followed or
/// not by `:` and a port — its port dropped. None for any other, a zone, a name, `unknown` and an
/// empty entry among them.
#[must_use]
pub fn address_of_entry(entry: &str) -> Option<String> {
    let value = trimmed(entry);

    if is_ipv4_address(value) {
        return Some(value.to_owned());
    }

    if let Some((address, port)) = value.rsplit_once(':')
        && !address.contains(':')
        && is_port(port)
    {
        return is_ipv4_address(address).then(|| address.to_owned());
    }

    // an IPv6 address in its brackets, or bare; never with a zone, which names an interface of the
    // proxy's own
    let address = match value.strip_prefix('[') {
        Some(rest) => {
            let (inner, after) = rest.split_once(']')?;

            if !(after.is_empty() || after.strip_prefix(':').is_some_and(is_port)) {
                return None;
            }

            inner
        }
        None => value,
    };

    (!address.contains('%') && is_ipv6_address(address)).then(|| held_address_of(address))
}

// an entry read as its network, or refused naming it
fn network_of(entry: &str) -> Result<Network, ProgrammerError> {
    let (text, prefix) = match entry.split_once('/') {
        Some((address, prefix))
            if prefix == "0"
                || (prefix.starts_with(|digit: char| ('1'..='9').contains(&digit))
                    && prefix.bytes().all(|byte| byte.is_ascii_digit())) =>
        {
            (address, Some(prefix))
        }
        Some(_) | None => (entry, None),
    };
    let address = Address::of(text).filter(|_| is_ip_address(text)).ok_or_else(|| {
        let hint = text
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
            .filter(|bare| !bare.is_empty() && is_ip_address(bare))
            .map_or_else(String::new, |bare| format!("; write {bare}, not {text}"));

        ProgrammerError::new(format!(
            "a trustedProxies entry is an IP address, bare, or a network, address/prefix: not {entry}{hint}"
        ))
    })?;
    let (bits, width) = match address {
        Address::V4(bits) => (u128::from(bits), IPV4_BITS),
        Address::V6(bits) => (bits, IPV6_BITS),
    };
    let Some(prefix) = prefix else {
        return Ok(Network {
            address,
            prefix: width,
        });
    };
    let length = prefix.parse::<u32>().unwrap_or(u32::MAX);

    if length == 0 {
        return Err(ProgrammerError::new(
            "trustedProxies does not take a network of prefix 0: it would trust what every client writes",
        ));
    }

    if length > width {
        return Err(ProgrammerError::new(format!(
            "a trustedProxies network's prefix is {width} bits at most: not {entry}"
        )));
    }

    let past = 1_u128
        .checked_shl(width.saturating_sub(length))
        .map_or(u128::MAX, |bit| bit.wrapping_sub(1));

    if bits & past != 0 {
        let kept = bits & !past;
        let written = match address {
            Address::V4(_) => u32::try_from(kept)
                .map(|bits| Ipv4Addr::from_bits(bits).to_string())
                .unwrap_or_default(),
            Address::V6(_) => ipv6_text_of(kept),
        };

        return Err(ProgrammerError::new(format!(
            "a trustedProxies network has no bits set past its prefix: write {written}/{prefix}, not {entry}"
        )));
    }

    Ok(Network {
        address,
        prefix: length,
    })
}

/// Refuses, with a [`ProgrammerError`] naming the entry, a `trusted_proxies` entry of no proxy.
///
/// A proxy is an IP address in the form a server listens on — bare, with no zone, not IPv4-mapped —
/// or a network, that address followed by `/` and its prefix's length (RFC 4632 §3.1, RFC 4291
/// §2.3), from 1 to its family's bits, its bits past the prefix zero; a name, which another host
/// resolves otherwise, is none. A network of prefix 0 is refused
/// besides: it would trust what every client writes.
///
/// # Errors
///
/// A [`ProgrammerError`] naming the first entry refused.
pub fn assert_trusted_proxies(entries: &[String]) -> Result<(), ProgrammerError> {
    entries
        .iter()
        .try_for_each(|entry| network_of(entry).map(drop))
}

/// Refuses, with a [`ProgrammerError`] naming it, an `unnamed_proxies` past
/// [`MAXIMUM_UNNAMED_PROXIES`]: the count of every hop, which would trust what every client writes,
/// among them.
///
/// # Errors
///
/// A [`ProgrammerError`] for a count past 8.
pub fn assert_unnamed_proxies(count: u64) -> Result<(), ProgrammerError> {
    if count > MAXIMUM_UNNAMED_PROXIES {
        return Err(ProgrammerError::new(format!(
            "unnamedProxies is a whole number of proxies from 0 to {MAXIMUM_UNNAMED_PROXIES}, those trustedProxies does not name: not {count}"
        )));
    }

    Ok(())
}

/// The proxies a server trusts, from `entries` once [`assert_trusted_proxies`] took them, and
/// `unnamed_proxies` once [`assert_unnamed_proxies`] took it, 0 when none. None trusts no proxy,
/// the loopback among them.
///
/// # Errors
///
/// A [`ProgrammerError`] naming an entry or a count refused.
pub fn trusted_proxies_of(
    entries: &[String],
    unnamed_proxies: Option<u64>,
) -> Result<TrustedProxies, ProgrammerError> {
    let networks = entries
        .iter()
        .map(|entry| network_of(entry))
        .collect::<Result<Vec<Network>, ProgrammerError>>()?;
    let unnamed = unnamed_proxies.unwrap_or(0);

    assert_unnamed_proxies(unnamed)?;

    Ok(TrustedProxies { networks, unnamed })
}

/// A client's address (spec 15.12).
///
/// Its socket's, `remote`, in [`held_address_of`]'s form; then, while the address reached is one
/// the trusted proxies name, or one they do not while fewer than their unnamed such addresses were
/// passed, which then counts it, the next entry of `forwarded`, an `X-Forwarded-For`'s lines
/// joined, read from the right, while it is an address ([`address_of_entry`]): an entry that is
/// none, or the field's end, ends the walk where it is. A named proxy costs none of the count,
/// wherever it stands. A client cannot move it: what it wrote left of the first address past the
/// count that no proxy named holds is never read.
#[must_use]
pub fn client_address_of(remote: &str, options: &ClientAddressOptions<'_>) -> String {
    let mut client = held_address_of(remote);
    let mut unnamed = options.trusted_proxies.map_or(0, TrustedProxies::unnamed);
    let is_named = |address: &str| {
        options.trusted_proxies.is_some_and(|trusted| {
            Address::of(address).is_some_and(|address| {
                trusted
                    .networks
                    .iter()
                    .any(|network| network.holds(address))
            })
        })
    };

    for entry in options.forwarded.map_or_else(Vec::new, |forwarded| {
        forwarded.rsplit(',').collect::<Vec<&str>>()
    }) {
        // * an address no proxy named holds spends one of the count, and ends the walk past it
        if !is_named(&client) {
            if unnamed == 0 {
                break;
            }

            unnamed = unnamed.saturating_sub(1);
        }

        let Some(next) = address_of_entry(entry) else {
            break;
        };

        client = next;
    }

    client
}
