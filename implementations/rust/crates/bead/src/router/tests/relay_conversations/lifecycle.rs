//! Forwarding over a deferred memory pipe, loss of leg B, and a transfer's bound destination.

use core::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::super::locked;
use super::super::server::first;
use super::{Relayed, RelayedOptions, admitting, cancel, failure, procedure, request};
use crate::client::ClientOptions;
use crate::constants::{EnvelopeKind, ProtocolCode};
use crate::debug::DebugDirection;
use crate::envelope::{Envelope, ResultHeader};
use crate::errors::ProgrammerError;
use crate::router::admissions::BeforeRequest;
use crate::router::relay::{DestinationOptions, RelayOptions};
use crate::router::relay::{RelayLeg, RelayRouter, RelayTarget};
use crate::router::server::Call;
use crate::router::types::{RouterLimits, RouterRequest};
use crate::router::types::{RouterLimitsOptions, SignalReason};
use crate::server::ServerOptions;
use crate::testing::pair::{Pair, PairOptions, echo};

#[tokio::test]
async fn relays_over_a_pipe_that_hands_each_message_a_turn_later_and_cancels_over_it() {
    // The memory pipe hands messages through its owner's queue, in later turns.
    let relayed = Relayed::new(&RelayedOptions {
        relay: admitting(),
        ..RelayedOptions::default()
    })
    .await;
    relayed.deliver(&request((1, 7), (&echo(), "hi")));
    relayed.deliver(&request((3, 7), (&procedure((3, "held")), "")));
    assert!(locked(&relayed.sent).is_empty());
    relayed.served.settle().await;
    let expected = vec![(
        first(),
        Envelope::Result {
            header: ResultHeader {
                call_id: 1,
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(b"HI"),
        },
    )];
    assert_eq!(relayed.served.transport.take(), expected);
    relayed.deliver(&cancel(3));
    relayed.served.settle().await;
    assert_eq!(*locked(&relayed.aborted), [Some(SignalReason::Cancelled)]);
    assert_eq!(relayed.served.transport.take(), []);
    assert_eq!(
        *locked(&relayed.sent),
        [
            EnvelopeKind::Request,
            EnvelopeKind::Request,
            EnvelopeKind::Cancel
        ]
    );
    relayed.dispose().await;
}

#[tokio::test]
async fn answers_unreachable_when_the_target_never_had_the_request_and_lost_when_it_went_after_it_had_it_reporting_why()
 {
    let relayed = Relayed::new(&RelayedOptions {
        relay: admitting(),
        ..RelayedOptions::default()
    })
    .await;
    relayed.deliver(&request((1, 7), (&procedure((3, "held")), "")));
    relayed.served.settle().await;
    relayed.device.transport.close();
    relayed.served.settle().await;
    relayed.deliver(&request((3, 7), (&echo(), "")));
    relayed.served.settle().await;
    assert_eq!(
        relayed.served.transport.take(),
        [
            (
                first(),
                failure(
                    (1, ProtocolCode::DESTINATION_LOST),
                    (
                        "destination 7 was lost once handed the request: the procedure may have run",
                        0
                    )
                )
            ),
            (
                first(),
                failure(
                    (3, ProtocolCode::DESTINATION_UNREACHABLE),
                    ("destination 7 is unreachable: nothing was tried", 0)
                )
            ),
        ]
    );
    assert_eq!(
        relayed.served.reported(),
        [
            "the connection closed before the answer first",
            "the transport client is closed, not open first",
        ]
    );
    relayed.dispose().await;
}

#[derive(Debug)]
struct RefusingTarget {
    limits: RouterLimits,
    asked: AtomicUsize,
}

impl RelayRouter for RefusingTarget {
    fn limits(&self) -> RouterLimits {
        self.limits
    }

    fn request(&self, _: Bytes, _: RelayLeg) -> Result<Call, ProgrammerError> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        panic!("asked a call it did not open");
    }
}

