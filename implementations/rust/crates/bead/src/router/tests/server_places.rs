//! The server's subscription places themselves: a holder, its first answered waiter, the undo
//! of an answer, and the session and connection each place belongs to.

use std::sync::Arc;

use super::{
    RouterServer, RouterServerOptions, ServerState, cancel_place, drop_places, settle_place,
    subscribe_place,
};
use crate::failure::ProcedureAddress;
use crate::managers::notification::SubscribingCall;
use crate::router::core::Undo;
use crate::router::types::{CallAddress, ConnectionHandle, SessionIdentifier};
use crate::testing::SteppingClock;
use crate::testing::scripted::{ScriptedServer, handle_of};

fn first() -> ConnectionHandle {
    handle_of(1)
}
fn second() -> ConnectionHandle {
    handle_of(2)
}
fn news() -> ProcedureAddress {
    ProcedureAddress {
        service_id: 2,
        procedure_id: 5,
    }
}
fn other() -> ProcedureAddress {
    ProcedureAddress {
        service_id: 2,
        procedure_id: 7,
    }
}

fn call((call_id, handle, paced): (u32, ConnectionHandle, bool)) -> SubscribingCall {
    SubscribingCall {
        call_id,
        connection_handle: handle,
        paced,
        end: None,
        identifier: None,
        series: None,
    }
}

fn address(call: &SubscribingCall) -> CallAddress {
    CallAddress {
        call_id: call.call_id,
        connection_handle: Arc::clone(&call.connection_handle),
    }
}

fn held(state: &ServerState, handle: &ConnectionHandle) -> Vec<u32> {
    state
        .notifications
        .subscriptions(Some(handle))
        .iter()
        .map(|s| s.call_id)
        .collect()
}

fn success(state: &mut ServerState, call: SubscribingCall) -> Option<Undo<ServerState>> {
    settle_place(state, (call, (false, true, news())))
}

async fn opened() -> RouterServer {
    let clock = SteppingClock::new(crate::testing::instants::new_year());
    let transport = ScriptedServer::new(clock);
    let router = RouterServer::new(transport, &RouterServerOptions::default()).expect("a router");
    router
        .owner()
        .run(|state| {
            state.connections.insert(first(), ());
            state.connections.insert(second(), ());
        })
        .await
        .expect("two connections open");
    router
}

async fn places(check: impl FnOnce(&mut ServerState) + Send + 'static) {
    let router = opened().await;
    router
        .owner()
        .run(check)
        .await
        .expect("places checked in their owner");
    router.dispose().await;
}

#[tokio::test]
async fn subscribe_puts_a_call_in_its_place_in_flight_and_gives_any_other_the_holders_call_id() {
    places(|state| {
        assert_eq!(
            subscribe_place(state, (&call((3, first(), false)), news())).expect("a place"),
            3
        );
        assert_eq!(
            subscribe_place(state, (&call((5, first(), false)), news())).expect("the holder"),
            3
        );
        assert_eq!(
            subscribe_place(state, (&call((5, second(), false)), news()))
                .expect("another connection"),
            5
        );
        assert_eq!(held(state, &first()), [3]);
    })
    .await;
}

#[tokio::test]
async fn settle_keeps_a_success_and_its_undo_takes_it_away_when_the_answer_does_not_go_out() {
    places(|state| {
        let holder = call((3, first(), false));
        subscribe_place(state, (&holder, news())).expect("a place");
        let undo =
            settle_place(state, (holder, (false, false, news()))).expect("a success can be undone");
        assert_eq!(held(state, &first()), [3]);
        undo(state);
        assert_eq!(held(state, &first()), Vec::<u32>::new());
    })
    .await;
}

