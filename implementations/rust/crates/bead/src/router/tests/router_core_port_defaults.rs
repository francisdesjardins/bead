//! A side supplies its core, sends and reports; every optional port method keeps its default.

use std::sync::Arc;

use bytes::Bytes;

use super::router_core_sessions::handler;
use super::{Handed, locked};
use crate::clock::SharedClock;
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Envelope, NotificationHeader, RequestHeader, ResultHeader};
use crate::owner::Owner;
use crate::router::core::{self as router_core, Core, Side};
use crate::router::types::{
    ConnectionHandle, RouterAnswer, RouterError, RouterLimitsOptions, TransportMessage, limits_of,
};
use crate::testing::core_port::scripted_header;
use crate::testing::pair::echo;
use crate::testing::{SteppingClock, instants, scripted};
use crate::transport::Sent;

struct Plain {
    core: Core<Self>,
    reports: Vec<(ConnectionHandle, RouterError)>,
    sent: Vec<(ConnectionHandle, Envelope)>,
}

impl Side for Plain {
    fn core(&mut self) -> &mut Core<Self> {
        &mut self.core
    }

    fn report(&mut self, error: RouterError, handle: &ConnectionHandle) {
        self.reports.push((Arc::clone(handle), error));
    }

    // a plain port has no connection of its own to close
    fn close(&mut self, _connection_handle: &ConnectionHandle) {}

    fn transmit(
        &mut self,
        message: TransportMessage,
        handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        self.sent.push((
            Arc::clone(handle),
            scripted::envelope_of(&message.data, self.core.side.peer()),
        ));
        Ok(Sent::Done)
    }
}

fn plain() -> (Owner<Plain>, Arc<SteppingClock>) {
    let clock = SteppingClock::new(instants::new_year());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let runtime = crate::platform::runtime_of(None, "a plain port's core").expect("a runtime");
    let owner = Owner::spawn((&runtime, &shared), |owner| Plain {
        core: Core::new(
            owner,
            (
                RouterSide::Server,
                limits_of(&RouterLimitsOptions::default()).expect("default limits"),
                Arc::clone(&shared),
                None,
            ),
        ),
        reports: Vec::new(),
        sent: Vec::new(),
    });
    (owner, clock)
}

#[tokio::test]
async fn keeps_every_default_of_a_port_that_says_nothing_but_its_side_and_how_it_sends() {
    let (owner, clock) = plain();
    let handed = Handed::default();
    let resolving = handler((&handed, &Arc::default()));
    owner
        .run(move |state| {
            router_core::register_resolver(&state.core.resolvers, (&echo(), resolving, None))
                .expect("echo registered");
            for envelope in [
                Envelope::Request {
                    header: RequestHeader {
                        opens_subscription: true,
                        ..scripted_header(1)
                    },
                    payload: Bytes::from_static(&[1]),
                },
                Envelope::Notification {
                    header: NotificationHeader { call_id: 3 },
                    payload: Bytes::from_static(&[1]),
                },
            ] {
                router_core::receive(
                    state,
                    (
                        TransportMessage {
                            data: scripted::bytes_of(&envelope),
                            ..TransportMessage::default()
                        },
                        &Arc::from("a"),
                    ),
                );
            }
        })
        .await
        .expect("the request and notification arrive");
    clock.settle().await;
    {
        let handed = locked(&handed);
        assert_eq!(handed.len(), 1, "the default port carries both ways");
        assert_eq!(handed[0].header.call_id, 1);
        assert!(handed[0].header.opens_subscription);
        assert_eq!(handed[0].payload, Bytes::from_static(&[1]));
    }
    owner.run(|state| {
        assert!(matches!(state.reports.as_slice(), [(handle, RouterError::Failure(failure))]
            if handle.as_ref() == "a" && failure.protocol_code() == Some(ProtocolCode::KIND_UNSUPPORTED)),
            "a default port takes no notification: {:?}", state.reports);
        router_core::dispose(state);
    }).await.expect("the default notification policy reports its refusal");
}

pub(super) async fn assert_sessionless_answer() {
    let (owner, clock) = plain();
    let handed = Handed::default();
    let resolving = handler((&handed, &Arc::default()));
    owner
        .run(move |state| {
            router_core::register_resolver(&state.core.resolvers, (&echo(), resolving, None))
                .expect("echo registered");
            router_core::receive(
                state,
                (
                    TransportMessage {
                        data: scripted::bytes_of(&Envelope::Request {
                            header: scripted_header(1),
                            payload: Bytes::new(),
                        }),
                        ..TransportMessage::default()
                    },
                    &Arc::from("a"),
                ),
            );
        })
        .await
        .expect("the request arrives");
    clock.settle().await;
    let answerer = Arc::clone(&locked(&handed)[0].answerer);
    answerer
        .respond(RouterAnswer::Result(Bytes::new()))
        .await
        .expect("the bare port answers");
    clock.settle().await;
    owner
        .run(|state| {
            assert_eq!(
                state.sent,
                [(
                    Arc::from("a"),
                    Envelope::Result {
                        header: ResultHeader {
                            call_id: 1,
                            total: None,
                            credential: None
                        },
                        payload: Bytes::new()
                    }
                )]
            );
            assert!(state.reports.is_empty(), "the port reports no refusal");
            router_core::dispose(state);
        })
        .await
        .expect("the default session-token provider announces nothing");
}
