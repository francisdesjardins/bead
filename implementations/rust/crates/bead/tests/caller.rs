//! The Rust side's HTTP caller, the twins of `http-caller.test.ts` and `HttpCallerTests.cs`: through
//! the `TranscodingHttpClient` beadc writes for `spec/transcoding.proto` (transcoding 12.1), against
//! a gateway of beadc's table in front of a server of the `Transcoding` service, and against a
//! scripted listener on a socket for what a gateway would not answer. The caller takes no executor
//! (decision 0052): where the other sides hand theirs a stub, the Rust side answers from a listener
//! of the test's own.

#![expect(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a twin's helpers fail it as its own lines do"
)]

use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bead::testing::{patience, spawn};
use bead::{
    BoxFuture, CallError, DescriptorInit, Failure, FailureOrigin, FailureScope, HttpCallOptions,
    HttpCaller, HttpCallerOptions, HttpEvent, ProtocolCode, request_of,
};
use bead_interop::transcoding::generated::bead_http::{HttpRoutes, TranscodingHttpClient};
use bead_interop::transcoding::generated::messages::bead::transcoding::v1::{
    Book, FailRequest, GetBookRequest, Needs, Requiring, Tick, TicksRequest,
};
use bead_interop::transcoding::generated::services::bead::transcoding::v1::TranscodingProcedures;
use bead_interop::transcoding::{TranscodingFixture, TranscodingFixtureOptions, gateway_options};
use bead_protobuf::{DynamicCodec, ProtoCodec, ProtoSchema};
use buffa_types::google::protobuf::Empty;
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// how long a call waits for what it expects
const PATIENCE: Duration = Duration::from_secs(5);

const HOST: &str = "127.0.0.1";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ── Its fixture ───────────────────────────────────────────────────────────────

// a gateway of beadc's table on its own listener, in front of a server of the service
async fn started() -> TranscodingFixture {
    let gateway = gateway_options().expect("its gateway's options");

    TranscodingFixture::start(&TranscodingFixtureOptions::new(&gateway))
        .await
        .expect("the fixture")
}

fn url_of(fixture: &TranscodingFixture) -> String {
    format!("http://{HOST}:{}", fixture.port)
}

fn client_of(url: &str, options: &HttpCallerOptions) -> TranscodingHttpClient {
    TranscodingHttpClient::new(url, options).expect("the client")
}

fn options_of(authorization: Option<&str>) -> HttpCallerOptions {
    let mut options = HttpCallerOptions::default();

    options.authorization = authorization.map(str::to_owned);
    options
}

fn call_options_of((authorization, without): (Option<&str>, bool)) -> HttpCallOptions {
    let mut options = HttpCallOptions::default();

    options.authorization = authorization.map(str::to_owned);
    options.without_authorization = without.then_some(true);
    options
}

// what a call's future ends with, within the tests' patience
async fn settled<T>(future: BoxFuture<Result<T, CallError>>) -> Result<T, CallError> {
    patience(PATIENCE, future).await.expect("settled in time")
}

fn failure_of(error: CallError) -> Failure {
    let CallError::Failure(failure) = error else {
        panic!("a failure, not {error:?}");
    };

    failure
}

async fn failed<T: core::fmt::Debug>(future: BoxFuture<Result<T, CallError>>) -> Failure {
    failure_of(settled(future).await.expect_err("a failure"))
}

// a failure's code, scope, origin and detail
fn told(failure: &Failure) -> (u16, FailureScope, FailureOrigin, String) {
    (
        failure.code().get(),
        failure.scope(),
        failure.origin(),
        failure.detail().to_owned(),
    )
}

fn code_of(code: ProtocolCode) -> u16 {
    code.get().get()
}

// ── A scripted listener ───────────────────────────────────────────────────────

// a listener that answers each connection with the next of its answers, its socket then closed,
// and keeps each request it read
struct Scripted {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
}

impl Scripted {
    async fn new(answers: Vec<Vec<u8>>) -> Self {
        let listener = TcpListener::bind((HOST, 0)).await.expect("bound");
        let port = listener.local_addr().expect("its address").port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&requests);

        drop(spawn(async move {
            for answer in answers {
                let Ok((mut socket, _peer)) = listener.accept().await else {
                    return;
                };
                let request = request_of_socket(&mut socket).await;

                locked(&kept).push(request);
                drop(socket.write_all(&answer).await);
                drop(socket.shutdown().await);
            }
        }));

        Self { port, requests }
    }

    fn url(&self) -> String {
        format!("http://{HOST}:{}", self.port)
    }

    fn requests(&self) -> Vec<String> {
        locked(&self.requests).clone()
    }
}

// a request read whole: its head, then its body by its `content-length`
async fn request_of_socket(socket: &mut TcpStream) -> String {
    let mut read = Vec::new();
    let mut buffer = [0_u8; 4096];

    loop {
        if let Some(end) = read.windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&read[..end]).to_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .map_or(0, |length| length.trim().parse::<usize>().unwrap());

            if read.len() >= end.saturating_add(4).saturating_add(length) {
                return String::from_utf8_lossy(&read).into_owned();
            }
        }

        let count = socket.read(&mut buffer).await.unwrap_or(0);

        if count == 0 {
            return String::from_utf8_lossy(&read).into_owned();
        }

        read.extend_from_slice(&buffer[..count]);
    }
}

// a response of `status`, its fields, then `body`, its socket closed after it
fn answer_of((status, fields): (&str, &[&str]), body: &str) -> Vec<u8> {
    let mut head = format!("HTTP/1.1 {status}\r\nconnection: close\r\n");

    for field in fields {
        head.push_str(field);
        head.push_str("\r\n");
    }

    format!("{head}\r\n{body}").into_bytes()
}

// a whole response of `status`, its media type and its body
fn whole_answer_of((status, media_type): (&str, &str), body: &str) -> Vec<u8> {
    answer_of(
        (
            status,
            &[
                &format!("content-type: {media_type}"),
                &format!("content-length: {}", body.len()),
            ],
        ),
        body,
    )
}

// ── The twins ─────────────────────────────────────────────────────────────────

// transcoding 12.1
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn calls_default_routes_with_protobuf_json_and_every_native_encoding_through_its_gateway() {
    let fixture = started().await;
    let client = client_of(&url_of(&fixture), &HttpCallerOptions::default());
    let options = HttpCallOptions::default();
    let book = settled(client.get_book(
        &GetBookRequest {
            name: "shelves/a/books/b".to_owned(),
            revision: 7,
            ..GetBookRequest::default()
        },
        &options,
    ))
    .await
    .expect("a book");

    assert_eq!(
        book,
        Book {
            name: "shelves/a/books/b".to_owned(),
            pages: 7,
            title: "A tale".to_owned(),
            ..Book::default()
        }
    );
    assert_eq!(
        settled(client.text(&"Ada\r\nJosé".to_owned(), &options))
            .await
            .expect("a text"),
        "Ada\r\nJosé"
    );
    assert_eq!(
        settled(client.raw(&bytes::Bytes::from_static(&[0, 127, 255]), &options))
            .await
            .expect("bytes")
            .as_ref(),
        [0, 127, 255]
    );
    assert_eq!(
        settled(client.json(&json!({"z": [true, null], "a": "José"}), &options))
            .await
            .expect("a value")
            .to_string(),
        "{\"a\":\"José\",\"z\":[true,null]}"
    );

    fixture.dispose().await.expect("disposed");
}

