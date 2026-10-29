//! The in-memory transport's tests (spec 15.13): what each end hands the other and when, the
//! credential it carries, the handles its server draws, how a close and a stop are told, a
//! transfer carried under its routers' credit, a connect given up, and a reconnection.

use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::{
    MemoryClient, MemoryClientOptions, MemoryConnectOptions, MemoryServer, MemoryServerOptions,
};
use crate::client::ClientOptions;
use crate::clock::SharedClock;
use crate::errors::TransportError;
use crate::managers::service::{
    RequestDependencies, RequestOptions, ResolverDependencies, Response,
};
use crate::payloads::RawCodec;
use crate::router::types::{
    BoxFuture, ConnectionHandle, RouterError, RouterLimitsOptions, TransportMessage,
};
use crate::server::ServerOptions;
use crate::testing::SteppingClock;
use crate::testing::hexadecimal;
use crate::testing::pair::{Pair, PairOptions, echo};
use crate::transport::{
    ClientListener, ClientTransport, DisconnectOptions, ReadyState, ReconnectDelay,
    ReconnectOptions, ServerListener, ServerTransport,
};

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

type Told = Arc<Mutex<Vec<String>>>;

// what a server's listener hears, each told as a line
struct AtServer {
    told: Told,
}

impl ServerListener for AtServer {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        locked(&self.told).push(format!("connection {connection_handle}"));
    }

    fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
        locked(&self.told).push(format!(
            "heard {} on {connection_handle} carrying {:?} from {:?} {:?}",
            hexadecimal::text_of(&message.data),
            message.credential,
            message.address,
            message.port
        ));
    }

    fn on_close(&self, was_clean: bool, connection_handle: &ConnectionHandle) {
        locked(&self.told).push(format!("closed {connection_handle} {was_clean}"));
    }

    fn on_error(&self, error: &RouterError, connection_handle: Option<&ConnectionHandle>) {
        locked(&self.told).push(format!("error {error} on {connection_handle:?}"));
    }
}

// what a client's listener hears, each told as a line
struct AtClient {
    told: Told,
}

impl ClientListener for AtClient {
    fn on_message(&self, message: TransportMessage) {
        locked(&self.told).push(format!(
            "heard {} carrying {:?}",
            hexadecimal::text_of(&message.data),
            message.credential
        ));
    }

    fn on_close(&self, was_clean: bool, is_quick: bool) {
        locked(&self.told).push(format!("closed {was_clean} {is_quick}"));
    }

    fn on_reconnect(&self) {
        locked(&self.told).push("reconnect".to_owned());
    }

    fn on_error(&self, error: &RouterError) {
        locked(&self.told).push(format!("error {error}"));
    }
}

// a server's listener that runs what a test gives it as each connection is drawn
struct OnConnection<F>(F);

impl<F: Fn(&ConnectionHandle) + Send + Sync> ServerListener for OnConnection<F> {
    fn on_connection(&self, connection_handle: &ConnectionHandle) {
        (self.0)(connection_handle);
    }
}

// a client's listener that runs what a test gives it as each message comes
struct OnMessage<F>(F);

impl<F: Fn(&TransportMessage) + Send + Sync> ClientListener for OnMessage<F> {
    fn on_message(&self, message: TransportMessage) {
        (self.0)(&message);
    }
}

// a client's listener that runs what a test gives it as each reconnection starts
struct OnReconnect<F>(F);

impl<F: Fn() + Send + Sync> ClientListener for OnReconnect<F> {
    fn on_reconnect(&self) {
        (self.0)();
    }
}

/// A server started and a client of it, on one stepping clock, each told to a list of its own.
struct Ends {
    clock: Arc<SteppingClock>,
    shared: SharedClock,
    server: MemoryServer,
    at_server: Told,
}

impl Ends {
    async fn started() -> Self {
        let ends = Self::unstarted();

        ends.server.start().await.expect("started");

        ends
    }

    // a server not started yet, its listener told
    fn unstarted() -> Self {
        let clock = SteppingClock::new(crate::testing::instants::new_year());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let server = MemoryServer::new(&MemoryServerOptions {
            clock: Some(Arc::clone(&shared)),
            runtime: None,
        })
        .expect("a server");
        let at_server: Told = Arc::default();

        server.listen(Arc::new(AtServer {
            told: Arc::clone(&at_server),
        }));

        Self {
            clock,
            shared,
            server,
            at_server,
        }
    }

    fn client(&self) -> (MemoryClient, Told) {
        let client = MemoryClient::new(&MemoryClientOptions {
            clock: Some(Arc::clone(&self.shared)),
            server: self.server.clone(),
        })
        .expect("a client");
        let told: Told = Arc::default();

        client.listen(Arc::new(AtClient {
            told: Arc::clone(&told),
        }));

        (client, told)
    }

    async fn connected(
        &self,
        (address, port): (Option<&str>, Option<u16>),
    ) -> (MemoryClient, Told) {
        let (client, told) = self.client();
        let connecting = client.connect(MemoryConnectOptions {
            address: address.map(str::to_owned),
            port,
            signal: None,
            timeout: None,
        });

        self.clock.settle().await;
        connecting.await.expect("connected");

        (client, told)
    }

    // what the server was told since the last time asked
    fn server_told(&self) -> Vec<String> {
        core::mem::take(&mut *locked(&self.at_server))
    }
}

fn taken(told: &Told) -> Vec<String> {
    core::mem::take(&mut *locked(told))
}

fn message_of(bytes: &'static [u8], credential: Option<&str>) -> TransportMessage {
    TransportMessage {
        data: Bytes::from_static(bytes),
        credential: credential.map(str::to_owned),
        ..TransportMessage::default()
    }
}

const FIRST: &str = "type=MEMORY;ip=local;ordinal=1";

