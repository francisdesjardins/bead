//! The hosts and origins a server takes a request from, over HTTP as on a WebSocket's upgrade
//! (spec 15.2, 15.12).
//!
//! What it reads of a request's target, its fields and its credential besides, as the other sides'
//! `hosts-and-origins.ts` and `HostsAndOrigins.cs` read them.
//!
//! A request names its authority by its target in absolute-form, else by its `Host`; an authority
//! is a host and an optional port, of 15.12's grammar, a restriction of RFC 3986 §3.2.2. Its host,
//! the port aside, is taken when every server takes it — `localhost`, a name under `.localhost`, an
//! IPv6 address in brackets, an IPv4 address — or when the server's hosts list it, compared ASCII
//! case-insensitively (RFC 9110 §4.2.3); [`EVERY_HOST`] takes every host, and makes none of their
//! origins its own. A request with no `Origin`, or one from its own origin, by a host it takes by
//! name, or from one among those it takes, is taken. An origin is read as the serialized origin the
//! field carries (RFC 6454 §6.2), compared as a string, never parsed as a URL.

use core::net::Ipv6Addr;

use crate::errors::ProgrammerError;

#[cfg(test)]
mod tests;

/// The refusal of a request that names a host the server does not take (spec 15.12).
pub const HOST_REFUSAL: &str = "host-refused";

/// The refusal of a request whose `Origin` is neither the server's own nor among those it takes.
pub const ORIGIN_REFUSAL: &str = "origin-refused";

/// The `hosts` entry that takes every host, an empty one and none, alone in its list, and makes
/// none of their origins its own (spec 15.12).
pub const EVERY_HOST: &str = "*";

// the localhost names' own domain (RFC 6761 §6.3)
const LOCALHOST: &str = "localhost";

// the characters a name holds besides letters and digits: RFC 3986's unreserved, and the
// sub-delims no HTTP server refuses (spec 15.12)
const NAME_MARKS: &[u8] = b"-._~!$&'()";

// the visible characters a URI leaves out that a page's browser always percent-encodes where they
// stand (spec 15.12): in a path, the URL Standard's path percent-encode set; in a query, its query
// percent-encode set, which leaves ^, `, { and } as they came; both hold #, which no form of a
// request-target carries (RFC 9112 §3.2)
const ENCODED_IN_PATH: &[char] = &['"', '#', '<', '>', '^', '`', '{', '}'];
const ENCODED_IN_QUERY: &[char] = &['"', '#', '<', '>'];

// the schemes whose origin a browser serializes with its host in lower case and its default port
// left out (RFC 6454 §6.2; the URL Standard's special schemes)
const DEFAULT_PORTS: &[(&str, u32)] = &[("http", 80), ("https", 443), ("ws", 80), ("wss", 443)];

/// A request's target as HTTP reads it (RFC 9112 §3.2): its authority when it is in absolute-form,
/// its path, and its query, the text after its first `?`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct RequestTarget<'a> {
    /// The authority an absolute-form target names, as it came; none in origin-form.
    pub authority: Option<&'a str>,
    /// Its path, as it came: `/` when an absolute-form target names none.
    pub path: &'a str,
    /// What follows its first `?`, empty when it has none.
    pub query: &'a str,
}

/// What a request's `Origin` is judged against (spec 15.12): the authority the server's own origin
/// is made of, as [`own_authority_of`] gives it, and the origins it takes besides.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct TakenOrigins<'a> {
    /// The authority of the server's own origin: none when the request names none of its own.
    pub host: Option<&'a str>,
    /// The origins it takes besides, each compared exactly.
    pub origins: &'a [String],
}

impl<'a> TakenOrigins<'a> {
    /// The origins a request is judged against: its own by `host`, and `origins` besides.
    #[must_use]
    pub const fn new(host: Option<&'a str>, origins: &'a [String]) -> Self {
        Self { host, origins }
    }
}

// whether a byte is a space or a tab, what stands around a field's value and is not of it (RFC
// 9110 §5.5)
const fn is_field_whitespace(character: char) -> bool {
    matches!(character, ' ' | '\t')
}

// a field's value without the spaces and tabs around it (RFC 9110 §5.5)
fn trimmed(value: &str) -> &str {
    value.trim_matches(is_field_whitespace)
}

