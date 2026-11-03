//! A direct resolver asks its own admission with the router's handle and its call's session.

use core::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use serde_json::json;

use super::admissions::handler;
use super::{Fixture, Recording, header, locked, props};
use crate::clock::SharedClock;
use crate::constants::{ProtocolCode, RouterSide};
use crate::failure::Failure;
use crate::managers::service::ResolverDependencies;
use crate::managers::sessions::{SessionManager, SessionManagerOptions};
use crate::payloads::{JsonCodec, TextCodec};
use crate::router::admissions::BeforeRequest;
use crate::router::core::{AdmissionRequest, ResolverProps};
use crate::router::types::{CallSession, RouterAnswer};
use crate::testing::pair::echo;
use crate::testing::scripted::handle_of;
use crate::testing::sessions::NeverArming;

#[tokio::test]
async fn a_routers_own_handle_type_reaches_the_callback_for_the_session_manager_to_take() {
    let fixture = Fixture::new();
    let connection = handle_of(1);
    let clock: SharedClock = Arc::<crate::testing::SteppingClock>::clone(&fixture.clock);
    let mut sessions = SessionManager::new(&SessionManagerOptions {
        clock: Some(clock),
        ..SessionManagerOptions::default()
    })
    .expect("sessions on the router's clock");
    sessions
        .get_or_else_set(&connection, (&NeverArming, &mut Vec::new()))
        .expect("the router's handle stores a session");
    let mut dependencies = ResolverDependencies::of(TextCodec, TextCodec);
    let admissions = Arc::new(AtomicUsize::new(0));
    let admitting = Arc::clone(&admissions);
    dependencies.before_request = Some(BeforeRequest::new(
        move |request| {
            admitting.fetch_add(1, Ordering::SeqCst);
            sessions.has(&request.connection_handle)
        },
        None,
    ));
    let expected = Arc::clone(&connection);
    fixture
        .manager
        .get_request_resolver(&echo(), dependencies)
        .expect("echo defined")
        .on(Arc::new(move |request, response| {
            assert!(Arc::ptr_eq(&request.connection_handle, &expected));
            response.result(request.payload)
        }))
        .expect("echo registered");
    let recording = Arc::new(Recording::default());
    let request = ResolverProps {
        is_admitted: false,
        connection_handle: connection,
        ..props(&recording, b"hi")
    };
    (handler(&fixture, 1).await.resolve)(request)
        .await
        .expect("self-admitted by its session");
    assert_eq!(admissions.load(Ordering::SeqCst), 1);
    assert_eq!(
        recording.answers(),
        [RouterAnswer::Result(Bytes::from_static(b"hi"))]
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn self_admission_and_callbacks_keep_the_session_values_the_caller_hands_them() {
    let fixture = Fixture::new();
    let ada = Arc::new(CallSession {
        data: Some(json!("ada")),
        ..CallSession::default()
    });
    let bob = Arc::new(CallSession {
        data: Some(json!("bob")),
        ..CallSession::default()
    });
    let read = Arc::new(Mutex::new(Vec::new()));
    let reading = Arc::clone(&read);
    let mut dependencies = ResolverDependencies::of(JsonCodec, JsonCodec);
    dependencies.before_request = Some(BeforeRequest::new(
        move |request| {
            locked(&reading).push(("admission", request.session.clone()));
            request.session.is_some()
        },
        None,
    ));
    let reading = Arc::clone(&read);
    fixture
        .manager
        .get_request_resolver(&echo(), dependencies)
        .expect("echo defined")
        .on(Arc::new(move |request, response| {
            locked(&reading).push(("callback", request.session.clone()));
            response.result(request.payload)
        }))
        .expect("echo registered");
    let resolver = handler(&fixture, 1).await;
    assert!(
        resolver.admit.as_ref().expect("admission")(&AdmissionRequest {
            connection_handle: handle_of(1),
            header: header(),
            session: Some(Arc::clone(&ada)),
            carried: None,
        })
        .expect("admitted")
        .is_none()
    );
    let recording = Arc::new(Recording::default());
    for (is_admitted, session) in [
        (true, Some(Arc::clone(&ada))),
        (false, Some(Arc::clone(&ada))),
        (false, None),
    ] {
        (resolver.resolve)(ResolverProps {
            is_admitted,
            session,
            ..props(&recording, br#"{"text":"hi"}"#)
        })
        .await
        .expect("each call answered");
    }
    assert_eq!(
        *locked(&read),
        [
            ("admission", Some(Arc::clone(&ada))),
            ("callback", Some(Arc::clone(&ada))),
            ("admission", Some(Arc::clone(&ada))),
            ("callback", Some(Arc::clone(&ada))),
            ("admission", None),
        ]
    );
    assert_eq!(
        recording.answers(),
        [
            RouterAnswer::Result(Bytes::from_static(br#"{"text":"hi"}"#)),
            RouterAnswer::Result(Bytes::from_static(br#"{"text":"hi"}"#)),
            RouterAnswer::Failure(
                Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server).record()
            ),
        ]
    );

    permissive_sessions(&fixture, (ada, bob)).await;
    fixture.router.dispose().await;
}

async fn permissive_sessions(fixture: &Fixture, (ada, bob): (Arc<CallSession>, Arc<CallSession>)) {
    let recording = Arc::new(Recording::default());
    let admitted = Arc::new(Mutex::new(Vec::new()));
    let received = Arc::new(Mutex::new(Vec::new()));
    let reading = Arc::clone(&admitted);
    let mut dependencies = ResolverDependencies::of(JsonCodec, JsonCodec);
    dependencies.before_request = Some(BeforeRequest::new(
        move |request| {
            locked(&reading).push(request.session.clone());
            true
        },
        None,
    ));
    let reading = Arc::clone(&received);
    fixture
        .manager
        .get_request_resolver(
            &crate::identity::Procedure {
                id: 2,
                name: "permissive".to_owned(),
                ..echo()
            },
            dependencies,
        )
        .expect("permissive defined")
        .on(Arc::new(move |request, response| {
            locked(&reading).push(request.session.clone());
            response.result(request.payload)
        }))
        .expect("permissive registered");
    let resolver = handler(fixture, 2).await;
    for (is_admitted, session) in [
        (false, Some(Arc::clone(&ada))),
        (false, None),
        (true, Some(Arc::clone(&bob))),
    ] {
        (resolver.resolve)(ResolverProps {
            is_admitted,
            session,
            header: crate::envelope::RequestHeader {
                procedure_id: 2,
                ..header()
            },
            ..props(&recording, br#"{"text":"hi"}"#)
        })
        .await
        .expect("permissive answered");
    }
    assert_eq!(*locked(&admitted), [Some(Arc::clone(&ada)), None]);
    assert_eq!(*locked(&received), [Some(ada), None, Some(bob)]);
}
