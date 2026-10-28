//! The core both routers share, played through each: a call cancelled while it waits, a
//! procedure's payloads held to its limit, transfers ended with their connection or their router,
//! what is read, traced and dispatched, what a call made or answered counts and reads, and a
//! closing connection's calls detached before its resolvers hear of it.

#![expect(
    clippy::too_many_lines,
    reason = "a twin plays its sentence whole, as the other sides' twins do"
)]

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::server::{Served, counted_options, first, registry, request_of, second};
use super::{Scripted, answered, locked, options_of, request_of as client_request_of, result_of};
use crate::constants::{EnvelopeKind, ProcedureKind, ProtocolCode, RouterSide};
use crate::debug::{DebugDirection, TracedEnvelope};
use crate::envelope::{CreditHeader, Envelope, RequestHeader, ResultHeader};
use crate::errors::CallError;
use crate::identity::Procedure;
use crate::managers::service::{ResolverDependencies, Response};
use crate::metrics::MetricsRegistry;
use crate::payloads::RawCodec;
use crate::router::admissions::BeforeRequest;
use crate::router::client::{ClientRequest, RouterClientOptions};
use crate::router::core::{Handler, ResolverProps, Side};
use crate::router::parts::PendingCalls;
use crate::router::server::{CallHooks, RouterServerOptions, ServerRequest};
use crate::router::types::{
    CallAddress, ConnectionHandle, RouterAnswer, RouterLimitsOptions, TransportMessage,
};
use crate::testing::pair::echo;
use crate::testing::scripted::Sending;

// echo as a command, which a server's router makes
fn command(maximum_payload_bytes: Option<u64>) -> Procedure {
    Procedure {
        kind: Some(ProcedureKind::Command),
        maximum_payload_bytes,
        ..echo()
    }
}

// a command of `procedure` to `connection_handle`, of `payload`
fn command_of(
    served: &Served,
    (procedure, connection_handle, payload): (&Procedure, &ConnectionHandle, Bytes),
) -> crate::router::server::Call {
    let mut options = options_of(Duration::from_secs(1));

    options.connection_handle = Some(Arc::clone(connection_handle));

    served
        .router
        .request(
            payload,
            (
                ServerRequest {
                    procedure: procedure.address(),
                    maximum_payload_bytes: procedure.maximum_payload_bytes,
                    options,
                    series: None,
                    refusal: None,
                },
                CallHooks::default(),
            ),
        )
        .expect("a command")
}

fn kinds_of(
    served: &Served,
    connection_handle: &ConnectionHandle,
) -> Vec<(EnvelopeKind, u32, Option<u16>)> {
    served
        .transport
        .envelopes(connection_handle)
        .iter()
        .map(|envelope| {
            let code = match envelope {
                Envelope::Failure { failure, .. } => Some(failure.code.get()),
                Envelope::Request { .. }
                | Envelope::Result { .. }
                | Envelope::Notification { .. }
                | Envelope::Chunk { .. }
                | Envelope::Credit { .. }
                | Envelope::Cancel { .. } => None,
            };

            (envelope.kind(), envelope.call_id(), code)
        })
        .collect()
}

// echo answered with its payload, every request it was handed kept
fn answering(served: &Served, procedure: &Procedure) -> Arc<Mutex<Vec<RequestHeader>>> {
    let handed: Arc<Mutex<Vec<RequestHeader>>> = Arc::default();
    let keeping = Arc::clone(&handed);

    served
        .services
        .get_request_resolver(procedure, ResolverDependencies::of(RawCodec, RawCodec))
        .expect("echo resolved")
        .on(Arc::new(move |request, response: Response<RawCodec>| {
            locked(&keeping).push(request.header.clone());

            response.result(request.payload)
        }))
        .expect("echo registered");

    handed
}