// a platform's shape: a Rust `Bytes` is never changed once made, so a sender's buffer is its own
// once sent with no copy to show it
// spec 15.13, 15.15
#[tokio::test]
async fn hands_each_envelope_on_whole_once_and_in_order_in_a_later_turn_than_its_send() {
    let ends = Ends::started().await;
    let (client, at_client) = ends.connected((None, None)).await;
    let handle: ConnectionHandle = Arc::from(FIRST);

    ends.server_told();

    for bytes in [&[1_u8, 2, 3][..], &[4], &[5, 6]] {
        client
            .send(TransportMessage {
                data: Bytes::copy_from_slice(bytes),
                ..TransportMessage::default()
            })
            .expect("sent");
    }

    // a view on a larger buffer crosses as its own bytes alone
    let pool = Bytes::from_static(&[9, 11, 12, 9]);

    client
        .send(TransportMessage {
            data: pool.slice(1..3),
            ..TransportMessage::default()
        })
        .expect("sent");

    for bytes in [&[7_u8][..], &[8, 9], &[10]] {
        ends.server
            .send(
                TransportMessage {
                    data: Bytes::copy_from_slice(bytes),
                    ..TransportMessage::default()
                },
                &handle,
            )
            .expect("sent");
    }

    // * nothing within the send
    assert!(
        locked(&ends.at_server).is_empty(),
        "the server heard nothing within the sends"
    );
    assert!(
        locked(&at_client).is_empty(),
        "the client heard nothing within the sends"
    );

    ends.clock.settle().await;

    assert_eq!(
        ends.server_told(),
        ["01 02 03", "04", "05 06", "0B 0C"].map(|bytes| format!(
            "heard {bytes} on {FIRST} carrying None from Some(\"local\") None"
        )),
        "each once, whole and in order"
    );
    assert_eq!(
        taken(&at_client),
        [
            "heard 07 carrying None",
            "heard 08 09 carrying None",
            "heard 0A carrying None"
        ],
        "each once, whole and in order"
    );
}

// a server's listener that runs what a test gives it as each message comes
struct OnServerMessage<F>(F);

impl<F: Fn(&TransportMessage, &ConnectionHandle) + Send + Sync> ServerListener
    for OnServerMessage<F>
{
    fn on_message(&self, message: TransportMessage, connection_handle: &ConnectionHandle) {
        (self.0)(&message, connection_handle);
    }
}

// spec 15.13: in the order it was sent, its close after what it sent before, whatever turn sends
// it; both other sides queue a later turn at the tail
#[tokio::test]
async fn an_envelope_or_a_close_a_listener_of_the_transport_sends_within_its_turn_comes_behind_what_was_sent_before_it()
 {
    for closes in [false, true] {
        let ends = Ends::started().await;
        let server = ends.server.clone();

        ends.server.listen(Arc::new(OnServerMessage(
            move |message: &TransportMessage, handle: &ConnectionHandle| {
                if message.data.as_ref() != [0xFF] {
                    return;
                }

                // * within the turn that hands the server its client's trigger
                if closes {
                    drop(server.close(handle));
                } else {
                    server.send(message_of(&[2], None), handle).expect("sent");
                }
            },
        )));

        let (client, at_client) = ends.connected((None, None)).await;
        let handle: ConnectionHandle = Arc::from(FIRST);

        // the trigger, then the server's first: both queued before either is handed on
        client.send(message_of(&[0xFF], None)).expect("sent");
        ends.server
            .send(message_of(&[1], None), &handle)
            .expect("sent");
        ends.clock.settle().await;

        assert_eq!(
            taken(&at_client),
            if closes {
                ["heard 01 carrying None", "closed false false"]
            } else {
                ["heard 01 carrying None", "heard 02 carrying None"]
            },
            "what was sent first heard first, closes {closes}"
        );
    }
}

// the ELSEWHERE that stands for it, through both routers, the conversations play in memory
// spec 15.13
#[tokio::test]
async fn carries_the_credential_a_request_presents_beside_it_and_none_toward_its_client() {
    const CARRIED: &str = "Interop sub=ada";

    let ends = Ends::started().await;
    let (client, at_client) = ends.connected((None, None)).await;
    let handle: ConnectionHandle = Arc::from(FIRST);

    ends.server_told();

    // any field value, as POST /bead carries one; none toward a client, whatever it is given
    assert!(client.carries(CARRIED), "a field value carried");
    assert!(client.carries("Bearer mF_9.B5f-4.1JqM"), "a bearer carried");
    assert!(
        !client.carries(" Bearer x"),
        "a field that starts with a space not"
    );
    assert!(
        !ends.server.carries_credential(&handle),
        "none toward its client"
    );
    assert!(client.is_secure(), "the client off the clear");
    assert!(ends.server.is_secure(&handle), "the server off the clear");

    client.send(message_of(&[1], Some(CARRIED))).expect("sent");
    client.send(message_of(&[2], None)).expect("sent");

    // an empty field carries none
    client.send(message_of(&[3], Some(""))).expect("sent");
    ends.server
        .send(message_of(&[4], Some(CARRIED)), &handle)
        .expect("sent");

    // one no field carries is refused before it goes, the connection kept
    let refused = client
        .send(message_of(&[5], Some("Interop\nsub=ada")))
        .err()
        .map(|error| error.to_string());

    assert!(
        refused.as_deref().is_some_and(|refusal| refusal
            .starts_with("a credential holds visible ASCII, spaces and tabs alone")),
        "refused: {refused:?}"
    );

    ends.clock.settle().await;

    assert_eq!(
        ends.server_told(),
        [
            format!("heard 01 on {FIRST} carrying Some(\"{CARRIED}\") from Some(\"local\") None"),
            format!("heard 02 on {FIRST} carrying None from Some(\"local\") None"),
            format!("heard 03 on {FIRST} carrying None from Some(\"local\") None"),
        ],
        "carried beside its request"
    );
    assert_eq!(
        taken(&at_client),
        ["heard 04 carrying None"],
        "none toward its client"
    );
    assert_eq!(
        client.ready_state(),
        ReadyState::Open,
        "the connection kept"
    );
}

// spec 15.13
#[tokio::test]
async fn hands_its_router_the_address_and_the_port_its_client_gave_as_it_connected() {
    let ends = Ends::started().await;
    let (given, _) = ends.connected((Some("203.0.113.7"), Some(50_123))).await;
    let (none, _) = ends.connected((None, None)).await;

    ends.server_told();
    given.send(message_of(&[1], None)).expect("sent");
    none.send(message_of(&[2], None)).expect("sent");
    ends.clock.settle().await;

    assert_eq!(
        ends.server_told(),
        [
            "heard 01 on type=MEMORY;ip=203.0.113.7;ordinal=1 carrying None from Some(\"203.0.113.7\") Some(50123)",
            "heard 02 on type=MEMORY;ip=local;ordinal=2 carrying None from Some(\"local\") None",
        ],
        "each with what its client gave"
    );

    let clients: Vec<(String, String, Option<u16>)> = ends
        .server
        .clients()
        .into_iter()
        .map(|(handle, address, port, _)| (handle.to_string(), address, port))
        .collect();

    assert_eq!(
        clients,
        [
            (
                "type=MEMORY;ip=203.0.113.7;ordinal=1".to_owned(),
                "203.0.113.7".to_owned(),
                Some(50_123)
            ),
            (
                "type=MEMORY;ip=local;ordinal=2".to_owned(),
                "local".to_owned(),
                None
            ),
        ],
        "its clients, as they connected"
    );
}