// whether a string is 15.12's name: letters, digits and the marks above, empty among them
fn is_name(text: &str) -> bool {
    text.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || NAME_MARKS.contains(&byte))
}

// what stands between an IP literal's brackets, when `value` is one: an opening bracket, a closing
// one at its end, and none between them
fn literal_of(value: &str) -> Option<&str> {
    value
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .filter(|inner| !inner.contains(']'))
}

/// Whether a string is RFC 3986's `IPv6address`, what stands between an IP literal's brackets:
/// never a zone nor a prefix's length.
#[must_use]
pub fn is_ipv6_address(text: &str) -> bool {
    // ! the platform's parser is asked only once hex digits, colons and dots alone stand
    !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b':' || byte == b'.')
        && text.parse::<Ipv6Addr>().is_ok()
}

// whether `value` is a host of spec 15.12's grammar: an IPv6 address in brackets, bare, with no
// zone; or a name, an IPv4 address and the empty name among them
fn is_host(value: &str) -> bool {
    literal_of(value).map_or_else(
        || is_name(value),
        |literal| !literal.contains('%') && is_ipv6_address(literal),
    )
}

// an authority split at its port's colon: the bracketed literal, or the text before its first
// `:`; what follows a literal but a port stays with it, which is then no host
fn parts_of(authority: &str) -> (&str, Option<&str>) {
    if !authority.starts_with('[') {
        return authority
            .split_once(':')
            .map_or((authority, None), |(host, port)| (host, Some(port)));
    }

    let Some((host, rest)) = authority
        .find(']')
        .and_then(|close| authority.split_at_checked(close.saturating_add(1)))
    else {
        return (authority, None);
    };

    rest.strip_prefix(':')
        .map_or((authority, None), |port| (host, Some(port)))
}

// whether a host is one every server takes, a name no page can rebind to its address (spec
// 15.12): `localhost`, a name ending in `.localhost`, an IPv6 address in brackets, an
// `IPv4address`
fn is_taken_by_every_server(host: &str) -> bool {
    let lowered = host.to_ascii_lowercase();

    lowered == LOCALHOST
        || lowered.ends_with(".localhost")
        || host.starts_with('[')
        || is_ipv4_address(host)
}

// whether a string is RFC 3986's dec-octet: 0 to 255, with no leading zero
fn is_dec_octet(text: &str) -> bool {
    !text.is_empty()
        && text.len() < 4
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && (text.len() == 1 || !text.starts_with('0'))
        && text.parse::<u16>().is_ok_and(|octet| octet <= 255)
}

/// Whether `value` is RFC 3986's `IPv4address`, four `dec-octet` with no leading zero: by the
/// grammar alone, never as a platform's parser reads one, which takes `127.1` or `0177.0.0.1`.
#[must_use]
pub fn is_ipv4_address(value: &str) -> bool {
    let mut octets = value.split('.');

    (0..4).all(|_| octets.next().is_some_and(is_dec_octet)) && octets.next().is_none()
}

/// Whether `value` is an IP address a server may listen on (spec 15.12).
///
/// RFC 3986's `IPv4address` or `IPv6address`, bare, with no zone, and not IPv4-mapped — an IPv4
/// node's address is written as one (RFC 4291 §2.5.5.2). By the grammar alone, never as a
/// platform's parser reads one, which takes `127.1`, `0` or `[::1]`.
#[must_use]
pub fn is_ip_address(value: &str) -> bool {
    is_ipv4_address(value)
        || (is_ipv6_address(value)
            && value
                .parse::<Ipv6Addr>()
                .is_ok_and(|address| address.to_ipv4_mapped().is_none()))
}

/// Refuses, with a [`ProgrammerError`] naming it, an address a server cannot listen on (spec
/// 15.12).
///
/// Any that [`is_ip_address`] does not take but `localhost`, exactly, the keyword for both
/// loopbacks, never resolved; any other name among them, `LOCALHOST`, `localhost.` and a name under
/// `.localhost` too, which another host would resolve otherwise. A bracketed IPv6 address is told
/// how to write itself.
///
/// # Errors
///
/// A [`ProgrammerError`] for an address no server listens on.
pub fn assert_listening_address(address: &str) -> Result<(), ProgrammerError> {
    if address == LOCALHOST || is_ip_address(address) {
        return Ok(());
    }

    let hint = literal_of(address)
        .filter(|literal| is_ip_address(literal))
        .map_or_else(String::new, |literal| {
            format!(": write {literal}, not {address}")
        });

    Err(ProgrammerError::new(format!(
        "a server listens on an IP address, or on localhost, both loopbacks, not \"{address}\"{hint}"
    )))
}

