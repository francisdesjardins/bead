//! The parts the router core holds, each alone: the call ids a side draws, the calls it waits on
//! and the call ids it reserved, and the calls it answers, counted. A reservation runs on a
//! client's router, which arms its timer on the clock.

use core::time::Duration;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use super::Scripted;
use crate::constants::RouterSide;
use crate::duration::{LONGEST_TIMER, NEVER};
use crate::failure::ProcedureAddress;
use crate::router::parts::{
    Abandoned, Answering, AnsweringCalls, PendingCalls, PendingRequest, RequestReceiving,
    Reservation, ResolverRun,
};
use crate::router::types::{CallAddress, ConnectionHandle, Gauges, Signal, SignalReason};
use crate::server::{
    HealthCheck, HealthStatus, LayerGauges, ServerGauges, health_of, layer_gauges_of,
};

fn handle(name: &str) -> ConnectionHandle {
    Arc::from(name)
}

fn call_of((call_id, name): (u32, &str)) -> CallAddress {
    CallAddress {
        connection_handle: handle(name),
        call_id,
    }
}

fn milliseconds(count: u64) -> Duration {
    Duration::from_millis(count)
}

// none in use
const fn free(_call_id: u32) -> bool {
    false
}

// a request waiting, which settles nowhere a test reads, known by `id`
fn request_of(id: u64) -> PendingRequest {
    PendingRequest {
        id,
        destination_id: None,
        is_sent: true,
        maximum_payload_bytes: 1_024,
        on_sent: None,
        procedure: ProcedureAddress {
            service_id: 2,
            procedure_id: 1,
        },
        receiving: None,
        reply: None,
        sending: false,
        timeout: None,
        timer: None,
    }
}

// a call id reserved, with no timer of its own
fn reservation_of(id: u64) -> Reservation {
    Reservation {
        ends: Duration::from_secs(5),
        id,
        timer: None,
    }
}

fn reserve(calls: &mut PendingCalls, (call_id, name): (u32, &str)) {
    calls
        .reservations
        .entry(handle(name))
        .or_default()
        .insert(call_id, reservation_of(0));
}

fn ids_of(requests: &[PendingRequest]) -> Vec<u64> {
    requests.iter().map(|request| request.id).collect()
}

fn handles_of(gauges: &Gauges) -> Vec<String> {
    gauges
        .connection_handles
        .iter()
        .map(ToString::to_string)
        .collect()
}

// ── The call ids a side draws ────────────────────────────────────────────────────────────────

// spec 9.1
#[test]
fn draws_a_side_s_own_range_by_default_to_its_last_unsigned() {
    assert_eq!(RouterSide::Client.call_ids(), (1, u32::MAX));
    assert_eq!(RouterSide::Server.call_ids(), (2, u32::MAX - 1));
    let a = handle("a");
    assert_eq!(
        PendingCalls::new(RouterSide::Client).draw((&a, free)),
        Some(1)
    );
    assert_eq!(
        PendingCalls::new(RouterSide::Server).draw((&a, free)),
        Some(2)
    );
}

// spec 9.1
#[test]
fn refuses_a_last_call_id_of_the_other_parity_or_before_its_first() {
    for (side, last) in [
        (RouterSide::Client, 4),
        (RouterSide::Client, 0),
        (RouterSide::Server, 3),
        (RouterSide::Server, 0),
    ] {
        let error = PendingCalls::bounded(side, last).expect_err("the last id is not of its side");
        assert_eq!(
            error.to_string(),
            format!("the last call id of a {side} has its own parity and is not 0, not {last}")
        );
    }
}

