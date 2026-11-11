//! The greeter's client side, over a client paired in memory with a server whose
//! [`ServiceServer`] serves it: the twins of the TypeScript side's `service-client.test.ts` and of
//! the C# side's `ServiceClientTests`.

use core::num::NonZeroU16;
use std::sync::{Arc, Mutex};

use super::locked;
use super::server::{
    Greeter, NOT_EMPTY_DETAIL, TextDescriptor, answer, init, loud, not_empty, pair,
};
use crate::constants::{FailureScope, ProtocolCode, RouterSide};
use crate::debug::DebugDirection;
use crate::errors::{CallError, ProgrammerError, ResolverError};
use crate::failure::{Failure, FailureOrigin, ProcedureAddress};
use crate::managers::service::{
    CommandOptions, DebugEvent, RegistrationOptions, RequestOptions, TracedError,
};
use crate::payloads::TextCodec;
use crate::router::types::RouterError;
use crate::service::{
    AdmissionRule, DescriptorInit, ListedFailure, NotifyingDescriptor, ServiceClient,
    ServiceClientOptions, ServiceProcedure, ServiceServer, ServiceServerOptions, command_of,
    failures_of, notifying_of, request_of,
};
use crate::testing::pair::Pair;
use crate::testing::scripted::RequesterProbe;
use crate::violations::{ReadViolations, Violation, violations_of};

// a procedure of service 8, judged by `not_empty`
fn checked((id, name): (u16, &str)) -> DescriptorInit<TextCodec, TextCodec> {
    let init = init((id, name), AdmissionRule::None);

    DescriptorInit {
        procedure: crate::identity::Procedure {
            service_id: 8,
            ..init.procedure
        },
        validate: Some(not_empty()),
        ..init
    }
}

/// A procedure of service 8 that echoes a text, judged by `not_empty`; one that notifies too.
struct Echo {
    echo: TextDescriptor,
    news: NotifyingDescriptor<TextCodec, TextCodec, TextCodec>,
}

impl Echo {
    fn new() -> Self {
        Self {
            echo: request_of(checked((1, "echo"))).expect("echo"),
            news: notifying_of(checked((2, "news")), TextCodec).expect("news"),
        }
    }

    fn procedures(&self) -> Vec<ServiceProcedure> {
        vec![
            ServiceProcedure::from(&self.echo),
            ServiceProcedure::from(&self.news),
        ]
    }
}

fn client_of(pair: &Pair, procedures: Vec<ServiceProcedure>) -> ServiceClient {
    ServiceClient::new(procedures, &pair.client, &ServiceClientOptions::default())
        .expect("its client side")
}

fn validating(pair: &Pair, procedures: Vec<ServiceProcedure>) -> ServiceClient {
    ServiceClient::new(
        procedures,
        &pair.client,
        &ServiceClientOptions {
            validates: Some(true),
            ..ServiceClientOptions::default()
        },
    )
    .expect("its validating client side")
}

fn windowed(pair: &Pair, (name, window): (&str, u64)) -> Result<ServiceClient, ProgrammerError> {
    ServiceClient::new(
        Greeter::new().procedures(),
        &pair.client,
        &ServiceClientOptions {
            windows: Some([(name.to_owned(), window)].into()),
            ..ServiceClientOptions::default()
        },
    )
}

// a command's call to the pair's one connection
fn command_options(pair: &Pair) -> CommandOptions {
    CommandOptions::new(Arc::clone(&pair.connection_handle))
}

// the failure a call fails with; a call that is taken fails the test
fn failure_of<T: core::fmt::Debug>(called: Result<T, CallError>) -> Failure {
    match called {
        Err(CallError::Failure(failure)) => failure,
        other => panic!("a failure, not {other:?}"),
    }
}

