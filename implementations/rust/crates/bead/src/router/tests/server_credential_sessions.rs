//! Credential sessions kept by subscriptions: their latest end, connection isolation, renewal
//! in the turn an end is reached, and their last subscription leaving.

use core::time::Duration;
use std::sync::Arc;

use super::{
    RouterServer, RouterServerOptions, ServerState, clean_tracked, gauges, held, register_tracked,
    resolved_session, unregister_tracked,
};
use crate::constants::ProtocolCode;
use crate::envelope::Envelope;
use crate::failure::ProcedureAddress;
use crate::managers::notification::SubscribingCall;
use crate::router::types::{CallSession, ConnectionHandle, SessionIdentifier};
use crate::testing::scripted::{ScriptedServer, handle_of};
use crate::testing::{SteppingClock, instants};

const NOW: i64 = 1_767_225_600_000;

fn first() -> ConnectionHandle {
    handle_of(1)
}
fn second() -> ConnectionHandle {
    handle_of(2)
}
fn grace() -> SessionIdentifier {
    SessionIdentifier::JwtSub {
        issuer: "https://issuer.example".to_owned(),
        sub: "grace".to_owned(),
    }
}
fn session(end: i64) -> CallSession {
    CallSession {
        data: Some(serde_json::json!("grace")),
        end: Some(end),
        identifier: Some(grace()),
    }
}

fn register(
    state: &mut ServerState,
    (id, handle, procedure, end, identifier): (
        u32,
        ConnectionHandle,
        u16,
        Option<i64>,
        Option<SessionIdentifier>,
    ),
) {
    register_tracked(
        state,
        (
            ProcedureAddress {
                service_id: 2,
                procedure_id: procedure,
            },
            &SubscribingCall {
                call_id: id,
                connection_handle: handle,
                end,
                identifier,
                paced: false,
                series: None,
            },
        ),
    )
    .expect("a subscription");
}
fn counts(state: &ServerState) -> (u64, u64) {
    let gauged = gauges(state);
    (
        gauged.counts["credentialSessions"],
        gauged.counts["timedCredentialSessions"],
    )
}

struct Sessions {
    router: RouterServer,
    clock: Arc<SteppingClock>,
    transport: Arc<ScriptedServer>,
}

#[tokio::test]
async fn times_an_end_past_a_timers_ceiling_in_steps_the_wall_clock_read_again_at_each_due_and_ends_it_at_once_once_reached_no_timer_armed()
 {
    use crate::duration::LONGEST_TIMER;

    let kept = Sessions::new().await;
    let span = Duration::from_mins(30 * 24 * 60 + 1);
    let end = NOW + i64::try_from(span.as_millis()).expect("thirty days fit");
    kept.router
        .owner()
        .run(move |state| {
            register(state, (1, first(), 5, Some(end), Some(grace())));
        })
        .await
        .expect("a distant end kept");
    assert_eq!(kept.clock.dues(), [LONGEST_TIMER]);
    kept.clock.advance(LONGEST_TIMER).await;
    let remaining = span.saturating_sub(LONGEST_TIMER);
    assert_eq!(kept.clock.dues(), [remaining]);
    assert_eq!(kept.ended(), Vec::new());
    kept.clock.wall_by(-1_000);
    kept.clock.advance(remaining).await;
    assert_eq!(kept.ended(), Vec::new());
    assert_eq!(kept.clock.dues(), [Duration::from_secs(1)]);
    kept.clock.advance(Duration::from_millis(999)).await;
    assert_eq!(kept.ended(), Vec::new());
    kept.clock.advance(Duration::from_millis(1)).await;
    assert_eq!(kept.ended(), [(first(), 1)]);
    assert_eq!(kept.clock.dues(), Vec::<Duration>::new());
    kept.router
        .owner()
        .run(move |state| {
            let reached = super::wall_milliseconds(state);
            register(state, (3, second(), 5, Some(reached), Some(grace())));
            assert_eq!(counts(state), (1, 0));
            assert_eq!(
                state.notifications.subscriptions(None).len(),
                1,
                "the end is behind its answer"
            );
        })
        .await
        .expect("an end reached is deferred");
    kept.clock.settle().await;
    assert_eq!(kept.ended(), [(second(), 3)]);
    kept.router
        .owner()
        .run(|state| {
            // A subscription whose call was in flight when its session ended is kept anew by its answer.
            state
                .notifications
                .register(
                    ProcedureAddress {
                        service_id: 2,
                        procedure_id: 5,
                    },
                    &SubscribingCall {
                        call_id: 3,
                        connection_handle: second(),
                        end: Some(NOW),
                        identifier: Some(grace()),
                        paced: false,
                        series: None,
                    },
                )
                .expect("the answered subscription");
            held(state, (3, &second(), Some(NOW), grace()));
            assert_eq!(counts(state), (1, 0));
        })
        .await
        .expect("an answered call keeps it anew");
    kept.clock.settle().await;
    assert_eq!(kept.ended(), [(second(), 3)]);
    kept.router
        .owner()
        .run(|state| {
            held(state, (9, &second(), None, grace()));
            assert_eq!(counts(state), (0, 0));
        })
        .await
        .expect("a failed answer keeps nothing");
    assert_eq!(kept.clock.dues(), Vec::<Duration>::new());
    kept.router.dispose().await;
}
impl Sessions {
    async fn new() -> Self {
        let clock = SteppingClock::new(instants::new_year());
        let transport = ScriptedServer::new(Arc::<SteppingClock>::clone(&clock));
        let router = RouterServer::new(
            Arc::<ScriptedServer>::clone(&transport),
            &RouterServerOptions::default(),
        )
        .expect("a router");
        transport.open(&first(), true);
        transport.open(&second(), true);
        clock.settle().await;
        Self {
            router,
            clock,
            transport,
        }
    }
    fn ended(&self) -> Vec<(ConnectionHandle, u32)> {
        self.transport
            .take()
            .into_iter()
            .map(|(handle, envelope)| {
                let Envelope::Failure { header, failure } = envelope else {
                    panic!("a session's end answers a failure")
                };
                assert_eq!(failure.code, ProtocolCode::SESSION_REQUIRED.get());
                (handle, header.call_id)
            })
            .collect()
    }
}

