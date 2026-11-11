//! The server facade's session announcements and subscription endings, over the interop API.

use core::time::Duration;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bead::internal::{Envelope, ReadEnvelopeOptions, read_envelope, write_envelope};
use bead::testing::SteppingClock;
use bead::testing::scripted::{ScriptedServer, handle_of};
use bead::{
    BoxFuture, ConnectionHandle, Credential, FailureHeader, NotificationHeader, PayloadCodec,
    ProtocolCode, RequestHeader, ResultHeader, RouterError, RouterSide, Sent, Server,
    ServerListener, ServerOptions, ServerTransport, SharedClock, TransportMessage,
};
use serde_json::{Value, json};

use crate::{InteropProcedures, OfferedInterop, interop_procedures, offer_interop};

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// A send refused before delivery reaches no peer, whether its refusal is immediate or awaited.
#[derive(Debug)]
struct Wire {
    transport: Arc<ScriptedServer>,
    failing: Mutex<Option<bool>>,
}

impl ServerTransport for Wire {
    fn send(
        &self,
        message: TransportMessage,
        handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        let failing = locked(&self.failing).take();
        if let Some(immediate) = failing {
            let error = RouterError::Other(Arc::new(std::io::Error::other("a send refused")));
            if immediate {
                return Err(error);
            }
            return Ok(Sent::Later(Box::pin(async move { Err(error) })));
        }
        self.transport.send(message, handle)
    }

    fn close(&self, handle: &ConnectionHandle) -> BoxFuture<bool> {
        self.transport.close(handle)
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        self.transport.listen(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        self.transport.unlisten(listener);
    }

    fn pause(&self, handle: &ConnectionHandle) {
        self.transport.pause(handle);
    }

    fn resume(&self, handle: &ConnectionHandle) {
        self.transport.resume(handle);
    }

    fn clock(&self) -> Option<SharedClock> {
        self.transport.clock()
    }

    fn stop(&self) -> BoxFuture<Result<(), RouterError>> {
        self.transport.stop()
    }
}

struct Fixture {
    clock: Arc<SteppingClock>,
    wire: Arc<Wire>,
    server: Server,
    procedures: InteropProcedures,
    handle: ConnectionHandle,
    _offered: OfferedInterop,
}

impl Fixture {
    async fn new(timeout: Option<Duration>) -> Self {
        let clock = SteppingClock::new(bead::testing::instants::new_year());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let wire = Arc::new(Wire {
            transport: ScriptedServer::new(shared),
            failing: Mutex::default(),
        });
        let transport: Arc<dyn ServerTransport> = Arc::<Wire>::clone(&wire);
        let mut options = ServerOptions::default();
        options.connection_inactivity_timeout = timeout;
        let server = Server::new(transport, &options).expect("a server");
        let offered = offer_interop(&server).expect("the interop offered");
        let handle = handle_of(1);
        wire.transport.open(&handle, true);
        clock.settle().await;
        Self {
            clock,
            wire,
            server,
            procedures: interop_procedures(None).expect("the interop descriptors"),
            handle,
            _offered: offered,
        }
    }

    async fn ask(&self, (id, name, subscribes): (u32, &str, bool), payload: Value) {
        let procedure = self
            .procedures
            .all()
            .iter()
            .find(|descriptor| descriptor.procedure().procedure_name == name)
            .expect("the procedure")
            .procedure()
            .clone();
        let envelope = Envelope::Request {
            header: RequestHeader {
                call_id: id,
                service_id: procedure.service_id,
                procedure_id: procedure.procedure_id,
                opens_subscription: subscribes,
                paced: false,
                destination_id: None,
                credential: None,
                total: None,
            },
            payload: bead::JsonCodec.encode(&payload).expect("JSON bytes"),
        };
        let bytes = write_envelope(&envelope, 1_024).expect("an envelope");
        let mut message = TransportMessage::default();
        message.data = bytes;
        self.wire.transport.deliver_message(&message, &self.handle);
        self.clock.settle().await;
    }

    fn envelopes(&self) -> Vec<Envelope> {
        self.wire
            .transport
            .sent()
            .iter()
            .map(|(_, message)| {
                read_envelope(
                    &message.data,
                    RouterSide::Client,
                    &ReadEnvelopeOptions::default(),
                )
                .expect("a delivered envelope")
                .expect("a known kind")
            })
            .collect()
    }
}

#[tokio::test]
async fn announces_again_a_session_the_answer_that_carried_it_did_not_deliver() {
    for immediate in [true, false] {
        let fixture = Fixture::new(None).await;
        let sessions = fixture.server.sessions();
        let stored = sessions
            .set(sessions.create(Arc::clone(&fixture.handle)))
            .expect("a valid session")
            .await
            .expect("stored");
        *locked(&fixture.wire.failing) = Some(immediate);
        fixture.ask((1, "echo", false), Value::Null).await;
        assert_eq!(fixture.envelopes(), []);
        fixture.ask((3, "echo", false), Value::Null).await;
        let sent = fixture.envelopes();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].header(),
            bead::EnvelopeHeader::Result(ResultHeader {
                call_id: 3,
                credential: stored.session_token.map(Credential::Opaque),
                total: None,
            })
        );
        fixture.server.dispose().await.expect("disposed");
    }
}

