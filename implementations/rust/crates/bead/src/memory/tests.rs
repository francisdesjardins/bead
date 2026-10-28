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
use crate::router::types::{ConnectionHandle, RouterLimitsOptions, TransportMessage};
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
        server.start().await.expect("started");

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

    let echoed = tokio::time::timeout(Duration::from_secs(10), call)
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

    let reconnected = tokio::spawn(reconnection);

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
    let first = tokio::spawn(
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
