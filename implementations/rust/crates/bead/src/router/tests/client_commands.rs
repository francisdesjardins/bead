//! Commands received at the client: limits, dispatch, cancellation and resolver failures.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{Scripted, cancel_of, january_first, locked, request_header_of};
use crate::clock::SharedClock;
use crate::constants::{EnvelopeKind, ProtocolCode};
use crate::envelope::{Envelope, RequestHeader};
use crate::errors::ResolverError;
use crate::router::client::{RouterClient, RouterClientOptions};
use crate::router::core::{Handler, RequestResolverProps, ResolveFn};
use crate::router::types::{RouterAnswer, RouterError, RouterLimitsOptions, TransportMessage};
use crate::testing::SteppingClock;
use crate::testing::scripted::{ScriptedClient, Sending};
use crate::transport::{ClientListener, ReadyState, RouterClientTransport, Sent};

// A scripted transport whose disconnect panics, each one counted; the rest is the script's.
#[derive(Debug)]
struct Unclosable {
    transport: Arc<ScriptedClient>,
    disconnects: Arc<AtomicUsize>,
}

impl RouterClientTransport for Unclosable {
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError> {
        self.transport.send(message)
    }

    fn listen(&self, listener: Arc<dyn ClientListener>) {
        self.transport.listen(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ClientListener>) {
        self.transport.unlisten(listener);
    }

    fn pause(&self) {
        self.transport.pause();
    }

    fn disconnect(&self) {
        self.disconnects.fetch_add(1, Ordering::SeqCst);

        panic!("the transport would not disconnect");
    }

    fn resume(&self) {
        self.transport.resume();
    }

    fn clock(&self) -> Option<SharedClock> {
        self.transport.clock()
    }

    fn ready_state(&self) -> ReadyState {
        self.transport.ready_state()
    }
}

// a client router over a transport whose disconnect panics, and the count of its disconnects
fn unclosable(options: &RouterClientOptions) -> (Scripted, Arc<AtomicUsize>) {
    let clock = SteppingClock::new(january_first());
    let transport = ScriptedClient::new(Arc::<SteppingClock>::clone(&clock));
    let disconnects = Arc::new(AtomicUsize::new(0));
    let router = RouterClient::new(
        Arc::new(Unclosable {
            transport: Arc::clone(&transport),
            disconnects: Arc::clone(&disconnects),
        }),
        options,
    )
    .expect("a router over the transport");
    let errors = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&errors);

    router.on_error(Arc::new(move |error| {
        locked(&hearing).push(error.clone());
    }));

    (
        Scripted {
            clock,
            transport,
            router,
            errors,
        },
        disconnects,
    )
}

fn echo() -> crate::identity::Procedure {
    crate::identity::Procedure {
        procedure_kind: Some(crate::constants::ProcedureKind::Command),
        ..crate::testing::pair::echo()
    }
}

pub(super) fn handler(resolve: ResolveFn) -> Handler {
    Handler {
        resolve,
        admit: None,
        maximum_payload_bytes: None,
        forwards_credentials: false,
        notifies: false,
    }
}

pub(super) fn command(scripted: &Scripted, header: RequestHeader) {
    scripted.transport.deliver(&Envelope::Request {
        header,
        payload: Bytes::from_static(&[1]),
    });
}

pub(super) fn failures(scripted: &Scripted) -> Vec<(u32, u16, String)> {
    scripted
        .transport
        .envelopes()
        .iter()
        .filter_map(|envelope| {
            if let Envelope::Failure { header, failure } = envelope {
                Some((header.call_id, failure.code.get(), failure.detail.clone()))
            } else {
                None
            }
        })
        .collect()
}

#[tokio::test]
async fn cancelled_by_the_server_abort_their_resolvers_signal_and_are_answered_by_nothing() {
    let scripted = Scripted::new();
    let cancelled = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&cancelled);
    scripted
        .router
        .register_resolver((
            &echo(),
            handler(Arc::new(move |props| {
                let hearing = Arc::clone(&hearing);
                Box::pin(async move {
                    props.signal.token().cancelled().await;
                    assert_eq!(
                        props.signal.reason(),
                        Some(crate::router::types::SignalReason::Cancelled)
                    );
                    locked(&hearing).push(props.header.call_id);
                    props
                        .answerer
                        .respond(RouterAnswer::Result(Bytes::from_static(&[1])))
                        .await
                        .expect("a cancelled call answers nothing");
                    Err(ResolverError::other(std::io::Error::other("stopped")))
                })
            })),
        ))
        .expect("registered");
    command(&scripted, request_header_of(30));
    // its resolver handed it in a later turn, before its cancel comes
    scripted.settle().await;
    scripted.transport.deliver(&cancel_of(30));
    scripted.settle().await;
    assert_eq!(*locked(&cancelled), [30]);
    assert_eq!(scripted.transport.sent(), Vec::<TransportMessage>::new());
    assert_eq!(scripted.codes(), Vec::<String>::new());
}