#[test]
fn refuses_a_last_call_id_of_zero_or_its_peer_s_parity_before_a_router_starts() {
    use crate::router::client::{RouterClient, RouterClientOptions};
    use crate::router::server::{RouterServer, RouterServerOptions};
    use crate::testing::scripted::{ScriptedClient, ScriptedServer};

    let clock = crate::testing::SteppingClock::new(crate::testing::instants::new_year());
    let client = ScriptedClient::new(Arc::<crate::testing::SteppingClock>::clone(&clock));
    let server = ScriptedServer::new(clock);
    for last in [0, 2, 8, u32::MAX - 1] {
        let error = RouterClient::new(
            Arc::<ScriptedClient>::clone(&client),
            &RouterClientOptions {
                last_call_id: Some(last),
                ..RouterClientOptions::default()
            },
        )
        .expect_err("a client draws only nonzero odd ids");
        assert!(error.message().contains("last call id"));
    }
    for last in [0, 1, 7, u32::MAX] {
        let error = RouterServer::new(
            Arc::<ScriptedServer>::clone(&server),
            &RouterServerOptions {
                last_call_id: Some(last),
                ..RouterServerOptions::default()
            },
        )
        .expect_err("a server draws only nonzero even ids");
        assert!(error.message().contains("last call id"));
    }
    assert_eq!((client.listener_count(), server.listener_count()), (0, 0));
    for (side, last) in [
        (RouterSide::Client, 1),
        (RouterSide::Client, u32::MAX),
        (RouterSide::Server, 2),
        (RouterSide::Server, u32::MAX - 1),
    ] {
        let mut calls = PendingCalls::bounded(side, last).expect("either boundary holds");
        assert_eq!(calls.draw((&handle("a"), free)), Some(side.call_ids().0));
    }
}

// a side draws from its first, two apart, where the TypeScript side's sequence takes any first and
// step: each test below walks a side's own range, as the C# side's do

// spec 9.1
#[test]
fn walks_its_range_by_two_then_from_its_first_again() {
    let mut calls = PendingCalls::bounded(RouterSide::Client, 7).expect("a bound of its side");
    let a = handle("a");
    let drawn: Vec<Option<u32>> = (0..5).map(|_| calls.draw((&a, free))).collect();

    assert_eq!(
        drawn,
        [Some(1), Some(3), Some(5), Some(7), Some(1)],
        "by two, then from its first again"
    );
}

// spec 9.1
#[test]
fn skips_the_ids_in_use_and_gives_none_once_every_one_is() {
    let mut calls = PendingCalls::bounded(RouterSide::Server, 8).expect("a bound of its side");
    let a = handle("a");
    let some = |call_id: u32| call_id == 2 || call_id == 6;
    let drawn: Vec<Option<u32>> = (0..3).map(|_| calls.draw((&a, some))).collect();

    assert_eq!(drawn, [Some(4), Some(8), Some(4)], "2 and 6 skipped");
    assert_eq!(
        calls.draw((&a, |call_id: u32| matches!(call_id, 2 | 4 | 6 | 8))),
        None,
        "none once every one is"
    );

    // ids outside the range, however many, stop nothing: every id but 5 is in use here
    assert_eq!(
        PendingCalls::bounded(RouterSide::Client, 7)
            .expect("a bound of its side")
            .draw((&a, |call_id: u32| call_id != 5)),
        Some(5),
        "the one free"
    );
}

// spec 9.1
#[test]
fn asks_about_each_id_once_at_most_however_many_are_in_use() {
    let mut calls = PendingCalls::bounded(RouterSide::Client, 9).expect("a bound of its side");
    let asked = std::sync::Mutex::new(Vec::new());

    assert_eq!(
        calls.draw((&handle("a"), |call_id: u32| {
            super::locked(&asked).push(call_id);

            true
        })),
        None,
        "none free"
    );
    assert_eq!(*super::locked(&asked), [1, 3, 5, 7, 9], "each asked once");
}

// ── The calls a side waits on ────────────────────────────────────────────────────────────────

// spec 9.1
#[test]
fn draws_call_ids_of_its_side_skipping_those_waited_on_reserved_or_in_use_by_the_side() {
    let mut client = PendingCalls::bounded(RouterSide::Client, 9).expect("a bound of its side");
    let mut server = PendingCalls::new(RouterSide::Server);
    let (a, b) = (handle("a"), handle("b"));
    let in_use = |call_id: u32| call_id == 5;

    client.add(&call_of((1, "a")), request_of(1));
    reserve(&mut client, (3, "a"));

    let drawn: Vec<Option<u32>> = (0..3).map(|_| client.draw((&a, in_use))).collect();

    assert_eq!(drawn, [Some(7), Some(9), Some(7)], "1, 3 and 5 skipped");

    // another connection waits on nothing, and reserved nothing
    assert_eq!(client.draw((&b, in_use)), Some(9), "nothing of a's skipped");
    assert_eq!(
        [server.draw((&a, free)), server.draw((&a, free))],
        [Some(2), Some(4)],
        "a server's, even"
    );
}