#[tokio::test]
async fn admits_a_command_by_its_rule() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    let client = client_of(&pair, greeter.procedures());
    let sessions = pair.server.sessions().clone();

    // * before the offer, no command is made: the refusal is the layer's, not the router's
    assert_eq!(
        service
            .command_of(&greeter.guarded)
            .expect("given early")
            .call("who".to_owned(), &command_options(&pair))
            .expect_err("called before the offer")
            .message(),
        "guarded is a command made as its service is offered, not before"
    );

    service
        .on(
            &greeter.login,
            Arc::new(move |request, response| {
                let stored = sessions
                    .set(sessions.create(request.connection_handle))
                    .expect("a session");

                Box::pin(async move {
                    stored.await.map_err(ResolverError::other)?;
                    response.result("in".to_owned()).await
                })
            }),
        )
        .expect("login registered");
    client
        .on(
            &greeter.clock,
            Arc::new(|_, response| response.result("noon".to_owned())),
        )
        .expect("clock answered");
    client
        .on(
            &greeter.guarded,
            Arc::new(|request, response| response.result(format!("guarded {}", request.payload))),
        )
        .expect("guarded answered");
    service.offer(&pair.server).expect("offered");

    let command = |descriptor: &TextDescriptor, payload: &str| {
        service
            .command_of(descriptor)
            .expect("its command")
            .call(payload.to_owned(), &command_options(&pair))
            .expect("a call")
    };

    assert_eq!(
        command(&greeter.clock, "now").await.expect("answered"),
        "noon"
    );
    assert_eq!(
        failure_of(command(&greeter.guarded, "who").await).protocol_code(),
        Some(ProtocolCode::SESSION_REQUIRED),
        "in no session"
    );

    // a session learned by the client: the server's command runs in it
    client
        .requester_of(&greeter.login)
        .expect("login's requester")
        .call("ada".to_owned(), &RequestOptions::default())
        .expect("a call")
        .await
        .expect("logged in");

    assert_eq!(
        command(&greeter.guarded, "who")
            .await
            .expect("in its session"),
        "guarded who"
    );
}

#[tokio::test]
async fn refuses_a_command_admitted_by_a_hook_which_a_client_side_is_given_none_of() {
    let pair = pair().await;
    let clock = command_of(init((9, "clock"), AdmissionRule::Hook("loud"))).expect("clock");
    let client = client_of(&pair, vec![ServiceProcedure::from(&clock)]);

    assert_eq!(
        client
            .on(&clock, answer())
            .expect_err("a hook's command")
            .message(),
        "clock is admitted by the hook loud, which a client side is given none of"
    );
}

#[tokio::test]
async fn makes_each_requester_and_notification_once_at_its_window() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let declared = Arc::new(Mutex::new(Vec::new()));
    let declaring = Arc::clone(&declared);

    pair.client.router().observe_requester(RequesterProbe {
        declared: Arc::new(move |procedure, _| {
            locked(&declaring).push(procedure.procedure_name.clone());
        }),
        called: Arc::new(|_| {}),
    });

    let windows = ServiceClientOptions {
        windows: Some([("news".to_owned(), 4)].into()),
        ..ServiceClientOptions::default()
    };
    let client =
        ServiceClient::new(greeter.procedures(), &pair.client, &windows).expect("its client side");
    let news = client
        .notification_of(&greeter.news)
        .expect("its notification");

    assert_eq!(news.as_like().window(), Some(4));

    for requested in [
        &greeter.login,
        greeter.news.descriptor(),
        &greeter.hello,
        &greeter.shout,
        &greeter.whoami,
    ] {
        client
            .requester_of(requested)
            .expect("a requester of each procedure its server answers");
    }

    for command in [&greeter.clock, &greeter.guarded] {
        assert_eq!(
            client
                .requester_of(command)
                .expect_err("a command's")
                .message(),
            format!(
                "{} is no procedure this service's server answers",
                command.procedure().procedure_name
            )
        );
    }

    // * the notification's subscribing call is a requester of its own procedure, declared with it
    let mut names = locked(&declared).clone();

    names.sort();
    assert_eq!(
        names,
        ["login", "news", "news", "sayHello", "shout", "whoami"]
    );

    // the same procedure at the same window gives the same notification; at another, a refusal
    let again = ServiceClient::new(greeter.procedures(), &pair.client, &windows)
        .expect("a client side at the same windows");

    assert!(Arc::ptr_eq(
        &news.as_like(),
        &again
            .notification_of(&greeter.news)
            .expect("its notification")
            .as_like()
    ));
    ServiceClient::new(
        greeter.procedures(),
        &pair.client,
        &ServiceClientOptions::default(),
    )
    .expect_err("another window");
}

#[tokio::test]
async fn a_request_to_a_procedure_that_notifies_opens_no_subscription() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    let client = client_of(&pair, greeter.procedures());
    let opened = Arc::new(Mutex::new(Vec::new()));
    let opening = Arc::clone(&opened);

    service
        .on_notifying(
            &greeter.news,
            Arc::new(move |request, response| {
                locked(&opening).push(request.header.opens_subscription);
                response.result("headlines".to_owned())
            }),
        )
        .expect("news registered");
    service.offer(&pair.server).expect("offered");

    assert_eq!(
        client
            .requester_of(greeter.news.descriptor())
            .expect("news's requester")
            .call("today".to_owned(), &RequestOptions::default())
            .expect("a call")
            .await
            .expect("answered"),
        "headlines"
    );
    assert_eq!(*locked(&opened), [false]);
    assert_eq!(
        pair.server
            .router()
            .gauges()
            .await
            .expect("its gauges")
            .counts["notifiedSubscriptions"],
        0
    );
}