// spec 15.13
#[tokio::test]
async fn draws_a_handle_of_type_memory_for_each_connect_and_gives_none_twice() {
    let ends = Ends::started().await;
    let (first, _) = ends.connected((Some("127.0.0.1"), Some(50_001))).await;
    let (_second, _) = ends.connected((None, None)).await;
    let (third, _) = ends.connected((Some("::1"), None)).await;

    // a client connected again is a new connection, drawn at the next rank; so is one after a stop
    // and a start, which reset no rank
    first
        .disconnect(DisconnectOptions::default())
        .expect("closed");
    ends.clock.settle().await;

    let again = first.connect(MemoryConnectOptions {
        address: Some("127.0.0.1".to_owned()),
        port: Some(50_001),
        signal: None,
        timeout: None,
    });

    ends.clock.settle().await;
    again.await.expect("connected again");
    ends.server.stop().await;
    ends.clock.settle().await;
    ends.server.start().await.expect("started again");

    let after = third.connect(MemoryConnectOptions::default());

    ends.clock.settle().await;
    after.await.expect("connected after a start");

    let drawn: Vec<String> = ends
        .server_told()
        .into_iter()
        .filter_map(|line| line.strip_prefix("connection ").map(str::to_owned))
        .collect();

    assert_eq!(
        drawn,
        [
            "type=MEMORY;ip=127.0.0.1;ordinal=1",
            "type=MEMORY;ip=local;ordinal=2",
            "type=MEMORY;ip=::1;ordinal=3",
            "type=MEMORY;ip=127.0.0.1;ordinal=4",
            "type=MEMORY;ip=local;ordinal=5",
        ],
        "each drawn once, at the next rank"
    );

    // * an address names the connection: what no handle could name is refused before anything
    // moves
    let (named, _) = ends.client();

    for address in ["", "a;ordinal=1", "a b"] {
        let refused = named
            .connect(MemoryConnectOptions {
                address: Some(address.to_owned()),
                ..MemoryConnectOptions::default()
            })
            .await
            .expect_err("an address no handle names");

        assert!(
            refused
                .to_string()
                .starts_with("an in-memory connect's address"),
            "refused for its address: {refused}"
        );
    }

    assert_eq!(
        named.ready_state(),
        ReadyState::Uninitialized,
        "nothing moved"
    );
}

// spec 15.13
#[tokio::test]
async fn tells_the_other_end_of_a_close_in_a_later_turn_the_closer_s_clean() {
    let ends = Ends::started().await;
    let (client, at_client) = ends.connected((None, None)).await;

    ends.server_told();

    // the client closes: its own close in its call, clean as told; its server's in a later turn,
    // after what it sent before, clean as the closer's
    client.send(message_of(&[1], None)).expect("sent");
    client
        .disconnect(DisconnectOptions::default())
        .expect("closed");

    assert_eq!(
        taken(&at_client),
        ["closed true false"],
        "its own close within its call"
    );
    assert!(
        locked(&ends.at_server).is_empty(),
        "its server's in a later turn"
    );

    ends.clock.settle().await;

    assert_eq!(
        ends.server_told(),
        [
            format!("heard 01 on {FIRST} carrying None from Some(\"local\") None"),
            format!("closed {FIRST} true"),
        ],
        "after what it sent, clean as the closer's"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");

    // the server closes: its client's close in a later turn, after what it sent before, unclean,
    // as a close of the peer's
    let (closed, at_closed) = ends.connected((None, None)).await;
    let handle: ConnectionHandle = Arc::from("type=MEMORY;ip=local;ordinal=2");

    ends.server_told();
    ends.server
        .send(message_of(&[2], None), &handle)
        .expect("sent");

    let closing = ends.server.close(&handle);

    assert!(
        locked(&at_closed).is_empty(),
        "its client told nothing within the close"
    );

    ends.clock.settle().await;

    assert!(closing.await, "it held the connection");
    assert_eq!(
        taken(&at_closed),
        ["heard 02 carrying None", "closed false false"],
        "after what it sent, unclean"
    );
    assert_eq!(
        ends.server_told(),
        [format!("closed {handle} true")],
        "its own close, clean"
    );
    assert_eq!(
        closed.ready_state(),
        ReadyState::Closed,
        "the client closed"
    );
    assert!(
        !ends.server.close(&handle).await,
        "a close of what it no longer holds"
    );

    // a close told unclean is told so at its server
    let (unclean, at_unclean) = ends.connected((None, None)).await;

    ends.server_told();
    unclean
        .disconnect(DisconnectOptions {
            is_clean: Some(false),
            is_quick: None,
        })
        .expect("closed");

    assert_eq!(
        taken(&at_unclean),
        ["closed false false"],
        "unclean at its own end"
    );

    ends.clock.settle().await;

    assert_eq!(
        ends.server_told(),
        ["closed type=MEMORY;ip=local;ordinal=3 false"],
        "unclean at its server"
    );
}

// spec 15.13
#[tokio::test]
async fn closes_each_connection_as_it_stops_and_takes_no_connect_after() {
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let server = MemoryServer::new(&MemoryServerOptions {
        clock: Some(Arc::clone(&shared)),
        runtime: None,
    })
    .expect("a server");
    let client_of = || {
        MemoryClient::new(&MemoryClientOptions {
            clock: Some(Arc::clone(&shared)),
            server: server.clone(),
        })
        .expect("a client")
    };
    let (first, second) = (client_of(), client_of());

    // a connect before its start fails before anything goes
    let early = first
        .connect(MemoryConnectOptions::default())
        .await
        .expect_err("refused before its start");

    assert_eq!(
        early.to_string(),
        "the in-memory transport server is uninitialized, not open",
        "said why"
    );

    let told: Told = Arc::default();

    server.listen(Arc::new(AtServer {
        told: Arc::clone(&told),
    }));
    first.listen(Arc::new(AtClient {
        told: Arc::clone(&told),
    }));
    second.listen(Arc::new(AtClient {
        told: Arc::clone(&told),
    }));
    server.start().await.expect("started");

    for client in [&first, &second] {
        let connecting = client.connect(MemoryConnectOptions::default());

        clock.settle().await;
        connecting.await.expect("connected");
    }

    locked(&told).clear();
    server.stop().await;
    clock.settle().await;

    assert_eq!(
        taken(&told),
        [
            "closed type=MEMORY;ip=local;ordinal=1 true",
            "closed type=MEMORY;ip=local;ordinal=2 true",
            "closed false false",
            "closed false false",
        ],
        "each closed as it stops"
    );
    assert_eq!(
        (
            server.ready_state(),
            first.ready_state(),
            second.ready_state()
        ),
        (ReadyState::Closed, ReadyState::Closed, ReadyState::Closed),
        "all closed"
    );
    assert!(server.clients().is_empty(), "no connection held");

    let late = first
        .connect(MemoryConnectOptions::default())
        .await
        .expect_err("refused once stopped");

    assert_eq!(
        late.to_string(),
        "the in-memory transport server is closed, not open",
        "said why"
    );
    assert_eq!(first.ready_state(), ReadyState::Closed, "the client closed");
}

// spec 15.13
#[tokio::test]
async fn carries_a_transfer_under_its_routers_credit() {
    // an envelope of 64 bytes at most at both ends: 300 bytes cross as a transfer each way
    let limits = RouterLimitsOptions {
        chunk_bytes: Some(64),
        maximum_envelope_bytes: Some(64),
        window_bytes: Some(128),
        ..RouterLimitsOptions::default()
    };
    let mut server = ServerOptions::default();
    let mut client = ClientOptions::default();

    server.limits = Some(limits.clone());
    client.limits = Some(limits);

    let options = PairOptions {
        server,
        client,
        ..PairOptions::default()
    };

    let pair = Pair::connected((crate::testing::instants::new_year(), options))
        .await
        .expect("a pair connected");
    let kinds: Arc<Mutex<Vec<String>>> = Arc::default();
    let seeing = Arc::clone(&kinds);

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(RawCodec, RawCodec))
        .expect("echo resolved")
        .on(Arc::new(|request, response: Response<RawCodec>| {
            response.result(request.payload)
        }))
        .expect("echo registered");
    pair.client.router().on_debug(Arc::new(
        move |direction: crate::debug::DebugDirection, traced: &crate::debug::TracedEnvelope| {
            locked(&seeing).push(format!("{} {:?}", direction.as_str(), traced.header.kind()));
        },
    ));

    let payload = Bytes::from(
        (0..300_u16)
            .map(|index| u8::try_from(index % 251).unwrap_or(0))
            .collect::<Vec<u8>>(),
    );
    let call = pair
        .client
        .services()
        .get_request(&echo(), RequestDependencies::of(RawCodec, RawCodec))
        .expect("echo asked")
        .call(payload.clone(), RequestOptions::default())
        .expect("echo called");

    pair.settle().await;

    let echoed = crate::testing::patience(Duration::from_secs(10), call)
        .await
        .expect("answered within its patience")
        .expect("echo answered");

    assert_eq!(echoed, payload, "its payload, whole, both ways");

    let kinds = locked(&kinds).clone();

    for kind in ["tx Chunk", "rx Credit", "rx Chunk", "tx Credit"] {
        assert!(
            kinds.iter().any(|seen| seen == kind),
            "{kind} crossed: {kinds:?}"
        );
    }

    assert!(
        locked(&pair.server_reports).is_empty() && locked(&pair.client_reports).is_empty(),
        "nothing reported"
    );
}