// spec 10.4
#[tokio::test]
async fn cancels_a_call_waiting_once_throwing_and_reserving_its_call_id_on_its_connection_alone() {
    let served = Served::new(&RouterServerOptions::default());

    served.transport.open(&first(), true);
    served.transport.open(&second(), true);

    let asked = command_of(
        &served,
        (&command(None), &first(), Bytes::from_static(&[1])),
    );

    served.settle().await;

    for _ in 0..2 {
        served
            .router
            .owner()
            .run(|state| {
                crate::router::requester::cancel(
                    state,
                    (
                        &CallAddress {
                            connection_handle: first(),
                            call_id: 2,
                        },
                        Some(Duration::from_secs(5)),
                    ),
                );
            })
            .await
            .expect("cancelled on its owner");
    }

    served.settle().await;

    assert!(
        matches!(answered(asked).await, Err(CallError::Cancelled)),
        "cancelled"
    );
    assert_eq!(
        kinds_of(&served, &first())
            .iter()
            .filter(|(kind, _, _)| *kind == EnvelopeKind::Cancel)
            .count(),
        1,
        "one cancel"
    );

    served.transport.deliver(&result_of(2, None), &first());
    served.settle().await;

    assert_eq!(
        served.reported(),
        Vec::<String>::new(),
        "reserved on its connection"
    );

    served.transport.deliver(&result_of(2, None), &second());
    served.settle().await;

    assert_eq!(
        served.reported(),
        ["CALL_UNKNOWN second"],
        "on its connection alone"
    );
}

// spec 12.3.2
#[tokio::test]
async fn holds_a_procedure_s_payloads_to_its_own_limit_within_the_router_s_both_ways_once_admitted()
{
    let served = Served::new(&RouterServerOptions::default());
    let small = Procedure {
        maximum_payload_bytes: Some(8),
        ..echo()
    };
    let refusing = Procedure {
        id: 7,
        name: "refusing".to_owned(),
        ..small.clone()
    };
    let handed: Arc<Mutex<Vec<RequestHeader>>> = Arc::default();
    let answers: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let (keeping, telling) = (Arc::clone(&handed), Arc::clone(&answers));

    served.transport.open(&first(), true);

    // the one request admitted whole is answered past the procedure's limit, at the core, as the
    // other sides' twins answer it: the manager answers PROCEDURE_FAILED for an answer that does
    // not go, which its own tests hold
    served
        .router
        .register_resolver((
            &small,
            Handler {
                resolve: Arc::new(move |props: ResolverProps| {
                    let (keeping, telling) = (Arc::clone(&keeping), Arc::clone(&telling));

                    Box::pin(async move {
                        locked(&keeping).push(props.header.clone());

                        let outcome = props
                            .answerer
                            .respond(RouterAnswer::Result(Bytes::from(vec![0; 9])))
                            .await;

                        locked(&telling).push(outcome.err().map(|error| error.to_string()));

                        Ok(())
                    })
                }),
                admit: None,
                maximum_payload_bytes: Some(8),
                forwards_credentials: false,
                notifies: false,
            },
        ))
        .expect("echo registered");
    served
        .router
        .register_resolver((
            &refusing,
            Handler {
                resolve: Arc::new(|_props: ResolverProps| Box::pin(async { Ok(()) })),
                admit: Some(
                    BeforeRequest::new(|_request| false, None).admission(RouterSide::Server),
                ),
                maximum_payload_bytes: Some(8),
                forwards_credentials: false,
                notifies: false,
            },
        ))
        .expect("refusing registered");

    // sent: past the procedure's limit, nothing goes
    let small_command = Procedure {
        kind: Some(ProcedureKind::Command),
        ..small.clone()
    };
    let refused = answered(command_of(
        &served,
        (&small_command, &first(), Bytes::from(vec![0; 9])),
    ))
    .await;

    assert!(
        matches!(&refused, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get() && failure.detail() == "a payload is 8 bytes at most, not 9"),
        "refused as it is sent: {refused:?}"
    );

    // received: whole, or as a transfer on its total; admitted first
    let header_of = |call_id: u32| super::server::header_of((call_id, &small));

    for envelope in [
        Envelope::Request {
            header: header_of(1),
            payload: Bytes::from(vec![0; 9]),
        },
        Envelope::Request {
            header: RequestHeader {
                total: Some(9),
                ..header_of(3)
            },
            payload: Bytes::from_static(&[1]),
        },
        Envelope::Request {
            header: RequestHeader {
                procedure_id: 7,
                ..header_of(5)
            },
            payload: Bytes::from(vec![0; 9]),
        },
        Envelope::Request {
            header: header_of(7),
            payload: Bytes::from(vec![0; 8]),
        },
    ] {
        served.transport.deliver(&envelope, &first());
        served.settle().await;
    }

    // answered: past the procedure's limit, nothing goes
    assert!(
        matches!(locked(&answers).as_slice(), [Some(error)] if error.contains("PAYLOAD_TOO_LARGE") || error.contains("8 bytes at most")),
        "its answer refused: {:?}",
        locked(&answers)
    );

    // a result's transfer past the procedure's limit ends its call
    let asking = command_of(&served, (&small_command, &first(), Bytes::from(vec![0; 8])));

    served.settle().await;

    let call_id = kinds_of(&served, &first())
        .iter()
        .rev()
        .find(|(kind, _, _)| *kind == EnvelopeKind::Request)
        .map_or(0, |(_, call_id, _)| *call_id);

    served.transport.deliver(
        &Envelope::Result {
            header: ResultHeader {
                call_id,
                total: Some(9),
                credential: None,
            },
            payload: Bytes::from_static(&[1]),
        },
        &first(),
    );
    served.settle().await;

    let ended = answered(asking).await;

    assert!(
        matches!(&ended, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get() && failure.detail() == "a payload is 8 bytes at most, not 9"),
        "its call ended: {ended:?}"
    );
    assert_eq!(
        locked(&handed)
            .iter()
            .map(|header| header.call_id)
            .collect::<Vec<_>>(),
        [7],
        "the one within its limit handed on"
    );

    let payload_too_large = Some(ProtocolCode::PAYLOAD_TOO_LARGE.get().get());

    assert_eq!(
        kinds_of(&served, &first()),
        [
            (EnvelopeKind::Failure, 1, payload_too_large),
            (EnvelopeKind::Failure, 3, payload_too_large),
            (
                EnvelopeKind::Failure,
                5,
                Some(ProtocolCode::ACCESS_DENIED.get().get())
            ),
            (EnvelopeKind::Request, call_id, None),
            (EnvelopeKind::Cancel, call_id, None),
        ],
        "each refused, and the call ended cancelled"
    );
    assert_eq!(served.reported(), Vec::<String>::new(), "nothing reported");
}