// spec 9.1
#[test]
fn forgets_a_call_only_while_it_is_the_request_given_when_one_is() {
    let mut calls = PendingCalls::new(RouterSide::Client);
    let call = call_of((1, "a"));

    calls.add(&call, request_of(1));

    assert!(calls.forget(&call, Some(2)).is_none(), "another request's");
    assert_eq!(
        calls.get(&call).map(|request| request.id),
        Some(1),
        "still waited on"
    );
    assert_eq!(
        calls.forget(&call, Some(1)).map(|request| request.id),
        Some(1),
        "its own"
    );
    assert!(calls.forget(&call, None).is_none(), "gone already");
    assert!(calls.get(&call).is_none(), "forgotten");
}

// spec 9.1
#[test]
fn takes_out_every_call_of_a_connection_or_of_every_one_freeing_the_call_ids_it_reserved() {
    let mut calls = PendingCalls::new(RouterSide::Client);
    let a = handle("a");

    calls.add(&call_of((1, "a")), request_of(1));
    calls.add(&call_of((1, "b")), request_of(2));
    reserve(&mut calls, (3, "a"));

    assert_eq!(ids_of(&calls.take_all(Some(&a))), [1], "a's");
    assert!(!calls.is_reserved(3, &a), "its call id freed");
    assert_eq!(
        calls.get(&call_of((1, "b"))).map(|request| request.id),
        Some(2),
        "b's kept"
    );
    assert_eq!(ids_of(&calls.take_all(None)), [2], "every one's");
    assert!(calls.take_all(None).is_empty(), "none left");
}

// what the C# side hears through its OnRemove is what each way out gives back here: a request
// taken out once, and never again
// spec 9.1
#[test]
fn hears_each_call_leave_once_whichever_way_it_leaves() {
    let mut calls = PendingCalls::new(RouterSide::Client);
    let mut removed: Vec<u64> = Vec::new();
    let a = handle("a");

    calls.add(&call_of((1, "a")), request_of(1));

    // another request takes nothing out
    removed.extend(calls.forget(&call_of((1, "a")), Some(9)).map(|r| r.id));
    removed.extend(calls.forget(&call_of((1, "a")), Some(1)).map(|r| r.id));
    removed.extend(calls.forget(&call_of((1, "a")), Some(1)).map(|r| r.id));

    calls.add(&call_of((3, "a")), request_of(2));
    removed.extend(calls.forget(&call_of((3, "a")), None).map(|r| r.id));

    assert_eq!(removed, [1, 2], "each once");

    calls.add(&call_of((5, "a")), request_of(3));
    calls.add(&call_of((7, "b")), request_of(4));
    removed.extend(ids_of(&calls.take_all(Some(&a))));

    assert_eq!(removed, [1, 2, 3], "a's");

    removed.extend(ids_of(&calls.take_all(None)));

    assert_eq!(removed, [1, 2, 3, 4], "every one's");
}

// spec 9.1
#[test]
fn count_the_calls_waited_on_and_the_call_ids_reserved_and_the_connections_they_belong_to() {
    let mut calls = PendingCalls::new(RouterSide::Client);

    calls.add(&call_of((1, "a")), request_of(1));
    calls.add(&call_of((3, "a")), request_of(2));
    reserve(&mut calls, (5, "b"));

    let gauges = calls.gauges();

    assert_eq!(handles_of(&gauges), ["a", "b"], "both connections");
    assert_eq!(
        gauges.counts,
        BTreeMap::from([("pendingCalls", 2), ("reservedCallIds", 1)]),
        "counted"
    );

    calls.take_all(None);

    let gauges = calls.gauges();

    assert!(gauges.connection_handles.is_empty(), "none left");
    assert_eq!(
        gauges.counts,
        BTreeMap::from([("pendingCalls", 0), ("reservedCallIds", 0)]),
        "nothing"
    );
}

// ── The call ids a side reserves ─────────────────────────────────────────────────────────────

// a client's router reserves on its one connection: the tests below reserve there alone