/// Whether a field value is one a server reads (spec 15.12).
///
/// Visible ASCII, spaces and tabs alone, none of them at either end. A control character but a tab,
/// `DEL` among them, and an octet past ASCII, which a request carries as the character of its
/// Latin-1 code, are none (RFC 9110 §5.5); so is a value that starts or ends with a space or a tab,
/// which HTTP/1.1's parser strips and HTTP/2 calls malformed (RFC 9113 §8.2.1).
#[must_use]
pub fn is_visible_field(value: &str) -> bool {
    let is_padded = value.starts_with(is_field_whitespace) || value.ends_with(is_field_whitespace);

    !is_padded
        && value
            .chars()
            .all(|character| character == '\t' || (' '..='~').contains(&character))
}

/// The credential an `Authorization` carries (spec 15.1), over HTTP a `POST`'s and over a WebSocket
/// its upgrade's.
///
/// Its first line's value whole, its auth-scheme included, without the spaces and tabs around it
/// (RFC 9110 §5.5); none when it has no line, or when nothing is left. Two lines are refused before
/// it is read, as no list to combine (RFC 9110 §5.3).
#[must_use]
pub fn credential_of<'a>(lines: &[&'a str]) -> Option<&'a str> {
    lines
        .first()
        .map(|line| trimmed(line))
        .filter(|value| !value.is_empty())
}

/// Whether every field value of a request, as it came — each name before its value — is one
/// [`is_visible_field`] takes, none padded at either end.
///
/// A request that holds another is answered 400 unmarked, as HTTP answers a malformed field, or
/// over HTTP/2 its stream reset, before anything else of it is judged.
#[must_use]
pub fn has_visible_fields(raw: &[&str]) -> bool {
    raw.iter()
        .skip(1)
        .step_by(2)
        .all(|value| is_visible_field(value))
}

// a target's path and its query, at its first `?`
fn path_and_query(read: &str) -> (&str, &str) {
    read.split_once('?').unwrap_or((read, ""))
}

/// Whether a request's target, as it came, is one a server reads (spec 15.12).
///
/// Visible ASCII alone, a URI's characters (RFC 3986 §2), in its path and its query, in origin-form
/// or absolute-form, and a path whose percent-decoding holds no NUL. A control character, HTAB and
/// a bare CR among them, DEL, a space and an octet past ASCII, which a request carries as the
/// character of its Latin-1 code, are none, wherever they stand. Nor is a `#` anywhere in it, since
/// no form of a request-target carries a fragment (RFC 9112 §3.2), nor a visible character a URI
/// leaves out that a page's browser always percent-encodes where it stands — `"`, `<` or `>` in a
/// path or a query, `^`, `` ` ``, `{` or `}` in a path, by the URL Standard's path and query
/// percent-encode sets, which hold `#` too. Any percent-encoded octet is otherwise taken, `%01`,
/// `%7F` and `%23` among them, and `%00` in a query; and so are the other visible characters a URI
/// leaves out, `\` and `|`, and `^`, `` ` ``, `{` and `}` in a query, as a page's browser sends them
/// unencoded. A request that holds another is answered 400 unmarked, or over HTTP/2 its stream
/// reset, before anything else of it is judged (RFC 9112 §3).
#[must_use]
pub fn is_visible_target(target: Option<&str>) -> bool {
    let Some(target) = target else {
        return true;
    };
    let (path, query) = path_and_query(target);

    target
        .chars()
        .all(|character| ('!'..='~').contains(&character))
        && !path.contains(ENCODED_IN_PATH)
        && !query.contains(ENCODED_IN_QUERY)
        && !path.contains("%00")
}

/// A request's `Origin` as a refusal tells it (spec 15.1): its field lines as they came, joined by
/// `, ` (RFC 9110 §5.3); none when it sends none.
#[must_use]
pub fn origin_of(lines: &[&str]) -> Option<String> {
    (!lines.is_empty()).then(|| lines.join(", "))
}

