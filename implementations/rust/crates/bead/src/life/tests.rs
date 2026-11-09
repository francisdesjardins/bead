//! A transport server's life: the ready state and the guards around a start, a stop and a dispose,
//! as the other sides keep them, before any transport fills them (the twins of
//! `transport-server.test.ts`'s `createTransportServer` and of `TransportServerLifeTests`).

use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::oneshot;

use super::Life;
use crate::errors::ProgrammerError;
use crate::router::types::{BoxFuture, RouterError};
use crate::testing::spawn;
use crate::transport::{ReadyState, TransportServerAddress};

type Calls = Arc<Mutex<Vec<&'static str>>>;

// the stops a stop caused, each as its caller holds it
type Stops = Arc<Mutex<Vec<BoxFuture<Result<(), RouterError>>>>>;

fn bound() -> TransportServerAddress {
    TransportServerAddress::new("127.0.0.1", 50_000)
}

fn life() -> Arc<Life> {
    Arc::new(Life::new(Box::new(|future| {
        drop(spawn(future));
    })))
}

fn calls() -> Calls {
    Arc::new(Mutex::new(Vec::new()))
}

fn taken(calls: &Calls) -> Vec<&'static str> {
    calls.lock().unwrap_or_else(PoisonError::into_inner).clone()
}

fn call(calls: &Calls, what: &'static str) {
    calls
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(what);
}

// a start that listens at once, counting each time it is reached
fn starting(
    calls: &Calls,
) -> impl FnOnce() -> BoxFuture<Result<TransportServerAddress, RouterError>> + use<> {
    let calls = Arc::clone(calls);

    move || {
        call(&calls, "start");

        Box::pin(async { Ok(bound()) })
    }
}

// a stop that ends at once, counting each time it is reached
fn stopping(calls: &Calls) -> impl FnOnce() -> BoxFuture<Result<(), RouterError>> + use<> {
    let calls = Arc::clone(calls);

    move || {
        call(&calls, "stop");

        Box::pin(async { Ok(()) })
    }
}

fn failed(message: &'static str) -> RouterError {
    RouterError::Other(Arc::new(ProgrammerError::new(message)))
}

#[tokio::test]
async fn starts_reporting_where_it_listens() {
    let life = life();

    assert_eq!(
        life.ready_state(),
        ReadyState::Uninitialized,
        "uninitialized before its first start"
    );

    let listening = life.start(starting(&calls())).await.expect("started");

    assert_eq!(listening, bound(), "where it listens, given back");
    assert_eq!(
        (listening.address.as_str(), listening.port),
        ("127.0.0.1", 50_000),
        "its address and its port"
    );
    assert_eq!(
        life.ready_state(),
        ReadyState::Open,
        "open once started, no stop begun"
    );
}

// decision 0003
#[tokio::test]
async fn refuses_a_start_once_disposed_its_state_kept_and_disposes_once_stopping_it_first() {
    let calls = calls();
    let life = life();

    life.start(starting(&calls)).await.expect("started");

    // * two disposes: one stop, shared
    let first = life.dispose(stopping(&calls));
    let second = life.dispose(stopping(&calls));

    first.await.expect("disposed");
    second.await.expect("disposed alike");
    assert_eq!(taken(&calls), ["start", "stop"], "stopped once");
    assert_eq!(
        life.ready_state(),
        ReadyState::Closed,
        "closed once disposed"
    );

    // * a start after it: its application's misuse, refused before the transport is reached
    let refused = life
        .start(starting(&calls))
        .await
        .expect_err("refused once disposed");

    assert_eq!(
        refused.to_string(),
        "the transport server is disposed",
        "its refusal"
    );
    assert_eq!(
        taken(&calls),
        ["start", "stop"],
        "the transport never reached"
    );
    assert_eq!(life.ready_state(), ReadyState::Closed, "its state kept");
}

#[tokio::test]
async fn rejects_a_second_start_with_a_programmer_error_without_reaching_the_transport() {
    let calls = calls();
    let life = life();

    life.start(starting(&calls)).await.expect("started");

    let refused = life
        .start(starting(&calls))
        .await
        .expect_err("a second start refused");

    assert!(
        matches!(&refused, RouterError::Other(error) if error.is::<ProgrammerError>()),
        "a programmer error: {refused:?}"
    );
    assert_eq!(
        refused.to_string(),
        "the transport server is already open",
        "its refusal"
    );
    assert_eq!(taken(&calls), ["start"], "the transport reached once");
}

#[tokio::test]
async fn ends_closed_when_the_transport_cannot_start_and_can_start_again() {
    let life = life();

    let refused = life
        .start(|| Box::pin(async { Err(failed("taken")) }))
        .await
        .expect_err("its start failed");

    assert_eq!(refused.to_string(), "taken", "the transport's failure");
    assert_eq!(life.ready_state(), ReadyState::Closed, "closed once failed");

    life.start(starting(&calls())).await.expect("started again");
    assert_eq!(life.ready_state(), ReadyState::Open, "open again");

    life.stop(stopping(&calls())).await.expect("stopped");
    life.start(starting(&calls())).await.expect("started anew");
    assert_eq!(life.ready_state(), ReadyState::Open, "open anew");
}