async fn reserved_of(scripted: &Scripted, call_ids: [u32; 2]) -> [bool; 2] {
    [
        scripted.router.is_reserved(call_ids[0]).await,
        scripted.router.is_reserved(call_ids[1]).await,
    ]
}

async fn reserved(scripted: &Scripted, (call_id, timeout): (u32, Option<Duration>)) {
    scripted
        .router
        .reserve(call_id, timeout)
        .expect("a reservation held")
        .await;
}

// spec 10.3
#[tokio::test]
async fn reserves_a_call_id_until_its_timer_fires_the_later_end_of_two_standing() {
    let scripted = Scripted::new();

    reserved(&scripted, (1, Some(milliseconds(40)))).await;
    reserved(&scripted, (1, Some(milliseconds(10)))).await;
    reserved(&scripted, (3, Some(milliseconds(10)))).await;
    reserved(&scripted, (3, Some(milliseconds(40)))).await;

    // the earlier end of 3 replaced: its timer stopped
    assert_eq!(
        scripted.clock.dues(),
        [milliseconds(40), milliseconds(40)],
        "the later end of each"
    );
    assert_eq!(reserved_of(&scripted, [1, 3]).await, [true, true]);

    // the timer replaced frees nothing
    scripted.clock.advance(milliseconds(10)).await;

    assert_eq!(reserved_of(&scripted, [1, 3]).await, [true, true]);

    scripted.clock.advance(milliseconds(29)).await;

    assert_eq!(reserved_of(&scripted, [1, 3]).await, [true, true]);

    scripted.clock.advance(milliseconds(1)).await;

    assert_eq!(reserved_of(&scripted, [1, 3]).await, [false, false]);
}

// spec 10.3
#[tokio::test]
async fn refuses_a_reservation_longer_than_a_timer_holds_or_under_a_millisecond_and_reserves_nothing()
 {
    let scripted = Scripted::new();

    // 2³¹ ms, one past what JavaScript's timers hold
    for timeout in [
        LONGEST_TIMER.saturating_add(milliseconds(1)),
        Duration::from_micros(500),
    ] {
        assert!(
            scripted.router.reserve(1, Some(timeout)).is_err(),
            "{timeout:?} refused"
        );
    }

    assert!(!scripted.router.is_reserved(1).await, "nothing reserved");

    reserved(&scripted, (1, Some(LONGEST_TIMER))).await;
    reserved(&scripted, (3, Some(milliseconds(1)))).await;
    scripted.clock.advance(milliseconds(1)).await;

    assert_eq!(reserved_of(&scripted, [1, 3]).await, [true, false]);

    scripted
        .clock
        .advance(LONGEST_TIMER.saturating_sub(milliseconds(2)))
        .await;

    assert!(scripted.router.is_reserved(1).await, "the longest held");

    scripted.clock.advance(milliseconds(1)).await;

    assert!(!scripted.router.is_reserved(1).await, "then free");
}

// a deadline of its own: a wall clock that leaps an hour on, or a day back, between reservations
// moves none
// spec 10.3
#[tokio::test]
async fn keeps_the_later_end_of_two_reservations_by_the_monotonic_reading_never_the_wall_clock() {
    const HOUR: i64 = 3_600_000;
    const DAY: i64 = 86_400_000;

    let scripted = Scripted::new();

    scripted.clock.wall_by(HOUR);
    reserved(&scripted, (1, Some(milliseconds(40)))).await;
    scripted.clock.wall_by(-HOUR - DAY);
    reserved(&scripted, (1, Some(milliseconds(10)))).await;
    scripted.clock.wall_by(DAY + HOUR);
    reserved(&scripted, (1, Some(milliseconds(20)))).await;

    assert_eq!(
        scripted.clock.dues(),
        [milliseconds(40)],
        "the first stands"
    );

    scripted.clock.advance(milliseconds(39)).await;

    assert!(scripted.router.is_reserved(1).await, "reserved still");

    scripted.clock.advance(milliseconds(1)).await;

    assert!(!scripted.router.is_reserved(1).await, "free at 40 ms");
}