// a transfer's limits: an envelope of 64 bytes at most, a window of two
fn chunked() -> RouterLimitsOptions {
    RouterLimitsOptions {
        chunk_bytes: Some(64),
        maximum_envelope_bytes: Some(64),
        window_bytes: Some(128),
        ..RouterLimitsOptions::default()
    }
}

// spec 12.10
#[tokio::test]
async fn ends_the_transfers_it_sends_on_a_connection_that_goes_and_on_a_router_disposed_sending_nothing_more()
 {
    let credit = Envelope::Credit {
        header: CreditHeader {
            call_id: 1,
            credit_end: 300,
            paced: false,
        },
    };

    for is_disposed in [false, true] {
        let options = RouterClientOptions {
            limits: Some(chunked()),
            ..RouterClientOptions::default()
        };

        let scripted = Scripted::with(&options);
        let asked = scripted
            .router
            .request(
                Bytes::from(vec![7; 300]),
                (
                    client_request_of((None, Duration::from_secs(5))),
                    CallHooks::default(),
                ),
            )
            .expect("a call");

        scripted.settle().await;

        let before = scripted.transport.sent().len();

        if is_disposed {
            scripted.router.dispose().await;
        } else {
            scripted.transport.close_connection();
        }

        scripted.settle().await;

        assert!(
            matches!(answered(asked).await, Err(CallError::Disconnected(_))),
            "its call ended as its connection went: disposed {is_disposed}"
        );

        scripted.transport.deliver(&credit);
        scripted.settle().await;

        assert_eq!(
            scripted.transport.sent().len(),
            before,
            "nothing more sent: disposed {is_disposed}"
        );
    }
}

// debugging 5.2
#[tokio::test]
async fn reads_traces_then_dispatches_what_comes_in_and_reports_what_does_not_read_untraced() {
    let served = Served::new(&RouterServerOptions::default());
    let traced: Arc<Mutex<Vec<(DebugDirection, TracedEnvelope)>>> = Arc::default();
    let tracing = Arc::clone(&traced);

    served.transport.open(&first(), true);

    let handed = answering(&served, &echo());

    served.router.on_debug(Arc::new(
        move |direction: DebugDirection, envelope: &TracedEnvelope| {
            locked(&tracing).push((direction, envelope.clone()));
        },
    ));

    // what does not read is reported, never traced
    served.transport.deliver_message(
        &TransportMessage {
            data: Bytes::from_static(&[0xA1, 0x10]),
            ..TransportMessage::default()
        },
        &first(),
    );
    served.settle().await;

    assert_eq!(served.reported().len(), 1, "reported");
    assert!(locked(&traced).is_empty(), "not traced");

    let request = request_of((1, &echo(), "\u{7}"));

    served.transport.deliver(&request, &first());
    served.settle().await;

    let rx: Vec<TracedEnvelope> = locked(&traced)
        .iter()
        .filter(|(direction, _)| *direction == DebugDirection::Rx)
        .map(|(_, envelope)| envelope.clone())
        .collect();

    assert_eq!(
        rx,
        [TracedEnvelope {
            connection_handle: first(),
            header: request.header(),
            credential_scheme: None,
        }],
        "read, then traced"
    );
    assert_eq!(
        locked(&handed)
            .iter()
            .map(|header| header.call_id)
            .collect::<Vec<_>>(),
        [1],
        "then dispatched"
    );
}