#[tokio::test]
async fn keeps_the_latest_credential_end_across_subscriptions_and_clears_its_timers_when_the_connection_closes()
 {
    let kept = Sessions::new().await;
    kept.router
        .owner()
        .run(|state| {
            let ada = Some(SessionIdentifier::Elsewhere {
                id: "ada".to_owned(),
            });
            register(state, (1, first(), 5, Some(NOW + 1_000), ada.clone()));
            register(state, (3, first(), 6, Some(NOW + 2_000), ada.clone()));
            register(state, (1, second(), 5, Some(NOW + 3_000), ada));
        })
        .await
        .expect("two connections keep the credential");
    assert_eq!(
        kept.clock.dues(),
        [Duration::from_secs(2), Duration::from_secs(3)]
    );
    kept.clock.advance(Duration::from_secs(1)).await;
    assert_eq!(kept.ended(), Vec::new());
    kept.router
        .owner()
        .run(|state| {
            unregister_tracked(state, (1, &first())).expect("first subscription gone");
            let identifier = SessionIdentifier::Elsewhere {
                id: "ada".to_owned(),
            };
            register(state, (5, first(), 5, None, Some(identifier.clone())));
            assert_eq!(counts(state), (2, 1));
            assert_eq!(
                resolved_session(
                    state,
                    (
                        CallSession {
                            data: Some(serde_json::json!("ada")),
                            end: Some(NOW + 1_500),
                            identifier: Some(identifier)
                        },
                        &first()
                    )
                )
                .end,
                None
            );
            clean_tracked(state, &first());
            clean_tracked(state, &first());
            assert_eq!(counts(state), (1, 1));
            assert_eq!(state.kept.keys().cloned().collect::<Vec<_>>(), [second()]);
        })
        .await
        .expect("the open-ended session wins, then its connection clears");
    assert_eq!(kept.clock.dues(), [Duration::from_secs(2)]);
    kept.clock.advance(Duration::from_secs(2)).await;
    assert_eq!(kept.ended(), [(second(), 1)]);
    assert_eq!(kept.clock.dues(), Vec::<Duration>::new());
    kept.router
        .owner()
        .run(|state| {
            assert_eq!(counts(state), (0, 0));
        })
        .await
        .expect("no credential held");
    kept.router.dispose().await;
}

