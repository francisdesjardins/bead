//! The trace's and the filter's tests: each step of a call, a request and a notification as
//! `debug` hears it, the clocks it reads, what a listener that panics changes; and a filter's words.

use core::time::Duration;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::{CallAsked, DebugDirection, DebugFilterSource, DebugType, FilterKeeper, GivenFilter};
use crate::clock::{Clock, Schedule};
use crate::constants::{ProcedureKind, SERVER_CONNECTION_HANDLE};
use crate::errors::{CallError, ResolverError};
use crate::identity::Procedure;
use crate::managers::service::{
    DebugEvent, NotificationDependencies, NotifyOptions, RequestDependencies, RequestOptions,
    ResolverDependencies, Response, ServiceManager, Traced, TracedError,
};
use crate::payloads::{CodecRefusal, JsonCodec, PayloadCodec};
use crate::router::types::RequestCredential;
use crate::testing::pair::{Pair, PairOptions, echo};

// what a manager's debug listener heard: why, when a step went wrong, and the step
type Heard = Arc<Mutex<Vec<(Option<String>, DebugEvent)>>>;

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn january_first() -> SystemTime {
    crate::testing::instants::new_year()
}

fn milliseconds_of(at: SystemTime) -> i64 {
    i64::try_from(
        at.duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(i64::MAX)
}

fn recorded(manager: &ServiceManager) -> Heard {
    let heard: Heard = Arc::default();
    let hearing = Arc::clone(&heard);

    manager.on_debug(Arc::new(
        move |error: Option<&TracedError>, event: &DebugEvent| {
            locked(&hearing).push((error.map(ToString::to_string), event.clone()));
        },
    ));

    heard
}

fn value_of(traced: Option<&Traced>) -> Option<Value> {
    traced.and_then(|traced| traced.as_any().downcast_ref::<Value>().cloned())
}

// the server answers echo with its payload once `delay` passed on its clock, none for at once
fn serve_echo(pair: &Pair, delay: Option<Duration>) {
    let clock = pair.server.router().clock();

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(JsonCodec, JsonCodec))
        .expect("echo resolved")
        .on(Arc::new(move |request, response: Response<JsonCodec>| {
            let clock = Arc::clone(&clock);

            Box::pin(async move {
                if let Some(delay) = delay {
                    let (woken, wait) = oneshot::channel::<()>();
                    let mut woken = Some(woken);
                    let _timer = clock.arm(
                        Schedule::Once(delay),
                        Box::new(move || {
                            if let Some(woken) = woken.take() {
                                woken.send(()).ok();
                            }
                        }),
                    );

                    wait.await.ok();
                }

                response.result(request.payload).await
            })
        }))
        .expect("echo registered");
}

async fn pair() -> Pair {
    Pair::connected((january_first(), PairOptions::default()))
        .await
        .expect("a pair connected")
}

fn asking(manager: &ServiceManager) -> crate::managers::service::Request<JsonCodec, JsonCodec> {
    manager
        .get_request(&echo(), RequestDependencies::of(JsonCodec, JsonCodec))
        .expect("echo asked")
}

// debugging 1.1, 4.1, 4.1.1, 4.1.2, 4.1.3, 4.1.4, 4.1.6, 4.1.8
#[tokio::test]
async fn tells_each_step_of_a_request_and_once_answered_its_duration() {
    let pair = pair().await;
    let manager = pair.client.services();
    let heard = recorded(manager);

    serve_echo(&pair, Some(Duration::from_millis(30)));

    let call = asking(manager)
        .call(json!({ "text": "hello" }), RequestOptions::default())
        .expect("echo called");

    pair.clock.advance(Duration::from_millis(30)).await;

    assert_eq!(
        call.await.expect("echo answered"),
        json!({ "text": "hello" }),
        "its payload"
    );

    let heard = locked(&heard).clone();
    let steps: Vec<_> = heard
        .iter()
        .map(|(error, event)| {
            (
                error.clone(),
                event.call_id,
                event.connection_handle.as_deref().map(str::to_owned),
                event.direction,
                event.duration,
                event.options.as_ref().map(|options| options.timeout),
                (
                    event.service_id,
                    event.procedure_id,
                    event.procedure_name.clone(),
                    event.service_revision,
                ),
                event.started_at,
                value_of(event.tx.as_ref()),
                value_of(event.rx.as_ref()),
                event.call_type,
            )
        })
        .collect();
    let address = (2, 1, "echo".to_owned(), 3);
    let sent = (
        None,
        Some(1),
        Some(SERVER_CONNECTION_HANDLE.to_owned()),
        DebugDirection::Tx,
        None,
        Some(Duration::from_secs(5)),
        address.clone(),
        milliseconds_of(january_first()),
        Some(json!({ "text": "hello" })),
        None,
        DebugType::Request,
    );
    let answered = (
        None,
        Some(1),
        Some(SERVER_CONNECTION_HANDLE.to_owned()),
        DebugDirection::Rx,
        Some(30),
        Some(Duration::from_secs(5)),
        address,
        milliseconds_of(january_first()),
        Some(json!({ "text": "hello" })),
        Some(json!({ "text": "hello" })),
        DebugType::Request,
    );

    assert_eq!(
        steps,
        vec![sent, answered],
        "its tx step, then its rx step with its duration"
    );
}

