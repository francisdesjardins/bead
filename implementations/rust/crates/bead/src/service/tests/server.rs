//! The greeter's service server: admission, offering, registration and notifications.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use super::locked;
use crate::constants::{FailureScope, ProcedureKind, ProtocolCode, RouterSide};
use crate::errors::{CallError, ResolverError};
use crate::failure::FailureOrigin;
use crate::managers::service::{
    CommandOptions, NotificationDependencies, NotifyOptions, RegistrationOptions,
    RequestDependencies, RequestOptions, RequestResolverDependencies, ResolverCallback, Validate,
};
use crate::payloads::TextCodec;
use crate::service::{
    AdmissionHook, AdmissionRule, Descriptor, DescriptorInit, ListedFailure, NotifyingDescriptor,
    ServiceProcedure, ServiceServer, ServiceServerOptions, command_of, failures_of, notifying_of,
    request_of,
};
use crate::testing::pair::{Pair, PairOptions, echo};
use crate::testing::surface::Consumer;
use crate::violations::{Judged, ReadViolations, Violation, violations_of};

pub(super) type TextDescriptor = Descriptor<TextCodec, TextCodec>;

pub(super) fn init(
    (id, name): (u16, &str),
    admission: AdmissionRule,
) -> DescriptorInit<TextCodec, TextCodec> {
    DescriptorInit {
        procedure: crate::identity::Procedure {
            service_id: 7,
            procedure_id: id,
            service_revision: 1,
            procedure_name: name.to_owned(),
            procedure_kind: None,
            ..echo()
        },
        admission,
        failures: vec![],
        request: TextCodec,
        result: TextCodec,
        validate: None,
    }
}

pub(super) struct Greeter {
    pub(super) hello: TextDescriptor,
    pub(super) login: TextDescriptor,
    pub(super) shout: TextDescriptor,
    pub(super) whoami: TextDescriptor,
    pub(super) news: NotifyingDescriptor<TextCodec, TextCodec, TextCodec>,
    pub(super) clock: TextDescriptor,
    pub(super) guarded: TextDescriptor,
}

