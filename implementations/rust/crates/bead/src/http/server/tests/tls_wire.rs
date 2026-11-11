//! A client of the tests' own over TLS, trusting the fixture's certificate alone, as the C# side's
//! `TlsWire` and the TypeScript side's sessions: over HTTP/2 a session of h2's, or one written by
//! hand where h2 will not write what a test sends — its preface, a SETTINGS of no dynamic table,
//! and one HEADERS frame of the fields given, each a literal never indexed, never Huffman-coded
//! (RFC 7541 §6.2.3); over HTTP/1.1 a head as it is given, its response read as `testing::wire`
//! reads one.

#![expect(
    clippy::arithmetic_side_effects,
    reason = "a test's own HPACK reader, its counts bounded by the frames a server of its test writes"
)]

use std::collections::BTreeMap;

use bytes::Bytes;
use rustls::pki_types::ServerName;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use crate::http::peer::{HOST, PATIENCE};
use crate::testing::patience;
use crate::testing::wire::{Response, ResponseReader};

/// HTTP/2's protocol by ALPN.
pub(super) const H2: &[u8] = b"h2";

/// HTTP/1.1's.
pub(super) const HTTP_1_1: &[u8] = b"http/1.1";

/// HTTP/2's error code of a malformed request (RFC 9113 §7).
pub(super) const PROTOCOL_ERROR: u32 = 0x1;

// the client's connection preface (RFC 9113 §3.4)
const PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

const DATA: u8 = 0x0;
const HEADERS: u8 = 0x1;
const RESET_STREAM: u8 = 0x3;
const SETTINGS: u8 = 0x4;
const GO_AWAY: u8 = 0x7;
const END_STREAM: u8 = 0x1;
const END_HEADERS: u8 = 0x4;
const ACKNOWLEDGED: u8 = 0x1;

// SETTINGS_HEADER_TABLE_SIZE (RFC 9113 §6.5.2): 0, so that no answer leans on a dynamic table
const HEADER_TABLE_SIZE: u16 = 0x1;

// the fields of RFC 7541's static table a response's status is written by (Appendix A)
const STATIC_STATUSES: [(usize, u16); 7] = [
    (8, 200),
    (9, 204),
    (10, 206),
    (11, 304),
    (12, 400),
    (13, 404),
    (14, 500),
];

/// What a request over TLS was answered: over HTTP/2, its status and its mark, or the code its
/// stream was reset with, or its session ended with, nothing written.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(super) struct TlsAnswer {
    pub(super) status: Option<u16>,
    pub(super) refusal: Option<String>,
    pub(super) reset: Option<u32>,
    pub(super) ended: Option<u32>,
}

impl TlsAnswer {
    /// An answer of `status`, marked `refusal`.
    pub(super) fn of(status: u16, refusal: Option<&str>) -> Self {
        Self {
            status: Some(status),
            refusal: refusal.map(str::to_owned),
            ..Self::default()
        }
    }

    /// A stream reset with `code`, nothing written.
    pub(super) fn reset(code: u32) -> Self {
        Self {
            reset: Some(code),
            ..Self::default()
        }
    }
}

/// A socket connected to the loopback's `port`, its TLS shaken hands offering `protocol` alone.
pub(super) async fn secured(port: u16, protocol: &[u8]) -> TlsStream<TcpStream> {
    let mut config = rustls::ClientConfig::clone(&crate::testing::tls::client_config().unwrap());

    config.alpn_protocols = vec![protocol.to_vec()];

    let socket = TcpStream::connect((HOST, port)).await.unwrap();
    let name = ServerName::try_from(HOST.to_owned()).unwrap();
    let stream = TlsConnector::from(std::sync::Arc::new(config))
        .connect(name, socket)
        .await
        .unwrap();

    assert_eq!(
        stream.get_ref().1.alpn_protocol(),
        Some(protocol),
        "the protocol offered, chosen"
    );

    stream
}