// debugging 4.1.10, 4.2.1, 4.2.2
#[tokio::test]
async fn tells_a_call_made_and_its_answer_with_the_call_id_its_router_drew_and_their_connection() {
    let pair = pair().await;
    let either = Procedure {
        kind: None,
        ..echo()
    };
    let seen = recorded(pair.client.services());
    let commanded = recorded(pair.server.services());

    serve_echo(&pair, None);
    pair.client
        .services()
        .get_command_resolver(&either, ResolverDependencies::of(JsonCodec, JsonCodec))
        .expect("a command resolved")
        .on(Arc::new(|request, response: Response<JsonCodec>| {
            response.result(request.payload)
        }))
        .expect("a command registered");

    let asked = asking(pair.client.services())
        .call(json!({ "text": "a" }), RequestOptions::default())
        .expect("a call");

    pair.settle().await;
    asked.await.expect("an answer");

    let command = pair
        .server
        .services()
        .get_command(&either, RequestDependencies::of(JsonCodec, JsonCodec))
        .expect("a command");
    let commanding = command
        .call(
            json!({ "text": "b" }),
            RequestOptions {
                connection_handle: Some(Arc::clone(&pair.connection_handle)),
                ..RequestOptions::default()
            },
        )
        .expect("a command made");

    pair.settle().await;
    commanding.await.expect("an answer");

    let named: Vec<_> = locked(&seen)
        .iter()
        .chain(locked(&commanded).iter())
        .filter(|(_, event)| {
            event.call_type != DebugType::Command
                || event.direction == DebugDirection::Tx
                || event.duration.is_some()
        })
        .map(|(_, event)| {
            (
                event.direction,
                event.call_id,
                event.connection_handle.as_deref().map(str::to_owned),
            )
        })
        .collect();
    let server = Some(SERVER_CONNECTION_HANDLE.to_owned());
    let connection = Some(pair.connection_handle.to_string());

    assert_eq!(
        named.first().cloned(),
        Some((DebugDirection::Tx, Some(1), server.clone())),
        "the request, on the client's call id 1, to the server"
    );
    assert!(
        named.contains(&(DebugDirection::Rx, Some(1), server)),
        "its answer, on that call id: {named:?}"
    );
    assert!(
        named.contains(&(DebugDirection::Tx, Some(2), connection.clone())),
        "the command, on the server's call id 2, to the connection: {named:?}"
    );
    assert!(
        named.contains(&(DebugDirection::Rx, Some(2), connection)),
        "its answer, on that call id: {named:?}"
    );
}