#[tokio::test]
async fn keeps_a_credentials_session_from_its_first_subscription_on_a_connection_to_its_last_timing_its_end_meanwhile_its_connections_session_it_never_keeps()
 {
    let kept = Sessions::new().await;
    kept.router
        .owner()
        .run(|state| {
            register(state, (1, first(), 5, None, None));
            assert_eq!(counts(state), (0, 0));
        })
        .await
        .expect("a connection's subscription keeps no credential");
    assert_eq!(kept.clock.dues(), Vec::<Duration>::new());
    kept.router
        .owner()
        .run(|state| {
            register(state, (3, first(), 5, Some(NOW + 3_660_000), Some(grace())));
            register(state, (5, first(), 6, Some(NOW + 3_660_000), Some(grace())));
            assert_eq!(counts(state), (1, 1));
            unregister_tracked(state, (3, &first())).expect("one subscription gone");
        })
        .await
        .expect("two subscriptions of one credential");
    assert_eq!(kept.clock.dues(), [Duration::from_mins(61)]);
    kept.router
        .owner()
        .run(|state| {
            unregister_tracked(state, (5, &first())).expect("the last subscription gone");
            assert_eq!(counts(state), (0, 0));
            assert_eq!(
                resolved_session(state, (session(NOW + 1_000), &first())),
                session(NOW + 1_000)
            );
        })
        .await
        .expect("a session not kept runs with its own end");
    assert_eq!(kept.clock.dues(), Vec::<Duration>::new());
    kept.router.dispose().await;
}

#[tokio::test]
async fn ends_nothing_in_the_turn_after_its_end_was_reached_for_a_session_forgotten_or_renewed_meanwhile()
 {
    let kept = Sessions::new().await;
    kept.router
        .owner()
        .run(|state| {
            register(state, (1, first(), 5, Some(NOW), Some(grace())));
            unregister_tracked(state, (1, &first())).expect("forgotten in the same turn");
        })
        .await
        .expect("reached, then forgotten");
    kept.clock.settle().await;
    assert_eq!(kept.ended(), Vec::new());
    kept.router
        .owner()
        .run(|state| {
            register(state, (3, first(), 5, Some(NOW), Some(grace())));
            assert_eq!(
                resolved_session(state, (session(NOW + 60_000), &first())),
                session(NOW + 60_000)
            );
        })
        .await
        .expect("reached, then renewed");
    kept.clock.settle().await;
    assert_eq!(kept.ended(), Vec::new());
    assert_eq!(kept.clock.dues(), [Duration::from_secs(60)]);
    kept.router.dispose().await;
}

#[tokio::test]
async fn moves_a_kept_sessions_end_to_the_later_of_the_two_in_whatever_order_calls_resolve_its_timer_armed_anew_a_call_runs_with_the_end_kept()
 {
    let kept = Sessions::new().await;
    kept.router
        .owner()
        .run(|state| {
            register(state, (1, first(), 5, Some(NOW + 3_660_000), Some(grace())));
            assert_eq!(
                resolved_session(state, (session(NOW + 7_260_000), &first())),
                session(NOW + 7_260_000)
            );
        })
        .await
        .expect("a newer credential renews the end");
    assert_eq!(kept.clock.dues(), [Duration::from_mins(121)]);
    kept.router
        .owner()
        .run(|state| {
            assert_eq!(
                resolved_session(state, (session(NOW + 3_660_000), &first())),
                session(NOW + 7_260_000)
            );
            assert_eq!(
                resolved_session(state, (session(NOW + 60_000), &second())),
                session(NOW + 60_000)
            );
        })
        .await
        .expect("an older credential moves nothing back, and another connection keeps nothing");
    assert_eq!(kept.clock.dues(), [Duration::from_mins(121)]);
    kept.router.dispose().await;
}

#[tokio::test]
async fn ends_a_session_by_its_identifier_on_every_connection_that_keeps_it_and_forgets_those_of_a_connection_that_closes()
 {
    let kept = Sessions::new().await;
    kept.router
        .owner()
        .run(|state| {
            register(state, (1, first(), 5, Some(NOW + 3_660_000), Some(grace())));
            register(
                state,
                (1, second(), 5, Some(NOW + 3_660_000), Some(grace())),
            );
            register(
                state,
                (
                    3,
                    second(),
                    6,
                    None,
                    Some(SessionIdentifier::Elsewhere {
                        id: "bob".to_owned(),
                    }),
                ),
            );
        })
        .await
        .expect("two credentials on two connections");
    kept.router.end_session(grace()).await;
    kept.clock.settle().await;
    assert_eq!(kept.ended(), [(first(), 1), (second(), 1)]);
    assert_eq!(kept.clock.dues(), Vec::<Duration>::new());
    kept.router.end_session(grace()).await;
    assert_eq!(kept.ended(), Vec::new());
    kept.router
        .owner()
        .run(|state| {
            clean_tracked(state, &second());
        })
        .await
        .expect("second cleared");
    kept.router
        .end_session(SessionIdentifier::Elsewhere {
            id: "bob".to_owned(),
        })
        .await;
    assert_eq!(kept.ended(), Vec::new());
    kept.router
        .owner()
        .run(|state| {
            assert_eq!(counts(state), (0, 0));
        })
        .await
        .expect("no credential held");
    kept.router.dispose().await;
}