fn counted_resolver(registry: &MetricsRegistry) -> Served {
    let served = Served::new(&counted_options(registry));

    served.transport.open(&first(), true);
    answering(&served, &echo());

    served
}

// debugging 9.2, 9.4.21
#[tokio::test]
async fn count_a_call_answered_whose_answer_its_transport_throws_on_as_an_error_and_one_its_transport_rejects_once_it_has_it_as_answered()
 {
    let registry = registry();
    let served = counted_resolver(&registry);

    // thrown as it is handed the answer: nothing went; rejected once it had it: it went
    served.transport.send_as((
        &first(),
        Sending::Thrown("this transport throws".to_owned()),
    ));
    served
        .transport
        .deliver(&request_of((1, &echo(), "a")), &first());
    served.settle().await;
    served.transport.send_as((
        &first(),
        Sending::Rejected("this transport rejects".to_owned()),
    ));
    served
        .transport
        .deliver(&request_of((3, &echo(), "a")), &first());
    served.settle().await;

    assert_eq!(
        super::metrics::counts_of(&registry)
            .into_iter()
            .filter(|line| !line.contains("_bucket{"))
            .collect::<Vec<_>>(),
        [
            "bead_server_call_duration_seconds_count{service=\"2\",procedure=\"echo\",type=\"request\"} 2",
            "bead_server_call_handled_total{service=\"2\",procedure=\"echo\",type=\"request\",outcome=\"result\"} 1",
            "bead_server_call_handled_total{service=\"2\",procedure=\"echo\",type=\"request\",outcome=\"error\"} 1",
            "bead_server_call_started_total{service=\"2\",procedure=\"echo\",type=\"request\"} 2",
        ],
        "one an error, one answered"
    );
}

// a call made and a call answered, on a client's router and a server's given `given`: the readings
// each clock took, of the wall and of the monotonic
async fn readings_of(given: Option<&MetricsRegistry>) -> [(usize, usize); 2] {
    let options = RouterClientOptions {
        metrics_registry: given.cloned(),
        ..RouterClientOptions::default()
    };

    let client = Scripted::with(&options);
    let server = Served::new(&RouterServerOptions {
        metrics_registry: given.cloned(),
        ..RouterServerOptions::default()
    });

    server.transport.open(&first(), true);
    answering(&server, &echo());
    client.settle().await;
    server.settle().await;

    let (client_before, server_before) = (client.clock.readings(), server.clock.readings());
    let series = client
        .router
        .declare_requester(&echo())
        .expect("echo declared");
    let made = client
        .router
        .request(
            Bytes::from_static(&[1]),
            (
                ClientRequest {
                    series,
                    ..client_request_of((None, crate::duration::NEVER))
                },
                CallHooks::default(),
            ),
        )
        .expect("a call");

    client.settle().await;
    client.transport.deliver(&result_of(1, None));
    server
        .transport
        .deliver(&request_of((1, &echo(), "a")), &first());
    answered(made).await.expect("answered");
    client.settle().await;
    server.settle().await;

    assert_eq!(
        server.transport.envelopes(&first()).len(),
        1,
        "answered once"
    );

    let (client_after, server_after) = (client.clock.readings(), server.clock.readings());

    [
        (
            client_after.0.saturating_sub(client_before.0),
            client_after.1.saturating_sub(client_before.1),
        ),
        (
            server_after.0.saturating_sub(server_before.0),
            server_after.1.saturating_sub(server_before.1),
        ),
    ]
}