#[tokio::test]
async fn rejects_a_second_start_while_the_first_is_still_starting() {
    let calls = calls();
    let (open, gate) = oneshot::channel::<()>();
    let life = life();
    let first = Arc::clone(&calls);
    let starting_first = life.start(move || {
        call(&first, "start");

        Box::pin(async move {
            gate.await.ok();

            Ok(bound())
        })
    });

    let refused = life
        .start(starting(&calls))
        .await
        .expect_err("refused while starting");

    assert_eq!(
        refused.to_string(),
        "the transport server is already connecting",
        "its refusal"
    );

    open.send(()).ok();
    starting_first.await.expect("the first started");
    assert_eq!(taken(&calls), ["start"], "the transport reached once");
}

#[tokio::test]
async fn stops_at_once_when_never_started_or_already_stopped() {
    let calls = calls();
    let life = life();

    life.stop(stopping(&calls)).await.expect("stopped at once");
    life.start(starting(&calls)).await.expect("started");
    life.stop(stopping(&calls)).await.expect("stopped");
    life.stop(stopping(&calls)).await.expect("stopped at once");

    assert_eq!(taken(&calls), ["start", "stop"], "stopped once");
    assert_eq!(
        life.ready_state(),
        ReadyState::Closed,
        "closed, a stop ended"
    );
}

#[tokio::test]
async fn shares_a_stop_already_in_progress() {
    let calls = calls();
    let (open, gate) = oneshot::channel::<()>();
    let life = life();

    life.start(starting(&calls)).await.expect("started");

    let held = Arc::clone(&calls);
    let first = life.stop(move || {
        call(&held, "stop");

        Box::pin(async move {
            gate.await.ok();

            Ok(())
        })
    });
    let second = life.stop(stopping(&calls));

    assert_eq!(
        life.ready_state(),
        ReadyState::Closing,
        "closing, a stop begun"
    );

    open.send(()).ok();
    first.await.expect("stopped");
    second.await.expect("stopped with the first");
    assert_eq!(
        taken(&calls),
        ["start", "stop"],
        "the transport stopped once"
    );
    assert_eq!(life.ready_state(), ReadyState::Closed, "closed");
}

#[tokio::test]
async fn rejects_a_stop_while_starting() {
    let (open, gate) = oneshot::channel::<()>();
    let life = life();
    let starting_first = life.start(move || {
        Box::pin(async move {
            gate.await.ok();

            Ok(bound())
        })
    });

    let refused = life
        .stop(stopping(&calls()))
        .await
        .expect_err("refused while starting");

    assert!(
        matches!(&refused, RouterError::Other(error) if error.is::<ProgrammerError>()),
        "a programmer error: {refused:?}"
    );
    assert_eq!(
        refused.to_string(),
        "the transport server is starting",
        "its refusal"
    );
    assert_eq!(life.ready_state(), ReadyState::Connecting, "still starting");

    open.send(()).ok();
    starting_first.await.expect("started");
    life.stop(stopping(&calls())).await.expect("stopped");
    assert_eq!(life.ready_state(), ReadyState::Closed, "closed");
}

#[tokio::test]
async fn a_transport_stop_that_throws_still_ends_closed_as_a_rejection() {
    let life = life();

    life.start(starting(&calls())).await.expect("started");

    let refused = life
        .stop(|| Box::pin(async { Err(failed("stop failed")) }))
        .await
        .expect_err("its stop failed");

    assert_eq!(
        refused.to_string(),
        "stop failed",
        "the transport's failure"
    );
    assert_eq!(
        life.ready_state(),
        ReadyState::Closed,
        "closed all the same"
    );
}

#[tokio::test]
async fn a_stop_re_entered_from_a_close_listener_shares_the_stop_in_progress() {
    let calls = calls();
    let stops: Stops = Arc::new(Mutex::new(Vec::new()));
    let life = life();

    life.start(starting(&calls)).await.expect("started");

    let (held, again, within) = (Arc::clone(&calls), Arc::clone(&life), Arc::clone(&stops));
    let stopped = life.stop(move || {
        call(&held, "stop");

        // what the stop causes, a close, stops it again
        let shared = again.stop(stopping(&held));

        within
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(shared);

        Box::pin(async { Ok(()) })
    });

    stopped.await.expect("stopped");

    let shared: Vec<_> = stops
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .drain(..)
        .collect();

    assert_eq!(shared.len(), 1, "one stop re-entered");

    for stop in shared {
        stop.await.expect("the stop in progress, shared");
    }

    assert_eq!(
        taken(&calls),
        ["start", "stop"],
        "the transport stopped once"
    );
}