/// What a request written raw as `request` over HTTP/1.1 and TLS is answered, whole.
pub(super) async fn https_of(port: u16, request: &[u8]) -> Response {
    let mut stream = secured(port, HTTP_1_1).await;
    let mut reader = ResponseReader::new();
    let mut read = vec![0_u8; 16_384];

    stream.write_all(request).await.unwrap();

    patience(PATIENCE, async {
        while reader.response().is_none() && reader.failed().is_none() {
            match stream.read(&mut read).await {
                Ok(0) | Err(_) => reader.end(),
                Ok(count) => reader.feed(&read[..count]),
            }
        }
    })
    .await
    .expect("a response within patience");

    reader.response().cloned().expect("a response read whole")
}

/// A session of h2's over TLS to the loopback's `port`, its connection driven on its own.
pub(super) async fn session_of(port: u16) -> h2::client::SendRequest<Bytes> {
    let stream = secured(port, H2).await;
    let (session, connection) = h2::client::handshake(stream).await.unwrap();

    drop(crate::testing::spawn(async move {
        connection.await.ok();
    }));

    session
}

/// A request of `method` over `session` of h2's on `/bead`, its fields `fields`, its body `body`
/// when given, its stream ended with it.
pub(super) fn request_of(
    (method, port): (&str, u16),
    fields: &[(&str, &str)],
) -> ::http::Request<()> {
    let mut request = ::http::Request::builder()
        .method(method)
        .uri(format!("https://{HOST}:{port}/bead"));

    for (name, value) in fields {
        request = request.header(*name, *value);
    }

    request.body(()).unwrap()
}

/// `request` sent over `session` of h2's, its stream ended with its head where `ends`: its
/// response to come, and its stream to send on.
pub(super) async fn sent(
    session: &h2::client::SendRequest<Bytes>,
    (request, ends): (::http::Request<()>, bool),
) -> (h2::client::ResponseFuture, h2::SendStream<Bytes>) {
    let mut ready = patience(PATIENCE, session.clone().ready())
        .await
        .expect("a session ready within patience")
        .unwrap();

    ready.send_request(request, ends).unwrap()
}

/// A response's body of h2's, read whole.
pub(super) async fn body_of(mut received: h2::RecvStream) -> Vec<u8> {
    let mut bytes = Vec::new();

    while let Some(data) = patience(PATIENCE, received.data())
        .await
        .expect("a body within patience")
    {
        let data = data.unwrap();

        received.flow_control().release_capacity(data.len()).ok();
        bytes.extend_from_slice(&data);
    }

    bytes
}

/// A response's fields of h2's, each by its name, its lines joined.
pub(super) fn fields_of<T>(response: &::http::Response<T>) -> BTreeMap<String, String> {
    let mut fields: BTreeMap<String, String> = BTreeMap::new();

    for (name, value) in response.headers() {
        let value = value.to_str().unwrap_or_default();

        fields
            .entry(name.as_str().to_owned())
            .and_modify(|joined| {
                joined.push_str(", ");
                joined.push_str(value);
            })
            .or_insert_with(|| value.to_owned());
    }

    fields
}

/// What a session of h2's is answered to `request` and `body`, its stream ended with them: its
/// status, its fields, its body.
pub(super) async fn exchanged(
    session: &h2::client::SendRequest<Bytes>,
    (request, body): (::http::Request<()>, Option<Vec<u8>>),
) -> (u16, BTreeMap<String, String>, Vec<u8>) {
    let (response, mut stream) = sent(session, (request, body.is_none())).await;

    if let Some(body) = body {
        stream.send_data(Bytes::from(body), true).unwrap();
    }

    let response = patience(PATIENCE, response)
        .await
        .expect("a response within patience")
        .unwrap();
    let fields = fields_of(&response);

    (
        response.status().as_u16(),
        fields,
        body_of(response.into_body()).await,
    )
}

// a frame's type, its flags and its stream (RFC 9113 §4.1)
struct FrameHead {
    kind: u8,
    flags: u8,
    stream: u32,
}

