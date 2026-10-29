//! The requester's credential, as its side resolves it, and the room its headers leave a payload.

use bytes::Bytes;

use super::router_core_requester::{limits, pattern, quiet};
use super::token;
use crate::call_session::presented_credential_of;
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope};
use crate::errors::CallError;
use crate::failure::{Failure, FailureOrigin};
use crate::router::core as router_core;
use crate::router::types::{RequestCredential, RouterLimitsOptions, RouterResult};
use crate::session_token::SessionToken;
use crate::testing::core_port::{Completion, Peer, completed, request_of};

fn failure_of(outcome: Result<RouterResult, CallError>) -> Failure {
    let Err(CallError::Failure(failure)) = outcome else {
        panic!("a failure expected: {outcome:?}");
    };
    assert_eq!(failure.origin(), FailureOrigin::Local);
    failure
}

fn ask(
    peer: &Peer,
    (payload, requested, token): (Bytes, Option<&RequestCredential>, Option<&SessionToken>),
) -> Completion<RouterResult> {
    let mut request = request_of("a");
    match presented_credential_of(requested, (RouterSide::Client, token)) {
        Ok(presented) => {
            request.credential = presented.credential;
            request.transport_credential = presented.carried;
        }
        Err(error) => request.refusal = Some(error),
    }
    peer.request((payload, request))
}

// spec 4.4, 12.3, 13.4
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the shared credential presentations and both header boundaries"
)]
async fn the_credential_this_side_presents_is_the_one_its_side_resolved_and_one_that_leaves_a_transfers_opening_no_byte_fails_it_before_it_goes_payload_too_large()
 {
    let peer = Peer::new(RouterSide::Server, &limits());
    let mut request = request_of("a");
    request.credential = Some(Credential::Jwt(Bytes::from(vec![b'x'; 36])));
    let answering = peer.request((pattern(100), request));
    let mut request = request_of("a");
    request.credential = Some(Credential::Jwt(Bytes::from(vec![b'x'; 40])));
    let refused = failure_of(completed(peer.request((pattern(100), request))).await);
    assert_eq!(refused.code(), ProtocolCode::PAYLOAD_TOO_LARGE.get());
    assert_eq!(
        refused.detail(),
        "a payload of 100 bytes goes as a transfer, whose opening's header of 64 bytes leaves it no byte within 64"
    );
    assert_eq!(
        refused.procedure(),
        Some(crate::testing::pair::echo().address())
    );
    let mut request = request_of("a");
    request.credential = Some(Credential::Opaque(token()));
    let whole = peer.request((Bytes::from_static(&[1]), request));
    peer.settle().await;
    assert_eq!(
        peer.sent()
            .await
            .iter()
            .map(|(_, envelope)| {
                let Envelope::Request { header, payload } = envelope else {
                    panic!("a request expected: {envelope:?}")
                };
                (header.call_id, header.credential.clone(), payload.len())
            })
            .collect::<Vec<_>>(),
        [
            (2, Some(Credential::Jwt(Bytes::from(vec![b'x'; 36]))), 4),
            (6, Some(Credential::Opaque(token())), 1)
        ]
    );
    peer.owner
        .run(|state| {
            router_core::reject_pending(state, ("done", Some(&std::sync::Arc::from("a"))));
        })
        .await
        .expect("the calls closed");
    for call in [answering, whole] {
        assert!(matches!(
            completed(call).await,
            Err(CallError::Disconnected(_))
        ));
    }
    quiet(&peer).await;

    let client = Peer::new(RouterSide::Client, &limits());
    let refusal = failure_of(
        completed(ask(
            &client,
            (
                Bytes::from_static(&[1]),
                Some(&RequestCredential::Opaque),
                None,
            ),
        ))
        .await,
    );
    assert_eq!(refusal.code(), ProtocolCode::SESSION_REQUIRED.get());
    assert_eq!(refusal.side(), Some(RouterSide::Client));
    assert_eq!(client.sent().await.len(), 0);
    let known = token();
    let requests = [
        (Some(RequestCredential::Opaque), 1),
        (Some(RequestCredential::None), 1),
        (None, 1),
        (Some(RequestCredential::Jwt("a.b.c".to_owned())), 1),
        (Some(RequestCredential::Jwt("a".repeat(40))), 8),
    ];
    let calls = requests
        .iter()
        .map(|(requested, length)| {
            ask(
                &client,
                (pattern(*length), requested.as_ref(), Some(&known)),
            )
        })
        .collect::<Vec<_>>();
    let refusal = failure_of(
        completed(ask(
            &client,
            (
                pattern(9),
                Some(&RequestCredential::Jwt("a".repeat(40))),
                Some(&known),
            ),
        ))
        .await,
    );
    assert_eq!(refusal.code(), ProtocolCode::PAYLOAD_TOO_LARGE.get());
    assert_eq!(refusal.side(), Some(RouterSide::Client));
    assert_eq!(
        refusal.detail(),
        "a payload of 9 bytes goes as a transfer, whose opening's header of 64 bytes leaves it no byte within 64"
    );
    assert!(refusal.header().is_some());
    assert!(!format!("{refusal:?}").contains(&"a".repeat(40)));
    assert_eq!(
        client
            .sent()
            .await
            .iter()
            .map(|(_, envelope)| {
                let Envelope::Request { header, .. } = envelope else {
                    panic!("a request expected: {envelope:?}")
                };
                assert_eq!(
                    (
                        header.service_id,
                        header.procedure_id,
                        header.destination_id,
                        header.total,
                        header.opens_subscription,
                        header.paced
                    ),
                    (2, 1, None, None, false, false)
                );
                (header.call_id, header.credential.clone())
            })
            .collect::<Vec<_>>(),
        [
            (1, Some(Credential::Opaque(known))),
            (3, None),
            (5, None),
            (7, Some(Credential::Jwt(Bytes::from_static(b"a.b.c")))),
            (9, Some(Credential::Jwt(Bytes::from(vec![b'a'; 40]))))
        ]
    );
    client
        .owner
        .run(router_core::dispose)
        .await
        .expect("disposed");
    for call in calls {
        assert!(matches!(
            completed(call).await,
            Err(CallError::Disconnected(_))
        ));
    }
    quiet(&client).await;
}

