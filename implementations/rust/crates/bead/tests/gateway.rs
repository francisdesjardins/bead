//! The Rust side's gateway, the twins of `http-gateway.test.ts` and `HttpGatewayTests.cs`: a gateway
//! of beadc's table of the `Transcoding` service, its server joined, called over a real socket on
//! its own listener or mounted by `answer`: its methods, its document, a stream's reconnection, a
//! command, what it reports, and the words of each refusal of its gates and its bounds (transcoding
//! 2 to 11, spec 9.0).

#![expect(
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "a twin's helpers fail it as its own lines do"
)]

use core::fmt::Write as _;
use core::future::poll_fn;
use core::pin::Pin;
use core::task::{Context, Poll};
use core::time::Duration;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bead::testing::wire::{Exchange, ExchangeOptions, Response};
use bead::testing::{patience, rest};
use bead::{
    ConnectionHandle, GatewayAuthorization, HttpGatewayBody, HttpGatewayOptions, ServerListener,
    ServerTransport,
};
use bead_interop::transcoding::generated::bead_http::OPENAPI_DOCUMENT;
use bead_interop::transcoding::generated::messages::bead::transcoding::v1::{
    Edges, Everything, Needs, Tick,
};
use bead_interop::transcoding::generated::services::bead::transcoding::v1::TranscodingProcedures;
use bead_interop::transcoding::{TranscodingFixture, TranscodingFixtureOptions, gateway_options};
use bead_protobuf::ProtoCodec;
use buffa_types::google::protobuf::Empty;
use bytes::Bytes;
use http_body::{Body, Frame};
use sha2::{Digest, Sha256};

// how long an exchange waits for what it expects
const PATIENCE: Duration = Duration::from_secs(5);

const HOST: &str = "127.0.0.1";

// the origin the file's defaults list
const ORIGIN: &str = "https://app.example";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ── Its fixture ───────────────────────────────────────────────────────────────

// a gateway of the file's defaults, `adjust`'s changes over them, listening or mounted
async fn started_with<F>((adjust, listens): (F, bool)) -> TranscodingFixture
where
    F: FnOnce(&mut HttpGatewayOptions),
{
    let mut gateway = gateway_options().expect("the gateway's options");

    gateway.origins = Some(vec![ORIGIN.to_owned()]);
    adjust(&mut gateway);

    let mut options = TranscodingFixtureOptions::new(&gateway);

    options.listens = Some(listens);

    TranscodingFixture::start(&options)
        .await
        .expect("the fixture")
}

async fn started() -> TranscodingFixture {
    started_with((|_: &mut HttpGatewayOptions| {}, true)).await
}

// what its gateway reported, in its order
fn reported_by(fixture: &TranscodingFixture) -> Arc<Mutex<Vec<String>>> {
    let reported = Arc::new(Mutex::new(Vec::new()));
    let reporting = Arc::clone(&reported);

    fixture.gateway.on_error(Arc::new(move |error| {
        locked(&reporting).push(error.to_string());
    }));

    reported
}

// the connections its in-memory transport draws, each by its client's address and port
#[derive(Debug, Default)]
struct Drawn {
    peers: Mutex<Vec<(String, u16)>>,
    count: AtomicUsize,
    memory: Mutex<Option<bead::MemoryTransportServer>>,
}

impl ServerListener for Drawn {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        self.count.fetch_add(1, Ordering::SeqCst);

        let memory = locked(&self.memory).clone();

        if let Some(memory) = memory {
            for client in memory.clients() {
                if &client.connection_handle == connection_handle {
                    locked(&self.peers).push((client.address, client.port.unwrap_or(0)));
                }
            }
        }
    }
}

fn drawn_by(fixture: &TranscodingFixture) -> Arc<Drawn> {
    let drawn = Arc::new(Drawn::default());

    *locked(&drawn.memory) = Some(fixture.memory.clone());

    let listener: Arc<dyn ServerListener> = Arc::<Drawn>::clone(&drawn);

    fixture.memory.listen(listener);

    drawn
}

async fn until<F: Fn() -> bool + Send + Sync>(holds: F) {
    patience(PATIENCE, async {
        while !holds() {
            rest(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("it held in time");
}

// ── Its exchanges ─────────────────────────────────────────────────────────────

// a refusal or a failure of the gateway's own, as a request meets it: its request's line and
// fields, its status, its words; its body, and its mark, none for a failure of its own
struct OwnCase<'a> {
    lines: &'a [&'a str],
    status: u16,
    words: &'a str,
    body: &'a str,
    reason: Option<&'a str>,
}

// a case's request: its host but where it gives one, its length but under a transfer-encoding,
// its socket closed after it
fn octets_of(port: u16, given: &OwnCase<'_>) -> Vec<u8> {
    let mut lines = vec![given.lines[0].to_owned()];
    let fields = &given.lines[1..];

    if !fields
        .iter()
        .any(|field| field.to_ascii_lowercase().starts_with("host:"))
    {
        lines.push(format!("host: {HOST}:{port}"));
    }

    lines.extend(fields.iter().map(|field| (*field).to_owned()));

    if !given.body.is_empty()
        && !fields
            .iter()
            .any(|field| field.to_ascii_lowercase().starts_with("transfer-encoding:"))
    {
        lines.push(format!("content-length: {}", given.body.len()));
    }

    lines.extend([
        "connection: close".to_owned(),
        String::new(),
        given.body.to_owned(),
    ]);
    lines.join("\r\n").into_bytes()
}

fn address_of(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

async fn opened(port: u16, octets: &[u8]) -> Exchange {
    Exchange::open(octets, &ExchangeOptions::new(address_of(port)))
        .await
        .expect("a socket to the gateway")
}

async fn exchanged(port: u16, octets: &[u8]) -> Response {
    opened(port, octets)
        .await
        .response(PATIENCE)
        .await
        .expect("a response")
}

fn field<'a>(response: &'a Response, name: &str) -> Option<&'a str> {
    response.head.fields.get(name).map(String::as_str)
}

fn json_of(response: &Response) -> serde_json::Value {
    serde_json::from_slice(&response.body).expect("a JSON body")
}

// what a case's response parts from it: its status, its mark, and its problem's words exactly
fn parts_of(answered: &Response, expected: &OwnCase<'_>) -> Vec<String> {
    let mut parts = Vec::new();
    let detail = (!answered.body.is_empty())
        .then(|| json_of(answered))
        .and_then(|problem| {
            problem
                .get("detail")
                .and_then(|detail| detail.as_str().map(str::to_owned))
        });

    if answered.head.status != expected.status {
        parts.push(format!(
            "{}: status {}",
            expected.words, answered.head.status
        ));
    }

    if field(answered, "bead-refusal") != expected.reason {
        parts.push(format!(
            "{}: bead-refusal {:?}",
            expected.words,
            field(answered, "bead-refusal")
        ));
    }

    if detail.as_deref() != Some(expected.words) {
        parts.push(format!("{}: detail {detail:?}", expected.words));
    }

    parts
}

// ── Mounted ───────────────────────────────────────────────────────────────────

// a body handed to a mounted gateway: its frames, then its end
struct Handed(Vec<Bytes>);

impl Body for Handed {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        if self.0.is_empty() {
            Poll::Ready(None)
        } else {
            Poll::Ready(Some(Ok(Frame::data(self.0.remove(0)))))
        }
    }
}

// a response's body read whole
async fn body_of(response: http::Response<HttpGatewayBody>) -> Vec<u8> {
    let mut body = response.into_body();
    let mut read = Vec::new();

    while let Some(frame) = poll_fn(|context| Pin::new(&mut body).poll_frame(context)).await {
        if let Ok(data) = frame.expect("a frame").into_data() {
            read.extend_from_slice(&data);
        }
    }

    read
}

// ── The twins ─────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_lowercase_methods_on_a_route_and_the_document_405_method_refused() {
    let fixture = started().await;
    let drawn = drawn_by(&fixture);

    for (method, path, allow) in [
        ("get", "/v1/books/2", "GET, HEAD"),
        ("head", "/v1/books/2", "GET, HEAD"),
        ("post", "/api/Transcoding/echo", "POST"),
        ("options", "/v1/books/2", "GET, HEAD"),
        ("get", "/openapi.json", "GET, HEAD"),
        ("head", "/openapi.json", "GET, HEAD"),
        ("options", "/openapi.json", "GET, HEAD"),
    ] {
        let line = format!("{method} {path} HTTP/1.1");
        let origin = format!("origin: {ORIGIN}");
        let lines = [
            line.as_str(),
            origin.as_str(),
            "access-control-request-method: GET",
        ];
        let answered = exchanged(
            fixture.port,
            &octets_of(
                fixture.port,
                &OwnCase {
                    lines: &lines,
                    status: 405,
                    words: "",
                    body: "",
                    reason: None,
                },
            ),
        )
        .await;

        assert_eq!(
            (answered.head.status, field(&answered, "bead-refusal")),
            (405, Some("method-refused")),
            "{line}"
        );
        assert_eq!(field(&answered, "allow"), Some(allow), "{line}");
        assert_eq!(
            field(&answered, "access-control-allow-origin"),
            Some(ORIGIN),
            "{line}"
        );
        assert_eq!(
            field(&answered, "access-control-allow-methods"),
            None,
            "{line}"
        );

        // * a HEAD's answer holds no content: its problem is its GET's, unwritten
        if method != "head" {
            let problem = json_of(&answered);

            assert_eq!(problem["status"], 405, "{line}");
            assert_eq!(problem["title"], "Method Not Allowed", "{line}");
        }
    }

    assert_eq!(drawn.count.load(Ordering::SeqCst), 0);

    fixture.dispose().await.expect("disposed");
}

