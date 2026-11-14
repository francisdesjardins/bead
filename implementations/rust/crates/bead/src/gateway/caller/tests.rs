//! The caller over hand-built `json`, `text` and `raw` routes: through a gateway on its own
//! listener, and against a scripted listener for what a gateway would not answer.

use std::sync::Mutex;

use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::*;
use crate::constants::ProcedureKind;
use crate::failure::FailureOrigin;
use crate::gateway::host::{HttpGateway, HttpGatewayOptions, HttpGatewayStartOptions};
use crate::http::peer::{HOST, PATIENCE};
use crate::identity::Procedure;
use crate::managers::service::NotifyOptions;
use crate::memory::{MemoryTransportServer, MemoryTransportServerOptions};
use crate::payloads::{JsonCodec, RawCodec, TextCodec};
use crate::server::{Server, ServerOptions};
use crate::service::{
    AdmissionRule, DescriptorInit, ServiceProcedure, ServiceServer, ServiceServerOptions,
    notifying_of, request_of,
};
use crate::testing::patience;
use crate::transcoding::routes::{HttpRouteInit, HttpRouteTemplate, route_of};

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

// the service called: `echo` of a text, `raw` of bytes, `json` of a value, and `news` and `bytes`,
// which notify, each on its default route
struct Service {
    echo: Descriptor<TextCodec, TextCodec>,
    raw: Descriptor<RawCodec, RawCodec>,
    json: Descriptor<JsonCodec, JsonCodec>,
    news: NotifyingDescriptor<TextCodec, TextCodec, TextCodec>,
    bytes: NotifyingDescriptor<RawCodec, RawCodec, RawCodec>,
}

// a default route: a `POST` of its request whole
fn default_route(name: &str) -> Vec<HttpRouteTemplate> {
    vec![HttpRouteTemplate {
        method: HttpMethod::Post,
        template: format!("/api/S/{name}"),
        body: Some("*".to_owned()),
        response_body: None,
    }]
}

impl Service {
    fn new() -> Self {
        let notifies = Some(ProcedureKind::Notifies);

        Self {
            echo: request_of(init(procedure("echo", (1, None)), TextCodec)).expect("echo"),
            raw: request_of(init(procedure("raw", (2, None)), RawCodec)).expect("raw"),
            json: request_of(init(procedure("json", (3, None)), JsonCodec)).expect("json"),
            news: notifying_of(init(procedure("news", (4, notifies)), TextCodec), TextCodec)
                .expect("news"),
            bytes: notifying_of(init(procedure("bytes", (5, notifies)), RawCodec), RawCodec)
                .expect("bytes"),
        }
    }

    fn procedures(&self) -> Vec<ServiceProcedure> {
        vec![
            ServiceProcedure::from(&self.echo),
            ServiceProcedure::from(&self.raw),
            ServiceProcedure::from(&self.json),
            ServiceProcedure::from(&self.news),
            ServiceProcedure::from(&self.bytes),
        ]
    }

    // its routes, in its procedures' order
    fn routes(&self) -> Vec<HttpRoute> {
        let route = |procedure: ServiceProcedure, (payload, notification): (HttpPayload, bool)| {
            let name = procedure.procedure().procedure_name.clone();

            route_of(HttpRouteInit {
                procedure,
                request: payload.clone(),
                result: payload.clone(),
                notification: notification.then_some(payload),
                failures: vec![],
                no_side_effects: false,
                routes: default_route(&name),
            })
            .expect("a route")
        };

        vec![
            route(
                ServiceProcedure::from(&self.echo),
                (HttpPayload::Text, false),
            ),
            route(ServiceProcedure::from(&self.raw), (HttpPayload::Raw, false)),
            route(
                ServiceProcedure::from(&self.json),
                (HttpPayload::Json, false),
            ),
            route(
                ServiceProcedure::from(&self.news),
                (HttpPayload::Text, true),
            ),
            route(
                ServiceProcedure::from(&self.bytes),
                (HttpPayload::Raw, true),
            ),
        ]
    }
}

fn caller_of(url: &str, options: &HttpCallerOptions) -> HttpCaller {
    HttpCaller::new(url, options).expect("the caller")
}

