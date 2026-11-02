//! The greeter's service server: admission, offering, registration and notifications.

use std::sync::{Arc, Mutex};

use super::locked;
use crate::constants::{ProcedureKind, ProtocolCode};
use crate::errors::{CallError, ResolverError};
use crate::managers::service::{
    NotificationDependencies, NotifyOptions, RequestDependencies, RequestOptions, ResolverCallback,
};
use crate::payloads::TextCodec;
use crate::service::{
    AdmissionHook, AdmissionRule, Descriptor, DescriptorInit, ListedFailure, NotifyingDescriptor,
    ServiceProcedure, ServiceServer, ServiceServerOptions, command_of, failures_of, notifying_of,
    request_of,
};
use crate::testing::pair::{Pair, PairOptions, echo};
use crate::testing::surface::Consumer;

type TextDescriptor = Descriptor<TextCodec, TextCodec>;

fn init((id, name): (u16, &str), admission: AdmissionRule) -> DescriptorInit<TextCodec, TextCodec> {
    DescriptorInit {
        procedure: crate::identity::Procedure {
            service_id: 7,
            id,
            service_revision: 1,
            name: name.to_owned(),
            kind: None,
            ..echo()
        },
        admission,
        failures: vec![],
        request: TextCodec,
        result: TextCodec,
        validate: None,
    }
}

struct Greeter {
    hello: TextDescriptor,
    login: TextDescriptor,
    shout: TextDescriptor,
    whoami: TextDescriptor,
    news: NotifyingDescriptor<TextCodec, TextCodec, TextCodec>,
    clock: TextDescriptor,
    guarded: TextDescriptor,
}

impl Greeter {
    fn new() -> Self {
        let hello = request_of(DescriptorInit {
            failures: vec![ListedFailure::new("NOBODY_TO_GREET", 1)],
            ..init((1, "sayHello"), AdmissionRule::None)
        })
        .expect("hello");
        Self {
            hello,
            login: request_of(init((5, "login"), AdmissionRule::None)).expect("login"),
            shout: request_of(init((4, "shout"), AdmissionRule::Hook("loud"))).expect("shout"),
            whoami: request_of(init((3, "whoami"), AdmissionRule::Session)).expect("whoami"),
            news: notifying_of(init((2, "news"), AdmissionRule::None), TextCodec).expect("news"),
            clock: command_of(init((9, "clock"), AdmissionRule::None)).expect("clock"),
            guarded: command_of(init((10, "guarded"), AdmissionRule::Session)).expect("guarded"),
        }
    }

    fn procedures(&self) -> Vec<ServiceProcedure> {
        vec![
            ServiceProcedure::of(&self.clock),
            ServiceProcedure::of(&self.guarded),
            ServiceProcedure::of(&self.login),
            ServiceProcedure::of_notifying(&self.news),
            ServiceProcedure::of(&self.hello),
            ServiceProcedure::of(&self.shout),
            ServiceProcedure::of(&self.whoami),
        ]
    }

    fn service(&self, hook: AdmissionHook) -> ServiceServer {
        ServiceServer::new(
            self.procedures(),
            ServiceServerOptions {
                admissions: vec![("loud", hook)],
                ..ServiceServerOptions::default()
            },
        )
        .expect("the greeter's service")
    }
}

fn loud() -> AdmissionHook {
    AdmissionHook {
        admits: Arc::new(|_| true),
        detail: None,
    }
}

fn answer() -> ResolverCallback<TextCodec, TextCodec> {
    Arc::new(|request, response| response.result(request.payload))
}

async fn pair() -> Pair {
    Pair::connected((crate::testing::instants::new_year(), PairOptions::default()))
        .await
        .expect("a connected pair")
}

async fn call(
    pair: &Pair,
    (descriptor, payload): (&TextDescriptor, &str),
) -> Result<String, CallError> {
    pair.client
        .services()
        .get_request(
            descriptor.procedure(),
            RequestDependencies::of(TextCodec, TextCodec),
        )
        .expect("a requester")
        .call(payload.to_owned(), RequestOptions::default())
        .expect("a call")
        .await
}

