//! A gateway over hand-built `text` and `raw` routes, on its own listener and mounted: its gates,
//! its document, a body read before it, a `HEAD` that asks a stream, its bounds and its options.

use core::future::poll_fn;
use core::pin::Pin;
use core::task::{Context, Poll};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};

use http_body::{Frame, SizeHint};

use super::*;
use crate::constants::ProcedureKind;
use crate::duration::NEVER;
use crate::http::peer::{HOST, PATIENCE, RawSocket, head_of, raw_answer_of};
use crate::http_policy::HttpPolicyOptions;
use crate::memory::MemoryTransportServerOptions;
use crate::payloads::RawCodec;
use crate::server::{Server, ServerOptions};
use crate::service::{
    AdmissionRule, Descriptor, DescriptorInit, NotifyingDescriptor, ServiceProcedure,
    ServiceServer, ServiceServerOptions, notifying_of, request_of,
};
use crate::testing::patience;
use crate::testing::wire::ResponseReader;
use crate::transcoding::routes::{HttpRouteInit, route_of};

const DOCUMENT: &str = "{\"openapi\":\"3.1.0\"}";

fn procedure(name: &str, (procedure_id, kind): (u16, Option<ProcedureKind>)) -> Procedure {
    Procedure {
        service_id: 7,
        procedure_id,
        service_revision: 1,
        procedure_name: name.to_owned(),
        procedure_kind: kind,
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

fn init<C: PayloadCodec + Clone>(procedure: Procedure, codec: C) -> DescriptorInit<C, C> {
    DescriptorInit {
        procedure,
        admission: AdmissionRule::None,
        failures: vec![],
        request: codec.clone(),
        result: codec,
        validate: None,
    }
}

// the service the gateway answers: `echo` of a text, `raw` of bytes, and `news`, which notifies
struct Service {
    echo: Descriptor<TextCodec, TextCodec>,
    raw: Descriptor<RawCodec, RawCodec>,
    news: NotifyingDescriptor<TextCodec, TextCodec, TextCodec>,
}

impl Service {
    fn new() -> Self {
        Self {
            echo: request_of(init(procedure("echo", (1, None)), TextCodec)).expect("echo"),
            raw: request_of(init(procedure("raw", (2, None)), RawCodec)).expect("raw"),
            news: notifying_of(
                init(
                    procedure("news", (3, Some(ProcedureKind::Notifies))),
                    TextCodec,
                ),
                TextCodec,
            )
            .expect("news"),
        }
    }

    fn procedures(&self) -> Vec<ServiceProcedure> {
        vec![
            ServiceProcedure::from(&self.echo),
            ServiceProcedure::from(&self.raw),
            ServiceProcedure::from(&self.news),
        ]
    }

    // its routes: each a body whole, `news` a `GET` that reads alone
    fn routes(&self) -> Vec<HttpRoute> {
        let route =
            |method: HttpMethod, (template, body): (&str, Option<&str>)| HttpRouteTemplate {
                method,
                template: template.to_owned(),
                body: body.map(str::to_owned),
                response_body: None,
            };

        vec![
            route_of(HttpRouteInit {
                procedure: ServiceProcedure::from(&self.echo),
                request: HttpPayload::Text,
                result: HttpPayload::Text,
                notification: None,
                failures: vec![],
                no_side_effects: false,
                routes: vec![route(HttpMethod::Post, ("/v1/echo", Some("*")))],
            })
            .expect("echo's route"),
            route_of(HttpRouteInit {
                procedure: ServiceProcedure::from(&self.raw),
                request: HttpPayload::Raw,
                result: HttpPayload::Raw,
                notification: None,
                failures: vec![],
                no_side_effects: false,
                routes: vec![route(HttpMethod::Post, ("/v1/raw", Some("*")))],
            })
            .expect("raw's route"),
            route_of(HttpRouteInit {
                procedure: ServiceProcedure::from(&self.news),
                request: HttpPayload::Text,
                result: HttpPayload::Text,
                notification: Some(HttpPayload::Text),
                failures: vec![],
                no_side_effects: true,
                routes: vec![route(HttpMethod::Get, ("/v1/news", None))],
            })
            .expect("news' route"),
        ]
    }
}

// a gateway before its server, the calls its server answered and the connections they came on,
// and what the gateway reported
struct Fixture {
    memory: MemoryTransportServer,
    server: Server,
    gateway: HttpGateway,
    port: u16,
    calls: Arc<AtomicU64>,
    news: crate::managers::service::Notifier<TextCodec>,
    handles: Arc<Mutex<Vec<String>>>,
    reported: Arc<Mutex<Vec<String>>>,
}

impl Fixture {
    // the service served, its gateway built with `adjust`'s options, on its own listener where
    // it `listens`
    async fn new<F: FnOnce(&mut HttpGatewayOptions)>(adjust: F, listens: bool) -> Self {
        let memory = MemoryTransportServer::new(&MemoryTransportServerOptions::default())
            .expect("the in-memory transport");
        let server =
            Server::new(Arc::new(memory.clone()), &ServerOptions::default()).expect("the server");
        let service = Service::new();
        let offered = ServiceServer::new(service.procedures(), &ServiceServerOptions::default())
            .expect("its service");
        let calls = Arc::new(AtomicU64::new(0));
        let handles = Arc::new(Mutex::new(Vec::new()));
        let (counting, heard) = (Arc::clone(&calls), Arc::clone(&handles));

        offered
            .on(
                &service.echo,
                Arc::new(move |request, response| {
                    counting.fetch_add(1, Ordering::SeqCst);
                    heard
                        .lock()
                        .unwrap()
                        .push(request.connection_handle.to_string());
                    response.result(request.payload)
                }),
            )
            .expect("echo answered");
        offered
            .on(
                &service.raw,
                Arc::new(|request, response| response.result(request.payload)),
            )
            .expect("raw answered");
        offered
            .on_notifying(
                &service.news,
                Arc::new(|_request, response| response.result("open".to_owned())),
            )
            .expect("news answered");
        offered.offer(&server).expect("offered");

        let news = offered.notifier_of(&service.news).expect("news' notifier");
        memory.start().await.expect("started");

        let mut options = HttpGatewayOptions::new(memory.clone(), service.routes());

        options.document = Some(Bytes::from_static(DOCUMENT.as_bytes()));
        adjust(&mut options);

        let gateway = HttpGateway::new(&options).expect("the gateway");
        let reported = Arc::new(Mutex::new(Vec::new()));
        let reporting = Arc::clone(&reported);

        gateway.on_error(Arc::new(move |error| {
            reporting.lock().unwrap().push(error.to_string());
        }));

        let port = if listens {
            let start = HttpGatewayStartOptions {
                address: Some(HOST.to_owned()),
                port: Some(0),
                find_open_port: Some(true),
                ..HttpGatewayStartOptions::default()
            };

            gateway.start(&start).await.expect("listening").port
        } else {
            0
        };

        Self {
            memory,
            server,
            gateway,
            port,
            calls,
            news,
            handles,
            reported,
        }
    }

    fn reported(&self) -> Vec<String> {
        self.reported.lock().unwrap().clone()
    }

    async fn stop(self) {
        self.gateway.dispose().await.expect("the gateway disposed");
        self.server.dispose().await.expect("the server disposed");
    }

    // waits until no exchange's connection is left
    async fn until_drawn_none(&self) {
        patience(PATIENCE, async {
            while !self.memory.clients().is_empty() {
                crate::testing::rest(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("every connection closed");
    }
}

// a request's bytes: its head, then `body`
fn bytes_of(head: &str, body: &[u8]) -> Vec<u8> {
    let mut bytes = head.as_bytes().to_vec();

    bytes.extend_from_slice(body);
    bytes
}

// a refusal a request meets: its status, its mark, and the methods its `allow` names
struct Case {
    request: Vec<u8>,
    status: u16,
    refusal: &'static str,
    allow: Option<&'static str>,
}

// a body of its own, handed to a mounted gateway: its frames, and the hints it shows
struct Handed {
    frames: VecDeque<Bytes>,
    is_end_stream: bool,
    exact: Option<u64>,
}

impl Body for Handed {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        Poll::Ready(self.frames.pop_front().map(|frame| Ok(Frame::data(frame))))
    }

    fn is_end_stream(&self) -> bool {
        self.is_end_stream
    }

    fn size_hint(&self) -> SizeHint {
        self.exact
            .map_or_else(SizeHint::default, SizeHint::with_exact)
    }
}

// a mounted request of `fields`, its body `handed`
fn mounted(
    (method, target): (&str, &str),
    (fields, handed): (&[(&str, &str)], Handed),
) -> ::http::Request<Handed> {
    let mut request = ::http::Request::new(handed);

    *request.method_mut() = method.parse().expect("a method");
    *request.uri_mut() = target.parse().expect("a target");
    request
        .headers_mut()
        .insert("host", ::http::HeaderValue::from_static("localhost"));

    for (name, value) in fields {
        request.headers_mut().append(
            ::http::header::HeaderName::from_bytes(name.as_bytes()).expect("a name"),
            ::http::HeaderValue::from_str(value).expect("a value"),
        );
    }

    request
}

// a response's body read whole
async fn body_of(response: ::http::Response<HttpGatewayBody>) -> Vec<u8> {
    let mut body = response.into_body();
    let mut read = Vec::new();

    while let Some(frame) = poll_fn(|context| Pin::new(&mut body).poll_frame(context)).await {
        if let Ok(data) = frame.expect("a frame").into_data() {
            read.extend_from_slice(&data);
        }
    }

    read
}

#[tokio::test]
async fn answers_a_route_on_its_own_listener_with_its_result_one_connection_an_exchange() {
    let fixture = Fixture::new(|_| {}, true).await;
    let mut socket = RawSocket::on(fixture.port).await;

    socket
        .write(&bytes_of(
            &head_of(
                ("POST", "/v1/echo"),
                (
                    fixture.port,
                    &["content-type: text/plain", "content-length: 2"],
                ),
            ),
            b"hi",
        ))
        .await
        .unwrap();

    let response = socket.response(PATIENCE).await.expect("its response");

    assert_eq!(response.head.status, 200, "answered");
    assert_eq!(response.body, b"hi", "its result");

    let fields = &response.head.fields;

    assert_eq!(
        fields.get("content-type").map(String::as_str),
        Some("text/plain;charset=utf-8")
    );
    assert_eq!(
        fields.get("cache-control").map(String::as_str),
        Some("no-store")
    );
    assert_eq!(fields.get("vary").map(String::as_str), Some("Origin"));
    assert_eq!(
        fields.get("x-content-type-options").map(String::as_str),
        Some("nosniff")
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1, "one call");
    assert!(
        fixture.handles.lock().unwrap()[0].contains("ip=127.0.0.1"),
        "its connection drawn from its caller's address"
    );
    fixture.until_drawn_none().await;
    fixture.stop().await;
}

#[tokio::test]
async fn refuses_by_its_gates_in_their_order_each_marked() {
    let fixture = Fixture::new(|_| {}, true).await;
    let port = fixture.port;
    let foreign = b"GET /v1/news HTTP/1.1\r\nHost: elsewhere.test\r\n\r\n".to_vec();
    let cases = [
        Case {
            request: foreign,
            status: 403,
            refusal: HTTP_REFUSALS.host,
            allow: None,
        },
        Case {
            request: bytes_of(&head_of(("GET", "/missing"), (port, &[])), b""),
            status: 404,
            refusal: HTTP_REFUSALS.path,
            allow: None,
        },
        Case {
            request: bytes_of(&head_of(("GET", "/v1/echo"), (port, &[])), b""),
            status: 405,
            refusal: HTTP_REFUSALS.method,
            allow: Some("POST"),
        },
        Case {
            request: bytes_of(&head_of(("get", "/openapi.json"), (port, &[])), b""),
            status: 405,
            refusal: HTTP_REFUSALS.method,
            allow: Some("GET, HEAD"),
        },
        Case {
            request: bytes_of(
                &head_of(
                    ("POST", "/v1/echo"),
                    (
                        port,
                        &["content-type: application/json", "content-length: 2"],
                    ),
                ),
                b"{}",
            ),
            status: 415,
            refusal: HTTP_REFUSALS.type_refused,
            allow: None,
        },
        Case {
            request: bytes_of(
                &head_of(("GET", "/v1/news"), (port, &["content-length: 2"])),
                b"{}",
            ),
            status: 400,
            refusal: HTTP_REFUSALS.malformed,
            allow: None,
        },
    ];

    for case in cases {
        let answer = raw_answer_of(port, &case.request).await;

        assert_eq!(
            (answer.status, answer.refusal.as_deref()),
            (case.status, Some(case.refusal)),
            "{}",
            String::from_utf8_lossy(&case.request)
        );
        assert_eq!(
            answer.fields.get("allow").map(String::as_str),
            case.allow,
            "its allow"
        );
        assert_eq!(
            answer.fields.get("content-type").map(String::as_str),
            Some(PROBLEM_MEDIA_TYPE),
            "a problem"
        );
    }

    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0, "no call made");
    fixture.stop().await;
}

#[tokio::test]
async fn serves_its_document_with_its_tag_a_304_to_a_request_that_holds_it_and_its_head_to_a_head()
{
    let fixture = Fixture::new(|_| {}, true).await;
    let port = fixture.port;
    let mut socket = RawSocket::on(port).await;

    socket
        .write(head_of(("GET", "/openapi.json"), (port, &[])).as_bytes())
        .await
        .unwrap();

    let response = socket.response(PATIENCE).await.expect("the document");
    let etag = response.head.fields.get("etag").cloned().expect("its tag");

    assert_eq!(response.head.status, 200);
    assert_eq!(response.body, DOCUMENT.as_bytes(), "byte for byte");
    assert_eq!(etag, etag_of(DOCUMENT.as_bytes()), "its SHA-256, quoted");
    assert_eq!(
        response
            .head
            .fields
            .get("cache-control")
            .map(String::as_str),
        Some("no-cache"),
        "revalidated, never no-store"
    );

    let matched = raw_answer_of(
        port,
        head_of(
            ("GET", "/openapi.json"),
            (port, &[&format!("if-none-match: \"other\", W/{etag}")]),
        )
        .as_bytes(),
    )
    .await;

    assert_eq!(matched.status, 304, "weakly matched");

    let head = raw_answer_of(
        port,
        head_of(("HEAD", "/openapi.json"), (port, &[])).as_bytes(),
    )
    .await;

    assert_eq!(head.status, 200);
    assert_eq!(
        head.fields.get("content-length").map(String::as_str),
        Some(DOCUMENT.len().to_string().as_str()),
        "its GET's length, no content"
    );
    fixture.stop().await;
}

#[tokio::test]
async fn answers_mounted_requests_a_caller_of_no_address_as_local_and_a_path_no_route_matches_404()
{
    let fixture = Fixture::new(|_| {}, false).await;
    let response = fixture
        .gateway
        .answer(
            mounted(
                ("POST", "/v1/echo"),
                (
                    &[("content-type", "text/plain"), ("content-length", "2")],
                    Handed {
                        frames: [Bytes::from_static(b"hi")].into(),
                        is_end_stream: false,
                        exact: Some(2),
                    },
                ),
            ),
            None,
        )
        .await;

    assert_eq!(response.status(), 200, "answered");
    assert_eq!(body_of(response).await, b"hi", "its result");
    assert!(
        fixture.handles.lock().unwrap()[0].contains("ip=local"),
        "a caller of no address, local"
    );

    let unknown = fixture
        .gateway
        .answer(
            mounted(
                ("GET", "/elsewhere"),
                (
                    &[],
                    Handed {
                        frames: VecDeque::new(),
                        is_end_stream: true,
                        exact: Some(0),
                    },
                ),
            ),
            Some(SocketAddr::from(([10, 0, 0, 1], 4_000))),
        )
        .await;

    assert_eq!(unknown.status(), 404, "a path no route matches");
    assert_eq!(
        unknown
            .headers()
            .get(REFUSAL_HEADER)
            .and_then(|value| value.to_str().ok()),
        Some(HTTP_REFUSALS.path)
    );
    fixture.until_drawn_none().await;
    fixture.stop().await;
}

#[tokio::test]
async fn refuses_500_a_body_read_before_it_mounted_reported_its_call_never_made_and_reads_one_its_hints_hide()
 {
    let fixture = Fixture::new(|_| {}, false).await;
    let echo = |handed: Handed| {
        mounted(
            ("POST", "/v1/echo"),
            (
                &[("content-type", "text/plain"), ("content-length", "2")],
                handed,
            ),
        )
    };
    let taken = [
        // (a) read whole and handed on, or replaced by an ended body
        Handed {
            frames: VecDeque::new(),
            is_end_stream: true,
            exact: Some(0),
        },
        // (a) one frame of it read
        Handed {
            frames: [Bytes::from_static(b"i")].into(),
            is_end_stream: false,
            exact: Some(1),
        },
        // (d) a stream of nothing, its hints hidden
        Handed {
            frames: VecDeque::new(),
            is_end_stream: false,
            exact: None,
        },
    ];

    for handed in taken {
        let response = fixture.gateway.answer(echo(handed), None).await;

        assert_eq!(response.status(), 500, "refused");
        assert_eq!(
            response
                .headers()
                .get("connection")
                .and_then(|value| value.to_str().ok()),
            Some("close"),
            "over HTTP/1, its connection closed"
        );
        assert!(
            !String::from_utf8_lossy(&body_of(response).await).contains("detail"),
            "no detail"
        );
    }

    assert_eq!(
        fixture.calls.load(Ordering::SeqCst),
        0,
        "its call never made"
    );
    assert_eq!(
        fixture.reported(),
        ["a body read before the gateway took its request"; 3],
        "reported"
    );

    let hidden = fixture
        .gateway
        .answer(
            echo(Handed {
                frames: [Bytes::from_static(b"hi")].into(),
                is_end_stream: false,
                exact: None,
            }),
            None,
        )
        .await;

    assert_eq!(hidden.status(), 200, "a wrapper that forwards neither hint");
    assert_eq!(body_of(hidden).await, b"hi");
    fixture.stop().await;
}

#[tokio::test]
async fn answers_a_head_that_asks_a_stream_at_its_head_frees_its_place_and_answers_its_socket_on() {
    let fixture = Fixture::new(
        |options| {
            options.maximum_connections_per_address = Some(1);
            options.heartbeat = Some(NEVER);
        },
        true,
    )
    .await;
    let port = fixture.port;
    let mut socket = RawSocket::on(port).await;

    socket
        .write(head_of(("HEAD", "/v1/news"), (port, &["accept: text/event-stream"])).as_bytes())
        .await
        .unwrap();

    let head = socket.head(PATIENCE).await.expect("its head");

    assert_eq!(head.status, 200, "its GET's head");
    assert_eq!(
        head.fields.get("content-type").map(String::as_str),
        Some(EVENT_STREAM_MEDIA_TYPE)
    );
    assert!(!head.fields.contains_key("content-length"), "no length");

    // * its place freed: the address's one stream is taken again
    let mut stream = RawSocket::on(port).await;

    stream
        .write(head_of(("GET", "/v1/news"), (port, &["accept: text/event-stream"])).as_bytes())
        .await
        .unwrap();
    assert_eq!(
        stream.head(PATIENCE).await.expect("a stream's head").status,
        200,
        "a second stream of its address"
    );

    // * the HEAD's socket answers on
    socket.reader = ResponseReader::new();
    socket
        .write(head_of(("GET", "/openapi.json"), (port, &[])).as_bytes())
        .await
        .unwrap();
    assert_eq!(
        socket
            .response(PATIENCE)
            .await
            .expect("its next")
            .head
            .status,
        200,
        "its next request answered"
    );
    drop(stream);
    fixture.stop().await;
}

#[tokio::test]
async fn drops_a_response_past_maximum_unsent_bytes_before_its_head_reported() {
    let fixture = Fixture::new(|options| options.maximum_unsent_bytes = Some(1), true).await;
    let mut socket = RawSocket::on(fixture.port).await;

    socket
        .write(head_of(("GET", "/openapi.json"), (fixture.port, &[])).as_bytes())
        .await
        .unwrap();
    assert!(socket.ended(PATIENCE).await, "its socket ended");
    assert!(socket.reader.head().is_none(), "nothing written");
    assert_eq!(
        fixture.reported(),
        ["the response is dropped: maximumUnsentBytes 1 bytes"],
        "its bound named"
    );
    fixture.stop().await;
}

#[tokio::test]
async fn refuses_a_window_of_0_a_member_given_in_its_policy_and_beside_it_and_two_routes_that_tie()
{
    let memory = MemoryTransportServer::new(&MemoryTransportServerOptions::default())
        .expect("the in-memory transport");
    let service = Service::new();
    let refusal = |options: &HttpGatewayOptions| {
        HttpGateway::new(options)
            .err()
            .map(|error| error.message().to_owned())
    };
    let mut options = HttpGatewayOptions::new(memory.clone(), service.routes());

    options.window = Some(0);
    assert_eq!(
        refusal(&options),
        Some("window is a whole number above 0, not 0".to_owned())
    );

    let mut options = HttpGatewayOptions::new(memory.clone(), service.routes());
    let policy = HttpPolicyOptions {
        hosts: Some(vec!["a.test".to_owned()]),
        ..HttpPolicyOptions::default()
    };
    options.policy = Some(HttpPolicy::of(&policy).expect("a policy"));
    options.hosts = Some(vec!["b.test".to_owned()]);
    assert_eq!(
        refusal(&options),
        Some("hosts is given in the policy and beside it: give it once".to_owned())
    );

    let mut routes = service.routes();

    routes.extend(service.routes().into_iter().take(1));
    assert_eq!(
        refusal(&HttpGatewayOptions::new(memory, routes)),
        Some("echo's route POST /v1/echo ties echo's route POST /v1/echo".to_owned())
    );
}

#[tokio::test]
async fn listens_once_until_it_stops_and_never_once_disposed() {
    let fixture = Fixture::new(|_| {}, true).await;
    let start = HttpGatewayStartOptions {
        address: Some(HOST.to_owned()),
        find_open_port: Some(true),
        ..HttpGatewayStartOptions::default()
    };
    assert_eq!(
        fixture
            .gateway
            .start(&start)
            .await
            .expect_err("a second start")
            .to_string(),
        "a gateway listens once"
    );
    fixture.gateway.stop().await.expect("stopped");
    fixture
        .gateway
        .start(&start)
        .await
        .expect("listening again");
    fixture.gateway.dispose().await.expect("disposed");
    assert_eq!(
        fixture
            .gateway
            .start(&start)
            .await
            .expect_err("a start once disposed")
            .to_string(),
        "the gateway is disposed"
    );
    fixture.server.dispose().await.expect("the server disposed");
}

#[tokio::test]
async fn writes_a_stream_its_result_then_each_notification_each_event_an_id() {
    let fixture = Fixture::new(|options| options.heartbeat = Some(NEVER), true).await;
    let port = fixture.port;
    let mut socket = TcpStream::connect((HOST, port)).await.unwrap();
    let mut read = Vec::new();
    let mut chunk = [0_u8; 4_096];

    tokio::io::AsyncWriteExt::write_all(
        &mut socket,
        head_of(("GET", "/v1/news"), (port, &["accept: text/event-stream"])).as_bytes(),
    )
    .await
    .unwrap();

    let opened = patience(PATIENCE, async {
        while !String::from_utf8_lossy(&read).contains(
            "event: result
id: 1
data: \"open\"

",
        ) {
            let count = tokio::io::AsyncReadExt::read(&mut socket, &mut chunk)
                .await
                .unwrap();

            assert!(count > 0, "its stream open");
            read.extend_from_slice(&chunk[..count]);
        }
    })
    .await;

    assert!(
        opened.is_ok(),
        "its result first: {}",
        String::from_utf8_lossy(&read)
    );
    assert!(
        String::from_utf8_lossy(&read).contains("content-type: text/event-stream"),
        "a stream's head"
    );

    let notified = patience(PATIENCE, async {
        while !String::from_utf8_lossy(&read).contains(
            "id: 2
data: \"tick\"

",
        ) {
            fixture
                .news
                .notify(
                    "tick".to_owned(),
                    &crate::managers::service::NotifyOptions::default(),
                )
                .await;

            let count = tokio::io::AsyncReadExt::read(&mut socket, &mut chunk)
                .await
                .unwrap();

            assert!(count > 0, "its stream open");
            read.extend_from_slice(&chunk[..count]);
        }
    })
    .await;

    assert!(
        notified.is_ok(),
        "a notification a plain event: {}",
        String::from_utf8_lossy(&read)
    );
    drop(socket);
    fixture.until_drawn_none().await;
    fixture.stop().await;
}

#[tokio::test]
async fn answers_a_mounted_head_that_asks_a_stream_with_an_ended_body_and_frees_its_place() {
    let fixture = Fixture::new(
        |options| {
            options.maximum_connections_per_address = Some(1);
            options.heartbeat = Some(NEVER);
        },
        false,
    )
    .await;
    let asking = |method: &str| {
        mounted(
            (method, "/v1/news"),
            (
                &[("accept", EVENT_STREAM_MEDIA_TYPE)],
                Handed {
                    frames: VecDeque::new(),
                    is_end_stream: true,
                    exact: Some(0),
                },
            ),
        )
    };
    let head = fixture.gateway.answer(asking("HEAD"), None).await;

    assert_eq!(head.status(), 200, "its GET's head");
    assert_eq!(
        head.headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some(EVENT_STREAM_MEDIA_TYPE)
    );
    assert!(
        head.body().is_end_stream(),
        "ended at its head, which HTTP/2 ends its stream with"
    );

    let stream = fixture.gateway.answer(asking("GET"), None).await;

    assert_eq!(stream.status(), 200, "a second stream of its address");
    assert!(!stream.body().is_end_stream(), "a stream open");
    drop((head, stream));
    fixture.until_drawn_none().await;
    fixture.stop().await;
}

#[tokio::test]
async fn drops_on_its_own_listener_a_response_its_reader_stalls_past_its_deadline_reported() {
    let document = Bytes::from(vec![b' '; 4 * 1_048_576]);
    let fixture = Fixture::new(
        |options| {
            options.document = Some(document);
            options.minimum_send_bytes_per_second = Some(100_000_000);
            options.send_grace_period = Some(Duration::from_millis(1));
        },
        true,
    )
    .await;
    let mut socket = RawSocket::reading_little(fixture.port).await;

    socket
        .write(head_of(("GET", "/openapi.json"), (fixture.port, &[])).as_bytes())
        .await
        .unwrap();
    patience(PATIENCE, async {
        while fixture.reported().is_empty() {
            crate::testing::rest(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("dropped in time");
    assert_eq!(
        fixture.reported(),
        ["the response is dropped: minimumSendBytesPerSecond 100000000 after sendGracePeriod 1ms"],
        "its pace named"
    );
    assert!(socket.ended(PATIENCE).await, "its socket dropped");
    fixture.stop().await;
}
