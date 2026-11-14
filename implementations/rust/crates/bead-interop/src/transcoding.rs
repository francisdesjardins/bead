//! The `Transcoding` service of `spec/transcoding.proto`, and a gateway of its table before it.
//!
//! The service is served as `spec/transcoding.json`'s `service` states each procedure, on a server
//! whose in-memory transport is joined: what the conformance's exchanges and the gateway's and the
//! caller's tests call. Its table, its messages and its document are what beadc writes into
//! `generated` (decision 0052), which `tools/check-transcoding.mjs` holds to it.

use core::future::Future;
use core::time::Duration;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bead::{
    CallError, CommandOptions, ConnectionHandle, Credentials, DebugDirection, Descriptor,
    DescriptorInit, ElsewhereSession, EnvelopeKind, HttpGateway, HttpGatewayOptions,
    HttpGatewayStartOptions, MemoryTransportServer, MemoryTransportServerOptions, Notifier,
    NotifyOptions, NotifyingDescriptor, PayloadCodec, ProgrammerError, RequestProps, ResolverError,
    Response, RouterError, Server, ServerOptions, ServiceProcedure, ServiceServer,
    ServiceServerOptions, SessionIdentifier, TracedEnvelope, request_of,
};
use bead_protobuf::{DynamicCodec, ProtoCodec, ProtoSchema};
use buffa::Message as _;
use buffa_descriptor::reflect::DynamicMessage;
use buffa_types::google::protobuf::Empty;

#[expect(
    clippy::mod_module_files,
    reason = "beadc writes its tree's root as mod.rs, Buffa's name for a checked-in tree"
)]
pub mod generated;

use generated::bead_http::{HTTP_PROBLEM_TYPES, HttpRoutes, OPENAPI_DOCUMENT};
use generated::messages::bead::transcoding::v1::{
    AskResponse, Book, CancelsResponse, ListBooksResponse, ListOperationsResponse, Needs,
    Operation, Requiring, Tick, TicksResponse, WhoAmIResponse,
};
use generated::services::bead::transcoding::v1::{TranscodingFailures, TranscodingProcedures};

/// The value of `authorization` the server's `ELSEWHERE` verifier takes.
pub const GOOD_CREDENTIAL: &str = "Bearer good";

/// The session [`GOOD_CREDENTIAL`] names.
pub const SESSION: &str = "ada";

// how long `ticks` waits for its notifications to leave before it ends its subscription, at most
const TICKS_PATIENCE: Duration = Duration::from_secs(5);

// how often `cancels` looks again, and how many times at most: 1 second
const CANCELS_REST: Duration = Duration::from_millis(5);
const CANCELS_LOOKS: u32 = 200;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn failed<E: core::fmt::Display>(what: &str) -> impl FnOnce(E) -> String + '_ {
    move |error| format!("{what}: {error}")
}

/// The counts a fixture's exchanges wait on.
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct TranscodingCounts {
    /// The calls of `hang` that ended cancelled.
    pub cancelled: AtomicU64,
    /// The calls of `hang` its resolver took.
    pub hanging: AtomicU64,
    /// The errors its server reported (spec 9.0).
    pub reported: AtomicU64,
    /// The calls of `require` its resolver took.
    pub requires: AtomicU64,
}

impl TranscodingCounts {
    /// A count by the name `spec/transcoding.json`'s `counts` gives it; none for another name.
    #[must_use]
    pub fn by_name(&self, name: &str) -> Option<u64> {
        let count = match name {
            "cancelled" => &self.cancelled,
            "hanging" => &self.hanging,
            "reported" => &self.reported,
            "requires" => &self.requires,
            _ => return None,
        };

        Some(count.load(Ordering::SeqCst))
    }
}

