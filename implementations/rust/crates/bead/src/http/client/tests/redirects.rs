//! Redirects (spec 15.6): a listener answers an exchange with a redirect to a second, the target,
//! which keeps every request; a server stands behind the first where an exchange must reach one.

use super::*;
use crate::http::server::HttpTransportServer;
use crate::router::types::ConnectionHandle;

// Fetch's redirect statuses
const REDIRECTS: [u16; 5] = [301, 302, 303, 307, 308];

// what a request is, as a listener in front of the server judges it
struct Asked {
    method: String,
    // it presents a connection's token: an exchange on a connection drawn
    is_exchange: bool,
}

// the redirect a request is answered with, its status and its fields: none forwards it
type RedirectOf = Arc<dyn Fn(&Asked) -> Option<(u16, Vec<(String, String)>)> + Send + Sync>;

/// How a listener in front of a server answers.
struct RedirectingOptions {
    redirect_of: RedirectOf,
    /// The port of the server it forwards the rest to: none answers them 502.
    upstream: Option<u16>,
}

/// A listener in front of the server at its upstream, which answers each request its redirect
/// gives a redirect for with it, its `Location` the target, and forwards the rest; the methods it
/// forwarded.
struct Redirecting {
    port: u16,
    forwarded: Arc<Mutex<Vec<String>>>,
    stop: CancellationToken,
}