// spec 10.3
#[tokio::test]
async fn reserves_a_call_id_5_s_when_its_call_gave_no_time_or_waited_without_end() {
    for timeout in [None, Some(NEVER)] {
        let scripted = Scripted::new();

        reserved(&scripted, (1, timeout)).await;
        scripted.clock.advance(milliseconds(4_900)).await;

        assert!(scripted.router.is_reserved(1).await, "{timeout:?}: held");

        scripted.clock.advance(milliseconds(100)).await;

        assert!(!scripted.router.is_reserved(1).await, "{timeout:?}: 5 s");
    }
}

// ── The calls a side answers ─────────────────────────────────────────────────────────────────

fn answering_of(dispatched: u64) -> Answering {
    Answering {
        dispatched,
        signal: Signal::new(),
        run: ResolverRun::default(),
        is_answered: false,
        is_ended: false,
        receiving: None,
        series: None,
        started_at: Duration::ZERO,
    }
}

fn open(calls: &mut AnsweringCalls, (call_id, name): (u32, &str)) {
    calls
        .answering
        .entry(handle(name))
        .or_default()
        .insert(call_id, answering_of(u64::from(call_id)));
}

#[test]
fn takes_out_every_call_of_a_connection_or_of_every_one_giving_them() {
    let mut calls = AnsweringCalls::default();
    open(&mut calls, (3, "a"));
    open(&mut calls, (3, "b"));
    let first = calls
        .get(&call_of((3, "a")))
        .expect("a's call")
        .signal
        .clone();
    let second = calls
        .get(&call_of((3, "b")))
        .expect("b's call")
        .signal
        .clone();

    let taken = calls.take_all(Some(&handle("a")));
    assert_eq!(taken.len(), 1);
    assert_eq!(taken[0].0, call_of((3, "a")));
    assert_eq!(taken[0].1.dispatched, 3);
    assert!(!calls.has(&call_of((3, "a"))));
    assert!(calls.has(&call_of((3, "b"))));
    let rest = calls.take_all(None);
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].0, call_of((3, "b")));
    assert_eq!(rest[0].1.dispatched, 3);
    assert_eq!(calls.take_all(None).len(), 0);
    assert_eq!([first.is_aborted(), second.is_aborted()], [false, false]);

    // The caller owns the very signals returned, and ends them when it chooses.
    taken[0].1.signal.abort(SignalReason::Cancelled);
    assert_eq!([first.is_aborted(), second.is_aborted()], [true, false]);
    rest[0].1.signal.abort(SignalReason::Cancelled);
    assert!(second.is_aborted());
}

#[test]
fn count_the_calls_answered_and_those_abandoned_and_the_connections_they_belong_to() {
    let mut calls = AnsweringCalls::default();

    open(&mut calls, (1, "a"));
    open(&mut calls, (3, "b"));

    // the call on a ends, abandoned once it received 4 bytes
    calls.forget(&call_of((1, "a")), Some(1));
    calls.abandoned.entry(handle("a")).or_default().insert(
        1,
        Abandoned {
            credit_end: 4,
            id: 1,
            timer: None,
        },
    );

    let gauges = calls.gauges();

    assert_eq!(handles_of(&gauges), ["a", "b"], "both connections");
    assert_eq!(
        gauges.counts,
        BTreeMap::from([
            ("abandonedCalls", 1),
            ("answeringCalls", 1),
            ("largestAnsweringCalls", 1),
            ("largestTrackedCalls", 1),
            ("outlivingResolvers", 0)
        ]),
        "counted"
    );

    calls.forget_abandoned(&call_of((1, "a")), None);
    calls.forget(&call_of((3, "b")), None);

    let gauges = calls.gauges();

    assert!(gauges.connection_handles.is_empty(), "none left");
    assert_eq!(
        gauges.counts,
        BTreeMap::from([
            ("abandonedCalls", 0),
            ("answeringCalls", 0),
            ("largestAnsweringCalls", 0),
            ("largestTrackedCalls", 0),
            ("outlivingResolvers", 0)
        ]),
        "nothing"
    );
}

