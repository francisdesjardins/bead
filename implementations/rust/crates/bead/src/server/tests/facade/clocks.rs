//! Every layer of a server runs on its transport's clock: its router and its sessions are built on
//! it, and a server given another is refused, leaving nothing on its transport.

use core::time::Duration;
use std::sync::Arc;

use super::{Fixture, ServerOptions};
use crate::clock::{SharedClock, SystemClock, SystemClockOptions};
use crate::managers::sessions::SessionManagerOptions;
use crate::server::Server;
use crate::testing::SteppingClock;
use crate::testing::scripted::ScriptedServer;
use crate::transport::ServerTransport;

fn system() -> SharedClock {
    Arc::new(SystemClock::new(&SystemClockOptions::default()).expect("a system clock"))
}

fn stepping() -> SharedClock {
    SteppingClock::new(crate::testing::instants::new_year())
}

fn refusal_of(transport: &Arc<ScriptedServer>, options: &ServerOptions) -> String {
    let wire: Arc<dyn ServerTransport> = Arc::<ScriptedServer>::clone(transport);

    Server::new(wire, options)
        .expect_err("a server on another clock")
        .to_string()
}

#[tokio::test]
async fn runs_every_layer_on_its_transport_s_clock_the_sessions_are_built_with_it_and_a_layer_on_another_is_refused_leaving_nothing_on_its_transport()
 {
    let fixture = Fixture::new(&ServerOptions {
        sessions: Some(SessionManagerOptions {
            session_inactivity_timeout: Some(Duration::from_millis(20)),
            ..SessionManagerOptions::default()
        }),
        ..ServerOptions::default()
    });
    let clock: SharedClock = Arc::<SteppingClock>::clone(&fixture.clock);
    assert!(Arc::ptr_eq(&fixture.server.router().clock(), &clock));

    // * the sessions time a session on it: 20 ms of the transport's clock, their default, end it
    fixture.open().await;
    let sessions = fixture.server.sessions();
    let mut session = sessions.create(Arc::clone(&fixture.first));
    session.session_inactivity_timeout = None;
    sessions
        .set(session)
        .expect("a session")
        .await
        .expect("stored");
    fixture.advance(19).await;
    assert!(sessions.has(Arc::clone(&fixture.first)).await, "19 ms");
    fixture.advance(1).await;
    assert!(!sessions.has(Arc::clone(&fixture.first)).await, "20 ms");

    // the transport's own clock, given, is the one it runs on
    let own = ScriptedServer::new(Arc::clone(&clock));
    let wire: Arc<dyn ServerTransport> = Arc::<ScriptedServer>::clone(&own);
    let given = Server::new(
        wire,
        &ServerOptions {
            clock: Some(Arc::clone(&clock)),
            ..ServerOptions::default()
        },
    )
    .expect("the clock of its transport");
    assert!(Arc::ptr_eq(&given.router().clock(), &clock));
    given.dispose().await.expect("disposed");

    let listening = fixture.transport.listener_count();
    assert_eq!(
        refusal_of(
            &fixture.transport,
            &ServerOptions {
                clock: Some(stepping()),
                ..ServerOptions::default()
            }
        ),
        "a server runs on the clock of its transport, one of its own, and was given another, one of its own"
    );
    assert_eq!(
        refusal_of(
            &fixture.transport,
            &ServerOptions {
                sessions: Some(SessionManagerOptions {
                    clock: Some(system()),
                    ..SessionManagerOptions::default()
                }),
                ..ServerOptions::default()
            }
        ),
        "a server's session manager runs on the clock of its server, one of its own, and was given another, the platform's"
    );
    let elsewhere = ScriptedServer::new(stepping());
    assert_eq!(
        refusal_of(
            &elsewhere,
            &ServerOptions {
                clock: Some(clock),
                ..ServerOptions::default()
            }
        ),
        "a server runs on the clock of its transport, one of its own, and was given another, one of its own"
    );

    // the server built on it is the one listening: the refused ones let go
    assert_eq!(fixture.transport.listener_count(), listening);
    assert_eq!(elsewhere.listener_count(), 0);
    fixture.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn builds_its_sessions_with_their_own_options_on_its_transport_s_clock() {
    let fixture = Fixture::new(&ServerOptions {
        sessions: Some(SessionManagerOptions {
            session_inactivity_timeout: Some(Duration::from_secs(3)),
            ..SessionManagerOptions::default()
        }),
        ..ServerOptions::default()
    });
    fixture.open().await;
    let sessions = fixture.server.sessions();
    let mut session = sessions.create(Arc::clone(&fixture.first));
    session.session_inactivity_timeout = None;
    let stored = sessions
        .set(session)
        .expect("a session")
        .await
        .expect("stored");

    // the default of its own options, timed by the server's clock
    assert_eq!(
        stored.session_inactivity_timeout,
        Some(Duration::from_secs(3))
    );
    fixture.advance(3_000).await;
    assert!(!sessions.has(Arc::clone(&fixture.first)).await);
    fixture.server.dispose().await.expect("disposed");
}