// its clock's end before its server drew it: the way memory of transportClient.connectTimeout,
// which tests/durations.rs plays
// spec 15.15
#[tokio::test]
async fn gives_up_a_connect_its_dispose_its_token_or_its_clock_ends_before_its_server_drew_it() {
    let ends = Ends::started().await;

    // its token cancelled before its server drew it
    let (cancelled, _) = ends.client();
    let token = CancellationToken::new();
    let connecting = cancelled.connect(MemoryConnectOptions {
        signal: Some(token.clone()),
        ..MemoryConnectOptions::default()
    });

    token.cancel();
    ends.clock.settle().await;

    assert!(connecting.await.is_err(), "given up by its token");

    // disposed before its server drew it
    let (disposed, _) = ends.client();
    let connecting = disposed.connect(MemoryConnectOptions::default());

    disposed.dispose();
    ends.clock.settle().await;

    let refused = connecting.await.expect_err("given up by its dispose");

    assert_eq!(
        refused.to_string(),
        "the transport client was disposed as it connected",
        "said why"
    );
    ends.clock.settle().await;

    // what its server drew of either is closed at once, and none is held
    assert!(ends.server.clients().is_empty(), "no connection held");
    assert_ne!(
        cancelled.ready_state(),
        ReadyState::Open,
        "the cancelled one not open"
    );
    assert_ne!(
        disposed.ready_state(),
        ReadyState::Open,
        "the disposed one not open"
    );
}

// a client of a server never started, its first connect failed and kept for its reconnection
async fn never_started() -> (Arc<SteppingClock>, MemoryClient) {
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let server = MemoryServer::new(&MemoryServerOptions {
        clock: Some(Arc::clone(&shared)),
        runtime: None,
    })
    .expect("a server");
    let client = MemoryClient::new(&MemoryClientOptions {
        clock: Some(shared),
        server,
    })
    .expect("a client");

    assert!(
        client
            .connect(MemoryConnectOptions::default())
            .await
            .is_err(),
        "its server never started"
    );

    (clock, client)
}

fn reconnecting((delay, maximum_attempts): (Duration, u32)) -> ReconnectOptions {
    ReconnectOptions {
        delay: Some(ReconnectDelay::Fixed(delay)),
        maximum_attempts: Some(maximum_attempts),
        ..ReconnectOptions::default()
    }
}