#[tokio::test]
async fn forgets_what_a_connection_was_told_once_it_closed() {
    let fixture = Fixture::new(None).await;
    fixture
        .ask((1, "login", false), json!({"name": "ada"}))
        .await;
    let sent = fixture.envelopes();
    assert_eq!(sent.len(), 1);
    assert!(matches!(&sent[0], Envelope::Result { header, .. } if header.credential.is_some()));
    fixture.wire.transport.close_connection(&fixture.handle);
    fixture.wire.transport.open(&fixture.handle, true);
    fixture.ask((3, "echo", false), Value::Null).await;
    assert_eq!(
        fixture.envelopes()[1].header(),
        bead::EnvelopeHeader::Result(ResultHeader {
            call_id: 3,
            credential: None,
            total: None,
        })
    );
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn ends_a_session_past_its_timeout_with_its_subscriptions_and_keeps_its_connection_for_the_servers_own_timeout_counted_from_its_end()
 {
    let fixture = Fixture::new(Some(Duration::from_secs(3))).await;
    let sessions = fixture.server.sessions();
    let mut session = sessions.create(Arc::clone(&fixture.handle));
    session.connection_inactivity_timeout = Some(Duration::from_secs(5));
    session.session_inactivity_timeout = Some(Duration::from_secs(1));
    let stored = sessions.set(session).expect("valid").await.expect("stored");
    fixture.ask((1, "ticks", true), Value::Null).await;
    assert_eq!(
        fixture.envelopes()[0].header(),
        bead::EnvelopeHeader::Result(ResultHeader {
            call_id: 1,
            credential: stored.session_token.map(Credential::Opaque),
            total: None,
        })
    );
    fixture.clock.advance(Duration::from_secs(1)).await;
    assert!(!sessions.has(Arc::clone(&fixture.handle)).await);
    let sent = fixture.envelopes();
    assert_eq!(
        sent[1].header(),
        bead::EnvelopeHeader::Failure(FailureHeader {
            call_id: 1,
            credential: Some(Credential::None),
        })
    );
    assert!(
        matches!(&sent[1], Envelope::Failure { failure, .. } if failure.code == ProtocolCode::SESSION_REQUIRED.get())
    );
    assert_eq!(fixture.wire.transport.closed(), []);
    fixture.clock.advance(Duration::from_millis(2_999)).await;
    assert_eq!(fixture.wire.transport.closed(), []);
    fixture.clock.advance(Duration::from_millis(1)).await;
    assert_eq!(
        fixture.wire.transport.closed(),
        [Arc::clone(&fixture.handle)]
    );
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn an_ordinary_request_to_the_procedure_of_a_subscription_held_moves_nothing_notify_still_reaches_it()
 {
    let fixture = Fixture::new(None).await;
    let errors = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&errors);
    fixture.server.router().on_error(Arc::new(move |error, _| {
        locked(&hearing).push(error.clone());
    }));
    fixture.ask((1, "ticks", true), Value::Null).await;
    fixture.ask((3, "ticks", false), Value::Null).await;
    fixture.ask((5, "ticks", false), json!({"hold": 1})).await;
    fixture.ask((7, "tick", false), json!({"value": 1})).await;
    let sent = fixture.envelopes();
    assert_eq!(sent.len(), 5);
    assert_eq!(
        sent.iter().map(Envelope::header).collect::<Vec<_>>(),
        [
            bead::EnvelopeHeader::Result(ResultHeader {
                call_id: 1,
                credential: None,
                total: None
            }),
            bead::EnvelopeHeader::Result(ResultHeader {
                call_id: 3,
                credential: None,
                total: None
            }),
            bead::EnvelopeHeader::Failure(FailureHeader {
                call_id: 5,
                credential: None
            }),
            bead::EnvelopeHeader::Notification(NotificationHeader { call_id: 1 }),
            bead::EnvelopeHeader::Result(ResultHeader {
                call_id: 7,
                credential: None,
                total: None
            }),
        ]
    );
    assert!(
        matches!(&sent[2], Envelope::Failure { failure, .. } if failure.code == ProtocolCode::PROCEDURE_FAILED.get())
    );
    let errors = locked(&errors).clone();
    assert_eq!(errors.len(), 1);
    assert!(
        matches!(&errors[0], RouterError::Other(error) if
            matches!(error.downcast_ref::<bead::CallError>(), Some(bead::CallError::Refused(_)))),
        "a callback subscribing an ordinary request is a programmer error: {errors:?}"
    );
    fixture.server.dispose().await.expect("disposed");
}