impl Greeter {
    pub(super) fn new() -> Self {
        let hello = request_of(DescriptorInit {
            failures: vec![ListedFailure::new(
                "NOBODY_TO_GREET",
                core::num::NonZeroU16::new(1).expect("a nonzero code"),
            )],
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

    pub(super) fn procedures(&self) -> Vec<ServiceProcedure> {
        vec![
            ServiceProcedure::from(&self.clock),
            ServiceProcedure::from(&self.guarded),
            ServiceProcedure::from(&self.login),
            ServiceProcedure::from(&self.news),
            ServiceProcedure::from(&self.hello),
            ServiceProcedure::from(&self.shout),
            ServiceProcedure::from(&self.whoami),
        ]
    }

    pub(super) fn service(&self, hook: AdmissionHook) -> ServiceServer {
        ServiceServer::new(
            self.procedures(),
            &ServiceServerOptions {
                admissions: Some(BTreeMap::from([("loud", hook)])),
                ..ServiceServerOptions::default()
            },
        )
        .expect("the greeter's service")
    }
}

pub(super) fn loud() -> AdmissionHook {
    AdmissionHook {
        admits: Arc::new(|_| true),
        detail: None,
    }
}

pub(super) fn answer() -> ResolverCallback<TextCodec, TextCodec> {
    Arc::new(|request, response| response.result(request.payload))
}

pub(super) async fn pair() -> Pair {
    Pair::connected(
        crate::testing::instants::new_year(),
        &PairOptions::default(),
    )
    .await
    .expect("a connected pair")
}

#[tokio::test]
async fn refuses_on_twice_offered_or_not() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    let other = request_of(init((5, "login"), AdmissionRule::None)).expect("another descriptor");

    service
        .on(&greeter.shout, answer())
        .expect("shout registered");
    service
        .on(&greeter.shout, answer())
        .expect_err("shout twice");
    service.offer(&pair.server).expect("offered");
    assert_eq!(other.procedure(), greeter.login.procedure());
    assert_eq!(
        service
            .on(&other, answer())
            .expect_err("a descriptor the service does not hold")
            .message(),
        "login is no procedure this service's server answers"
    );
    service
        .on(&greeter.login, answer())
        .expect("login registered");
    service
        .on(&greeter.login, answer())
        .expect_err("login twice");
    service.on(&greeter.clock, answer()).expect_err("a command");
    let absent = request_of(init((12, "farewell"), AdmissionRule::None)).expect("absent");
    service
        .on(&absent, answer())
        .expect_err("no such procedure");
}

#[tokio::test]
async fn accepts_a_cloned_descriptor_and_refuses_a_distinct_one_at_its_address_before_and_after_offer()
 {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    let other_hello = request_of(init((1, "sayHello"), AdmissionRule::None)).expect("other hello");
    let other_news =
        notifying_of(init((2, "news"), AdmissionRule::None), TextCodec).expect("other news");
    let other_clock = command_of(init((9, "clock"), AdmissionRule::None)).expect("other clock");
    for offered in [false, true] {
        if offered {
            service.offer(&pair.server).expect("offered");
        }
        service
            .on(&other_hello, answer())
            .expect_err("the foreign request is not held");
        service
            .on_notifying(&other_news, answer())
            .expect_err("the foreign notification is not held");
        assert_eq!(
            service
                .command_of(&other_clock)
                .expect_err("the foreign command is not held")
                .message(),
            "clock is no procedure of this service"
        );
        assert_eq!(
            service
                .command_of(&greeter.hello)
                .expect_err("a request held is no command")
                .message(),
            "sayHello is no command of this service"
        );
        service
            .command_of(&greeter.clock.clone())
            .expect("the same command descriptor");
    }
    service
        .on(&greeter.hello.clone(), answer())
        .expect("the same request descriptor");
    service
        .on_notifying(&greeter.news.clone(), answer())
        .expect("the same notifying descriptor");
    assert_eq!(
        call(&pair, (&greeter.hello, "hello"))
            .await
            .expect("answered"),
        "hello"
    );
    assert_eq!(
        call(&pair, (greeter.news.descriptor(), "news"))
            .await
            .expect("answered"),
        "news"
    );
}

#[tokio::test]
async fn makes_each_command_s_requester_once_as_it_is_offered_and_refuses_one_called_before() {
    let registry =
        crate::metrics::MetricsRegistry::new(&crate::metrics::MetricsRegistryOptions::default())
            .expect("a registry");
    let pair = Pair::connected(
        crate::testing::instants::new_year(),
        &PairOptions {
            server: Some(crate::server::ServerOptions {
                metrics_registry: Some(registry),
                ..crate::server::ServerOptions::default()
            }),
            ..PairOptions::default()
        },
    )
    .await
    .expect("a pair with metrics");
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    let declared = Arc::new(Mutex::new(Vec::new()));
    let declaring = Arc::clone(&declared);
    let clock_series = Arc::new(Mutex::new(None::<crate::metrics::ProcedureSeries>));
    let declaring_series = Arc::clone(&clock_series);
    let called = Arc::new(Mutex::new(Vec::new()));
    let calling = Arc::clone(&called);
    pair.server
        .router()
        .observe_requester(crate::testing::scripted::RequesterProbe {
            declared: Arc::new(move |procedure, series| {
                locked(&declaring).push(procedure.clone());
                if procedure.procedure_name == "clock" {
                    *locked(&declaring_series) = Some(series.expect("clock's series").clone());
                }
            }),
            called: Arc::new(move |request| {
                locked(&calling).push(
                    locked(&clock_series)
                        .as_ref()
                        .expect("clock declared before its calls")
                        .is_same(request.series.as_ref().expect("clock's handed series")),
                );
            }),
        });
    pair.client
        .services()
        .get_command_resolver(
            greeter.clock.procedure(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("clock resolver")
        .register(
            (
                Arc::new(|request, response| response.result(format!("noon, {}", request.payload))),
                None,
            ),
            true,
        )
        .expect("clock registered");

    let given = service.command_of(&greeter.clock).expect("given early");
    let options = CommandOptions::new(Arc::clone(&pair.connection_handle));
    assert_eq!(
        given
            .call("early".to_owned(), &options)
            .expect_err("called before the offer")
            .message(),
        "clock is a command made as its service is offered, not before"
    );
    assert!(locked(&declared).is_empty());
    assert!(locked(&called).is_empty());
    service.offer(&pair.server).expect("offered");
    assert_eq!(
        *locked(&declared),
        [
            greeter.clock.procedure().clone(),
            greeter.guarded.procedure().clone()
        ]
    );
    let requester = service.command_of(&greeter.clock).expect("clock requester");
    assert_eq!(given.procedure(), greeter.clock.procedure());
    assert_eq!(requester.procedure(), greeter.clock.procedure());
    assert!(locked(&called).is_empty(), "offering makes no call");
    for (asked, requester) in [("now", &given), ("again", &requester)] {
        let call = requester
            .call(asked.to_owned(), &options)
            .expect("clock called");
        assert_eq!(
            crate::testing::patience(core::time::Duration::from_secs(10), call)
                .await
                .expect("answered")
                .expect("a result"),
            format!("noon, {asked}")
        );
    }
    assert_eq!(
        *locked(&declared),
        [
            greeter.clock.procedure().clone(),
            greeter.guarded.procedure().clone()
        ]
    );
    assert_eq!(*locked(&called), [true, true]);
}

#[tokio::test]
async fn declares_each_resolver_and_requester_once_to_a_registry() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    let declared = Arc::new(Mutex::new(Vec::new()));
    let declaring = Arc::clone(&declared);
    pair.server
        .router()
        .observe_requester(crate::testing::scripted::RequesterProbe {
            declared: Arc::new(move |procedure, _| {
                locked(&declaring).push(format!("requester {}", procedure.procedure_name));
            }),
            called: Arc::new(|_| {}),
        });
    service
        .on(
            &greeter.hello,
            Arc::new(|_, response| response.result("hi".to_owned())),
        )
        .expect("hello registered");
    service
        .on_notifying(
            &greeter.news,
            Arc::new(|_, response| response.result("subscribed".to_owned())),
        )
        .expect("news registered");
    service.offer(&pair.server).expect("offered");
    service
        .on(
            &greeter.login,
            Arc::new(|_, response| response.result("in".to_owned())),
        )
        .expect("login registered after the offer");

    let mut options = CommandOptions::new(Arc::clone(&pair.connection_handle));
    options.timeout = Some(core::time::Duration::from_millis(50));
    let call = service
        .command_of(&greeter.clock)
        .expect("clock requester")
        .call("now".to_owned(), &options)
        .expect("clock called");
    drop(
        crate::testing::patience(core::time::Duration::from_secs(10), call)
            .await
            .expect("the command settles"),
    );

    // * a second resolver at an address is refused; read what the router actually holds
    let resolvers = pair
        .server
        .router()
        .owner()
        .run(|state| {
            locked(&state.core.resolvers)
                .keys()
                .copied()
                .collect::<Vec<_>>()
        })
        .await
        .expect("the registered resolvers");
    assert_eq!(resolvers, [(7, 1), (7, 2), (7, 5)]);
    let mut declarations = locked(&declared).clone();
    declarations.sort();
    assert_eq!(declarations, ["requester clock", "requester guarded"]);
}

async fn call(
    pair: &Pair,
    (descriptor, payload): (&TextDescriptor, &str),
) -> Result<String, CallError> {
    pair.client
        .services()
        .get_request(
            descriptor.procedure(),
            RequestDependencies::new(TextCodec, TextCodec),
        )
        .expect("a requester")
        .call(payload.to_owned(), &RequestOptions::default())
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
        ServiceServer::new(greeter.procedures(), &ServiceServerOptions::default())
            .expect_err("a hook missing")
            .message(),
        "shout is admitted by the hook loud, which the options do not give"
    );
    assert_eq!(
        ServiceServer::new(
            greeter.procedures(),
            &ServiceServerOptions {
                admissions: Some(BTreeMap::from([("loud", loud()), ("quiet", loud())])),
                ..ServiceServerOptions::default()
            }
        )
        .expect_err("an unnamed hook")
        .message(),
        "the hook quiet is given, and no procedure names it"
    );
    let consumer = Consumer::new();
    consumer.accepts("pub fn check(mut options: bead::ServiceServerOptions, hook: bead::AdmissionHook) { options.admissions = Some(std::collections::BTreeMap::from([(\"loud\", hook)])); }");
    consumer.refuses("pub fn check(mut options: bead::ServiceServerOptions) { options.admissions = Some(std::collections::BTreeMap::from([(\"loud\", None)])); }", ("E0308", "mismatched types"));
    consumer.refuses(
        "pub fn check() { let _ = bead::AdmissionHook { admits: None, detail: None }; }",
        ("E0308", "mismatched types"),
    );
}

// decision 0047: the hooks are required exactly when a procedure names one, refused as the
// service is built where the TypeScript side's types refuse them
#[test]
fn refuses_options_without_admissions_where_a_procedure_names_a_hook() {
    let greeter = Greeter::new();
    let none_listed = ServiceServerOptions {
        admissions: Some(BTreeMap::new()),
        ..ServiceServerOptions::default()
    };
    let failing_fast = ServiceServerOptions {
        fail_fast: Some(true),
        ..ServiceServerOptions::default()
    };
    for options in [ServiceServerOptions::default(), none_listed, failing_fast] {
        assert_eq!(
            ServiceServer::new(greeter.procedures(), &options)
                .expect_err("the admissions missing")
                .message(),
            "shout is admitted by the hook loud, which the options do not give"
        );
    }
}

#[tokio::test]
async fn answers_a_failure_its_procedure_lists() {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    let listed = ListedFailure::new(
        "NOBODY_TO_GREET",
        core::num::NonZeroU16::new(1).expect("a nonzero code"),
    );
    let catalogue = failures_of(
        7,
        &[
            listed,
            ListedFailure::new(
                "TOO_LOUD",
                core::num::NonZeroU16::new(2).expect("a nonzero code"),
            ),
        ],
    )
    .expect("a catalogue");
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
    let news = service
        .notifier_of(&greeter.news)
        .expect("given before the offer");
    news.notify("before".to_owned(), &NotifyOptions::default())
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
            NotificationDependencies::new(
                RequestDependencies::new(TextCodec, TextCodec),
                TextCodec,
            ),
        )
        .expect("a notification");
    let registration = notification
        .register(
            "subscribe".to_owned(),
            Arc::new(move |value| {
                locked(&hearing).push(value);
                Box::pin(async { Ok(()) })
            }),
            &RegistrationOptions::default(),
        )
        .await
        .expect("subscribed");
    news.notify("after".to_owned(), &NotifyOptions::default())
        .await;
    pair.settle().await;
    assert_eq!(*locked(&heard), ["after"]);
    registration.unregister().await.expect("unregistered");
}

#[tokio::test]
async fn gives_one_notifier_for_each_procedure_that_notifies_and_refuses_a_procedure_its_service_lacks()
 {
    let pair = pair().await;
    let greeter = Greeter::new();
    let service = greeter.service(loud());
    let other_news =
        notifying_of(init((2, "news"), AdmissionRule::None), TextCodec).expect("other news");
    let absent =
        notifying_of(init((11, "weather"), AdmissionRule::None), TextCodec).expect("absent");
    let notifying: Vec<String> = greeter
        .procedures()
        .iter()
        .filter(|described| described.procedure().procedure_kind == Some(ProcedureKind::Notifies))
        .map(|described| described.procedure().procedure_name.clone())
        .collect();
    assert_eq!(
        notifying,
        ["news"],
        "the greeter's one procedure that notifies"
    );
    for offered in [false, true] {
        if offered {
            service.offer(&pair.server).expect("offered");
        }
        let news = service
            .notifier_of(&greeter.news.clone())
            .expect("its notifier");
        assert!(
            format!("{news:?}").contains("news"),
            "the notifier of its procedure"
        );
        assert_eq!(
            service
                .notifier_of(&other_news)
                .expect_err("a distinct descriptor of the same name and types")
                .message(),
            "news is no procedure of this service"
        );
        assert_eq!(
            service
                .notifier_of(&absent)
                .expect_err("a procedure the service lacks")
                .message(),
            "weather is no procedure of this service"
        );
    }
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
            .map(|procedure| procedure.procedure_name.clone())
            .collect::<Vec<_>>(),
        ["login", "news", "shout", "whoami"]
    );
    let failure = call(&pair, (&greeter.login, "ada"))
        .await
        .expect_err("no resolver");
    assert!(
        matches!(failure, CallError::Failure(failure) if failure.protocol_code() == Some(ProtocolCode::PROCEDURE_UNKNOWN))
    );
    assert_eq!(
        greeter.clock.procedure().procedure_kind,
        Some(ProcedureKind::Command)
    );
}