fn failure_of_error(error: CallError) -> Failure {
    let CallError::Failure(failure) = error else {
        panic!("a failure, not {error:?}");
    };

    failure
}

// what a call's future ends with, within the tests' patience
async fn settled<T>(future: BoxFuture<Result<T, CallError>>) -> Result<T, CallError> {
    patience(PATIENCE, future).await.expect("settled in time")
}

// ── A scripted listener ──────────────────────────────────────────────────────────────────────

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

        drop(crate::testing::spawn(async move {
            for answer in answers {
                let Ok((mut socket, _peer)) = listener.accept().await else {
                    return;
                };
                let request = request_of_socket(&mut socket).await;

                kept.lock().unwrap().push(request);
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
        self.requests.lock().unwrap().clone()
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

// a stream of `events`, ended as its socket closes
fn stream_answer_of(events: &str) -> Vec<u8> {
    answer_of(("200 OK", &["content-type: text/event-stream"]), events)
}

// ── The tests ────────────────────────────────────────────────────────────────────────────────

// the service offered on `server`, each procedure answered: `echo` its text and a `!`, `raw` and
// `json` their payloads, `news` `open`, `bytes` nothing
fn offered_on(service: &Service, server: &Server) -> ServiceServer {
    let offered = ServiceServer::new(service.procedures(), &ServiceServerOptions::default())
        .expect("its service");

    offered
        .on(
            &service.echo,
            Arc::new(|request, response| response.result(format!("{}!", request.payload))),
        )
        .expect("echo answered");
    offered
        .on(
            &service.raw,
            Arc::new(|request, response| response.result(request.payload)),
        )
        .expect("raw answered");
    offered
        .on(
            &service.json,
            Arc::new(|request, response| response.result(request.payload)),
        )
        .expect("json answered");
    offered
        .on_notifying(
            &service.news,
            Arc::new(|_request, response| response.result("open".to_owned())),
        )
        .expect("news answered");
    offered
        .on_notifying(
            &service.bytes,
            Arc::new(|_request, response| response.result(Bytes::new())),
        )
        .expect("bytes answered");
    offered.offer(server).expect("offered");

    offered
}

#[tokio::test]
async fn calls_a_text_a_raw_and_a_json_route_and_reads_a_stream_through_a_gateway() {
    let memory = MemoryTransportServer::new(&MemoryTransportServerOptions::default())
        .expect("the in-memory transport");
    let server =
        Server::new(Arc::new(memory.clone()), &ServerOptions::default()).expect("the server");
    let service = Service::new();
    let offered = offered_on(&service, &server);
    let news = offered.notifier_of(&service.news).expect("news' notifier");

    memory.start().await.expect("started");

    let gateway = HttpGateway::new(&HttpGatewayOptions::new(memory.clone(), service.routes()))
        .expect("the gateway");
    let start = HttpGatewayStartOptions {
        address: Some(HOST.to_owned()),
        port: Some(0),
        find_open_port: Some(true),
        ..HttpGatewayStartOptions::default()
    };
    let port = gateway.start(&start).await.expect("listening").port;
    let caller = caller_of(
        &format!("http://{HOST}:{port}"),
        &HttpCallerOptions::default(),
    );
    let routes = service.routes();
    let options = HttpCallOptions::default();
    let echo = caller
        .requester_of(&routes[0], &service.echo)
        .expect("echo's requester");
    let raw = caller
        .requester_of(&routes[1], &service.raw)
        .expect("raw's requester");
    let json = caller
        .requester_of(&routes[2], &service.json)
        .expect("json's requester");
    let subscriber = caller
        .subscriber_of(&routes[3], &service.news)
        .expect("news' subscriber");

    assert_eq!(
        settled(echo.call(&"hi".to_owned(), &options))
            .await
            .expect("echo's result"),
        "hi!",
        "a text payload goes as its text and comes back as its result's"
    );
    assert_eq!(
        settled(raw.call(&Bytes::from_static(&[0, 255, 7]), &options))
            .await
            .expect("raw's result"),
        Bytes::from_static(&[0, 255, 7]),
        "a raw payload goes as its bytes"
    );
    assert_eq!(
        settled(json.call(&serde_json::json!({"a": [1, "b", null]}), &options))
            .await
            .expect("json's result"),
        serde_json::json!({"a": [1, "b", null]}),
        "a json payload goes as its JSON text"
    );

    let mut subscription = subscriber.call(&String::new(), &options);

    assert_eq!(
        patience(PATIENCE, subscription.next())
            .await
            .expect("in time")
            .expect("its result")
            .expect("no error"),
        HttpEvent::Result("open".to_owned()),
        "a stream's first event is its result"
    );

    news.notify("first".to_owned(), &NotifyOptions::default())
        .await;

    assert_eq!(
        patience(PATIENCE, subscription.next())
            .await
            .expect("in time")
            .expect("its notification")
            .expect("no error"),
        HttpEvent::Notification("first".to_owned()),
        "each event after it a notification"
    );

    drop(subscription);
    gateway.dispose().await.expect("the gateway disposed");
    server.dispose().await.expect("the server disposed");
}

#[tokio::test]
async fn refuses_a_url_of_another_scheme_or_with_user_information_a_query_or_a_fragment_and_a_bound_of_0()
 {
    for url in [
        "http://user:secret@localhost",
        "http://localhost?x=1",
        "http://localhost/#fragment",
        "ftp://localhost",
        "localhost",
        "http://",
    ] {
        let refused = HttpCaller::new(url, &HttpCallerOptions::default())
            .expect_err("a URL outside the caller's contract");

        assert_eq!(refused.message(), URL_REFUSED, "{url} is refused");
    }

    let bounded = HttpCallerOptions {
        maximum_body_bytes: Some(0),
        ..HttpCallerOptions::default()
    };

    assert!(
        HttpCaller::new("http://localhost", &bounded).is_err(),
        "a bound of 0 is refused"
    );
    assert!(
        HttpCaller::new("HTTPS://Example.COM", &HttpCallerOptions::default()).is_ok(),
        "a scheme is read without its case"
    );
}

#[tokio::test]
async fn resolves_each_default_route_under_its_base_path_and_refuses_another_procedure_s_or_no_default_one()
 {
    let service = Service::new();
    let routes = service.routes();

    for path in ["/proxy", "/proxy/"] {
        let scripted = Scripted::new(vec![whole_answer_of(("200 OK", "text/plain"), "ok")]).await;
        let caller = caller_of(
            &format!("{}{path}", scripted.url()),
            &HttpCallerOptions::default(),
        );
        let echo = caller
            .requester_of(&routes[0], &service.echo)
            .expect("echo's requester");

        assert_eq!(
            settled(echo.call(&"hi".to_owned(), &HttpCallOptions::default()))
                .await
                .expect("its result"),
            "ok",
            "the result read"
        );

        let request = &scripted.requests()[0];

        assert!(
            request.starts_with("POST /proxy/api/S/echo HTTP/1.1\r\n"),
            "the route resolved under its base's path: {request}"
        );
        assert!(
            request.contains("content-type: text/plain\r\n") && request.ends_with("\r\n\r\nhi"),
            "a text request goes as its text: {request}"
        );
    }

    let caller = caller_of("http://localhost/a/b", &HttpCallerOptions::default());

    assert!(
        caller.requester_of(&routes[1], &service.echo).is_err(),
        "a route of another procedure is refused"
    );

    let ruled = route_of(HttpRouteInit {
        procedure: ServiceProcedure::from(&service.echo),
        request: HttpPayload::Text,
        result: HttpPayload::Text,
        notification: None,
        failures: vec![],
        no_side_effects: false,
        routes: vec![HttpRouteTemplate {
            method: HttpMethod::Get,
            template: "/v1/echo/{text}".to_owned(),
            body: None,
            response_body: None,
        }],
    })
    .expect("a rule's route");
    let refused = caller
        .requester_of(&ruled, &service.echo)
        .expect_err("a route of no default one");

    assert_eq!(refused.message(), DEFAULT_ROUTE, "its words");
    assert_eq!(
        without_dot_segments("/a/b/../c/./d/.."),
        "/a/c/",
        "dot segments removed as RFC 3986 removes them"
    );
}

#[tokio::test]
async fn presents_its_credential_or_the_call_s_own_and_none_when_empty_or_omitted() {
    let service = Service::new();
    let routes = service.routes();
    let answers = (0..4)
        .map(|_| whole_answer_of(("200 OK", "text/plain"), "ok"))
        .collect();
    let scripted = Scripted::new(answers).await;
    let caller = caller_of(
        &scripted.url(),
        &HttpCallerOptions {
            authorization: Some("Bearer default".to_owned()),
            ..HttpCallerOptions::default()
        },
    );
    let echo = caller
        .requester_of(&routes[0], &service.echo)
        .expect("echo's requester");
    let given =
        |authorization: Option<&str>, without_authorization: Option<bool>| HttpCallOptions {
            authorization: authorization.map(str::to_owned),
            without_authorization,
            ..HttpCallOptions::default()
        };

    for options in [
        given(None, None),
        given(Some("Bearer own"), None),
        given(Some(""), None),
        given(Some("Bearer own"), Some(true)),
    ] {
        settled(echo.call(&String::new(), &options))
            .await
            .expect("its result");
    }

    let presented: Vec<Option<String>> = scripted
        .requests()
        .iter()
        .map(|request| {
            request
                .lines()
                .find_map(|line| line.strip_prefix("authorization: "))
                .map(str::to_owned)
        })
        .collect();

    assert_eq!(
        presented,
        [
            Some("Bearer default".to_owned()),
            Some("Bearer own".to_owned()),
            None,
            None
        ],
        "its default, the call's own, none for an empty one, none where it is omitted"
    );
}

#[tokio::test]
async fn refuses_a_credential_in_the_clear_or_of_no_field_value_before_anything_goes() {
    let service = Service::new();
    let routes = service.routes();
    let caller = caller_of(
        "http://example.com",
        &HttpCallerOptions {
            authorization: Some("Bearer good".to_owned()),
            ..HttpCallerOptions::default()
        },
    );
    let echo = caller
        .requester_of(&routes[0], &service.echo)
        .expect("echo's requester");
    let failure = failure_of_error(
        settled(echo.call(&String::new(), &HttpCallOptions::default()))
            .await
            .expect_err("a credential in the clear"),
    );

    assert_eq!(
        (
            failure.protocol_code(),
            failure.origin(),
            failure.side(),
            failure.detail()
        ),
        (
            Some(ProtocolCode::DESTINATION_UNREACHABLE),
            FailureOrigin::Local,
            Some(RouterSide::Client),
            ""
        ),
        "refused here, before it goes"
    );

    let refused = settled(echo.call(
        &String::new(),
        &HttpCallOptions {
            authorization: Some("Bearer\nsplit".to_owned()),
            ..HttpCallOptions::default()
        },
    ))
    .await
    .expect_err("a credential of no field value");

    assert!(
        matches!(&refused, CallError::Refused(error) if error.message() == NO_FIELD_VALUE),
        "refused as its caller's bug: {refused:?}"
    );

    for url in [
        "https://example.com",
        "http://LOCALHOST",
        "http://127.1",
        "http://[::1]",
    ] {
        let caller = caller_of(
            url,
            &HttpCallerOptions {
                authorization: Some("Bearer good".to_owned()),
                ..HttpCallerOptions::default()
            },
        );
        let echo = caller
            .requester_of(&routes[0], &service.echo)
            .expect("echo's requester");

        assert!(echo.bound.is_secure, "{url} may carry a credential");
    }
}

// a gateway's own problem, its words its own
const GATE: &str = "{\"type\":\"about:blank\",\"detail\":\"by the gate\"}";

#[tokio::test]
async fn reads_a_problem_as_its_bead_failure_or_a_gateway_s_own_by_its_refusal_then_its_status() {
    let service = Service::new();
    let routes = service.routes();
    let problem = "application/problem+json";
    let scripted = Scripted::new(vec![
        whole_answer_of(
            ("422 Unprocessable Content", problem),
            "{\"code\":1e0,\"scope\":\"application\",\"detail\":\"by choice\"}",
        ),
        answer_of(
            (
                "503 Service Unavailable",
                &[
                    "content-type: Application/Problem+JSON",
                    "bead-refusal: busy",
                    "retry-after: 7",
                    &format!("content-length: {}", GATE.len()),
                ],
            ),
            GATE,
        ),
        answer_of(
            ("401 Unauthorized", &["retry-after: 3", "content-length: 0"]),
            "",
        ),
        answer_of(
            (
                "307 Temporary Redirect",
                &["location: /elsewhere", "content-length: 0"],
            ),
            "",
        ),
        whole_answer_of(("500 Internal Server Error", problem), "{\"code\":\"7\"}"),
        whole_answer_of(("408 Request Timeout", problem), "{\"status\":408}"),
    ])
    .await;
    let caller = caller_of(&scripted.url(), &HttpCallerOptions::default());
    let echo = caller
        .requester_of(&routes[0], &service.echo)
        .expect("echo's requester");
    let mut failures = Vec::new();

    for _ in 0..6 {
        let failure = failure_of_error(
            settled(echo.call(&String::new(), &HttpCallOptions::default()))
                .await
                .expect_err("a problem"),
        );

        failures.push((
            failure.code().get(),
            failure.scope(),
            failure.origin(),
            failure.detail().to_owned(),
        ));
    }

    let (peer, protocol) = (FailureOrigin::Peer, FailureScope::Protocol);

    assert_eq!(
        failures,
        [
            (1, FailureScope::Application, peer, "by choice".to_owned()),
            (
                35,
                protocol,
                peer,
                "the HTTP call answers 503; Retry-After: 7; by the gate".to_owned()
            ),
            (
                32,
                protocol,
                peer,
                "the HTTP call answers 401; Retry-After: 3".to_owned()
            ),
            (65, protocol, peer, "the HTTP call answers 307".to_owned()),
            (
                50,
                protocol,
                FailureOrigin::Local,
                "the HTTP problem holds no Bead failure".to_owned()
            ),
            (17, protocol, peer, "the HTTP call answers 408".to_owned()),
        ],
        "a Bead failure by its code, a gateway's own by its refusal then its status, an unmarked \
         status by its own, a problem of neither refused"
    );
}

#[tokio::test]
async fn bounds_a_body_and_refuses_a_result_of_another_media_type() {
    let service = Service::new();
    let routes = service.routes();
    let scripted = Scripted::new(vec![
        whole_answer_of(("200 OK", "text/plain"), "12345"),
        whole_answer_of(("200 OK", "text/html"), "ok"),
        whole_answer_of(("200 OK", "Text/Plain; charset=utf-8"), "1234"),
    ])
    .await;
    let caller = caller_of(
        &scripted.url(),
        &HttpCallerOptions {
            maximum_body_bytes: Some(4),
            ..HttpCallerOptions::default()
        },
    );
    let echo = caller
        .requester_of(&routes[0], &service.echo)
        .expect("echo's requester");
    let options = HttpCallOptions::default();
    let large = failure_of_error(
        settled(echo.call(&String::new(), &options))
            .await
            .expect_err("a body past its bound"),
    );
    let other = failure_of_error(
        settled(echo.call(&String::new(), &options))
            .await
            .expect_err("a result of another media type"),
    );

    assert_eq!(
        (large.protocol_code(), large.origin(), large.detail()),
        (
            Some(ProtocolCode::PAYLOAD_TOO_LARGE),
            FailureOrigin::Local,
            "the HTTP body passes maximumBodyBytes"
        ),
        "a body past its bound"
    );
    assert_eq!(
        (other.protocol_code(), other.detail()),
        (
            Some(ProtocolCode::PAYLOAD_UNDECODABLE),
            "the HTTP result has another media type"
        ),
        "a result of another media type"
    );
    assert_eq!(
        settled(echo.call(&String::new(), &options))
            .await
            .expect("its result"),
        "1234",
        "a media type read without its case or its parameters"
    );
}

#[tokio::test]
async fn reads_a_stream_s_result_then_its_notifications_then_the_failure_that_ends_it() {
    let service = Service::new();
    let routes = service.routes();
    let scripted = Scripted::new(vec![
        stream_answer_of(concat!(
            "\u{feff}: a comment\r\n",
            "event: result\r\nid: 0\r\ndata: \"op\r\n\r\n",
            "data:\"next\"\r\n\r\n",
            "event: message\ndata: \"two\"\n\n",
            "event: failure\rdata: {\"code\":65,\r",
            "data: \"scope\":\"protocol\"}\r\r",
        )),
        stream_answer_of("event: result\ndata: \"open\"\n\n"),
        stream_answer_of("data: \"early\"\n\n"),
    ])
    .await;
    let caller = caller_of(&scripted.url(), &HttpCallerOptions::default());
    let subscriber = caller
        .subscriber_of(&routes[3], &service.news)
        .expect("news' subscriber");
    let options = HttpCallOptions::default();
    let read = |subscription: HttpSubscription<String, String>| async move {
        patience(PATIENCE, subscription.collect::<Vec<_>>())
            .await
            .expect("read in time")
    };
    let first = read(subscriber.call(&String::new(), &options)).await;

    assert!(
        matches!(&first[0], Err(error) if matches!(error, CallError::Failure(failure)
            if failure.protocol_code() == Some(ProtocolCode::PAYLOAD_UNDECODABLE))),
        "a text event whose data is no JSON string fails, and ends it: {first:?}"
    );
    assert_eq!(first.len(), 1, "nothing comes after an error");

    let ended = read(subscriber.call(&String::new(), &options)).await;

    assert_eq!(ended.len(), 2, "its result, then its end: {ended:?}");
    assert_eq!(
        failure_of_error(ended[1].clone().expect_err("its end")).detail(),
        "the HTTP event stream ends without a failure",
        "a stream that ends without its failure"
    );

    let early = read(subscriber.call(&String::new(), &options)).await;

    assert_eq!(
        failure_of_error(early[0].clone().expect_err("a notification first")).detail(),
        "the HTTP event stream holds one result then notifications",
        "a notification before its result"
    );

    let scripted = Scripted::new(vec![stream_answer_of(concat!(
        "\u{feff}: a comment\r\n",
        "event: result\r\nid: 0\r\ndata: \"open\"\r\n\r\n",
        "data:\"next\"\r\n\r\n",
        "event: message\ndata: \"two\"\n\n",
        "event: failure\rdata: {\"code\":65,\r",
        "data: \"scope\":\"protocol\"}\r\r",
    ))])
    .await;
    let caller = caller_of(&scripted.url(), &HttpCallerOptions::default());
    let subscriber = caller
        .subscriber_of(&routes[3], &service.news)
        .expect("news' subscriber");
    let events = read(subscriber.call(&String::new(), &options)).await;

    assert_eq!(
        events.len(),
        4,
        "three events, then its failure: {events:?}"
    );
    assert_eq!(
        events[..3]
            .iter()
            .map(|event| event.clone().expect("an event"))
            .collect::<Vec<_>>(),
        [
            HttpEvent::Result("open".to_owned()),
            HttpEvent::Notification("next".to_owned()),
            HttpEvent::Notification("two".to_owned()),
        ],
        "its result, then each notification, whatever ends its lines, a BOM and a comment aside"
    );

    let failure = failure_of_error(events[3].clone().expect_err("its failure"));

    assert_eq!(
        (failure.protocol_code(), failure.origin()),
        (Some(ProtocolCode::DESTINATION_LOST), FailureOrigin::Peer),
        "the failure that ends it, its data's lines joined"
    );
    assert!(
        scripted.requests()[0].contains("accept: text/event-stream\r\n"),
        "a stream asked by its accept"
    );
}

#[tokio::test]
async fn reads_raw_event_data_in_standard_padded_base64_alone_and_bounds_each_event() {
    let service = Service::new();
    let routes = service.routes();
    let scripted = Scripted::new(vec![
        stream_answer_of("event: result\ndata: \"AAE=\"\n\ndata: \"AAE\"\n\n"),
        stream_answer_of("event: result\ndata: \"%%\"\n\n"),
        stream_answer_of(
            "event: result\ndata: \"AAE=\"\n\ndata: \"0123456789012345678901234567\"\n\n",
        ),
    ])
    .await;
    let caller = caller_of(
        &scripted.url(),
        &HttpCallerOptions {
            maximum_body_bytes: Some(32),
            ..HttpCallerOptions::default()
        },
    );
    let subscriber = caller
        .subscriber_of(&routes[4], &service.bytes)
        .expect("bytes' subscriber");
    let options = HttpCallOptions::default();
    let read = |subscription: HttpSubscription<Bytes, Bytes>| async move {
        patience(PATIENCE, subscription.collect::<Vec<_>>())
            .await
            .expect("read in time")
    };
    let unpadded = read(subscriber.call(&Bytes::new(), &options)).await;

    assert_eq!(
        unpadded[0].clone().expect("its result"),
        HttpEvent::Result(Bytes::from_static(&[0, 1])),
        "raw data in base64"
    );
    assert_eq!(
        failure_of_error(unpadded[1].clone().expect_err("unpadded")).detail(),
        "an HTTP raw event holds standard padded base64",
        "base64 not in its standard padded form"
    );

    let malformed = read(subscriber.call(&Bytes::new(), &options)).await;

    assert_eq!(
        failure_of_error(malformed[0].clone().expect_err("no base64")).detail(),
        UNDECODABLE,
        "what is no base64"
    );

    let large = read(subscriber.call(&Bytes::new(), &options)).await;

    assert_eq!(
        failure_of_error(large[1].clone().expect_err("past its bound")).detail(),
        "the HTTP event passes maximumBodyBytes",
        "an event past its bound, each event counted alone"
    );
}

#[tokio::test]
async fn ends_a_call_and_a_stream_its_signal_gives_up_as_cancelled() {
    let service = Service::new();
    let routes = service.routes();
    // a listener that never accepts: the request goes, and nothing answers it
    let listener = TcpListener::bind((HOST, 0)).await.expect("bound");
    let url = format!(
        "http://{HOST}:{}",
        listener.local_addr().expect("its address").port()
    );
    let caller = caller_of(&url, &HttpCallerOptions::default());
    let echo = caller
        .requester_of(&routes[0], &service.echo)
        .expect("echo's requester");
    let subscriber = caller
        .subscriber_of(&routes[3], &service.news)
        .expect("news' subscriber");
    let signal = CancellationToken::new();
    let options = HttpCallOptions {
        signal: Some(signal.clone()),
        ..HttpCallOptions::default()
    };
    let call = echo.call(&String::new(), &options);
    let mut subscription = subscriber.call(&String::new(), &options);

    signal.cancel();

    assert!(
        matches!(settled(call).await, Err(CallError::Cancelled(None))),
        "a call given up"
    );
    assert!(
        matches!(
            patience(PATIENCE, subscription.next()).await,
            Ok(Some(Err(CallError::Cancelled(None))))
        ),
        "a stream given up"
    );
    assert!(
        matches!(
            settled(echo.call(&String::new(), &options)).await,
            Err(CallError::Cancelled(None))
        ),
        "a call whose signal gave it up already never goes"
    );

    drop(listener);
}

#[test]
fn frames_events_across_chunks_by_any_line_end_and_refuses_a_line_of_no_utf_8() {
    let mut framing = Framing::new(64);
    let mut framed = Vec::new();
    let text = "event: result\r\ndata: \u{e9}t\u{e9}\r\n\r\n".as_bytes();

    for byte in text {
        framing
            .feed((core::slice::from_ref(byte), &mut framed))
            .expect("framed");
    }

    assert_eq!(framed.len(), 1, "one event");
    assert_eq!(
        (framed[0].name.as_str(), framed[0].data.as_str()),
        ("result", "\u{e9}t\u{e9}"),
        "its UTF-8 read whole across its chunks, its CRLF one line end"
    );

    let mut framing = Framing::new(64);
    let refused = framing
        .feed((b"data: \xff\n", &mut framed))
        .expect_err("no UTF-8");

    assert_eq!(
        failure_of_error(refused).detail(),
        UNDECODABLE,
        "a line of no UTF-8 is refused"
    );
    assert_eq!(
        failure_of_error(Framing::new(64).end()).detail(),
        "the HTTP event stream ends without a failure",
        "an end with no failure"
    );
}