#[tokio::test]
async fn refuses_a_window_for_a_procedure_that_does_not_notify() {
    let pair = pair().await;

    windowed(&pair, ("sayHello", 1)).expect_err("a window for a request");
    windowed(&pair, ("news", 0)).expect_err("a window of 0");
}

#[tokio::test]
async fn refuses_to_answer_what_is_no_command_of_its_service_a_command_twice_and_a_window_of_what_it_does_not_hold()
 {
    let pair = pair().await;
    let greeter = Greeter::new();
    let client = client_of(&pair, greeter.procedures());
    // * a descriptor the service does not hold, at its command's address, is no command it answers
    let other = command_of(init((9, "clock"), AdmissionRule::None)).expect("another clock");

    for (refused, words) in [
        (
            &greeter.hello,
            "sayHello is no command this service's client answers",
        ),
        (&other, "clock is no command this service's client answers"),
    ] {
        assert_eq!(
            client
                .on(refused, answer())
                .expect_err("no command")
                .message(),
            words
        );
    }

    client.on(&greeter.clock, answer()).expect("clock answered");

    assert_eq!(
        client
            .on(&greeter.clock, answer())
            .expect_err("twice")
            .message(),
        "clock is already a registered resolver"
    );
    assert_eq!(
        windowed(&pair, ("toString", 1))
            .expect_err("a window of no procedure")
            .message(),
        "a window is given for toString, which is no procedure of this service that notifies"
    );
}

#[tokio::test]
async fn fails_a_call_before_it_goes_with_payload_invalid_when_its_options_say_so_and_sends_nothing()
 {
    let pair = pair().await;
    let echo = Echo::new();
    let server = ServiceServer::new(echo.procedures(), &ServiceServerOptions::default())
        .expect("its server");
    let sent = Arc::new(Mutex::new(Vec::new()));
    let sending = Arc::clone(&sent);
    let steps = Arc::new(Mutex::new(Vec::new()));
    let stepping = Arc::clone(&steps);

    server
        .on(
            &echo.echo,
            Arc::new(move |request, response| {
                locked(&sending).push(request.payload.clone());
                response.result(request.payload)
            }),
        )
        .expect("echo registered");
    server
        .on_notifying(
            &echo.news,
            Arc::new(|_, response| response.result(String::new())),
        )
        .expect("news registered");
    server.offer(&pair.server).expect("offered");

    let validating = validating(&pair, echo.procedures());
    let trusting = client_of(&pair, echo.procedures());
    let call = |client: &ServiceClient, payload: &str| {
        client
            .requester_of(&echo.echo)
            .expect("echo's requester")
            .call(payload.to_owned(), &RequestOptions::default())
            .expect("a call")
    };

    pair.client.services().on_debug(Arc::new(
        move |_: Option<&TracedError>, event: &DebugEvent| {
            locked(&stepping).push((event.direction, event.call_id));
        },
    ));

    let refused = failure_of(call(&validating, "").await);

    assert_eq!(
        (refused.protocol_code(), refused.scope()),
        (Some(ProtocolCode::PAYLOAD_INVALID), FailureScope::Protocol)
    );
    assert_eq!(
        (refused.origin(), refused.side()),
        (FailureOrigin::Local, Some(RouterSide::Client))
    );
    assert_eq!(refused.destination_id(), None);
    assert_eq!(refused.detail(), NOT_EMPTY_DETAIL);
    assert_eq!(
        refused.procedure(),
        Some(ProcedureAddress {
            service_id: 8,
            procedure_id: 1
        })
    );
    assert_eq!(
        violations_of(&refused),
        ReadViolations {
            violations: vec![Violation {
                bounds: Some(
                    serde_json::json!({ "min_len": "1" })
                        .as_object()
                        .expect("bounds")
                        .clone()
                ),
                rule_id: "string.min_len".to_owned(),
                message: Some("must be at least 1 characters".to_owned()),
                ..Violation::default()
            }],
            more: Some(0),
            stopped: false,
        }
    );

    // * a call refused before it goes: its tx step names no call, then its failure
    pair.settle().await;

    assert_eq!(
        *locked(&steps),
        [(DebugDirection::Tx, None), (DebugDirection::Rx, None)]
    );

    // the server's layer holds it too: the request went, and its resolver never saw it
    assert_eq!(
        failure_of(call(&trusting, "").await).protocol_code(),
        Some(ProtocolCode::PAYLOAD_INVALID)
    );
    assert!(locked(&sent).is_empty());
    assert_eq!(call(&validating, "hi").await.expect("taken"), "hi");
    assert_eq!(*locked(&sent), ["hi"]);
}