// debugging 3.3
#[tokio::test]
async fn reads_the_monotonic_clock_twice_more_for_a_counted_call_than_for_one_counted_nothing_once_at_each_of_its_gates_and_the_wall_clock_never()
 {
    let registry = registry();
    let uncounted = readings_of(None).await;
    let counted = readings_of(Some(&registry)).await;

    // the monotonic clock alone, twice a call, and never the wall clock
    assert_eq!(
        uncounted,
        [(0, 0), (0, 0)],
        "a call counted nothing reads no clock"
    );
    assert_eq!(
        counted,
        [(0, 2), (0, 2)],
        "a counted call reads the monotonic clock twice"
    );
}

// debugging 9.6.3, 9.6.4
#[tokio::test]
async fn counts_a_call_made_refused_before_it_goes_no_call_id_free_or_payload_too_large_as_started_and_ended_in_the_turn_it_started_and_a_programmer_s_error_or_an_aborted_signal_as_nothing()
 {
    let registry = registry();
    let options = RouterClientOptions {
        metrics_registry: Some(registry.clone()),
        ..RouterClientOptions::default()
    };

    let scripted = Scripted::with(&options);
    let series = scripted
        .router
        .declare_requester(&echo())
        .expect("echo declared");
    let call = |(procedure, payload): (Procedure, usize)| {
        scripted
            .router
            .request(
                Bytes::from(vec![0; payload]),
                (
                    ClientRequest {
                        procedure,
                        series: series.clone(),
                        ..client_request_of((None, crate::duration::NEVER))
                    },
                    CallHooks::default(),
                ),
            )
            .expect("a call")
    };

    // this side draws two call ids, 1 and 3, alone
    scripted
        .router
        .owner()
        .run(|state| {
            state.core().pending = PendingCalls::new(RouterSide::Client, Some(3));
        })
        .await
        .expect("its call ids bounded");

    // past its procedure's limit
    let too_large = call((
        Procedure {
            maximum_payload_bytes: Some(4),
            ..echo()
        },
        8,
    ));

    assert!(
        matches!(answered(too_large).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get()),
        "PAYLOAD_TOO_LARGE"
    );

    // two calls under way hold the two call ids this side draws: a third finds none free
    let _first = call((echo(), 1));
    let _second = call((echo(), 1));
    let third = call((echo(), 1));

    assert!(
        matches!(answered(third).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::CAPACITY_EXCEEDED.get()),
        "CAPACITY_EXCEEDED"
    );
    scripted.settle().await;

    let made_of = |rest: &str| format!("bead_client_call_{rest}");
    let counts = |registry: &MetricsRegistry| -> Vec<String> {
        let mut lines: Vec<String> = super::metrics::counts_of(registry)
            .into_iter()
            .map(|line| {
                line.replace("service=\"2\",procedure=\"echo\",type=\"request\"", "")
                    .replace("{,", "{")
            })
            .collect();

        lines.sort();
        lines
    };

    // each refusal ended in the turn it started, the clock unmoved: in the bucket of 0
    assert_eq!(
        counts(&registry),
        [
            made_of("duration_seconds_bucket{le=\"0.0\"} 2"),
            made_of("duration_seconds_count{} 2"),
            made_of("handled_total{outcome=\"failure\",code=\"CAPACITY_EXCEEDED\"} 1"),
            made_of("handled_total{outcome=\"failure\",code=\"PAYLOAD_TOO_LARGE\"} 1"),
            made_of("started_total{} 4"),
        ],
        "each refusal counted"
    );

    // a programmer's error, and a signal aborted already: neither is a call
    let aborted = CancellationToken::new();

    aborted.cancel();

    let mut jwt = client_request_of((None, Duration::from_secs(1)));

    jwt.options.credential = Some(crate::router::types::RequestCredential::Jwt(String::new()));

    assert!(
        scripted
            .router
            .request(Bytes::new(), (jwt, CallHooks::default()))
            .is_err(),
        "a JWT of no token refused"
    );

    let mut cancelled = client_request_of((None, Duration::from_secs(1)));

    cancelled.options.signal = Some(aborted);
    cancelled.series = series.clone();

    let cancelled = scripted
        .router
        .request(Bytes::new(), (cancelled, CallHooks::default()))
        .expect("a call aborted already");

    assert!(
        matches!(answered(cancelled).await, Err(CallError::Cancelled)),
        "cancelled"
    );
    scripted.settle().await;

    assert!(
        counts(&registry).contains(&made_of("started_total{} 4")),
        "nothing more started: {:?}",
        counts(&registry)
    );
}