pub(super) const NOT_EMPTY_DETAIL: &str = "{\"bounds\":{\"min_len\":\"1\"},\"message\":\"must be at least 1 characters\",\"ruleId\":\"string.min_len\"}\n{\"more\":0}";

pub(super) fn not_empty() -> Validate<String> {
    Arc::new(|value, _| {
        if !value.is_empty() {
            return Ok(Judged::default());
        }
        Ok(Judged {
            violations: vec![Violation {
                bounds: Some(
                    serde_json::json!({ "min_len": "1" })
                        .as_object()
                        .expect("bounds")
                        .clone(),
                ),
                message: Some("must be at least 1 characters".to_owned()),
                rule_id: "string.min_len".to_owned(),
                value: Some(serde_json::Value::String(value.clone())),
                ..Violation::default()
            }],
            ..Judged::default()
        })
    })
}

fn checked(validate: Validate<String>, command: bool) -> TextDescriptor {
    let init = DescriptorInit {
        procedure: crate::identity::Procedure {
            service_id: 8,
            ..init((if command { 3 } else { 1 }, "echo"), AdmissionRule::None).procedure
        },
        validate: Some(validate),
        ..init((1, "echo"), AdmissionRule::None)
    };
    if command {
        command_of(init).expect("a command")
    } else {
        request_of(init).expect("a request")
    }
}