/// How a fixture serves its gateway: its gateway's options, and where it listens.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct TranscodingFixtureOptions {
    /// Its gateway's options, over the in-memory transport its server listens on, as
    /// [`gateway_options`] gives them and a test changes them.
    pub gateway: HttpGatewayOptions,
    /// Whether its gateway listens on 127.0.0.1, on a port of its own, `true` when none; it is
    /// mounted otherwise.
    pub listens: Option<bool>,
}

impl TranscodingFixtureOptions {
    /// The options of a fixture of `gateway`, listening on a port of its own.
    #[must_use]
    pub fn new(gateway: &HttpGatewayOptions) -> Self {
        Self {
            gateway: gateway.clone(),
            listens: None,
        }
    }
}

/// A gateway's options over a new in-memory transport, beside beadc's table, document and problem
/// types.
///
/// A fixture serves the service on them: changed by assignment, then given to
/// [`TranscodingFixture::start`].
///
/// # Errors
///
/// What refuses the transport or beadc's table, in words.
pub fn gateway_options() -> Result<HttpGatewayOptions, String> {
    let memory = MemoryTransportServer::new(&MemoryTransportServerOptions::default())
        .map_err(failed("the in-memory transport"))?;
    let routes = HttpRoutes::get().map_err(failed("beadc's table"))?;
    let mut options = HttpGatewayOptions::new(memory, routes.all.clone());

    options.document = Some(OPENAPI_DOCUMENT.as_bytes().to_vec().into());
    options.problem_types = HTTP_PROBLEM_TYPES.map(str::to_owned);

    Ok(options)
}

/// A gateway in front of a server of the `Transcoding` service, and the counts its exchanges wait
/// on.
#[derive(Debug)]
pub struct TranscodingFixture {
    /// The counts its exchanges wait on.
    pub counts: Arc<TranscodingCounts>,
    /// Its gateway.
    pub gateway: HttpGateway,
    /// The in-memory transport its gateway's connections cross.
    pub memory: MemoryTransportServer,
    /// The detail of each command of `ask` that failed, in their order.
    pub refused: Arc<Mutex<Vec<String>>>,
    /// Its server.
    pub server: Server,
    /// The notifier of `watch`.
    pub watch: Notifier<ProtoCodec<Tick>>,
    /// Its gateway's own listener's port, on 127.0.0.1; 0 where it is mounted.
    pub port: u16,
}

impl TranscodingFixture {
    /// A server of the service on its gateway's in-memory transport, joined, and a gateway of
    /// those options in front of it, served as `options` says.
    ///
    /// # Errors
    ///
    /// What refuses the server, the service, the gateway or its listener, in words.
    pub async fn start(options: &TranscodingFixtureOptions) -> Result<Self, String> {
        let gateway = &options.gateway;
        let memory = gateway.transport.clone();
        let mut server_options = ServerOptions::default();

        server_options.credentials = Some(credentials());

        let server =
            Server::new(Arc::new(memory.clone()), &server_options).map_err(failed("the server"))?;
        let procedures = TranscodingProcedures::get().map_err(failed("its procedures"))?;
        let require = require_of(procedures).map_err(failed("require's descriptor"))?;
        let all = procedures
            .all()
            .into_iter()
            .map(|procedure| {
                if procedure.procedure() == require.procedure() {
                    ServiceProcedure::from(&require)
                } else {
                    procedure
                }
            })
            .collect();
        let service = ServiceServer::new(all, &ServiceServerOptions::default())
            .map_err(failed("the service"))?;
        let watch = service
            .notifier_of(&procedures.watch)
            .map_err(failed("watch's notifier"))?;
        let counts = Arc::new(TranscodingCounts::default());
        let refused = Arc::new(Mutex::new(Vec::new()));
        let sent = Arc::new(Sent::default());

        {
            let sent = Arc::clone(&sent);

            server.router().on_debug(Arc::new(move |direction, traced| {
                sent.heard(direction, traced);
            }));
        }

        Offering {
            service: &service,
            procedures,
        }
        .answer(
            &require,
            &Kept {
                server: server.clone(),
                counts: Arc::clone(&counts),
                refused: Arc::clone(&refused),
                sent,
            },
        )
        .map_err(failed("its resolvers"))?;

        {
            let counts = Arc::clone(&counts);

            server.router().on_error(Arc::new(move |_error, _handle| {
                counts.reported.fetch_add(1, Ordering::SeqCst);
            }));
        }

        service.offer(&server).map_err(failed("its offer"))?;
        memory
            .start()
            .await
            .map_err(failed("the in-memory transport"))?;

        let given = gateway;
        let gateway = HttpGateway::new(given).map_err(failed("the gateway"))?;
        let port = if options.listens.unwrap_or(true) {
            let mut start = HttpGatewayStartOptions::default();

            start.address = Some("127.0.0.1".to_owned());
            start.port = Some(0);

            gateway
                .start(&start)
                .await
                .map_err(failed("its listener"))?
                .port
        } else {
            0
        };

        Ok(Self {
            counts,
            gateway,
            memory,
            refused,
            server,
            watch,
            port,
        })
    }