#[tokio::test]
async fn validates_a_subscribing_request_as_a_plain_one_when_its_options_say_so() {
    let pair = pair().await;
    let echo = Echo::new();
    let server = ServiceServer::new(echo.procedures(), &ServiceServerOptions::default())
        .expect("its server");
    let subscribed = Arc::new(Mutex::new(Vec::new()));
    let subscribing = Arc::clone(&subscribed);

    server.on(&echo.echo, answer()).expect("echo registered");
    server
        .on_notifying(
            &echo.news,
            Arc::new(move |request, response| {
                locked(&subscribing).push(request.payload.clone());

                Box::pin(async move {
                    response
                        .register_notification()
                        .await
                        .map_err(ResolverError::other)?;
                    response.result(request.payload).await
                })
            }),
        )
        .expect("news registered");
    server.offer(&pair.server).expect("offered");

    let refused = failure_of(
        validating(&pair, echo.procedures())
            .notification_of(&echo.news)
            .expect("its notification")
            .register(
                String::new(),
                Arc::new(|_| Box::pin(async { Ok(()) })),
                &RegistrationOptions::default(),
            )
            .await,
    );

    assert_eq!(refused.protocol_code(), Some(ProtocolCode::PAYLOAD_INVALID));
    assert_eq!(refused.detail(), NOT_EMPTY_DETAIL);
    assert_eq!(refused.origin(), FailureOrigin::Local);

    pair.settle().await;

    assert!(locked(&subscribed).is_empty());
}

#[tokio::test]
async fn answers_payload_invalid_to_a_command_its_rules_refuse_before_its_resolver() {
    let pair = pair().await;
    let shout = command_of(checked((3, "shout"))).expect("shout");
    let server = ServiceServer::new(
        vec![ServiceProcedure::from(&shout)],
        &ServiceServerOptions::default(),
    )
    .expect("its server");
    let client = client_of(&pair, vec![ServiceProcedure::from(&shout)]);
    let heard = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&heard);

    client
        .on(
            &shout,
            Arc::new(move |request, response| {
                locked(&hearing).push(request.payload.clone());
                response.result(request.payload.to_uppercase())
            }),
        )
        .expect("shout answered");
    server.offer(&pair.server).expect("offered");

    let command = |payload: &str| {
        server
            .command_of(&shout)
            .expect("its command")
            .call(payload.to_owned(), &command_options(&pair))
            .expect("a call")
    };
    let refused = failure_of(command("").await);

    assert_eq!(refused.protocol_code(), Some(ProtocolCode::PAYLOAD_INVALID));
    assert_eq!(refused.detail(), NOT_EMPTY_DETAIL);
    assert_eq!(refused.origin(), FailureOrigin::Peer);
    assert!(locked(&heard).is_empty());

    // * a refusal leaves the next command alone
    assert_eq!(command("hi").await.expect("taken"), "HI");
    assert_eq!(*locked(&heard), ["hi"]);
}

#[tokio::test]
async fn sends_a_command_s_unlisted_code_as_written_and_reports_it() {
    let pair = pair().await;
    let nobody = ListedFailure::new("NOBODY_TO_GREET", NonZeroU16::MIN);
    let too_loud = ListedFailure::new("TOO_LOUD", NonZeroU16::MIN.saturating_add(1));
    let catalogue = failures_of(7, &[nobody, too_loud]).expect("its catalogue");
    let clock = command_of(DescriptorInit {
        failures: vec![nobody],
        ..init((9, "clock"), AdmissionRule::None)
    })
    .expect("clock");
    let server = ServiceServer::new(
        vec![ServiceProcedure::from(&clock)],
        &ServiceServerOptions::default(),
    )
    .expect("its server");
    let client = client_of(&pair, vec![ServiceProcedure::from(&clock)]);

    // a code of its service's catalogue that clock does not list, which nothing typed refuses
    client
        .on(
            &clock,
            Arc::new(move |_, response| response.failure(&too_loud.of("too loud"))),
        )
        .expect("clock answered");
    server.offer(&pair.server).expect("offered");

    let failure = server
        .command_of(&clock)
        .expect("its command")
        .call("now".to_owned(), &command_options(&pair))
        .expect("a call")
        .await
        .expect_err("a failure");

    assert!(catalogue.is(&failure, &too_loud), "sent as written");

    pair.settle().await;

    let reported: Vec<String> = locked(&pair.client_reports)
        .iter()
        .map(|error| match error {
            RouterError::Other(error) => error.to_string(),
            other @ (RouterError::Failure(_)
            | RouterError::ReadyState(_)
            | RouterError::Disconnected(_)) => other.to_string(),
        })
        .collect();

    assert_eq!(
        reported,
        ["clock answers failure 2, which it does not list"],
        "and reported"
    );
}
