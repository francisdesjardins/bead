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
    Abandoned, Answering, AnsweringCalls, PendingCalls, PendingRequest, Reservation,
};
use crate::router::types::{CallAddress, ConnectionHandle, Gauges, Signal};
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

// a side draws from its first, two apart, where the TypeScript side's sequence takes any first and
// step: each test below walks a side's own range, as the C# side's do

// spec 9.1
#[test]
fn walks_its_range_by_two_then_from_its_first_again() {
    let mut calls = PendingCalls::new(RouterSide::Client, Some(7));
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
    let mut calls = PendingCalls::new(RouterSide::Server, Some(8));
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
        PendingCalls::new(RouterSide::Client, Some(7)).draw((&a, |call_id: u32| call_id != 5)),
        Some(5),
        "the one free"
    );
}

// spec 9.1
#[test]
fn asks_about_each_id_once_at_most_however_many_are_in_use() {
    let mut calls = PendingCalls::new(RouterSide::Client, Some(9));
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
    let mut client = PendingCalls::new(RouterSide::Client, Some(9));
    let mut server = PendingCalls::new(RouterSide::Server, None);
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
    let mut calls = PendingCalls::new(RouterSide::Client, None);
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
    let mut calls = PendingCalls::new(RouterSide::Client, None);
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
    let mut calls = PendingCalls::new(RouterSide::Client, None);
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
    let mut calls = PendingCalls::new(RouterSide::Client, None);

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
        .reserve((call_id, timeout))
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
            scripted.router.reserve((1, Some(timeout))).is_err(),
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
            ("largestAnsweringCalls", 1)
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
            ("largestAnsweringCalls", 0)
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