async fn receiving_pair(admissions: Arc<AtomicUsize>, limits: &RouterLimitsOptions) -> Pair {
    Pair::connected(
        super::super::january_first(),
        &PairOptions {
            server: Some(ServerOptions {
                limits: Some(limits.clone()),
                relay: Some(RelayOptions {
                    before_route: Some(BeforeRequest::new(
                        move |_| {
                            admissions.fetch_add(1, Ordering::SeqCst);
                            true
                        },
                        None,
                    )),
                    ..RelayOptions::default()
                }),
                ..ServerOptions::default()
            }),
            client: Some(ClientOptions {
                limits: Some(limits.clone()),
                ..ClientOptions::default()
            }),
        },
    )
    .await
    .expect("leg A connected")
}

#[tokio::test]
async fn holds_a_transfer_to_the_targets_limit_at_its_opening_and_relays_one_to_the_destination_it_opened_on()
 {
    let limits = RouterLimitsOptions {
        chunk_bytes: Some(1_024),
        maximum_envelope_bytes: Some(1_024),
        window_bytes: Some(4_096),
        ..RouterLimitsOptions::default()
    };
    let behind = Relayed::new(&RelayedOptions {
        relay: admitting(),
        device_limits: RouterLimitsOptions {
            maximum_payload_bytes: Some(4_096),
            ..limits.clone()
        },
    })
    .await;
    let admissions = Arc::new(AtomicUsize::new(0));
    let pair = receiving_pair(Arc::clone(&admissions), &limits).await;
    let router = pair.server.router();
    let registration = router
        .register_destination(
            behind.device.client.router().as_relay_target(),
            &DestinationOptions {
                destination_id: Some(7),
                ..DestinationOptions::default()
            },
        )
        .expect("the device registered");
    let later = Arc::new(RefusingTarget {
        limits: behind.device.client.router().limits(),
        asked: AtomicUsize::new(0),
    });
    let credits: Arc<Mutex<Vec<u32>>> = Arc::default();
    let crediting = Arc::clone(&credits);
    let (replacing, replacing_router) = (Arc::clone(&later), router.clone());
    let listener = router.on_debug(Arc::new(move |direction, traced| {
        if direction == DebugDirection::Tx && traced.header.kind() == EnvelopeKind::Credit {
            locked(&crediting).push(traced.header.call_id());
        }
        if direction == DebugDirection::Rx
            && traced.header.kind() == EnvelopeKind::Chunk
            && registration.unregister()
        {
            replacing_router
                .register_destination(
                    RelayTarget::Router(Arc::<RefusingTarget>::clone(&replacing)),
                    &DestinationOptions {
                        destination_id: Some(7),
                        ..DestinationOptions::default()
                    },
                )
                .expect("the replacement registered during the transfer");
        }
    }));
    let ask = |length| {
        let mut request = RouterRequest::new(
            echo(),
            &crate::router::types::ResolvedRequestOptions::new(core::time::Duration::from_secs(5)),
        );
        request.options.destination_id = Some(7);
        pair.client
            .router()
            .request(Bytes::from(vec![b'x'; length]), request)
            .expect("the request starts")
    };
    let Err(crate::errors::CallError::Failure(refused)) = super::super::answered(ask(5_000)).await
    else {
        panic!("the opening exceeds the device's payload limit")
    };
    assert_eq!(refused.code(), ProtocolCode::PAYLOAD_TOO_LARGE.get());
    assert_eq!(refused.relays(), 0);
    assert!(locked(&credits).is_empty());
    assert!(locked(&behind.sent).is_empty());
    let answered = super::super::answered(ask(3_000))
        .await
        .expect("the bound device answers");
    assert_eq!(answered.payload, Bytes::from(vec![b'X'; 3_000]));
    assert!(!locked(&credits).is_empty());
    assert_eq!(admissions.load(Ordering::SeqCst), 2);
    assert_eq!(later.asked.load(Ordering::SeqCst), 0);
    router.off(listener);
    pair.client.router().dispose().await;
    router.dispose().await;
    behind.dispose().await;
}