impl Drop for Redirecting {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

impl Redirecting {
    fn forwarded(&self) -> Vec<String> {
        locked(&self.forwarded).clone()
    }
}

async fn redirecting(location: u16, options: &RedirectingOptions) -> Redirecting {
    let listener = TcpListener::bind((HOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let forwarded: Arc<Mutex<Vec<String>>> = Arc::default();
    let stop = CancellationToken::new();
    let (keeping, ending) = (Arc::clone(&forwarded), stop.clone());
    let (redirect_of, upstream) = (Arc::clone(&options.redirect_of), options.upstream);

    drop(spawn(async move {
        while let Some(Ok((socket, _))) = unless_ended(&ending, listener.accept()).await {
            let route = Route {
                location,
                upstream,
                redirect_of: Arc::clone(&redirect_of),
                forwarded: Arc::clone(&keeping),
            };
            let ending = ending.clone();

            drop(spawn(async move {
                Box::pin(unless_ended(&ending, passing(socket, &route))).await;
            }));
        }
    }));

    Redirecting {
        port,
        forwarded,
        stop,
    }
}

// where a request goes: redirected to the target at `location`, or forwarded to `upstream`, the
// methods forwarded kept
struct Route {
    location: u16,
    upstream: Option<u16>,
    redirect_of: RedirectOf,
    forwarded: Arc<Mutex<Vec<String>>>,
}

// one request of a client's: redirected, or forwarded with its connection closed after it, its
// answer copied back to its end
async fn passing(mut socket: TcpStream, route: &Route) {
    let Some((mut read, head_length)) = request_of(&mut socket).await else {
        return;
    };
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut parsed = httparse::Request::new(&mut headers);

    parsed.parse(&read).unwrap();

    let asked = Asked {
        method: parsed.method.unwrap_or_default().to_owned(),
        is_exchange: parsed
            .headers
            .iter()
            .any(|header| header.name.eq_ignore_ascii_case(CONNECTION_TOKEN_HEADER)),
    };
    let length: usize = parsed
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("content-length"))
        .and_then(|header| core::str::from_utf8(header.value).ok())
        .and_then(|length| length.parse().ok())
        .unwrap_or(0);
    let mut chunk = [0_u8; 4_096];

    while read.len() < head_length.saturating_add(length) {
        match socket.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(count) => read.extend_from_slice(&chunk[..count]),
        }
    }

    let redirect = (route.redirect_of)(&asked);
    let Some(upstream) = route.upstream.filter(|_| redirect.is_none()) else {
        let (status, fields) = redirect.unwrap_or((502, Vec::new()));
        let mut answer = Answer::of(status)
            .with(
                "location",
                &format!("http://{HOST}:{}/bead", route.location),
            )
            .carrying(b"moved");

        answer.fields.extend(fields);
        socket.write_all(&answer.head()).await.ok();
        socket.write_all(b"moved").await.ok();
        socket.shutdown().await.ok();

        return;
    };

    locked(&route.forwarded).push(asked.method);

    let Ok(mut server) = TcpStream::connect((HOST, upstream)).await else {
        return;
    };
    // its connection closed after it, so that its answer ends where its socket does
    let mut request = read[..head_length.saturating_sub(2)].to_vec();

    request.extend_from_slice(b"connection: close\r\n\r\n");
    request.extend_from_slice(&read[head_length..]);

    if server.write_all(&request).await.is_err() {
        return;
    }

    while let Ok(count) = server.read(&mut chunk).await {
        if count == 0 || socket.write_all(&chunk[..count]).await.is_err() {
            break;
        }
    }

    socket.shutdown().await.ok();
}

/// Where a redirect points: a server that keeps each request's method and answers as a server
/// would, a connection drawn, a listen's batch, an exchange's answer, each what would be heard
/// were it read.
async fn target() -> Fake {
    fake_of(&ScriptOptions {
        responder: Some(Arc::new(|call: &Call| {
            Some(if call.field(CONNECTION_TOKEN_HEADER).is_none() {
                drawn(true)
            } else if call.method == "GET" {
                batch(1, &[&pushed(1)])
            } else {
                bead(&envelope_of(crate::http::fields::RESULT, (1, 0)))
            })
        })),
        ..ScriptOptions::default()
    })
    .await
}

fn handle_of(server: &HttpTransportServer) -> ConnectionHandle {
    Arc::clone(
        &server
            .clients()
            .last()
            .expect("a connection drawn")
            .connection_handle,
    )
}

// a listener that keeps how many listens were redirected as it hears its first message
struct Counting {
    listens: Arc<AtomicUsize>,
    at_message: Mutex<Option<usize>>,
}

impl ClientListener for Counting {
    fn on_message(&self, _message: TransportMessage) {
        let mut at_message = locked(&self.at_message);

        if at_message.is_none() {
            *at_message = Some(self.listens.load(Ordering::SeqCst));
        }
    }
}

#[tokio::test]
async fn fails_its_connect_on_a_redirect_301_302_303_307_or_308_naming_its_status_its_target_hearing_nothing()
 {
    let target = target().await;

    // its status alone, a mark it carries unread
    for status in REDIRECTS {
        for fields in [
            Vec::new(),
            vec![(REFUSAL_HEADER.to_owned(), HTTP_REFUSALS.busy.to_owned())],
        ] {
            let redirecting = redirecting(
                target.port,
                &RedirectingOptions {
                    redirect_of: Arc::new(move |_asked: &Asked| Some((status, fields.clone()))),
                    upstream: None,
                },
            )
            .await;
            let client = client_of(&HttpTransportClientOptions::default());
            let refused = settled(client.connect(&to(redirecting.port))).await;
            let message = format!("the server drew no connection: {status}");

            assert!(
                matches!(&refused, Err(TransportError::Connect(error)) if error.to_string() == message),
                "{status}: {refused:?}"
            );
            assert_eq!(client.ready_state(), ReadyState::Closed, "{status}");
        }
    }

    assert_eq!(target.count(), 0, "its target heard nothing");
}

#[tokio::test]
async fn counts_a_send_answered_with_a_redirect_301_302_303_307_or_308_lost_its_target_hearing_nothing()
 {
    let target = target().await;

    for status in REDIRECTS {
        let server = started(&HttpTransportServerOptions::default()).await;
        let redirecting = redirecting(
            target.port,
            &RedirectingOptions {
                redirect_of: Arc::new(move |asked: &Asked| {
                    (asked.is_exchange && asked.method == "POST").then(|| (status, Vec::new()))
                }),
                upstream: Some(server.port),
            },
        )
        .await;
        let client = client_of(&not_listening());
        let told = recorded(&client);

        settled(client.connect(&to(redirecting.port)))
            .await
            .unwrap();

        let handle = handle_of(&server.server);

        assert!(sent(&client, request(1)).await.is_ok(), "{status}");
        assert_eq!(told.closed(1).await, vec![(false, false)], "{status}");
        // the connection released, at the origin
        until(|| redirecting.forwarded() == ["POST", "DELETE"]).await;
        assert_eq!(
            server.recorder.closes(1).await,
            vec![(true, handle)],
            "{status}"
        );
        assert_eq!(
            (
                client.ready_state(),
                server.server.clients().len(),
                told.messages().len()
            ),
            (ReadyState::Closed, 0, 0),
            "{status}"
        );
        server.stop().await;
    }

    assert_eq!(target.count(), 0, "its target heard nothing");
}

#[tokio::test]
async fn listens_again_after_a_listen_answered_with_a_redirect_its_target_hearing_nothing() {
    let target = target().await;
    let server = started(&HttpTransportServerOptions::default()).await;
    let listens = Arc::new(AtomicUsize::new(0));
    let counting = Arc::clone(&listens);
    let redirecting = redirecting(
        target.port,
        &RedirectingOptions {
            redirect_of: Arc::new(move |asked: &Asked| {
                if !(asked.is_exchange && asked.method == "GET") {
                    return None;
                }

                match counting.fetch_add(1, Ordering::SeqCst).saturating_add(1) {
                    1 => Some((302, Vec::new())),
                    2 => Some((307, Vec::new())),
                    _ => None,
                }
            }),
            upstream: Some(server.port),
        },
    )
    .await;
    let client = client_of(&HttpTransportClientOptions::default());
    let told = recorded(&client);
    let at_message = Arc::new(Counting {
        listens: Arc::clone(&listens),
        at_message: Mutex::new(None),
    });

    client.listen(Arc::<Counting>::clone(&at_message));
    settled(client.connect(&to(redirecting.port)))
        .await
        .unwrap();

    let envelope = pushed(1);

    server
        .send(&envelope, &handle_of(&server.server))
        .await
        .unwrap();

    // lost at once, listened again at once, lost, then after a wait drawn between 0.5 and 1 s heard
    until(|| told.messages().len() == 1).await;

    assert_eq!(
        (
            told.heard(),
            client.ready_state(),
            *locked(&at_message.at_message)
        ),
        (vec![envelope], ReadyState::Open, Some(3)),
        "heard on its third listen"
    );
    assert_eq!(target.count(), 0, "its target heard nothing");
    disconnected(&client, &TransportClientDisconnectOptions::default()).await;
    assert_eq!(target.count(), 0, "its target heard nothing still");
    server.stop().await;
}

#[tokio::test]
async fn leaves_a_redirect_s_bead_refusal_unread_a_send_so_answered_is_lost_and_a_listen_listened_again()
 {
    let target = target().await;
    let marked = || {
        Some((
            307,
            vec![(
                REFUSAL_HEADER.to_owned(),
                HTTP_REFUSALS.connection_unknown.to_owned(),
            )],
        ))
    };

    // a send: resolved, its connection lost and released, as no connection told gone is
    {
        let server = started(&HttpTransportServerOptions::default()).await;
        let redirecting = redirecting(
            target.port,
            &RedirectingOptions {
                redirect_of: Arc::new(move |asked: &Asked| {
                    (asked.is_exchange && asked.method == "POST")
                        .then(marked)
                        .flatten()
                }),
                upstream: Some(server.port),
            },
        )
        .await;
        let client = client_of(&not_listening());
        let told = recorded(&client);

        settled(client.connect(&to(redirecting.port)))
            .await
            .unwrap();

        let handle = handle_of(&server.server);

        assert!(sent(&client, request(1)).await.is_ok(), "resolved");
        assert_eq!(told.closed(1).await, vec![(false, false)], "lost");
        until(|| redirecting.forwarded() == ["POST", "DELETE"]).await;
        assert_eq!(
            server.recorder.closes(1).await,
            vec![(true, handle)],
            "released"
        );
        server.stop().await;
    }

    // a listen: listened again, its connection kept
    {
        let server = started(&HttpTransportServerOptions::default()).await;
        let listens = AtomicUsize::new(0);
        let redirecting = redirecting(
            target.port,
            &RedirectingOptions {
                redirect_of: Arc::new(move |asked: &Asked| {
                    if !(asked.is_exchange && asked.method == "GET") {
                        return None;
                    }

                    (listens.fetch_add(1, Ordering::SeqCst) == 0)
                        .then(marked)
                        .flatten()
                }),
                upstream: Some(server.port),
            },
        )
        .await;
        let client = client_of(&HttpTransportClientOptions::default());
        let told = recorded(&client);
        let envelope = pushed(1);

        settled(client.connect(&to(redirecting.port)))
            .await
            .unwrap();
        server
            .send(&envelope, &handle_of(&server.server))
            .await
            .unwrap();
        until(|| told.messages().len() == 1).await;

        assert_eq!(
            (told.heard(), client.ready_state()),
            (vec![envelope], ReadyState::Open),
            "heard, open"
        );
        disconnected(&client, &TransportClientDisconnectOptions::default()).await;
        server.stop().await;
    }

    assert_eq!(target.count(), 0, "its target heard nothing");
}