// a server's resolver that calls its caller back and awaits the answer, which never comes, as the
// caller's connection closes: what it heard, in order, and what was counted
#[tokio::test]
async fn detaches_calls_before_settling_an_incoming_resolver_awaiting_an_outgoing_call_and_counts_its_incoming_close_once()
 {
    use crate::client::ClientOptions;
    use crate::managers::service::{RequestDependencies, RequestOptions};
    use crate::metrics::MetricsRegistryOptions;
    use crate::payloads::JsonCodec;
    use crate::server::ServerOptions;
    use crate::testing::pair::{Pair, PairOptions};
    use crate::transport::DisconnectOptions;

    let registry = MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let options = PairOptions {
        server: ServerOptions {
            metrics_registry: Some(registry.clone()),
            ..ServerOptions::default()
        },
        client: ClientOptions::default(),
    };
    let pair = Pair::connected((crate::testing::instants::new_year(), options))
        .await
        .expect("a pair connected");
    let hold = Procedure {
        id: 2,
        name: "hold".to_owned(),
        kind: Some(ProcedureKind::Command),
        ..echo()
    };

    // the client takes the command and never answers it
    pair.client
        .services()
        .get_request_resolver(&hold, ResolverDependencies::of(JsonCodec, JsonCodec))
        .expect("hold resolved")
        .on(Arc::new(|_request, _response: Response<JsonCodec>| {
            Box::pin(core::future::pending())
        }))
        .expect("hold registered");

    let holding = pair
        .server
        .services()
        .get_request(&hold, RequestDependencies::of(JsonCodec, JsonCodec))
        .expect("hold asked");
    let heard: Arc<Mutex<Vec<String>>> = Arc::default();
    let hearing = Arc::clone(&heard);
    let connection_handle = Arc::clone(&pair.connection_handle);

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(JsonCodec, JsonCodec))
        .expect("echo resolved")
        .on(Arc::new(move |request, response: Response<JsonCodec>| {
            let holding = holding.clone();
            let hearing = Arc::clone(&hearing);
            let connection_handle = Arc::clone(&connection_handle);

            Box::pin(async move {
                let called = holding.call(
                    request.payload.clone(),
                    RequestOptions {
                        connection_handle: Some(connection_handle),
                        ..RequestOptions::default()
                    },
                );
                let rejected = match called {
                    Ok(call) => call.await,
                    Err(refused) => Err(CallError::Other(Arc::new(refused))),
                };

                // * as it hears its call's rejection, its own signal is aborted already
                locked(&hearing).push(format!(
                    "rejected {} with its signal aborted {}",
                    matches!(rejected, Err(CallError::Disconnected(_))),
                    request.signal.token().is_cancelled()
                ));

                // its answer goes nowhere: its connection is gone
                response.result(request.payload).await.ok();

                Ok(())
            })
        }))
        .expect("echo registered");

    let calling = pair
        .client
        .services()
        .get_request(&echo(), RequestDependencies::of(JsonCodec, JsonCodec))
        .expect("echo asked")
        .call(serde_json::json!("hello"), RequestOptions::default())
        .expect("echo called");

    pair.settle().await;

    let before = pair.server.router().gauges().await;

    assert_eq!(
        (
            before.counts.get("answeringCalls").copied(),
            before.counts.get("pendingCalls").copied()
        ),
        (Some(1), Some(1)),
        "echo answering, hold waiting"
    );

    pair.transport
        .disconnect(DisconnectOptions::default())
        .expect("disconnected");
    pair.settle().await;

    assert!(
        matches!(calling.await, Err(CallError::Disconnected(_))),
        "the client's call ended with its connection"
    );
    assert_eq!(
        *locked(&heard),
        ["rejected true with its signal aborted true"],
        "its call rejected as its connection went, its signal aborted by then"
    );

    let after = pair.server.router().gauges().await;

    assert_eq!(
        (
            after.counts.get("answeringCalls").copied(),
            after.counts.get("pendingCalls").copied()
        ),
        (Some(0), Some(0)),
        "both detached"
    );

    let closed: Vec<String> = registry
        .exposition()
        .text
        .split('\n')
        .filter(|line| {
            line.starts_with("bead_server_call_handled_total{")
                && line.contains("outcome=\"closed\"")
                && !line.ends_with(" 0")
        })
        .map(str::to_owned)
        .collect();

    assert_eq!(
        closed,
        [
            "bead_server_call_handled_total{service=\"2\",procedure=\"echo\",type=\"request\",outcome=\"closed\"} 1",
        ],
        "its incoming call counted closed once"
    );
}