// debugging 4.2.1, 4.4
#[tokio::test]
async fn tells_a_call_its_router_refuses_before_drawing_an_id_with_none_its_tx_step_then_its_rx_step()
 {
    let pair = pair().await;
    let seen = recorded(pair.client.services());

    // OPAQUE with no session known: refused SESSION_REQUIRED once it started, no call id drawn
    let refused = asking(pair.client.services())
        .call(
            json!({ "text": "x" }),
            RequestOptions {
                credential: Some(RequestCredential::Opaque),
                ..RequestOptions::default()
            },
        )
        .expect("a call made")
        .await;

    pair.settle().await;

    assert!(
        matches!(&refused, Err(CallError::Failure(failure)) if failure.is_protocol_code(&[crate::constants::ProtocolCode::SESSION_REQUIRED])),
        "refused SESSION_REQUIRED: {refused:?}"
    );

    let steps: Vec<_> = locked(&seen)
        .iter()
        .map(|(error, event)| {
            (
                event.direction,
                event.call_id,
                event.connection_handle.clone(),
                error.is_some(),
            )
        })
        .collect();

    assert_eq!(
        steps,
        vec![
            (DebugDirection::Tx, None, None, false),
            (DebugDirection::Rx, None, None, true)
        ],
        "its tx step, then its rx step with why, no call id and no connection"
    );
}

// debugging 3.2, 4.1.5, 4.1.6
#[tokio::test]
async fn reads_its_router_s_clock_a_call_s_start_on_the_wall_clock_its_duration_on_the_monotonic_reading()
 {
    let pair = pair().await;
    let seen = recorded(pair.client.services());

    serve_echo(&pair, Some(Duration::from_millis(250)));

    let answering = asking(pair.client.services())
        .call(json!({ "text": "hello" }), RequestOptions::default())
        .expect("a call");

    // a wall clock set back by hand moves no duration
    pair.clock.wall_by(-86_400_000);
    pair.clock.advance(Duration::from_millis(250)).await;
    answering.await.expect("an answer");

    let read: Vec<_> = locked(&seen)
        .iter()
        .map(|(_, event)| (event.duration, event.started_at))
        .collect();
    let start = milliseconds_of(january_first());

    assert_eq!(
        read,
        vec![(None, start), (Some(250), start)],
        "its start, then its duration"
    );
}

// debugging 4.1.6, 11.4
#[tokio::test]
async fn tells_a_duration_in_whole_milliseconds_its_fraction_dropped() {
    let pair = pair().await;
    let seen = recorded(pair.client.services());
    let (release, released) = oneshot::channel::<()>();
    let released = Arc::new(Mutex::new(Some(released)));

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(JsonCodec, JsonCodec))
        .expect("echo resolved")
        .on(Arc::new(move |request, response: Response<JsonCodec>| {
            let released = locked(&released).take();

            Box::pin(async move {
                if let Some(released) = released {
                    released.await.ok();
                }

                response.result(request.payload).await
            })
        }))
        .expect("echo registered");

    let before = pair.clock.monotonic();
    let answering = asking(pair.client.services())
        .call(json!({ "text": "hello" }), RequestOptions::default())
        .expect("a call");

    pair.settle().await;
    pair.clock.advance(Duration::from_micros(30_600)).await;
    release.send(()).ok();
    pair.settle().await;
    answering.await.expect("an answer");

    // the call took 30.6 ms of the monotonic reading, and is told as 30
    assert_eq!(
        pair.clock.monotonic().saturating_sub(before),
        Duration::from_micros(30_600),
        "30.6 ms"
    );
    assert_eq!(
        locked(&seen)
            .iter()
            .map(|(_, event)| event.duration)
            .collect::<Vec<_>>(),
        vec![None, Some(30)],
        "told in whole milliseconds"
    );
}

// a codec that writes no value: what a value that does not write meets
#[derive(Debug, Clone, Copy)]
struct Unwritable;

impl PayloadCodec for Unwritable {
    type Value = Value;

    fn decode(&self, bytes: &Bytes) -> Result<Value, CodecRefusal> {
        JsonCodec.decode(bytes)
    }

    fn encode(&self, _value: &Value) -> Result<Bytes, CodecRefusal> {
        Err(CodecRefusal::new("this value does not write"))
    }

    fn encoding(&self) -> &'static str {
        "json"
    }
}

