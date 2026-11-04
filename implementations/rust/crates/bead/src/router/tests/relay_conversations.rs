//! A relay's two legs over the memory transport: answers, refusals and cancellations.

mod lifecycle;
mod timers;

use core::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::locked;
use super::server::{Served, first, header_of};
use crate::clock::SharedClock;
use crate::constants::{EnvelopeKind, FailureScope, ProtocolCode};
use crate::debug::DebugDirection;
use crate::envelope::{CancelHeader, Envelope, FailureHeader, FailureRecord, ResultHeader};
use crate::failure::Failure;
use crate::identity::Procedure;
use crate::managers::service::{RequestResolverDependencies, Response};
use crate::payloads::TextCodec;
use crate::router::admissions::BeforeRequest;
use crate::router::relay::{Destination, DestinationOptions, RelayOptions};
use crate::router::server::RouterServerOptions;
use crate::router::types::{RouterLimitsOptions, SignalReason};
use crate::server::ServerOptions;
use crate::testing::SteppingClock;
use crate::testing::pair::{Pair, PairOptions, echo};

fn procedure((id, name): (u16, &str)) -> Procedure {
    Procedure {
        procedure_id: id,
        procedure_name: name.to_owned(),
        ..echo()
    }
}

fn request((id, destination): (u32, u32), (procedure, payload): (&Procedure, &str)) -> Envelope {
    Envelope::Request {
        header: crate::envelope::RequestHeader {
            destination_id: Some(destination),
            ..header_of((id, procedure))
        },
        payload: Bytes::copy_from_slice(payload.as_bytes()),
    }
}

fn cancel(id: u32) -> Envelope {
    Envelope::Cancel {
        header: CancelHeader { call_id: id },
    }
}

fn failure((id, code): (u32, ProtocolCode), (detail, relays): (&str, u8)) -> Envelope {
    Envelope::Failure {
        header: FailureHeader {
            call_id: id,
            credential: None,
        },
        failure: FailureRecord {
            code: code.get(),
            scope: FailureScope::Protocol,
            detail: detail.to_owned(),
            relays,
        },
    }
}

fn admitting() -> RelayOptions {
    RelayOptions {
        before_route: Some(BeforeRequest::new(|_| true, None)),
        ..RelayOptions::default()
    }
}

struct Relayed {
    served: Served,
    device: Pair,
    aborted: Arc<Mutex<Vec<Option<SignalReason>>>>,
    sent: Arc<Mutex<Vec<EnvelopeKind>>>,
}

impl Relayed {
    async fn new(relay: RelayOptions, device_limits: RouterLimitsOptions) -> Self {
        let device = Pair::connected(
            super::january_first(),
            &PairOptions {
                server: Some(ServerOptions {
                    limits: Some(device_limits.clone()),
                    ..ServerOptions::default()
                }),
                client: Some(crate::client::ClientOptions {
                    limits: Some(device_limits),
                    ..crate::client::ClientOptions::default()
                }),
            },
        )
        .await
        .expect("the device connected");
        let services = device.server.services();
        services
            .get_request_resolver(
                &echo(),
                RequestResolverDependencies::new(TextCodec, TextCodec),
            )
            .expect("echo resolved")
            .on(Arc::new(|request, response: Response<TextCodec>| {
                response.result(request.payload.to_uppercase())
            }))
            .expect("echo registered");
        services
            .get_request_resolver(
                &procedure((2, "failing")),
                RequestResolverDependencies::new(TextCodec, TextCodec),
            )
            .expect("failing resolved")
            .on(Arc::new(|_, response: Response<TextCodec>| {
                response.failure(&Failure::application(
                    21.try_into().expect("a nonzero code"),
                    "nothing to echo",
                ))
            }))
            .expect("failing registered");
        let aborted: Arc<Mutex<Vec<Option<SignalReason>>>> = Arc::default();
        let aborting = Arc::clone(&aborted);
        services
            .get_request_resolver(
                &procedure((3, "held")),
                RequestResolverDependencies::new(TextCodec, TextCodec),
            )
            .expect("held resolved")
            .on(Arc::new(move |request, _: Response<TextCodec>| {
                let aborted = Arc::clone(&aborting);
                Box::pin(async move {
                    request.signal.token().cancelled().await;
                    locked(&aborted).push(request.signal.reason());
                    Ok(())
                })
            }))
            .expect("held registered");
        let sent: Arc<Mutex<Vec<EnvelopeKind>>> = Arc::default();
        let sending = Arc::clone(&sent);
        device
            .client
            .router()
            .on_debug(Arc::new(move |direction, traced| {
                if direction == DebugDirection::Tx {
                    locked(&sending).push(traced.header.kind());
                }
            }));
        let shared: SharedClock = Arc::<SteppingClock>::clone(&device.clock);
        let served = Served::on(
            (shared, Arc::clone(&device.clock)),
            &RouterServerOptions {
                relay: Some(relay),
                ..RouterServerOptions::default()
            },
        );
        served.transport.open(&first(), true);
        served
            .router
            .register_destination(
                device.client.router().as_relay_target(),
                &DestinationOptions {
                    destination_id: Some(7),
                    label: Some("the device".to_owned()),
                    ..DestinationOptions::default()
                },
            )
            .expect("the device registered");
        served.settle().await;
        Self {
            served,
            device,
            aborted,
            sent,
        }
    }