/// Whether `value` is an authority of spec 15.12's grammar.
///
/// A host, then an optional `:` and a port of one digit at least. A percent-encoded octet, `*`,
/// `+`, `,`, `;` or `=` in a name, an `IPvFuture` literal, a zone, and a colon with no port are
/// none.
#[must_use]
pub fn is_authority(value: &str) -> bool {
    let (host, port) = parts_of(value);

    is_host(host)
        && port
            .is_none_or(|port| !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()))
}

/// An authority's host, its port aside (RFC 9110 §4.2.3): the bracketed literal, or the text
/// before its first `:`.
#[must_use]
pub fn host_part_of(authority: &str) -> &str {
    parts_of(authority).0
}

// the length of an absolute-form target's scheme and its `://`, when it is `http` or `https` in
// any case (RFC 3986 §3.1)
fn absolute_form_of(target: &str) -> Option<usize> {
    ["http://", "https://"].into_iter().find_map(|scheme| {
        target
            .get(..scheme.len())
            .filter(|opening| opening.eq_ignore_ascii_case(scheme))
            .map(|_| scheme.len())
    })
}

// whether a target opens with another scheme and its `//` (RFC 3986 §3.1): a letter, then letters,
// digits, `+`, `-` or `.`
fn names_other_scheme(target: &str) -> bool {
    target.split_once("://").is_some_and(|(scheme, _)| {
        scheme.starts_with(|character: char| character.is_ascii_alphabetic())
            && scheme.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'-' || byte == b'.'
            })
    })
}

/// A request's target as HTTP reads it (spec 15.12).
///
/// In absolute-form, its scheme `http` or `https`, in any case (RFC 3986 §3.1), then `://` and an
/// authority as it came (RFC 9112 §3.2.2), then its path, `/` when it names none; otherwise its
/// path whole, `/` when there is none. None for a target HTTP refuses: another scheme's
/// absolute-form, or an authority that is no host, a userinfo, a colon with no port and an empty
/// one among them (RFC 9110 §4.2.1, §4.2.4).
#[must_use]
pub fn request_target_of(target: Option<&str>) -> Option<RequestTarget<'_>> {
    let given = target.unwrap_or("/");
    let Some(rest) = absolute_form_of(given).and_then(|length| given.get(length..)) else {
        if names_other_scheme(given) {
            return None;
        }

        let (path, query) = path_and_query(given);

        return Some(RequestTarget {
            authority: None,
            path,
            query,
        });
    };
    let (authority, after) = rest
        .find(['/', '?'])
        .and_then(|end| rest.split_at_checked(end))
        .unwrap_or((rest, ""));
    let (path, query) = path_and_query(after);

    if authority.is_empty() || !is_authority(authority) {
        return None;
    }

    Some(RequestTarget {
        authority: Some(authority),
        path: if path.is_empty() { "/" } else { path },
        query,
    })
}

/// Whether a request's `Host` is one HTTP takes (RFC 9112 §3.2), from its field lines as they came.
///
/// One line at most, none only where `is_required` is false, as in an HTTP/1.0 request; its value,
/// without the spaces and tabs around it, an authority of spec 15.12's grammar. An empty value is
/// one, and so is a name of invalid punycode, which [`is_taken_host`] judges. A request this
/// refuses is answered 400 before anything else of it is read.
#[must_use]
pub fn is_well_formed_host(lines: &[&str], is_required: bool) -> bool {
    match lines {
        [] => !is_required,
        [line] => is_authority(trimmed(line)),
        [_, _, ..] => false,
    }
}

/// A request's authority (spec 15.12), once HTTP took its form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct Authority<'a> {
    /// The authority it names: none when it names none.
    pub authority: Option<&'a str>,
}

/// What an HTTP/1 request's authority is read from beside its `Host`, as [`authority_of`] takes
/// it.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct HostRequest<'a> {
    /// Whether it requires a `Host`, as an HTTP/1.1 request does and an HTTP/1.0 one does not.
    pub is_required: bool,
    /// Its target, as [`request_target_of`] reads it: none for one HTTP refuses.
    pub target: Option<RequestTarget<'a>>,
}

impl<'a> HostRequest<'a> {
    /// A request that requires a `Host` or not, of `target`.
    #[must_use]
    pub const fn new(is_required: bool, target: Option<RequestTarget<'a>>) -> Self {
        Self {
            is_required,
            target,
        }
    }
}

