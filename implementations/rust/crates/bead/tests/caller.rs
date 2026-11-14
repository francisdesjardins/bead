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
    Book, FailRequest, GetBookRequest, Needs, Requiring, TicksRequest,
};
use bead_interop::transcoding::generated::services::bead::transcoding::v1::TranscodingProcedures;
use bead_interop::transcoding::{TranscodingFixture, TranscodingFixtureOptions, gateway_options};
use bead_protobuf::{DynamicCodec, ProtoSchema};
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