    /// Notifies each subscriber of `watch` with `remaining`, as its server's service does.
    pub async fn watched(&self, remaining: i32) {
        self.watch
            .notify(
                Tick {
                    remaining,
                    ..Tick::default()
                },
                &NotifyOptions::default(),
            )
            .await;
    }

    /// Stops its gateway, then disposes of its server.
    ///
    /// # Errors
    ///
    /// What either refused as it ended.
    pub async fn dispose(self) -> Result<(), RouterError> {
        self.gateway.dispose().await?;
        self.server.dispose().await
    }
}

// `Bearer good` resolves to the session of `ada`; any other value does not hold
fn credentials() -> Credentials {
    let mut credentials = Credentials::default();

    credentials.verify = Some(Arc::new(|carried, _signal| {
        Box::pin(async move {
            Ok((carried == GOOD_CREDENTIAL).then(|| ElsewhereSession {
                id: SESSION.to_owned(),
                data: None,
                end: None,
            }))
        })
    }));

    credentials
}

// what the resolvers share
#[derive(Clone)]
struct Kept {
    server: Server,
    counts: Arc<TranscodingCounts>,
    refused: Arc<Mutex<Vec<String>>>,
    sent: Arc<Sent>,
}

// what its server sent on each connection: its notifications, and whether its client cancelled
#[derive(Debug, Default)]
struct Outgoing {
    notifications: u64,
    cancelled: bool,
}

// the notifications its server sent, by connection, heard on its router's trace: a subscription
// ended by its service's failure drops what its queue still holds (spec 11.7), so `ticks` ends its
// own once its notifications left, or its client cancelled it
#[derive(Debug, Default)]
struct Sent {
    by_connection: Mutex<BTreeMap<ConnectionHandle, Outgoing>>,
    changed: tokio::sync::Notify,
}

impl Sent {
    fn heard(&self, direction: DebugDirection, traced: &TracedEnvelope) {
        let is_sent = match (direction, traced.header.kind()) {
            (DebugDirection::Tx, EnvelopeKind::Notification) => true,
            (DebugDirection::Rx, EnvelopeKind::Cancel) => false,
            _ => return,
        };

        let mut by_connection = locked(&self.by_connection);
        let outgoing = by_connection
            .entry(Arc::clone(&traced.connection_handle))
            .or_default();

        if is_sent {
            outgoing.notifications = outgoing.notifications.saturating_add(1);
        } else {
            outgoing.cancelled = true;
        }

        drop(by_connection);
        self.changed.notify_waiters();
    }

    fn notifications(&self, connection_handle: &ConnectionHandle) -> u64 {
        locked(&self.by_connection)
            .get(connection_handle)
            .map_or(0, |outgoing| outgoing.notifications)
    }

