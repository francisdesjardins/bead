//! Request options, payload encoding, defaults, deprecation and a command's trace.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::{ClientFixture, Fixture, locked};
use crate::constants::ProcedureKind;
use crate::debug::{DebugDirection, DebugType};
use crate::envelope::{Envelope, ResultHeader};
use crate::identity::{Deprecation, Procedure};
use crate::managers::service::{
    RequestDefaults, RequestDependencies, RequestOptions, ServiceManager, ServiceManagerOptions,
    ServiceRouter,
};
use crate::payloads::{JsonCodec, TextCodec};
use crate::testing::pair::echo;
use crate::testing::scripted::handle_of;

fn result(call_id: u32, payload: Bytes) -> Envelope {
    Envelope::Result {
        header: ResultHeader {
            call_id,
            total: None,
            credential: None,
        },
        payload,
    }
}

fn command() -> Procedure {
    Procedure {
        procedure_kind: Some(ProcedureKind::Command),
        ..echo()
    }
}

#[tokio::test]
async fn declares_its_requester_to_its_router_as_it_is_made_and_hands_each_of_its_calls_the_series_it_gave()
 {
    let registry =
        crate::metrics::MetricsRegistry::new(&crate::metrics::MetricsRegistryOptions::default())
            .expect("a registry");
    let fixture = Fixture::with(&crate::router::server::RouterServerOptions {
        metrics_registry: Some(registry),
        ..crate::router::server::RouterServerOptions::default()
    });
    let declarations = Arc::new(Mutex::new(Vec::new()));
    let declared_series = Arc::new(Mutex::new(None::<crate::metrics::ProcedureSeries>));
    let declarations_for_probe = Arc::clone(&declarations);
    let series_for_probe = Arc::clone(&declared_series);
    let calls = Arc::new(Mutex::new(Vec::new()));
    let calls_for_probe = Arc::clone(&calls);
    fixture
        .router
        .observe_requester(crate::testing::scripted::RequesterProbe {
            declared: Arc::new(move |procedure, series| {
                locked(&declarations_for_probe).push(procedure.procedure_name.clone());
                *locked(&series_for_probe) = Some(series.expect("a declared series").clone());
            }),
            called: Arc::new(move |series| {
                let same = locked(&declared_series)
                    .as_ref()
                    .expect("declared before the call")
                    .is_same(series.expect("the handed series"));
                locked(&calls_for_probe).push(same);
            }),
        });
    let request = fixture
        .manager
        .get_command(&command(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("echo declared");
    assert_eq!(*locked(&declarations), ["echo"]);
    assert!(locked(&calls).is_empty(), "the declaration makes no call");
    fixture.transport.open(&handle_of(1), true);
    fixture.clock.settle().await;
    for (id, payload) in [(2, "x"), (4, "y")] {
        let answer = request
            .call(
                payload.to_owned(),
                &RequestOptions {
                    connection_handle: Some(handle_of(1)),
                    ..RequestOptions::default()
                },
            )
            .expect("a command");
        fixture.clock.settle().await;
        fixture.transport.deliver(
            &result(id, Bytes::copy_from_slice(payload.as_bytes())),
            &handle_of(1),
        );
        fixture.clock.settle().await;
        assert_eq!(answer.await.expect("answered"), payload);
    }
    assert_eq!(*locked(&declarations), ["echo"]);
    assert_eq!(*locked(&calls), [true, true]);
    fixture.router.dispose().await;
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the same timeout matrix and the other endings as both other sides"
)]
async fn one_unanswered_in_time_closes_its_connection_as_the_call_or_else_the_manager_says_nothing_else_does()
 {
    use crate::constants::{ProtocolCode, RouterSide};
    use crate::envelope::FailureHeader;
    use crate::errors::CallError;
    use crate::failure::Failure;

    let closed = Arc::new(Mutex::new(Vec::new()));
    for (default, own, can_close, ending, closes) in [
        (true, None, true, "timeout", true),
        (true, Some(false), true, "timeout", false),
        (false, None, true, "timeout", false),
        (true, None, false, "timeout", false),
        (false, Some(true), true, "timeout", true),
        (true, None, true, "failure", false),
        (true, None, true, "closed", false),
        (true, None, true, "cancelled", false),
        (true, None, true, "result", false),
    ] {
        let fixture = Fixture::new();
        fixture.transport.open(&handle_of(1), true);
        let closing = Arc::clone(&closed);
        let manager = ServiceManager::new(
            ServiceRouter::Server(fixture.router.clone()),
            &ServiceManagerOptions {
                close_connection: can_close.then(|| -> super::super::CloseConnection {
                    Arc::new(move |handle| locked(&closing).push(Arc::clone(handle)))
                }),
                defaults: Some(RequestDefaults {
                    close_on_timeout: Some(default),
                    ..RequestDefaults::default()
                }),
                ..ServiceManagerOptions::default()
            },
        )
        .expect("a manager");
        let signal = CancellationToken::new();
        let call = manager
            .get_command(&command(), RequestDependencies::new(TextCodec, TextCodec))
            .expect("declared")
            .call(
                "run".to_owned(),
                &RequestOptions {
                    connection_handle: Some(handle_of(1)),
                    timeout: Some(Duration::from_millis(10)),
                    close_on_timeout: own,
                    signal: Some(signal.clone()),
                    ..RequestOptions::default()
                },
            )
            .expect("called");
        fixture.clock.settle().await;
        let before = locked(&closed).len();
        match ending {
            "timeout" => fixture.clock.advance(Duration::from_millis(10)).await,
            "failure" => fixture.transport.deliver(
                &Envelope::Failure {
                    header: FailureHeader {
                        call_id: 2,
                        credential: None,
                    },
                    failure: Failure::protocol(ProtocolCode::PROCEDURE_FAILED, RouterSide::Client)
                        .record(),
                },
                &handle_of(1),
            ),
            "closed" => fixture.transport.close_connection(&handle_of(1)),
            "cancelled" => signal.cancel(),
            "result" => fixture
                .transport
                .deliver(&result(2, Bytes::from_static(b"run")), &handle_of(1)),
            _ => panic!("a test ending"),
        }
        let outcome = crate::testing::patience(Duration::from_secs(10), call)
            .await
            .expect("settled");
        match ending {
            "timeout" => assert!(
                matches!(outcome, Err(CallError::TimedOut(delay)) if delay == Duration::from_millis(10))
            ),
            "failure" => assert!(
                matches!(outcome, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::PROCEDURE_FAILED.get())
            ),
            "closed" => assert!(matches!(outcome, Err(CallError::Disconnected(_)))),
            "cancelled" => assert!(matches!(outcome, Err(CallError::Cancelled))),
            "result" => assert_eq!(outcome.expect("answered"), "run"),
            _ => panic!("a test ending"),
        }
        assert_eq!(
            locked(&closed).len() - before,
            usize::from(closes),
            "{ending}, default {default}, own {own:?}"
        );
        fixture.router.dispose().await;
    }
    assert_eq!(*locked(&closed), [handle_of(1), handle_of(1)]);

    let fixture = ClientFixture::new();
    let closing = Arc::clone(&closed);
    let manager = ServiceManager::new(
        ServiceRouter::Client(fixture.router.clone()),
        &ServiceManagerOptions {
            close_connection: Some(Arc::new(move |handle| {
                locked(&closing).push(Arc::clone(handle));
            })),
            defaults: Some(RequestDefaults {
                close_on_timeout: Some(true),
                ..RequestDefaults::default()
            }),
            ..ServiceManagerOptions::default()
        },
    )
    .expect("a manager");
    let call = manager
        .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("declared")
        .call(
            "run".to_owned(),
            &RequestOptions {
                timeout: Some(Duration::from_millis(10)),
                ..RequestOptions::default()
            },
        )
        .expect("called");
    fixture.clock.advance(Duration::from_millis(10)).await;
    assert!(matches!(
        crate::testing::patience(Duration::from_secs(10), call)
            .await
            .expect("settled"),
        Err(CallError::TimedOut(_))
    ));
    assert_eq!(*locked(&closed), [handle_of(1), handle_of(1)]);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn fills_what_the_options_leave_out_and_passes_a_destination_as_it_is() {
    let fixture = Fixture::new();
    fixture.transport.open(&handle_of(1), true);
    let defaults = &fixture.manager.inner;
    assert_eq!(defaults.timeout, Duration::from_secs(5));
    for (default_close, own_close, destination, timeout, expected_close) in [
        (None, None, None, None, false),
        (None, None, Some(4), Some(Duration::from_millis(10)), false),
        (Some(true), None, None, None, true),
        (Some(true), Some(false), None, None, false),
    ] {
        let manager = ServiceManager::new(
            ServiceRouter::Server(fixture.router.clone()),
            &ServiceManagerOptions {
                defaults: Some(RequestDefaults {
                    close_on_timeout: default_close,
                    ..RequestDefaults::default()
                }),
                ..ServiceManagerOptions::default()
            },
        )
        .expect("a manager");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let hearing = Arc::clone(&seen);
        manager.on_debug(Arc::new(move |_, event| {
            if event.direction == DebugDirection::Tx {
                locked(&hearing).push(event.options.clone().expect("options"));
            }
        }));
        let options = RequestOptions {
            connection_handle: Some(handle_of(1)),
            destination_id: destination,
            timeout,
            close_on_timeout: own_close,
            ..RequestOptions::default()
        };
        let call = manager
            .get_command(&command(), RequestDependencies::new(TextCodec, TextCodec))
            .expect("declared")
            .call("hi".to_owned(), &options.clone())
            .expect("called");
        fixture.clock.settle().await;
        let sent = fixture.transport.take();
        let Envelope::Request { header, .. } = &sent[0].1 else {
            panic!("a request")
        };
        assert_eq!(header.destination_id, destination);
        fixture.transport.deliver(
            &result(header.call_id, Bytes::from_static(b"hi")),
            &handle_of(1),
        );
        assert_eq!(
            crate::testing::patience(Duration::from_secs(10), call)
                .await
                .expect("answered")
                .expect("result"),
            "hi"
        );
        let seen = locked(&seen).clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            (
                seen[0].connection_handle.clone(),
                seen[0].destination_id,
                seen[0].timeout,
                seen[0].close_on_timeout.unwrap_or(false)
            ),
            (
                Some(handle_of(1)),
                destination,
                timeout.unwrap_or(Duration::from_secs(5)),
                expected_close
            )
        );
        assert_eq!(
            (
                options.connection_handle,
                options.destination_id,
                options.timeout,
                options.close_on_timeout
            ),
            (Some(handle_of(1)), destination, timeout, own_close)
        );
    }
    fixture.router.dispose().await;
}

// decision 0004: a server's call names its connection, refused at the call without one where the
// TypeScript side's types refuse it
#[tokio::test]
async fn on_a_server_router_names_the_connection_it_goes_to() {
    let fixture = Fixture::new();
    fixture.transport.open(&handle_of(1), true);
    let requester = fixture
        .manager
        .get_command(&command(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("declared");
    let options = RequestOptions {
        connection_handle: Some(handle_of(1)),
        ..RequestOptions::default()
    };
    let call = requester.call("a".to_owned(), &options).expect("called");
    fixture.clock.settle().await;
    let sent = fixture.transport.take();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, handle_of(1));
    let Envelope::Request { header, .. } = &sent[0].1 else {
        panic!("a request")
    };
    fixture.transport.deliver(
        &result(header.call_id, Bytes::from_static(b"a")),
        &handle_of(1),
    );
    assert_eq!(
        crate::testing::patience(Duration::from_secs(10), call)
            .await
            .expect("answered")
            .expect("result"),
        "a"
    );
    assert_eq!(
        requester
            .call("b".to_owned(), &RequestOptions::default())
            .expect_err("no connection named")
            .message(),
        "a server request names the connection it goes to"
    );
    fixture.clock.settle().await;
    assert_eq!(fixture.transport.take().len(), 0);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn sends_the_encoded_payload_with_the_resolved_options_and_decodes_the_answer() {
    let fixture = ClientFixture::new();
    let requester = fixture
        .manager
        .get_request(&echo(), RequestDependencies::new(JsonCodec, JsonCodec))
        .expect("declared");
    let call = requester
        .call(
            serde_json::json!({ "text": "hello" }),
            &RequestOptions {
                timeout: Some(Duration::from_millis(100)),
                ..RequestOptions::default()
            },
        )
        .expect("called");
    fixture.clock.settle().await;
    assert_eq!(fixture.clock.dues(), [Duration::from_millis(100)]);
    assert!(
        matches!(&fixture.transport.envelopes()[0], Envelope::Request { payload, header } if payload.as_ref() == br#"{"text":"hello"}"# && header.call_id == 1)
    );
    fixture
        .transport
        .deliver(&result(1, Bytes::from_static(br#"{"text":"hello"}"#)));
    assert_eq!(
        crate::testing::patience(Duration::from_secs(10), call)
            .await
            .expect("answered")
            .expect("decoded"),
        serde_json::json!({ "text": "hello" })
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn takes_the_managers_defaults_where_the_call_says_nothing_and_its_signal_as_given() {
    let fixture = ClientFixture::new();
    let manager = ServiceManager::new(
        ServiceRouter::Client(fixture.router.clone()),
        &ServiceManagerOptions {
            defaults: Some(RequestDefaults {
                timeout: Some(Duration::from_millis(50)),
                ..RequestDefaults::default()
            }),
            ..ServiceManagerOptions::default()
        },
    )
    .expect("a manager");
    let requester = manager
        .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("declared");
    let first = requester
        .call("a".to_owned(), &RequestOptions::default())
        .expect("called");
    let signal = CancellationToken::new();
    let second = requester
        .call(
            "b".to_owned(),
            &RequestOptions {
                destination_id: Some(2),
                signal: Some(signal.clone()),
                timeout: Some(Duration::from_millis(9)),
                ..RequestOptions::default()
            },
        )
        .expect("called");
    let third = fixture
        .manager
        .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("declared")
        .call("c".to_owned(), &RequestOptions::default())
        .expect("called");
    fixture.clock.settle().await;
    assert_eq!(
        fixture.clock.dues(),
        [
            Duration::from_millis(50),
            Duration::from_millis(9),
            Duration::from_secs(5)
        ]
    );
    assert_eq!(
        fixture
            .transport
            .envelopes()
            .iter()
            .map(|envelope| {
                let Envelope::Request { header, .. } = envelope else {
                    panic!("a request")
                };
                header.destination_id
            })
            .collect::<Vec<_>>(),
        [None, Some(2), None]
    );
    signal.cancel();
    assert!(matches!(
        crate::testing::patience(Duration::from_secs(10), second)
            .await
            .expect("settled"),
        Err(crate::errors::CallError::Cancelled)
    ));
    for (id, call, payload) in [(1, first, "a"), (5, third, "c")] {
        fixture
            .transport
            .deliver(&result(id, Bytes::copy_from_slice(payload.as_bytes())));
        assert_eq!(
            crate::testing::patience(Duration::from_secs(10), call)
                .await
                .expect("answered")
                .expect("result"),
            payload
        );
    }
    crate::testing::surface::Consumer::new().refuses(
        "pub fn check(mut defaults: bead::RequestDefaults) { defaults.destination_id = Some(4); }",
        ("E0609", "no field `destination_id`"),
    );
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_deprecated_procedure_raises_deprecated_at_each_call_and_only_a_deprecated_one() {
    let fixture = ClientFixture::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&seen);
    fixture.manager.on_deprecated(Arc::new(move |procedure| {
        locked(&hearing).push(procedure.clone());
    }));
    let old = Procedure {
        deprecation: Some(Deprecation {
            message: Some("use echo2".to_owned()),
        }),
        ..echo()
    };
    let empty = Procedure {
        deprecation: Some(Deprecation::default()),
        ..echo()
    };
    let requester = fixture
        .manager
        .get_request(&old, RequestDependencies::new(TextCodec, TextCodec))
        .expect("declared");
    let calls = [
        requester
            .call("a".to_owned(), &RequestOptions::default())
            .expect("called"),
        requester
            .call("b".to_owned(), &RequestOptions::default())
            .expect("called"),
        fixture
            .manager
            .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
            .expect("declared")
            .call("c".to_owned(), &RequestOptions::default())
            .expect("called"),
        fixture
            .manager
            .get_request(&empty, RequestDependencies::new(TextCodec, TextCodec))
            .expect("declared")
            .call("d".to_owned(), &RequestOptions::default())
            .expect("called"),
    ];
    fixture.clock.settle().await;
    for (id, call) in [1, 3, 5, 7].into_iter().zip(calls) {
        fixture.transport.deliver(&result(id, Bytes::new()));
        crate::testing::patience(Duration::from_secs(10), call)
            .await
            .expect("answered")
            .expect("result");
    }
    assert_eq!(*locked(&seen), [old.clone(), old, empty]);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn get_command_asks_one_connection_as_a_servers_request_does_and_tells_debug_it_is_a_command()
{
    let fixture = Fixture::new();
    let heard = fixture.heard();
    fixture.transport.open(&handle_of(1), true);
    let requester = fixture
        .manager
        .get_command(&command(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("declared");
    assert_eq!(requester.procedure().procedure_name, "echo");
    let call = requester
        .call(
            "run".to_owned(),
            &RequestOptions {
                connection_handle: Some(handle_of(1)),
                ..RequestOptions::default()
            },
        )
        .expect("called");
    fixture.clock.settle().await;
    assert_eq!(fixture.transport.take()[0].0, handle_of(1));
    fixture
        .transport
        .deliver(&result(2, Bytes::from_static(b"run")), &handle_of(1));
    assert_eq!(
        crate::testing::patience(Duration::from_secs(10), call)
            .await
            .expect("answered")
            .expect("result"),
        "run"
    );
    assert_eq!(
        locked(&heard)
            .iter()
            .map(|(_, event)| (event.direction, event.call_type))
            .collect::<Vec<_>>(),
        [
            (DebugDirection::Tx, DebugType::Command),
            (DebugDirection::Rx, DebugType::Command)
        ]
    );
    requester
        .call("run".to_owned(), &RequestOptions::default())
        .expect_err("a command names a connection");
    fixture.router.dispose().await;
}

#[tokio::test]
async fn tells_debug_the_close_on_timeout_that_applies_the_calls_or_else_the_managers() {
    let fixture = Fixture::new();
    fixture.transport.open(&handle_of(1), true);
    let manager = ServiceManager::new(
        ServiceRouter::Server(fixture.router.clone()),
        &ServiceManagerOptions {
            close_connection: Some(Arc::new(|_| {})),
            defaults: Some(RequestDefaults {
                close_on_timeout: Some(true),
                ..RequestDefaults::default()
            }),
            ..ServiceManagerOptions::default()
        },
    )
    .expect("a manager");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&seen);
    manager.on_debug(Arc::new(move |_, event| {
        if event.direction == DebugDirection::Tx {
            locked(&hearing).push(event.options.as_ref().expect("options").close_on_timeout);
        }
    }));
    let requester = manager
        .get_command(&command(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("declared");
    for (call_id, close) in [(2, None), (4, Some(false))] {
        let call = requester
            .call(
                "run".to_owned(),
                &RequestOptions {
                    connection_handle: Some(handle_of(1)),
                    close_on_timeout: close,
                    ..RequestOptions::default()
                },
            )
            .expect("called");
        fixture.clock.settle().await;
        fixture
            .transport
            .deliver(&result(call_id, Bytes::from_static(b"run")), &handle_of(1));
        crate::testing::patience(Duration::from_secs(10), call)
            .await
            .expect("answered")
            .expect("result");
    }
    assert_eq!(*locked(&seen), [Some(true), Some(false)]);
    fixture.router.dispose().await;
}