fn ticks() -> Procedure {
    Procedure {
        service_id: 2,
        id: 2,
        service_revision: 3,
        name: "ticks".to_owned(),
        kind: Some(ProcedureKind::Notifies),
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

// debugging 4.1.5, 4.2.5, 4.2.6
#[tokio::test]
async fn a_notification_starts_as_it_is_heard_or_sent_and_a_failed_notify_tells_its_failure_at_that_same_start()
 {
    let pair = pair().await;
    let start = milliseconds_of(january_first());
    let notifying = pair.server.services();
    let hearing = pair.client.services();
    let notifier = notifying
        .get_notification_resolver(
            &ticks(),
            (ResolverDependencies::of(JsonCodec, JsonCodec), JsonCodec),
        )
        .expect("ticks resolved")
        .on(Arc::new(|_request, response: Response<JsonCodec>| {
            response.result(Value::Null)
        }))
        .expect("ticks registered");
    let failing = notifying
        .get_notification_resolver(
            &Procedure {
                id: 3,
                name: "late".to_owned(),
                ..ticks()
            },
            (ResolverDependencies::of(JsonCodec, JsonCodec), Unwritable),
        )
        .expect("late resolved")
        .on(Arc::new(|_request, response: Response<JsonCodec>| {
            response.result(Value::Null)
        }))
        .expect("late registered");
    let notification = hearing
        .get_notification(
            &ticks(),
            NotificationDependencies::of((JsonCodec, JsonCodec, JsonCodec)),
        )
        .expect("ticks heard");
    let registering = notification.on(
        (Value::Null, Arc::new(|_value| Box::pin(async { Ok(()) }))),
        RequestOptions::default(),
    );

    pair.settle().await;
    registering.await.expect("subscribed");

    let heard = recorded(hearing);
    let sent = recorded(notifying);

    pair.clock.advance(Duration::from_millis(10)).await;
    notifier
        .notify(json!({ "text": "news" }), &NotifyOptions::default())
        .await;
    pair.settle().await;
    pair.clock.advance(Duration::from_millis(10)).await;
    failing
        .notify(json!({ "text": "late" }), &NotifyOptions::default())
        .await;
    pair.settle().await;

    let heard: Vec<_> = locked(&heard)
        .iter()
        .map(|(_, event)| {
            (
                event.direction,
                event.started_at,
                event.duration,
                event.call_id,
            )
        })
        .collect();
    let sent: Vec<_> = locked(&sent)
        .iter()
        .map(|(error, event)| {
            (
                error.is_some(),
                event.started_at,
                event.duration,
                event.call_id,
            )
        })
        .collect();

    assert_eq!(
        heard,
        vec![(DebugDirection::Rx, start + 10, None, None)],
        "heard as it came"
    );
    assert_eq!(
        sent,
        vec![
            (false, start + 10, None, None),
            (false, start + 20, None, None),
            (true, start + 20, None, None),
        ],
        "each sent as it went, a failure told at its start"
    );
}

// debugging 3.1, 3.2, 3.4
#[tokio::test]
async fn reads_no_clock_for_a_call_made_a_request_answered_a_notification_sent_and_one_heard_while_nobody_listens_and_three_for_a_call_with_a_listener()
 {
    async fn readings_of(
        pair: &Pair,
        (manager_notifier, ask): (
            &crate::managers::service::Notifier<JsonCodec>,
            &crate::managers::service::Request<JsonCodec, JsonCodec>,
        ),
    ) -> [(usize, usize); 2] {
        let (walls, monotonics) = pair.clock.readings();
        let call = ask
            .call(json!({ "text": "x" }), RequestOptions::default())
            .expect("a call");

        pair.settle().await;
        call.await.expect("an answer");

        let (called_walls, called_monotonics) = pair.clock.readings();

        manager_notifier
            .notify(json!({ "text": "news" }), &NotifyOptions::default())
            .await;
        pair.settle().await;

        let (notified_walls, notified_monotonics) = pair.clock.readings();

        [
            (called_walls - walls, called_monotonics - monotonics),
            (
                notified_walls - called_walls,
                notified_monotonics - called_monotonics,
            ),
        ]
    }

    let pair = pair().await;

    serve_echo(&pair, None);

    let notifier = pair
        .server
        .services()
        .get_notification_resolver(
            &ticks(),
            (ResolverDependencies::of(JsonCodec, JsonCodec), JsonCodec),
        )
        .expect("ticks resolved")
        .on(Arc::new(|_request, response: Response<JsonCodec>| {
            response.result(Value::Null)
        }))
        .expect("ticks registered");
    let notification = pair
        .client
        .services()
        .get_notification(
            &ticks(),
            NotificationDependencies::of((JsonCodec, JsonCodec, JsonCodec)),
        )
        .expect("ticks heard");
    let registering = notification.on(
        (Value::Null, Arc::new(|_value| Box::pin(async { Ok(()) }))),
        RequestOptions::default(),
    );

    pair.settle().await;
    registering.await.expect("subscribed");

    let ask = asking(pair.client.services());
    let unheard = readings_of(&pair, (&notifier, &ask)).await;

    for manager in [pair.client.services(), pair.server.services()] {
        manager.on_debug(Arc::new(|_error, _event| {}));
    }

    let heard = readings_of(&pair, (&notifier, &ask)).await;

    // a call's start on both clocks, and its end on the monotonic one, at each end; a
    // notification's on the wall clock alone, at each end (spec/debugging.md 3.2)
    assert_eq!(
        [
            (heard[0].0 - unheard[0].0, heard[0].1 - unheard[0].1),
            (heard[1].0 - unheard[1].0, heard[1].1 - unheard[1].1),
        ],
        [(2, 4), (2, 0)],
        "three readings a call made and three a request answered, one a notification sent and one heard"
    );
}

// debugging 2.2, 2.3
#[tokio::test]
async fn a_debug_listener_that_throws_on_the_answer_is_reported_through_the_router_and_the_call_resolves_with_its_result_each_step_told()
 {
    let pair = pair().await;
    let manager = pair.client.services();
    let seen: Arc<Mutex<Vec<DebugDirection>>> = Arc::default();
    let heard: Arc<Mutex<Vec<DebugDirection>>> = Arc::default();
    let (seeing, hearing) = (Arc::clone(&seen), Arc::clone(&heard));

    serve_echo(&pair, None);
    manager.on_debug(Arc::new(move |_error, event: &DebugEvent| {
        locked(&seeing).push(event.direction);

        assert!(event.direction != DebugDirection::Rx, "listener bug");
    }));
    // a listener after it hears each step all the same
    manager.on_debug(Arc::new(move |_error, event: &DebugEvent| {
        locked(&hearing).push(event.direction);
    }));

    let call = asking(manager)
        .call(json!({ "text": "x" }), RequestOptions::default())
        .expect("a call");

    pair.settle().await;

    assert_eq!(
        call.await.expect("its result"),
        json!({ "text": "x" }),
        "the call resolves"
    );
    assert_eq!(
        *locked(&seen),
        vec![DebugDirection::Tx, DebugDirection::Rx],
        "each step told"
    );
    assert_eq!(
        *locked(&heard),
        vec![DebugDirection::Tx, DebugDirection::Rx],
        "to every listener"
    );
    assert_eq!(
        locked(&pair.client_reports).len(),
        1,
        "the panic reported through the router"
    );
}

// debugging 2.2, 2.3
#[tokio::test]
async fn a_request_is_answered_as_a_debug_listener_throws_on_its_rx_step_the_error_reported_through_the_router_with_its_connection()
 {
    let pair = pair().await;

    serve_echo(&pair, None);
    pair.server
        .services()
        .on_debug(Arc::new(|_error, event: &DebugEvent| {
            assert!(event.direction != DebugDirection::Rx, "listener bug");
        }));

    let call = asking(pair.client.services())
        .call(json!({ "text": "hi" }), RequestOptions::default())
        .expect("a call");

    pair.settle().await;

    assert_eq!(
        call.await.expect("its result"),
        json!({ "text": "hi" }),
        "the request answered"
    );

    let reports = locked(&pair.server_reports).clone();

    assert_eq!(reports.len(), 1, "the panic reported once");
    assert_eq!(
        reports.first().and_then(|(_, handle)| handle.clone()),
        Some(Arc::clone(&pair.connection_handle)),
        "with its connection"
    );
}

// debugging 4.1.7
#[tokio::test]
async fn hands_its_router_the_credential_a_call_presents_and_leaves_it_out_of_its_trace() {
    let pair = pair().await;
    let seen = recorded(pair.client.services());

    serve_echo(&pair, None);

    let call = asking(pair.client.services())
        .call(
            json!({ "text": "x" }),
            RequestOptions {
                credential: Some(RequestCredential::Jwt("a.b.c".to_owned())),
                ..RequestOptions::default()
            },
        )
        .expect("a call");

    pair.settle().await;
    drop(call.await);

    let heard = locked(&seen).clone();

    assert!(!heard.is_empty(), "its steps told");
    assert!(
        heard.iter().all(|(_, event)| event
            .options
            .as_ref()
            .is_some_and(|options| options.credential.is_none())),
        "never its credential"
    );
}

// debugging 4.1.9
#[tokio::test]
async fn rethrows_what_the_router_rejects_with_and_tells_debug_its_failure_and_only_a_failure_one()
{
    let pair = pair().await;
    let seen = recorded(pair.client.services());

    // no resolver: the server answers PROCEDURE_UNKNOWN
    let unknown = asking(pair.client.services())
        .call(json!({ "text": "x" }), RequestOptions::default())
        .expect("a call");

    pair.settle().await;

    let failed = unknown.await;

    assert!(
        matches!(failed, Err(CallError::Failure(_))),
        "rejected with its failure: {failed:?}"
    );

    // a timeout: no failure's record to tell
    serve_echo(&pair, Some(Duration::from_secs(60)));

    let late = asking(pair.client.services())
        .call(
            json!({ "text": "y" }),
            RequestOptions {
                timeout: Some(Duration::from_millis(10)),
                ..RequestOptions::default()
            },
        )
        .expect("a call");

    pair.clock.advance(Duration::from_millis(10)).await;

    let timed_out = late.await;

    assert!(
        matches!(timed_out, Err(CallError::TimedOut(_))),
        "timed out: {timed_out:?}"
    );

    let answers: Vec<_> = locked(&seen)
        .iter()
        .filter(|(_, event)| event.direction == DebugDirection::Rx)
        .map(|(error, event)| {
            (
                error.is_some(),
                event
                    .rx
                    .as_ref()
                    .is_some_and(|rx| rx.as_any().is::<crate::envelope::FailureRecord>()),
            )
        })
        .collect();

    assert_eq!(
        answers,
        vec![(true, true), (true, false)],
        "a failure's record told, and only a failure's"
    );
}

// debugging 4.1.10, 4.2.5, 4.2.6
#[tokio::test]
async fn tells_a_notification_sent_or_heard_with_no_call_id() {
    let pair = pair().await;
    let notifier = pair
        .server
        .services()
        .get_notification_resolver(
            &ticks(),
            (ResolverDependencies::of(JsonCodec, JsonCodec), JsonCodec),
        )
        .expect("ticks resolved")
        .on(Arc::new(|_request, response: Response<JsonCodec>| {
            response.result(Value::Null)
        }))
        .expect("ticks registered");
    let notification = pair
        .client
        .services()
        .get_notification(
            &ticks(),
            NotificationDependencies::of((JsonCodec, JsonCodec, JsonCodec)),
        )
        .expect("ticks heard");
    let registering = notification.on(
        (Value::Null, Arc::new(|_value| Box::pin(async { Ok(()) }))),
        RequestOptions::default(),
    );

    pair.settle().await;
    registering.await.expect("subscribed");

    let heard = recorded(pair.client.services());
    let sent = recorded(pair.server.services());

    notifier.notify(json!(1), &NotifyOptions::default()).await;
    pair.settle().await;

    let steps: Vec<_> = locked(&sent)
        .iter()
        .chain(locked(&heard).iter())
        .map(|(_, event)| {
            (
                event.call_type,
                event.direction,
                event.call_id,
                event.connection_handle.clone(),
            )
        })
        .collect();

    assert_eq!(
        steps,
        vec![
            (DebugType::Notification, DebugDirection::Tx, None, None),
            (DebugType::Notification, DebugDirection::Rx, None, None),
        ],
        "no call id, and no connection"
    );
}

// debugging 4.1.10, 4.2.3, 4.2.4
#[tokio::test]
async fn tells_the_request_it_received_and_the_answer_it_sent_with_that_request_s_call_id_and_connection()
 {
    let pair = pair().await;
    let seen = recorded(pair.server.services());

    serve_echo(&pair, None);

    let call = asking(pair.client.services())
        .call(json!({ "text": "x" }), RequestOptions::default())
        .expect("a call");

    pair.settle().await;
    call.await.expect("an answer");

    let steps: Vec<_> = locked(&seen)
        .iter()
        .map(|(_, event)| {
            (
                event.direction,
                event.call_id,
                event.connection_handle.clone(),
                event.duration.is_some(),
            )
        })
        .collect();
    let handle = Some(Arc::clone(&pair.connection_handle));

    assert_eq!(
        steps,
        vec![
            (DebugDirection::Rx, Some(1), handle.clone(), false),
            (DebugDirection::Tx, Some(1), handle, true)
        ],
        "the request's call id and connection, the answer's duration"
    );
}

// debugging 4.2, 4.2.4, 4.3
#[tokio::test]
async fn tells_a_callback_that_fails_before_it_answers_as_an_answer_that_did_not_go_with_why_beside_it_nothing_more_for_one_that_fails_once_it_answered_nor_for_an_admission_that_fails()
 {
    let pair = pair().await;
    let seen = recorded(pair.server.services());

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(JsonCodec, JsonCodec))
        .expect("echo resolved")
        .on(Arc::new(|request, response: Response<JsonCodec>| {
            Box::pin(async move {
                if request.payload == json!("after") {
                    response.result(Value::Null).await?;
                }

                Err(ResolverError::other("this callback fails"))
            })
        }))
        .expect("echo registered");

    for payload in ["before", "after"] {
        let call = asking(pair.client.services())
            .call(json!(payload), RequestOptions::default())
            .expect("a call");

        pair.settle().await;
        drop(call.await);
    }

    let steps: Vec<_> = locked(&seen)
        .iter()
        .map(|(error, event)| (event.direction, error.is_some(), event.duration.is_some()))
        .collect();

    assert_eq!(
        steps,
        vec![
            (DebugDirection::Rx, false, false),
            (DebugDirection::Tx, true, true),
            (DebugDirection::Rx, false, false),
            (DebugDirection::Tx, false, true),
        ],
        "a failure before the answer told with why; none once it answered"
    );
}

// debugging 6.10
#[test]
fn matches_a_whole_name_and_takes_every_other_character_literally() {
    let heard_of = |spec: &str, names: &[&str]| -> Vec<String> {
        let keeper =
            FilterKeeper::new(DebugFilterSource::Given(GivenFilter::Spec(spec.to_owned())))
                .expect("a filter");

        names
            .iter()
            .filter(|name| {
                keeper.keeps_call(&CallAsked {
                    direction: DebugDirection::Tx,
                    call_type: DebugType::Request,
                    procedure_name: name,
                })
            })
            .map(|name| format!("{name} tx request"))
            .collect()
    };
    let names = ["get+status", "a.b", "axb", "getStatusNow"];

    assert_eq!(
        heard_of("get+status", &names),
        vec!["get+status tx request"],
        "a plus itself"
    );
    assert_eq!(
        heard_of("a.b", &names),
        vec!["a.b tx request"],
        "a dot itself"
    );
    assert!(
        heard_of("getStatus, a+b, [x], ^a", &names).is_empty(),
        "nothing a pattern's"
    );
    // neither its start nor its end alone
    assert!(
        heard_of("status, getStatu", &["getStatus"]).is_empty(),
        "a whole name alone"
    );
}

// a platform's shape: a filter given whole holds its directions, types and kinds as the enums the
// grammar names, which hold no other; one given as words naming another is refused as it is made
// debugging 6.8
#[test]
fn refuses_a_filter_given_whole_in_the_grammar_s_names_as_it_is_made() {
    let refusal_of = |spec: &str| {
        FilterKeeper::new(DebugFilterSource::Given(GivenFilter::Spec(spec.to_owned())))
            .expect_err(spec)
            .message()
            .to_owned()
    };

    assert!(
        refusal_of("t(publisher)")
            .starts_with("a debug filter takes a type among request, command, notification"),
        "a type no grammar names"
    );
    assert!(
        refusal_of("d(up)").starts_with("a debug filter takes a direction among rx, tx"),
        "a direction no grammar names"
    );
    assert!(
        refusal_of("e(publish)")
            .starts_with("a debug filter takes a kind among request, result, failure"),
        "a kind no grammar names"
    );
}