// spec 4.4, 12.3
#[tokio::test]
async fn a_jwt_its_header_holds_whole_fails_its_call_before_it_goes_payload_too_large_once_a_transfers_header_would_pass_1020_bytes_and_goes_as_a_transfer_a_word_shorter()
 {
    let peer = Peer::new(RouterSide::Client, &RouterLimitsOptions::default());
    let payload = pattern(1_048_576);
    let ask = |length, (destination_id, payload)| {
        let mut request = request_of("a");
        request.credential = Some(Credential::Jwt(Bytes::from(vec![b'x'; length])));
        request.options.destination_id = destination_id;
        peer.request((payload, request))
    };
    for (length, destination, opening) in [
        (1_004, None, 1_028),
        (997, None, 1_024),
        (1_000, Some(7), 1_028),
        (993, Some(7), 1_024),
    ] {
        let failure = failure_of(completed(ask(length, (destination, payload.clone()))).await);
        assert_eq!(failure.code(), ProtocolCode::PAYLOAD_TOO_LARGE.get());
        assert_eq!(failure.side(), Some(RouterSide::Client));
        assert_eq!(
            failure.detail(),
            format!(
                "a payload of 1048576 bytes goes as a transfer, whose opening's header of {opening} bytes passes 1020"
            )
        );
    }
    assert_eq!(peer.sent().await.len(), 0);
    let calls = [
        ask(996, (None, payload.clone())),
        ask(992, (Some(7), payload)),
        ask(1_004, (None, Bytes::from_static(&[1]))),
    ];
    peer.settle().await;
    assert_eq!(
        peer.sent()
            .await
            .iter()
            .map(|(_, envelope)| {
                let Envelope::Request { header, payload } = envelope else {
                    panic!("a request expected: {envelope:?}")
                };
                let Some(Credential::Jwt(token)) = &header.credential else {
                    panic!("a JWT expected")
                };
                (
                    token.len(),
                    header.destination_id,
                    header.total,
                    payload.len(),
                )
            })
            .collect::<Vec<_>>(),
        [
            (996, None, Some(1_048_576), 1_047_556),
            (992, Some(7), Some(1_048_576), 1_047_556),
            (1_004, None, None, 1)
        ]
    );
    peer.owner
        .run(router_core::dispose)
        .await
        .expect("disposed");
    for call in calls {
        assert!(matches!(
            completed(call).await,
            Err(CallError::Disconnected(_))
        ));
    }
    quiet(&peer).await;
}