/// An HTTP/1 request's authority (spec 15.12), from its `Host` field lines as they came and its
/// target.
///
/// An absolute-form target's, its `Host` ignored but for being one line, or none where none is
/// required; otherwise its `Host`, when [`is_well_formed_host`] takes it, and none when it has
/// none. None for what HTTP answers 400 of its own.
#[must_use]
pub fn authority_of<'a>(
    host_lines: &[&'a str],
    request: &HostRequest<'a>,
) -> Option<Authority<'a>> {
    let target = request.target?;

    if let Some(authority) = target.authority {
        return (host_lines.len() == 1 || (host_lines.is_empty() && !request.is_required))
            .then_some(Authority {
                authority: Some(authority),
            });
    }

    is_well_formed_host(host_lines, request.is_required).then(|| Authority {
        authority: host_lines.first().map(|line| trimmed(line)),
    })
}

/// Whether a request that names `authority` is taken (spec 15.12), by its host, its port aside,
/// compared ASCII case-insensitively (RFC 9110 §4.2.3).
///
/// Every server takes `localhost`, a name that ends in `.localhost`, an IPv6 address in brackets
/// and an `IPv4address`; `hosts` takes those it lists besides, and [`EVERY_HOST`], alone in it,
/// every host, an empty one and none. Any other, an empty one and none are refused.
#[must_use]
pub fn is_taken_host(authority: Option<&str>, hosts: &[String]) -> bool {
    if hosts.first().is_some_and(|host| host == EVERY_HOST) {
        return true;
    }

    let host = authority.map_or("", host_part_of);

    !host.is_empty()
        && (is_taken_by_every_server(host)
            || hosts.iter().any(|taken| taken.eq_ignore_ascii_case(host)))
}

/// The authority a server's own origin is made of (spec 15.12).
///
/// The request's, when its host is one the server takes by name — one every server takes, or one
/// `hosts` lists — and none when only [`EVERY_HOST`] takes it, which vouches for no name: a page
/// that rebinds its name to the server's address names its own `Host`, and is no origin of the
/// server's by it.
#[must_use]
pub fn own_authority_of<'a>(authority: Option<&'a str>, hosts: &[String]) -> Option<&'a str> {
    let named: Vec<String> = hosts
        .iter()
        .filter(|host| *host != EVERY_HOST)
        .cloned()
        .collect();

    authority.filter(|_| is_taken_host(authority, &named))
}

/// Whether a request from `origin` is taken.
///
/// One without an `Origin` comes from no page, and from anywhere; one among the origins taken,
/// exactly; or the server's own, `http://` or `https://` followed by the authority it is given,
/// [`own_authority_of`]'s, compared ASCII case-insensitively. The field is read as the serialized
/// origin it carries (RFC 6454 §6.2; Fetch, "serializing a request origin"), never parsed as a URL:
/// a browser writes it and the `Host` from one URL alike. Any other is none of its own, `null` and
/// every other scheme among them, as is any `Origin` of a request without an authority of its own.
#[must_use]
pub fn is_taken_origin(origin: Option<&str>, taken: &TakenOrigins<'_>) -> bool {
    let Some(origin) = origin else {
        return true;
    };

    if taken.origins.iter().any(|listed| listed == origin) {
        return true;
    }

    taken
        .host
        .filter(|host| !host.is_empty())
        .is_some_and(|host| {
            origin.eq_ignore_ascii_case(&format!("http://{host}"))
                || origin.eq_ignore_ascii_case(&format!("https://{host}"))
        })
}

/// Whether `origin` is among `origins`, exactly, as [`is_taken_origin`] compares them: the pages
/// the server answers CORS to (spec 15.12). None is never listed, and the server's own is listed
/// only when named.
#[must_use]
pub fn is_listed_origin(origin: Option<&str>, origins: &[String]) -> bool {
    origin.is_some_and(|origin| origins.iter().any(|listed| listed == origin))
}