#[tokio::test]
async fn admits_every_call_with_none() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    service
        .on(
            &greeter.hello,
            Arc::new(|request, response| response.result(format!("Hello, {}!", request.payload))),
        )
        .expect("hello registered");
    service.offer(&pair.server).expect("offered");
    assert_eq!(
        call(&pair, (&greeter.hello, "Bead"))
            .await
            .expect("admitted"),
        "Hello, Bead!"
    );
}

#[tokio::test]
async fn refuses_a_call_in_no_session_session_required() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    service
        .on(
            &greeter.whoami,
            Arc::new(|_, _| panic!("a refused call never reaches the resolver")),
        )
        .expect("whoami registered");
    service.offer(&pair.server).expect("offered");
    let refused = call(&pair, (&greeter.whoami, "who"))
        .await
        .expect_err("no session");
    assert!(
        matches!(refused, CallError::Failure(failure) if failure.protocol_code() == Some(ProtocolCode::SESSION_REQUIRED))
    );
}

#[tokio::test]
async fn refuses_with_a_hooks_detail_access_denied_in_a_session_or_in_none() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(AdmissionHook {
        admits: Arc::new(|_| false),
        detail: Some("too quiet".to_owned()),
    });
    service
        .on(
            &greeter.shout,
            Arc::new(|_, _| panic!("a refused hook never reaches its resolver")),
        )
        .expect("shout registered");
    let sessions = pair.server.sessions().clone();
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
    service.offer(&pair.server).expect("offered");
    for _ in ["none", "in one"] {
        let refused = call(&pair, (&greeter.shout, "hi"))
            .await
            .expect_err("denied");
        assert!(
            matches!(refused, CallError::Failure(failure) if failure.protocol_code() == Some(ProtocolCode::ACCESS_DENIED) && failure.detail() == "too quiet")
        );
        assert_eq!(
            call(&pair, (&greeter.login, "ada"))
                .await
                .expect("logged in"),
            "in"
        );
    }
}

#[tokio::test]
async fn answers_procedure_failed_to_a_hook_that_throws_and_reports_it() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(AdmissionHook {
        admits: Arc::new(|_| panic!("the hook broke")),
        detail: None,
    });
    service
        .on(&greeter.shout, answer())
        .expect("shout registered");
    service.offer(&pair.server).expect("offered");
    let refused = call(&pair, (&greeter.shout, "hi"))
        .await
        .expect_err("a hook panics");
    assert!(
        matches!(refused, CallError::Failure(failure) if failure.protocol_code() == Some(ProtocolCode::PROCEDURE_FAILED) && failure.detail().is_empty())
    );
    pair.settle().await;
    let reported = locked(&pair.server_reports);
    assert_eq!(reported.len(), 1);
    assert!(reported[0].0.to_string().contains("the hook broke"));
    assert_eq!(reported[0].1.as_ref(), Some(&pair.connection_handle));
}

#[test]
fn refuses_a_hook_the_options_lack_one_no_procedure_names_and_one_that_is_no_hook() {
    let greeter = Greeter::new();
    assert_eq!(
        ServiceServer::new(greeter.procedures(), ServiceServerOptions::default())
            .expect_err("a hook missing")
            .message(),
        "shout is admitted by the hook loud, which the options do not give"
    );
    assert_eq!(
        ServiceServer::new(
            greeter.procedures(),
            ServiceServerOptions {
                admissions: vec![("loud", loud()), ("quiet", loud())],
                ..ServiceServerOptions::default()
            }
        )
        .expect_err("an unnamed hook")
        .message(),
        "the hook quiet is given, and no procedure names it"
    );
    let consumer = Consumer::new();
    consumer.accepts("pub fn check(mut options: bead::ServiceServerOptions, hook: bead::AdmissionHook) { options.admissions = vec![(\"loud\", hook)]; }");
    consumer.refuses("pub fn check(mut options: bead::ServiceServerOptions) { options.admissions = vec![(\"loud\", None)]; }", ("E0308", "mismatched types"));
    consumer.refuses(
        "pub fn check() { let _ = bead::AdmissionHook { admits: None, detail: None }; }",
        ("E0308", "mismatched types"),
    );
}

