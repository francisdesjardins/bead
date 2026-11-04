//! A server's relay, admitted by a `before_route` of the application's own.

use std::sync::Arc;

use bytes::Bytes;

use super::{Envelope, Fixture, ProtocolCode, RequestHeader, ServerOptions, handle_of};
use crate::constants::RouterSide;
use crate::router::admissions::{BeforeRequest, require_credential};
use crate::router::relay::{DestinationOptions, RelayOptions, RelayTarget};

fn relayed(call_id: u32, destination_id: u32) -> Envelope {
    Envelope::Request {
        header: RequestHeader {
            call_id,
            service_id: 1,
            procedure_id: 2,
            destination_id: Some(destination_id),
            opens_subscription: false,
            paced: false,
            total: None,
            credential: None,
        },
        payload: Bytes::from_static(b"hi"),
    }
}

#[tokio::test]
async fn a_before_route_that_reads_the_destination_admits_a_requester_in_a_session_only_to_the_destinations_its_session_names()
 {
    // a requester reaches a destination its session names, or forwards a credential its
    // destination verifies
    let forwards = require_credential().admission(RouterSide::Server);
    let is_admitted = BeforeRequest::new(
        move |request| {
            let named = request
                .session
                .as_ref()
                .and_then(|session| session.data.as_ref())
                .and_then(serde_json::Value::as_str)
                .zip(request.header.destination_id)
                .is_some_and(|(devices, destination_id)| {
                    devices
                        .split(',')
                        .any(|device| device == destination_id.to_string())
                });

            matches!(forwards(request), Ok(None)) || named
        },
        None,
    );
    let fixture = Fixture::new(&ServerOptions {
        relay: Some(RelayOptions {
            before_route: Some(is_admitted),
            ..RelayOptions::default()
        }),
        ..ServerOptions::default()
    });
    let (door, window) = (handle_of(2), handle_of(3));
    fixture.open().await;
    for device in [&door, &window] {
        fixture.transport.open(device, true);
    }
    fixture.clock.settle().await;
    let router = fixture.server.router();
    let _registered = [(&door, 7), (&window, 8)].map(|(device, destination_id)| {
        router
            .register_destination(
                RelayTarget::Connection(Arc::clone(device)),
                &DestinationOptions {
                    destination_id: Some(destination_id),
                    ..DestinationOptions::default()
                },
            )
            .expect("registered")
    });

    // in none, refused; in a session that names 7, through to 7 alone
    fixture.transport.deliver(&relayed(1, 7), &fixture.first);
    fixture.clock.settle().await;
    let sessions = fixture.server.sessions();
    let mut session = sessions.create(Arc::clone(&fixture.first));
    session.data = Some(serde_json::json!("7"));
    sessions
        .set(session)
        .expect("a session")
        .await
        .expect("stored");
    fixture.transport.deliver(&relayed(3, 7), &fixture.first);
    fixture.transport.deliver(&relayed(5, 8), &fixture.first);
    fixture.clock.settle().await;

    let refused: Vec<_> = fixture
        .transport
        .envelopes(&fixture.first)
        .iter()
        .filter_map(|envelope| {
            let Envelope::Failure { header, failure } = envelope else {
                return None;
            };

            Some((header.call_id, failure.code))
        })
        .collect();
    let denied = ProtocolCode::ACCESS_DENIED.get();
    assert_eq!(refused, [(1, denied), (5, denied)]);
    assert!(matches!(
        fixture.transport.envelopes(&door).as_slice(),
        [Envelope::Request { .. }]
    ));
    assert_eq!(fixture.transport.envelopes(&window), []);
    fixture.server.dispose().await.expect("disposed");
}