/// Refuses, with a [`ProgrammerError`] naming the entry, a `hosts` entry no server takes.
///
/// An entry with a port, an empty one, one that is no host of spec 15.12's grammar — a Unicode IDN
/// among them, which the field never carries — or [`EVERY_HOST`] beside another. None takes the hosts every server takes alone; `["*"]` takes every host and makes none of their
/// origins its own: a page that rebinds its name to the server's address passes the host's test,
/// and the origin's refuses it.
///
/// # Errors
///
/// A [`ProgrammerError`] naming the first entry refused.
pub fn assert_hosts(hosts: &[String]) -> Result<(), ProgrammerError> {
    for entry in hosts {
        if entry == EVERY_HOST {
            if hosts.len() != 1 {
                return Err(ProgrammerError::new(format!(
                    "hosts takes {EVERY_HOST} alone, which takes every host"
                )));
            }
        } else if entry.is_empty() {
            return Err(ProgrammerError::new(
                "a hosts entry is a host, not an empty one",
            ));
        } else if is_host(entry) {
        } else if is_authority(entry) {
            return Err(ProgrammerError::new(format!(
                "a hosts entry is a host without its port, compared on any port: {}, not {entry}",
                host_part_of(entry)
            )));
        } else {
            return Err(ProgrammerError::new(format!(
                "a hosts entry is a host as the Host field carries it, an IDN host in punycode: not {entry}"
            )));
        }
    }

    Ok(())
}

// an origin as RFC 6454 §6.2 serializes it, read apart: a scheme in lower case, `://`, a host, and
// a port without a leading zero; none for any other
fn serialized_origin_of(entry: &str) -> Option<(&str, &str, Option<&str>)> {
    let (scheme, rest) = entry.split_once("://")?;
    let is_scheme = scheme.starts_with(|character: char| character.is_ascii_lowercase())
        && scheme.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || byte == b'+'
                || byte == b'-'
                || byte == b'.'
        });

    if !is_scheme {
        return None;
    }

    let end = if rest.starts_with('[') {
        rest.find(']')?.saturating_add(1)
    } else {
        rest.find([':', '/', '?', '[', ']']).unwrap_or(rest.len())
    };
    let (host, after) = rest.split_at_checked(end)?;
    let port = match after.strip_prefix(':') {
        None if after.is_empty() => None,
        Some(port)
            if port == "0"
                || (port.starts_with(|digit: char| ('1'..='9').contains(&digit))
                    && port.bytes().all(|byte| byte.is_ascii_digit())) =>
        {
            Some(port)
        }
        Some(_) | None => return None,
    };

    Some((scheme, host, port))
}

/// Refuses, with a [`ProgrammerError`] naming the entry, an `origins` entry no browser writes.
///
/// An origin is one as RFC 6454 §6.2 serializes it — a scheme in lower case, `://`, a host of spec
/// 15.12's grammar, a port of 0 to 65535 with no leading zero, nothing after. For `http`, `https`, `ws` and `wss`, the host in lower case and no port where it is the scheme's
/// default, another scheme's taken as written — since a browser writes `Origin` so, and an entry is
/// compared exactly. `*` is none: no origin wildcard exists. Nor is `null`, which a browser sends
/// for every page with no origin of its own, a sandboxed frame of any site among them: naming it
/// would take them all (RFC 6454 §6.2). None takes a page of the server's own alone.
///
/// # Errors
///
/// A [`ProgrammerError`] naming the first entry refused.
pub fn assert_origins(origins: &[String]) -> Result<(), ProgrammerError> {
    for entry in origins {
        if entry == "*" {
            return Err(ProgrammerError::new(
                "origins has no wildcard, not *: it names each origin a page comes from besides the server\u{2019}s own",
            ));
        }

        if entry == "null" {
            return Err(ProgrammerError::new(
                "origins does not take null: a browser sends it for every page with no origin of its own, a sandboxed frame of any site among them; serve the page from an origin, and name that one",
            ));
        }

        let is_origin = serialized_origin_of(entry).is_some_and(|(scheme, host, port)| {
            let default = DEFAULT_PORTS
                .iter()
                .find(|(special, _)| *special == scheme)
                .map(|(_, port)| *port);
            let number = port.map_or(Some(0), |port| port.parse::<u32>().ok());

            !host.is_empty()
                && is_host(host)
                && default.is_none_or(|default| {
                    host == host.to_ascii_lowercase()
                        && port.is_none_or(|_| number != Some(default))
                })
                && number.is_some_and(|number| number <= 65_535)
        });

        if !is_origin {
            return Err(ProgrammerError::new(format!(
                "an origins entry is an origin as a browser serializes it, scheme://host[:port] in lower case, no default port, nothing after: not {entry}"
            )));
        }
    }

    Ok(())
}