#[tokio::test]
async fn rejects_with_a_reconnect_error_carrying_the_last_failure_as_cause_ending_closed() {
    let (clock, client) = never_started().await;
    let reconnection = client
        .reconnect(reconnecting((Duration::from_secs(1), 2)))
        .expect("a reconnection");

    assert_eq!(
        client.ready_state(),
        ReadyState::Reconnecting,
        "reconnecting as it is asked"
    );

    let reconnected = crate::testing::spawn(reconnection);

    clock.settle().await;
    clock.advance(Duration::from_secs(1)).await;

    let refused = reconnected.await.expect("its reconnection ended");

    assert!(
        matches!(
            &refused,
            Err(TransportError::Reconnect(error))
                if error.attempts() == 2 && std::error::Error::source(error).is_some()
        ),
        "out of its two attempts, the last one's failure its cause: {refused:?}"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
}

#[tokio::test]
async fn refuses_a_second_reconnection_leaving_the_first_alone() {
    let (clock, client) = never_started().await;
    let first = crate::testing::spawn(
        client
            .reconnect(reconnecting((Duration::from_secs(1), 2)))
            .expect("a reconnection"),
    );

    clock.settle().await;

    assert!(
        matches!(
            client.reconnect(ReconnectOptions::default()),
            Err(TransportError::Refused(_))
        ),
        "a second refused"
    );
    assert_eq!(
        client.ready_state(),
        ReadyState::Reconnecting,
        "the first goes on"
    );

    clock.advance(Duration::from_secs(1)).await;

    assert!(
        matches!(
            first.await.expect("its reconnection ended"),
            Err(TransportError::Reconnect(_))
        ),
        "the first ran its course"
    );
}

// a listener that panics at each event it is told, at either end
struct Breaking;

impl ServerListener for Breaking {
    fn on_connection(&self, _connection_handle: &ConnectionHandle) {
        panic!("a listener broke");
    }

    fn on_message(&self, _message: TransportMessage, _connection_handle: &ConnectionHandle) {
        panic!("a listener broke");
    }

    fn on_close(&self, _was_clean: bool, _connection_handle: &ConnectionHandle) {
        panic!("a listener broke");
    }
}

impl ClientListener for Breaking {
    fn on_close(&self, _was_clean: bool, _is_quick: bool) {
        panic!("a listener broke");
    }

    fn on_reconnect(&self) {
        panic!("a listener broke");
    }
}

const SECOND: &str = "type=MEMORY;ip=local;ordinal=2";

const BROKE: &str = "error a listener panicked: a listener broke";

type Reconnection = Result<BoxFuture<Result<(), TransportError>>, TransportError>;

// what a reconnection's refusal says, or none when it was made
fn refusal_of(reconnection: Reconnection) -> Option<String> {
    reconnection.err().map(|refused| refused.to_string())
}

// spec 15.13
#[tokio::test]
async fn hears_what_its_server_sent_before_the_connection_opened_once_it_has_in_its_order() {
    let ends = Ends::started().await;
    let server = ends.server.clone();

    // * sent in the turn its server draws it, before its client opened: heard once it has, in
    // order
    ends.server
        .listen(Arc::new(OnConnection(move |handle: &ConnectionHandle| {
            server.send(message_of(&[1], None), handle).expect("sent");
            server.send(message_of(&[2], None), handle).expect("sent");
        })));

    let (client, at_client) = ends.connected((None, None)).await;

    ends.clock.settle().await;

    assert_eq!(
        taken(&at_client),
        ["heard 01 carrying None", "heard 02 carrying None"],
        "heard once open, in its order"
    );
    assert_eq!(client.ready_state(), ReadyState::Open, "open");
}

// spec 15.13, 15.15
#[tokio::test]
async fn fails_a_connect_its_server_closed_as_it_opened_what_it_sent_before_unheard() {
    let ends = Ends::started().await;
    let server = ends.server.clone();

    // * sent and closed in the turn its server draws it, before its client opened
    ends.server
        .listen(Arc::new(OnConnection(move |handle: &ConnectionHandle| {
            server.send(message_of(&[1], None), handle).expect("sent");
            drop(server.close(handle));
        })));

    let (client, at_client) = ends.client();
    let connecting = client.connect(MemoryConnectOptions::default());

    ends.clock.settle().await;

    let refused = connecting.await.expect_err("closed as it opened");

    assert!(
        matches!(refused, TransportError::Connect(_)),
        "a connect's error: {refused:?}"
    );
    assert_eq!(
        refused.to_string(),
        "the in-memory transport server closed the connection as it opened",
        "said why"
    );

    ends.clock.settle().await;

    assert!(taken(&at_client).is_empty(), "nothing heard, no close told");
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    assert!(ends.server.clients().is_empty(), "no connection held");
}

// spec 15.13, 15.15
#[tokio::test]
async fn closes_at_once_unclean_a_connection_its_server_draws_once_a_dispose_gave_up_on_its_connect()
 {
    let ends = Ends::started().await;
    let (client, at_client) = ends.client();
    let (server, disposed) = (ends.server.clone(), client.clone());

    // * its dispose in the turn its server draws the connection, before its client opened; what
    // its server sends after goes unheard
    ends.server
        .listen(Arc::new(OnConnection(move |handle: &ConnectionHandle| {
            disposed.dispose();
            server.send(message_of(&[1], None), handle).expect("sent");
        })));

    let connecting = client.connect(MemoryConnectOptions::default());

    ends.clock.settle().await;

    let refused = connecting.await.expect_err("disposed as it connected");

    assert_eq!(
        refused.to_string(),
        "the transport client was disposed as it connected",
        "said why"
    );

    ends.clock.settle().await;

    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    assert_eq!(
        ends.server_told(),
        [
            format!("connection {FIRST}"),
            format!("closed {FIRST} false")
        ],
        "closed at once, unclean"
    );
    assert!(taken(&at_client).is_empty(), "nothing heard");
    assert!(ends.server.clients().is_empty(), "no connection held");
}

// spec 15.15: what a connect draws as it ends is let go, its server told the close of its
// connection, its client's last handle let go within that turn too
#[tokio::test]
async fn a_connect_given_up_its_client_let_go_as_its_server_draws_it_leaves_no_connection_held() {
    let ends = Ends::started().await;
    let (client, at_client) = ends.client();
    let held = Arc::new(Mutex::new(Some(client.clone())));
    let giving_up = Arc::clone(&held);

    // * its dispose in the turn its server draws the connection, then its last handle let go
    ends.server
        .listen(Arc::new(OnConnection(move |_handle: &ConnectionHandle| {
            let client = locked(&giving_up).take();

            if let Some(client) = client {
                client.dispose();
            }
        })));

    let connecting = client.connect(MemoryConnectOptions::default());

    drop(client);
    ends.clock.settle().await;

    assert!(locked(&held).is_none(), "its last handle let go");
    assert_eq!(
        connecting
            .await
            .expect_err("disposed as it connected")
            .to_string(),
        "the transport client was disposed as it connected",
        "said why"
    );

    ends.clock.settle().await;

    assert_eq!(
        ends.server_told(),
        [
            format!("connection {FIRST}"),
            format!("closed {FIRST} false")
        ],
        "closed at once, unclean"
    );
    assert!(taken(&at_client).is_empty(), "nothing heard");
    assert!(ends.server.clients().is_empty(), "no connection held");
}

// a platform's shape: a message's data is bytes, so what is no bytes is no message to send
#[tokio::test]
async fn refuses_a_send_or_a_disconnect_unless_open_and_a_send_of_what_is_no_bytes() {
    let ends = Ends::started().await;
    let (client, _) = ends.client();

    // * never connected: nothing to send on, nor to close
    let unsent = client
        .send(message_of(&[1], None))
        .expect_err("never connected");

    assert_eq!(
        unsent.to_string(),
        "the transport client is uninitialized, not open",
        "said why"
    );

    let unclosed = client
        .disconnect(DisconnectOptions::default())
        .expect_err("never connected");

    assert!(
        matches!(unclosed, TransportError::ReadyState(_)),
        "a ready state's error: {unclosed:?}"
    );
    assert_eq!(
        unclosed.to_string(),
        "the transport client is uninitialized, not open",
        "said why"
    );

    ends.clock.settle().await;

    assert!(ends.server_told().is_empty(), "nothing reached its server");
    assert_eq!(
        client.ready_state(),
        ReadyState::Uninitialized,
        "nothing moved"
    );
}

// spec 15.13
#[tokio::test]
async fn refuses_a_reconnect_never_connected_and_a_connect_unless_closed_nothing_changed() {
    let ends = Ends::unstarted();
    let (client, _) = ends.client();
    let cancelled = CancellationToken::new();

    cancelled.cancel();

    // * never connected: nothing to connect again to
    assert_eq!(
        refusal_of(client.reconnect(ReconnectOptions::default())).as_deref(),
        Some("the transport client was never connected"),
        "said why"
    );

    // its token cancelled already, and a server not started: refused, the first leaving its state
    // as it was
    let refused = client
        .connect(MemoryConnectOptions {
            signal: Some(cancelled.clone()),
            ..MemoryConnectOptions::default()
        })
        .await
        .expect_err("cancelled already");

    assert!(
        matches!(refused, TransportError::Cancelled(_)),
        "cancelled: {refused:?}"
    );
    assert_eq!(client.ready_state(), ReadyState::Uninitialized, "as it was");

    let refused = client
        .connect(MemoryConnectOptions::default())
        .await
        .expect_err("its server not started");

    assert_eq!(
        refused.to_string(),
        "the in-memory transport server is uninitialized, not open",
        "said why"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");

    // open: a second connect refused, and a reconnection whose token is cancelled already leaves
    // it open
    ends.server.start().await.expect("started");

    let connecting = client.connect(MemoryConnectOptions::default());

    ends.clock.settle().await;
    connecting.await.expect("connected");

    let again = client
        .connect(MemoryConnectOptions::default())
        .await
        .expect_err("open already");

    assert_eq!(
        again.to_string(),
        "the transport client is already open",
        "said why"
    );
    assert!(
        matches!(
            client
                .reconnect(ReconnectOptions {
                    signal: Some(cancelled),
                    ..ReconnectOptions::default()
                })
                .err(),
            Some(TransportError::Cancelled(_))
        ),
        "a reconnection cancelled already refused"
    );
    assert_eq!(client.ready_state(), ReadyState::Open, "still open");
    assert_eq!(ends.server.clients().len(), 1, "one connection held");
}

// pending from its call to a later turn: what the other sides hold behind an accept, this side
// asks within the call's own turn, before any later one runs
#[tokio::test]
async fn refuses_a_second_connect_or_reconnect_while_one_is_pending() {
    for is_reconnect in [false, true] {
        let ends = Ends::started().await;
        let (client, at_client) = ends.client();

        if is_reconnect {
            let connecting = client.connect(MemoryConnectOptions::default());

            ends.clock.settle().await;
            connecting.await.expect("connected");
            ends.server_told();
        }

        let pending: BoxFuture<Result<(), TransportError>> = if is_reconnect {
            client
                .reconnect(ReconnectOptions {
                    maximum_attempts: Some(1),
                    ..ReconnectOptions::default()
                })
                .expect("a reconnection")
        } else {
            Box::pin(client.connect(MemoryConnectOptions::default()))
        };
        let state = if is_reconnect {
            "reconnecting"
        } else {
            "connecting"
        };

        assert_eq!(
            client
                .connect(MemoryConnectOptions::default())
                .await
                .err()
                .map(|refused| refused.to_string()),
            Some(format!("the transport client is already {state}")),
            "a second connect refused"
        );
        assert_eq!(
            refusal_of(client.reconnect(ReconnectOptions::default())).as_deref(),
            Some(if is_reconnect {
                "the transport client is already reconnecting"
            } else {
                "the transport client cannot reconnect while connecting"
            }),
            "a reconnection refused"
        );
        assert_eq!(
            client.ready_state(),
            if is_reconnect {
                ReadyState::Reconnecting
            } else {
                ReadyState::Connecting
            },
            "still pending"
        );
        assert_eq!(
            taken(&at_client),
            if is_reconnect {
                vec!["reconnect"]
            } else {
                vec![]
            },
            "its one start told, no close, no error"
        );
        assert!(
            ends.server_told().is_empty(),
            "nothing drawn nor closed within it"
        );

        ends.clock.settle().await;
        pending.await.expect("the first goes on");

        assert_eq!(client.ready_state(), ReadyState::Open, "open");
        assert_eq!(ends.server.clients().len(), 1, "one connection held");

        client
            .disconnect(DisconnectOptions::default())
            .expect("closed");
        ends.clock.settle().await;

        assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
        assert!(ends.server.clients().is_empty(), "none held");
        assert_eq!(
            taken(&at_client),
            ["closed true false"],
            "its own close alone"
        );
        assert_eq!(
            ends.server_told(),
            if is_reconnect {
                vec![
                    format!("closed {FIRST} false"),
                    format!("connection {SECOND}"),
                    format!("closed {SECOND} true"),
                ]
            } else {
                vec![
                    format!("connection {FIRST}"),
                    format!("closed {FIRST} true"),
                ]
            },
            "the one it replaced dropped, its own closed clean"
        );
    }
}

// spec 15.13
#[tokio::test]
async fn reconnects_with_its_last_connect_s_options_replacing_its_connection_without_a_close() {
    const ONE: &str = "type=MEMORY;ip=10.0.0.1;ordinal=1";
    const TWO: &str = "type=MEMORY;ip=10.0.0.1;ordinal=2";

    let ends = Ends::started().await;
    let (client, at_client) = ends.client();

    // * each listener of its start told, the one that panics reported, and the reconnection goes on
    client.listen(Arc::new(Breaking));

    let connecting = client.connect(MemoryConnectOptions {
        address: Some("10.0.0.1".to_owned()),
        port: Some(4_000),
        ..MemoryConnectOptions::default()
    });

    ends.clock.settle().await;
    connecting.await.expect("connected");

    let reconnection = client
        .reconnect(ReconnectOptions::default())
        .expect("a reconnection");

    ends.clock.settle().await;
    reconnection.await.expect("reconnected");

    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    assert_eq!(
        ends.server_told(),
        [
            format!("connection {ONE}"),
            format!("closed {ONE} false"),
            format!("connection {TWO}"),
        ],
        "drawn again with its last connect's options, the one it replaced dropped"
    );
    assert_eq!(
        taken(&at_client),
        ["reconnect", BROKE],
        "its start told once, the listener that broke reported, no close"
    );

    // its server gone: each attempt refused until they run out, closed with no close of its own
    ends.server.stop().await;
    ends.clock.settle().await;

    assert_eq!(
        taken(&at_client),
        ["closed false false", BROKE],
        "its server's close"
    );

    let reconnection = client
        .reconnect(ReconnectOptions {
            maximum_attempts: Some(1),
            ..ReconnectOptions::default()
        })
        .expect("a reconnection");

    ends.clock.settle().await;

    let gave_up = reconnection.await;

    assert!(
        matches!(
            &gave_up,
            Err(TransportError::Reconnect(error)) if std::error::Error::source(error)
                .and_then(|cause| cause.downcast_ref::<TransportError>())
                .is_some_and(|cause| matches!(cause, TransportError::Connect(_)))
        ),
        "a reconnection's error, its connect's its cause: {gave_up:?}"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    assert_eq!(
        taken(&at_client),
        ["reconnect", BROKE],
        "no close of its own"
    );
}

#[tokio::test]
async fn cancels_a_reconnection_before_its_first_attempt_when_its_start_listener_cancels() {
    let ends = Ends::started().await;
    let (client, at_client) = ends.connected((None, None)).await;
    let cancelling = CancellationToken::new();
    let cancel = cancelling.clone();

    client.listen(Arc::new(OnReconnect(move || cancel.cancel())));
    ends.server_told();

    let reconnection = client
        .reconnect(ReconnectOptions {
            maximum_attempts: Some(1),
            signal: Some(cancelling),
            ..ReconnectOptions::default()
        })
        .expect("a reconnection");

    ends.clock.settle().await;

    let cancelled = reconnection.await.expect_err("cancelled");

    ends.clock.settle().await;

    assert!(
        matches!(cancelled, TransportError::Cancelled(_)),
        "cancelled: {cancelled:?}"
    );
    assert_eq!(
        cancelled.to_string(),
        "the reconnection was cancelled",
        "said why"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    assert!(ends.server.clients().is_empty(), "none held");
    assert_eq!(
        ends.server_told(),
        [format!("closed {FIRST} false")],
        "the one it replaced dropped, none drawn"
    );
    assert_eq!(
        taken(&at_client),
        ["reconnect"],
        "its start told, no close, no error"
    );
}

// the seam after its attempt opened and before its reconnection hears so, as the C# side's
// timeout's release is: a message its server sent as it drew the connection, told as it opens
// spec 15.13
#[tokio::test]
async fn closes_a_successful_last_attempt_when_its_reconnection_is_cancelled_after_it_opens() {
    for is_closed_before_cancel in [false, true] {
        let ends = Ends::started().await;
        let (client, at_client) = ends.connected((None, None)).await;
        let cancelling = CancellationToken::new();
        let opened: Arc<Mutex<Vec<ReadyState>>> = Arc::default();
        let server = ends.server.clone();
        let (seam, cancel, seen) = (client.clone(), cancelling.clone(), Arc::clone(&opened));

        ends.server
            .listen(Arc::new(OnConnection(move |handle: &ConnectionHandle| {
                server.send(message_of(&[1], None), handle).expect("sent");
            })));
        client.listen(Arc::new(OnMessage(move |_: &TransportMessage| {
            locked(&seen).push(seam.ready_state());

            if is_closed_before_cancel {
                seam.disconnect(DisconnectOptions::default())
                    .expect("closed");
            }

            cancel.cancel();
        })));
        ends.server_told();

        let reconnection = client
            .reconnect(ReconnectOptions {
                maximum_attempts: Some(1),
                signal: Some(cancelling),
                ..ReconnectOptions::default()
            })
            .expect("a reconnection");

        ends.clock.settle().await;

        let cancelled = reconnection.await.expect_err("cancelled");

        ends.clock.settle().await;

        assert_eq!(
            cancelled.to_string(),
            "the reconnection was cancelled",
            "said why"
        );
        assert_eq!(
            *locked(&opened),
            [ReadyState::Open],
            "open as it was cancelled"
        );
        assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
        assert_eq!(
            taken(&at_client),
            ["reconnect", "heard 01 carrying None", "closed true false"],
            "one close, clean, and no error"
        );
        assert_eq!(
            ends.server_told(),
            [
                format!("closed {FIRST} false"),
                format!("connection {SECOND}"),
                format!("closed {SECOND} true"),
            ],
            "what its last attempt opened closed clean"
        );
        assert!(ends.server.clients().is_empty(), "none held");
    }
}

#[tokio::test]
async fn closes_what_its_last_attempt_opened_as_its_reconnection_was_cancelled() {
    let ends = Ends::started().await;
    let (client, at_client) = ends.connected((None, None)).await;
    let cancelling = CancellationToken::new();
    let cancel = cancelling.clone();

    // * the reconnection cancelled in the very turn its server draws the connection: the cancel
    // holds until its attempt's connect settles, which fails, what was drawn closed unclean and no
    // close told here
    ends.server
        .listen(Arc::new(OnConnection(move |_: &ConnectionHandle| {
            cancel.cancel();
        })));
    ends.server_told();

    let reconnection = client
        .reconnect(ReconnectOptions {
            signal: Some(cancelling),
            ..ReconnectOptions::default()
        })
        .expect("a reconnection");

    ends.clock.settle().await;

    let cancelled = reconnection.await.expect_err("cancelled");

    ends.clock.settle().await;

    assert_eq!(
        cancelled.to_string(),
        "the reconnection was cancelled",
        "said why"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    assert_eq!(taken(&at_client), ["reconnect"], "no close told here");
    assert_eq!(
        ends.server_told(),
        [
            format!("closed {FIRST} false"),
            format!("connection {SECOND}"),
            format!("closed {SECOND} false"),
        ],
        "what was drawn closed unclean"
    );
    assert!(ends.server.clients().is_empty(), "none held");
}

// spec 15.13
#[tokio::test]
async fn hears_nothing_once_it_let_go_of_its_connection_and_tells_one_close_at_each_end() {
    let ends = Ends::started().await;
    let (client, at_client) = ends.connected((None, None)).await;
    let handle: ConnectionHandle = Arc::from(FIRST);

    ends.server_told();

    // * its server sends and ends it as its client closes it, in one turn: none of it heard, one
    // close told at each end
    ends.server
        .send(message_of(&[8], None), &handle)
        .expect("sent");

    let ending = ends.server.close(&handle);

    client
        .disconnect(DisconnectOptions::default())
        .expect("closed");
    ends.clock.settle().await;

    assert!(ending.await, "it held the connection");
    assert_eq!(
        taken(&at_client),
        ["closed true false"],
        "its own close alone"
    );
    assert_eq!(
        ends.server_told(),
        [format!("closed {FIRST} true")],
        "its server's close alone"
    );
}

// a platform's shape: a message's data is bytes, so what is no bytes is no message to send
// spec 15.13
#[tokio::test]
async fn drops_what_an_end_it_no_longer_holds_receives_and_refuses_to_send_what_is_no_bytes() {
    let ends = Ends::started().await;
    let (client, at_client) = ends.connected((None, None)).await;
    let handle: ConnectionHandle = Arc::from(FIRST);

    client.send(message_of(&[1], None)).expect("sent");
    ends.clock.settle().await;

    assert_eq!(
        ends.server_told(),
        [
            format!("connection {FIRST}"),
            format!("heard 01 on {FIRST} carrying None from Some(\"local\") None"),
        ],
        "heard while held"
    );

    // * ended twice, then a send its client made before it heard so, in one turn: neither heard
    // nor ended again
    let ending = ends.server.close(&handle);
    let again = ends.server.close(&handle);

    client.send(message_of(&[2], None)).expect("sent");
    ends.clock.settle().await;

    assert_eq!((ending.await, again.await), (true, true), "both held it");
    assert_eq!(
        ends.server_told(),
        [format!("closed {FIRST} true")],
        "ended once, nothing heard after"
    );
    assert_eq!(
        taken(&at_client),
        ["closed false false"],
        "its client told once"
    );
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    assert!(ends.server.clients().is_empty(), "none held");
}

// spec 15.13
#[tokio::test]
async fn draws_no_connection_for_a_connect_cancelled_as_it_held_it_and_reports_what_a_listener_throws()
 {
    let ends = Ends::started().await;
    let (client, _) = ends.client();

    ends.server.listen(Arc::new(Breaking));

    // * a connect whose token is cancelled as its server holds it, before the turn it would be
    // drawn in: no connection drawn
    let cancelling = CancellationToken::new();
    let connecting = client.connect(MemoryConnectOptions {
        signal: Some(cancelling.clone()),
        ..MemoryConnectOptions::default()
    });

    cancelling.cancel();

    let refused = connecting.await.expect_err("cancelled");

    ends.clock.settle().await;

    assert!(
        matches!(refused, TransportError::Cancelled(_)),
        "cancelled: {refused:?}"
    );
    assert!(ends.server_told().is_empty(), "none drawn");
    assert!(ends.server.clients().is_empty(), "none held");

    // a listener's panic reported with its connection, the transport going on
    let connecting = client.connect(MemoryConnectOptions::default());

    ends.clock.settle().await;
    connecting.await.expect("connected");
    client.send(message_of(&[1], None)).expect("sent");
    client.send(message_of(&[2], None)).expect("sent");
    ends.clock.settle().await;

    let on = format!("on Some({FIRST:?})");

    assert_eq!(
        ends.server_told(),
        [
            format!("connection {FIRST}"),
            format!("{BROKE} {on}"),
            format!("heard 01 on {FIRST} carrying None from Some(\"local\") None"),
            format!("{BROKE} {on}"),
            format!("heard 02 on {FIRST} carrying None from Some(\"local\") None"),
            format!("{BROKE} {on}"),
        ],
        "each panic reported with its connection"
    );
}

#[tokio::test]
async fn calls_each_listener_though_one_throws_reporting_the_throw_with_its_connection() {
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let server = MemoryServer::new(&MemoryServerOptions {
        clock: Some(Arc::clone(&shared)),
        runtime: None,
    })
    .expect("a server");
    let client = MemoryClient::new(&MemoryClientOptions {
        clock: Some(shared),
        server: server.clone(),
    })
    .expect("a client");
    let told: Told = Arc::default();

    // * the one that panics first: each after it told all the same
    server.listen(Arc::new(Breaking));
    server.listen(Arc::new(AtServer {
        told: Arc::clone(&told),
    }));
    client.listen(Arc::new(Breaking));
    client.listen(Arc::new(AtClient {
        told: Arc::clone(&told),
    }));
    server.start().await.expect("started");

    let connecting = client.connect(MemoryConnectOptions::default());

    clock.settle().await;
    connecting.await.expect("connected");
    client.send(message_of(&[1], None)).expect("sent");
    clock.settle().await;

    // a client's events carry no connection: its panics are reported with none
    let reconnection = client
        .reconnect(ReconnectOptions::default())
        .expect("a reconnection");

    clock.settle().await;
    reconnection.await.expect("reconnected");

    let closing = server.close(&Arc::from(SECOND));

    clock.settle().await;

    assert!(closing.await, "it held the connection");

    let (first, second) = (
        format!("on Some({FIRST:?})"),
        format!("on Some({SECOND:?})"),
    );

    assert_eq!(
        taken(&told),
        [
            format!("{BROKE} {first}"),
            format!("connection {FIRST}"),
            format!("{BROKE} {first}"),
            format!("heard 01 on {FIRST} carrying None from Some(\"local\") None"),
            BROKE.to_owned(),
            "reconnect".to_owned(),
            format!("{BROKE} {first}"),
            format!("closed {FIRST} false"),
            format!("{BROKE} {second}"),
            format!("connection {SECOND}"),
            format!("{BROKE} {second}"),
            format!("closed {SECOND} true"),
            BROKE.to_owned(),
            "closed false false".to_owned(),
        ],
        "every listener told, each panic reported, with its connection where there is one"
    );
}