#[test]
fn gauges_largest_answering_calls_under_its_ceiling_maximum_answering_calls_which_health_warns_at()
{
    let mut calls = AnsweringCalls {
        most: 5,
        ..AnsweringCalls::default()
    };
    let check_of = |calls: &AnsweringCalls| {
        let router = layer_gauges_of(calls.gauges(), &BTreeSet::from([handle("a"), handle("b")]));
        let health = health_of(&ServerGauges {
            router,
            server: LayerGauges::default(),
            sessions: LayerGauges::default(),
            transport: LayerGauges::default(),
        });

        health
            .checks
            .get("router:largestAnsweringCalls")
            .cloned()
            .unwrap_or_default()
    };

    for call_id in [1, 3, 5] {
        open(&mut calls, (call_id, "a"));
    }

    open(&mut calls, (1, "b"));

    // the busiest connection's, never the sum of them, under the bound of one connection
    let gauges = calls.gauges();

    assert_eq!(gauges.ceilings.get("largestAnsweringCalls"), Some(&5));
    assert_eq!(
        (
            gauges.counts.get("answeringCalls"),
            gauges.counts.get("largestAnsweringCalls")
        ),
        (Some(&4), Some(&3))
    );
    assert_eq!(calls.count_on(&handle("a")), 3);
    assert_eq!(
        check_of(&calls),
        [HealthCheck {
            observed_value: 3,
            output: Some("3 of 5".to_owned()),
            status: HealthStatus::Pass,
        }]
    );

    open(&mut calls, (7, "a"));

    assert_eq!(
        check_of(&calls),
        [HealthCheck {
            observed_value: 4,
            output: Some("4 of 5".to_owned()),
            status: HealthStatus::Warn,
        }]
    );

    calls.answering.remove(&handle("a"));

    assert_eq!(calls.gauges().counts.get("largestAnsweringCalls"), Some(&1));
}

// a call opened on `name` whose resolver runs, and its dispatch: one of its own on each connection
fn running_on(calls: &mut AnsweringCalls, (call_id, name): (u32, &str)) -> (ResolverRun, u64) {
    let dispatched = u64::from(call_id).saturating_add(if name == "a" { 0 } else { 100 });
    let answering = answering_of(dispatched);
    let run = answering.run.clone();

    assert!(run.start(), "its turn came");
    calls
        .answering
        .entry(handle(name))
        .or_default()
        .insert(call_id, answering);

    (run, dispatched)
}

// the call ends, answered or cancelled, as the core ends it: a resolver that runs on outlives it
fn end_on(calls: &mut AnsweringCalls, (call_id, name): (u32, &str)) {
    let answering = calls
        .forget(&call_of((call_id, name)), None)
        .expect("a call");

    if answering.run.end() {
        calls.outlive((&handle(name), &answering));
    }
}

// the resolver settles, as the core settles it: one that outlived its call gives its place back
fn settle_on(calls: &mut AnsweringCalls, ((run, dispatched), name): (&(ResolverRun, u64), &str)) {
    if run.settle() {
        calls.settle((&handle(name), *dispatched));
    }
}