#[tokio::test]
async fn answers_a_failure_its_procedure_lists() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    let listed = ListedFailure::new("NOBODY_TO_GREET", 1);
    let catalogue =
        failures_of(7, &[listed, ListedFailure::new("TOO_LOUD", 2)]).expect("a catalogue");
    service
        .on(
            &greeter.hello,
            Arc::new(move |request, response| {
                if request.payload.is_empty() {
                    response.failure(&listed.of("a name is needed"))
                } else {
                    response.result(format!("Hello, {}!", request.payload))
                }
            }),
        )
        .expect("hello registered");
    service.offer(&pair.server).expect("offered");
    let failure = call(&pair, (&greeter.hello, ""))
        .await
        .expect_err("a name is needed");
    assert!(catalogue.is(&failure, &listed));
    assert!(
        matches!(failure, CallError::Failure(failure) if failure.code().get() == 1 && failure.detail() == "a name is needed")
    );
    pair.settle().await;
    assert!(locked(&pair.server_reports).is_empty());
}

#[tokio::test]
async fn registers_before_and_after_offer() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    service
        .on(
            &greeter.hello,
            Arc::new(|request, response| response.result(format!("Hello, {}!", request.payload))),
        )
        .expect("before offering");
    service.offer(&pair.server).expect("offered");
    service
        .on(
            &greeter.login,
            Arc::new(|_, response| response.result("in".to_owned())),
        )
        .expect("after offering");
    assert_eq!(
        call(&pair, (&greeter.hello, "Bead")).await.expect("hello"),
        "Hello, Bead!"
    );
    assert_eq!(
        call(&pair, (&greeter.login, "ada")).await.expect("login"),
        "in"
    );
}

#[tokio::test]
async fn refuses_a_second_offer() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    service.offer(&pair.server).expect("offered once");
    assert_eq!(
        service
            .offer(&pair.server)
            .expect_err("a second offer")
            .message(),
        "a service is offered on one server, once"
    );
}

#[tokio::test]
async fn notifies_nothing_before_it_is_offered_and_resolves() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    let heard = Arc::new(Mutex::new(Vec::new()));
    service
        .notify(
            &greeter.news,
            ("before".to_owned(), &NotifyOptions::default()),
        )
        .await;
    service
        .on_notifying(
            &greeter.news,
            Arc::new(|_, response| {
                Box::pin(async move {
                    response
                        .register_notification()
                        .await
                        .map_err(ResolverError::other)?;
                    response.result("subscribed".to_owned()).await
                })
            }),
        )
        .expect("news registered");
    service.offer(&pair.server).expect("offered");
    let hearing = Arc::clone(&heard);
    let notification = pair
        .client
        .services()
        .get_notification(
            greeter.news.descriptor().procedure(),
            NotificationDependencies::of((TextCodec, TextCodec, TextCodec)),
        )
        .expect("a notification");
    let registration = notification
        .on(
            (
                "subscribe".to_owned(),
                Arc::new(move |value| {
                    locked(&hearing).push(value);
                    Box::pin(async { Ok(()) })
                }),
            ),
            RequestOptions::default(),
        )
        .await
        .expect("subscribed");
    service
        .notify(
            &greeter.news,
            ("after".to_owned(), &NotifyOptions::default()),
        )
        .await;
    pair.settle().await;
    assert_eq!(*locked(&heard), ["after"]);
    registration.unregister().await.expect("unregistered");
}

#[tokio::test]
async fn lists_the_procedures_without_a_resolver_which_the_router_answers_procedure_unknown() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    service
        .on(
            &greeter.hello,
            Arc::new(|_, response| response.result("hi".to_owned())),
        )
        .expect("hello registered");
    service.offer(&pair.server).expect("offered");
    assert_eq!(
        service
            .procedures_without_resolver()
            .iter()
            .map(|procedure| procedure.name.clone())
            .collect::<Vec<_>>(),
        ["login", "news", "shout", "whoami"]
    );
    let failure = call(&pair, (&greeter.login, "ada"))
        .await
        .expect_err("no resolver");
    assert!(
        matches!(failure, CallError::Failure(failure) if failure.protocol_code() == Some(ProtocolCode::PROCEDURE_UNKNOWN))
    );
    assert_eq!(greeter.clock.procedure().kind, Some(ProcedureKind::Command));
}
