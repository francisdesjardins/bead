//! The resolvers a core's calls leave running: each keeps a place on its connection until it
//! settles, within twice the calls it answers; one whose call ended before its turn is handed
//! nothing; a connection refused past them in a row is closed; one that closes tells them all.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::oneshot;

use super::router_core_sessions::{receive, session};
use super::{Handed, cancel_of, locked};
use crate::constants::{CredentialScheme, ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope, RequestHeader};
use crate::errors::ResolverError;
use crate::router::core::{self as router_core, Handler, Resolution, ResolveFn, Resolved};
use crate::router::types::{RouterAnswer, RouterError, RouterLimitsOptions, SignalReason};
use crate::testing::core_port::{Peer, State, scripted_header};
use crate::testing::pair::echo;
use crate::transport::Sent;

// the payload of a request whose resolver answers first, then runs on
const ANSWER: &[u8] = b"answer";

// the detail of a refusal past the calls answered and those outlived, twice `most`
fn past_both(most: u64) -> String {
    format!("the calls a connection answers and those its resolvers outlive are {most} at most")
}

// the detail of a refusal past the calls answered alone
fn past_answered(most: u64) -> String {
    format!("the calls a connection has answered at once are {most} at most")
}

// how a resolver the test holds settles
#[derive(Debug, Clone, Copy)]
enum Settling {
    Resolves,
    Rejects,
}

// the settling of each resolver the test holds, in the order handed
type Held = Arc<Mutex<Vec<Option<oneshot::Sender<Settling>>>>>;

// the settling of each resolver the test holds, by its call id
type Settlings = Arc<Mutex<Vec<(u32, Option<oneshot::Sender<Settling>>)>>>;

fn handler_of(resolve: ResolveFn) -> Handler {
    Handler {
        resolve,
        admit: None,
        maximum_payload_bytes: None,
        forwards_credentials: false,
        notifies: false,
    }
}

fn limits_of(maximum_answering_calls: u64) -> RouterLimitsOptions {
    RouterLimitsOptions {
        maximum_answering_calls: Some(maximum_answering_calls),
        ..RouterLimitsOptions::default()
    }
}

/// A core whose resolver of echo holds each call it is handed until the test settles it, deaf to
/// its signal; one whose payload says `answer` answers first.
struct Holding {
    peer: Peer,
    handed: Handed,
    held: Held,
}

impl Holding {
    async fn new(maximum_answering_calls: u64) -> Self {
        let peer = Peer::new(RouterSide::Server, &limits_of(maximum_answering_calls));
        let handed = Handed::default();
        let held = Held::default();
        let (handing, holding) = (Arc::clone(&handed), Arc::clone(&held));
        let resolve: ResolveFn = Arc::new(move |props| {
            let (settles, settled) = oneshot::channel();
            let answerer = Arc::clone(&props.answerer);
            let is_answering = props.payload.as_ref() == ANSWER;

            locked(&holding).push(Some(settles));
            locked(&handing).push(props);

            Box::pin(async move {
                if is_answering {
                    drop(answerer.respond(RouterAnswer::Result(Bytes::new())).await);
                }

                match settled.await {
                    Ok(Settling::Rejects) => {
                        Err(ResolverError::other(std::io::Error::other("rejected")))
                    }
                    Ok(Settling::Resolves) | Err(_) => Ok(()),
                }
            })
        });

        registered(&peer, handler_of(resolve)).await;

        Self { peer, handed, held }
    }

    // settles the resolver handed `index`th as `settling` says
    async fn settle(&self, (index, settling): (usize, Settling)) {
        let settles = locked(&self.held)
            .get_mut(index)
            .and_then(Option::take)
            .expect("a resolver held");

        settles.send(settling).ok();
        self.peer.settle().await;
    }

    fn call_ids(&self) -> Vec<u32> {
        call_ids_of(&self.handed)
    }
}

async fn registered(peer: &Peer, handler: Handler) {
    peer.owner
        .run(move |state| {
            router_core::register_resolver(&state.core.resolvers, (&echo(), handler, None))
                .expect("echo registered");
        })
        .await
        .expect("the port ready");
}