// spec 9.2
#[test]
fn gauges_largest_tracked_calls_under_its_ceiling_twice_maximum_answering_calls_which_health_warns_at_and_outliving_resolvers()
 {
    let mut calls = AnsweringCalls {
        most: 5,
        ..AnsweringCalls::default()
    };
    let check_of = |calls: &AnsweringCalls, name: &str| {
        let router = layer_gauges_of(calls.gauges(), &BTreeSet::from([handle("a"), handle("b")]));
        let health = health_of(&ServerGauges {
            router,
            server: LayerGauges::default(),
            sessions: LayerGauges::default(),
            transport: LayerGauges::default(),
        });

        health
            .checks
            .get(&format!("router:{name}"))
            .and_then(|checks| checks.first())
            .map(|check| (check.output.clone(), check.status))
    };
    let counts_of = |calls: &AnsweringCalls| {
        let counts = calls.gauges().counts;

        [
            "answeringCalls",
            "largestAnsweringCalls",
            "largestTrackedCalls",
            "outlivingResolvers",
        ]
        .map(|name| counts.get(name).copied().unwrap_or(0))
    };
    // a's: three calls answered, then three whose resolvers outlive their cancel
    let on_a: Vec<(ResolverRun, u64)> = [1, 3, 5, 7, 9, 11]
        .into_iter()
        .map(|call_id| running_on(&mut calls, (call_id, "a")))
        .collect();

    for call_id in [7, 9, 11] {
        end_on(&mut calls, (call_id, "a"));
    }

    // b's: one whose resolver outlives its answer
    let on_b = running_on(&mut calls, (1, "b"));

    end_on(&mut calls, (1, "b"));

    // the busiest connection's two counts together, never the sum of them, and the resolvers that
    // outlive their call over the whole side, under no ceiling
    let gauges = calls.gauges();

    assert_eq!(
        gauges.ceilings,
        BTreeMap::from([("largestAnsweringCalls", 5), ("largestTrackedCalls", 10)])
    );
    assert_eq!(handles_of(&gauges), ["a", "b"]);
    assert_eq!(counts_of(&calls), [3, 3, 6, 4]);
    assert_eq!(
        [
            calls.count_on(&handle("a")),
            calls.tracked_on(&handle("a")),
            calls.tracked_on(&handle("b"))
        ],
        [3, 6, 1]
    );
    assert_eq!(
        check_of(&calls, "largestTrackedCalls"),
        Some((Some("6 of 10".to_owned()), HealthStatus::Pass))
    );
    assert_eq!(check_of(&calls, "outlivingResolvers"), None);

    // two more whose resolvers outlive their answer: 8 of 10 warns
    for call_id in [13, 15] {
        running_on(&mut calls, (call_id, "a"));
        end_on(&mut calls, (call_id, "a"));
    }

    assert_eq!(
        check_of(&calls, "largestTrackedCalls"),
        Some((Some("8 of 10".to_owned()), HealthStatus::Warn))
    );

    // one that settles gives its place back; one whose call is open runs no more, and its call's
    // end leaves nothing behind
    settle_on(&mut calls, (&on_a[3], "a"));
    settle_on(&mut calls, (&on_a[0], "a"));
    end_on(&mut calls, (1, "a"));

    assert_eq!(counts_of(&calls), [2, 2, 6, 5]);
    assert_eq!(
        check_of(&calls, "largestTrackedCalls"),
        Some((Some("6 of 10".to_owned()), HealthStatus::Pass))
    );

    // a's connection closes: what still runs there counts by no connection until it settles
    for (_, answering) in calls.take_all(Some(&handle("a"))) {
        if answering.run.end() {
            calls.outlive_closed(answering.dispatched);
        }
    }

    drop(calls.close_outliving(Some(&handle("a"))));

    let gauges = calls.gauges();

    assert_eq!(handles_of(&gauges), ["b"]);
    assert_eq!(
        [
            gauges.counts.get("largestTrackedCalls").copied(),
            gauges.counts.get("outlivingResolvers").copied()
        ],
        [Some(1), Some(7)]
    );

    for running in &on_a {
        settle_on(&mut calls, (running, "a"));
    }

    settle_on(&mut calls, (&on_b, "b"));

    assert_eq!(counts_of(&calls), [0, 0, 0, 2]);
}

// ── The calls a side answers, found by their dispatch ────────────────────────────────────────

// what a call receives, told apart by its transfer
const fn receiving_of(transfer: u64) -> RequestReceiving {
    RequestReceiving { transfer }
}

// the transfer a call left with, when it received one
fn heard(left: Option<Answering>) -> Option<u64> {
    left.and_then(|answering| answering.receiving)
        .map(|receiving| receiving.transfer)
}

// ! a request is known by the id its dispatch drew, once per request dispatched, as the other sides
// know it by the very header dispatched: a copy of the header is an id no dispatch of the call drew
// spec 9.1, 9.4
#[test]
fn opens_a_call_as_its_request_is_dispatched_and_finds_it_again_by_that_very_header_alone() {
    let mut calls = AnsweringCalls::default();
    let call = call_of((3, "a"));
    let signal = Signal::new();

    calls.open(
        &call,
        Answering {
            signal: signal.clone(),
            ..answering_of(1)
        },
    );

    assert!(calls.has(&call), "open on a");
    assert!(!calls.has(&call_of((3, "b"))), "none on b");
    assert_eq!(
        calls
            .answering_of((&call, 1))
            .map(|answering| answering.dispatched),
        Some(1),
        "found by its dispatch"
    );
    assert!(
        calls.is_answering((&call, 1)),
        "its own dispatch answers it"
    );

    calls
        .signal_of((&call, 1))
        .expect("found by its dispatch")
        .abort(SignalReason::Cancelled);

    assert!(signal.is_aborted(), "the very signal it was opened with");

    // a copy was never dispatched: it finds no call, and is open to none
    assert!(
        calls.answering_of((&call, 2)).is_none(),
        "a copy finds nothing"
    );
    assert!(calls.signal_of((&call, 2)).is_none(), "nor its signal");
    assert!(!calls.is_answering((&call, 2)), "a copy answers nothing");
}