    fn deliver(&self, envelope: &Envelope) {
        self.served.transport.deliver(envelope, &first());
    }

    async fn dispose(&self) {
        self.served.router.dispose().await;
        self.device.client.router().dispose().await;
        self.device.server.router().dispose().await;
    }
}

#[tokio::test]
async fn relays_a_request_to_the_destination_it_names_admitted_once_and_brings_the_answer_back_under_its_call_id_a_failure_of_the_targets_one_relay_more()
 {
    // The C# source delivers one request at a time; TypeScript delivers all three in one turn.
    for batched in [false, true] {
        let admissions = Arc::new(AtomicUsize::new(0));
        let admitting = Arc::clone(&admissions);
        let relayed = Relayed::new(
            RelayOptions {
                before_route: Some(BeforeRequest::new(
                    move |_| {
                        admitting.fetch_add(1, Ordering::SeqCst);
                        true
                    },
                    None,
                )),
                ..RelayOptions::default()
            },
            RouterLimitsOptions::default(),
        )
        .await;
        for (id, procedure, payload) in [
            (1, echo(), "hi"),
            (3, procedure((2, "failing")), ""),
            (5, procedure((9, "echo")), ""),
        ] {
            relayed.deliver(&request((id, 7), (&procedure, payload)));
            if !batched {
                relayed.served.settle().await;
            }
        }
        relayed.served.settle().await;
        let result = Envelope::Result {
            header: ResultHeader {
                call_id: 1,
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(b"HI"),
        };
        let refused = failure(
            (5, ProtocolCode::PROCEDURE_UNKNOWN),
            ("no procedure 9 in service 2", 1),
        );
        let failed = Envelope::Failure {
            header: FailureHeader {
                call_id: 3,
                credential: None,
            },
            failure: FailureRecord {
                code: 21.try_into().expect("a nonzero code"),
                scope: FailureScope::Application,
                detail: "nothing to echo".to_owned(),
                relays: 1,
            },
        };
        let expected = if batched {
            vec![refused, result, failed]
        } else {
            vec![result, failed, refused]
        };
        let sent = relayed.served.transport.take();
        assert_eq!(
            sent,
            expected
                .into_iter()
                .map(|envelope| (first(), envelope))
                .collect::<Vec<_>>()
        );
        assert_eq!(admissions.load(Ordering::SeqCst), 3);
        assert!(locked(&relayed.served.reports).is_empty());
        assert_eq!(
            relayed.served.router.destinations(),
            [Destination {
                destination_id: 7,
                is_closed: false,
                label: Some("the device".to_owned())
            }]
        );
        relayed.dispose().await;
    }
}

#[tokio::test]
async fn refuses_before_leg_b_the_routing_not_admitted_the_destination_unknown_a_subscription_a_payload_past_the_targets_limit_and_sends_the_target_nothing()
 {
    let relayed = Relayed::new(
        RelayOptions {
            before_route: Some(BeforeRequest::new(
                |request| request.header.call_id != 1,
                None,
            )),
            ..RelayOptions::default()
        },
        RouterLimitsOptions {
            maximum_payload_bytes: Some(4),
            ..RouterLimitsOptions::default()
        },
    )
    .await;
    relayed.deliver(&request((1, 7), (&echo(), "")));
    relayed.deliver(&request((3, 8), (&echo(), "")));
    let Envelope::Request {
        mut header,
        payload,
    } = request((5, 7), (&echo(), ""))
    else {
        panic!("a request")
    };
    header.opens_subscription = true;
    relayed.deliver(&Envelope::Request { header, payload });
    relayed.deliver(&request((7, 7), (&echo(), "too long")));
    relayed.served.settle().await;
    let sent = relayed.served.transport.take();
    assert_eq!(sent.len(), 4);
    for ((handle, envelope), (id, code)) in sent.into_iter().zip([
        (1, ProtocolCode::ACCESS_DENIED),
        (3, ProtocolCode::DESTINATION_UNKNOWN),
        (5, ProtocolCode::SUBSCRIPTION_UNSUPPORTED),
        (7, ProtocolCode::PAYLOAD_TOO_LARGE),
    ]) {
        assert_eq!(handle, first());
        let Envelope::Failure { header, failure } = envelope else {
            panic!("a refusal")
        };
        assert_eq!(
            header,
            FailureHeader {
                call_id: id,
                credential: None
            }
        );
        assert_eq!(failure.code, code.get());
        assert_eq!(failure.scope, FailureScope::Protocol);
        assert_eq!(failure.relays, 0);
    }
    assert!(locked(&relayed.sent).is_empty());
    assert!(locked(&relayed.served.reports).is_empty());
    relayed.dispose().await;
}

#[tokio::test]
async fn cancels_leg_b_when_leg_a_cancels_its_call_when_its_connection_goes_and_when_the_relay_is_disposed_freeing_the_call_id_each_time()
 {
    let relayed = Relayed::new(admitting(), RouterLimitsOptions::default()).await;
    for ending in 0..3 {
        relayed.deliver(&request((1, 7), (&procedure((3, "held")), "")));
        relayed.served.settle().await;
        match ending {
            0 => relayed.deliver(&cancel(1)),
            1 => relayed.served.transport.close_connection(&first()),
            _ => {
                relayed.served.router.dispose().await;
            }
        }
        relayed.served.settle().await;
        assert_eq!(
            *locked(&relayed.aborted),
            vec![Some(SignalReason::Cancelled); ending + 1]
        );
        if ending == 1 {
            relayed.served.transport.open(&first(), true);
            relayed.served.settle().await;
        }
    }
    assert_eq!(
        *locked(&relayed.sent),
        [
            EnvelopeKind::Request,
            EnvelopeKind::Cancel,
            EnvelopeKind::Request,
            EnvelopeKind::Cancel,
            EnvelopeKind::Request,
            EnvelopeKind::Cancel
        ]
    );
    assert_eq!(relayed.served.transport.take(), []);
    relayed.dispose().await;
}

#[tokio::test]
async fn cancels_leg_b_when_leg_a_cancels_its_call_as_leg_bs_request_is_handed_over() {
    let relayed = Relayed::new(admitting(), RouterLimitsOptions::default()).await;
    let taken: Arc<Mutex<Vec<EnvelopeKind>>> = Arc::default();
    let taking = Arc::clone(&taken);
    let transport = Arc::clone(&relayed.served.transport);
    relayed
        .device
        .server
        .router()
        .on_debug(Arc::new(move |direction, traced| {
            if direction == DebugDirection::Rx {
                let mut taken = locked(&taking);
                taken.push(traced.header.kind());
                if taken.len() == 1 {
                    transport.deliver(&cancel(1), &first());
                }
            }
        }));
    relayed.deliver(&request((1, 7), (&procedure((3, "held")), "")));
    relayed.served.settle().await;
    assert_eq!(
        *locked(&taken),
        [EnvelopeKind::Request, EnvelopeKind::Cancel]
    );
    assert_eq!(*locked(&relayed.aborted), [Some(SignalReason::Cancelled)]);
    assert_eq!(relayed.served.transport.take(), []);
    relayed.dispose().await;
}
