//! A client's core and a server linked in memory: the result and failure of a request, its
//! cancellation reaching its resolver, its call id reserved, and its closing connection.

use core::num::NonZeroU16;
use core::sync::atomic::{AtomicUsize, Ordering};
use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::{answered, locked, options_of};
use crate::clock::SharedClock;
use crate::constants::{FailureScope, ProcedureKind, ProtocolCode, RouterSide};
use crate::debug::DebugDirection;
use crate::envelope::EnvelopeHeader;
use crate::errors::{CallError, ResolverError};
use crate::failure::{Failure, FailureOrigin};
use crate::identity::Procedure;
use crate::memory::{
    MemoryTransportClient, MemoryTransportClientConnectOptions, MemoryTransportClientOptions,
    MemoryTransportServer, MemoryTransportServerOptions,
};
use crate::router::client::{RouterClient, RouterClientOptions};
use crate::router::core::{Handler, RequestResolverProps, reject_pending};
use crate::router::server::{Call, RouterServer, RouterServerOptions};
use crate::router::types::{RouterAnswer, RouterRequest, RouterResult};
use crate::testing::{SteppingClock, instants};
use crate::transport::ServerTransport;

fn procedure(name: &str) -> Procedure {
    Procedure {
        service_id: 1,
        procedure_id: match name {
            "echo" => 1,
            "fail" => 2,
            "slow" => 3,
            "cancellations" => 4,
            _ => panic!("a procedure of the link"),
        },
        service_revision: 1,
        procedure_name: name.to_owned(),
        procedure_kind: Some(ProcedureKind::Request),
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

struct Link {
    clock: Arc<SteppingClock>,
    memory: MemoryTransportServer,
    // The client keeps its transport alive, as its application's handle does.
    _transport: Arc<MemoryTransportClient>,
    client: RouterClient,
    server: RouterServer,
    drawn: Arc<Mutex<Vec<u32>>>,
    received: Arc<Mutex<Vec<EnvelopeHeader>>>,
}

impl Link {
    async fn new(last_call_id: Option<u32>) -> Self {
        let clock = SteppingClock::new(instants::new_year());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let memory = MemoryTransportServer::new(&MemoryTransportServerOptions {
            clock: Some(Arc::clone(&shared)),
            runtime: None,
            procedures: None,
        })
        .expect("a server transport");
        let server = RouterServer::new(Arc::new(memory.clone()), &RouterServerOptions::default())
            .expect("a server router");
        let transport = Arc::new(
            MemoryTransportClient::new(&MemoryTransportClientOptions {
                clock: Some(shared),
            })
            .expect("a client transport"),
        );
        let client = RouterClient::new(
            Arc::<MemoryTransportClient>::clone(&transport),
            &RouterClientOptions {
                last_call_id,
                ..RouterClientOptions::default()
            },
        )
        .expect("a client router");
        let cancellations = Arc::new(AtomicUsize::new(0));
        let received: Arc<Mutex<Vec<EnvelopeHeader>>> = Arc::default();
        let receiving = Arc::clone(&received);
        server.on_debug(Arc::new(move |direction, traced| {
            if direction == DebugDirection::Rx {
                locked(&receiving).push(traced.header.clone());
            }
        }));

        for name in ["echo", "fail", "slow", "cancellations"] {
            let cancellations = Arc::clone(&cancellations);
            server
                .register_resolver((
                    &procedure(name),
                    Handler {
                        resolve: Arc::new(move |props: RequestResolverProps| {
                            let cancellations = Arc::clone(&cancellations);
                            Box::pin(async move {
                                let answer = match name {
                                    "echo" => RouterAnswer::Result(props.payload),
                                    "fail" => RouterAnswer::Failure(
                                        Failure::application(
                                            NonZeroU16::new(7).expect("nonzero"),
                                            "this procedure fails, on purpose",
                                        )
                                        .record(),
                                    ),
                                    "slow" => {
                                        props.signal.token().cancelled().await;
                                        cancellations.fetch_add(1, Ordering::SeqCst);
                                        return Ok(());
                                    }
                                    "cancellations" => RouterAnswer::Result(Bytes::from(
                                        cancellations.load(Ordering::SeqCst).to_string(),
                                    )),
                                    _ => panic!("a procedure of the link"),
                                };
                                props
                                    .answerer
                                    .respond(answer)
                                    .await
                                    .map_err(ResolverError::other)
                            })
                        }),
                        admit: None,
                        maximum_payload_bytes: None,
                        forwards_credentials: false,
                        notifies: false,
                    },
                ))
                .expect("a procedure registered");
        }

        memory.start().await.expect("listening");
        transport
            .connect(&MemoryTransportClientConnectOptions::new(memory.clone()))
            .await
            .expect("connected");
        clock.settle().await;
        Self {
            clock,
            memory,
            _transport: transport,
            client,
            server,
            drawn: Arc::default(),
            received,
        }
    }

    fn request(&self, name: &str) -> RouterRequest {
        let drawn = Arc::clone(&self.drawn);
        let mut request = RouterRequest::new(procedure(name), &options_of(Duration::from_secs(5)));
        request.on_call_id = Some(Box::new(move |id| locked(&drawn).push(id)));
        request
    }

    fn call(&self, name: &str) -> Call {
        let payload = if name == "slow" {
            Bytes::from_static(br#"{"milliseconds":3600000}"#)
        } else {
            Bytes::from_static(b"null")
        };
        self.client
            .request(payload, self.request(name))
            .expect("a call")
    }

    async fn ask(&self, name: &str) -> RouterResult {
        answered(self.call(name)).await.expect("a result")
    }

    async fn dispose(&self) {
        self.client.dispose().await;
        self.server.dispose().await;
        self.memory.stop().await.expect("stopped");
        self.clock.settle().await;
    }
}

#[tokio::test]
async fn requests_and_resolves_with_the_result() {
    let link = Link::new(None).await;
    let call = link
        .client
        .request(Bytes::from_static(br#"{"a":1}"#), link.request("echo"))
        .expect("a request");
    let result = answered(call).await.expect("echo answered");
    assert_eq!(result.payload, Bytes::from_static(br#"{"a":1}"#));
    assert_eq!(result.header.call_id, 1);
    link.dispose().await;
}

#[tokio::test]
async fn throws_the_failure_the_peer_answered_with_saying_it_raised_it() {
    let link = Link::new(None).await;
    let Err(CallError::Failure(failure)) = answered(link.call("fail")).await else {
        panic!("the peer answered a failure")
    };
    assert_eq!(failure.code(), NonZeroU16::new(7).expect("nonzero"));
    assert_eq!(failure.scope(), FailureScope::Application);
    assert_eq!(failure.origin(), FailureOrigin::Peer);
    assert_eq!(failure.side(), Some(RouterSide::Server));
    assert_eq!(failure.procedure(), Some(procedure("fail").address()));
    assert_eq!(
        failure.to_string(),
        "server application failure 7 (service 1, procedure 2): this procedure fails, on purpose"
    );
    link.dispose().await;
}

#[tokio::test]
async fn times_out_cancels_its_call_and_reserves_its_call_id_as_long_as_it_was_given() {
    let link = Link::new(Some(3)).await;
    let mut request = link.request("slow");
    request.options.timeout = Duration::from_secs(1);
    let slow = link
        .client
        .request(Bytes::from_static(br#"{"milliseconds":3600000}"#), request)
        .expect("a slow call");
    link.clock.settle().await;
    link.clock.advance(Duration::from_secs(1)).await;
    assert!(
        matches!(answered(slow).await, Err(CallError::TimedOut(timeout))
        if timeout == Duration::from_secs(1))
    );
    link.clock.settle().await;
    assert_eq!(link.ask("cancellations").await.payload, "1");
    link.ask("echo").await;
    assert_eq!(*locked(&link.drawn), [1, 3, 3]);
    link.clock.advance(Duration::from_secs(1)).await;
    link.ask("echo").await;
    assert_eq!(*locked(&link.drawn), [1, 3, 3, 1]);
    link.dispose().await;
}

#[tokio::test]
async fn cancels_its_call_once_its_token_is_cancelled_after_it_went_out() {
    let link = Link::new(None).await;
    let token = CancellationToken::new();
    let mut request = link.request("slow");
    request.options.signal = Some(token.clone());
    let slow = link
        .client
        .request(Bytes::from_static(br#"{"milliseconds":3600000}"#), request)
        .expect("a slow call");
    link.clock.settle().await;
    token.cancel();
    let refused = answered(slow)
        .await
        .expect_err("the token cancels its call");
    assert!(matches!(refused, CallError::Cancelled(Some(1))));
    assert_eq!(refused.to_string(), "call 1 was cancelled");
    link.clock.settle().await;
    assert_eq!(link.ask("cancellations").await.payload, "1");
    link.dispose().await;
}

#[tokio::test]
async fn draws_nothing_for_a_token_cancelled_already() {
    let link = Link::new(None).await;
    let token = CancellationToken::new();
    token.cancel();
    let mut request = link.request("echo");
    request.options.signal = Some(token);
    let call = link
        .client
        .request(Bytes::from_static(b"null"), request)
        .expect("a call");
    assert!(matches!(
        answered(call).await,
        Err(CallError::Cancelled(None))
    ));
    assert!(locked(&link.drawn).is_empty());
    assert!(locked(&link.received).is_empty());
    link.dispose().await;
}

#[tokio::test]
async fn is_capacity_exceeded_once_every_call_id_is_in_use() {
    let link = Link::new(Some(1)).await;
    let slow = link.call("slow");
    let refused = answered(link.call("echo")).await;
    assert!(matches!(refused, Err(CallError::Failure(failure))
        if failure.code() == ProtocolCode::CAPACITY_EXCEEDED.get()
        && failure.origin() == FailureOrigin::Local));
    link.dispose().await;
    assert!(matches!(
        answered(slow).await,
        Err(CallError::Disconnected(_))
    ));
}

#[tokio::test]
async fn rejects_what_waits_on_a_connection_that_closed() {
    let link = Link::new(None).await;
    let slow = link.call("slow");
    link.client
        .owner()
        .run(|state| {
            reject_pending(
                state,
                (
                    "the connection closed before the answer",
                    Some(&Arc::from("server")),
                ),
            );
        })
        .await
        .expect("the connection's calls rejected");
    assert!(
        matches!(answered(slow).await, Err(CallError::Disconnected(reason))
        if reason == "the connection closed before the answer")
    );
    link.dispose().await;
}

#[tokio::test]
async fn rejects_what_waits_once_disposed_and_sends_nothing_more() {
    let link = Link::new(None).await;
    let slow = link.call("slow");
    link.client.dispose().await;
    assert!(matches!(
        answered(slow).await,
        Err(CallError::Disconnected(_))
    ));
    let received = locked(&link.received).len();
    assert!(matches!(
        answered(link.call("echo")).await,
        Err(CallError::Disconnected(_))
    ));
    link.clock.settle().await;
    assert_eq!(locked(&link.received).len(), received);
    link.dispose().await;
}

#[tokio::test]
async fn refuses_a_payload_past_its_procedure_s_limit_before_it_sends_or_tells_its_call_id() {
    let link = Link::new(None).await;
    let mut request = link.request("echo");
    request.procedure.maximum_payload_bytes = Some(4);
    let call = link
        .client
        .request(Bytes::from_static(br#""too long""#), request)
        .expect("a call");
    assert!(
        matches!(answered(call).await, Err(CallError::Failure(failure))
        if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get())
    );
    assert!(locked(&link.drawn).is_empty());
    link.clock.settle().await;
    assert!(locked(&link.received).is_empty());
    link.dispose().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stalls_nothing_for_a_resolver_that_blocks_its_thread() {
    use core::future::{Future, poll_fn};
    use core::pin::Pin;
    use core::task::Poll;
    use std::sync::mpsc;
    use tokio::sync::oneshot;

    let link = Link::new(None).await;
    let (release, released) = mpsc::channel();
    let released = Arc::new(Mutex::new(released));
    let (enter, entered) = oneshot::channel();
    let enter = Arc::new(Mutex::new(Some(enter)));
    let block = Procedure {
        procedure_id: 50,
        procedure_name: "block".to_owned(),
        ..procedure("echo")
    };
    link.server
        .register_resolver((
            &block,
            Handler {
                resolve: Arc::new(move |props: RequestResolverProps| {
                    let released = Arc::clone(&released);
                    let enter = locked(&enter).take().expect("one blocking call");
                    Box::pin(async move {
                        enter.send(()).expect("the test hears it enter");
                        // A bounded blocking wait, as the twin's ManualResetEventSlim.Wait.
                        locked(&released)
                            .recv_timeout(super::PATIENCE)
                            .expect("the blocking resolver released");
                        props
                            .answerer
                            .respond(RouterAnswer::Result(props.payload))
                            .await
                            .map_err(ResolverError::other)
                    })
                }),
                admit: None,
                maximum_payload_bytes: None,
                forwards_credentials: false,
                notifies: false,
            },
        ))
        .expect("the blocking resolver registered");
    let mut request = link.request("echo");
    request.procedure = block;
    let mut blocked = link
        .client
        .request(Bytes::from_static(br#""held""#), request)
        .expect("a blocking call");
    crate::testing::patience(super::PATIENCE, entered)
        .await
        .expect("the resolver enters within patience")
        .expect("it enters");

    let free = link
        .client
        .request(Bytes::from_static(br#""free""#), link.request("echo"))
        .expect("a free call");
    assert_eq!(
        answered(free).await.expect("echo answered").payload,
        br#""free""#.as_slice()
    );
    assert!(
        poll_fn(|context| Poll::Ready(Pin::new(&mut blocked).poll(context).is_pending())).await
    );
    release.send(()).expect("release the blocking resolver");
    assert_eq!(
        answered(blocked)
            .await
            .expect("the blocking call answered")
            .payload,
        br#""held""#.as_slice()
    );
    link.dispose().await;
}