#[tokio::test]
async fn answers_capacity_exceeded_a_command_past_the_calls_its_server_has_it_answer() {
    let scripted = Scripted::with(&RouterClientOptions {
        limits: Some(RouterLimitsOptions {
            maximum_answering_calls: Some(2),
            ..RouterLimitsOptions::default()
        }),
        ..RouterClientOptions::default()
    });
    let handed = Arc::new(Mutex::new(Vec::<RequestResolverProps>::new()));
    scripted
        .router
        .register_resolver((&echo(), handler(super::keeping((&handed, None)))))
        .expect("registered");
    for call_id in [30, 32, 34] {
        command(&scripted, request_header_of(call_id));
    }
    scripted.settle().await;
    assert_eq!(locked(&handed).len(), 2);
    assert_eq!(
        failures(&scripted)
            .iter()
            .map(|(id, code, _)| (*id, *code))
            .collect::<Vec<_>>(),
        [(34, ProtocolCode::CAPACITY_EXCEEDED.get().get())]
    );
    assert_eq!(scripted.transport.calls(), [(EnvelopeKind::Failure, 34)]);
    let answerer = Arc::clone(&locked(&handed)[0].answerer);
    answerer
        .respond(RouterAnswer::Result(Bytes::from_static(&[1])))
        .await
        .expect("answered");
    command(&scripted, request_header_of(36));
    scripted.settle().await;
    assert_eq!(locked(&handed).len(), 3);
    assert_eq!(scripted.codes(), Vec::<String>::new());
}