// transcoding 12.4 and 12.4.1
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_application_and_protocol_problems_with_their_code_scope_and_detail() {
    let fixture = started().await;
    let client = client_of(&url_of(&fixture), &HttpCallerOptions::default());
    let options = HttpCallOptions::default();
    let application = failed(client.fail(
        &FailRequest {
            detail: "by choice".to_owned(),
            ..FailRequest::default()
        },
        &options,
    ))
    .await;
    let protocol = failed(client.who_am_i(&Empty::default(), &options)).await;

    assert_eq!(
        told(&application),
        (
            1,
            FailureScope::Application,
            FailureOrigin::Peer,
            "by choice".to_owned()
        )
    );
    assert_eq!(
        (protocol.code().get(), protocol.scope(), protocol.origin()),
        (
            code_of(ProtocolCode::SESSION_REQUIRED),
            FailureScope::Protocol,
            FailureOrigin::Peer
        )
    );

    fixture.dispose().await.expect("disposed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn presents_a_default_authorization_or_its_override_and_omits_it_on_request() {
    let fixture = started().await;
    let client = client_of(&url_of(&fixture), &options_of(Some("Bearer wrong")));
    let overridden = settled(client.who_am_i(
        &Empty::default(),
        &call_options_of((Some("Bearer good"), false)),
    ))
    .await
    .expect("its session");
    let defaulted = failed(client.who_am_i(&Empty::default(), &HttpCallOptions::default())).await;
    let omitted = failed(client.who_am_i(
        &Empty::default(),
        &call_options_of((Some("Bearer good"), true)),
    ))
    .await;

    assert_eq!(overridden.session, "ada");
    assert_eq!(
        defaulted.code().get(),
        code_of(ProtocolCode::SESSION_REQUIRED)
    );
    assert_eq!(
        omitted.code().get(),
        code_of(ProtocolCode::SESSION_REQUIRED)
    );
    assert_eq!(
        settled(client.json(&Value::Null, &call_options_of((None, true))))
            .await
            .expect("null"),
        Value::Null
    );

    fixture.dispose().await.expect("disposed");
}

// transcoding 12.3
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_credential_in_the_clear_before_encoding_or_http_dispatch() {
    // * a host in the clear is refused before anything goes: the scripted listener, reached as
    // `localhost.`, counts what came, and nothing does until the call omits its credential
    let scripted = Scripted::new(vec![whole_answer_of(
        ("200 OK", "application/json"),
        "null",
    )])
    .await;

    for host in ["example.com", "localhost.", "128.0.0.1"] {
        let url = format!("http://{host}:{}", scripted.port);
        let client = client_of(&url, &options_of(Some("Bearer good")));
        let refused = failed(client.json(&Value::Null, &HttpCallOptions::default())).await;

        assert_eq!(
            (refused.code().get(), refused.scope(), refused.origin()),
            (
                code_of(ProtocolCode::DESTINATION_UNREACHABLE),
                FailureScope::Protocol,
                FailureOrigin::Local
            ),
            "{host}"
        );
        assert_eq!(scripted.requests(), Vec::<String>::new(), "{host}");
    }

    let client = client_of(
        &format!("http://localhost.:{}", scripted.port),
        &options_of(Some("Bearer good")),
    );

    assert_eq!(
        settled(client.json(&Value::Null, &call_options_of((None, true))))
            .await
            .expect("null"),
        Value::Null
    );
    assert_eq!(scripted.requests().len(), 1);
}

// transcoding 12.5
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_the_result_then_notifications_and_the_failure_ending_its_gateway_stream() {
    let fixture = started().await;
    let client = client_of(&url_of(&fixture), &HttpCallerOptions::default());
    let mut stream = client.subscribe_ticks(
        &TicksRequest {
            from: 2,
            ..TicksRequest::default()
        },
        &HttpCallOptions::default(),
    );
    let mut received = Vec::new();
    let ended = patience(PATIENCE, async {
        while let Some(entry) = stream.next().await {
            match entry {
                Ok(HttpEvent::Result(result)) => received.push((true, result.ticks)),
                Ok(HttpEvent::Notification(tick)) => received.push((false, tick.remaining)),
                Err(error) => return Some(error),
            }
        }

        None
    })
    .await
    .expect("settled in time")
    .expect("the failure that ends it");
    let failure = failure_of(ended);

    assert_eq!(
        (failure.code().get(), failure.scope()),
        (2, FailureScope::Application)
    );
    assert_eq!(received, [(true, 2), (false, 1), (false, 0)]);

    fixture.dispose().await.expect("disposed");
}

// transcoding 12.6
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bounds_unary_bodies_and_events_and_refuses_redirects_without_following_them() {
    let scripted = Scripted::new(vec![
        whole_answer_of(("200 OK", "application/json"), "null"),
        answer_of(
            ("200 OK", &["content-type: text/event-stream"]),
            "data: {}\n\n",
        ),
        whole_answer_of(("307 Temporary Redirect", "application/json"), ""),
    ])
    .await;
    let mut bounded = HttpCallerOptions::default();

    bounded.maximum_body_bytes = Some(2);

    let unary = client_of(&scripted.url(), &bounded);
    let body = failed(unary.json(&Value::Null, &HttpCallOptions::default())).await;
    let mut stream = unary.subscribe_watch(&Empty::default(), &HttpCallOptions::default());
    let events = patience(PATIENCE, async {
        while let Some(entry) = stream.next().await {
            if let Err(error) = entry {
                return Some(error);
            }
        }

        None
    })
    .await
    .expect("settled in time")
    .map(failure_of)
    .expect("a failure");
    let redirect = client_of(&scripted.url(), &HttpCallerOptions::default());
    let moved = failed(redirect.json(&Value::Null, &HttpCallOptions::default())).await;

    for failure in [&body, &events] {
        assert_eq!(
            failure.code().get(),
            code_of(ProtocolCode::PAYLOAD_TOO_LARGE)
        );
    }

    assert_eq!(moved.code().get(), code_of(ProtocolCode::DESTINATION_LOST));
    // * hyper follows no redirect: the 307 came once, and nothing went after it
    assert_eq!(scripted.requests().len(), 3);
}

// transcoding 12.4.3
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_an_unmarked_http_401_and_keeps_its_status_and_retry_after() {
    let scripted = Scripted::new(vec![answer_of(
        (
            "401 Unauthorized",
            &[
                "content-type: text/plain",
                "content-length: 8",
                "retry-after: 7",
            ],
        ),
        "upstream",
    )])
    .await;
    let client = client_of(&scripted.url(), &HttpCallerOptions::default());
    let failure = failed(client.json(&Value::Null, &HttpCallOptions::default())).await;

    assert_eq!(
        told(&failure),
        (
            code_of(ProtocolCode::SESSION_REQUIRED),
            FailureScope::Protocol,
            FailureOrigin::Peer,
            "the HTTP call answers 401; Retry-After: 7".to_owned()
        )
    );
}

// transcoding 12.4.2
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_gateway_problems_by_their_refusal_before_their_status() {
    let cases = [
        (503, "busy", ProtocolCode::CAPACITY_EXCEEDED),
        (404, "path-unknown", ProtocolCode::DESTINATION_UNREACHABLE),
        (413, "too-large", ProtocolCode::PAYLOAD_TOO_LARGE),
        (403, "host-refused", ProtocolCode::ACCESS_DENIED),
        (403, "origin-refused", ProtocolCode::ACCESS_DENIED),
        (405, "method-refused", ProtocolCode::DESTINATION_UNREACHABLE),
        (400, "malformed", ProtocolCode::PAYLOAD_UNDECODABLE),
        (415, "type-refused", ProtocolCode::PAYLOAD_UNDECODABLE),
        (408, "too-slow", ProtocolCode::DESTINATION_UNREACHABLE),
        (401, "", ProtocolCode::SESSION_REQUIRED),
        (502, "", ProtocolCode::DESTINATION_LOST),
    ];
    let body = "{\"type\":\"about:blank\",\"detail\":\"by the gateway\"}";

    for (status, refusal, code) in cases {
        let scripted = Scripted::new(vec![answer_of(
            (
                &format!("{status} Refused"),
                &[
                    "content-type: Application/Problem+JSON",
                    &format!("content-length: {}", body.len()),
                    &format!("bead-refusal: {refusal}"),
                    "retry-after: 7",
                ],
            ),
            body,
        )])
        .await;
        let client = client_of(&scripted.url(), &HttpCallerOptions::default());
        let failure = failed(client.json(&Value::Null, &HttpCallOptions::default())).await;

        assert_eq!(
            told(&failure),
            (
                code_of(code),
                FailureScope::Protocol,
                FailureOrigin::Peer,
                format!("the HTTP call answers {status}; Retry-After: 7; by the gateway")
            ),
            "{status} {refusal}"
        );
    }
}

// transcoding 12.2
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn joins_a_base_url_path_to_its_default_routes_and_treats_an_empty_authorization_as_none() {
    for path in ["/proxy", "/proxy/"] {
        let scripted = Scripted::new(vec![whole_answer_of(
            ("200 OK", "Application/JSON"),
            "null",
        )])
        .await;
        let client = client_of(&format!("{}{path}", scripted.url()), &options_of(Some("")));

        assert_eq!(
            settled(client.json(&Value::Null, &HttpCallOptions::default()))
                .await
                .expect("null"),
            Value::Null
        );

        let requests = scripted.requests();

        assert_eq!(requests.len(), 1);
        assert!(
            requests[0].starts_with("POST /proxy/api/Transcoding/json HTTP/1.1\r\n"),
            "{}",
            requests[0]
        );
        assert!(
            !requests[0].to_lowercase().contains("\r\nauthorization:"),
            "{}",
            requests[0]
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fails_a_request_whose_value_leaves_a_required_field_unset_before_anything_goes_with_the_codec_s_refusal()
 {
    // * a typed Needs holds its required fields bare, which no value leaves unset: the request is
    // given through the dynamic codec, as the row of a typed writer says (docs/support.md)
    let scripted = Scripted::new(vec![whole_answer_of(("200 OK", "application/json"), "{}")]).await;
    let procedures = TranscodingProcedures::get().expect("its procedures");
    let requiring = ProtoSchema::of::<Requiring>();
    let needs = ProtoSchema::of::<Needs>();
    let descriptor = request_of(DescriptorInit {
        procedure: procedures.require.procedure().clone(),
        admission: procedures.require.admission(),
        failures: procedures.require.failures().to_vec(),
        request: DynamicCodec::new(Arc::clone(requiring.pool()), requiring.message()),
        result: DynamicCodec::new(Arc::clone(needs.pool()), needs.message()),
        validate: None,
    })
    .expect("require's descriptor");
    let route = HttpRoutes::get()
        .expect("the table")
        .all
        .iter()
        .find(|route| route.procedure().procedure().procedure_name == "require")
        .expect("require's route");
    let caller =
        HttpCaller::new(&scripted.url(), &HttpCallerOptions::default()).expect("the caller");
    let requester = caller
        .requester_of(route, &descriptor)
        .expect("require's requester");
    // a Requiring whose Needs sets its count alone, its name unset
    let request = buffa_descriptor::reflect::DynamicMessage::decode(
        Arc::clone(requiring.pool()),
        requiring.message(),
        &[0x0A, 0x02, 0x10, 0x01],
    )
    .expect("a Requiring");
    let refused = settled(requester.call(&request, &HttpCallOptions::default()))
        .await
        .expect_err("refused");

    // * the codec's writer's refusal, its reason, before the request is built (spec 17.2, 17.9.7)
    let CallError::Other(refusal) = refused else {
        panic!("the codec's refusal, not {refused:?}");
    };

    assert_eq!(refusal.to_string(), "a required field unset");
    assert_eq!(
        core::error::Error::source(&*refusal).map(ToString::to_string),
        Some("a proto message leaves bead.transcoding.v1.Needs.name unset".to_owned())
    );
    assert_eq!(scripted.requests(), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fails_a_result_that_leaves_a_required_field_unset_with_payload_undecodable() {
    let scripted = Scripted::new(vec![whole_answer_of(
        ("200 OK", "application/json"),
        "{\"count\":1}",
    )])
    .await;
    let client = client_of(&scripted.url(), &HttpCallerOptions::default());
    let failure = failed(client.require(&Requiring::default(), &HttpCallOptions::default())).await;

    // * its result read by 5.2 whole, step 4 among it
    assert_eq!(
        (failure.code().get(), failure.origin(), failure.detail()),
        (
            code_of(ProtocolCode::PAYLOAD_UNDECODABLE),
            FailureOrigin::Local,
            "the HTTP payload cannot be decoded"
        )
    );
    assert_eq!(
        core::error::Error::source(&failure).map(ToString::to_string),
        Some("a required field unset".to_owned())
    );
}

// the unmarked statuses, each a twin of its own on every side
async fn unmarked((status, code): (&str, ProtocolCode)) {
    let scripted = Scripted::new(vec![answer_of(
        (
            status,
            &[
                "content-type: text/plain",
                "content-length: 8",
                "retry-after: 7",
            ],
        ),
        "upstream",
    )])
    .await;
    let client = client_of(&scripted.url(), &HttpCallerOptions::default());
    let failure = failed(client.json(&Value::Null, &HttpCallOptions::default())).await;
    let number = status.split(' ').next().unwrap_or_default();

    assert_eq!(
        told(&failure),
        (
            code_of(code),
            FailureScope::Protocol,
            FailureOrigin::Peer,
            format!("the HTTP call answers {number}; Retry-After: 7")
        ),
        "{status}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_an_unmarked_http_403_and_keeps_its_status_and_retry_after() {
    unmarked(("403 Forbidden", ProtocolCode::ACCESS_DENIED)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_an_unmarked_http_404_and_keeps_its_status_and_retry_after() {
    unmarked(("404 Not Found", ProtocolCode::DESTINATION_UNREACHABLE)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_an_unmarked_http_413_and_keeps_its_status_and_retry_after() {
    unmarked(("413 Payload Too Large", ProtocolCode::PAYLOAD_TOO_LARGE)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_an_unmarked_http_429_and_keeps_its_status_and_retry_after() {
    unmarked(("429 Too Many Requests", ProtocolCode::CAPACITY_EXCEEDED)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_an_unmarked_http_503_and_keeps_its_status_and_retry_after() {
    unmarked((
        "503 Service Unavailable",
        ProtocolCode::DESTINATION_UNREACHABLE,
    ))
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_an_unmarked_http_502_and_keeps_its_status_and_retry_after() {
    unmarked(("502 Bad Gateway", ProtocolCode::DESTINATION_LOST)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_an_unmarked_http_504_and_keeps_its_status_and_retry_after() {
    unmarked(("504 Gateway Timeout", ProtocolCode::DESTINATION_LOST)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_an_unmarked_http_307_and_keeps_its_status_and_retry_after() {
    unmarked(("307 Temporary Redirect", ProtocolCode::DESTINATION_LOST)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_an_unmarked_http_418_and_keeps_its_status_and_retry_after() {
    unmarked(("418 I'm a teapot", ProtocolCode::DESTINATION_LOST)).await;
}

// ── A held listener ───────────────────────────────────────────────────────────

// a listener that answers one connection with its head, then its body in chunks of `chunk`
// octets, and holds its socket open until the caller lets it go
struct Held {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
    released: tokio::sync::oneshot::Receiver<()>,
}

impl Held {
    async fn new((status, media_type): (&str, &str), (body, chunk): (&[u8], usize)) -> Self {
        let listener = TcpListener::bind((HOST, 0)).await.expect("bound");
        let port = listener.local_addr().expect("its address").port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&requests);
        let (release, released) = tokio::sync::oneshot::channel();
        let mut answer = format!(
            "HTTP/1.1 {status}\r\ncontent-type: {media_type}\r\ntransfer-encoding: chunked\r\n\r\n"
        )
        .into_bytes();

        for part in body.chunks(chunk) {
            answer.extend_from_slice(format!("{:x}\r\n", part.len()).as_bytes());
            answer.extend_from_slice(part);
            answer.extend_from_slice(b"\r\n");
        }

        drop(spawn(async move {
            let Ok((mut socket, _peer)) = listener.accept().await else {
                return;
            };
            let request = request_of_socket(&mut socket).await;

            locked(&kept).push(request);
            drop(socket.write_all(&answer).await);
            until_closed(&mut socket).await;
            release.send(()).ok();
        }));

        Self {
            port,
            requests,
            released,
        }
    }

    fn url(&self) -> String {
        format!("http://{HOST}:{}", self.port)
    }

    fn requests(&self) -> usize {
        locked(&self.requests).len()
    }

    // once the caller closed its socket
    async fn released(self) {
        patience(PATIENCE, self.released)
            .await
            .expect("released in time")
            .expect("its socket closed");
    }
}

// what comes on `socket` let go, until its peer closes it
async fn until_closed(socket: &mut TcpStream) {
    let mut buffer = [0_u8; 64];

    while let Ok(count) = socket.read(&mut buffer).await
        && count > 0
    {}
}

// what a stream gives until it ends: its events, then the error that ended it
async fn subscribed<R, N>(
    mut subscription: bead::HttpSubscription<R, N>,
) -> (Vec<HttpEvent<R, N>>, Option<CallError>) {
    let mut events = Vec::new();
    let ended = patience(PATIENCE, async {
        while let Some(entry) = subscription.next().await {
            match entry {
                Ok(event) => events.push(event),
                Err(error) => return Some(error),
            }
        }

        None
    })
    .await
    .expect("settled in time");

    (events, ended)
}

// a stream's failure, its code, scope, origin and detail
fn told_of(ended: Option<CallError>) -> (u16, FailureScope, FailureOrigin, String) {
    told(&failure_of(ended.expect("the error that ends it")))
}

// a route of the table, by its procedure's name
fn route_named(name: &str) -> bead::HttpRoute {
    HttpRoutes::get()
        .expect("the table")
        .all
        .iter()
        .find(|route| route.procedure().procedure().procedure_name == name)
        .expect("its route")
        .clone()
}

// `watch`'s route, its result and its notification given in their place
fn watch_of((result, notification): (bead::HttpPayload, bead::HttpPayload)) -> bead::HttpRoute {
    let route = route_named("watch");

    bead::route_of(bead::HttpRouteInit {
        procedure: route.procedure().clone(),
        request: route.request().clone(),
        result,
        notification: Some(notification),
        failures: route.failures().to_vec(),
        no_side_effects: route.no_side_effects(),
        routes: route.routes().to_vec(),
    })
    .expect("a route")
}

// `watch`'s procedure, its result read by `result` and its notifications by `notification`
fn watch_descriptor<R: bead::PayloadCodec, N: bead::PayloadCodec>(
    (result, notification): (R, N),
) -> bead::NotifyingDescriptor<ProtoCodec<Empty>, R, N> {
    let watch = &TranscodingProcedures::get().expect("its procedures").watch;
    let described = watch.descriptor();

    bead::notifying_of(
        DescriptorInit {
            procedure: described.procedure().clone(),
            admission: described.admission(),
            failures: described.failures().to_vec(),
            request: described.request().clone(),
            result,
            validate: None,
        },
        notification,
    )
    .expect("watch's descriptor")
}

// a whole response of `status`, its media type and its body's octets
fn octets_answer_of((status, media_type): (&str, &str), body: &[u8]) -> Vec<u8> {
    let mut answer = answer_of(
        (
            status,
            &[
                &format!("content-type: {media_type}"),
                &format!("content-length: {}", body.len()),
            ],
        ),
        "",
    );

    answer.extend_from_slice(body);
    answer
}

// ── The twins of a stub ───────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_fragmented_utf_8_and_crlf_events_and_releases_an_iteration_that_stops() {
    let held = Held::new(
        ("200 OK", "text/event-stream"),
        (
            b": heartbeat\r\nevent: result\r\nid: 1\r\ndata: {}\r\n\r\nid: 2\r\ndata: {\"remaining\":7}\r\n\r\n",
            1,
        ),
    )
    .await;
    let client = client_of(&held.url(), &HttpCallerOptions::default());
    let mut stream = client.subscribe_watch(&Empty::default(), &HttpCallOptions::default());
    let mut received = Vec::new();

    patience(PATIENCE, async {
        while let Some(entry) = stream.next().await {
            received.push(entry.expect("an event"));

            if received.len() == 2 {
                break;
            }
        }
    })
    .await
    .expect("read in time");

    assert!(
        matches!(received[0], HttpEvent::Result(_)),
        "its result first: {received:?}"
    );
    assert!(
        matches!(&received[1], HttpEvent::Notification(tick) if tick.remaining == 7),
        "then its notification: {received:?}"
    );

    // * the iteration stops: its subscription dropped lets its response go, its socket closed
    drop(stream);
    held.released().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_notifications_before_the_result_and_a_second_result_and_releases_the_stream() {
    for body in [
        "data: {}\n\n",
        "event: result\ndata: {}\n\nevent: result\ndata: {}\n\n",
    ] {
        let held = Held::new(
            ("200 OK", "text/event-stream"),
            (body.as_bytes(), body.len()),
        )
        .await;
        let client = client_of(&held.url(), &HttpCallerOptions::default());
        let (_events, ended) =
            subscribed(client.subscribe_watch(&Empty::default(), &HttpCallOptions::default()))
                .await;

        assert_eq!(
            told_of(ended).0,
            code_of(ProtocolCode::PAYLOAD_UNDECODABLE),
            "{body:?}"
        );
        held.released().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn passes_cancellation_to_http_dispatch_and_rejects_a_url_or_bound_outside_its_contract() {
    // a listener that reads the request and never answers it, then tells when its socket closes
    let listener = TcpListener::bind((HOST, 0)).await.expect("bound");
    let port = listener.local_addr().expect("its address").port();
    let (entered, entering) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();

    drop(spawn(async move {
        let Ok((mut socket, _peer)) = listener.accept().await else {
            return;
        };

        drop(request_of_socket(&mut socket).await);
        entered.send(()).ok();
        until_closed(&mut socket).await;
        release.send(()).ok();
    }));

    let client = client_of(
        &format!("http://{HOST}:{port}"),
        &HttpCallerOptions::default(),
    );
    let signal = tokio_util::sync::CancellationToken::new();
    let mut options = HttpCallOptions::default();

    options.signal = Some(signal.clone());

    let waiting = client.json(&Value::Null, &options);

    patience(PATIENCE, entering)
        .await
        .expect("its request in time")
        .expect("its request");
    signal.cancel();

    assert!(
        matches!(settled(waiting).await, Err(CallError::Cancelled(None))),
        "a call its signal gave up"
    );
    // * its signal reached its dispatch: the exchange dropped, its socket closed
    patience(PATIENCE, released)
        .await
        .expect("released in time")
        .expect("its socket closed");

    for url in [
        "http://user:secret@localhost",
        "http://localhost?x=1",
        "http://localhost/#fragment",
        "ftp://localhost",
    ] {
        assert!(
            TranscodingHttpClient::new(url, &HttpCallerOptions::default()).is_err(),
            "{url} is refused"
        );
    }

    let mut bounded = HttpCallerOptions::default();

    bounded.maximum_body_bytes = Some(0);

    assert!(
        TranscodingHttpClient::new("http://localhost", &bounded).is_err(),
        "a bound of 0 is refused"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_text_and_raw_event_data_by_their_encodings() {
    let held = Held::new(
        ("200 OK", "text/event-stream"),
        (
            "event: result\ndata: \"Ada\\rJosé\"\n\ndata: \"AAH/\"\n\nevent: failure\ndata: {\"code\":7,\"scope\":\"protocol\"}\n\n"
                .as_bytes(),
            1,
        ),
    )
    .await;
    let route = watch_of((bead::HttpPayload::Text, bead::HttpPayload::Raw));
    let caller = HttpCaller::new(&held.url(), &HttpCallerOptions::default()).expect("the caller");
    let subscriber = caller
        .subscriber_of(&route, &watch_descriptor((bead::TextCodec, bead::RawCodec)))
        .expect("watch's subscriber");
    let (events, ended) =
        subscribed(subscriber.call(&Empty::default(), &HttpCallOptions::default())).await;
    let (code, scope, ..) = told_of(ended);

    assert_eq!((code, scope), (7, FailureScope::Protocol), "its failure");
    assert_eq!(
        events,
        [
            HttpEvent::Result("Ada\rJosé".to_owned()),
            HttpEvent::Notification(bytes::Bytes::from_static(&[0, 1, 255])),
        ],
        "a text's data its text, a raw's its bytes in base64"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_truncated_stream_and_malformed_problems_without_another_call() {
    let cases = [
        (
            "event: result\ndata: {}\n\n",
            ("200 OK", "text/event-stream"),
            (ProtocolCode::DESTINATION_LOST, FailureOrigin::Local),
        ),
        (
            "{}",
            ("400 Bad Request", "application/problem+json"),
            (ProtocolCode::PAYLOAD_UNDECODABLE, FailureOrigin::Peer),
        ),
        (
            "{\"code\":0,\"scope\":\"protocol\"}",
            ("400 Bad Request", "application/problem+json"),
            (ProtocolCode::PAYLOAD_UNDECODABLE, FailureOrigin::Local),
        ),
        (
            "{}",
            ("200 OK", "application/json"),
            (ProtocolCode::PAYLOAD_UNDECODABLE, FailureOrigin::Local),
        ),
    ];

    for (body, answered, (code, origin)) in cases {
        let scripted = Scripted::new(vec![whole_answer_of(answered, body)]).await;
        let client = client_of(&scripted.url(), &HttpCallerOptions::default());
        let (_events, ended) =
            subscribed(client.subscribe_watch(&Empty::default(), &HttpCallOptions::default()))
                .await;
        let (told_code, _scope, told_origin, _detail) = told_of(ended);

        assert_eq!(
            (told_code, told_origin),
            (code_of(code), origin),
            "{body} {answered:?}"
        );
        assert_eq!(scripted.requests().len(), 1, "{body} {answered:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_an_authorization_outside_http_field_values_before_dispatch() {
    let scripted = Scripted::new(vec![whole_answer_of(
        ("200 OK", "application/json"),
        "null",
    )])
    .await;
    let client = client_of(&scripted.url(), &HttpCallerOptions::default());

    for authorization in [
        "Bearer bad\r\ninjected: value",
        "\u{1}",
        "Bearer José",
        " Bearer good",
        "Bearer good ",
        "\tBearer good",
        "Bearer good\t",
    ] {
        let refused =
            settled(client.json(&Value::Null, &call_options_of((Some(authorization), false))))
                .await
                .expect_err("refused");

        assert!(
            matches!(refused, CallError::Refused(_)),
            "{authorization:?} is its caller's bug: {refused:?}"
        );
    }

    assert_eq!(scripted.requests(), Vec::<String>::new(), "nothing went");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_numeric_problem_codes_by_their_integer_value_and_refuses_another_json_kind() {
    let undecodable = (
        code_of(ProtocolCode::PAYLOAD_UNDECODABLE),
        FailureScope::Protocol,
        FailureOrigin::Local,
    );
    let application = (1, FailureScope::Application, FailureOrigin::Peer);
    let cases = [
        ("{\"code\":1.0,\"scope\":\"application\"}", application),
        ("{\"code\":1e0,\"scope\":\"application\"}", application),
        ("{\"code\":\"1\",\"scope\":\"application\"}", undecodable),
        ("{\"code\":1,\"scope\":1}", undecodable),
        (
            "{\"code\":1,\"scope\":\"application\",\"detail\":2}",
            undecodable,
        ),
    ];

    for (body, expected) in cases {
        let scripted = Scripted::new(vec![whole_answer_of(
            ("400 Bad Request", "application/problem+json"),
            body,
        )])
        .await;
        let client = client_of(&scripted.url(), &HttpCallerOptions::default());
        let failure = failed(client.json(&Value::Null, &HttpCallOptions::default())).await;

        assert_eq!(
            (failure.code().get(), failure.scope(), failure.origin()),
            expected,
            "{body}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_a_leading_stream_bom_and_media_types_without_case() {
    let held = Held::new(
        ("200 OK", "Text/Event-Stream"),
        (
            "\u{feff}event: result\r\ndata: {}\r\n\r\nevent: failure\r\ndata: {\"status\":502}\r\n\r\n"
                .as_bytes(),
            1,
        ),
    )
    .await;
    let client = client_of(&held.url(), &HttpCallerOptions::default());
    let (events, ended) =
        subscribed(client.subscribe_watch(&Empty::default(), &HttpCallOptions::default())).await;
    let (code, _scope, origin, _detail) = told_of(ended);

    assert_eq!(
        (code, origin),
        (code_of(ProtocolCode::DESTINATION_LOST), FailureOrigin::Peer),
        "its failure by its status"
    );
    assert!(
        matches!(events[..], [HttpEvent::Result(_)]),
        "its result alone: {events:?}"
    );
}

// `watch`'s route, its result given in its place
fn watch_resulting(result: bead::HttpPayload) -> bead::HttpRoute {
    let notification = route_named("watch")
        .notification()
        .cloned()
        .expect("watch notifies");

    watch_of((result, notification))
}

// `watch`'s subscriber, its result read as raw bytes or as a text, its notifications as Ticks
enum Resulting {
    Raw(bead::HttpSubscriber<ProtoCodec<Empty>, bead::RawCodec, ProtoCodec<Tick>>),
    Text(bead::HttpSubscriber<ProtoCodec<Empty>, bead::TextCodec, ProtoCodec<Tick>>),
}

// `watch`'s subscriber on a caller of `url`, its result read as `result` says
fn raw_or_text_subscriber_of(url: &str, result: &bead::HttpPayload) -> Resulting {
    let caller = HttpCaller::new(url, &HttpCallerOptions::default()).expect("the caller");
    let route = watch_resulting(result.clone());
    let notification = TranscodingProcedures::get()
        .expect("its procedures")
        .watch
        .notification()
        .clone();

    if matches!(result, bead::HttpPayload::Raw) {
        Resulting::Raw(
            caller
                .subscriber_of(&route, &watch_descriptor((bead::RawCodec, notification)))
                .expect("watch's subscriber"),
        )
    } else {
        Resulting::Text(
            caller
                .subscriber_of(&route, &watch_descriptor((bead::TextCodec, notification)))
                .expect("watch's subscriber"),
        )
    }
}

// what `watch`'s stream on `url` ends with, its result read as `result`, and how many events came
async fn raw_or_text_ended(url: &str, result: &bead::HttpPayload) -> (usize, Option<CallError>) {
    let options = HttpCallOptions::default();

    match raw_or_text_subscriber_of(url, result) {
        Resulting::Raw(raw) => {
            let (events, ended) = subscribed(raw.call(&Empty::default(), &options)).await;

            (events.len(), ended)
        }
        Resulting::Text(text) => {
            let (events, ended) = subscribed(text.call(&Empty::default(), &options)).await;

            (events.len(), ended)
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wraps_malformed_json_utf_8_base64_and_event_framing_as_an_undecodable_payload() {
    let watch = route_named("watch");
    let descriptor = &TranscodingProcedures::get().expect("its procedures").watch;

    for (body, is_raw) in [
        ("event: result\ndata: {\n\n", false),
        ("event: result\ndata: \"%%%\"\n\n", true),
        ("event: message\ndata: {}\n\n", false),
    ] {
        let held = Held::new(("200 OK", "text/event-stream"), (body.as_bytes(), 1)).await;
        let ended = if is_raw {
            raw_or_text_ended(&held.url(), &bead::HttpPayload::Raw)
                .await
                .1
        } else {
            let caller =
                HttpCaller::new(&held.url(), &HttpCallerOptions::default()).expect("the caller");
            let subscriber = caller
                .subscriber_of(&watch, descriptor)
                .expect("watch's subscriber");

            subscribed(subscriber.call(&Empty::default(), &HttpCallOptions::default()))
                .await
                .1
        };
        let (code, _scope, origin, _detail) = told_of(ended);

        assert_eq!(
            (code, origin),
            (
                code_of(ProtocolCode::PAYLOAD_UNDECODABLE),
                FailureOrigin::Local
            ),
            "{body:?}"
        );
    }

    for media_type in [
        "application/json",
        "application/problem+json",
        "text/event-stream",
    ] {
        let status = if media_type == "application/problem+json" {
            "400 Bad Request"
        } else {
            "200 OK"
        };
        let mut answer = answer_of((status, &[&format!("content-type: {media_type}")]), "");

        answer.push(0xff);

        let scripted = Scripted::new(vec![answer]).await;
        let client = client_of(&scripted.url(), &HttpCallerOptions::default());
        let failure = if media_type == "text/event-stream" {
            failure_of(
                subscribed(client.subscribe_watch(&Empty::default(), &HttpCallOptions::default()))
                    .await
                    .1
                    .expect("its end"),
            )
        } else {
            failed(client.json(&Value::Null, &HttpCallOptions::default())).await
        };

        assert_eq!(
            told(&failure),
            (
                code_of(ProtocolCode::PAYLOAD_UNDECODABLE),
                FailureScope::Protocol,
                FailureOrigin::Local,
                "the HTTP payload cannot be decoded".to_owned()
            ),
            "{media_type}"
        );
        assert!(
            core::error::Error::source(&failure).is_some(),
            "{media_type}: its cause kept"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_non_string_and_noncanonical_raw_event_data_and_releases_its_reader() {
    for (data, detail) in [
        ("null", "an HTTP text or raw event holds a JSON string"),
        ("\"AB==\"", "an HTTP raw event holds standard padded base64"),
    ] {
        let body = format!("event: result\ndata: {data}\n\n");
        let held = Held::new(("200 OK", "text/event-stream"), (body.as_bytes(), 1)).await;
        let (received, ended) = raw_or_text_ended(&held.url(), &bead::HttpPayload::Raw).await;

        assert_eq!(
            told_of(ended),
            (
                code_of(ProtocolCode::PAYLOAD_UNDECODABLE),
                FailureScope::Protocol,
                FailureOrigin::Local,
                detail.to_owned()
            ),
            "{data}"
        );
        assert_eq!(received, 0, "{data}: no event");
        assert_eq!(held.requests(), 1, "{data}: one call");
        held.released().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_invalid_result_media_and_malformed_json_without_another_call() {
    // * a result of another media type is let go unread: its body never ends, its socket closed
    let held = Held::new(("200 OK", "text/plain"), (b"null", 4)).await;
    let client = client_of(&held.url(), &HttpCallerOptions::default());
    let other = failed(client.json(&Value::Null, &HttpCallOptions::default())).await;

    assert_eq!(
        told(&other),
        (
            code_of(ProtocolCode::PAYLOAD_UNDECODABLE),
            FailureScope::Protocol,
            FailureOrigin::Local,
            "the HTTP result has another media type".to_owned()
        ),
        "another media type"
    );
    assert_eq!(held.requests(), 1, "one call");
    held.released().await;

    let scripted = Scripted::new(vec![whole_answer_of(("200 OK", "application/json"), "{")]).await;
    let client = client_of(&scripted.url(), &HttpCallerOptions::default());
    let malformed = failed(client.json(&Value::Null, &HttpCallOptions::default())).await;

    assert_eq!(
        told(&malformed),
        (
            code_of(ProtocolCode::PAYLOAD_UNDECODABLE),
            FailureScope::Protocol,
            FailureOrigin::Local,
            "the HTTP payload cannot be decoded".to_owned()
        ),
        "malformed JSON"
    );
    assert_eq!(scripted.requests().len(), 1, "one call");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_failed_response_reads_to_destination_lost_and_releases_their_readers() {
    // * each body cut short of what its head promised, its socket closed: its read fails
    for is_streaming in [false, true] {
        let answer = if is_streaming {
            answer_of(
                (
                    "200 OK",
                    &[
                        "content-type: text/event-stream",
                        "transfer-encoding: chunked",
                    ],
                ),
                "14\r\nevent: result\ndata: \r\n",
            )
        } else {
            answer_of(
                (
                    "200 OK",
                    &["content-type: application/json", "content-length: 10"],
                ),
                "nu",
            )
        };
        let scripted = Scripted::new(vec![answer]).await;
        let client = client_of(&scripted.url(), &HttpCallerOptions::default());
        let (received, failure) = if is_streaming {
            let (events, ended) =
                subscribed(client.subscribe_watch(&Empty::default(), &HttpCallOptions::default()))
                    .await;

            (events.len(), failure_of(ended.expect("its end")))
        } else {
            (
                0,
                failed(client.json(&Value::Null, &HttpCallOptions::default())).await,
            )
        };

        assert_eq!(
            told(&failure),
            (
                code_of(ProtocolCode::DESTINATION_LOST),
                FailureScope::Protocol,
                FailureOrigin::Local,
                "the HTTP body ends before its answer".to_owned()
            ),
            "streaming {is_streaming}"
        );
        assert!(
            core::error::Error::source(&failure).is_some(),
            "streaming {is_streaming}: the read's error its cause"
        );
        assert_eq!(received, 0, "streaming {is_streaming}: no event");
        assert_eq!(
            scripted.requests().len(),
            1,
            "streaming {is_streaming}: one call"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bounds_the_decoded_message_even_when_the_body_bound_is_larger() {
    let maximum = bead::internal::limits_of(&bead::RouterLimitsOptions::default())
        .expect("the default limits")
        .maximum_envelope_bytes;
    let length = usize::try_from(maximum.saturating_add(1)).expect("a length");
    let scripted = Scripted::new(vec![octets_answer_of(
        ("200 OK", "application/octet-stream"),
        &vec![0; length],
    )])
    .await;
    let mut bounded = HttpCallerOptions::default();

    bounded.maximum_body_bytes = Some(maximum.saturating_add(1));

    let client = client_of(&scripted.url(), &bounded);
    let failure = failed(client.raw(&bytes::Bytes::new(), &HttpCallOptions::default())).await;

    assert_eq!(
        (failure.code().get(), failure.origin(), failure.detail()),
        (
            code_of(ProtocolCode::PAYLOAD_TOO_LARGE),
            FailureOrigin::Local,
            "the HTTP payload passes maximumEnvelopeBytes"
        ),
        "its message past the envelope's bound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_a_gateway_problem_without_a_refusal_by_its_status() {
    let cases = [
        (400, ProtocolCode::PAYLOAD_UNDECODABLE),
        (401, ProtocolCode::SESSION_REQUIRED),
        (403, ProtocolCode::ACCESS_DENIED),
        (404, ProtocolCode::DESTINATION_UNREACHABLE),
        (405, ProtocolCode::DESTINATION_UNREACHABLE),
        (408, ProtocolCode::DESTINATION_UNREACHABLE),
        (413, ProtocolCode::PAYLOAD_TOO_LARGE),
        (415, ProtocolCode::PAYLOAD_UNDECODABLE),
        (422, ProtocolCode::PAYLOAD_INVALID),
        (429, ProtocolCode::CAPACITY_EXCEEDED),
        (431, ProtocolCode::PAYLOAD_TOO_LARGE),
        (500, ProtocolCode::DESTINATION_LOST),
        (501, ProtocolCode::PROCEDURE_UNKNOWN),
        (502, ProtocolCode::DESTINATION_LOST),
        (503, ProtocolCode::DESTINATION_UNREACHABLE),
        (504, ProtocolCode::DESTINATION_LOST),
    ];

    for (status, code) in cases {
        let scripted = Scripted::new(vec![whole_answer_of(
            (&format!("{status} Refused"), "application/problem+json"),
            "{\"type\":\"about:blank\"}",
        )])
        .await;
        let client = client_of(&scripted.url(), &HttpCallerOptions::default());
        let failure = failed(client.json(&Value::Null, &HttpCallOptions::default())).await;

        assert_eq!(
            told(&failure),
            (
                code_of(code),
                FailureScope::Protocol,
                FailureOrigin::Peer,
                format!("the HTTP call answers {status}")
            ),
            "{status}"
        );
    }
}

// `json`'s route, its first default route changed as `change` says, or none
fn json_routed(templates: Vec<bead::HttpRouteTemplate>) -> bead::HttpRoute {
    let route = route_named("json");

    bead::route_of(bead::HttpRouteInit {
        procedure: route.procedure().clone(),
        request: route.request().clone(),
        result: route.result().clone(),
        notification: None,
        failures: route.failures().to_vec(),
        no_side_effects: route.no_side_effects(),
        routes: templates,
    })
    .expect("a route")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_invalid_low_level_call_inputs_before_http_dispatch() {
    let scripted = Scripted::new(vec![whole_answer_of(
        ("200 OK", "application/json"),
        "null",
    )])
    .await;
    let caller =
        HttpCaller::new(&scripted.url(), &HttpCallerOptions::default()).expect("the caller");
    let json = &TranscodingProcedures::get().expect("its procedures").json;
    let generated = route_named("json");
    let template = generated.routes()[0].clone();
    let changed = |change: &dyn Fn(&mut bead::HttpRouteTemplate)| {
        let mut changed = template.clone();

        change(&mut changed);
        vec![changed]
    };
    let choices = [
        Vec::new(),
        changed(&|template| template.method = bead::HttpMethod::Get),
        changed(&|template| template.body = None),
        changed(&|template| template.response_body = Some("field".to_owned())),
        changed(&|template| template.template = "/items/{name}".to_owned()),
    ];

    for routes in choices {
        let refused = caller
            .requester_of(&json_routed(routes.clone()), json)
            .expect_err("no default route");

        assert_eq!(
            refused.message(),
            "an HTTP client calls a default POST route with a whole body and result",
            "{routes:?}"
        );
    }

    let elsewhere = caller
        .requester_of(
            &json_routed(changed(&|template| {
                template.template = "https://elsewhere.example/call".to_owned();
            })),
            json,
        )
        .expect_err("off its origin");

    assert_eq!(
        elsewhere.message(),
        "an HTTP route stays on its gateway origin",
        "a route off its gateway's origin"
    );

    let requester = caller
        .requester_of(&generated, json)
        .expect("json's requester");

    for authorization in [" Bearer x", "Bearer x ", "Bearer\nx", "\t", "É"] {
        let refused =
            settled(requester.call(&Value::Null, &call_options_of((Some(authorization), false))))
                .await
                .expect_err("refused");

        assert!(
            matches!(&refused, CallError::Refused(error)
                if error.message() == "a credential holds visible ASCII, spaces and tabs alone, none first or last"),
            "{authorization:?}: {refused:?}"
        );
    }

    // * a stream of `json`'s procedure, which notifies nowhere on its route
    let mut procedure = json.procedure().clone();

    procedure.procedure_kind = Some(bead::ProcedureKind::Notifies);

    let notifying = bead::notifying_of(
        DescriptorInit {
            procedure,
            admission: json.admission(),
            failures: json.failures().to_vec(),
            request: bead::JsonCodec,
            result: bead::JsonCodec,
            validate: None,
        },
        bead::JsonCodec,
    )
    .expect("a notifying descriptor");
    let refused = caller
        .subscriber_of(&generated, &notifying)
        .expect_err("no stream");

    assert_eq!(
        refused.message(),
        "only a notifying HTTP procedure opens a stream",
        "a stream of a procedure its route does not notify"
    );
    assert_eq!(scripted.requests(), Vec::<String>::new(), "nothing went");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_invalid_utf_8_on_a_terminated_event_line_and_releases_its_reader() {
    let held = Held::new(
        ("200 OK", "text/event-stream"),
        (b"event: result\ndata: \xff\n\n", 1),
    )
    .await;
    let client = client_of(&held.url(), &HttpCallerOptions::default());
    let (events, ended) =
        subscribed(client.subscribe_watch(&Empty::default(), &HttpCallOptions::default())).await;
    let failure = failure_of(ended.expect("its end"));

    assert_eq!(
        told(&failure),
        (
            code_of(ProtocolCode::PAYLOAD_UNDECODABLE),
            FailureScope::Protocol,
            FailureOrigin::Local,
            "the HTTP payload cannot be decoded".to_owned()
        ),
        "a line of no UTF-8"
    );
    assert!(
        core::error::Error::source(&failure)
            .is_some_and(<dyn core::error::Error>::is::<std::string::FromUtf8Error>),
        "its decoder's error its cause"
    );
    assert!(events.is_empty(), "no event: {events:?}");
    assert_eq!(held.requests(), 1, "one call");
    held.released().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn propagates_a_response_read_error_after_cancellation_without_mapping_it_to_a_failure() {
    for is_streaming in [false, true] {
        // a listener that writes a head and a part of its body, then, told to, closes its socket
        // short of what its head promised: the read fails after the call is given up
        let listener = TcpListener::bind((HOST, 0)).await.expect("bound");
        let port = listener.local_addr().expect("its address").port();
        let (wrote, written) = tokio::sync::oneshot::channel();
        let (cut, cutting) = tokio::sync::oneshot::channel::<()>();
        let answer = if is_streaming {
            answer_of(
                (
                    "200 OK",
                    &[
                        "content-type: text/event-stream",
                        "transfer-encoding: chunked",
                    ],
                ),
                "14\r\nevent: result\ndata: \r\n",
            )
        } else {
            answer_of(
                (
                    "200 OK",
                    &["content-type: application/json", "content-length: 10"],
                ),
                "nu",
            )
        };

        drop(spawn(async move {
            let Ok((mut socket, _peer)) = listener.accept().await else {
                return;
            };

            drop(request_of_socket(&mut socket).await);
            drop(socket.write_all(&answer).await);

            wrote.send(()).ok();

            drop(cutting.await);
        }));

        let client = client_of(
            &format!("http://{HOST}:{port}"),
            &HttpCallerOptions::default(),
        );
        let signal = tokio_util::sync::CancellationToken::new();
        let mut options = HttpCallOptions::default();

        options.signal = Some(signal.clone());

        let waiting: BoxFuture<Result<(), CallError>> = if is_streaming {
            let subscription = client.subscribe_watch(&Empty::default(), &options);

            Box::pin(async move {
                let (events, ended) = subscribed(subscription).await;

                assert!(events.is_empty(), "no event: {events:?}");
                ended.map_or(Ok(()), Err)
            })
        } else {
            let call = client.json(&Value::Null, &options);

            Box::pin(async move { call.await.map(drop) })
        };

        patience(PATIENCE, written)
            .await
            .expect("written in time")
            .expect("written");
        signal.cancel();
        cut.send(()).ok();

        // * the call its signal gave up ends cancelled, the read's error never a failure of its own
        assert!(
            matches!(settled(waiting).await, Err(CallError::Cancelled(None))),
            "streaming {is_streaming}: cancelled"
        );
        assert!(
            signal.is_cancelled(),
            "streaming {is_streaming}: its signal"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_malformed_json_in_native_stream_data_before_delivering_an_event() {
    for result in [bead::HttpPayload::Text, bead::HttpPayload::Raw] {
        let held = Held::new(
            ("200 OK", "text/event-stream"),
            (b"event: result\ndata: {\n\n", 1),
        )
        .await;
        let (received, ended) = raw_or_text_ended(&held.url(), &result).await;
        let failure = failure_of(ended.expect("its end"));

        assert_eq!(
            told(&failure),
            (
                code_of(ProtocolCode::PAYLOAD_UNDECODABLE),
                FailureScope::Protocol,
                FailureOrigin::Local,
                "the HTTP payload cannot be decoded".to_owned()
            ),
            "{result:?}"
        );
        assert!(
            core::error::Error::source(&failure).is_some(),
            "{result:?}: its reader's refusal its cause"
        );
        assert_eq!(received, 0, "{result:?}: no event");
        assert_eq!(held.requests(), 1, "{result:?}: one call");
        held.released().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_an_empty_raw_result_and_maps_an_empty_non_problem_refusal_by_status() {
    for status in ["200 OK", "503 Service Unavailable"] {
        let scripted = Scripted::new(vec![answer_of(
            (
                status,
                &[
                    "content-type: application/octet-stream",
                    "retry-after: 7",
                    "content-length: 0",
                ],
            ),
            "",
        )])
        .await;
        let client = client_of(&scripted.url(), &HttpCallerOptions::default());
        let answered = settled(client.raw(&bytes::Bytes::new(), &HttpCallOptions::default())).await;

        if status == "200 OK" {
            assert!(
                answered.expect("its result").is_empty(),
                "an empty raw result"
            );
        } else {
            assert_eq!(
                told(&failure_of(answered.expect_err("refused"))),
                (
                    code_of(ProtocolCode::DESTINATION_UNREACHABLE),
                    FailureScope::Protocol,
                    FailureOrigin::Peer,
                    "the HTTP call answers 503; Retry-After: 7".to_owned()
                ),
                "an empty refusal by its status"
            );
        }

        assert_eq!(scripted.requests().len(), 1, "{status}: one call");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejects_empty_responses_with_no_required_media_type_and_releases_their_content() {
    let cases = [
        (
            (false, "200 OK"),
            ProtocolCode::PAYLOAD_UNDECODABLE,
            "the HTTP result has another media type",
            FailureOrigin::Local,
        ),
        (
            (true, "200 OK"),
            ProtocolCode::PAYLOAD_UNDECODABLE,
            "the HTTP subscription answers no event stream",
            FailureOrigin::Local,
        ),
        (
            (false, "503 Service Unavailable"),
            ProtocolCode::DESTINATION_UNREACHABLE,
            "the HTTP call answers 503",
            FailureOrigin::Peer,
        ),
    ];

    for ((is_streaming, status), code, detail, origin) in cases {
        let scripted = Scripted::new(vec![answer_of((status, &["content-length: 0"]), "")]).await;
        let client = client_of(&scripted.url(), &HttpCallerOptions::default());
        let (received, failure) = if is_streaming {
            let (events, ended) =
                subscribed(client.subscribe_watch(&Empty::default(), &HttpCallOptions::default()))
                    .await;

            (events.len(), failure_of(ended.expect("its end")))
        } else {
            (
                0,
                failed(client.json(&Value::Null, &HttpCallOptions::default())).await,
            )
        };

        assert_eq!(
            told(&failure),
            (
                code_of(code),
                FailureScope::Protocol,
                origin,
                detail.to_owned()
            ),
            "{status} streaming {is_streaming}"
        );
        assert_eq!(received, 0, "{status}: no event");
        assert_eq!(scripted.requests().len(), 1, "{status}: one call");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_an_empty_event_stream_from_a_supplied_executor_and_over_http() {
    // * the caller takes no executor (decision 0052): the stream over HTTP alone
    let scripted = Scripted::new(vec![whole_answer_of(("200 OK", "text/event-stream"), "")]).await;
    let client = client_of(&scripted.url(), &HttpCallerOptions::default());
    let (events, ended) =
        subscribed(client.subscribe_watch(&Empty::default(), &HttpCallOptions::default())).await;

    assert_eq!(
        told_of(ended),
        (
            code_of(ProtocolCode::DESTINATION_LOST),
            FailureScope::Protocol,
            FailureOrigin::Local,
            "the HTTP event stream ends without a failure".to_owned()
        ),
        "an empty stream over HTTP"
    );
    assert!(events.is_empty(), "no event: {events:?}");
    assert_eq!(scripted.requests().len(), 1, "one call");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn maps_unmarked_http_statuses_without_treating_an_intermediary_as_its_gateway() {
    let lost = ProtocolCode::DESTINATION_LOST;
    let cases = [
        (201, lost),
        (204, lost),
        (299, lost),
        (300, lost),
        (304, lost),
        (399, lost),
        (400, lost),
        (401, ProtocolCode::SESSION_REQUIRED),
        (403, ProtocolCode::ACCESS_DENIED),
        (404, ProtocolCode::DESTINATION_UNREACHABLE),
        (405, lost),
        (408, lost),
        (413, ProtocolCode::PAYLOAD_TOO_LARGE),
        (415, lost),
        (422, lost),
        (429, ProtocolCode::CAPACITY_EXCEEDED),
        (431, lost),
        (500, lost),
        (501, lost),
        (502, lost),
        (503, ProtocolCode::DESTINATION_UNREACHABLE),
        (504, lost),
        (599, lost),
    ];

    for (status, code) in cases {
        let scripted = Scripted::new(vec![answer_of(
            (
                &format!("{status} Unmarked"),
                &["retry-after: 7", "content-length: 0"],
            ),
            "",
        )])
        .await;
        let client = client_of(&scripted.url(), &HttpCallerOptions::default());
        let failure = failed(client.json(&Value::Null, &HttpCallOptions::default())).await;

        assert_eq!(
            told(&failure),
            (
                code_of(code),
                FailureScope::Protocol,
                FailureOrigin::Peer,
                format!("the HTTP call answers {status}; Retry-After: 7")
            ),
            "{status}"
        );
        assert_eq!(scripted.requests().len(), 1, "{status}: one call");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refuses_a_stream_failure_with_an_invalid_http_problem_status_and_no_bead_code() {
    for data in [
        "null",
        "{}",
        "{\"status\":99}",
        "{\"status\":600}",
        "{\"status\":1.5}",
        "{\"status\":\"502\"}",
        "{\"status\":null}",
    ] {
        let body = format!("event: failure\ndata: {data}\n\n");
        let held = Held::new(("200 OK", "text/event-stream"), (body.as_bytes(), 1)).await;
        let client = client_of(&held.url(), &HttpCallerOptions::default());
        let (events, ended) =
            subscribed(client.subscribe_watch(&Empty::default(), &HttpCallOptions::default()))
                .await;

        assert_eq!(
            told_of(ended),
            (
                code_of(ProtocolCode::PAYLOAD_UNDECODABLE),
                FailureScope::Protocol,
                FailureOrigin::Local,
                "the HTTP problem holds no Bead failure".to_owned()
            ),
            "{data}"
        );
        assert!(events.is_empty(), "{data}: no event");
        assert_eq!(held.requests(), 1, "{data}: one call");
        held.released().await;
    }
}