    // until `count` notifications left on a connection, its client cancelled, or its patience ran
    async fn until_sent(&self, connection_handle: &ConnectionHandle, count: u64) {
        let waited = tokio::time::timeout(TICKS_PATIENCE, async {
            loop {
                let changed = self.changed.notified();

                if locked(&self.by_connection)
                    .get(connection_handle)
                    .is_some_and(|outgoing| outgoing.cancelled || outgoing.notifications >= count)
                {
                    return;
                }

                changed.await;
            }
        });

        // * past its patience, it ends the subscription as it would have
        drop(waited.await);
    }
}

// the code and the detail a command of `ask` failed with
fn refusal_of(error: &CallError) -> (i32, String) {
    match error {
        CallError::Failure(failure) => {
            (i32::from(failure.code().get()), failure.detail().to_owned())
        }
        CallError::Cancelled(_)
        | CallError::Disconnected(_)
        | CallError::ReadyState(_)
        | CallError::TimedOut(_)
        | CallError::Refused(_)
        | CallError::Other(_)
        | _ => (0, error.to_string()),
    }
}

// `require`'s descriptor, its result's codec the dynamic one, which a Needs of no field holds: a
// typed Needs holds its required fields bare, which no value leaves unset (docs/support.md, "A
// proto value that leaves a required field unset or holds a closed enum's undeclared number,
// given to a typed writer")
fn require_of(
    procedures: &TranscodingProcedures,
) -> Result<Descriptor<ProtoCodec<Requiring>, DynamicCodec>, ProgrammerError> {
    let schema = ProtoSchema::of::<Needs>();

    request_of(DescriptorInit {
        procedure: procedures.require.procedure().clone(),
        admission: procedures.require.admission(),
        failures: procedures.require.failures().to_vec(),
        request: ProtoCodec::new()?,
        result: DynamicCodec::new(Arc::clone(schema.pool()), schema.message()),
        validate: None,
    })
}

// a typed Needs as its dynamic message holds it
fn dynamic_of(needs: &Needs) -> Result<DynamicMessage, ResolverError> {
    let schema = ProtoSchema::of::<Needs>();

    DynamicMessage::decode(
        Arc::clone(schema.pool()),
        schema.message(),
        &needs.encode_to_vec(),
    )
    .map_err(|error| ResolverError::other(format!("a Needs of its own bytes: {error}")))
}

// a service's procedures, answered through its service layer
struct Offering<'a> {
    service: &'a ServiceServer,
    procedures: &'static TranscodingProcedures,
}