// a frame: its length, its head, then its payload
fn frame_of(head: &FrameHead, payload: &[u8]) -> Vec<u8> {
    let length = u32::try_from(payload.len()).unwrap().to_be_bytes();
    let mut frame = vec![length[1], length[2], length[3], head.kind, head.flags];

    frame.extend_from_slice(&head.stream.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

// a header block of literals never indexed, each name and value of fewer than 127 octets, written
// as their octets, each character its code point (ISO-8859-1)
fn block_of(fields: &[(&str, &str)]) -> Vec<u8> {
    let mut block = Vec::new();

    for (name, value) in fields {
        let name = crate::testing::wire::latin1_of(name).unwrap();
        let value = crate::testing::wire::latin1_of(value).unwrap();

        // ! a length past 126 would take more than its one octet's prefix
        assert!(name.len() < 127 && value.len() < 127, "a field too long");
        block.push(0x10);
        block.push(u8::try_from(name.len()).unwrap());
        block.extend_from_slice(&name);
        block.push(u8::try_from(value.len()).unwrap());
        block.extend_from_slice(&value);
    }

    block
}

/// A session of HTTP/2 written by hand over TLS, its requests one after the other, each on the
/// next stream of the client's.
pub(super) struct TlsWire {
    stream: TlsStream<TcpStream>,
    next_stream: u32,
    is_open: bool,
}

impl TlsWire {
    /// A socket connected to the loopback's `port`, its TLS shaken hands offering HTTP/2.
    pub(super) async fn open(port: u16) -> Self {
        Self {
            stream: secured(port, H2).await,
            next_stream: 1,
            is_open: false,
        }
    }

    async fn frame(&mut self) -> (u8, u8, u32, Vec<u8>) {
        let mut head = [0_u8; 9];

        patience(PATIENCE, self.stream.read_exact(&mut head))
            .await
            .expect("a frame within patience")
            .unwrap();

        let length = usize::from(head[0]) << 16 | usize::from(head[1]) << 8 | usize::from(head[2]);
        let stream = u32::from_be_bytes([head[5], head[6], head[7], head[8]]) & 0x7FFF_FFFF;
        let mut payload = vec![0_u8; length];

        patience(PATIENCE, self.stream.read_exact(&mut payload))
            .await
            .expect("a frame's payload within patience")
            .unwrap();

        (head[3], head[4], stream, payload)
    }

    /// One `POST` over HTTP/2, of the fields given after `:method`, `:scheme` and `:path`, each
    /// but one the fields given name, its stream ended with its head: its status and its mark, or
    /// the code its stream was reset with, or its session ended with before any answer.
    pub(super) async fn ask(&mut self, fields: &[(&str, &str)]) -> TlsAnswer {
        if !self.is_open {
            let mut settings = HEADER_TABLE_SIZE.to_be_bytes().to_vec();

            settings.extend_from_slice(&0_u32.to_be_bytes());
            self.stream.write_all(PREFACE).await.unwrap();
            self.stream
                .write_all(&frame_of(
                    &FrameHead {
                        kind: SETTINGS,
                        flags: 0,
                        stream: 0,
                    },
                    &settings,
                ))
                .await
                .unwrap();

            // ! the server's SETTINGS acknowledged, and its acknowledgement of ours read, before
            // the request goes: its answers then lean on no dynamic table
            let (mut acknowledged, mut theirs) = (false, false);

            while !(acknowledged && theirs) {
                let (kind, flags, _, _) = self.frame().await;

                if kind == SETTINGS && flags & ACKNOWLEDGED == 0 {
                    self.stream
                        .write_all(&frame_of(
                            &FrameHead {
                                kind: SETTINGS,
                                flags: ACKNOWLEDGED,
                                stream: 0,
                            },
                            &[],
                        ))
                        .await
                        .unwrap();
                    theirs = true;
                } else if kind == SETTINGS {
                    acknowledged = true;
                }
            }

            self.is_open = true;
        }

        // ! a pseudo-header the fields given name takes the place of its default, every one
        // before any regular field (RFC 9113 §8.3)
        let defaults = [
            (":method", "POST"),
            (":scheme", "https"),
            (":path", "/bead"),
        ];
        let mut request: Vec<(&str, &str)> = defaults
            .into_iter()
            .filter(|(name, _)| !fields.iter().any(|(given, _)| given == name))
            .collect();
        let stream_id = self.next_stream;

        request.extend_from_slice(fields);
        self.next_stream += 2;
        self.stream
            .write_all(&frame_of(
                &FrameHead {
                    kind: HEADERS,
                    flags: END_STREAM | END_HEADERS,
                    stream: stream_id,
                },
                &block_of(&request),
            ))
            .await
            .unwrap();

        loop {
            let (kind, flags, stream, payload) = self.frame().await;

            if kind == SETTINGS && flags & ACKNOWLEDGED == 0 {
                self.stream
                    .write_all(&frame_of(
                        &FrameHead {
                            kind: SETTINGS,
                            flags: ACKNOWLEDGED,
                            stream: 0,
                        },
                        &[],
                    ))
                    .await
                    .unwrap();
            } else if stream == stream_id && kind == RESET_STREAM {
                return TlsAnswer::reset(u32::from_be_bytes(payload[..4].try_into().unwrap()));
            } else if kind == GO_AWAY {
                return TlsAnswer {
                    ended: Some(u32::from_be_bytes(payload[4..8].try_into().unwrap())),
                    ..TlsAnswer::default()
                };
            } else if stream == stream_id && kind == HEADERS {
                assert_ne!(flags & END_HEADERS, 0, "a head in one frame");

                return answer_of(&payload);
            } else {
                assert!(
                    kind != DATA || stream != stream_id,
                    "no body before its head"
                );
            }
        }
    }
}

/// One `POST` over HTTP/2 on a session of its own, written by hand: its answer, or its reset.
pub(super) async fn http2_of(port: u16, fields: &[(&str, &str)]) -> TlsAnswer {
    TlsWire::open(port).await.ask(fields).await
}

// ── HPACK, as far as an answer reads it (RFC 7541) ──────────────────────────────────────────────

// the length of each octet's code, then EOS's, by RFC 7541's Appendix B, whose code is canonical:
// each code the next of its length, in the order of the octets
const HUFFMAN_LENGTHS: [u8; 257] = [
    13, 23, 28, 28, 28, 28, 28, 28, 28, 24, 30, 28, 28, 30, 28, 28, 28, 28, 28, 28, 28, 28, 30, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 6, 10, 10, 12, 13, 6, 8, 11, 10, 10, 8, 11, 8, 6, 6, 6, 5, 5,
    5, 6, 6, 6, 6, 6, 6, 6, 7, 8, 15, 6, 12, 10, 13, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 8, 7, 8, 13, 19, 13, 14, 6, 15, 5, 6, 5, 6, 5, 6, 6, 6, 5, 7, 7, 6, 6,
    6, 5, 6, 7, 6, 5, 5, 6, 7, 7, 7, 7, 7, 15, 11, 14, 13, 28, 20, 22, 20, 20, 22, 22, 22, 23, 22,
    23, 23, 23, 23, 23, 24, 23, 24, 24, 22, 23, 24, 23, 23, 23, 23, 21, 22, 23, 22, 23, 23, 24, 22,
    21, 20, 22, 22, 23, 23, 21, 23, 22, 22, 24, 21, 22, 23, 23, 21, 21, 22, 21, 23, 22, 23, 23, 20,
    22, 22, 22, 23, 22, 22, 23, 26, 26, 20, 19, 22, 23, 22, 25, 26, 26, 26, 27, 27, 26, 24, 25, 19,
    21, 26, 27, 27, 26, 27, 24, 21, 21, 26, 26, 28, 27, 27, 27, 20, 24, 20, 21, 22, 21, 21, 23, 22,
    22, 25, 25, 24, 24, 26, 23, 26, 27, 26, 26, 27, 27, 27, 27, 27, 28, 27, 27, 27, 27, 27, 26, 30,
];

// each code by its length and its bits, the octet it stands for
fn huffman_codes() -> BTreeMap<(u8, u32), u8> {
    let mut symbols: Vec<usize> = (0..256).collect();
    let mut codes = BTreeMap::new();
    let mut code = 0_u32;
    let mut previous = 0_u8;

    symbols.sort_by_key(|symbol| (HUFFMAN_LENGTHS[*symbol], *symbol));

    for (rank, symbol) in symbols.into_iter().enumerate() {
        let length = HUFFMAN_LENGTHS[symbol];

        if rank > 0 {
            code = (code + 1) << (length - previous);
        }

        previous = length;
        codes.insert((length, code), u8::try_from(symbol).unwrap());
    }

    codes
}

// a string Huffman-coded (RFC 7541 §5.2), its padding the most significant bits of EOS
fn huffman_of(bytes: &[u8]) -> String {
    let codes = huffman_codes();
    let mut text = Vec::new();
    let (mut code, mut length) = (0_u32, 0_u8);

    for byte in bytes {
        for bit in (0..8).rev() {
            code = code << 1 | u32::from(byte >> bit & 1);
            length += 1;

            if let Some(symbol) = codes.get(&(length, code)) {
                text.push(*symbol);
                (code, length) = (0, 0);
            }
        }
    }

    assert!(length < 8, "a string's padding past 7 bits");
    String::from_utf8(text).unwrap()
}

// a response's header block, read as RFC 7541 writes one, its status and its mark kept
struct HeaderBlock<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl HeaderBlock<'_> {
    // an integer of the prefix given, and the octets that continue it (RFC 7541 §5.1)
    fn integer(&mut self, prefix: u32) -> usize {
        let most = (1_usize << prefix) - 1;
        let mut value = usize::from(self.bytes[self.at]) & most;

        self.at += 1;

        if value < most {
            return value;
        }

        let mut shift = 0;

        loop {
            let next = self.bytes[self.at];

            self.at += 1;
            value += usize::from(next & 0x7F) << shift;
            shift += 7;

            if next & 0x80 == 0 {
                return value;
            }
        }
    }

    // a string literal (RFC 7541 §5.2)
    fn text(&mut self) -> String {
        let is_huffman = self.bytes[self.at] & 0x80 != 0;
        let length = self.integer(7);
        let raw = &self.bytes[self.at..self.at + length];

        self.at += length;

        if is_huffman {
            huffman_of(raw)
        } else {
            String::from_utf8(raw.to_vec()).unwrap()
        }
    }
}

fn status_of(index: usize) -> Option<u16> {
    STATIC_STATUSES
        .iter()
        .find(|(at, _)| *at == index)
        .map(|(_, status)| *status)
}

// the answer a response's header block says
fn answer_of(bytes: &[u8]) -> TlsAnswer {
    let mut block = HeaderBlock { bytes, at: 0 };
    let mut answer = TlsAnswer::default();

    while block.at < bytes.len() {
        let first = bytes[block.at];

        if first & 0x80 != 0 {
            // an indexed field: a status the static table holds, or one of no matter here
            let index = block.integer(7);

            assert!(index <= 61, "an answer that leans on no dynamic table");
            answer.status = status_of(index).or(answer.status);

            continue;
        }

        if first & 0xE0 == 0x20 {
            // a dynamic table's size update
            block.integer(5);

            continue;
        }

        let index = block.integer(if first & 0x40 != 0 { 6 } else { 4 });

        assert!(index <= 61, "an answer that leans on no dynamic table");

        let name = if index == 0 {
            block.text()
        } else if status_of(index).is_some() {
            ":status".to_owned()
        } else {
            format!("#{index}")
        };
        let value = block.text();

        if name == ":status" {
            answer.status = value.parse().ok();
        } else if name == crate::http::fields::REFUSAL_HEADER {
            answer.refusal = Some(value);
        }
    }

    answer
}