// spec 9.3
#[test]
fn answers_a_call_no_more_once_its_answer_goes_out_while_the_call_stays_until_closed_a_copy_of_its_header_marking_nothing()
 {
    let mut calls = AnsweringCalls::default();
    let call = call_of((3, "a"));

    calls.open(&call, answering_of(1));

    assert!(!calls.answer((&call, 2)), "a copy marks nothing");
    assert!(!calls.answer((&call_of((3, "b")), 1)), "nor b's call id");
    assert!(calls.is_answering((&call, 1)), "still to answer");
    assert!(calls.answer((&call, 1)), "its own marks it");
    assert!(!calls.is_answering((&call, 1)), "answered");
    assert!(calls.has(&call), "the call stays");
    assert!(calls.forget(&call, Some(1)).is_some(), "until closed");
    assert!(!calls.has(&call), "closed");
}

// spec 9.4
#[test]
fn answers_a_call_no_more_once_closed_by_its_own_call_taken_or_opened_again() {
    let mut calls = AnsweringCalls::default();
    let call = call_of((3, "a"));

    calls.open(&call, answering_of(1));

    assert!(
        calls.forget(&call, Some(9)).is_none(),
        "another request's closes nothing"
    );
    assert!(calls.is_answering((&call, 1)), "still to answer");
    assert!(calls.forget(&call, Some(1)).is_some(), "its own closes it");
    assert!(!calls.has(&call), "closed");
    assert!(!calls.is_answering((&call, 1)), "answered no more");

    calls.open(&call, answering_of(2));

    // the call id is open again, for another request
    assert!(!calls.is_answering((&call, 1)), "the first still not");
    assert_eq!(
        calls
            .forget(&call, None)
            .map(|answering| answering.dispatched),
        Some(2),
        "taken"
    );
    assert!(calls.forget(&call, None).is_none(), "once");
    assert!(!calls.is_answering((&call, 2)), "taken, answered no more");
}

// what a call left with is what its owner hears, given back once, as a call waited on gives its
// request
// spec 12.7, 12.10
#[test]
fn gives_a_call_what_it_receives_and_hears_it_leave_once_whichever_way_the_call_leaves() {
    let mut calls = AnsweringCalls::default();
    let call = call_of((3, "a"));
    let mut left: Vec<u64> = Vec::new();

    calls.open(&call, answering_of(1));

    // a call not open receives nothing, on a connection with calls open or none
    calls.attach(&call_of((5, "a")), receiving_of(9));
    calls.attach(&call_of((5, "b")), receiving_of(9));
    calls.attach(&call, receiving_of(1));

    assert!(
        calls.receiving_of(&call_of((5, "a"))).is_none(),
        "none on a"
    );
    assert!(
        calls.receiving_of(&call_of((5, "b"))).is_none(),
        "none on b"
    );
    assert_eq!(
        calls
            .receiving_of(&call)
            .map(|receiving| receiving.transfer),
        Some(1),
        "its own"
    );

    // another request's dispatch takes nothing out
    left.extend(heard(calls.forget(&call, Some(9))));
    left.extend(heard(calls.forget(&call, Some(1))));
    left.extend(heard(calls.forget(&call, Some(1))));

    assert!(calls.receiving_of(&call).is_none(), "gone with its call");

    calls.open(&call, answering_of(2));
    calls.attach(&call, receiving_of(2));
    left.extend(heard(calls.forget(&call, None)));
    left.extend(heard(calls.forget(&call, None)));
    calls.open(&call, answering_of(3));
    calls.open(&call_of((3, "b")), answering_of(4));
    calls.attach(&call_of((3, "b")), receiving_of(3));

    for (_, answering) in calls.take_all(None) {
        left.extend(heard(Some(answering)));
    }

    // a call that received nothing leaves unheard
    assert_eq!(left, [1, 2, 3], "closed, taken, gone");
}