impl Offering<'_> {
    fn on<Req, Res, F, Fut>(
        &self,
        descriptor: &Descriptor<Req, Res>,
        resolver: F,
    ) -> Result<(), ProgrammerError>
    where
        Req: PayloadCodec + Clone,
        Res: PayloadCodec + Clone,
        Req::Value: Clone + core::fmt::Debug + Sync,
        Res::Value: Clone + core::fmt::Debug + Sync,
        F: Fn(RequestProps<Req::Value>, Response<Res>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), ResolverError>> + Send + 'static,
    {
        self.service.on(
            descriptor,
            Arc::new(move |request, response| Box::pin(resolver(request, response))),
        )
    }

    fn on_notifying<Req, Res, Not, F, Fut>(
        &self,
        descriptor: &NotifyingDescriptor<Req, Res, Not>,
        resolver: F,
    ) -> Result<(), ProgrammerError>
    where
        Req: PayloadCodec + Clone,
        Res: PayloadCodec + Clone,
        Not: PayloadCodec + Clone,
        Req::Value: Clone + core::fmt::Debug + Sync,
        Res::Value: Clone + core::fmt::Debug + Sync,
        Not::Value: Clone + core::fmt::Debug + Sync,
        F: Fn(RequestProps<Req::Value>, Response<Res>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), ResolverError>> + Send + 'static,
    {
        self.service.on_notifying(
            descriptor,
            Arc::new(move |request, response| Box::pin(resolver(request, response))),
        )
    }

    // each procedure answered as spec/transcoding.json's `service` states it
    #[expect(
        clippy::too_many_lines,
        reason = "one resolver a procedure, as the file states them, in the service's order"
    )]
    fn answer(
        &self,
        require: &Descriptor<ProtoCodec<Requiring>, DynamicCodec>,
        kept: &Kept,
    ) -> Result<(), ProgrammerError> {
        let procedures = self.procedures;
        let service = self.service;

        self.on(&procedures.echo, |request, response| async move {
            response.result(request.payload).await
        })?;
        self.on(&procedures.echo_edges, |request, response| async move {
            response.result(request.payload).await
        })?;
        self.on(&procedures.get_book, |request, response| async move {
            let book = Book {
                name: request.payload.name,
                pages: request.payload.revision,
                title: "A tale".to_owned(),
                ..Book::default()
            };

            response.result(book).await
        })?;
        self.on(&procedures.list_books, |request, response| async move {
            let parent = request.payload.parent;
            let books = [("a", "A"), ("b", "B")]
                .into_iter()
                .map(|(name, title)| Book {
                    name: format!("{parent}/books/{name}"),
                    title: title.to_owned(),
                    ..Book::default()
                })
                .collect();

            response
                .result(ListBooksResponse {
                    books,
                    ..ListBooksResponse::default()
                })
                .await
        })?;
        self.on(&procedures.update_book, |request, response| async move {
            response.result(request.payload).await
        })?;
        self.on(&procedures.archive_book, |_request, response| async move {
            response.result(Empty::default()).await
        })?;
        self.on(
            &procedures.list_operations,
            |request, response| async move {
                let operation = Operation {
                    name: format!("{}/a", request.payload.name),
                    ..Operation::default()
                };

                response
                    .result(ListOperationsResponse {
                        operations: vec![operation],
                        ..ListOperationsResponse::default()
                    })
                    .await
            },
        )?;
        self.on(&procedures.get_operation, |request, response| async move {
            let operation = Operation {
                name: request.payload.name,
                done: true,
                ..Operation::default()
            };

            response.result(operation).await
        })?;
        self.on(&procedures.judge, |_request, response| async move {
            response.result(Empty::default()).await
        })?;
        {
            let server = kept.server.clone();
            let sent = Arc::clone(&kept.sent);
            let ticks = service.notifier_of(&procedures.ticks)?;

            self.on_notifying(&procedures.ticks, move |request, response| {
                let server = server.clone();
                let sent = Arc::clone(&sent);
                let ticks = ticks.clone();

                async move {
                    let handle = Arc::clone(&request.connection_handle);
                    let from = request.payload.from;
                    let before = sent.notifications(&handle);

                    response
                        .result(TicksResponse {
                            ticks: from,
                            ..TicksResponse::default()
                        })
                        .await?;

                    for remaining in (0..from).rev() {
                        let mut options = NotifyOptions::default();
                        let on = Arc::clone(&handle);

                        options.filter = Some(Arc::new(move |subscriber: &bead::Subscriber| {
                            subscriber.connection_handle == on
                        }));
                        ticks
                            .notify(
                                Tick {
                                    remaining,
                                    ..Tick::default()
                                },
                                &options,
                            )
                            .await;
                    }

                    // * the subscription ends with the service's own failure, on its call id, once its
                    // notifications left its queue
                    sent.until_sent(
                        &handle,
                        before.saturating_add(u64::try_from(from).unwrap_or(0)),
                    )
                    .await;
                    server
                        .router()
                        .drop_subscriptions(handle, TranscodingFailures::COUNTED.of(""))
                        .await;

                    Ok(())
                }
            })?;
        }
        self.on_notifying(&procedures.watch, |_request, response| async move {
            response.result(Empty::default()).await
        })?;
        self.on(&procedures.raw, |request, response| async move {
            response.result(request.payload).await
        })?;
        self.on(&procedures.text, |request, response| async move {
            response.result(request.payload).await
        })?;
        self.on(&procedures.json, |request, response| async move {
            response.result(request.payload).await
        })?;
        self.on(&procedures.fail, |request, response| async move {
            response
                .failure(&TranscodingFailures::REFUSED.of(&request.payload.detail))
                .await
        })?;
        self.on(&procedures.who_am_i, |request, response| async move {
            let session = match request
                .session
                .as_ref()
                .and_then(|session| session.identifier.as_ref())
            {
                Some(SessionIdentifier::Elsewhere { id }) => id.clone(),
                _ => String::new(),
            };

            response
                .result(WhoAmIResponse {
                    session,
                    ..WhoAmIResponse::default()
                })
                .await
        })?;
        {
            let refused = Arc::clone(&kept.refused);
            let command = service.command_of(&procedures.answer)?;

            self.on(&procedures.ask, move |request, response| {
                let refused = Arc::clone(&refused);
                let command = command.clone();

                async move {
                    let options = CommandOptions::new(Arc::clone(&request.connection_handle));
                    let outcome = match command.call(Empty::default(), &options) {
                        Ok(call) => call.await.map(drop),
                        Err(error) => Err(CallError::Refused(error)),
                    };
                    let code = match outcome {
                        Ok(()) => 0,
                        Err(error) => {
                            let (code, detail) = refusal_of(&error);

                            locked(&refused).push(detail);
                            code
                        }
                    };

                    response
                        .result(AskResponse {
                            code,
                            ..AskResponse::default()
                        })
                        .await
                }
            })?;
        }
        {
            let counts = Arc::clone(&kept.counts);

            self.on(&procedures.hang, move |request, _response| {
                let counts = Arc::clone(&counts);

                async move {
                    counts.hanging.fetch_add(1, Ordering::SeqCst);
                    request.signal.token().cancelled().await;
                    counts.cancelled.fetch_add(1, Ordering::SeqCst);

                    // * answers never, as the file states it
                    core::future::pending::<Result<(), ResolverError>>().await
                }
            })?;
        }
        {
            let counts = Arc::clone(&kept.counts);

            self.on(&procedures.cancels, move |request, response| {
                let counts = Arc::clone(&counts);

                async move {
                    let at_least = u64::try_from(request.payload.at_least).unwrap_or(0);
                    for _ in 0..CANCELS_LOOKS {
                        if counts.cancelled.load(Ordering::SeqCst) >= at_least {
                            break;
                        }

                        tokio::time::sleep(CANCELS_REST).await;
                    }

                    let count =
                        i32::try_from(counts.cancelled.load(Ordering::SeqCst)).unwrap_or(i32::MAX);

                    response
                        .result(CancelsResponse {
                            count,
                            ..CancelsResponse::default()
                        })
                        .await
                }
            })?;
        }
        {
            let counts = Arc::clone(&kept.counts);

            self.on(require, move |request, response| {
                let counts = Arc::clone(&counts);

                async move {
                    counts.requires.fetch_add(1, Ordering::SeqCst);

                    // * a Needs of no field where none is set, which its codec refuses to write (spec
                    // 17.9.7)
                    let needs = if let Some(needs) = request.payload.needs.into_option() {
                        dynamic_of(&needs)?
                    } else {
                        let schema = ProtoSchema::of::<Needs>();

                        DynamicMessage::new(Arc::clone(schema.pool()), schema.message())
                    };

                    response.result(needs).await
                }
            })?;
        }
        self.on(&procedures.get_needs, |request, response| async move {
            response.result(request.payload).await
        })?;
        self.on(&procedures.update_needs, |request, response| async move {
            let needs: Needs = request.payload.needs.into_option().unwrap_or_default();

            response.result(needs).await
        })?;

        Ok(())
    }
}
