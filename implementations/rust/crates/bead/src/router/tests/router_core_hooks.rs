//! What the core hands its side: notifications, paced credits and redacted envelope traces.

use std::sync::Arc;

use bytes::Bytes;

use super::token;
use crate::constants::{CredentialScheme, EnvelopeKind, ProtocolCode, RouterSide};
use crate::debug::DebugDirection;
use crate::envelope::{
    Credential, CreditHeader, Envelope, Header, NotificationHeader, ResultHeader,
};
use crate::router::core::{self as router_core, Handler};
use crate::router::types::{RouterAnswer, RouterError, RouterLimitsOptions};
use crate::testing::core_port::{Peer, completed, scripted_header};

// spec 11.1
#[tokio::test]
async fn hands_a_notification_to_the_side_that_takes_them_and_reports_it_where_none_does() {
    let taking = Peer::new(RouterSide::Client, &RouterLimitsOptions::default());
    let refusing = Peer::new(RouterSide::Client, &RouterLimitsOptions::default());
    taking
        .owner
        .run(|state| {
            state.takes_notifications = true;
        })
        .await
        .expect("notifications taken");
    let notification = Envelope::Notification {
        header: NotificationHeader { call_id: 41 },
        payload: Bytes::from_static(&[1]),
    };
    taking.receive((notification.clone(), Arc::from("b")));
    refusing.receive((notification, Arc::from("b")));
    taking.settle().await;
    refusing.settle().await;
    taking
        .owner
        .run(|state| {
            assert_eq!(
                state.notifications,
                [(
                    Arc::from("b"),
                    NotificationHeader { call_id: 41 },
                    Bytes::from_static(&[1])
                )]
            );
            assert!(state.reports.is_empty());
        })
        .await
        .expect("the side checked");
    refusing.owner.run(|state| {
        assert_eq!(state.reports.len(), 1);
        assert!(matches!(&state.reports[0], (handle, RouterError::Failure(failure)) if handle.as_ref() == "b" && failure.code() == ProtocolCode::KIND_UNSUPPORTED.get()));
        assert_eq!(state.sent, []);
    }).await.expect("the refusal checked");
}

// spec 11.3, 12.3
#[tokio::test]
async fn hands_a_credit_of_notifications_to_the_side_that_paces_them_a_transfers_to_its_transfer_and_reports_it_where_none_does()
 {
    let pacing = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let refusing = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    pacing
        .owner
        .run(|state| {
            state.sends_notifications = true;
        })
        .await
        .expect("notifications paced");
    let header = CreditHeader {
        call_id: 41,
        credit_end: 3,
        paced: true,
    };
    pacing.receive((
        Envelope::Credit {
            header: header.clone(),
        },
        Arc::from("b"),
    ));
    pacing.receive((
        Envelope::Credit {
            header: CreditHeader {
                call_id: 41,
                credit_end: 5,
                paced: false,
            },
        },
        Arc::from("b"),
    ));
    refusing.receive((
        Envelope::Credit {
            header: header.clone(),
        },
        Arc::from("b"),
    ));
    pacing.settle().await;
    refusing.settle().await;
    pacing
        .owner
        .run(move |state| {
            assert_eq!(state.credits, [(Arc::from("b"), header)]);
            assert!(state.reports.is_empty());
            assert_eq!(state.sent, []);
        })
        .await
        .expect("the pacing checked");
    refusing.owner.run(|state| {
        assert_eq!(state.reports.len(), 1);
        assert!(matches!(&state.reports[0], (handle, RouterError::Failure(failure)) if handle.as_ref() == "b" && failure.code() == ProtocolCode::KIND_UNSUPPORTED.get() && failure.to_string().contains("this side sends no notification")));
        assert_eq!(state.sent, []);
    }).await.expect("the refusal checked");
}

// debugging 5.1
#[tokio::test]
async fn trace_what_goes_out_and_what_comes_in_without_its_credential_its_scheme_alone() {
    for answer_first in [false, true] {
        let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
        peer.owner
            .run(|state| {
                state.tokens.insert(Arc::from("a"), token());
                router_core::register_resolver(
                    &state.core.resolvers,
                    (
                        &crate::testing::pair::echo(),
                        Handler {
                            resolve: Arc::new(|_| Box::pin(async { Ok(()) })),
                            admit: None,
                            maximum_payload_bytes: None,
                            forwards_credentials: false,
                            notifies: false,
                        },
                        None,
                    ),
                )
                .expect("echo registered");
            })
            .await
            .expect("the port ready");
        if answer_first {
            completed(peer.respond((
                RouterAnswer::Result(Bytes::new()),
                crate::router::types::CallAddress {
                    call_id: 1,
                    connection_handle: Arc::from("a"),
                },
            )))
            .await
            .expect("answered");
        }
        let call_id = if answer_first { 3 } else { 1 };
        peer.receive((
            Envelope::Request {
                header: crate::envelope::RequestHeader {
                    credential: Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
                    ..scripted_header(call_id)
                },
                payload: Bytes::from_static(&[1]),
            },
            Arc::from("a"),
        ));
        peer.settle().await;
        peer.owner.run(move |state| {
            let mut expected = Vec::new();
            if answer_first {
                expected.push((DebugDirection::Tx, "a", EnvelopeKind::Result, 1, Some(CredentialScheme::OPAQUE)));
            }
            expected.push((DebugDirection::Rx, "a", EnvelopeKind::Request, call_id, Some(CredentialScheme::JWT)));
            expected.push((DebugDirection::Tx, "a", EnvelopeKind::Failure, call_id, if answer_first { None } else { Some(CredentialScheme::OPAQUE) }));
            assert_eq!(state.traces.iter().map(|(direction, traced)| (*direction, traced.connection_handle.as_ref(), traced.header.kind(), traced.header.call_id(), traced.credential_scheme)).collect::<Vec<_>>(), expected);
            let request = &state.traces[usize::from(answer_first)].1.header;
            assert_eq!(request, &Header::Request(scripted_header(call_id)));
            assert!(state.traces.iter().all(|(_, traced)| traced.header.credential().is_none()), "a trace carries the credential's scheme alone, with no token");
            assert!(!format!("{:?}", state.traces).contains("a.b.c"));
            assert!(!format!("{:?}", state.traces).contains(&token().to_string()));
            assert_eq!(state.sent[0].1.kind(), if answer_first { EnvelopeKind::Result } else { EnvelopeKind::Failure });
            assert!(matches!(state.sent[0].1.header(), Header::Result(ResultHeader { credential: Some(Credential::Opaque(announced)), .. }) | Header::Failure(crate::envelope::FailureHeader { credential: Some(Credential::Opaque(announced)), .. }) if announced == token()));
        }).await.expect("the traces checked");
    }
}