fn call_ids_of(handed: &Handed) -> Vec<u32> {
    locked(handed)
        .iter()
        .map(|props| props.header.call_id)
        .collect()
}

fn request(call_id: u32) -> Envelope {
    request_with(call_id, b"")
}

fn request_with(call_id: u32, payload: &'static [u8]) -> Envelope {
    Envelope::Request {
        header: scripted_header(call_id),
        payload: Bytes::from_static(payload),
    }
}

// what each envelope does in one turn of the core, on `handle`
async fn receive_all(peer: &Peer, (envelopes, handle): (Vec<Envelope>, &'static str)) {
    peer.owner
        .run(move |state| {
            for envelope in envelopes {
                receive(state, (envelope, handle, None));
            }
        })
        .await
        .expect("received in one turn");
}

// each refusal it sent: its call id, its code and its detail
async fn failures_of(peer: &Peer) -> Vec<(u32, u16, String)> {
    peer.sent()
        .await
        .into_iter()
        .filter_map(|(_, envelope)| match envelope {
            Envelope::Failure { header, failure } => {
                Some((header.call_id, failure.code.get(), failure.detail))
            }
            Envelope::Request { .. }
            | Envelope::Result { .. }
            | Envelope::Notification { .. }
            | Envelope::Chunk { .. }
            | Envelope::Credit { .. }
            | Envelope::Cancel { .. } => None,
        })
        .collect()
}

fn capacity(call_id: u32, detail: &str) -> (u32, u16, String) {
    (
        call_id,
        ProtocolCode::CAPACITY_EXCEEDED.get().get(),
        detail.to_owned(),
    )
}

// each answer it sent: its connection, its kind and its call id
async fn answers_of(peer: &Peer) -> Vec<String> {
    peer.sent()
        .await
        .into_iter()
        .map(|(handle, envelope)| format!("{handle} {:?} {}", envelope.kind(), envelope.call_id()))
        .collect()
}

// the calls it answers, the busiest connection's calls with the resolvers that outlive its calls,
// and every resolver that outlives its call
async fn tracked_of(peer: &Peer) -> [u64; 3] {
    peer.owner
        .run(|state| {
            let counts = state.core.gauges().expect("the combined gauges").counts;

            [
                "answeringCalls",
                "largestTrackedCalls",
                "outlivingResolvers",
            ]
            .map(|name| counts.get(name).copied().unwrap_or(0))
        })
        .await
        .expect("the port lives")
}

async fn reports_of(peer: &Peer) -> Vec<(String, String)> {
    peer.owner
        .run(|state| {
            state
                .reports
                .iter()
                .map(|(handle, error)| {
                    let said = match error {
                        RouterError::Failure(failure) => failure.detail().to_owned(),
                        other @ (RouterError::ReadyState(_)
                        | RouterError::Disconnected(_)
                        | RouterError::Other(_)) => other.to_string(),
                    };

                    (handle.to_string(), said)
                })
                .collect()
        })
        .await
        .expect("the port lives")
}

async fn closed_of(peer: &Peer) -> Vec<String> {
    peer.owner
        .run(|state| {
            state
                .closed
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .await
        .expect("the port lives")
}

// spec 9.2, 10.2
#[tokio::test]
async fn holds_a_call_whose_resolver_outlives_its_cancel_among_the_calls_it_counts_until_that_resolver_settles_and_answers_capacity_exceeded_a_request_that_comes_while_they_and_the_calls_it_answers_number_twice_maximum_answering_calls()
 {
    let holding = Holding::new(2).await;
    let peer = &holding.peer;

    receive_all(peer, (vec![request(1), request(3)], "a")).await;
    peer.settle().await;
    // * both resolvers run on past their cancel: the calls leave, their places stay
    receive_all(peer, (vec![cancel_of(1), cancel_of(3)], "a")).await;

    assert_eq!(tracked_of(peer).await, [0, 2, 2]);

    receive_all(peer, (vec![request(5), request(7), request(9)], "a")).await;
    peer.settle().await;

    assert_eq!(holding.call_ids(), [1, 3, 5, 7]);
    assert_eq!(failures_of(peer).await, [capacity(9, &past_both(4))]);

    // one settles: its place goes back among both counts, while the calls answered stay at their
    // own bound
    holding.settle((0, Settling::Resolves)).await;
    receive_all(peer, (vec![request(11)], "a")).await;
    peer.settle().await;

    assert_eq!(
        failures_of(peer).await.last(),
        Some(&capacity(11, &past_answered(2)))
    );

    // a call cancelled leaves room among the calls answered, and the next is taken
    receive_all(peer, (vec![cancel_of(5), request(13)], "a")).await;
    // another connection's counts are its own
    receive_all(peer, (vec![request(1)], "b")).await;
    peer.settle().await;

    assert_eq!(holding.call_ids(), [1, 3, 5, 7, 13, 1]);
    assert_eq!(tracked_of(peer).await, [3, 4, 2]);
    assert_eq!(reports_of(peer).await, []);
}

// spec 9.2
#[tokio::test]
async fn holds_a_call_whose_resolver_outlives_its_answer_among_the_calls_it_counts_until_that_resolver_settles()
 {
    let holding = Holding::new(1).await;
    let peer = &holding.peer;

    receive_all(peer, (vec![request_with(1, ANSWER)], "a")).await;
    peer.settle().await;

    // answered, its resolver runs on: the call left, its place stays
    assert_eq!(answers_of(peer).await, ["a Result 1"]);
    assert_eq!(tracked_of(peer).await, [0, 1, 1]);

    receive_all(peer, (vec![request(3), request(5)], "a")).await;
    peer.settle().await;

    assert_eq!(holding.call_ids(), [1, 3]);
    assert_eq!(failures_of(peer).await, [capacity(5, &past_both(2))]);

    holding.settle((0, Settling::Resolves)).await;

    assert_eq!(tracked_of(peer).await, [1, 1, 0]);

    // the calls answered at their own bound still refuse the next, by their own detail
    receive_all(peer, (vec![request(7)], "a")).await;
    peer.settle().await;

    assert_eq!(
        failures_of(peer).await.last(),
        Some(&capacity(7, &past_answered(1)))
    );
    assert_eq!(reports_of(peer).await, []);
}

// spec 9.2
#[tokio::test]
async fn gives_a_place_back_as_the_resolver_that_outlives_its_call_settles_whether_it_resolves_rejects_or_throws()
 {
    let peer = Peer::new(RouterSide::Server, &limits_of(1));
    let settling = Settlings::default();
    let holding = Arc::clone(&settling);
    let resolve: ResolveFn = Arc::new(move |props| {
        // its answer gone, it throws before it returns
        if props.payload.as_ref() == b"throws" {
            drop(props.answerer.respond(RouterAnswer::Result(Bytes::new())));

            panic!("thrown");
        }

        let (settles, settled) = oneshot::channel();

        locked(&holding).push((props.header.call_id, Some(settles)));

        Box::pin(async move {
            match settled.await {
                Ok(Settling::Rejects) => {
                    Err(ResolverError::other(std::io::Error::other("rejected")))
                }
                Ok(Settling::Resolves) | Err(_) => Ok(()),
            }
        })
    });
    let settle = |(call_id, how): (u32, Settling)| {
        let settles = locked(&settling)
            .iter_mut()
            .find(|(held, _)| *held == call_id)
            .and_then(|(_, settles)| settles.take())
            .expect("a resolver held");

        settles.send(how).ok();
    };
    let outliving = async |peer: &Peer| tracked_of(peer).await[2];

    registered(&peer, handler_of(resolve)).await;

    // it resolves, past its cancel
    receive_all(&peer, (vec![request(1)], "a")).await;
    peer.settle().await;
    receive_all(&peer, (vec![cancel_of(1)], "a")).await;

    assert_eq!(outliving(&peer).await, 1);

    settle((1, Settling::Resolves));
    peer.settle().await;

    assert_eq!(outliving(&peer).await, 0);

    // it rejects, past its cancel: reported by none, its call no one's to hear of
    receive_all(&peer, (vec![request(3)], "a")).await;
    peer.settle().await;
    receive_all(&peer, (vec![cancel_of(3)], "a")).await;

    assert_eq!(outliving(&peer).await, 1);

    settle((3, Settling::Rejects));
    peer.settle().await;

    assert_eq!(outliving(&peer).await, 0);

    // it throws past its answer, in the turn it was handed: reported, its place back
    receive_all(&peer, (vec![request_with(5, b"throws")], "a")).await;
    peer.settle().await;

    assert_eq!(outliving(&peer).await, 0);

    // no place held: the next is taken, and the one after refused at the calls answered alone
    receive_all(&peer, (vec![request(7), request(9)], "a")).await;
    peer.settle().await;

    assert_eq!(
        locked(&settling)
            .iter()
            .map(|(call_id, _)| *call_id)
            .collect::<Vec<_>>(),
        [1, 3, 7]
    );
    assert_eq!(answers_of(&peer).await, ["a Result 5", "a Failure 9"]);
    assert_eq!(failures_of(&peer).await, [capacity(9, &past_answered(1))]);

    let reported = reports_of(&peer).await;

    assert!(
        matches!(reported.as_slice(), [(handle, said)] if handle == "a" && said.contains("thrown")),
        "its throw reported: {reported:?}"
    );
}

// spec 9.2; the review's probe of HTTP/2's Rapid Reset (CVE-2023-44487)
#[tokio::test]
async fn holds_a_peer_that_cancels_each_request_it_sends_to_twice_maximum_answering_calls_resolvers_at_once_however_many_it_sends()
 {
    let peer = Peer::new(RouterSide::Server, &limits_of(2));
    let live: Arc<Mutex<(u32, u32)>> = Arc::default();
    let counting = Arc::clone(&live);

    registered(
        &peer,
        handler_of(Arc::new(move |_props| {
            let mut live = locked(&counting);

            live.0 = live.0.saturating_add(1);
            live.1 = live.1.max(live.0);
            drop(live);

            // deaf to its signal, it never settles
            Box::pin(core::future::pending())
        })),
    )
    .await;

    // * a request, its resolver handed it, then its cancel, 200 times
    for round in 0..200_u32 {
        let call_id = round.saturating_mul(2).saturating_add(1);

        receive_all(&peer, (vec![request(call_id)], "a")).await;
        peer.settle().await;
        receive_all(&peer, (vec![cancel_of(call_id)], "a")).await;
    }

    peer.settle().await;

    assert_eq!(*locked(&live), (4, 4), "live, and the most at once");

    let failures = failures_of(&peer).await;

    assert_eq!(failures.len(), 196, "the rest refused");
    assert!(
        failures
            .iter()
            .all(|(_, code, _)| *code == ProtocolCode::CAPACITY_EXCEEDED.get().get()),
        "each CAPACITY_EXCEEDED"
    );
    assert_eq!(peer.sent().await.len(), 196, "nothing else");
    assert_eq!(tracked_of(&peer).await, [0, 4, 4]);
}

// spec 9.2, 10.2
#[tokio::test]
async fn holds_a_call_cancelled_while_its_credential_resolves_among_the_calls_it_counts_until_its_verifier_settles()
 {
    let peer = Peer::new(RouterSide::Server, &limits_of(1));
    let verifying: Arc<Mutex<Vec<oneshot::Sender<Resolved>>>> = Arc::default();
    let signals: Arc<Mutex<Vec<crate::router::types::Signal>>> = Arc::default();
    let handed = Handed::default();
    let (resolving, telling, seeing) = (
        Arc::clone(&verifying),
        Arc::clone(&signals),
        Arc::clone(&handed),
    );

    peer.owner
        .run(move |state: &mut State| {
            state.schemes = vec![CredentialScheme::JWT];
            state.session = Some(Box::new(move |request, signal| {
                if request.carried.header.credential.is_none() {
                    return Resolution::Now(Ok(Resolved::None));
                }

                let (resolution, resolved) = oneshot::channel();

                locked(&resolving).push(resolution);
                locked(&telling).push(signal.clone());

                // deaf to its signal: it settles as the test says
                Resolution::Later(Box::pin(async move {
                    Ok(resolved.await.unwrap_or(Resolved::None))
                }))
            }));
            router_core::register_resolver(
                &state.core.resolvers,
                (
                    &echo(),
                    handler_of(Arc::new(move |props| {
                        locked(&seeing).push(props);

                        Box::pin(async { Ok(()) })
                    })),
                    None,
                ),
            )
            .expect("echo registered");
        })
        .await
        .expect("the port ready");

    receive_all(
        &peer,
        (
            vec![
                Envelope::Request {
                    header: RequestHeader {
                        credential: Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
                        ..scripted_header(1)
                    },
                    payload: Bytes::new(),
                },
                cancel_of(1),
            ],
            "a",
        ),
    )
    .await;

    // * its verifier told, it runs on: the call left, its place stays
    assert_eq!(
        locked(&signals)
            .first()
            .map(crate::router::types::Signal::reason),
        Some(Some(SignalReason::Cancelled))
    );
    assert_eq!(tracked_of(&peer).await, [0, 1, 1]);

    // a call beside it, which its resolver leaves open, then one past both refused
    receive_all(&peer, (vec![request(3)], "a")).await;
    peer.settle().await;
    receive_all(&peer, (vec![request(5)], "a")).await;
    peer.settle().await;

    assert_eq!(failures_of(&peer).await, [capacity(5, &past_both(2))]);

    // its verifier settles, to a session dropped in silence: its place goes back
    let resolution = locked(&verifying).remove(0);

    resolution.send(Resolved::Session(session())).ok();
    peer.settle().await;

    assert_eq!(tracked_of(&peer).await, [1, 1, 0]);

    receive_all(&peer, (vec![request(7)], "a")).await;
    peer.settle().await;

    assert_eq!(
        failures_of(&peer).await.last(),
        Some(&capacity(7, &past_answered(1)))
    );
    assert_eq!(call_ids_of(&handed), [3]);
    assert_eq!(reports_of(&peer).await, []);
}

// spec 9.2, step 9
#[tokio::test]
async fn hands_nothing_to_the_resolver_of_a_request_whose_cancel_came_in_the_same_read() {
    let peer = Peer::new(RouterSide::Server, &RouterLimitsOptions::default());
    let handed = Handed::default();
    let seeing = Arc::clone(&handed);

    registered(
        &peer,
        handler_of(Arc::new(move |props| {
            locked(&seeing).push(props);

            Box::pin(async { Ok(()) })
        })),
    )
    .await;

    // ! each request and its cancel received in one turn of the router, before its resolver's
    // own: its call ended before that turn came
    let envelopes = (1..200_u32)
        .step_by(2)
        .flat_map(|call_id| [request(call_id), cancel_of(call_id)])
        .collect();

    receive_all(&peer, (envelopes, "a")).await;
    peer.settle().await;

    assert!(locked(&handed).is_empty(), "no resolver handed anything");
    assert_eq!(peer.sent().await, []);
    assert_eq!(reports_of(&peer).await, []);
    assert_eq!(tracked_of(&peer).await, [0, 0, 0]);
}

// spec 9.2; RFC 9113 §10.5
#[tokio::test]
async fn closes_a_connection_that_it_refused_twice_maximum_answering_calls_requests_in_a_row_past_the_resolvers_that_outlive_its_calls_nothing_settling_between_and_reports_it()
 {
    let holding = Holding::new(1).await;
    let peer = &holding.peer;
    let close_detail = "the calls a connection answers and those its resolvers outlive stayed at 2 for 2 requests: the connection is closed";

    receive_all(peer, (vec![request(1)], "a")).await;
    peer.settle().await;
    receive_all(peer, (vec![cancel_of(1), request(3)], "a")).await;
    peer.settle().await;
    // the first of a run past both counts
    receive_all(peer, (vec![request(5)], "a")).await;
    peer.settle().await;
    // a settle, then a request refused at the calls answered alone: the run starts over
    holding.settle((0, Settling::Resolves)).await;
    receive_all(peer, (vec![request(7), cancel_of(3), request(9)], "a")).await;
    peer.settle().await;
    // past both again: once
    receive_all(peer, (vec![request(11)], "a")).await;
    peer.settle().await;

    let call_ids = async || {
        failures_of(peer)
            .await
            .into_iter()
            .map(|(call_id, _, _)| call_id)
            .collect::<Vec<_>>()
    };

    assert_eq!(call_ids().await, [5, 7, 11]);
    assert_eq!(closed_of(peer).await, Vec::<String>::new());
    assert_eq!(reports_of(peer).await, []);

    // twice, in a row: reported at once, and closed once its transport settled that refusal
    let (releases, held): (Vec<_>, Vec<_>) = (0..2).map(|_| oneshot::channel::<()>()).unzip();

    peer.owner
        .run(move |state| {
            for releasing in held {
                state.sending.push_back(Ok(Sent::Later(Box::pin(async move {
                    releasing.await.ok();

                    Ok(())
                }))));
            }

            receive(state, (request(13), "a", None));
        })
        .await
        .expect("received");

    assert_eq!(
        reports_of(peer).await,
        [("a".to_owned(), close_detail.to_owned())]
    );

    // one more refused before the close lands closes nothing more
    receive_all(peer, (vec![request(15)], "a")).await;
    peer.settle().await;

    assert_eq!(closed_of(peer).await, Vec::<String>::new());

    for release in releases {
        release.send(()).ok();
    }

    peer.settle().await;

    assert_eq!(call_ids().await, [5, 7, 11, 13, 15]);

    let failures = failures_of(peer).await;

    assert_eq!(
        failures.get(failures.len().saturating_sub(2)),
        Some(&capacity(13, &past_both(2)))
    );
    assert_eq!(closed_of(peer).await, ["a"]);
    assert_eq!(reports_of(peer).await.len(), 1);
}

// spec 9.10
#[tokio::test]
async fn tells_every_resolver_still_running_on_a_connection_as_it_closes_its_call_answered_or_not_and_counts_those_that_outlive_it_side_wide_until_they_settle()
 {
    let holding = Holding::new(2).await;
    let peer = &holding.peer;
    let reasons = || {
        locked(&holding.handed)
            .iter()
            .map(|props| props.signal.reason())
            .collect::<Vec<_>>()
    };

    receive_all(peer, (vec![request_with(1, ANSWER)], "a")).await;
    peer.settle().await;
    receive_all(peer, (vec![request(3), request(5)], "a")).await;
    peer.settle().await;
    receive_all(peer, (vec![cancel_of(5)], "a")).await;

    assert_eq!(reasons(), [None, None, Some(SignalReason::Cancelled)]);

    let gauged = peer
        .owner
        .run(|state| {
            router_core::reject_pending(state, ("a closed", Some(&Arc::from("a"))));
            state
                .core
                .gauges()
                .expect("the combined gauges")
                .connection_handles
        })
        .await
        .expect("closed");

    // * each told: one answered and one open by the close, one cancelled by its cancel already
    let closed = Some(SignalReason::Disconnected("a closed".to_owned()));

    assert_eq!(
        reasons(),
        [closed.clone(), closed, Some(SignalReason::Cancelled)]
    );
    assert!(gauged.is_empty(), "no connection: {gauged:?}");
    assert_eq!(tracked_of(peer).await, [0, 0, 3]);

    // a connection opened again under its handle starts from none of them
    receive_all(peer, (vec![request(1), request(3)], "a")).await;
    peer.settle().await;

    assert_eq!(holding.call_ids(), [1, 3, 5, 1, 3]);
    assert_eq!(tracked_of(peer).await, [2, 2, 3]);

    // each settles, and its place goes back side-wide alone
    for index in 0..3 {
        holding.settle((index, Settling::Resolves)).await;
    }

    assert_eq!(tracked_of(peer).await, [2, 2, 0]);
    assert_eq!(answers_of(peer).await, ["a Result 1"]);
    assert_eq!(reports_of(peer).await, []);
}
