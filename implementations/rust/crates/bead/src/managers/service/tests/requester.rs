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
    CommandOptions, NotificationDependencies, RequestDefaults, RequestDependencies, RequestOptions,
    ServiceManager, ServiceManagerOptions, ServiceRouter,
};
use crate::payloads::{JsonCodec, TextCodec};
use crate::router::types::RequestCredential;
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
            called: Arc::new(move |request| {
                let same = locked(&declared_series)
                    .as_ref()
                    .expect("declared before the call")
                    .is_same(request.series.as_ref().expect("the handed series"));
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
            .call(payload.to_owned(), &CommandOptions::new(handle_of(1)))
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
                &CommandOptions {
                    timeout: Some(Duration::from_millis(10)),
                    close_on_timeout: own,
                    signal: Some(signal.clone()),
                    ..CommandOptions::new(handle_of(1))
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
            "cancelled" => assert!(matches!(outcome, Err(CallError::Cancelled(_)))),
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
        let options = CommandOptions {
            destination_id: destination,
            timeout,
            close_on_timeout: own_close,
            ..CommandOptions::new(handle_of(1))
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
            (handle_of(1), destination, timeout, own_close)
        );
    }
    fixture.router.dispose().await;
}

// decision 0004: a command's connection is required by its type, `CommandOptions::new`'s; the
// router refuses one that names none, for whoever calls it directly
#[tokio::test]
async fn a_command_names_the_connection_it_goes_to() {
    let fixture = Fixture::new();
    fixture.transport.open(&handle_of(1), true);
    let requester = fixture
        .manager
        .get_command(&command(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("declared");
    let options = CommandOptions::new(handle_of(1));
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
        Err(crate::errors::CallError::Cancelled(_))
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
        .call("run".to_owned(), &CommandOptions::new(handle_of(1)))
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
                &CommandOptions {
                    close_on_timeout: close,
                    ..CommandOptions::new(handle_of(1))
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

// decision 0004: a command's options are a request's and its own, its connection and its close; the
// four of a request's are written out on both records, so this build is what holds them equal
#[test]
fn a_command_options_carry_every_option_of_a_request() {
    let signal = CancellationToken::new();
    let request = RequestOptions {
        timeout: Some(Duration::from_millis(7)),
        destination_id: Some(4),
        credential: Some(RequestCredential::Jwt("a.b.c".to_owned())),
        signal: Some(signal.clone()),
    };
    // * destructured without `..`: a field a request's options gain and a command's do not fails
    // this build
    let RequestOptions {
        timeout,
        destination_id,
        credential,
        signal: cancelling,
    } = request;
    let command = CommandOptions {
        timeout,
        destination_id,
        credential,
        signal: cancelling,
        ..CommandOptions::new(handle_of(1))
    };
    assert_eq!(
        (
            command.connection_handle,
            command.close_on_timeout,
            command.timeout,
            command.destination_id
        ),
        (handle_of(1), None, Some(Duration::from_millis(7)), Some(4))
    );
    assert!(matches!(
        command.credential,
        Some(RequestCredential::Jwt(token)) if token == "a.b.c"
    ));
    signal.cancel();
    assert!(command.signal.expect("its signal").is_cancelled());
}

// spec 16.11: a client's router makes requests and hears notifications, a server's makes commands;
// the other maker is refused as it is made, after spec 16.10's reasons, and declares nothing
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "each maker on each router, by kind, as both other sides tell them"
)]
async fn makes_requests_and_notifications_on_a_client_router_alone_and_commands_on_a_server_router_alone()
 {
    use crate::errors::{ProgrammerError, Refusal};
    use crate::identity::IdentityRefusal;
    use crate::metrics::{MetricsRegistry, MetricsRegistryOptions};

    const COMMANDS: &str = "a server's router makes commands: get_command";
    const REQUESTS: &str = "a client's router makes requests: get_request";
    const NOTIFIES: &str = "only a client hears notifications; a server notifies them";

    let of_kind = |procedure_kind| Procedure {
        procedure_kind,
        ..echo()
    };
    let told = |refused: ProgrammerError| (refused.reason(), refused.message().to_owned());
    let by_side = |message: &str| (None, message.to_owned());
    let against = |refused: &(Option<Refusal>, String)| {
        refused.0 == Some(Refusal::Identity(IdentityRefusal::AgainstItsKind))
    };
    let notifying =
        || NotificationDependencies::new(RequestDependencies::new(TextCodec, TextCodec), TextCodec);

    // on a server's router
    let registry = MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let fixture = Fixture::with(&crate::router::server::RouterServerOptions {
        metrics_registry: Some(registry.clone()),
        ..crate::router::server::RouterServerOptions::default()
    });
    // * what the registry holds before any maker: a declaration adds its procedure's series
    let declared = registry.exposition().text;
    let request = |procedure: &Procedure| {
        fixture
            .manager
            .get_request(procedure, RequestDependencies::new(TextCodec, TextCodec))
            .map(drop)
            .map_err(told)
    };
    let notification = |procedure: &Procedure| {
        fixture
            .manager
            .get_notification(procedure, notifying())
            .map(drop)
            .map_err(told)
    };
    for kind in [None, Some(ProcedureKind::Command)] {
        assert_eq!(request(&of_kind(kind)), Err(by_side(COMMANDS)), "{kind:?}");
        assert_eq!(
            notification(&of_kind(kind)),
            Err(by_side(NOTIFIES)),
            "{kind:?}"
        );
    }
    assert!(against(
        &request(&of_kind(Some(ProcedureKind::Request))).expect_err("a request")
    ));
    for kind in [ProcedureKind::Request, ProcedureKind::Notifies] {
        assert!(
            against(&notification(&of_kind(Some(kind))).expect_err("refused")),
            "{kind:?}"
        );
    }
    // * out of its range before the side, as before its kind
    let unranged = Procedure {
        service_id: 0,
        procedure_kind: None,
        ..echo()
    };
    for refused in [request(&unranged), notification(&unranged)] {
        assert_eq!(
            refused.expect_err("out of its range").0,
            Some(Refusal::Identity(IdentityRefusal::OutOfItsRange))
        );
    }
    assert_eq!(registry.exposition().text, declared, "nothing declared");
    fixture
        .manager
        .get_command(
            &of_kind(None),
            RequestDependencies::new(TextCodec, TextCodec),
        )
        .expect("a command, on a server's router");
    assert_ne!(registry.exposition().text, declared, "the command declared");
    fixture.router.dispose().await;

    // on a client's router
    let registry = MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let fixture = ClientFixture::with(&crate::router::client::RouterClientOptions {
        metrics_registry: Some(registry.clone()),
        ..crate::router::client::RouterClientOptions::default()
    });
    let declared = registry.exposition().text;
    let command = |procedure: &Procedure| {
        fixture
            .manager
            .get_command(procedure, RequestDependencies::new(TextCodec, TextCodec))
            .map(drop)
            .map_err(told)
    };
    for kind in [
        None,
        Some(ProcedureKind::Request),
        Some(ProcedureKind::Notifies),
    ] {
        assert_eq!(command(&of_kind(kind)), Err(by_side(REQUESTS)), "{kind:?}");
    }
    assert!(against(
        &command(&of_kind(Some(ProcedureKind::Command))).expect_err("a command")
    ));
    assert_eq!(registry.exposition().text, declared, "nothing declared");
    fixture
        .manager
        .get_request(
            &of_kind(None),
            RequestDependencies::new(TextCodec, TextCodec),
        )
        .expect("a request, on a client's router");
    fixture
        .manager
        .get_notification(
            &Procedure {
                procedure_id: 2,
                procedure_name: "news".to_owned(),
                procedure_kind: Some(ProcedureKind::Notifies),
                ..echo()
            },
            notifying(),
        )
        .expect("a notification, on a client's router");
    assert_ne!(registry.exposition().text, declared, "the request declared");
    fixture.router.dispose().await;
}

// a request names no connection, so it has none to close, whatever its manager's defaults say
#[tokio::test]
async fn a_client_request_resolves_no_close_on_timeout() {
    let fixture = ClientFixture::new();
    let manager = ServiceManager::new(
        ServiceRouter::Client(fixture.router.clone()),
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
            locked(&hearing).push(event.options.clone().expect("options"));
        }
    }));
    let call = manager
        .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("declared")
        .call("run".to_owned(), &RequestOptions::default())
        .expect("called");
    fixture.clock.settle().await;
    fixture
        .transport
        .deliver(&result(1, Bytes::from_static(b"run")));
    assert_eq!(
        crate::testing::patience(Duration::from_secs(10), call)
            .await
            .expect("answered")
            .expect("result"),
        "run"
    );
    let seen = locked(&seen).clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        (seen[0].close_on_timeout, seen[0].connection_handle.clone()),
        (None, None)
    );
    fixture.router.dispose().await;
}
