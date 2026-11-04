//! Sessions end without their connection, which follows the server's own inactivity policy.

use core::time::Duration;
use std::sync::Arc;

use super::{Credential, Envelope, Fixture, ProtocolCode, ServerOptions, locked};
use crate::NotifyOptions;
use crate::envelope::FailureHeader;
use crate::managers::sessions::SessionEvent;

fn milliseconds(count: u64) -> Duration {
    Duration::from_millis(count)
}

#[tokio::test]
async fn a_session_unused_past_its_timeout_ends_and_its_connection_stays() {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.sessions((Some(crate::duration::NEVER), Some(milliseconds(40))));
    fixture.ask(1, (1, None)).await;
    assert!(
        fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    assert_eq!(fixture.clock.dues(), [milliseconds(40)]);

    fixture.advance(40).await;

    assert!(
        !fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    assert_eq!(fixture.clock.dues(), []);
    assert_eq!(fixture.transport.closed(), []);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_session_that_ended_leaves_its_connection_the_servers_own_timeout_counted_from_its_end() {
    let fixture = Fixture::idle(60);
    fixture.sessions((Some(milliseconds(100)), Some(milliseconds(30))));
    fixture.ask(1, (1, None)).await;
    let mut dues = fixture.clock.dues();
    dues.sort_unstable();
    assert_eq!(dues, [milliseconds(30), milliseconds(100)]);

    fixture.advance(30).await;
    assert!(
        !fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    assert_eq!(fixture.transport.closed(), []);
    assert_eq!(fixture.clock.dues(), [milliseconds(60)]);
    fixture.advance(59).await;
    assert_eq!(fixture.transport.closed(), []);
    fixture.advance(1).await;
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_session_that_ended_takes_its_connections_subscriptions_nothing_more_reaches_it() {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.sessions((Some(crate::duration::NEVER), Some(milliseconds(30))));
    let news = fixture.news();
    fixture.ask(1, (1, None)).await;
    fixture.subscribe(3, None).await;
    let candidates = fixture
        .server
        .router()
        .owner()
        .run(|state| {
            state
                .notifications
                .candidates(super::procedure(5).address())
        })
        .await
        .expect("candidates observed");
    assert_eq!(
        candidates
            .iter()
            .map(|held| Arc::clone(&held.connection_handle))
            .collect::<Vec<_>>(),
        [Arc::clone(&fixture.first)]
    );
    assert_eq!(fixture.clock.dues(), [milliseconds(30)]);

    fixture.advance(30).await;

    let sent = fixture.transport.envelopes(&fixture.first);
    let Some(Envelope::Failure { header, failure }) = sent.last() else {
        panic!("the session's end ends its subscription");
    };
    assert_eq!(
        header,
        &FailureHeader {
            call_id: 3,
            credential: Some(Credential::None)
        }
    );
    assert_eq!(failure.code, ProtocolCode::SESSION_REQUIRED.get());
    let before = fixture.transport.sent().len();
    news.notify("flash".to_owned(), &NotifyOptions::default())
        .await;
    fixture.clock.settle().await;
    assert_eq!(fixture.transport.sent().len(), before);
    assert!(
        !fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    assert_eq!(
        fixture
            .server
            .router()
            .owner()
            .run(|state| state.notifications.subscriptions(None))
            .await
            .expect("subscriptions observed"),
        []
    );
    assert_eq!(fixture.transport.closed(), []);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_connection_that_never_opens_a_session_is_closed_once_silent_when_the_server_says_how_long()
 {
    let told = Fixture::idle(60);
    let quiet = Fixture::new(&ServerOptions::default());
    told.open().await;
    quiet.open().await;
    assert_eq!(told.clock.dues(), [milliseconds(60)]);
    assert_eq!(quiet.clock.dues(), []);
    told.ask(1, (99, None)).await;
    assert_eq!(told.clock.dues(), [milliseconds(60)]);
    assert_eq!(told.transport.closed(), []);
    told.advance(60).await;
    quiet.advance(60).await;
    assert_eq!(told.transport.closed(), [Arc::clone(&told.first)]);
    assert_eq!(quiet.transport.closed(), []);
    assert_eq!(told.server.sessions().all().await, []);
    assert_eq!(quiet.server.sessions().all().await, []);
    told.server.dispose().await.expect("disposed");
    quiet.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn closes_a_session_s_connection_silent_past_its_connection_timeout_unless_it_speaks() {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.open().await;
    fixture.sessions((Some(milliseconds(2_000)), None));
    let sessions = fixture.server.sessions();
    let mut session = sessions.create(Arc::clone(&fixture.first));
    session.connection_inactivity_timeout = Some(milliseconds(2_000));
    sessions
        .set(session)
        .expect("a valid session")
        .await
        .expect("stored");
    fixture.advance(1_500).await;
    fixture.ask(1, (2, None)).await;
    fixture.advance(1_500).await;
    assert_eq!(fixture.transport.closed(), []);
    fixture.advance(500).await;
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn closes_a_connection_without_a_session_silent_past_the_server_s_own_timeout() {
    let fixture = Fixture::idle(3_000);
    fixture.open().await;
    fixture.advance(2_000).await;
    fixture.ask(1, (2, None)).await;
    fixture.advance(2_000).await;
    assert_eq!(fixture.transport.closed(), []);
    fixture.advance(1_000).await;
    assert_eq!(fixture.transport.closed(), [Arc::clone(&fixture.first)]);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_connection_that_never_opens_a_session_is_never_closed_when_the_server_says_nothing() {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.open().await;
    fixture.advance(86_400_000).await;
    fixture.ask(1, (99, None)).await;
    fixture.advance(86_400_000).await;
    assert_eq!(fixture.transport.closed(), []);
    assert_eq!(fixture.server.sessions().all().await, []);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn ends_at_once_a_session_stored_for_a_connection_already_closed_and_with_a_connection_that_closes()
 {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.open().await;
    let sessions = fixture.server.sessions();
    sessions
        .set(sessions.create(Arc::clone(&fixture.first)))
        .expect("a valid session")
        .await
        .expect("stored");
    fixture.transport.close_connection(&fixture.first);
    fixture.clock.settle().await;
    assert!(!sessions.has(Arc::clone(&fixture.first)).await);
    sessions
        .set(sessions.create(Arc::clone(&fixture.first)))
        .expect("a valid session")
        .await
        .expect("taken");
    assert!(!sessions.has(Arc::clone(&fixture.first)).await);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn removing_every_listener_does_not_unhook_the_timers() {
    let fixture = Fixture::new(&ServerOptions::default());
    fixture.open().await;
    let sessions = fixture.server.sessions();
    let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
    let hearing = Arc::clone(&heard);
    let listener = sessions.on(Arc::new(move |event| locked(&hearing).push(event.clone())));
    let mut session = sessions
        .set(sessions.create(Arc::clone(&fixture.first)))
        .expect("a valid session")
        .await
        .expect("stored");
    sessions.off(listener);
    session.connection_inactivity_timeout = Some(milliseconds(20));
    sessions
        .update_connection_inactivity_timeout(session)
        .expect("a held timeout")
        .await
        .expect("a session");
    let reached = Arc::new(std::sync::Mutex::new(Vec::new()));
    let hearing = Arc::clone(&reached);
    sessions.on(Arc::new(move |event| {
        if let SessionEvent::ConnectionInactivityTimeoutReached(session) = event {
            locked(&hearing).push(session.clone());
        }
    }));
    fixture.advance(19).await;
    assert_eq!(locked(&reached).len(), 0);
    fixture.advance(1).await;
    assert_eq!(locked(&reached).len(), 1);
    assert_eq!(locked(&reached)[0].connection_handle, fixture.first);
    assert_eq!(locked(&heard).len(), 1);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_session_stored_once_its_connection_closed_goes_at_once_and_a_new_connection_of_that_handle_has_none()
 {
    let fixture = Fixture::new(&ServerOptions::default());
    let sessions = fixture.server.sessions().clone();
    let gate = tokio_util::sync::CancellationToken::new();
    let waiting = gate.clone();
    let finished = tokio_util::sync::CancellationToken::new();
    let finishing = finished.clone();
    fixture
        .server
        .services()
        .get_request_resolver(
            &super::procedure(1),
            crate::RequestResolverDependencies::new(crate::TextCodec, crate::TextCodec),
        )
        .expect("openSession declared")
        .on(Arc::new(move |request, response| {
            let (sessions, waiting, finishing) =
                (sessions.clone(), waiting.clone(), finishing.clone());
            Box::pin(async move {
                waiting.cancelled().await;
                let stored = sessions
                    .set(sessions.create(request.connection_handle))
                    .expect("a valid session")
                    .await;
                finishing.cancel();
                stored.map_err(crate::ResolverError::other)?;
                response.result(String::new()).await
            })
        }))
        .expect("registered");
    fixture.ask(1, (1, None)).await;
    fixture.transport.close_connection(&fixture.first);
    gate.cancel();
    crate::testing::patience(Duration::from_secs(10), finished.cancelled())
        .await
        .expect("the resolver finishes");
    fixture.clock.settle().await;
    assert_eq!(fixture.server.sessions().all().await, []);
    fixture.open().await;
    assert!(
        !fixture
            .server
            .sessions()
            .has(Arc::clone(&fixture.first))
            .await
    );
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn a_resolver_that_finishes_after_dispose_stores_nothing() {
    let fixture = Fixture::new(&ServerOptions::default());
    let sessions = fixture.server.sessions().clone();
    let gate = tokio_util::sync::CancellationToken::new();
    let waiting = gate.clone();
    let (finish, finished) = tokio::sync::oneshot::channel();
    let finish = Arc::new(std::sync::Mutex::new(Some(finish)));
    let entering = tokio_util::sync::CancellationToken::new();
    let entered = entering.clone();
    fixture
        .server
        .services()
        .get_request_resolver(
            &crate::Procedure {
                service_id: 2,
                procedure_id: 1,
                procedure_name: "gated".to_owned(),
                service_revision: 1,
                procedure_kind: None,
                maximum_payload_bytes: None,
                deprecation: None,
            },
            crate::RequestResolverDependencies::new(crate::JsonCodec, crate::JsonCodec),
        )
        .expect("gated declared")
        .on(Arc::new(move |request, _| {
            let (sessions, waiting, finish) =
                (sessions.clone(), waiting.clone(), Arc::clone(&finish));
            entered.cancel();
            Box::pin(async move {
                waiting.cancelled().await;
                let stored = sessions
                    .set(sessions.create(request.connection_handle))
                    .expect("a valid session")
                    .await;
                let disconnected = matches!(stored, Err(crate::CallError::Disconnected(_)));
                locked(&finish)
                    .take()
                    .expect("one request")
                    .send(disconnected)
                    .expect("the outcome heard");
                Ok(())
            })
        }))
        .expect("registered");
    fixture.open().await;
    fixture.transport.deliver(
        &Envelope::Request {
            header: crate::RequestHeader {
                call_id: 1,
                service_id: 2,
                procedure_id: 1,
                credential: None,
                destination_id: None,
                opens_subscription: false,
                paced: false,
                total: None,
            },
            payload: bytes::Bytes::from_static(b"null"),
        },
        &fixture.first,
    );
    crate::testing::patience(Duration::from_secs(10), entering.cancelled())
        .await
        .expect("the resolver starts");
    fixture.server.dispose().await.expect("disposed");
    gate.cancel();
    assert!(
        crate::testing::patience(Duration::from_secs(10), finished)
            .await
            .expect("the resolver finishes")
            .expect("the outcome heard")
    );
    assert_eq!(fixture.server.sessions().all().await, []);
}