#[tokio::test]
async fn settle_subscribes_a_call_that_notifies_while_its_connection_holds_no_place_and_nothing_else()
 {
    places(|state| {
        assert!(success(state, call((3, first(), false))).is_some());
        assert!(settle_place(state, (call((5, first(), false)), (false, true, other()))).is_some());
        assert!(success(state, call((7, first(), false))).is_none());
        assert!(
            settle_place(state, (call((9, second(), false)), (false, false, news()))).is_none()
        );
        assert_eq!(held(state, &first()), [3, 5]);
        assert_eq!(held(state, &second()), Vec::<u32>::new());
    })
    .await;
}

#[tokio::test]
async fn a_failure_takes_the_holder_away_and_hands_its_place_to_the_first_call_answered_meanwhile()
{
    places(|state| {
        let holder = call((3, first(), false));
        subscribe_place(state, (&holder, news())).expect("a place");
        assert!(success(state, call((5, first(), false))).is_none());
        assert!(success(state, call((7, first(), false))).is_none());
        assert!(settle_place(state, (holder, (true, true, news()))).is_none());
        assert_eq!(held(state, &first()), [5]);
    })
    .await;
}

#[tokio::test]
async fn paces_a_call_subscribed_settled_or_handed_its_place_as_its_own_request_asked() {
    places(|state| {
        let holder = call((3, first(), true));
        subscribe_place(state, (&holder, news())).expect("a paced place");
        assert!(success(state, call((5, first(), false))).is_none());
        assert!(settle_place(state, (call((7, first(), true)), (false, true, other()))).is_some());
        subscribe_place(state, (&call((3, second(), false)), news())).expect("an unpaced place");
        assert!(success(state, call((5, second(), true))).is_none());
        assert!(state.notifications.pacing_of(3, &first()).is_some());
        assert!(state.notifications.pacing_of(7, &first()).is_some());
        assert!(state.notifications.pacing_of(3, &second()).is_none());
        assert!(settle_place(state, (holder, (true, true, news()))).is_none());
        cancel_place(state, &address(&call((3, second(), false))));
        assert!(state.notifications.pacing_of(5, &first()).is_none());
        assert!(state.notifications.has(5, &first()));
        assert!(state.notifications.pacing_of(5, &second()).is_some());
    })
    .await;
}

#[tokio::test]
async fn a_failure_of_a_call_not_in_flight_takes_nothing_away() {
    places(|state| {
        assert!(success(state, call((3, first(), false))).is_some());
        assert!(settle_place(state, (call((3, first(), false)), (true, true, news()))).is_none());
        assert_eq!(held(state, &first()), [3]);
    })
    .await;
}

#[tokio::test]
async fn a_holder_answered_successfully_leaves_nothing_waiting_on_it() {
    places(|state| {
        let holder = call((3, first(), false));
        subscribe_place(state, (&holder, news())).expect("a place");
        assert!(success(state, call((5, first(), false))).is_none());
        assert!(success(state, holder.clone()).is_some());
        cancel_place(state, &address(&holder));
        assert_eq!(held(state, &first()), Vec::<u32>::new());
    })
    .await;
}

#[tokio::test]
async fn an_undo_hands_the_place_over_to_a_connection_still_open_that_holds_none() {
    for open in [true, false] {
        places(move |state| {
            let holder = call((3, first(), false));
            subscribe_place(state, (&holder, news())).expect("a place");
            assert!(success(state, call((5, first(), false))).is_none());
            let undo = success(state, holder).expect("an answer can be undone");
            if !open {
                state.connections.clear();
            }
            undo(state);
            assert_eq!(held(state, &first()), if open { vec![5] } else { vec![] });
        })
        .await;
    }
}

#[tokio::test]
async fn cancel_takes_the_holder_away_and_hands_its_place_over_on_its_own_connection_alone() {
    places(|state| {
        let holder = call((3, first(), false));
        subscribe_place(state, (&holder, news())).expect("a place");
        assert!(success(state, call((5, first(), false))).is_none());
        subscribe_place(state, (&call((3, second(), false)), news())).expect("another connection");
        cancel_place(state, &address(&holder));
        assert_eq!(held(state, &first()), [5]);
        assert_eq!(held(state, &second()), [3]);
    })
    .await;
}

