//! A connection's end rejects its waiting calls and forgets its session; a request on the
//! client's parity reaches no resolver and gets no answer.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{Scripted, TIMEOUT, answered, locked, request_header_of, request_of, result_of, token};
use crate::constants::ProcedureKind;
use crate::envelope::{Credential, Envelope};
use crate::errors::CallError;
use crate::identity::Procedure;
use crate::managers::service::{
    RequestDependencies, RequestOptions, ServiceManager, ServiceManagerOptions, ServiceRouter,
};
use crate::payloads::JsonCodec;
use crate::testing::pair::echo;

#[tokio::test]
async fn rejects_every_request_still_waiting_when_the_connection_closes() {
    let scripted = Scripted::new();
    scripted
        .transport
        .deliver(&result_of(9, Some(Credential::Opaque(token()))));
    let waiting = scripted
        .router
        .request(Bytes::new(), request_of((None, TIMEOUT)))
        .expect("waiting");
    scripted.settle().await;
    assert_eq!(scripted.router.session_token(), Some(token()));
    assert_eq!(
        scripted.transport.envelopes(),
        [Envelope::Request {
            header: request_header_of(1),
            payload: Bytes::new()
        }]
    );
    scripted.transport.close_connection();
    assert!(matches!(
        answered(waiting).await,
        Err(CallError::Disconnected(_))
    ));
    assert_eq!(scripted.router.session_token(), None);
    assert_eq!(scripted.codes(), ["CALL_UNKNOWN"]);
    scripted.router.dispose().await;
}

#[tokio::test]
async fn rejects_what_waits_once_its_connection_closed_and_forgets_its_session() {
    let scripted = Scripted::new();
    let services = ServiceManager::new(
        ServiceRouter::Client(scripted.router.clone()),
        &ServiceManagerOptions::default(),
    )
    .expect("services");
    let slow = Procedure {
        service_id: 1,
        procedure_id: 3,
        service_revision: 2,
        procedure_name: "slow".to_owned(),
        procedure_kind: Some(ProcedureKind::Request),
        maximum_payload_bytes: None,
        deprecation: None,
    };
    let requester = services
        .get_request(&slow, RequestDependencies::new(JsonCodec, JsonCodec))
        .expect("slow's requester");
    scripted
        .transport
        .deliver(&result_of(9, Some(Credential::Opaque(token()))));
    let waiting = requester
        .call(
            serde_json::json!({"milliseconds": 3_600_000}),
            &RequestOptions::default(),
        )
        .expect("waiting");
    scripted.settle().await;
    assert_eq!(scripted.router.session_token(), Some(token()));
    assert_eq!(
        scripted.transport.envelopes(),
        [Envelope::Request {
            header: crate::envelope::RequestHeader {
                service_id: 1,
                procedure_id: 3,
                ..request_header_of(1)
            },
            payload: Bytes::from_static(b"{\"milliseconds\":3600000}")
        }]
    );
    scripted.transport.close_connection();
    let refused = crate::testing::patience(super::PATIENCE, waiting)
        .await
        .expect("the disconnection settles");
    assert!(matches!(refused, Err(CallError::Disconnected(_))));
    assert_eq!(scripted.router.session_token(), None);
    assert_eq!(scripted.codes(), ["CALL_UNKNOWN"]);
    scripted.router.dispose().await;
}

#[tokio::test]
async fn of_the_clients_own_parity_are_reported_and_never_answered() {
    let scripted = Scripted::new();
    let handed = Arc::new(Mutex::new(Vec::new()));
    scripted
        .router
        .register_resolver((
            &Procedure {
                procedure_kind: Some(ProcedureKind::Command),
                ..echo()
            },
            super::client_commands::handler(super::keeping((&handed, None))),
        ))
        .expect("a resolver");
    scripted.transport.deliver(&Envelope::Request {
        header: request_header_of(31),
        payload: Bytes::new(),
    });
    scripted.settle().await;
    assert!(locked(&handed).is_empty());
    assert_eq!(
        scripted.transport.sent(),
        Vec::<crate::router::types::TransportMessage>::new()
    );
    assert_eq!(scripted.codes(), ["ENVELOPE_MALFORMED"]);
    scripted.router.dispose().await;
}