#[tokio::test]
async fn answers_payload_invalid_with_its_violations_to_a_request_its_rules_refuse_before_its_resolver()
 {
    let pair = pair().await;
    let descriptor = checked(not_empty(), false);
    let service = ServiceServer::new(
        vec![ServiceProcedure::from(&descriptor)],
        &ServiceServerOptions::default(),
    )
    .expect("a checked service");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seeing = Arc::clone(&seen);
    service
        .on(
            &descriptor,
            Arc::new(move |request, response| {
                locked(&seeing).push(request.payload.clone());
                response.result(request.payload)
            }),
        )
        .expect("registered");
    service.offer(&pair.server).expect("offered");
    assert_eq!(call(&pair, (&descriptor, "hi")).await.expect("valid"), "hi");
    let CallError::Failure(failure) = call(&pair, (&descriptor, ""))
        .await
        .expect_err("an empty request")
    else {
        panic!("a protocol failure");
    };
    assert_eq!(failure.protocol_code(), Some(ProtocolCode::PAYLOAD_INVALID));
    assert_eq!(failure.scope(), FailureScope::Protocol);
    assert_eq!(failure.origin(), FailureOrigin::Peer);
    assert_eq!(failure.detail(), NOT_EMPTY_DETAIL);
    assert_eq!(
        violations_of(&failure),
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
    pair.settle().await;
    assert_eq!(*locked(&seen), ["hi"]);
    assert!(locked(&pair.server_reports).is_empty());
}

#[tokio::test]
async fn answers_procedure_failed_to_a_validate_that_throws_and_reports_it() {
    let pair = pair().await;
    let rules = not_empty();
    let descriptor = checked(
        Arc::new(move |value, options| {
            assert!(!value.is_empty(), "a rule that fails to judge");
            rules(value, options)
        }),
        false,
    );
    let service = ServiceServer::new(
        vec![ServiceProcedure::from(&descriptor)],
        &ServiceServerOptions::default(),
    )
    .expect("a checked service");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seeing = Arc::clone(&seen);
    service
        .on(
            &descriptor,
            Arc::new(move |request, response| {
                locked(&seeing).push(request.payload.clone());
                response.result(request.payload)
            }),
        )
        .expect("registered");
    service.offer(&pair.server).expect("offered");
    assert_eq!(
        call(&pair, (&descriptor, "hi")).await.expect("judged"),
        "hi"
    );
    let CallError::Failure(failure) = call(&pair, (&descriptor, ""))
        .await
        .expect_err("a broken rule")
    else {
        panic!("a protocol failure");
    };
    assert_eq!(
        failure.protocol_code(),
        Some(ProtocolCode::PROCEDURE_FAILED)
    );
    assert_eq!(failure.detail(), "");
    pair.settle().await;
    assert_eq!(*locked(&seen), ["hi"]);
    let reports = locked(&pair.server_reports);
    assert_eq!(reports.len(), 1);
    assert!(
        reports[0]
            .0
            .to_string()
            .contains("a rule that fails to judge")
    );
    assert_eq!(reports[0].1.as_ref(), Some(&pair.connection_handle));
}

#[tokio::test]
async fn validates_a_command_before_it_goes_when_its_options_say_so() {
    let pair = pair().await;
    let descriptor = checked(not_empty(), true);
    let service = ServiceServer::new(
        vec![ServiceProcedure::from(&descriptor)],
        &ServiceServerOptions {
            validates: Some(true),
            ..ServiceServerOptions::default()
        },
    )
    .expect("a validating service");
    let heard = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&heard);
    pair.client
        .services()
        .get_command_resolver(
            descriptor.procedure(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("a command resolver")
        .register(
            (
                Arc::new(move |request, response| {
                    locked(&hearing).push(request.payload.clone());
                    response.result(request.payload.to_uppercase())
                }),
                None,
            ),
            true,
        )
        .expect("registered");
    service.offer(&pair.server).expect("offered");
    let command = service.command_of(&descriptor).expect("made");
    let options = || CommandOptions::new(Arc::clone(&pair.connection_handle));
    let CallError::Failure(failure) = command
        .call(String::new(), &options())
        .expect("a call")
        .await
        .expect_err("invalid")
    else {
        panic!("a protocol failure");
    };
    assert_eq!(failure.protocol_code(), Some(ProtocolCode::PAYLOAD_INVALID));
    assert_eq!(failure.origin(), FailureOrigin::Local);
    assert_eq!(failure.side(), Some(RouterSide::Server));
    assert_eq!(failure.detail(), NOT_EMPTY_DETAIL);
    pair.settle().await;
    assert!(locked(&heard).is_empty());
    assert_eq!(
        command
            .call("hi".to_owned(), &options())
            .expect("a call")
            .await
            .expect("valid"),
        "HI"
    );
    assert_eq!(*locked(&heard), ["hi"]);
}

// a validating service's command judged by `validate`, its client's resolver recording what it hears
async fn judged_before_it_goes(
    validate: Validate<String>,
) -> (Pair, CallError, Arc<Mutex<Vec<String>>>) {
    let pair = pair().await;
    let descriptor = checked(validate, true);
    let service = ServiceServer::new(
        vec![ServiceProcedure::from(&descriptor)],
        &ServiceServerOptions {
            validates: Some(true),
            ..ServiceServerOptions::default()
        },
    )
    .expect("a validating service");
    let heard = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&heard);
    pair.client
        .services()
        .get_command_resolver(
            descriptor.procedure(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("a command resolver")
        .on(Arc::new(move |request, response| {
            locked(&hearing).push(request.payload.clone());
            response.result(request.payload)
        }))
        .expect("registered");
    service.offer(&pair.server).expect("offered");
    let failed = service
        .command_of(&descriptor)
        .expect("made")
        .call(
            "hi".to_owned(),
            &CommandOptions::new(Arc::clone(&pair.connection_handle)),
        )
        .expect("a call")
        .await
        .expect_err("its rule failed to judge");
    pair.settle().await;
    (pair, failed, heard)
}

// spec 18.2
#[tokio::test]
async fn fails_a_command_whose_rule_throws_as_it_judges_with_that_throw_before_anything_goes() {
    let (pair, failed, heard) = judged_before_it_goes(Arc::new(|_, _| {
        Err("this rule fails to judge, on purpose".into())
    }))
    .await;

    let CallError::Other(error) = failed else {
        panic!("its rule's own error: {failed:?}");
    };
    assert_eq!(error.to_string(), "this rule fails to judge, on purpose");
    // * failed on this side, before it went: its client heard nothing, and neither router reported
    assert!(locked(&heard).is_empty());
    assert!(locked(&pair.server_reports).is_empty());
    assert!(locked(&pair.client_reports).is_empty());
}

// spec 18.2, decision 0044: a rule's panic is its throw, named as a rule's
#[tokio::test]
async fn fails_a_command_whose_rule_panics_as_it_judges_with_that_panic_before_anything_goes() {
    let (pair, failed, heard) = judged_before_it_goes(Arc::new(|_, _| {
        panic!("this rule panics as it judges, on purpose")
    }))
    .await;

    let CallError::Other(error) = failed else {
        panic!("its rule's panic: {failed:?}");
    };
    assert_eq!(
        error.to_string(),
        "a rule panicked: this rule panics as it judges, on purpose"
    );
    assert!(locked(&heard).is_empty());
    assert!(locked(&pair.server_reports).is_empty());
    assert!(locked(&pair.client_reports).is_empty());
}