// transcoding 2.3
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serves_a_mounted_route_without_a_remote_endpoint() {
    // * mounted, `answer(request, None)`: no remote endpoint, its caller read as local
    let fixture = started_with((|_: &mut HttpGatewayOptions| {}, false)).await;
    let reported = reported_by(&fixture);
    let drawn = drawn_by(&fixture);
    let mut request = http::Request::new(Handed(Vec::new()));

    *request.uri_mut() = "/v1/books/2".parse().expect("a target");
    request
        .headers_mut()
        .insert("host", http::HeaderValue::from_static("127.0.0.1"));

    let response = patience(PATIENCE, fixture.gateway.answer(request, None))
        .await
        .expect("answered in time");
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .map(|value| value.to_str().expect("a field value").to_owned());

    assert_eq!(status, 200);
    assert_eq!(content_type.as_deref(), Some("application/json"));
    assert_eq!(
        String::from_utf8(body_of(response).await).expect("UTF-8"),
        "{\"name\":\"2\",\"title\":\"A tale\"}"
    );
    assert_eq!(*locked(&drawn.peers), [("local".to_owned(), 0)]);
    until(|| fixture.memory.clients().is_empty()).await;
    assert_eq!(*locked(&reported), Vec::<String>::new());

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_a_stream_s_request_that_carries_last_event_id_with_204_and_no_call() {
    let fixture = started().await;
    let drawn = drawn_by(&fixture);
    let reconnection = exchanged(
        fixture.port,
        &octets_of(
            fixture.port,
            &OwnCase {
                lines: &[
                    "POST /api/Transcoding/ticks HTTP/1.1",
                    "content-type: application/json",
                    "accept: text/event-stream",
                    "last-event-id: 3",
                ],
                status: 204,
                words: "",
                body: "{\"from\":2}",
                reason: None,
            },
        ),
    )
    .await;

    assert_eq!(reconnection.head.status, 204);
    assert_eq!(reconnection.body, Vec::<u8>::new());
    assert_eq!(field(&reconnection, "content-type"), None);
    assert_eq!(drawn.count.load(Ordering::SeqCst), 0);

    // the same request, no stream asked: a call, which subscribes nothing
    let call = exchanged(
        fixture.port,
        &octets_of(
            fixture.port,
            &OwnCase {
                lines: &[
                    "POST /api/Transcoding/ticks HTTP/1.1",
                    "content-type: application/json",
                    "last-event-id: 3",
                ],
                status: 200,
                words: "",
                body: "{\"from\":2}",
                reason: None,
            },
        ),
    )
    .await;

    assert_eq!(
        (
            call.head.status,
            String::from_utf8_lossy(&call.body).into_owned()
        ),
        (200, "{\"ticks\":2}".to_owned())
    );

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_a_command_to_an_exchange_s_connection_service_unknown() {
    let fixture = started().await;
    let asked = exchanged(
        fixture.port,
        &octets_of(
            fixture.port,
            &OwnCase {
                lines: &[
                    "POST /api/Transcoding/ask HTTP/1.1",
                    "content-type: application/json",
                ],
                status: 200,
                words: "",
                body: "{}",
                reason: None,
            },
        ),
    )
    .await;

    assert_eq!(
        (
            asked.head.status,
            String::from_utf8_lossy(&asked.body).into_owned()
        ),
        (200, "{\"code\":18}".to_owned())
    );
    assert_eq!(*locked(&fixture.refused), ["no service 1"]);

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serves_the_document_beadc_wrote_byte_for_byte() {
    let fixture = started().await;
    let get = |extra: &'static [&'static str]| {
        let mut lines = vec!["GET /openapi.json HTTP/1.1"];

        lines.extend(extra);
        lines
    };
    let served = exchanged(
        fixture.port,
        &octets_of(
            fixture.port,
            &OwnCase {
                lines: &get(&[]),
                status: 200,
                words: "",
                body: "",
                reason: None,
            },
        ),
    )
    .await;
    let digest = Sha256::digest(OPENAPI_DOCUMENT.as_bytes());
    let tag = format!(
        "\"{}\"",
        digest.iter().fold(String::new(), |mut text, byte| {
            write!(text, "{byte:02x}").ok();
            text
        })
    );

    // * the document beadc wrote, which its route table embeds as it is
    assert_eq!(served.body, OPENAPI_DOCUMENT.as_bytes());
    assert_eq!(field(&served, "cache-control"), Some("no-cache"));
    assert_eq!(field(&served, "content-type"), Some("application/json"));
    assert_eq!(field(&served, "etag"), Some(tag.as_str()));

    let matched = format!("if-none-match: {tag}");
    let held = exchanged(
        fixture.port,
        &octets_of(
            fixture.port,
            &OwnCase {
                lines: &["GET /openapi.json HTTP/1.1", matched.as_str()],
                status: 304,
                words: "",
                body: "",
                reason: None,
            },
        ),
    )
    .await;

    assert_eq!(held.head.status, 304);

    let posted = exchanged(
        fixture.port,
        &octets_of(
            fixture.port,
            &OwnCase {
                lines: &[
                    "POST /openapi.json HTTP/1.1",
                    "content-type: application/json",
                ],
                status: 405,
                words: "",
                body: "{}",
                reason: None,
            },
        ),
    )
    .await;

    assert_eq!(field(&posted, "allow"), Some("GET, HEAD"));

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_an_authorization_but_elsewhere_or_bearer_jwt_and_a_bound_that_is_no_whole_number_above_0()
 {
    // * an authorization but the two is no value of `GatewayAuthorization`, and a stream window of
    // 1.5 none of a `u64`: their types hold them (row `A gateway's stream window that is no whole
    // number`); each bound of 0 is refused as the gateway is built
    let fixture = started().await;
    let options_of = |change: &dyn Fn(&mut HttpGatewayOptions)| {
        let mut options = HttpGatewayOptions::new(fixture.memory.clone(), Vec::new());

        options.authorization = Some(GatewayAuthorization::BearerJwt);
        change(&mut options);
        options
    };
    let body = bead::HttpGateway::new(&options_of(&|options| {
        options.maximum_body_bytes = Some(0);
    }))
    .expect_err("a body bound of 0 refused");
    let window = bead::HttpGateway::new(&options_of(&|options| {
        options.window = Some(0);
    }))
    .expect_err("a window of 0 refused");

    assert!(
        body.to_string()
            .starts_with("maximumBodyBytes is a whole number above 0, not 0"),
        "{body}"
    );
    assert!(
        window
            .to_string()
            .starts_with("window is a whole number above 0, not 0"),
        "{window}"
    );

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reports_to_a_handler_until_it_is_off() {
    let fixture = started().await;
    let reported = reported_by(&fixture);
    let off = Arc::new(Mutex::new(Vec::new()));
    let offed = Arc::clone(&off);
    let id = fixture.gateway.on_error(Arc::new(move |error| {
        locked(&offed).push(error.to_string());
    }));

    fixture.gateway.off(id);
    fixture.memory.stop().await.expect("its transport stopped");

    let answered = exchanged(
        fixture.port,
        &octets_of(
            fixture.port,
            &OwnCase {
                lines: &[
                    "POST /api/Transcoding/echo HTTP/1.1",
                    "content-type: application/json",
                ],
                status: 503,
                words: "",
                body: "{}",
                reason: None,
            },
        ),
    )
    .await;

    assert_eq!(answered.head.status, 503);
    assert_eq!((locked(&reported).len(), locked(&off).len()), (1, 0));

    fixture.dispose().await.expect("disposed");
}

#[expect(
    clippy::too_many_lines,
    reason = "the other sides' cases, one a line, in their order"
)]
// transcoding 10.2
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn words_each_refusal_of_its_gates_exactly_none_of_them_what_its_request_carried() {
    const JSON_TYPE: &str = "content-type: application/json";
    const BOOK: &str = "{\"aString\":\"0123456789\"}";

    let plain = started().await;
    let jwt = started_with((
        |options: &mut HttpGatewayOptions| {
            options.authorization = Some(GatewayAuthorization::BearerJwt);
        },
        true,
    ))
    .await;
    let small = started_with((
        |options: &mut HttpGatewayOptions| {
            options.maximum_body_bytes = Some(16);
        },
        true,
    ))
    .await;
    let long_token = format!(
        "authorization: Bearer {}",
        core::iter::repeat_n('a', 1_005).collect::<String>()
    );
    let chunked_book = format!("18\r\n{BOOK}\r\n0\r\n\r\n");
    let long_lines = [
        "POST /api/Transcoding/whoAmI HTTP/1.1",
        JSON_TYPE,
        long_token.as_str(),
    ];
    let cases: Vec<(&TranscodingFixture, OwnCase<'_>)> = vec![
        (
            &plain,
            OwnCase {
                lines: &["GET /v1/books/2 HTTP/1.1", "host: evil.example"],
                status: 403,
                words: "a host it does not take",
                body: "",
                reason: Some("host-refused"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &["GET /nope HTTP/1.1"],
                status: 404,
                words: "a path no route matches",
                body: "",
                reason: Some("path-unknown"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &["GET /v1/books/2 HTTP/1.1", "origin: https://other.example"],
                status: 403,
                words: "an origin neither its own nor listed",
                body: "",
                reason: Some("origin-refused"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &[
                    "GET /v1/books/2 HTTP/1.1",
                    "sec-fetch-site: cross-site",
                    "sec-fetch-mode: no-cors",
                ],
                status: 403,
                words: "a request from a page of another site that shows no origin",
                body: "",
                reason: Some("origin-refused"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &["PUT /v1/shelves/1/books/2 HTTP/1.1", JSON_TYPE],
                status: 405,
                words: "a method no route of its path takes",
                body: "{}",
                reason: Some("method-refused"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &["POST /openapi.json HTTP/1.1", JSON_TYPE],
                status: 405,
                words: "a method the document takes none of",
                body: "{}",
                reason: Some("method-refused"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &["GET /openapi.json HTTP/1.1", JSON_TYPE],
                status: 400,
                words: "content to the document",
                body: "{}",
                reason: Some("malformed"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &[
                    "POST /api/Transcoding/echo HTTP/1.1",
                    "content-type: text/plain",
                ],
                status: 415,
                words: "this route's body is application/json, unencoded",
                body: "{}",
                reason: Some("type-refused"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &["GET /v1/books/2 HTTP/1.1", JSON_TYPE],
                status: 400,
                words: "content to a route that takes none",
                body: "{}",
                reason: Some("malformed"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &[
                    "POST /api/Transcoding/whoAmI HTTP/1.1",
                    JSON_TYPE,
                    "authorization: Bearer good",
                    "authorization: Bearer good",
                ],
                status: 400,
                words: "two authorization fields",
                body: "{}",
                reason: Some("malformed"),
            },
        ),
        (
            &jwt,
            OwnCase {
                lines: &[
                    "POST /api/Transcoding/whoAmI HTTP/1.1",
                    JSON_TYPE,
                    "authorization: Basic YTpi",
                ],
                status: 401,
                words: "an auth-scheme but Bearer",
                body: "{}",
                reason: None,
            },
        ),
        (
            &jwt,
            OwnCase {
                lines: &long_lines,
                status: 431,
                words: "a token past 1004 bytes",
                body: "{}",
                reason: None,
            },
        ),
        (
            &small,
            OwnCase {
                lines: &["POST /api/Transcoding/echo HTTP/1.1", JSON_TYPE],
                status: 413,
                words: "a body declared past maximumBodyBytes 16",
                body: BOOK,
                reason: Some("too-large"),
            },
        ),
        (
            &small,
            OwnCase {
                lines: &[
                    "POST /api/Transcoding/echo HTTP/1.1",
                    JSON_TYPE,
                    "transfer-encoding: chunked",
                ],
                status: 413,
                words: "a body past maximumBodyBytes 16",
                body: chunked_book.as_str(),
                reason: Some("too-large"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &["POST /api/Transcoding/echo HTTP/1.1", JSON_TYPE, JSON_TYPE],
                status: 415,
                words: "this route's body is application/json, unencoded",
                body: "{}",
                reason: Some("type-refused"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &[
                    "POST /api/Transcoding/echo HTTP/1.1",
                    "content-type: application/json; boundary=x",
                ],
                status: 415,
                words: "this route's body is application/json, unencoded",
                body: "{}",
                reason: Some("type-refused"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &[
                    "POST /api/Transcoding/echo HTTP/1.1",
                    "content-type: application/json; charset",
                ],
                status: 415,
                words: "this route's body is application/json, unencoded",
                body: "{}",
                reason: Some("type-refused"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &[
                    "POST /api/Transcoding/echo HTTP/1.1",
                    "content-type: text/plain",
                ],
                status: 415,
                words: "this route's body is application/json, unencoded",
                body: "",
                reason: Some("type-refused"),
            },
        ),
        (
            &plain,
            OwnCase {
                lines: &[
                    "POST /api/Transcoding/echo HTTP/1.1",
                    JSON_TYPE,
                    "sec-fetch-site: cross-site",
                    "sec-fetch-mode: navigate",
                ],
                status: 403,
                words: "a request from a page of another site that shows no origin",
                body: "{}",
                reason: Some("origin-refused"),
            },
        ),
        (
            &jwt,
            OwnCase {
                lines: &[
                    "POST /api/Transcoding/whoAmI HTTP/1.1",
                    JSON_TYPE,
                    "authorization: Bearer",
                ],
                status: 401,
                words: "an auth-scheme but Bearer",
                body: "{}",
                reason: None,
            },
        ),
    ];
    let mut parted = Vec::new();

    for (fixture, expected) in &cases {
        let answered = exchanged(fixture.port, &octets_of(fixture.port, expected)).await;

        parted.extend(parts_of(&answered, expected));
    }

    assert_eq!(parted, Vec::<String>::new());

    drop(cases);

    for fixture in [plain, jwt, small] {
        fixture.dispose().await.expect("disposed");
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "the other sides' cases, in their order"
)]
// transcoding 7.7.6
// transcoding 10.2
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn words_each_refusal_of_its_bounds_exactly() {
    const ECHO: &[&str] = &[
        "POST /api/Transcoding/echo HTTP/1.1",
        "content-type: application/json",
    ];
    const HANG: &[&str] = &[
        "POST /api/Transcoding/hang HTTP/1.1",
        "content-type: application/json",
    ];
    const WATCH: &[&str] = &[
        "POST /api/Transcoding/watch HTTP/1.1",
        "content-type: application/json",
        "accept: text/event-stream",
    ];

    // what changes the file's defaults, a bound of its own
    trait Changing: Fn(&mut HttpGatewayOptions) + Sync {}

    impl<F: Fn(&mut HttpGatewayOptions) + Sync> Changing for F {}

    type Change = &'static dyn Changing;

    let mut parted = Vec::new();

    // * a call that hangs holds its bound; a second is refused past it, every caller's or its
    // address's
    let calls: [(Change, &str); 2] = [
        (
            &|options: &mut HttpGatewayOptions| options.maximum_exchanges = Some(1),
            "the calls under way hold maximumExchanges",
        ),
        (
            &|options: &mut HttpGatewayOptions| options.maximum_exchanges_per_address = Some(1),
            "the calls of its address hold maximumExchangesPerAddress",
        ),
    ];

    for (change, words) in calls {
        let fixture = started_with((change, true)).await;
        let held = OwnCase {
            lines: HANG,
            status: 0,
            words: "",
            body: "{}",
            reason: None,
        };
        let _holding = opened(fixture.port, &octets_of(fixture.port, &held)).await;

        until(|| fixture.counts.by_name("hanging") == Some(1)).await;

        let expected = OwnCase {
            lines: ECHO,
            status: 503,
            words,
            body: "{}",
            reason: Some("busy"),
        };

        parted.extend(parts_of(
            &exchanged(fixture.port, &octets_of(fixture.port, &expected)).await,
            &expected,
        ));
        fixture.dispose().await.expect("disposed");
    }

    // a stream that stays holds its own, apart from the calls
    let streams: [(Change, &str); 2] = [
        (
            &|options: &mut HttpGatewayOptions| options.maximum_connections = Some(1),
            "the streams under way hold maximumConnections",
        ),
        (
            &|options: &mut HttpGatewayOptions| options.maximum_connections_per_address = Some(1),
            "the streams of its address hold maximumConnectionsPerAddress",
        ),
    ];

    for (change, words) in streams {
        let fixture = started_with((change, true)).await;
        let held = OwnCase {
            lines: WATCH,
            status: 0,
            words: "",
            body: "{}",
            reason: None,
        };
        let holding = opened(fixture.port, &octets_of(fixture.port, &held)).await;

        holding.head(PATIENCE).await.expect("its stream's head");

        let expected = OwnCase {
            lines: WATCH,
            status: 503,
            words,
            body: "{}",
            reason: Some("busy"),
        };

        parted.extend(parts_of(
            &exchanged(fixture.port, &octets_of(fixture.port, &expected)).await,
            &expected,
        ));
        drop(holding);
        fixture.dispose().await.expect("disposed");
    }

    let echo_slow: &[&str] = &[ECHO[0], ECHO[1], "content-length: 10"];
    let bounds: [(Change, OwnCase<'_>); 3] = [
        (
            &|options: &mut HttpGatewayOptions| options.body_bytes_budget = Some(4),
            OwnCase {
                lines: ECHO,
                status: 503,
                words: "the bodies under way hold bodyBytesBudget",
                body: "{\"anInt32\":1}",
                reason: Some("busy"),
            },
        ),
        (
            &|options: &mut HttpGatewayOptions| {
                options.body_grace_period = Some(Duration::from_millis(100));
            },
            OwnCase {
                lines: echo_slow,
                status: 408,
                words: "a body slower than minimumBodyBytesPerSecond",
                body: "",
                reason: Some("too-slow"),
            },
        ),
        (
            &|options: &mut HttpGatewayOptions| options.timeout = Some(Duration::from_millis(50)),
            OwnCase {
                lines: HANG,
                status: 504,
                words: "no answer within 50 ms",
                body: "{}",
                reason: None,
            },
        ),
    ];

    for (change, expected) in &bounds {
        let fixture = started_with((*change, true)).await;

        parted.extend(parts_of(
            &exchanged(fixture.port, &octets_of(fixture.port, expected)).await,
            expected,
        ));
        fixture.dispose().await.expect("disposed");
    }

    assert_eq!(parted, Vec::<String>::new());
}

// ── Mounted under hyper ───────────────────────────────────────────────────────

// a body a reader before the gateway left: ended, or a stream of nothing that ends, which shows no
// hint of either
struct Left {
    is_end_stream: bool,
}

impl Body for Left {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        Poll::Ready(None)
    }

    fn is_end_stream(&self) -> bool {
        self.is_end_stream
    }
}

// the gateway mounted by hyper's `service_fn` on each socket a listener accepts over HTTP/1.1,
// behind a reader its request's `x-reader` names: `taken`, its body read whole and the same request
// handed on; `replaced`, an ended body in its place; `nothing`, a stream of nothing that shows no
// hint; none, the request as it came
async fn mounted_behind_reader(gateway: bead::HttpGateway) -> u16 {
    let listener = tokio::net::TcpListener::bind((HOST, 0))
        .await
        .expect("bound");
    let port = listener.local_addr().expect("its address").port();

    drop(bead::testing::spawn(async move {
        while let Ok((socket, peer)) = listener.accept().await {
            let gateway = gateway.clone();
            let service =
                hyper::service::service_fn(move |request: http::Request<hyper::body::Incoming>| {
                    let gateway = gateway.clone();

                    async move {
                        let reader = request
                            .headers()
                            .get("x-reader")
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned);
                        let (parts, mut body) = request.into_parts();
                        let response = match reader.as_deref() {
                            Some("taken") => {
                                while let Some(frame) =
                                    poll_fn(|context| Pin::new(&mut body).poll_frame(context)).await
                                {
                                    drop(frame);
                                }

                                gateway
                                    .answer(http::Request::from_parts(parts, body), Some(peer))
                                    .await
                            }
                            Some("replaced") => {
                                gateway
                                    .answer(
                                        http::Request::from_parts(
                                            parts,
                                            Left {
                                                is_end_stream: true,
                                            },
                                        ),
                                        Some(peer),
                                    )
                                    .await
                            }
                            Some("nothing") => {
                                gateway
                                    .answer(
                                        http::Request::from_parts(
                                            parts,
                                            Left {
                                                is_end_stream: false,
                                            },
                                        ),
                                        Some(peer),
                                    )
                                    .await
                            }
                            _ => {
                                gateway
                                    .answer(http::Request::from_parts(parts, body), Some(peer))
                                    .await
                            }
                        };

                        Ok::<_, std::convert::Infallible>(response)
                    }
                });

            drop(bead::testing::spawn(async move {
                drop(
                    hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(socket), service)
                        .await,
                );
            }));
        }
    }));

    port
}

// transcoding 7.6.27
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_500_a_body_read_before_it_by_the_server_it_is_mounted_on_reported_its_call_never_made()
 {
    // * the Rust form: hyper's request shows a body read before the gateway by its hints before
    // its first byte, and by its count at its end (clauses a, b and d); its call never made
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            options.body_grace_period = Some(Duration::from_millis(100));
            options.maximum_exchanges_per_address = Some(1);
        },
        false,
    ))
    .await;
    let reported = reported_by(&fixture);
    let drawn = drawn_by(&fixture);
    let port = mounted_behind_reader(fixture.gateway.clone()).await;
    let echo = |(fields, body): (&[&str], &str)| {
        let mut lines = vec![
            "POST /api/Transcoding/echo HTTP/1.1".to_owned(),
            format!("host: {HOST}:{port}"),
            "content-type: application/json".to_owned(),
        ];

        lines.extend(fields.iter().map(|field| (*field).to_owned()));
        lines.extend([String::new(), body.to_owned()]);
        lines.join("\r\n").into_bytes()
    };
    let mut parted = Vec::new();

    for (reader, framing, fields, body) in [
        (
            "taken",
            "JSON, content-length",
            &["content-length: 13"][..],
            "{\"anInt32\":1}",
        ),
        (
            "replaced",
            "JSON, content-length",
            &["content-length: 13"][..],
            "{\"anInt32\":1}",
        ),
        (
            "replaced",
            "JSON, chunked",
            &["transfer-encoding: chunked"][..],
            "d\r\n{\"anInt32\":1}\r\n0\r\n\r\n",
        ),
        (
            "replaced",
            "chunked, empty",
            &["transfer-encoding: chunked"][..],
            "0\r\n\r\n",
        ),
        (
            "nothing",
            "JSON, content-length",
            &["content-length: 13"][..],
            "{\"anInt32\":1}",
        ),
    ] {
        let cell = format!("{reader}, {framing}");
        let before = (drawn.count.load(Ordering::SeqCst), locked(&reported).len());
        let marked = format!("x-reader: {reader}");
        let mut given: Vec<&str> = fields.to_vec();

        given.push(marked.as_str());

        let answered = exchanged(port, &echo((&given, body))).await;
        let made = drawn.count.load(Ordering::SeqCst) - before.0;
        let told: Vec<String> = locked(&reported)[before.1..].to_vec();
        // * its place released: the address's one call answers
        let next = exchanged(
            port,
            &echo((&["content-length: 2", "connection: close"], "{}")),
        )
        .await;

        for part in [
            (answered.head.status != 500).then(|| format!("status {}", answered.head.status)),
            field(&answered, "bead-refusal").map(|reason| format!("bead-refusal {reason}")),
            (answered.body
                != b"{\"status\":500,\"title\":\"Internal Server Error\",\"type\":\"about:blank\"}")
                .then(|| format!("body {}", String::from_utf8_lossy(&answered.body))),
            (told != ["a body read before the gateway took its request"])
                .then(|| format!("reported {told:?}")),
            (made != 0).then(|| format!("{made} call(s)")),
            (next.head.status != 200).then(|| format!("next {}", next.head.status)),
        ]
        .into_iter()
        .flatten()
        {
            parted.push(format!("{cell}: {part}"));
        }
    }

    assert_eq!(parted, Vec::<String>::new());

    fixture.dispose().await.expect("disposed");
}

// ── Its exchanges, whole ──────────────────────────────────────────────────────

const JSON: &str = "content-type: application/json";

// a request of its line and fields, then its body, as a case's; a HEAD's response its head alone
async fn asked(port: u16, (lines, body): (&[&str], &str)) -> Response {
    let octets = octets_of(
        port,
        &OwnCase {
            lines,
            status: 0,
            words: "",
            body,
            reason: None,
        },
    );

    if lines[0].starts_with("HEAD ") {
        Response {
            head: opened(port, &octets)
                .await
                .head(PATIENCE)
                .await
                .expect("a head"),
            body: Vec::new(),
        }
    } else {
        exchanged(port, &octets).await
    }
}

// a POST of a JSON body to `path`, its fields beside it
// a POST's path, its fields beside its media type, and its body
struct Post<'a> {
    path: &'a str,
    fields: &'a [&'a str],
    body: &'a str,
}

async fn posted(port: u16, &Post { path, fields, body }: &Post<'_>) -> Response {
    let line = format!("POST {path} HTTP/1.1");
    let mut lines = vec![line.as_str(), JSON];

    lines.extend(fields);

    asked(port, (&lines, body)).await
}

fn text_of(response: &Response) -> String {
    String::from_utf8_lossy(&response.body).into_owned()
}

// `count` of `letter`, a test's own text
fn letters(letter: char, count: usize) -> String {
    core::iter::repeat_n(letter, count).collect()
}

// the connections its in-memory transport draws and closes, each by its handle; given the
// transport, it closes each connection a request comes on
#[derive(Debug, Default)]
struct Watched {
    drawn: Mutex<Vec<String>>,
    closed: Mutex<Vec<String>>,
    requests: AtomicUsize,
    closing: Mutex<Option<bead::MemoryTransportServer>>,
}

impl ServerListener for Watched {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        locked(&self.drawn).push(connection_handle.to_string());
    }

    fn on_message(&self, message: bead::TransportMessage, connection_handle: &ConnectionHandle) {
        let closing = locked(&self.closing).clone();

        if let Some(memory) = closing {
            let envelope =
                bead::testing::scripted::envelope_of(&message.data, bead::RouterSide::Server);

            if envelope.header().kind() == bead::EnvelopeKind::Request {
                self.requests.fetch_add(1, Ordering::SeqCst);

                let closed = memory.close(connection_handle);

                drop(bead::testing::spawn(async move {
                    closed.await;
                }));
            }
        }
    }

    fn on_close(&self, _was_clean: bool, connection_handle: &ConnectionHandle) {
        locked(&self.closed).push(connection_handle.to_string());
    }
}

fn watched_on(memory: &bead::MemoryTransportServer) -> Arc<Watched> {
    let watched = Arc::new(Watched::default());
    let listener: Arc<dyn ServerListener> = Arc::<Watched>::clone(&watched);

    memory.listen(listener);

    watched
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hands_each_exchange_s_client_address_and_socket_port_to_its_transport_after_its_proxy_policy()
 {
    for (address, trusted_proxies, unnamed_proxies) in [
        ("127.0.0.1", Vec::<String>::new(), 0),
        ("203.0.113.9", vec!["127.0.0.1".to_owned()], 0),
        ("203.0.113.9", Vec::new(), 1),
    ] {
        let fixture = started_with((
            |options: &mut HttpGatewayOptions| {
                options.trusted_proxies = Some(trusted_proxies);
                options.unnamed_proxies = Some(unnamed_proxies);
            },
            false,
        ))
        .await;
        let drawn = drawn_by(&fixture);
        let mut request = http::Request::new(Handed(Vec::new()));

        *request.uri_mut() = "/v1/books/2".parse().expect("a target");
        request
            .headers_mut()
            .insert("host", http::HeaderValue::from_static("127.0.0.1"));
        request.headers_mut().insert(
            "x-forwarded-for",
            http::HeaderValue::from_static("203.0.113.9:54321"),
        );

        let response = patience(
            PATIENCE,
            fixture
                .gateway
                .answer(request, Some(SocketAddr::from(([127, 0, 0, 1], 43210)))),
        )
        .await
        .expect("answered in time");

        // * a forwarded port never replaces the exchange's socket port
        assert_eq!(response.status(), 200, "{address}");
        assert_eq!(
            String::from_utf8(body_of(response).await).expect("UTF-8"),
            "{\"name\":\"2\",\"title\":\"A tale\"}"
        );
        assert_eq!(
            *locked(&drawn.peers),
            [(address.to_owned(), 43210)],
            "{address}"
        );
        until(|| fixture.memory.clients().is_empty()).await;

        fixture.dispose().await.expect("disposed");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn draws_one_bead_connection_per_exchange_and_closes_it_as_its_response_ends() {
    let fixture = started().await;
    let watched = watched_on(&fixture.memory);
    let port = fixture.port;
    let (one, two) = tokio::join!(
        posted(
            port,
            &Post {
                path: "/api/Transcoding/echo",
                fields: &[],
                body: "{\"anInt32\":1}"
            }
        ),
        posted(
            port,
            &Post {
                path: "/api/Transcoding/echo",
                fields: &[],
                body: "{\"anInt32\":2}"
            }
        ),
    );

    assert_eq!(
        (text_of(&one), text_of(&two)),
        ("{\"anInt32\":1}".to_owned(), "{\"anInt32\":2}".to_owned())
    );
    until(|| locked(&watched.closed).len() == 2).await;

    // * two exchanges, two connections, each of its caller's address, each closed
    let mut drawn = locked(&watched.drawn).clone();
    let mut closed = locked(&watched.closed).clone();

    drawn.sort();
    closed.sort();
    assert_eq!(drawn.len(), 2);
    assert_ne!(drawn[0], drawn[1]);
    assert!(
        drawn
            .iter()
            .all(|handle| handle.starts_with("type=MEMORY;ip=127.0.0.1;")),
        "{drawn:?}"
    );
    assert_eq!(drawn, closed);

    // a refusal of its own, or a body its reading refuses, draws none
    let unread = posted(
        port,
        &Post {
            path: "/api/Transcoding/echo",
            fields: &[],
            body: "{\"nope\":1}",
        },
    )
    .await;
    let unknown = asked(port, (&["GET /nope HTTP/1.1"], "")).await;

    assert_eq!((unread.head.status, unknown.head.status), (400, 404));
    assert_eq!(locked(&watched.drawn).len(), 2);

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gives_each_exchange_s_client_the_router_limits_it_is_given() {
    let limited = started_with((
        |options: &mut HttpGatewayOptions| {
            let mut limits = bead::RouterLimitsOptions::default();

            limits.maximum_payload_bytes = Some(16);
            options.limits = Some(limits);
        },
        true,
    ))
    .await;
    let unlimited = started().await;
    let past = format!("{{\"aString\":\"{}\"}}", letters('a', 40));

    // a request within its client's bound goes
    let within = posted(
        limited.port,
        &Post {
            path: "/api/Transcoding/echo",
            fields: &[],
            body: "{\"aString\":\"a\"}",
        },
    )
    .await;

    assert_eq!(
        (within.head.status, text_of(&within)),
        (200, "{\"aString\":\"a\"}".to_owned())
    );

    // * one past it refused by its exchange's own client before it goes, each exchange alike
    for _ in 1..=2 {
        let refused = posted(
            limited.port,
            &Post {
                path: "/api/Transcoding/echo",
                fields: &[],
                body: &past,
            },
        )
        .await;
        let problem = json_of(&refused);

        assert_eq!(refused.head.status, 413);
        assert_eq!(
            (&problem["code"], &problem["title"], &problem["detail"]),
            (
                &serde_json::json!(34),
                &serde_json::json!("PAYLOAD_TOO_LARGE"),
                &serde_json::json!("a payload is 16 bytes at most, not 42")
            )
        );
    }

    // a gateway given none holds by the defaults
    let echoed = posted(
        unlimited.port,
        &Post {
            path: "/api/Transcoding/echo",
            fields: &[],
            body: &past,
        },
    )
    .await;

    assert_eq!((echoed.head.status, text_of(&echoed)), (200, past.clone()));

    limited.dispose().await.expect("disposed");
    unlimited.dispose().await.expect("disposed");
}

// a POST to `whoAmI`, its authorization where it holds one
async fn who_am_i(port: u16, authorization: Option<String>) -> Response {
    let fields: Vec<String> = authorization
        .map(|value| format!("authorization: {value}"))
        .into_iter()
        .collect();
    let fields: Vec<&str> = fields.iter().map(String::as_str).collect();

    posted(
        port,
        &Post {
            path: "/api/Transcoding/whoAmI",
            fields: &fields,
            body: "{}",
        },
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn presents_the_authorization_field_elsewhere_or_as_a_jwt_under_bearer_jwt() {
    let elsewhere = started().await;
    let jwt = started_with((
        |options: &mut HttpGatewayOptions| {
            options.authorization = Some(GatewayAuthorization::BearerJwt);
        },
        true,
    ))
    .await;
    let who = who_am_i(elsewhere.port, Some(" Bearer good ".to_owned())).await;

    assert_eq!(
        (who.head.status, text_of(&who)),
        (200, "{\"session\":\"ada\"}".to_owned())
    );

    let none = who_am_i(elsewhere.port, None).await;
    let bad = who_am_i(elsewhere.port, Some("Bearer bad".to_owned())).await;

    assert_eq!(
        (none.head.status, field(&none, "www-authenticate")),
        (401, Some("Bearer"))
    );
    assert_eq!(
        (bad.head.status, field(&bad, "www-authenticate")),
        (401, Some("Bearer error=\"invalid_token\""))
    );

    // under bearer-jwt, a token presented as a JWT, which a server with no JWT verifier refuses
    let reported = reported_by(&jwt);
    let unsupported = who_am_i(jwt.port, Some("bearer a.b.c".to_owned())).await;
    let problem = json_of(&unsupported);

    assert_eq!(unsupported.head.status, 500);
    assert_eq!(
        (&problem["code"], &problem["title"]),
        (
            &serde_json::json!(36),
            &serde_json::json!("CREDENTIAL_UNSUPPORTED")
        )
    );

    let reported = locked(&reported).clone();

    assert_eq!(reported.len(), 1, "{reported:?}");
    assert!(
        reported[0].starts_with("the server takes none of the scheme this gateway presents: "),
        "{reported:?}"
    );

    let scheme = who_am_i(jwt.port, Some("Basic YTpi".to_owned())).await;

    assert_eq!(
        (scheme.head.status, field(&scheme, "www-authenticate")),
        (401, Some("Bearer error=\"invalid_request\""))
    );

    // a token its request's block holds, 1,004 bytes, and one past it
    let held = who_am_i(jwt.port, Some(format!("Bearer {}", letters('a', 1_004)))).await;
    let past = who_am_i(jwt.port, Some(format!("Bearer {}", letters('a', 1_005)))).await;

    assert_eq!((held.head.status, past.head.status), (500, 431));

    elsewhere.dispose().await.expect("disposed");
    jwt.dispose().await.expect("disposed");
}

// a request of `method` to `path` with the fetch metadata given, each field where it holds a value
// a request's method, its path, and its fetch metadata, each field where it holds a value
struct Fetch<'a> {
    method: &'a str,
    path: &'a str,
    metadata: &'a [(&'a str, Option<&'a str>)],
}

async fn fetched(
    port: u16,
    &Fetch {
        method,
        path,
        metadata,
    }: &Fetch<'_>,
) -> Response {
    let line = format!("{method} {path} HTTP/1.1");
    let fields: Vec<String> = metadata
        .iter()
        .filter_map(|(name, value)| value.map(|value| format!("{name}: {value}")))
        .collect();
    let mut lines = vec![line.as_str()];

    lines.extend(fields.iter().map(String::as_str));

    asked(port, (&lines, "")).await
}

// a request's site, its mode and its origin, each where it holds one
struct Metadata<'a> {
    site: Option<&'a str>,
    mode: Option<&'a str>,
    origin: Option<&'a str>,
}

// a GET's path, and its fetch metadata
struct Got<'a> {
    path: &'a str,
    metadata: Metadata<'a>,
}

// a GET of `path` from a site, in a mode, from an origin, each where it holds one
async fn got(port: u16, got: &Got<'_>) -> Response {
    let Got {
        path,
        metadata: Metadata { site, mode, origin },
    } = *got;

    fetched(
        port,
        &Fetch {
            method: "GET",
            path,
            metadata: &[
                ("sec-fetch-site", site),
                ("sec-fetch-mode", mode),
                ("origin", origin),
            ],
        },
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_request_with_no_origin_from_a_page_of_another_site_and_a_navigation_to_an_unmarked_get_rule()
 {
    let fixture = started().await;
    let port = fixture.port;

    // a navigation to what reads alone: the document, and a GET on a method marked NO_SIDE_EFFECTS
    let document = got(
        port,
        &Got {
            path: "/openapi.json",
            metadata: Metadata {
                site: Some("cross-site"),
                mode: Some("navigate"),
                origin: None,
            },
        },
    )
    .await;
    let marked = got(
        port,
        &Got {
            path: "/v1/books/2",
            metadata: Metadata {
                site: Some("cross-site"),
                mode: Some("navigate"),
                origin: None,
            },
        },
    )
    .await;

    assert_eq!((document.head.status, marked.head.status), (200, 200));

    // * an <img> of another site: no Origin, refused; a navigation to a get rule of a method not
    // marked NO_SIDE_EFFECTS: refused
    for (path, site, mode) in [
        ("/v1/books/2", "cross-site", "no-cors"),
        ("/v1/shelves/s/books", "cross-site", "navigate"),
        ("/v1/shelves/s/books", "same-site", "navigate"),
        ("/v1/operations", "same-site", "navigate"),
    ] {
        let refused = got(
            port,
            &Got {
                path,
                metadata: Metadata {
                    site: Some(site),
                    mode: Some(mode),
                    origin: None,
                },
            },
        )
        .await;

        assert_eq!(
            (refused.head.status, field(&refused, "bead-refusal")),
            (403, Some("origin-refused")),
            "{path} {site} {mode}"
        );
    }

    // its own origin's, and one from no browser, taken; an origin shown is judged by its own gate
    let own = got(
        port,
        &Got {
            path: "/v1/shelves/s/books",
            metadata: Metadata {
                site: Some("same-origin"),
                mode: Some("no-cors"),
                origin: None,
            },
        },
    )
    .await;
    let browserless = got(
        port,
        &Got {
            path: "/v1/shelves/s/books",
            metadata: Metadata {
                site: None,
                mode: None,
                origin: None,
            },
        },
    )
    .await;
    let shown = got(
        port,
        &Got {
            path: "/v1/shelves/s/books",
            metadata: Metadata {
                site: Some("cross-site"),
                mode: Some("no-cors"),
                origin: Some(ORIGIN),
            },
        },
    )
    .await;

    assert_eq!(
        (own.head.status, browserless.head.status, shown.head.status),
        (200, 200, 200)
    );

    fixture.dispose().await.expect("disposed");
}

// a navigation from another site, to `destination` where it names one
// a navigation's method, its path, and its destination where it names one
struct Navigation<'a> {
    method: &'a str,
    path: &'a str,
    destination: Option<&'a str>,
}

async fn navigated(
    port: u16,
    &Navigation {
        method,
        path,
        destination,
    }: &Navigation<'_>,
) -> Response {
    fetched(
        port,
        &Fetch {
            method,
            path,
            metadata: &[
                ("sec-fetch-site", Some("cross-site")),
                ("sec-fetch-mode", Some("navigate")),
                ("sec-fetch-dest", destination),
            ],
        },
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_head_navigation_and_one_an_object_or_an_embed_makes_from_another_site_to_a_route_and_to_the_document()
 {
    let fixture = started().await;
    let port = fixture.port;

    // a GET of a method marked NO_SIDE_EFFECTS, and the document
    for path in ["/v1/books/2", "/openapi.json"] {
        // * a GET a page or a frame navigates to, taken, as web.dev's resource isolation policy
        // takes one
        for destination in [None, Some("document"), Some("iframe")] {
            let taken = navigated(
                port,
                &Navigation {
                    method: "GET",
                    path,
                    destination,
                },
            )
            .await;

            assert_eq!(taken.head.status, 200, "{path} {destination:?}");
        }

        // a HEAD navigation, and a GET an object or an embed makes, refused
        for (method, destination) in [
            ("HEAD", None),
            ("HEAD", Some("document")),
            ("GET", Some("object")),
            ("GET", Some("embed")),
        ] {
            let refused = navigated(
                port,
                &Navigation {
                    method,
                    path,
                    destination,
                },
            )
            .await;

            assert_eq!(
                (refused.head.status, field(&refused, "bead-refusal")),
                (403, Some("origin-refused")),
                "{path} {method} {destination:?}"
            );
        }

        // a HEAD from no page of another site, taken
        let own = fetched(
            port,
            &Fetch {
                method: "HEAD",
                path,
                metadata: &[],
            },
        )
        .await;

        assert_eq!(own.head.status, 200, "{path}");
    }

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_a_call_whose_peer_closes_before_its_result_with_502_and_releases_its_place() {
    let mut options = gateway_options().expect("the gateway's options");
    let memory = options.transport.clone();

    options.maximum_exchanges = Some(1);
    memory.start().await.expect("started");

    let watched = watched_on(&memory);

    *locked(&watched.closing) = Some(memory.clone());

    let gateway = bead::HttpGateway::new(&options).expect("a gateway");
    let reported = Arc::new(Mutex::new(Vec::new()));
    let reporting = Arc::clone(&reported);

    gateway.on_error(Arc::new(move |error| {
        locked(&reporting).push(error.to_string());
    }));

    let mut start = bead::HttpGatewayStartOptions::default();

    start.address = Some(HOST.to_owned());
    start.port = Some(0);

    let port = gateway.start(&start).await.expect("listening").port;

    for _ in 0..2 {
        let answered = posted(
            port,
            &Post {
                path: "/api/Transcoding/echo",
                fields: &[],
                body: "{}",
            },
        )
        .await;

        assert_eq!(answered.head.status, 502);
        assert_eq!(
            field(&answered, "content-type"),
            Some("application/problem+json")
        );
        assert_eq!(
            text_of(&answered),
            "{\"detail\":\"the connection closed\",\"status\":502,\"title\":\"Bad Gateway\",\"type\":\"about:blank\"}"
        );
        assert_eq!(field(&answered, "bead-refusal"), None);
        until(|| memory.clients().is_empty()).await;
    }

    assert_eq!(watched.requests.load(Ordering::SeqCst), 2);
    assert_eq!(locked(&reported).len(), 2);

    gateway.dispose().await.expect("disposed");
    memory.dispose().await.expect("disposed");
}

// `watch`'s route, its procedure one its server does not know, 99
fn unknown_watch(route: &bead::HttpRoute) -> bead::HttpRoute {
    let mut procedure = route.procedure().procedure().clone();

    procedure.procedure_id = 99;

    let descriptor = bead::notifying_of(
        bead::DescriptorInit {
            procedure,
            admission: bead::AdmissionRule::None,
            failures: Vec::new(),
            request: ProtoCodec::<Empty>::new().expect("a codec"),
            result: ProtoCodec::<Empty>::new().expect("a codec"),
            validate: None,
        },
        ProtoCodec::<Tick>::new().expect("a codec"),
    )
    .expect("a descriptor");

    bead::route_of(bead::HttpRouteInit {
        procedure: bead::ServiceProcedure::from(&descriptor),
        request: route.request().clone(),
        result: route.result().clone(),
        notification: route.notification().cloned(),
        failures: route.failures().to_vec(),
        no_side_effects: route.no_side_effects(),
        routes: route.routes().to_vec(),
    })
    .expect("a route")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_a_failed_stream_request_as_a_problem_before_writing_any_event() {
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            let watch = TranscodingProcedures::get()
                .expect("its procedures")
                .watch
                .descriptor()
                .procedure()
                .procedure_id;

            options.maximum_connections = Some(1);
            options.routes = options
                .routes
                .iter()
                .map(|route| {
                    if route.procedure().procedure().procedure_id == watch {
                        unknown_watch(route)
                    } else {
                        route.clone()
                    }
                })
                .collect();
        },
        true,
    ))
    .await;
    let reported = reported_by(&fixture);
    let watched = watched_on(&fixture.memory);

    for count in 1..=2 {
        let answered = posted(
            fixture.port,
            &Post {
                path: "/api/Transcoding/watch",
                fields: &["accept: text/event-stream"],
                body: "{}",
            },
        )
        .await;

        assert_eq!(answered.head.status, 501);
        assert_eq!(
            field(&answered, "content-type"),
            Some("application/problem+json")
        );
        assert_eq!(
            text_of(&answered),
            "{\"code\":19,\"detail\":\"no procedure 99 in service 1\",\"scope\":\"protocol\",\"status\":501,\"title\":\"PROCEDURE_UNKNOWN\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PROCEDURE_UNKNOWN\"}"
        );
        assert_eq!(field(&answered, "bead-refusal"), None);
        until(|| locked(&watched.closed).len() == count).await;
        assert_eq!(locked(&watched.drawn).len(), count);
        assert_eq!(locked(&reported).len(), count);
    }

    fixture.dispose().await.expect("disposed");
}

// a preflight of `path` from the origin the file's defaults list, asking `method`
async fn preflight(port: u16, (path, method): (&str, &str)) -> Response {
    let line = format!("OPTIONS {path} HTTP/1.1");
    let origin = format!("origin: {ORIGIN}");
    let asks = format!("access-control-request-method: {method}");

    asked(
        port,
        (
            &[
                line.as_str(),
                origin.as_str(),
                asks.as_str(),
                "access-control-request-headers: content-type",
            ],
            "",
        ),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_a_preflight_with_the_methods_its_url_s_routes_take() {
    let fixture = started().await;
    let port = fixture.port;
    let book = preflight(port, ("/v1/shelves/1/books/2", "PATCH")).await;
    let echo = preflight(port, ("/api/Transcoding/echo", "PATCH")).await;

    assert_eq!(book.head.status, 204);
    assert_eq!(
        field(&book, "access-control-allow-methods"),
        Some("GET, HEAD, PATCH")
    );
    assert_eq!(
        field(&book, "access-control-allow-headers"),
        Some("authorization, content-type, *")
    );
    assert_eq!(field(&book, "access-control-allow-origin"), Some(ORIGIN));
    assert_eq!(field(&book, "access-control-max-age"), Some("7200"));
    assert_eq!(field(&echo, "access-control-allow-methods"), Some("POST"));

    for (path, methods) in [
        ("/v1/shelves/1/books/2:archive", "POST"),
        ("/api/Transcoding/getOperation", "GET, HEAD, POST"),
        ("/openapi.json", "GET, HEAD"),
    ] {
        let answered = preflight(port, (path, "PATCH")).await;

        assert_eq!(
            field(&answered, "access-control-allow-methods"),
            Some(methods),
            "{path}"
        );
    }

    // from an origin it does not name, refused before any preflight
    let refused = asked(
        port,
        (
            &[
                "OPTIONS /api/Transcoding/echo HTTP/1.1",
                "origin: https://other.example",
                "access-control-request-method: POST",
            ],
            "",
        ),
    )
    .await;

    assert_eq!(refused.head.status, 403);

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancels_the_call_of_a_request_aborted() {
    let fixture = started().await;
    let port = fixture.port;
    let hanging = opened(
        port,
        &octets_of(
            port,
            &OwnCase {
                lines: &["POST /api/Transcoding/hang HTTP/1.1", JSON],
                status: 0,
                words: "",
                body: "{}",
                reason: None,
            },
        ),
    )
    .await;

    until(|| fixture.counts.hanging.load(Ordering::SeqCst) == 1).await;
    hanging.destroy();

    // * its connection closed, its server ended its call as cancelled, its resolver told
    let cancels = asked(
        port,
        (&["GET /api/Transcoding/cancels?atLeast=1 HTTP/1.1"], ""),
    )
    .await;

    assert_eq!(text_of(&cancels), "{\"count\":1}");

    fixture.dispose().await.expect("disposed");

    // and a call past its timeout ends cancelled too, answered 504
    let timed = started_with((
        |options: &mut HttpGatewayOptions| {
            options.timeout = Some(Duration::from_millis(50));
        },
        true,
    ))
    .await;
    let answered = posted(
        timed.port,
        &Post {
            path: "/api/Transcoding/hang",
            fields: &[],
            body: "{}",
        },
    )
    .await;

    assert_eq!(answered.head.status, 504);
    until(|| timed.counts.cancelled.load(Ordering::SeqCst) == 1).await;

    timed.dispose().await.expect("disposed");
}

// ── Its routes, changed ───────────────────────────────────────────────────────

// a route of the table, its procedure, its result, or both given in their place
fn rebuilt(
    route: &bead::HttpRoute,
    (procedure, result): (Option<bead::ServiceProcedure>, Option<bead::HttpPayload>),
) -> bead::HttpRoute {
    bead::route_of(bead::HttpRouteInit {
        procedure: procedure.unwrap_or_else(|| route.procedure().clone()),
        request: route.request().clone(),
        result: result.unwrap_or_else(|| route.result().clone()),
        notification: route.notification().cloned(),
        failures: route.failures().to_vec(),
        no_side_effects: route.no_side_effects(),
        routes: route.routes().to_vec(),
    })
    .expect("a route")
}

// the table, the route of the procedure named changed as `change` says
fn changed_routes(
    routes: &[bead::HttpRoute],
    (name, change): (&str, &dyn Fn(&bead::HttpRoute) -> bead::HttpRoute),
) -> Vec<bead::HttpRoute> {
    routes
        .iter()
        .map(|route| {
            if route.procedure().procedure().procedure_name == name {
                change(route)
            } else {
                route.clone()
            }
        })
        .collect()
}

// `raw`'s procedure, its id one its server does not know, 99
fn unknown_raw(route: &bead::HttpRoute) -> bead::ServiceProcedure {
    let mut procedure = route.procedure().procedure().clone();

    procedure.procedure_id = 99;

    let descriptor = bead::request_of(bead::DescriptorInit {
        procedure,
        admission: bead::AdmissionRule::None,
        failures: Vec::new(),
        request: bead::RawCodec,
        result: bead::RawCodec,
        validate: None,
    })
    .expect("a descriptor");

    bead::ServiceProcedure::from(&descriptor)
}

// a POST of `bytes` to `raw`
async fn raw_of(port: u16, bytes: &[u8]) -> Response {
    let mut octets = format!(
        "POST /api/Transcoding/raw HTTP/1.1\r\nhost: {HOST}:{port}\r\ncontent-type: application/octet-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        bytes.len()
    )
    .into_bytes();

    octets.extend_from_slice(bytes);
    exchanged(port, &octets).await
}

// ── A clock that breaks ───────────────────────────────────────────────────────

// the platform's clock, which refuses to arm each timer `breaks` names, in its words, and counts
// each it refused
#[derive(Debug)]
struct Breaking {
    platform: bead::SystemClock,
    breaks: fn(&bead::Schedule) -> Option<&'static str>,
    attempts: AtomicUsize,
}

impl Breaking {
    fn shared(breaks: fn(&bead::Schedule) -> Option<&'static str>) -> Arc<Self> {
        Arc::new(Self {
            platform: bead::SystemClock::current().expect("the platform's clock"),
            breaks,
            attempts: AtomicUsize::new(0),
        })
    }
}

impl bead::Clock for Breaking {
    fn monotonic(&self) -> Duration {
        self.platform.monotonic()
    }

    fn wall(&self) -> std::time::SystemTime {
        self.platform.wall()
    }

    fn arm(
        &self,
        schedule: bead::Schedule,
        callback: bead::TimerCallback,
    ) -> Result<Arc<dyn bead::Timer>, bead::ProgrammerError> {
        if let Some(words) = (self.breaks)(&schedule) {
            self.attempts.fetch_add(1, Ordering::SeqCst);

            return Err(bead::ProgrammerError::new(words));
        }

        self.platform.arm(schedule, callback)
    }
}

// the platform's clock, but for each timer of `held` it holds until the test fires it: a call's
// timeout that passes as the test moves it, and no sooner
struct Holding {
    platform: bead::SystemClock,
    held: Duration,
    callbacks: Mutex<Vec<bead::TimerCallback>>,
}

// a timer the test fires, which nothing cancels
#[derive(Debug)]
struct HeldTimer;

impl bead::Timer for HeldTimer {
    fn cancel(&self) {}
}

impl core::fmt::Debug for Holding {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Holding")
            .field("held", &self.held)
            .finish_non_exhaustive()
    }
}

impl Holding {
    // fires each timer it holds, once
    fn fire(&self) {
        let callbacks: Vec<bead::TimerCallback> = core::mem::take(&mut *locked(&self.callbacks));

        for mut callback in callbacks {
            callback();
        }
    }
}

impl bead::Clock for Holding {
    fn monotonic(&self) -> Duration {
        self.platform.monotonic()
    }

    fn wall(&self) -> std::time::SystemTime {
        self.platform.wall()
    }

    fn arm(
        &self,
        schedule: bead::Schedule,
        callback: bead::TimerCallback,
    ) -> Result<Arc<dyn bead::Timer>, bead::ProgrammerError> {
        if matches!(schedule, bead::Schedule::Once(after) if after == self.held) {
            locked(&self.callbacks).push(callback);

            return Ok(Arc::new(HeldTimer));
        }

        self.platform.arm(schedule, callback)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn holds_each_caller_s_calls_and_streams_to_bounds_of_their_own() {
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            options.maximum_exchanges_per_address = Some(1);
            options.maximum_connections_per_address = Some(1);
        },
        true,
    ))
    .await;
    let port = fixture.port;
    let watch = octets_of(
        port,
        &OwnCase {
            lines: &[
                "POST /api/Transcoding/watch HTTP/1.1",
                JSON,
                "accept: text/event-stream",
            ],
            status: 0,
            words: "",
            body: "{}",
            reason: None,
        },
    );

    // * a stream holds one of its address's streams, and none of its calls
    let stream = opened(port, &watch).await;
    let head = stream.head(PATIENCE).await.expect("its head");
    let second = exchanged(port, &watch).await;
    let call = posted(
        port,
        &Post {
            path: "/api/Transcoding/echo",
            fields: &[],
            body: "{}",
        },
    )
    .await;

    assert_eq!(
        (head.status, second.head.status, call.head.status),
        (200, 503, 200)
    );
    assert_eq!(
        (
            field(&second, "bead-refusal"),
            field(&second, "retry-after")
        ),
        (Some("busy"), Some("1"))
    );

    // a call that hangs holds its address's one call, and a stream still opens beside none
    let hanging = opened(
        port,
        &octets_of(
            port,
            &OwnCase {
                lines: &["POST /api/Transcoding/hang HTTP/1.1", JSON],
                status: 0,
                words: "",
                body: "{}",
                reason: None,
            },
        ),
    )
    .await;

    until(|| fixture.counts.hanging.load(Ordering::SeqCst) == 1).await;

    let refused = posted(
        port,
        &Post {
            path: "/api/Transcoding/echo",
            fields: &[],
            body: "{}",
        },
    )
    .await;

    assert_eq!(refused.head.status, 503);
    assert_eq!(
        (
            field(&refused, "bead-refusal"),
            field(&refused, "retry-after")
        ),
        (Some("busy"), Some("1"))
    );

    // both freed as their exchanges end
    hanging.destroy();
    stream.destroy();
    until(|| fixture.counts.cancelled.load(Ordering::SeqCst) == 1).await;

    let mut freed = 503;

    patience(PATIENCE, async {
        while freed != 200 {
            freed = posted(
                port,
                &Post {
                    path: "/api/Transcoding/echo",
                    fields: &[],
                    body: "{}",
                },
            )
            .await
            .head
            .status;
        }
    })
    .await
    .expect("freed in time");

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_a_result_the_stock_library_refuses_502_reported_none_of_its_words_in_the_problem()
{
    // * raw's route told its result is an Edges: the bytes its server echoes, `x`, a varint cut
    // short
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            let form = bead_protobuf::JsonForm::new(Arc::clone(
                bead_protobuf::ProtoSchema::of::<Everything>().pool(),
            ));
            let edges =
                bead::HttpPayload::Message(form.form_of(bead_protobuf::ProtoSchema::of::<Edges>()));

            options.routes = changed_routes(
                &options.routes,
                ("raw", &|route| rebuilt(route, (None, Some(edges.clone())))),
            );
        },
        true,
    ))
    .await;
    let reported = reported_by(&fixture);
    let answered = raw_of(fixture.port, b"x").await;
    let body = text_of(&answered);

    assert_eq!(answered.head.status, 502);
    assert_eq!(
        body,
        "{\"code\":50,\"scope\":\"protocol\",\"status\":502,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}"
    );

    let told = locked(&reported).clone();

    assert_eq!(told.len(), 1, "{told:?}");
    assert!(!body.contains(told[0].as_str()), "{told:?}");

    // and one whose records its codec refuses first (spec 17.9.5): `at`, a message, as a varint
    let refused = raw_of(fixture.port, &[0x08, 0x00]).await;

    assert_eq!((refused.head.status, text_of(&refused)), (502, body));
    assert_eq!(locked(&reported).len(), 2);

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_503_destination_unreachable_when_its_connection_cannot_be_drawn_reported_none_of_its_words_in_the_problem()
 {
    let fixture = started().await;
    let reported = reported_by(&fixture);

    fixture.memory.dispose().await.expect("disposed");

    let answered = posted(
        fixture.port,
        &Post {
            path: "/api/Transcoding/echo",
            fields: &[],
            body: "{}",
        },
    )
    .await;

    assert_eq!(answered.head.status, 503);
    assert_eq!(field(&answered, "retry-after"), Some("1"));
    assert_eq!(
        text_of(&answered),
        "{\"code\":17,\"scope\":\"protocol\",\"status\":503,\"title\":\"DESTINATION_UNREACHABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/DESTINATION_UNREACHABLE\"}"
    );

    let reported = locked(&reported).clone();

    assert_eq!(reported.len(), 1, "{reported:?}");
    assert!(reported[0].ends_with(", not open"), "{reported:?}");

    fixture.dispose().await.expect("disposed");
}

// transcoding 7.6.28
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_what_no_gate_foresaw_500_reported_none_of_its_words_in_the_problem() {
    // * a clock that breaks as a body is read, past every gate: the Rust form, a clock that arms
    // no timer, its reading the platform's
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            options.clock = Some(Breaking::shared(|_| Some("the clock broke")));
        },
        true,
    ))
    .await;
    let reported = reported_by(&fixture);
    let drawn = drawn_by(&fixture);
    let answered = posted(
        fixture.port,
        &Post {
            path: "/api/Transcoding/echo",
            fields: &[],
            body: "{}",
        },
    )
    .await;

    assert_eq!(answered.head.status, 500);
    assert_eq!(drawn.count.load(Ordering::SeqCst), 0);
    assert_eq!(
        text_of(&answered),
        "{\"status\":500,\"title\":\"Internal Server Error\",\"type\":\"about:blank\"}"
    );
    assert_eq!(*locked(&reported), ["the clock broke"]);

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_a_route_s_variable_that_names_no_field_500_reported_none_of_its_words_in_the_problem()
 {
    // * getBook's route told its path is /v1/{nope}, which no field of its request names: a
    // programmer's error its binding meets, past every gate, before any connection is drawn
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            options.routes = changed_routes(
                &options.routes,
                ("getBook", &|route| {
                    bead::route_of(bead::HttpRouteInit {
                        procedure: route.procedure().clone(),
                        request: route.request().clone(),
                        result: route.result().clone(),
                        notification: route.notification().cloned(),
                        failures: route.failures().to_vec(),
                        no_side_effects: route.no_side_effects(),
                        routes: vec![bead::HttpRouteTemplate {
                            method: bead::HttpMethod::Get,
                            template: "/v1/{nope}".to_owned(),
                            body: None,
                            response_body: None,
                        }],
                    })
                    .expect("a route")
                }),
            );
        },
        true,
    ))
    .await;
    let reported = reported_by(&fixture);
    let drawn = drawn_by(&fixture);
    let answered = asked(fixture.port, (&["GET /v1/x HTTP/1.1"], "")).await;

    assert_eq!(answered.head.status, 500);
    assert_eq!(
        text_of(&answered),
        "{\"status\":500,\"title\":\"Internal Server Error\",\"type\":\"about:blank\"}"
    );
    assert_eq!(drawn.count.load(Ordering::SeqCst), 0);

    let reported = locked(&reported).clone();

    assert_eq!(reported.len(), 1, "{reported:?}");
    assert!(reported[0].contains("nope"), "{reported:?}");

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_500_a_connection_its_server_failed_to_draw_but_by_refusing_it_reported_with_no_detail()
 {
    // * the Rust form: its in-memory connect refused as it is made, its timer one its clock will
    // not arm; no socket port is past 65535, and its transport is the in-memory one, no stand-in
    let clock = Breaking::shared(|schedule| {
        matches!(schedule, bead::Schedule::Once(after) if *after == bead::CONNECT_TIMEOUT)
            .then_some("the transport broke")
    });
    let shared: bead::SharedClock = Arc::<Breaking>::clone(&clock);
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            options.clock = Some(shared);
        },
        true,
    ))
    .await;
    let reported = reported_by(&fixture);
    let answered = asked(fixture.port, (&["GET /v1/books/2 HTTP/1.1"], "")).await;

    assert_eq!(answered.head.status, 500);
    assert_eq!(
        text_of(&answered),
        "{\"status\":500,\"title\":\"Internal Server Error\",\"type\":\"about:blank\"}"
    );
    assert_eq!(clock.attempts.load(Ordering::SeqCst), 1);

    let reported = locked(&reported).clone();

    assert_eq!(reported.len(), 1, "{reported:?}");
    assert!(
        reported[0].starts_with("the transport broke"),
        "{reported:?}"
    );

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_500_without_detail_when_its_call_timer_fails() {
    let clock = Breaking::shared(|schedule| {
        matches!(schedule, bead::Schedule::Once(after) if *after == Duration::from_millis(54_321))
            .then_some("the call timer broke")
    });
    let shared: bead::SharedClock = Arc::<Breaking>::clone(&clock);
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            options.clock = Some(shared);
            options.timeout = Some(Duration::from_millis(54_321));
        },
        true,
    ))
    .await;
    let reported = reported_by(&fixture);
    let answered = asked(fixture.port, (&["GET /v1/books/2 HTTP/1.1"], "")).await;

    assert_eq!(answered.head.status, 500);
    assert_eq!(
        text_of(&answered),
        "{\"status\":500,\"title\":\"Internal Server Error\",\"type\":\"about:blank\"}"
    );
    assert_eq!(field(&answered, "bead-refusal"), None);
    assert_eq!(*locked(&reported), ["the call timer broke"]);
    assert_eq!(clock.attempts.load(Ordering::SeqCst), 1);
    until(|| fixture.memory.clients().is_empty()).await;

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reports_each_failure_it_answers_a_call_with_500_or_above_and_none_below() {
    // * a route of a procedure its server does not offer, 501; a call past its timeout, 504, on a
    // clock that moves only as the test moves it, so no call races its deadline
    let clock = Arc::new(Holding {
        platform: bead::SystemClock::current().expect("the platform's clock"),
        held: Duration::from_millis(50),
        callbacks: Mutex::new(Vec::new()),
    });
    let shared: bead::SharedClock = Arc::<Holding>::clone(&clock);
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            options.clock = Some(shared);
            options.timeout = Some(Duration::from_millis(50));
            options.routes = changed_routes(
                &options.routes,
                ("raw", &|route| {
                    rebuilt(route, (Some(unknown_raw(route)), None))
                }),
            );
        },
        true,
    ))
    .await;
    let reported = reported_by(&fixture);
    let port = fixture.port;
    let unknown = raw_of(port, b"x").await;

    assert_eq!(unknown.head.status, 501);
    assert_eq!(locked(&reported).len(), 1);

    // its resolver holds it: its timeout passes as the clock moves
    let hanging = opened(
        port,
        &octets_of(
            port,
            &OwnCase {
                lines: &["POST /api/Transcoding/hang HTTP/1.1", JSON],
                status: 0,
                words: "",
                body: "{}",
                reason: None,
            },
        ),
    )
    .await;

    until(|| fixture.counts.hanging.load(Ordering::SeqCst) == 1).await;
    clock.fire();

    let hung = hanging.response(PATIENCE).await.expect("a response");

    assert_eq!(hung.head.status, 504);
    assert_eq!(locked(&reported).len(), 2);

    // an application failure is the caller's, 400, and no session one, 401: reported none
    let failed = posted(
        port,
        &Post {
            path: "/api/Transcoding/fail",
            fields: &[],
            body: "{\"detail\":\"no\"}",
        },
    )
    .await;
    let unknown_session = posted(
        port,
        &Post {
            path: "/api/Transcoding/whoAmI",
            fields: &[],
            body: "{}",
        },
    )
    .await;

    assert_eq!(
        (failed.head.status, unknown_session.head.status),
        (400, 401)
    );
    assert_eq!(locked(&reported).len(), 2);

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_502_a_text_result_that_is_no_utf_8_reported_none_of_its_words_in_the_problem() {
    // * raw's route told its result is a text: the bytes its server echoes, FF, no UTF-8
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            options.routes = changed_routes(
                &options.routes,
                ("raw", &|route| {
                    rebuilt(route, (None, Some(bead::HttpPayload::Text)))
                }),
            );
        },
        true,
    ))
    .await;
    let reported = reported_by(&fixture);
    let answered = raw_of(fixture.port, &[0xFF]).await;

    assert_eq!(answered.head.status, 502);
    assert_eq!(
        text_of(&answered),
        "{\"code\":50,\"scope\":\"protocol\",\"status\":502,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}"
    );
    assert_eq!(locked(&reported).len(), 1);

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_304_a_request_for_the_document_under_an_if_none_match_of_any_entity_tag() {
    let fixture = started().await;
    let port = fixture.port;
    let served = asked(port, (&["GET /openapi.json HTTP/1.1"], "")).await;
    let etag = field(&served, "etag").expect("its tag").to_owned();

    // * any tag, among others or alone, and a weak tag of its own compared as its strong one
    for tag in [
        " * ".to_owned(),
        "\"other\", *".to_owned(),
        format!("W/{etag}"),
    ] {
        let matching = format!("if-none-match: {tag}");
        let held = asked(
            port,
            (&["GET /openapi.json HTTP/1.1", matching.as_str()], ""),
        )
        .await;

        assert_eq!(held.head.status, 304, "{tag}");
    }

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serves_its_document_to_a_head_and_to_a_preflight_that_asks_for_no_field() {
    let fixture = started().await;
    let port = fixture.port;
    let head = asked(port, (&["HEAD /openapi.json HTTP/1.1"], "")).await;
    let length = OPENAPI_DOCUMENT.len().to_string();

    assert_eq!(
        (head.head.status, field(&head, "content-length")),
        (200, Some(length.as_str()))
    );
    assert_eq!(head.body, Vec::<u8>::new());

    // a preflight from an origin it lists that asks for no field: GET and HEAD, authorization and
    // any other
    let origin = format!("origin: {ORIGIN}");
    let answered = asked(
        port,
        (
            &[
                "OPTIONS /openapi.json HTTP/1.1",
                origin.as_str(),
                "access-control-request-method: GET",
            ],
            "",
        ),
    )
    .await;

    assert_eq!(answered.head.status, 204);
    assert_eq!(
        field(&answered, "access-control-allow-methods"),
        Some("GET, HEAD")
    );
    assert_eq!(
        field(&answered, "access-control-allow-headers"),
        Some("authorization, *")
    );

    fixture.dispose().await.expect("disposed");
}

// a protocol refusal of PAYLOAD_UNDECODABLE, 400, in `detail`'s words
fn undecodable(detail: &str) -> String {
    format!(
        "{{\"code\":50,\"detail\":\"{detail}\",\"scope\":\"protocol\",\"status\":400,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}}"
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_query_beside_a_body_of_a_json_text_or_raw_route_and_a_variable_that_does_not_decode_400()
 {
    let fixture = started().await;
    let port = fixture.port;

    for (path, media_type, body) in [
        ("raw", "application/octet-stream", "x"),
        ("text", "text/plain", "x"),
        ("json", "application/json", "1"),
    ] {
        let line = format!("POST /api/Transcoding/{path}?a=1 HTTP/1.1");
        let typed = format!("content-type: {media_type}");
        let queried = asked(port, (&[line.as_str(), typed.as_str()], body)).await;

        assert_eq!(
            (queried.head.status, text_of(&queried)),
            (
                400,
                undecodable("a query beside a body of the whole request")
            ),
            "{path}"
        );
    }

    let undecoded = asked(port, (&["GET /v1/shelves/%FF/books/2 HTTP/1.1"], "")).await;

    assert_eq!(
        (undecoded.head.status, text_of(&undecoded)),
        (
            400,
            undecodable("a value whose bytes are not UTF-8")
                .replace("\"scope\"", "\"parameter\":\"name\",\"scope\"")
        )
    );

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn takes_its_hosts_and_proxies_from_its_policy_or_beside_it_and_refuses_one_given_in_both() {
    let policy_of = |unnamed_proxies: u64, with_hosts: bool| {
        let mut options = bead::HttpPolicyOptions::default();

        if with_hosts {
            options.hosts = Some(vec!["api.example".to_owned()]);
            options.trusted_proxies = Some(vec!["127.0.0.1".to_owned()]);
        }

        options.unnamed_proxies = Some(unnamed_proxies);

        bead::HttpPolicy::of(&options).expect("a policy")
    };
    let policy = policy_of(0, true);
    let from_policy = started_with((
        |options: &mut HttpGatewayOptions| {
            options.policy = Some(policy.clone());
        },
        true,
    ))
    .await;
    let beside = started_with((
        |options: &mut HttpGatewayOptions| {
            options.hosts = Some(vec!["api.example".to_owned()]);
            options.trusted_proxies = Some(vec!["127.0.0.1".to_owned()]);
            options.unnamed_proxies = Some(0);
        },
        true,
    ))
    .await;

    for fixture in [&from_policy, &beside] {
        let watched = watched_on(&fixture.memory);

        // * a host it takes, and its caller's address as the proxy it trusts forwards it
        let taken = asked(
            fixture.port,
            (
                &[
                    "GET /v1/books/2 HTTP/1.1",
                    "host: api.example",
                    "x-forwarded-for: 203.0.113.9",
                ],
                "",
            ),
        )
        .await;
        let refused = asked(
            fixture.port,
            (&["GET /v1/books/2 HTTP/1.1", "host: evil.example"], ""),
        )
        .await;

        assert_eq!((taken.head.status, refused.head.status), (200, 403));

        let drawn = locked(&watched.drawn).clone();

        assert_eq!(drawn.len(), 1, "{drawn:?}");
        assert!(
            drawn[0].starts_with("type=MEMORY;ip=203.0.113.9;"),
            "{drawn:?}"
        );
    }

    // a member given in its policy and beside it, whatever its value
    let mut options = gateway_options().expect("the gateway's options");

    options.hosts = Some(vec!["api.example".to_owned()]);
    options.policy = Some(policy.clone());

    assert_eq!(
        bead::HttpGateway::new(&options)
            .expect_err("refused")
            .to_string(),
        "hosts is given in the policy and beside it: give it once"
    );

    let mut options = gateway_options().expect("the gateway's options");

    options.unnamed_proxies = Some(0);
    options.policy = Some(policy_of(1, false));

    assert_eq!(
        bead::HttpGateway::new(&options)
            .expect_err("refused")
            .to_string(),
        "unnamedProxies is given in the policy and beside it: give it once"
    );

    from_policy.dispose().await.expect("disposed");
    beside.dispose().await.expect("disposed");
}

// the route of the table of the procedure named
fn route_named(name: &str) -> bead::HttpRoute {
    gateway_options()
        .expect("the gateway's options")
        .routes
        .into_iter()
        .find(|route| route.procedure().procedure().procedure_name == name)
        .expect("its route")
}

// a route of `route`'s procedure, at `templates` alone
fn templated(route: &bead::HttpRoute, templates: Vec<bead::HttpRouteTemplate>) -> bead::HttpRoute {
    bead::route_of(bead::HttpRouteInit {
        procedure: route.procedure().clone(),
        request: route.request().clone(),
        result: route.result().clone(),
        notification: route.notification().cloned(),
        failures: route.failures().to_vec(),
        no_side_effects: route.no_side_effects(),
        routes: templates,
    })
    .expect("a route")
}

fn template_of(
    (method, template): (bead::HttpMethod, &str),
    body: Option<&str>,
) -> bead::HttpRouteTemplate {
    bead::HttpRouteTemplate {
        method,
        template: template.to_owned(),
        body: body.map(str::to_owned),
        response_body: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_route_off_its_template_s_grammar_and_listens_once() {
    let options = gateway_options().expect("the gateway's options");
    let echo = route_named("echo");
    let crooked = templated(
        &echo,
        vec![template_of((bead::HttpMethod::Get, "/v1/{name"), None)],
    );
    let mut refused = options.clone();

    refused.routes = vec![crooked];

    // * a template off http.proto's grammar is refused as the gateway is built, naming its route
    let words = bead::HttpGateway::new(&refused)
        .expect_err("refused")
        .to_string();

    assert!(
        words.starts_with("echo's route GET /v1/{name: a variable that does not close"),
        "{words}"
    );

    // one that listens on localhost, its loopbacks, listens once; one that listens on none stops at
    // once
    let fixture = TranscodingFixture::start(&TranscodingFixtureOptions::new(&options))
        .await
        .expect("the fixture");
    let gateway = bead::HttpGateway::new(&options).expect("a gateway");
    let mut start = bead::HttpGatewayStartOptions::default();

    start.find_open_port = Some(true);

    let address = gateway.start(&start).await.expect("listening");

    assert_eq!(address.address, "localhost");
    assert_eq!(
        gateway
            .start(&start)
            .await
            .expect_err("refused")
            .to_string(),
        "a gateway listens once"
    );

    let book = asked(
        address.port,
        (&["GET /v1/books/2 HTTP/1.1", "host: localhost"], ""),
    )
    .await;

    assert_eq!(book.head.status, 200);

    // a port another listener holds: its listen fails, and it listens on none
    let mut taken = bead::HttpGatewayStartOptions::default();

    taken.address = Some(HOST.to_owned());
    taken.port = Some(fixture.port);

    let second = bead::HttpGateway::new(&options).expect("a gateway");

    second.start(&taken).await.expect_err("its port held");
    second.stop().await.expect("stopped");

    let never = bead::HttpGateway::new(&options).expect("a gateway");

    never.stop().await.expect("stopped");
    gateway.dispose().await.expect("disposed");
    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_route_table_of_two_routes_of_one_method_that_tie_naming_both() {
    let options = gateway_options().expect("the gateway's options");
    let echo = route_named("echo");
    let tying = templated(
        &echo,
        vec![template_of((bead::HttpMethod::Get, "/v1/books/{id}"), None)],
    );
    let beside = templated(
        &echo,
        vec![template_of(
            (bead::HttpMethod::Post, "/v1/books/{id}"),
            Some("*"),
        )],
    );
    let mut tied = options.clone();

    tied.routes.push(tying);

    // * two tables built apart and joined: the tie no builder saw is refused as the gateway is built
    assert_eq!(
        bead::HttpGateway::new(&tied)
            .expect_err("refused")
            .to_string(),
        "echo's route GET /v1/books/{id} ties getBook's route GET /v1/books/{name}"
    );

    // a route of another method at that template ties none
    let mut untied = options.clone();

    untied.routes.push(beside);

    let gateway = bead::HttpGateway::new(&untied).expect("a gateway");

    gateway.stop().await.expect("stopped");
}

// a transport that answers each request `ok` and keeps its payload, standing for a server
#[derive(Debug, Default)]
struct Answering {
    connections: AtomicUsize,
    requests: Mutex<Vec<Vec<u8>>>,
    memory: Mutex<Option<bead::MemoryTransportServer>>,
}

impl ServerListener for Answering {
    fn on_connection(&self, _connection_handle: &ConnectionHandle) {
        self.connections.fetch_add(1, Ordering::SeqCst);
    }

    fn on_message(&self, message: bead::TransportMessage, connection_handle: &ConnectionHandle) {
        let Some(memory) = locked(&self.memory).clone() else {
            return;
        };
        let bead::internal::Envelope::Request { header, payload } =
            bead::testing::scripted::envelope_of(&message.data, bead::RouterSide::Server)
        else {
            return;
        };

        locked(&self.requests).push(payload.to_vec());

        let result = bead::internal::Envelope::Result {
            header: bead::ResultHeader {
                call_id: header.call_id,
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(b"ok"),
        };
        let mut reply = bead::TransportMessage::default();

        reply.data = bead::internal::write_envelope(&result, 1024).expect("an envelope");
        drop(memory.send(reply, connection_handle));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_message_that_leaves_a_proto2_required_field_unset_before_calling_its_peer_and_binds_one_set_at_its_default()
 {
    // * the Rust form: `Needs`, a proto2 message of the file's own, its first field required, in
    // place of the C# side's `NamePart`, which writes alike
    let mut options = gateway_options().expect("the gateway's options");
    let memory = options.transport.clone();
    let form = bead_protobuf::JsonForm::new(Arc::clone(
        bead_protobuf::ProtoSchema::of::<Everything>().pool(),
    ));
    let raw = route_named("raw");

    options.routes = vec![
        bead::route_of(bead::HttpRouteInit {
            procedure: raw.procedure().clone(),
            request: bead::HttpPayload::Message(
                form.form_of(bead_protobuf::ProtoSchema::of::<Needs>()),
            ),
            result: raw.result().clone(),
            notification: None,
            failures: raw.failures().to_vec(),
            no_side_effects: raw.no_side_effects(),
            routes: raw.routes().to_vec(),
        })
        .expect("a route"),
    ];
    memory.start().await.expect("started");

    let answering = Arc::new(Answering::default());

    *locked(&answering.memory) = Some(memory.clone());
    memory.listen(Arc::<Answering>::clone(&answering));

    let gateway = bead::HttpGateway::new(&options).expect("a gateway");
    let reported = Arc::new(Mutex::new(Vec::<String>::new()));
    let reporting = Arc::clone(&reported);

    gateway.on_error(Arc::new(move |error| {
        locked(&reporting).push(error.to_string());
    }));

    let mut start = bead::HttpGatewayStartOptions::default();

    start.address = Some(HOST.to_owned());
    start.port = Some(0);

    let port = gateway.start(&start).await.expect("listening").port;

    // * step 4 of transcoding 5.2: the client's own request, 400, at the first field unset by number
    let missing = posted(
        port,
        &Post {
            path: "/api/Transcoding/raw",
            fields: &[],
            body: "{}",
        },
    )
    .await;

    assert_eq!(missing.head.status, 400);
    assert_eq!(
        field(&missing, "content-type"),
        Some("application/problem+json")
    );
    assert_eq!(field(&missing, "bead-refusal"), None);
    assert_eq!(
        text_of(&missing),
        "{\"code\":50,\"detail\":\"a required field unset\",\"pointer\":\"#/name\",\"scope\":\"protocol\",\"status\":400,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}"
    );
    assert_eq!(*locked(&reported), Vec::<String>::new());
    assert_eq!(answering.connections.load(Ordering::SeqCst), 0);
    assert_eq!(*locked(&answering.requests), Vec::<Vec<u8>>::new());

    for body in [
        "{\"name\":\"Ada\",\"count\":0}",
        "{\"name\":\"\",\"count\":0}",
    ] {
        let answered = posted(
            port,
            &Post {
                path: "/api/Transcoding/raw",
                fields: &[],
                body,
            },
        )
        .await;

        assert_eq!(answered.head.status, 200, "{body}");
        assert_eq!(
            field(&answered, "content-type"),
            Some("application/octet-stream")
        );
        assert_eq!(field(&answered, "bead-refusal"), None);
        assert_eq!(text_of(&answered), "ok");
    }

    assert_eq!(
        *locked(&answering.requests),
        [vec![10, 3, 65, 100, 97, 16, 0], vec![10, 0, 16, 0]]
    );
    assert_eq!(answering.connections.load(Ordering::SeqCst), 2);
    assert_eq!(*locked(&reported), Vec::<String>::new());
    until(|| memory.clients().is_empty()).await;

    gateway.dispose().await.expect("disposed");
    memory.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_502_to_a_result_that_leaves_a_required_field_unset_and_reports_it() {
    // * the bytes its server echoes, `10 01`, a Needs of a count and no name (spec 17.9.7)
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            let form = bead_protobuf::JsonForm::new(Arc::clone(
                bead_protobuf::ProtoSchema::of::<Everything>().pool(),
            ));
            let needs =
                bead::HttpPayload::Message(form.form_of(bead_protobuf::ProtoSchema::of::<Needs>()));

            options.routes = changed_routes(
                &options.routes,
                ("raw", &|route| rebuilt(route, (None, Some(needs.clone())))),
            );
        },
        true,
    ))
    .await;
    let reported = reported_by(&fixture);
    let answered = raw_of(fixture.port, &[0x10, 0x01]).await;

    assert_eq!(answered.head.status, 502);
    assert_eq!(
        text_of(&answered),
        "{\"code\":50,\"scope\":\"protocol\",\"status\":502,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}"
    );
    assert_eq!(*locked(&reported), ["a required field unset"]);

    fixture.dispose().await.expect("disposed");
}

// ── Mounted under hyper, read before ──────────────────────────────────────────

// a body put back whole, its length exact, as a server that buffered it hands it on
struct PutBack(Option<Bytes>);

impl Body for PutBack {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        Poll::Ready(self.0.take().map(|bytes| Ok(Frame::data(bytes))))
    }

    fn is_end_stream(&self) -> bool {
        self.0.is_none()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        http_body::SizeHint::with_exact(
            self.0
                .as_ref()
                .map_or(0, |bytes| u64::try_from(bytes.len()).unwrap_or(u64::MAX)),
        )
    }
}

// what a body gives, to its end
async fn drained<B: Body<Data = Bytes> + Unpin>(body: &mut B) -> Vec<u8> {
    let mut read = Vec::new();

    while let Some(frame) = poll_fn(|context| Pin::new(&mut *body).poll_frame(context)).await {
        if let Ok(frame) = frame
            && let Ok(data) = frame.into_data()
        {
            read.extend_from_slice(&data);
        }
    }

    read
}

// the gateway mounted by hyper's `service_fn` on each socket a listener accepts, over HTTP/1.1 or
// HTTP/2 with no TLS, behind a reader its request's `x-reader` names: `put-back`, its body read
// whole and put back with its exact length; `partial`, one frame of it read and the same request
// handed on; `emptied`, read whole and an empty one of an exact length of 0 handed in its place;
// `taken` and `replaced`
// as `mounted_behind_reader`'s; none, the request as it came
async fn mounted_on(gateway: bead::HttpGateway, is_http2: bool) -> u16 {
    let listener = tokio::net::TcpListener::bind((HOST, 0))
        .await
        .expect("bound");
    let port = listener.local_addr().expect("its address").port();

    drop(bead::testing::spawn(async move {
        while let Ok((socket, peer)) = listener.accept().await {
            let gateway = gateway.clone();
            let service =
                hyper::service::service_fn(move |request: http::Request<hyper::body::Incoming>| {
                    let gateway = gateway.clone();

                    async move {
                        let reader = request
                            .headers()
                            .get("x-reader")
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned);
                        let (parts, mut body) = request.into_parts();
                        let peer = Some(peer);
                        let response = match reader.as_deref() {
                            Some("put-back") => {
                                let read = drained(&mut body).await;

                                gateway
                                    .answer(
                                        http::Request::from_parts(
                                            parts,
                                            PutBack(Some(Bytes::from(read))),
                                        ),
                                        peer,
                                    )
                                    .await
                            }
                            Some("partial") => {
                                drop(
                                    poll_fn(|context| Pin::new(&mut body).poll_frame(context))
                                        .await,
                                );

                                gateway
                                    .answer(http::Request::from_parts(parts, body), peer)
                                    .await
                            }
                            Some("taken") => {
                                drained(&mut body).await;

                                gateway
                                    .answer(http::Request::from_parts(parts, body), peer)
                                    .await
                            }
                            Some("emptied") => {
                                drained(&mut body).await;

                                gateway
                                    .answer(http::Request::from_parts(parts, PutBack(None)), peer)
                                    .await
                            }
                            Some("replaced") => {
                                gateway
                                    .answer(
                                        http::Request::from_parts(
                                            parts,
                                            Left {
                                                is_end_stream: true,
                                            },
                                        ),
                                        peer,
                                    )
                                    .await
                            }
                            _ => {
                                gateway
                                    .answer(http::Request::from_parts(parts, body), peer)
                                    .await
                            }
                        };

                        Ok::<_, std::convert::Infallible>(response)
                    }
                });

            drop(bead::testing::spawn(async move {
                let io = hyper_util::rt::TokioIo::new(socket);

                if is_http2 {
                    drop(
                        hyper::server::conn::http2::Builder::new(
                            hyper_util::rt::TokioExecutor::new(),
                        )
                        .serve_connection(io, service)
                        .await,
                    );
                } else {
                    drop(
                        hyper::server::conn::http1::Builder::new()
                            .serve_connection(io, service)
                            .await,
                    );
                }
            }));
        }
    }));

    port
}

// a POST over HTTP/1.1 to a mounted gateway, its fields and its body as given, its socket closed
// after it
fn mounted_octets(port: u16, &Post { path, fields, body }: &Post<'_>) -> Vec<u8> {
    let mut lines = vec![
        format!("POST {path} HTTP/1.1"),
        format!("host: {HOST}:{port}"),
    ];

    lines.extend(fields.iter().map(|field| (*field).to_owned()));
    lines.extend([
        "connection: close".to_owned(),
        String::new(),
        body.to_owned(),
    ]);
    lines.join("\r\n").into_bytes()
}

// a POST over HTTP/2 with no TLS to a mounted gateway: its body `chunks`, with no content-length,
// its reader named; its status and its body
// a POST over HTTP/2: its path, its media type, its reader, and its body's chunks
struct Http2Post<'a> {
    path: &'a str,
    media_type: &'a str,
    reader: &'a str,
    chunks: Vec<Bytes>,
}

async fn posted_over_http2(port: u16, given: &Http2Post<'_>) -> (u16, Vec<u8>) {
    let Http2Post {
        path,
        media_type,
        reader,
        ref chunks,
    } = *given;

    let socket = tokio::net::TcpStream::connect(address_of(port))
        .await
        .expect("a socket to the server");
    let (mut sender, connection) = hyper::client::conn::http2::handshake(
        hyper_util::rt::TokioExecutor::new(),
        hyper_util::rt::TokioIo::new(socket),
    )
    .await
    .expect("its handshake");

    drop(bead::testing::spawn(async move {
        drop(connection.await);
    }));

    let request = http::Request::builder()
        .method("POST")
        .uri(format!("http://{HOST}:{port}{path}"))
        .header("content-type", media_type)
        .header("x-reader", reader)
        .body(Handed(chunks.clone()))
        .expect("a request");
    let response = patience(PATIENCE, sender.send_request(request))
        .await
        .expect("answered in time")
        .expect("a response");
    let status = response.status().as_u16();
    let mut body = response.into_body();

    (status, drained(&mut body).await)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serves_a_route_whose_target_holds_a_hash_cut_at_it_as_hyper_hands_it_on() {
    // * hyper's `http::Uri` cuts a target at its `#`: the route of the cut path answers, its
    // variables bound from it, on its own listener and mounted
    let fixture = started().await;
    let mounted = started_with((|_: &mut HttpGatewayOptions| {}, false)).await;
    let port = mounted_on(mounted.gateway.clone(), false).await;

    for (at, where_) in [(fixture.port, "its own listener"), (port, "mounted")] {
        let answered = asked(at, (&["GET /v1/books/a#b HTTP/1.1"], "")).await;

        assert_eq!(
            (answered.head.status, text_of(&answered)),
            (200, "{\"name\":\"a\",\"title\":\"A tale\"}".to_owned()),
            "{where_}"
        );
    }

    fixture.dispose().await.expect("disposed");
    mounted.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_from_its_start_a_body_the_server_it_is_mounted_on_buffered() {
    let fixture = started_with((|_: &mut HttpGatewayOptions| {}, false)).await;
    let reported = reported_by(&fixture);
    let drawn = drawn_by(&fixture);
    let port = mounted_on(fixture.gateway.clone(), false).await;
    let mut parted = Vec::new();

    for (framing, fields, body) in [
        ("content-length", "content-length: 13", "{\"anInt32\":1}"),
        (
            "chunked",
            "transfer-encoding: chunked",
            "d\r\n{\"anInt32\":1}\r\n0\r\n\r\n",
        ),
    ] {
        let before = drawn.count.load(Ordering::SeqCst);
        let answered = exchanged(
            port,
            &mounted_octets(
                port,
                &Post {
                    path: "/api/Transcoding/echo",
                    fields: &[JSON, fields, "x-reader: put-back"],
                    body,
                },
            ),
        )
        .await;
        let made = drawn.count.load(Ordering::SeqCst) - before;

        // * a body put back whole with its exact length is read from its start, its call made
        if (answered.head.status, text_of(&answered).as_str(), made) != (200, "{\"anInt32\":1}", 1)
        {
            parted.push(format!(
                "{framing}: {} {}, {made} call(s)",
                answered.head.status,
                text_of(&answered)
            ));
        }
    }

    assert_eq!(parted, Vec::<String>::new());
    assert_eq!(*locked(&reported), Vec::<String>::new());

    fixture.dispose().await.expect("disposed");
}

// transcoding 10.1.10
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_a_body_that_came_empty_as_empty_whatever_read_it_before() {
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            options.body_grace_period = Some(Duration::from_millis(100));
            options.maximum_exchanges_per_address = Some(1);
        },
        false,
    ))
    .await;
    let reported = reported_by(&fixture);
    let port = mounted_on(fixture.gateway.clone(), false).await;
    let untouched = exchanged(
        port,
        &mounted_octets(
            port,
            &Post {
                path: "/api/Transcoding/echo",
                fields: &[JSON, "content-length: 0"],
                body: "",
            },
        ),
    )
    .await;

    assert_eq!(
        (untouched.head.status, field(&untouched, "content-type")),
        (400, Some("application/problem+json"))
    );

    let mut parted = Vec::new();

    // * a `content-length: 0` body, read to its end, put back or replaced by an ended body, is read
    // as the empty body it came as
    for reader in ["taken", "put-back", "replaced"] {
        let marked = format!("x-reader: {reader}");
        let answered = exchanged(
            port,
            &mounted_octets(
                port,
                &Post {
                    path: "/api/Transcoding/echo",
                    fields: &[JSON, "content-length: 0", marked.as_str()],
                    body: "",
                },
            ),
        )
        .await;

        if (
            answered.head.status,
            field(&answered, "bead-refusal"),
            &answered.body,
        ) != (untouched.head.status, None, &untouched.body)
        {
            parted.push(format!(
                "{reader}, content-length: 0: {} {:?} {}",
                answered.head.status,
                field(&answered, "bead-refusal"),
                text_of(&answered)
            ));
        }
    }

    assert_eq!(parted, Vec::<String>::new());
    assert_eq!(*locked(&reported), Vec::<String>::new());

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_500_an_untouched_chunked_body_that_came_empty_over_http_1_1_as_one_read_before_it()
{
    // * over HTTP/1.1, an untouched chunked body that came empty shows hyper what one read to its
    // end before it shows: refused alike, failing closed, its call never made
    let fixture = started_with((|_: &mut HttpGatewayOptions| {}, false)).await;
    let reported = reported_by(&fixture);
    let drawn = drawn_by(&fixture);
    let port = mounted_on(fixture.gateway.clone(), false).await;
    let answered = exchanged(
        port,
        &mounted_octets(
            port,
            &Post {
                path: "/api/Transcoding/echo",
                fields: &[JSON, "transfer-encoding: chunked"],
                body: "0\r\n\r\n",
            },
        ),
    )
    .await;

    assert_eq!(answered.head.status, 500);
    assert_eq!(field(&answered, "bead-refusal"), None);
    assert_eq!(
        text_of(&answered),
        "{\"status\":500,\"title\":\"Internal Server Error\",\"type\":\"about:blank\"}"
    );
    assert_eq!(
        *locked(&reported),
        ["a body read before the gateway took its request"]
    );
    assert_eq!(drawn.count.load(Ordering::SeqCst), 0);

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_what_is_left_of_a_body_hyper_shows_unread_a_chunked_one_read_in_part_and_an_empty_one_handed_in_its_place()
 {
    let fixture = started_with((|_: &mut HttpGatewayOptions| {}, false)).await;
    let reported = reported_by(&fixture);
    let over_http1 = mounted_on(fixture.gateway.clone(), false).await;
    let over_http2 = mounted_on(fixture.gateway.clone(), true).await;

    // * over HTTP/1.1, a chunked body read in part and the same request handed on: read as what is
    // left, its call made with it
    let partial = exchanged(
        over_http1,
        &mounted_octets(
            over_http1,
            &Post {
                path: "/api/Transcoding/raw",
                fields: &[
                    "content-type: application/octet-stream",
                    "transfer-encoding: chunked",
                    "x-reader: partial",
                ],
                body: "2\r\nab\r\n2\r\ncd\r\n0\r\n\r\n",
            },
        ),
    )
    .await;

    assert_eq!(
        (partial.head.status, text_of(&partial)),
        (200, "cd".to_owned())
    );

    // over HTTP/2 with no content-length, a body read whole and an ended one handed in its place:
    // read as empty, a raw route called with an empty payload
    let emptied = posted_over_http2(
        over_http2,
        &Http2Post {
            path: "/api/Transcoding/raw",
            media_type: "application/octet-stream",
            reader: "emptied",
            chunks: vec![Bytes::from_static(b"ab"), Bytes::from_static(b"cd")],
        },
    )
    .await;

    assert_eq!(emptied, (200, Vec::new()));

    // and a JSON route, refused 400 as an empty body
    let json = posted_over_http2(
        over_http2,
        &Http2Post {
            path: "/api/Transcoding/echo",
            media_type: "application/json",
            reader: "emptied",
            chunks: vec![Bytes::from_static(b"{}")],
        },
    )
    .await;

    assert_eq!(json.0, 400);
    assert_eq!(*locked(&reported), Vec::<String>::new());

    fixture.dispose().await.expect("disposed");
}

// ── Its edges, its events and its pace ────────────────────────────────────────

// a socket to `port` that sent `octets`, read as the test reads it
async fn sent(port: u16, octets: &[u8]) -> tokio::net::TcpStream {
    use tokio::io::AsyncWriteExt as _;

    let mut socket = tokio::net::TcpStream::connect(address_of(port))
        .await
        .expect("a socket to the gateway");

    socket.write_all(octets).await.expect("its request written");
    socket
}

// what comes on `socket` until `text` is among it, as it comes, chunks and all
async fn read_until(socket: &mut tokio::net::TcpStream, text: &str) -> String {
    use tokio::io::AsyncReadExt as _;

    let mut read = Vec::new();
    let mut buffer = vec![0_u8; 16_384];

    patience(PATIENCE, async {
        while !String::from_utf8_lossy(&read).contains(text) {
            let count = socket.read(&mut buffer).await.expect("its bytes");

            assert_ne!(count, 0, "its socket ended before {text:?}");
            read.extend_from_slice(&buffer[..count]);
        }
    })
    .await
    .expect("read in time");

    String::from_utf8_lossy(&read).into_owned()
}

// how many bytes come on `socket` before it ends
async fn received_on(mut socket: tokio::net::TcpStream) -> usize {
    use tokio::io::AsyncReadExt as _;

    let mut buffer = vec![0_u8; 16_384];
    let mut received = 0_usize;

    patience(PATIENCE, async {
        while let Ok(count) = socket.read(&mut buffer).await
            && count > 0
        {
            received = received.saturating_add(count);
        }
    })
    .await
    .expect("ended in time");

    received
}

// a request of its line alone, its socket closed after it
fn line_octets(port: u16, line: &str) -> Vec<u8> {
    octets_of(
        port,
        &OwnCase {
            lines: &[line],
            status: 0,
            words: "",
            body: "",
            reason: None,
        },
    )
}

// a stream's request to `watch`, its socket closed after it
fn watch_octets(port: u16) -> Vec<u8> {
    octets_of(
        port,
        &OwnCase {
            lines: &[
                "POST /api/Transcoding/watch HTTP/1.1",
                JSON,
                "accept: text/event-stream",
            ],
            status: 0,
            words: "",
            body: "{}",
            reason: None,
        },
    )
}

// a route of the table, its notification given in its place
fn notifying(route: &bead::HttpRoute, notification: bead::HttpPayload) -> bead::HttpRoute {
    bead::route_of(bead::HttpRouteInit {
        procedure: route.procedure().clone(),
        request: route.request().clone(),
        result: route.result().clone(),
        notification: Some(notification),
        failures: route.failures().to_vec(),
        no_side_effects: route.no_side_effects(),
        routes: route.routes().to_vec(),
    })
    .expect("a route")
}

// the application's own answer or its gateway's, one body for both
enum Mounted {
    Own(Option<Bytes>),
    Gateway(HttpGatewayBody),
}

impl Body for Mounted {
    type Data = Bytes;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        match self.get_mut() {
            Self::Own(bytes) => Poll::Ready(bytes.take().map(|bytes| Ok(Frame::data(bytes)))),
            Self::Gateway(body) => Pin::new(body).poll_frame(context),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_as_the_endpoint_an_application_maps_and_a_caller_of_no_address_as_local() {
    // * the Rust form: `answer` mounted by hyper's `service_fn` on each socket its application
    // accepts, which answers its own path first; a path no route matches is 404 `path-unknown`, as
    // the endpoint the C# side maps answers it, and a request handed on with no peer, as a test
    // host's, is local
    let fixture = started_with((|_: &mut HttpGatewayOptions| {}, false)).await;
    let drawn = drawn_by(&fixture);
    let listener = tokio::net::TcpListener::bind((HOST, 0))
        .await
        .expect("bound");
    let port = listener.local_addr().expect("its address").port();
    let gateway = fixture.gateway.clone();
    let application = bead::testing::spawn(async move {
        while let Ok((socket, peer)) = listener.accept().await {
            let gateway = gateway.clone();
            let service =
                hyper::service::service_fn(move |request: http::Request<hyper::body::Incoming>| {
                    let gateway = gateway.clone();

                    async move {
                        if request.uri().path() == "/own" {
                            return Ok::<_, core::convert::Infallible>(http::Response::new(
                                Mounted::Own(Some(Bytes::from_static(b"its own"))),
                            ));
                        }

                        let peer = (!request.headers().contains_key("x-handed")).then_some(peer);

                        Ok(gateway.answer(request, peer).await.map(Mounted::Gateway))
                    }
                });

            drop(bead::testing::spawn(async move {
                drop(
                    hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(socket), service)
                        .await,
                );
            }));
        }
    });
    let own = asked(port, (&["GET /own HTTP/1.1"], "")).await;
    let book = asked(port, (&["GET /v1/books/2 HTTP/1.1"], "")).await;
    let none = asked(port, (&["GET /nope HTTP/1.1"], "")).await;

    assert_eq!(text_of(&own), "its own");
    assert_eq!(
        (book.head.status, text_of(&book)),
        (200, "{\"name\":\"2\",\"title\":\"A tale\"}".to_owned())
    );
    assert_eq!(
        (none.head.status, field(&none, "bead-refusal")),
        (404, Some("path-unknown"))
    );

    // an exchange handed on with no peer, as a test host's: its caller is local
    let handed = asked(port, (&["GET /v1/books/2 HTTP/1.1", "x-handed: local"], "")).await;

    assert_eq!(handed.head.status, 200);
    assert_eq!(
        locked(&drawn.peers)
            .last()
            .map(|(address, _)| address.clone()),
        Some("local".to_owned())
    );

    application.abort();
    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn answers_each_request_at_the_edges_of_its_gates() {
    let fixture = started().await;
    let port = fixture.port;

    // * a field of a control character: what HTTP refuses of its own, unmarked, its body empty
    let bell = asked(
        port,
        (&["GET /v1/books/2 HTTP/1.1", "x-other: a\u{7}b"], ""),
    )
    .await;

    assert_eq!(
        (
            bell.head.status,
            field(&bell, "bead-refusal"),
            text_of(&bell)
        ),
        (400, None, String::new())
    );

    // an absolute-form target: its path and query, its authority aside
    let line = format!("GET http://{HOST}:{port}/v1/books/2?revision=3 HTTP/1.1");
    let absolute = asked(port, (&[line.as_str()], "")).await;

    assert_eq!(
        (absolute.head.status, text_of(&absolute)),
        (
            200,
            "{\"name\":\"2\",\"title\":\"A tale\",\"pages\":\"3\"}".to_owned()
        )
    );

    // a range of application/* weighed below text/event-stream: a stream; a weight it cannot read
    // is 1
    for accept in [
        "application/*;q=0.5, text/event-stream",
        "text/event-stream;q=x;level, application/json",
    ] {
        let field = format!("accept: {accept}");
        let octets = octets_of(
            port,
            &OwnCase {
                lines: &["POST /api/Transcoding/watch HTTP/1.1", JSON, &field],
                status: 0,
                words: "",
                body: "{}",
                reason: None,
            },
        );
        let mut stream = sent(port, &octets).await;

        assert!(
            read_until(&mut stream, "data: {}\n\n")
                .await
                .contains("event: result\nid: 1\ndata: {}\n\n"),
            "{accept}"
        );
    }

    // a raw route's query of empty parameters alone binds nothing, a charset quoted and an
    // identity encoding are taken
    for lines in [
        &[
            "POST /api/Transcoding/raw?& HTTP/1.1",
            "content-type: application/octet-stream",
        ][..],
        &[
            "POST /api/Transcoding/raw HTTP/1.1",
            "content-type: application/octet-stream; charset=\"UTF-8\"",
            "content-encoding: identity",
        ][..],
    ] {
        let answered = asked(port, (lines, "hi")).await;

        assert_eq!(
            (answered.head.status, text_of(&answered)),
            (200, "hi".to_owned()),
            "{lines:?}"
        );
    }

    // a call that hangs and one beside it of the same address: each held, then each let go
    let hanging = opened(
        port,
        &octets_of(
            port,
            &OwnCase {
                lines: &["POST /api/Transcoding/hang HTTP/1.1", JSON],
                status: 0,
                words: "",
                body: "{}",
                reason: None,
            },
        ),
    )
    .await;

    until(|| fixture.counts.hanging.load(Ordering::SeqCst) == 1).await;

    let echoed = posted(
        port,
        &Post {
            path: "/api/Transcoding/echo",
            fields: &[],
            body: "{\"anInt32\":2}",
        },
    )
    .await;

    assert_eq!(text_of(&echoed), "{\"anInt32\":2}");
    hanging.destroy();
    until(|| fixture.counts.cancelled.load(Ordering::SeqCst) == 1).await;

    fixture.dispose().await.expect("disposed");
}

// a transport that answers each request a result of nothing, then a notification of each of its
// payloads, standing for a server
#[derive(Debug, Default)]
struct Notifying {
    payloads: Vec<Bytes>,
    memory: Mutex<Option<bead::MemoryTransportServer>>,
}

impl ServerListener for Notifying {
    fn on_message(&self, message: bead::TransportMessage, connection_handle: &ConnectionHandle) {
        let Some(memory) = locked(&self.memory).clone() else {
            return;
        };
        let bead::internal::Envelope::Request { header, .. } =
            bead::testing::scripted::envelope_of(&message.data, bead::RouterSide::Server)
        else {
            return;
        };
        let call_id = header.call_id;
        let result = bead::internal::Envelope::Result {
            header: bead::ResultHeader {
                call_id,
                total: None,
                credential: None,
            },
            payload: Bytes::new(),
        };
        let notifications =
            self.payloads
                .iter()
                .map(|payload| bead::internal::Envelope::Notification {
                    header: bead::NotificationHeader { call_id },
                    payload: payload.clone(),
                });

        for envelope in core::iter::once(result).chain(notifications) {
            let mut reply = bead::TransportMessage::default();

            reply.data = bead::internal::write_envelope(&envelope, 1024).expect("an envelope");
            drop(memory.send(reply, connection_handle));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writes_an_event_s_data_through_the_runtime_reader_its_records_checked() {
    // * `at`, a message, as a varint: no reader of Edges takes it (spec 17.9.5); `ints`, its field
    // 14, read
    let mut options = gateway_options().expect("the gateway's options");
    let memory = options.transport.clone();
    let edges = route_named("echoEdges").result().clone();

    options.routes = changed_routes(
        &options.routes,
        ("watch", &|route| notifying(route, edges.clone())),
    );
    memory.start().await.expect("started");

    let scripted = Arc::new(Notifying {
        payloads: vec![Bytes::from_static(&[0x70, 1]), Bytes::from_static(&[8, 0])],
        memory: Mutex::new(Some(memory.clone())),
    });

    memory.listen(Arc::<Notifying>::clone(&scripted));

    let gateway = bead::HttpGateway::new(&options).expect("a gateway");
    let reported = Arc::new(Mutex::new(Vec::<String>::new()));
    let reporting = Arc::clone(&reported);

    gateway.on_error(Arc::new(move |error| {
        locked(&reporting).push(error.to_string());
    }));

    let mut start = bead::HttpGatewayStartOptions::default();

    start.address = Some(HOST.to_owned());
    start.port = Some(0);

    let port = gateway.start(&start).await.expect("listening").port;
    let answered = exchanged(port, &watch_octets(port)).await;

    assert_eq!(answered.head.status, 200);
    assert_eq!(
        text_of(&answered),
        "event: result\nid: 1\ndata: {}\n\nid: 2\ndata: {\"ints\":[1]}\n\nevent: failure\nid: 3\ndata: {\"code\":50,\"scope\":\"protocol\",\"status\":502,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}\n\n"
    );
    assert_eq!(locked(&reported).len(), 1);
    until(|| memory.clients().is_empty()).await;

    gateway.dispose().await.expect("disposed");
    memory.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ends_a_stream_whose_notification_its_stock_library_refuses_with_502_as_its_last_event() {
    // * ticks' notification told it is an Edges: a Tick's remaining, field 1 a varint, where an
    // Edges' at is a message
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            let edges = route_named("echoEdges").result().clone();

            options.routes = changed_routes(
                &options.routes,
                ("ticks", &|route| notifying(route, edges.clone())),
            );
        },
        true,
    ))
    .await;
    let reported = reported_by(&fixture);
    let ticks = posted(
        fixture.port,
        &Post {
            path: "/api/Transcoding/ticks",
            fields: &["accept: text/event-stream"],
            body: "{\"from\":2}",
        },
    )
    .await;
    let begun = "event: result\nid: 1\ndata: {\"ticks\":2}\n\nevent: failure\nid: 2\ndata: {\"code\":50,\"scope\":\"protocol\",\"status\":502,\"title\":\"PAYLOAD_UNDECODABLE\",\"type\":\"tag:francisdesjardins.ca,2026:bead/PAYLOAD_UNDECODABLE\"}\n\n";

    assert_eq!(ticks.head.status, 200);
    assert!(text_of(&ticks).starts_with(begun), "{}", text_of(&ticks));
    assert_eq!(locked(&reported).len(), 1);

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writes_a_comment_on_a_quiet_stream_each_heartbeat_on_its_clock_and_drops_one_past_maximum_unsent_bytes()
 {
    // * the Rust form: on its own listener, where the pace is its socket's
    let clock = Arc::new(Holding {
        platform: bead::SystemClock::current().expect("the platform's clock"),
        held: Duration::from_secs(1),
        callbacks: Mutex::new(Vec::new()),
    });
    let shared: bead::SharedClock = Arc::<Holding>::clone(&clock);
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            options.clock = Some(shared);
            options.heartbeat = Some(Duration::from_secs(1));
        },
        true,
    ))
    .await;
    let mut stream = sent(fixture.port, &watch_octets(fixture.port)).await;

    read_until(&mut stream, "data: {}\n\n").await;

    // nothing written for a heartbeat: a comment, which no EventSource dispatches
    until(|| !locked(&clock.callbacks).is_empty()).await;
    clock.fire();
    assert!(
        read_until(&mut stream, ":\n\r\n")
            .await
            .ends_with(":\n\r\n")
    );
    drop(stream);
    fixture.dispose().await.expect("disposed");

    // a stream's write past what its response may hold unsent: dropped, its socket aborted,
    // nothing written
    let bounded = started_with((
        |options: &mut HttpGatewayOptions| {
            options.maximum_unsent_bytes = Some(1);
        },
        true,
    ))
    .await;
    let reported = reported_by(&bounded);

    assert_eq!(
        received_on(sent(bounded.port, &watch_octets(bounded.port)).await).await,
        0
    );
    until(|| !locked(&reported).is_empty()).await;
    assert_eq!(
        *locked(&reported),
        ["the response is dropped: maximumUnsentBytes 1 bytes"]
    );

    bounded.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn counts_pending_bytes_with_the_write_at_the_maximum_unsent_bytes_edge() {
    // * the Rust form: on its own listener, where the pace is its socket's: what it holds, none
    // here, and the write it would add, the document's 2 bytes
    for bound in [1, 2] {
        let fixture = started_with((
            |options: &mut HttpGatewayOptions| {
                options.document = Some(Bytes::from_static(b"{}"));
                options.maximum_unsent_bytes = Some(bound);
            },
            true,
        ))
        .await;
        let reported = reported_by(&fixture);
        let octets = line_octets(fixture.port, "GET /openapi.json HTTP/1.1");
        let received = received_on(sent(fixture.port, &octets).await).await;

        if bound == 1 {
            assert_eq!(received, 0);
            until(|| !locked(&reported).is_empty()).await;
            assert_eq!(
                *locked(&reported),
                ["the response is dropped: maximumUnsentBytes 1 bytes"]
            );
        } else {
            assert!(received > 0, "written");
            assert_eq!(*locked(&reported), Vec::<String>::new());
        }

        fixture.dispose().await.expect("disposed");
    }
}

// the receive buffer of a reader that reads nothing, so its socket holds little
const STALLED_RECEIVE_BYTES: u32 = 4_096;

// a socket to `port` whose reader holds little and reads nothing until the test reads it
async fn stalled_on(port: u16) -> tokio::net::TcpStream {
    let socket = tokio::net::TcpSocket::new_v4().expect("a socket");

    socket
        .set_recv_buffer_size(STALLED_RECEIVE_BYTES)
        .expect("its receive buffer");
    socket
        .connect(address_of(port))
        .await
        .expect("a socket to the server")
}

// how many bytes a loopback socket takes toward a stalled reader before it blocks: its send
// buffer and its reader's, which differ by platform
async fn held_by_loopback() -> usize {
    let listener = tokio::net::TcpListener::bind((HOST, 0))
        .await
        .expect("bound");
    let port = listener.local_addr().expect("its address").port();
    let reader = stalled_on(port).await;
    let (writer, _) = listener.accept().await.expect("accepted");
    let chunk = vec![0_u8; 65_536];
    let mut held = 0_usize;
    let mut blocked = 0_u32;

    while blocked < 3 {
        match writer.try_write(&chunk) {
            Ok(count) => {
                held = held.saturating_add(count);
                blocked = 0;
            }
            Err(error) => {
                assert_eq!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock,
                    "the loopback refused a write: {error}"
                );
                blocked = blocked.saturating_add(1);
                rest(Duration::from_millis(50)).await;
            }
        }
    }

    drop(reader);

    held
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn drops_a_stalled_reader_s_body_at_its_deadline_on_its_own_listener_and_ends_it_whole_mounted_over_http_1_1()
 {
    use tokio::io::AsyncWriteExt as _;

    // * a document past what the loopback holds, within what hyper's write queue takes beside it:
    // on its own listener the pace judges its socket, which its reader stalls past its deadline,
    // and drops it; mounted, every frame is polled at once, hyper's queue and its socket taking
    // it, and hyper arms no write deadline: its reader takes it whole once it reads
    let document = Bytes::from(vec![b' '; held_by_loopback().await + 131_072]);
    let paced = |options: &mut HttpGatewayOptions| {
        options.document = Some(document.clone());
        options.minimum_send_bytes_per_second = Some(100_000_000);
        options.send_grace_period = Some(Duration::from_millis(1));
    };
    let own = started_with((paced, true)).await;
    let reported = reported_by(&own);
    let mut stalled = stalled_on(own.port).await;

    stalled
        .write_all(&line_octets(own.port, "GET /openapi.json HTTP/1.1"))
        .await
        .expect("its request");
    until(|| !locked(&reported).is_empty()).await;
    assert_eq!(
        *locked(&reported),
        ["the response is dropped: minimumSendBytesPerSecond 100000000 after sendGracePeriod 1ms"]
    );
    assert!(received_on(stalled).await < document.len(), "its body cut");

    own.dispose().await.expect("disposed");

    let mounted = started_with((paced, false)).await;
    let reported = reported_by(&mounted);
    let port = mounted_on(mounted.gateway.clone(), false).await;
    let mut stalled = stalled_on(port).await;

    stalled
        .write_all(&line_octets(port, "GET /openapi.json HTTP/1.1"))
        .await
        .expect("its request");
    rest(Duration::from_millis(300)).await;

    let head = read_until(&mut stalled, "\r\n\r\n").await;
    let begun = head.find("\r\n\r\n").expect("its head") + 4;

    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert_eq!(
        head.len() - begun + received_on(stalled).await,
        document.len(),
        "its body whole"
    );
    assert_eq!(*locked(&reported), Vec::<String>::new());

    mounted.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resets_over_http_2_the_stream_of_a_request_whose_target_or_a_field_holds_an_octet_past_visible_ascii_protocol_error_nothing_written()
 {
    // * its own listener under TLS, HTTP/2 by ALPN: a NUL percent-encoded in its path, a path no
    // route matches among them, and a field past ASCII, each reset before its path is matched,
    // nothing drawn; what its target percent-encodes is no octet of it. A raw octet past ASCII in
    // its `:path` is the HTTP transport's wire's, which h2's client cannot send through
    // `http::Uri`: `http/server/tests/over_tls.rs` writes its frames by hand
    let fixture = started_with((
        |options: &mut HttpGatewayOptions| {
            options.tls = Some(bead::testing::tls::server_config().expect("the server's config"));
        },
        true,
    ))
    .await;
    let port = fixture.port;
    let drawn = drawn_by(&fixture);
    let mut config = rustls::ClientConfig::clone(
        &bead::testing::tls::client_config().expect("the client's config"),
    );

    config.alpn_protocols = vec![b"h2".to_vec()];

    let socket = tokio::net::TcpStream::connect(address_of(port))
        .await
        .expect("a socket to the gateway");
    let secured = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(
            rustls::pki_types::ServerName::try_from(HOST.to_owned()).expect("a name"),
            socket,
        )
        .await
        .expect("its handshake");
    let (session, connection) = h2::client::handshake(secured).await.expect("its session");

    drop(bead::testing::spawn(async move {
        drop(connection.await);
    }));

    // its status and body, or the reason its stream was reset with when none came
    let answer_of = |(path, other): (&'static [u8], Option<&'static [u8]>)| {
        let session = session.clone();

        async move {
            let mut request = http::Request::builder()
                .method("GET")
                .uri(
                    http::Uri::builder()
                        .scheme("https")
                        .authority(format!("{HOST}:{port}"))
                        .path_and_query(
                            http::uri::PathAndQuery::from_maybe_shared(Bytes::from_static(path))
                                .expect("a path"),
                        )
                        .build()
                        .expect("a target"),
                )
                .body(())
                .expect("a request");

            if let Some(other) = other {
                request.headers_mut().insert(
                    "x-other",
                    http::HeaderValue::from_bytes(other).expect("a field value"),
                );
            }

            let mut session = session.ready().await.expect("ready");
            let (response, _) = session.send_request(request, true).expect("sent");

            match patience(PATIENCE, response)
                .await
                .expect("answered in time")
            {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let mut body = response.into_body();
                    let mut read = Vec::new();

                    while let Some(data) = body.data().await {
                        read.extend_from_slice(&data.expect("its data"));
                    }

                    Ok((status, String::from_utf8(read).expect("UTF-8")))
                }
                Err(error) => Err(error.reason()),
            }
        }
    };

    for asked in [
        (&b"/v1/books/a%00b"[..], None),
        (&b"/nowhere%00"[..], None),
        (&b"/v1/books/2"[..], Some(&b"caf\xC3\xA9"[..])),
    ] {
        assert_eq!(
            answer_of(asked).await,
            Err(Some(h2::Reason::PROTOCOL_ERROR)),
            "{asked:?}"
        );
    }

    assert_eq!(drawn.count.load(Ordering::SeqCst), 0, "nothing drawn");
    assert_eq!(
        answer_of((b"/v1/books/a%01b", None)).await,
        Ok((
            200,
            "{\"name\":\"a\\u0001b\",\"title\":\"A tale\"}".to_owned()
        ))
    );

    fixture.dispose().await.expect("disposed");
}
