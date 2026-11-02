//! A command's credential is checked before any envelope leaves its connection.

use std::sync::Arc;

use bytes::Bytes;

use super::server::{Served, first, second};
use super::{answered, options_of};
use crate::constants::ProtocolCode;
use crate::envelope::{Credential, Envelope};
use crate::errors::{CallError, ProgrammerError};
use crate::failure::FailureOrigin;
use crate::router::server::{Call, CallHooks, RouterServerOptions, ServerRequest};
use crate::router::types::{ConnectionHandle, RequestCredential};
use crate::testing::pair::echo;
use crate::testing::scripted::handle_of;

const CARRIED: &str = " \tInterop sub=ada";

fn command(
    served: &Served,
    (handle, credential): (ConnectionHandle, RequestCredential),
) -> Result<Call, ProgrammerError> {
    let mut options = options_of(super::TIMEOUT);
    options.connection_handle = Some(handle);
    options.credential = Some(credential);
    served.router.request(
        Bytes::new(),
        (
            ServerRequest {
                procedure: echo().address(),
                maximum_payload_bytes: None,
                options,
                series: None,
                refusal: None,
            },
            CallHooks::default(),
        ),
    )
}

#[tokio::test]
async fn fails_a_command_presenting_elsewhere_over_a_transport_that_carries_none_and_a_jwt_command_over_one_not_secure_before_they_go_destination_unreachable()
 {
    let served = Served::new(&RouterServerOptions::default());
    let third = handle_of(3);
    for handle in [first(), second(), Arc::clone(&third)] {
        served.transport.open(&handle, true);
    }
    served.transport.secure(&first(), true);
    served.transport.carry(&second(), true);
    served.transport.secure(&third, true);
    served.transport.carry(&third, true);
    for (handle, credential) in [
        (first(), RequestCredential::Elsewhere(CARRIED.to_owned())),
        (second(), RequestCredential::Jwt("a.b.c".to_owned())),
        (second(), RequestCredential::Elsewhere(CARRIED.to_owned())),
    ] {
        let call = command(&served, (handle, credential)).expect("a valid credential");
        served.settle().await;
        let error = answered(call).await.expect_err("the transport refuses");
        assert!(matches!(error, CallError::Failure(failure)
            if failure.code() == ProtocolCode::DESTINATION_UNREACHABLE.get()
                && failure.origin() == FailureOrigin::Local));
    }
    assert_eq!(served.transport.take(), Vec::new());

    let jwt = command(
        &served,
        (first(), RequestCredential::Jwt("a.b.c".to_owned())),
    )
    .expect("a JWT goes on a secure connection");
    let elsewhere = command(
        &served,
        (
            Arc::clone(&third),
            RequestCredential::Elsewhere(CARRIED.to_owned()),
        ),
    )
    .expect("an ELSEWHERE goes where it is carried");
    served.settle().await;
    let sent = served.transport.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(
        sent.iter()
            .map(|(_, message)| message.credential.as_deref())
            .collect::<Vec<_>>(),
        [None, Some(CARRIED)]
    );
    let envelopes = served.transport.take();
    for ((handle, envelope), (expected_handle, credential, call_id)) in envelopes.iter().zip([
        (first(), Credential::Jwt(Bytes::from_static(b"a.b.c")), 2),
        (third, Credential::Elsewhere, 4),
    ]) {
        let Envelope::Request { header, payload } = envelope else {
            panic!("a command")
        };
        assert_eq!(*handle, expected_handle);
        assert_eq!(header.call_id, call_id);
        assert_eq!(header.credential, Some(credential));
        assert!(payload.is_empty());
    }
    served.router.dispose().await;
    for call in [jwt, elsewhere] {
        assert!(matches!(
            answered(call).await,
            Err(CallError::Disconnected(_))
        ));
    }
    assert_eq!(served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn refuses_a_command_presenting_a_jwt_with_no_token_an_elsewhere_that_gives_nothing_for_its_transport_to_carry_or_a_scheme_to_come_as_a_programmers_error_nothing_sent()
 {
    let served = Served::new(&RouterServerOptions::default());
    served.transport.open(&first(), true);
    served.transport.secure(&first(), true);
    served.transport.carry(&first(), true);
    // RequestCredential is closed and Elsewhere holds a String: neither a scheme to come nor a
    // missing carried value can be passed. An empty string is a value on all three sides.
    command(&served, (first(), RequestCredential::Jwt(String::new())))
        .expect_err("a JWT gives a token");
    served.settle().await;
    assert_eq!(served.transport.take(), Vec::new());
    assert_eq!(served.reported(), Vec::<String>::new());
    served.router.dispose().await;
}