#[tokio::test]
async fn holds_a_place_a_procedure_for_each_session_of_a_connection_and_drop_gives_a_sessions_own_its_connections_or_a_credentials_by_its_identifier()
 {
    places(|state| {
        let grace = SessionIdentifier::Elsewhere {
            id: "grace".to_owned(),
        };
        let in_grace = |call_id| SubscribingCall {
            identifier: Some(grace.clone()),
            ..call((call_id, first(), false))
        };
        assert!(success(state, call((1, first(), false))).is_some());
        assert!(success(state, in_grace(3)).is_some());
        assert!(settle_place(state, (in_grace(5), (false, true, other()))).is_some());
        assert!(success(state, in_grace(7)).is_none());
        assert_eq!(held(state, &first()), [1, 3, 5]);
        let ids = |dropped: Vec<(u32, Option<crate::metrics::NotificationSeries>)>| {
            dropped.into_iter().map(|(id, _)| id).collect::<Vec<_>>()
        };
        assert_eq!(ids(drop_places(state, (&first(), None))), [1]);
        assert_eq!(
            ids(drop_places(state, (&first(), Some(&grace.clone())))),
            [3, 5]
        );
        assert!(
            drop_places(
                state,
                (
                    &first(),
                    Some(&SessionIdentifier::Elsewhere {
                        id: "Grace".to_owned()
                    })
                )
            )
            .is_empty()
        );
    })
    .await;
}

#[tokio::test]
async fn drop_gives_the_established_and_the_waiting_never_one_in_flight_and_no_call_waits_after() {
    places(|state| {
        let holder = call((3, first(), false));
        subscribe_place(state, (&holder, news())).expect("a place");
        assert!(success(state, call((5, first(), false))).is_none());
        assert!(settle_place(state, (call((7, first(), false)), (false, true, other()))).is_some());
        let dropped = drop_places(state, (&first(), None));
        assert_eq!(
            dropped.into_iter().map(|(id, _)| id).collect::<Vec<_>>(),
            [7, 5]
        );
        assert!(drop_places(state, (&second(), None)).is_empty());
        assert!(settle_place(state, (holder, (true, true, news()))).is_none());
        assert_eq!(held(state, &first()), [7]);
    })
    .await;
}

#[tokio::test]
async fn a_call_that_waited_cancelled_or_unsubscribed_waits_no_more() {
    let router = opened().await;
    router
        .owner()
        .run(|state| {
            subscribe_place(state, (&call((3, first(), false)), news())).expect("a holder");
            assert!(success(state, call((5, first(), false))).is_none());
            cancel_place(state, &address(&call((5, first(), false))));
            assert!(success(state, call((7, first(), false))).is_none());
        })
        .await
        .expect("a cancelled waiter and a second one");
    assert!(
        !router
            .unsubscribe(address(&call((7, first(), false))))
            .await
    );
    router
        .owner()
        .run(|state| {
            cancel_place(state, &address(&call((3, first(), false))));
            assert_eq!(held(state, &first()), Vec::<u32>::new());
        })
        .await
        .expect("neither waiter takes the place");
    router.dispose().await;
}

#[tokio::test]
async fn unsubscribe_takes_a_subscription_away_and_says_whether_the_connection_held_it() {
    let router = opened().await;
    router
        .owner()
        .run(|state| {
            assert!(success(state, call((3, first(), false))).is_some());
        })
        .await
        .expect("an established subscription");
    assert!(
        !router
            .unsubscribe(address(&call((3, second(), false))))
            .await
    );
    assert!(
        router
            .unsubscribe(address(&call((3, first(), false))))
            .await
    );
    router
        .owner()
        .run(|state| {
            assert_eq!(held(state, &first()), Vec::<u32>::new());
        })
        .await
        .expect("the subscription is removed");
    router.dispose().await;
}
