//! A relay's own connections: even command ids, cancellation, closure and replacement.

use std::sync::Arc;

use bytes::Bytes;

use super::server::{Served, first, second};
use crate::constants::{FailureScope, ProtocolCode};
use crate::envelope::{CancelHeader, Envelope, RequestHeader, ResultHeader};
use crate::router::admissions::BeforeRequest;
use crate::router::relay::{Destination, DestinationOptions, RelayOptions, RelayTarget};
use crate::router::server::RouterServerOptions;
use crate::router::types::{LIMIT_DEFAULTS, RouterLimitsOptions};
use crate::testing::scripted::handle_of;

fn request((id, destination): (u32, u32), payload: &str) -> Envelope {
    Envelope::Request {
        header: RequestHeader {
            destination_id: Some(destination),
            ..super::request_header_of(id)
        },
        payload: Bytes::copy_from_slice(payload.as_bytes()),
    }
}

fn admitting() -> RelayOptions {
    RelayOptions {
        before_route: Some(BeforeRequest::new(|_| true, None)),
        ..RelayOptions::default()
    }
}

#[tokio::test]
async fn asks_a_connection_of_its_own_by_a_command_cancels_it_with_leg_a_answers_lost_when_it_goes_and_unreachable_after_until_a_connection_opened_since_takes_its_place()
 {
    let served = Served::new(&RouterServerOptions {
        relay: Some(admitting()),
        ..RouterServerOptions::default()
    });
    let newcomer = Arc::from("type=WS;ip=127.0.0.1;port=50002;ordinal=2");
    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served.settle().await;
    let registration = served
        .router
        .register_destination(
            RelayTarget::Connection(second()),
            &DestinationOptions {
                destination_id: Some(9),
                ..DestinationOptions::default()
            },
        )
        .expect("the connection registered");
    served.transport.deliver(&request((1, 9), "hi"), &first());
    served.settle().await;
    let sent = served.transport.sent();
    let sent = crate::testing::scripted::envelope_of(
        &sent[0].1.data,
        crate::constants::RouterSide::Client,
    );
    assert_eq!(
        sent,
        Envelope::Request {
            header: super::request_header_of(2),
            payload: Bytes::from_static(b"hi"),
        }
    );
    served.transport.deliver(
        &Envelope::Result {
            header: ResultHeader {
                call_id: 2,
                total: None,
                credential: None,
            },
            payload: Bytes::from_static(b"HI"),
        },
        &second(),
    );
    served.settle().await;
    served.transport.deliver(&request((3, 9), ""), &first());
    served.settle().await;
    served.transport.deliver(
        &Envelope::Cancel {
            header: CancelHeader { call_id: 3 },
        },
        &first(),
    );
    served.settle().await;
    served.transport.deliver(&request((5, 9), ""), &first());
    served.settle().await;
    served.transport.close_connection(&second());
    served.settle().await;
    served.transport.open(&newcomer, true);
    served.transport.deliver(&request((7, 9), ""), &first());
    served.settle().await;
    assert_eq!(
        served.sent_since(),
        [
            "second request 2 hi",
            "first result 1 HI",
            "second request 4 ",
            "second Cancel 4",
            "second request 6 ",
            "first failure 5 DESTINATION_LOST",
            "first failure 7 DESTINATION_UNREACHABLE",
        ]
    );
    assert_eq!(
        served.router.destinations(),
        [Destination {
            destination_id: 9,
            is_closed: true,
            label: None
        }]
    );
    assert!(registration.is_closed());
    replacement(&served, (registration, newcomer)).await;
}

async fn replacement(
    served: &Served,
    (registration, newcomer): (
        crate::router::relay::DestinationRegistration,
        crate::router::types::ConnectionHandle,
    ),
) {
    let again = served
        .router
        .register_destination(
            RelayTarget::Connection(second()),
            &DestinationOptions {
                replaces: Some(registration.clone()),
                ..DestinationOptions::default()
            },
        )
        .expect("the closed connection replaces its registration");
    served.transport.deliver(&request((9, 9), ""), &first());
    served.settle().await;
    assert!(again.is_closed());
    assert_eq!(
        served.sent_since(),
        ["first failure 9 DESTINATION_UNREACHABLE"]
    );
    served
        .router
        .register_destination(
            RelayTarget::Connection(Arc::clone(&newcomer)),
            &DestinationOptions {
                replaces: Some(again),
                ..DestinationOptions::default()
            },
        )
        .expect("the newcomer replaces it");
    served
        .transport
        .deliver(&request((11, 9), "again"), &first());
    served.settle().await;
    served.router.dispose().await;
    served.settle().await;
    assert!(!registration.unregister());
    assert_eq!(served.sent_since(), [format!("{newcomer} request 8 again")]);
    assert_eq!(
        served.reported(),
        ["the connection closed before the answer first"]
    );
}

#[tokio::test]
async fn holds_a_connection_of_its_own_to_the_routers_own_limits_and_passes_nothing_on_to_one_that_carries_no_request()
 {
    let past = LIMIT_DEFAULTS.maximum_payload_bytes + 1;
    let served = Served::new(&RouterServerOptions {
        limits: Some(RouterLimitsOptions {
            maximum_payload_bytes: Some(2 * past),
            ..RouterLimitsOptions::default()
        }),
        relay: Some(admitting()),
        ..RouterServerOptions::default()
    });
    let third = handle_of(3);
    for (handle, two_way) in [
        (first(), true),
        (second(), true),
        (Arc::clone(&third), false),
    ] {
        served.transport.open(&handle, two_way);
    }
    served.settle().await;
    for (handle, id) in [(second(), 9), (third, 11)] {
        served
            .router
            .register_destination(
                RelayTarget::Connection(handle),
                &DestinationOptions {
                    destination_id: Some(id),
                    ..DestinationOptions::default()
                },
            )
            .expect("the destination registered");
    }
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                destination_id: Some(9),
                total: Some(past),
                ..super::request_header_of(1)
            },
            payload: Bytes::from_static(&[0; 16]),
        },
        &first(),
    );
    served.transport.deliver(&request((3, 11), ""), &first());
    served.settle().await;
    let sent = served.transport.take();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0].0, first());
    assert!(
        matches!(&sent[0].1, Envelope::Credit { header } if header.call_id == 1 && !header.paced)
    );
    let (handle, Envelope::Failure { header, failure }) = &sent[1] else {
        panic!("the one-way connection refused")
    };
    assert_eq!(handle, &first());
    assert_eq!(header.call_id, 3);
    assert_eq!(header.credential, None);
    assert_eq!(failure.code, ProtocolCode::DESTINATION_UNREACHABLE.get());
    assert_eq!(failure.scope, FailureScope::Protocol);
    assert_eq!(failure.relays, 0);
    assert_eq!(
        failure.detail,
        "destination 11 is unreachable: its connection carries no request"
    );
    served.router.dispose().await;
}
