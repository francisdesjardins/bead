//! `ws-handshake`: raw bytes as an upgrade, read as the WebSocket transport's server reads a head,
//! under its bounds, then judged as it judges a request at its address before its 101 (spec 15.2).
//! The first byte picks what the rest is, modulo the twelve below: the whole head, as it came; or,
//! in RFC 6455 §1.3's handshake to a host the server takes, its request line, or one field's lines
//! in place of that field's, each line feed parting two of them. What the head's reader refuses is
//! not judged. The judgement answers a refusal, or none; the refusal tells of the request, and an
//! upgrade it takes carries its credential: a panic is a finding. The other sides'
//! `ws-handshake` targets are its twins, slot for slot, with the same server.

#![no_main]

use std::sync::LazyLock;

use bead::internal::handshake::{
    HandshakeRequest, HandshakeTaken, refusal_of_handshake, told_of_handshake,
};
use bead::internal::head::{HeadRead, read_head};
use bead::internal::hosts::credential_of;
use libfuzzer_sys::fuzz_target;

// the server the upgrade comes to: the host it takes, besides those every server takes, and an
// origin of another's it takes
static HOSTS: LazyLock<Vec<String>> = LazyLock::new(|| vec!["bead.test".to_owned()]);
static ORIGINS: LazyLock<Vec<String>> = LazyLock::new(|| vec!["https://bead.test".to_owned()]);

// RFC 6455 §1.3's handshake, to a host the server takes
const REQUEST_LINE: &[u8] = b"GET / HTTP/1.1";
const HANDSHAKE: &[(&str, &str)] = &[
    ("host", "bead.test"),
    ("upgrade", "websocket"),
    ("connection", "Upgrade"),
    ("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="),
    ("sec-websocket-version", "13"),
];

// the parts, by the first byte's slot: the head, its request line, then each field by its name
const HEAD: usize = 0;
const LINE: usize = 1;
const FIELDS: &[&str] = &[
    "host",
    "upgrade",
    "connection",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "origin",
    "authorization",
    "content-length",
    "transfer-encoding",
];

// the head the bytes stand for: as they came, or the handshake's with one part replaced
fn head_of(slot: usize, rest: &[u8]) -> Vec<u8> {
    if slot == HEAD {
        return rest.to_vec();
    }

    let replaced = FIELDS.get(slot.saturating_sub(2)).copied();
    let mut head = if slot == LINE { rest.to_vec() } else { REQUEST_LINE.to_vec() };

    head.extend_from_slice(b"\r\n");

    for (name, value) in HANDSHAKE {
        if Some(*name) != replaced {
            head.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
        }
    }

    if let Some(name) = replaced {
        for line in rest.split(|byte| *byte == b'\n') {
            head.extend_from_slice(name.as_bytes());
            head.extend_from_slice(b": ");
            head.extend_from_slice(line);
            head.extend_from_slice(b"\r\n");
        }
    }

    head.extend_from_slice(b"\r\n");
    head
}

fuzz_target!(|data: &[u8]| {
    let (first, rest) = data.split_first().map_or((0, &[][..]), |(first, rest)| (*first, rest));
    let slot = usize::from(first) % (2 + FIELDS.len());
    let HeadRead::Whole(head) = read_head(&head_of(slot, rest)) else {
        return;
    };
    let fields = head.fields();
    let mut request = HandshakeRequest::new(head.http_version, &fields);

    request.method = Some(&head.method);
    request.target = Some(&head.target);

    let refusal = refusal_of_handshake(&request, &HandshakeTaken::new(&HOSTS, &ORIGINS));

    core::hint::black_box(told_of_handshake(&request));

    // an upgrade the judgement takes carries its credential, but from a page
    let lines_of = |name: &str| -> Vec<&str> {
        fields
            .chunks(2)
            .filter_map(|pair| match pair {
                [field, value] if field.eq_ignore_ascii_case(name) => Some(*value),
                _ => None,
            })
            .collect()
    };

    if refusal.is_none() && lines_of("origin").is_empty() {
        core::hint::black_box(credential_of(&lines_of("authorization")));
    }
});
