//! The router core's ask of its transport (spec 9.2, step 5, and 9.11): of each request that names
//! no destination, whether its connection's transport takes its procedure, when that transport
//! names procedures, and never otherwise. The other sides' twins hold the same sentences.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::server::{first, header_of, name_of, request_of};
use super::{Handed, keeping, locked};
use crate::clock::SharedClock;
use crate::constants::ProtocolCode;
use crate::envelope::{Envelope, RequestHeader};
use crate::failure::ProcedureAddress;
use crate::identity::Procedure;
use crate::router::core::Handler;
use crate::router::server::{RouterServer, RouterServerOptions};
use crate::router::types::{BoxFuture, ConnectionHandle, RouterError, TransportMessage};
use crate::testing::SteppingClock;
use crate::testing::pair::echo;
use crate::testing::scripted::ScriptedServer;
use crate::transport::{Sent, ServerListener, ServerTransport};

// a scripted transport that answers whether a connection takes a procedure by the list it is given,
// recording each ask, and names procedures as a test says, the list or not
#[derive(Debug)]
struct Asking {
    scripted: Arc<ScriptedServer>,
    names: bool,
    taking: Vec<ProcedureAddress>,
    asked: Mutex<Vec<String>>,
}

impl ServerTransport for Asking {
    fn send(
        &self,
        message: TransportMessage,
        connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        self.scripted.send(message, connection_handle)
    }

    fn close(&self, connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        self.scripted.close(connection_handle)
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        self.scripted.listen(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        self.scripted.unlisten(listener);
    }

    fn pause(&self, connection_handle: &ConnectionHandle) {
        self.scripted.pause(connection_handle);
    }

    fn resume(&self, connection_handle: &ConnectionHandle) {
        self.scripted.resume(connection_handle);
    }

    fn clock(&self) -> Option<SharedClock> {
        self.scripted.clock()
    }

    fn names_procedures(&self) -> bool {
        self.names
    }

    fn takes_procedure(
        &self,
        connection_handle: &ConnectionHandle,
        address: ProcedureAddress,
    ) -> bool {
        locked(&self.asked).push(format!(
            "{}/{} on {}",
            address.service_id,
            address.procedure_id,
            name_of(Some(connection_handle))
        ));

        self.taking.contains(&address)
    }

    fn stop(&self) -> BoxFuture<Result<(), RouterError>> {
        self.scripted.stop()
    }
}

// a server's router over a transport that names procedures or not, taking `echo` alone, with
// `echo` and `other` of its service registered, its first connection open
struct Asked {
    clock: Arc<SteppingClock>,
    transport: Arc<Asking>,
    router: RouterServer,
    handed: Handed,
}

// procedure 2 of `echo`'s service, which the transport does not take
fn other() -> Procedure {
    Procedure {
        procedure_id: 2,
        procedure_name: "other".to_owned(),
        ..echo()
    }
}

impl Asked {
    fn of(names: bool) -> Self {
        let clock = SteppingClock::new(super::january_first());
        let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
        let transport = Arc::new(Asking {
            scripted: ScriptedServer::new(shared),
            names,
            taking: vec![echo().address()],
            asked: Mutex::default(),
        });
        let carried: Arc<dyn ServerTransport> = Arc::<Asking>::clone(&transport);
        let router =
            RouterServer::new(carried, &RouterServerOptions::default()).expect("a router built");
        let handed: Handed = Arc::default();

        transport.scripted.open(&first(), true);

        for procedure in [echo(), other()] {
            router
                .register_resolver((
                    &procedure,
                    Handler {
                        resolve: keeping((&handed, None)),
                        admit: None,
                        maximum_payload_bytes: None,
                        forwards_credentials: false,
                        notifies: false,
                    },
                ))
                .expect("registered");
        }

        Self {
            clock,
            transport,
            router,
            handed,
        }
    }

    // what was asked of the transport since the last time asked
    fn asked(&self) -> Vec<String> {
        core::mem::take(&mut *locked(&self.transport.asked))
    }

    // each failure sent since the last time asked: its call id, its code by name and its detail
    fn failures(&self) -> Vec<String> {
        self.transport
            .scripted
            .take()
            .iter()
            .map(|(_, envelope)| {
                if let Envelope::Failure { header, failure } = envelope {
                    format!(
                        "{} {} {}",
                        header.call_id,
                        ProtocolCode::new(failure.code).name().unwrap_or_default(),
                        failure.detail
                    )
                } else {
                    format!("{:?} {}", envelope.kind(), envelope.call_id())
                }
            })
            .collect()
    }

    // each call id its resolvers were handed
    fn handed(&self) -> Vec<u32> {
        locked(&self.handed)
            .iter()
            .map(|props| props.header.call_id)
            .collect()
    }
}

// spec 9.2.5, 9.11: the twin of "a router asks its transport of each request that names no
// destination, and of none that names one"
#[tokio::test]
async fn a_router_asks_its_transport_of_each_request_that_names_no_destination_and_of_none_that_names_one()
 {
    let asked = Asked::of(true);

    // * a procedure it takes is handed to its resolver, asked once
    asked
        .transport
        .scripted
        .deliver(&request_of((1, &echo(), "\"x\"")), &first());
    asked.clock.settle().await;

    assert_eq!(asked.asked(), ["2/1 on first"], "asked of echo");
    assert_eq!(asked.handed(), [1], "echo handed to its resolver");

    // one it does not take is none: its service known by echo, which it takes
    asked
        .transport
        .scripted
        .deliver(&request_of((3, &other(), "null")), &first());
    asked.clock.settle().await;

    assert_eq!(
        asked.asked(),
        ["2/2 on first", "2/1 on first"],
        "asked of other, then of its service's procedures until one is taken"
    );
    assert_eq!(
        asked.failures(),
        ["3 PROCEDURE_UNKNOWN no procedure 2 in service 2"],
        "answered as a procedure absent"
    );
    assert_eq!(asked.handed(), [1], "other never handed");

    // one that names a destination is its relay's, asked of no transport
    asked.transport.scripted.deliver(
        &Envelope::Request {
            header: RequestHeader {
                destination_id: Some(4),
                ..header_of((5, &other()))
            },
            payload: Bytes::new(),
        },
        &first(),
    );
    asked.clock.settle().await;

    assert!(asked.asked().is_empty(), "nothing asked");
    assert_eq!(
        asked.failures(),
        ["5 DESTINATION_UNKNOWN this peer relays nothing, to 4 or elsewhere"],
        "refused as a destination unknown"
    );

    asked.router.dispose().await;
}

// spec 9.11: the twin of "a router whose transport names no procedures never asks"
#[tokio::test]
async fn a_router_whose_transport_names_no_procedures_never_asks() {
    let asked = Asked::of(false);

    // * a list it would answer from goes unasked: every procedure taken
    for (call_id, procedure) in [(1, echo()), (3, other())] {
        asked
            .transport
            .scripted
            .deliver(&request_of((call_id, &procedure, "null")), &first());
    }

    asked.transport.scripted.deliver(
        &request_of((
            5,
            &Procedure {
                procedure_id: 99,
                ..echo()
            },
            "null",
        )),
        &first(),
    );
    asked.clock.settle().await;

    assert!(asked.asked().is_empty(), "nothing asked");
    assert_eq!(asked.handed(), [1, 3], "both handed to their resolvers");
    assert_eq!(
        asked.failures(),
        ["5 PROCEDURE_UNKNOWN no procedure 99 in service 2"],
        "an absent one answered as before"
    );

    asked.router.dispose().await;
}