// spec 9.2; RFC 9113 §10.5
#[tokio::test]
async fn closes_a_connection_that_it_refused_twice_maximum_answering_calls_requests_in_a_row_past_the_resolvers_that_outlive_its_calls_nothing_settling_between_and_reports_it()
 {
    // what its disconnect panics is reported
    let (scripted, disconnects) = unclosable(&RouterClientOptions {
        limits: Some(RouterLimitsOptions {
            maximum_answering_calls: Some(1),
            ..RouterLimitsOptions::default()
        }),
        ..RouterClientOptions::default()
    });

    // deaf to its signal, it never settles
    scripted
        .router
        .register_resolver((
            &echo(),
            handler(Arc::new(|_props| Box::pin(core::future::pending()))),
        ))
        .expect("registered");

    // one whose resolver outlives its cancel, one open beside it: twice the bound
    command(&scripted, request_header_of(30));
    scripted.settle().await;
    scripted.transport.deliver(&cancel_of(30));
    command(&scripted, request_header_of(32));
    scripted.settle().await;
    command(&scripted, request_header_of(34));
    scripted.settle().await;

    assert_eq!(disconnects.load(Ordering::SeqCst), 0);
    assert_eq!(scripted.codes(), Vec::<String>::new());

    // * the second refusal in a row: reported, then its transport disconnected in a later turn
    command(&scripted, request_header_of(36));
    scripted.settle().await;

    assert_eq!(
        failures(&scripted),
        [
            (
                34,
                ProtocolCode::CAPACITY_EXCEEDED.get().get(),
                "the calls a connection answers and those its resolvers outlive are 2 at most"
                    .to_owned()
            ),
            (
                36,
                ProtocolCode::CAPACITY_EXCEEDED.get().get(),
                "the calls a connection answers and those its resolvers outlive are 2 at most"
                    .to_owned()
            )
        ]
    );
    assert_eq!(
        scripted.codes(),
        [
            "CAPACITY_EXCEEDED",
            "a transport panicked: the transport would not disconnect"
        ]
    );

    let detail = locked(&scripted.errors)
        .first()
        .and_then(|error| match error {
            RouterError::Failure(failure) => Some(failure.detail().to_owned()),
            RouterError::ReadyState(_) | RouterError::Disconnected(_) | RouterError::Other(_) => {
                None
            }
        });

    assert_eq!(
        detail.as_deref(),
        Some(
            "the calls a connection answers and those its resolvers outlive stayed at 2 for 2 requests: the connection is closed"
        )
    );
    assert_eq!(disconnects.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn for_a_service_a_procedure_or_a_destination_it_does_not_know_are_refused_with_the_clients_failures()
 {
    let scripted = Scripted::new();
    command(&scripted, request_header_of(2));
    scripted.settle().await;
    let mut procedure = echo();
    procedure.procedure_id = 9;
    scripted
        .router
        .register_resolver((
            &procedure,
            handler(Arc::new(|_| Box::pin(async { Ok(()) }))),
        ))
        .expect("another procedure registered");
    command(&scripted, request_header_of(4));
    command(
        &scripted,
        RequestHeader {
            destination_id: Some(5),
            ..request_header_of(6)
        },
    );
    scripted.settle().await;
    assert_eq!(
        failures(&scripted)
            .iter()
            .map(|(id, code, _)| (*id, *code))
            .collect::<Vec<_>>(),
        [
            (2, ProtocolCode::SERVICE_UNKNOWN.get().get()),
            (4, ProtocolCode::PROCEDURE_UNKNOWN.get().get()),
            (6, ProtocolCode::DESTINATION_UNKNOWN.get().get())
        ]
    );
    assert_eq!(scripted.transport.sent().len(), 3);
}

#[tokio::test]
async fn refuses_a_second_resolver_for_one_procedure() {
    let scripted = Scripted::new();
    let handler = handler(Arc::new(|_| Box::pin(async { Ok(()) })));
    scripted
        .router
        .register_resolver((&echo(), handler.clone()))
        .expect("one resolver registered");
    scripted
        .router
        .register_resolver((&echo(), handler))
        .expect_err("a second resolver for one procedure");
    assert_eq!(scripted.transport.sent(), Vec::<TransportMessage>::new());
}

#[tokio::test]
async fn reports_a_resolver_that_rejects_and_an_answer_the_transport_cannot_send() {
    let scripted = Scripted::new();
    scripted
        .router
        .register_resolver((
            &echo(),
            handler(Arc::new(|_| {
                Box::pin(async {
                    Err(ResolverError::other(std::io::Error::other(
                        "resolver failed",
                    )))
                })
            })),
        ))
        .expect("registered");
    command(&scripted, request_header_of(2));
    scripted.settle().await;
    let refusal: Arc<dyn std::error::Error + Send + Sync> =
        Arc::new(std::io::Error::other("not open"));
    scripted
        .transport
        .send_as(Sending::Error(RouterError::Other(Arc::clone(&refusal))));
    command(&scripted, request_header_of(4));
    scripted.settle().await;
    command(
        &scripted,
        RequestHeader {
            service_id: 99,
            ..request_header_of(6)
        },
    );
    scripted.settle().await;
    assert_eq!(
        scripted.codes(),
        ["resolver failed", "resolver failed", "not open", "not open"]
    );
    for error in &locked(&scripted.errors)[2..] {
        assert!(matches!(error, RouterError::Other(error) if Arc::ptr_eq(error, &refusal)));
    }
    assert_eq!(
        failures(&scripted)
            .iter()
            .map(|(id, code, _)| (*id, *code))
            .collect::<Vec<_>>(),
        [
            (2, ProtocolCode::PROCEDURE_FAILED.get().get()),
            (4, ProtocolCode::PROCEDURE_FAILED.get().get()),
            (6, ProtocolCode::SERVICE_UNKNOWN.get().get())
        ]
    );
}

#[tokio::test]
async fn reports_a_resolver_that_throws_before_it_returns_and_keeps_taking_envelopes() {
    let scripted = Scripted::new();
    scripted
        .router
        .register_resolver((
            &echo(),
            handler(Arc::new(|_| {
                panic!("thrown at once");
            })),
        ))
        .expect("registered");
    command(&scripted, request_header_of(2));
    scripted.settle().await;
    scripted.transport.deliver_message(&TransportMessage {
        data: Bytes::from_static(&[0xa1, 0x17, 0, 2, 0, 0, 0, 2]),
        ..TransportMessage::default()
    });
    scripted.settle().await;
    assert_eq!(
        scripted.codes(),
        ["a resolver panicked: thrown at once", "KIND_UNSUPPORTED"]
    );
}

#[tokio::test]
async fn fails_a_command_to_a_connection_not_open() {
    use crate::managers::service::{CommandOptions, RequestDependencies};
    use crate::payloads::TextCodec;
    use crate::testing::pair::{Pair, PairOptions};

    let pair = Pair::connected(january_first(), &PairOptions::default())
        .await
        .expect("connected");
    let command = pair
        .server
        .services()
        .get_command(&echo(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("command declared");
    let missing = command
        .call(
            "now".to_owned(),
            &CommandOptions {
                timeout: Some(super::TIMEOUT),
                ..CommandOptions::new(Arc::from("type=WS;ip=127.0.0.1;port=1;ordinal=1"))
            },
        )
        .expect("a command names a connection");
    assert!(matches!(
        crate::testing::patience(super::PATIENCE, missing)
            .await
            .expect("settled"),
        Err(crate::errors::CallError::Disconnected(_))
    ));
    pair.client.dispose().await;
    pair.server.dispose().await.expect("disposed");
}
