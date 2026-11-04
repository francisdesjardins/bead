//! Declarations are checked before their callbacks, cache conflicts and admission refusals.

use core::num::NonZeroU16;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::{ClientFixture, Fixture, header, locked};
use crate::constants::{ProcedureKind, ProtocolCode, RouterSide};
use crate::envelope::{Credential, Envelope, ResultHeader};
use crate::failure::Failure;
use crate::managers::service::{
    CommandOptions, NotificationDependencies, NotificationResolverDependencies,
    RequestDependencies, RequestResolverDependencies,
};
use crate::payloads::{JsonCodec, TextCodec};
use crate::router::admissions::BeforeRequest;
use crate::router::core::{AdmissionRequest, Carried, Side};
use crate::router::types::{CallSession, RouterError};
use crate::testing::pair::echo;
use crate::testing::scripted::handle_of;

#[tokio::test]
async fn refuses_a_resolver_off_section_16_as_it_is_asked_for_before_its_callback_is_given() {
    let fixture = Fixture::new();
    let client = ClientFixture::new();
    let named = crate::identity::Procedure {
        procedure_name: "Echo".to_owned(),
        ..echo()
    };
    let ranged = crate::identity::Procedure {
        service_revision: 0,
        ..echo()
    };
    let request = fixture
        .manager
        .get_request_resolver(
            &named,
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect_err("the request's name is off its form");
    let command = client
        .manager
        .get_command_resolver(
            &named,
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect_err("the name is checked before the command's kind");
    let notification = fixture
        .manager
        .get_notification_resolver(
            &ranged,
            NotificationResolverDependencies::new(
                RequestResolverDependencies::new(TextCodec, TextCodec),
                TextCodec,
            ),
        )
        .expect_err("the notification's revision is out of its range");
    for error in [request, command] {
        assert!(error.to_string().contains(" is off its form: "));
    }
    assert!(notification.to_string().contains(" is out of its range: "));
    fixture
        .router
        .owner()
        .run(|state| assert!(locked(&state.core().resolvers).is_empty()))
        .await
        .expect("no callback is registered");
    assert_eq!(fixture.transport.take(), []);
    fixture.router.dispose().await;
    assert_eq!(client.transport.envelopes(), []);
    client.router.dispose().await;
}

// spec 16.10, 16.11; debugging 4.1.2
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "each resolver maker on each router, by kind, as both other sides tell them"
)]
async fn makes_the_resolvers_of_requests_and_notifications_on_a_server_router_alone_and_of_commands_on_a_client_router_alone()
 {
    use crate::errors::{ProgrammerError, Refusal};
    use crate::identity::IdentityRefusal;

    const ANSWERS_COMMANDS: &str = "a client's router answers commands: get_command_resolver";
    const ANSWERS_REQUESTS: &str = "a server's router answers requests: get_request_resolver";
    const NOTIFIES: &str = "only a server notifies; a client hears notifications";

    let of_kind = |procedure_kind| crate::identity::Procedure {
        procedure_kind,
        ..echo()
    };
    let unranged = crate::identity::Procedure {
        service_id: 0,
        procedure_kind: None,
        ..echo()
    };
    let every = || {
        [
            None,
            Some(ProcedureKind::Request),
            Some(ProcedureKind::Notifies),
            Some(ProcedureKind::Command),
        ]
        .into_iter()
        .map(of_kind)
        .chain([unranged.clone()])
    };
    let told = |refused: ProgrammerError| (refused.reason(), refused.message().to_owned());
    let by_side = |message: &str| (None, message.to_owned());
    let reason_of = |refused: Result<(), (Option<Refusal>, String)>| {
        refused.expect_err("refused as it is asked for").0
    };
    let against = Some(Refusal::Identity(IdentityRefusal::AgainstItsKind));
    let ranged = Some(Refusal::Identity(IdentityRefusal::OutOfItsRange));
    let resolving = || RequestResolverDependencies::new(TextCodec, TextCodec);
    let notifying = || NotificationResolverDependencies::new(resolving(), TextCodec);
    let answered: crate::managers::service::ResolverCallback<TextCodec, TextCodec> =
        Arc::new(|request, response| response.result(request.payload));

    // on a client's router
    let client = ClientFixture::new();
    let request = |procedure: &crate::identity::Procedure| {
        client
            .manager
            .get_request_resolver(procedure, resolving())
            .map(drop)
            .map_err(told)
    };
    let notification = |procedure: &crate::identity::Procedure| {
        client
            .manager
            .get_notification_resolver(procedure, notifying())
            .map(drop)
            .map_err(told)
    };
    let command = |procedure: &crate::identity::Procedure| {
        client
            .manager
            .get_command_resolver(procedure, resolving())
            .map(drop)
            .map_err(told)
    };
    // * the side first, whatever the procedure: of every kind, and out of its range
    for procedure in every() {
        assert_eq!(
            request(&procedure),
            Err(by_side(ANSWERS_COMMANDS)),
            "{procedure:?}"
        );
        assert_eq!(
            notification(&procedure),
            Err(by_side(NOTIFIES)),
            "{procedure:?}"
        );
    }
    // then spec 16.10's reasons, for the way of the maker of its side
    for kind in [ProcedureKind::Request, ProcedureKind::Notifies] {
        assert_eq!(
            reason_of(command(&of_kind(Some(kind)))),
            against,
            "{kind:?}"
        );
    }
    assert_eq!(reason_of(command(&unranged)), ranged);
    // then the maker's own: a refusal that is not an admission's comes after the side
    let mut admitting = resolving();
    admitting.before_request = Some(BeforeRequest::new(
        |_| false,
        Some(Failure::protocol(
            ProtocolCode::PROCEDURE_FAILED,
            RouterSide::Client,
        )),
    ));
    assert_eq!(
        client
            .manager
            .get_request_resolver(&echo(), admitting)
            .map(drop)
            .map_err(told),
        Err(by_side(ANSWERS_COMMANDS))
    );
    client
        .router
        .owner()
        .run(|state| assert!(locked(&state.core().resolvers).is_empty()))
        .await
        .expect("the whole client matrix registers nothing");
    let define_command = client
        .manager
        .get_command_resolver(&of_kind(Some(ProcedureKind::Command)), resolving())
        .expect("a command resolver, on a client's router");
    client
        .router
        .owner()
        .run(|state| assert!(locked(&state.core().resolvers).is_empty()))
        .await
        .expect("the command factory waits for its callback");
    define_command
        .on(Arc::clone(&answered))
        .expect("the command registered");
    client
        .router
        .owner()
        .run(|state| {
            assert_eq!(
                locked(&state.core().resolvers)
                    .keys()
                    .copied()
                    .collect::<Vec<_>>(),
                [(2, 1)]
            );
        })
        .await
        .expect("only the command is registered");
    client.router.dispose().await;

    // on a server's router
    let server = Fixture::new();
    let request = |procedure: &crate::identity::Procedure| {
        server
            .manager
            .get_request_resolver(procedure, resolving())
            .map(drop)
            .map_err(told)
    };
    let notification = |procedure: &crate::identity::Procedure| {
        server
            .manager
            .get_notification_resolver(procedure, notifying())
            .map(drop)
            .map_err(told)
    };
    let command = |procedure: &crate::identity::Procedure| {
        server
            .manager
            .get_command_resolver(procedure, resolving())
            .map(drop)
            .map_err(told)
    };
    for procedure in every() {
        assert_eq!(
            command(&procedure),
            Err(by_side(ANSWERS_REQUESTS)),
            "{procedure:?}"
        );
    }
    for kind in [ProcedureKind::Notifies, ProcedureKind::Command] {
        assert_eq!(
            reason_of(request(&of_kind(Some(kind)))),
            against,
            "{kind:?}"
        );
    }
    for kind in [ProcedureKind::Request, ProcedureKind::Command] {
        assert_eq!(
            reason_of(notification(&of_kind(Some(kind)))),
            against,
            "{kind:?}"
        );
    }
    assert_eq!(reason_of(request(&unranged)), ranged);
    assert_eq!(reason_of(notification(&unranged)), ranged);
    server
        .router
        .owner()
        .run(|state| assert!(locked(&state.core().resolvers).is_empty()))
        .await
        .expect("no callback is registered");
    // each maker of its side makes, and registers once it is given its callback
    let define_request = server
        .manager
        .get_request_resolver(&of_kind(Some(ProcedureKind::Request)), resolving())
        .expect("a request resolver, on a server's router");
    let define_notification = server
        .manager
        .get_notification_resolver(
            &crate::identity::Procedure {
                procedure_id: 2,
                procedure_name: "news".to_owned(),
                procedure_kind: Some(ProcedureKind::Notifies),
                ..echo()
            },
            notifying(),
        )
        .expect("a notification resolver, on a server's router");
    server
        .router
        .owner()
        .run(|state| assert!(locked(&state.core().resolvers).is_empty()))
        .await
        .expect("both server factories wait for their callbacks");
    define_request
        .on(Arc::clone(&answered))
        .expect("the request registered");
    define_notification
        .on(answered)
        .expect("the notification registered");
    server
        .router
        .owner()
        .run(|state| {
            let registered = locked(&state.core().resolvers);
            assert_eq!(
                registered.keys().copied().collect::<Vec<_>>(),
                [(2, 1), (2, 2)]
            );
            assert!(!registered[&(2, 1)].handler.notifies);
            assert!(registered[&(2, 2)].handler.notifies);
            drop(registered);
        })
        .await
        .expect("both registered");
    assert_eq!(server.transport.take(), []);
    server.router.dispose().await;
}

#[tokio::test]
async fn refuses_a_procedure_off_section_16_before_its_own_reason_a_notifications_asked_for_otherwise()
 {
    let fixture = ClientFixture::new();
    let dependencies =
        || NotificationDependencies::new(RequestDependencies::new(TextCodec, TextCodec), TextCodec);
    let notification = fixture
        .manager
        .get_notification(&echo(), dependencies())
        .expect("the notification is known");
    for (procedure, reason) in [
        (
            crate::identity::Procedure {
                procedure_name: "Echo".to_owned(),
                ..echo()
            },
            " is off its form: ",
        ),
        (
            crate::identity::Procedure {
                service_revision: 0,
                ..echo()
            },
            " is out of its range: ",
        ),
    ] {
        let error = fixture
            .manager
            .get_notification(&procedure, dependencies())
            .expect_err("the declaration's identity comes before its cache conflict");
        assert!(error.to_string().contains(reason), "{error}");
    }
    let same = fixture
        .manager
        .get_notification(&echo(), dependencies())
        .expect("the valid notification remains known");
    assert!(Arc::ptr_eq(&notification.as_like(), &same.as_like()));
    let renamed = crate::identity::Procedure {
        procedure_name: "other".to_owned(),
        ..echo()
    };
    let error = fixture
        .manager
        .get_notification(&renamed, dependencies())
        .expect_err("a valid declaration reaches the manager's cache conflict");
    assert!(error.to_string().contains("already a notification"));
    assert_eq!(fixture.transport.envelopes(), []);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_trigger_the_router_never_registered_is_a_programmer_error() {
    let fixture = ClientFixture::new();
    let notification = fixture
        .manager
        .get_notification(
            &echo(),
            NotificationDependencies::new(
                RequestDependencies::new(JsonCodec, JsonCodec),
                JsonCodec,
            ),
        )
        .expect("a notification, without a registration");
    let outcome = notification
        .as_like()
        .trigger(Bytes::from_static(br#"{"text":"stray"}"#));
    let Err(RouterError::Other(error)) = outcome else {
        panic!("an unregistered trigger is a programmer error");
    };
    assert!(error.is::<crate::errors::ProgrammerError>());
    assert_eq!(error.to_string(), "echo should not have been triggered");
    assert!(!fixture.router.has_notification(&notification.as_like()));
    assert_eq!(fixture.transport.envelopes(), []);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn the_same_procedure_asked_for_with_payloads_of_other_types_is_an_invalid_operation() {
    let fixture = ClientFixture::new();
    let first = fixture
        .manager
        .get_notification(
            &echo(),
            NotificationDependencies::new(
                RequestDependencies::new(JsonCodec, JsonCodec),
                JsonCodec,
            ),
        )
        .expect("the notification reads structured text");
    let error = fixture
        .manager
        .get_notification(
            &echo(),
            NotificationDependencies::new(
                RequestDependencies::new(TextCodec, TextCodec),
                TextCodec,
            ),
        )
        .expect_err("another payload type cannot name that same notification");
    assert_eq!(
        error.to_string(),
        "2/1 is already a notification of other payloads"
    );
    let same = fixture
        .manager
        .get_notification(
            &echo(),
            NotificationDependencies::new(
                RequestDependencies::new(JsonCodec, JsonCodec),
                JsonCodec,
            ),
        )
        .expect("the first notification remains known");
    assert!(Arc::ptr_eq(&first.as_like(), &same.as_like()));
    assert_eq!(fixture.transport.envelopes(), []);
    fixture.router.dispose().await;
}

#[tokio::test]
async fn a_refusal_that_is_not_an_admission_of_the_routers_side_is_a_programmer_error_as_the_resolver_is_made()
 {
    let fixture = Fixture::new();
    for refusal in [
        Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Client),
        Failure::protocol(ProtocolCode::PROCEDURE_UNKNOWN, RouterSide::Server),
        Failure::application(NonZeroU16::new(33).expect("an application code"), ""),
    ] {
        let mut dependencies = RequestResolverDependencies::new(TextCodec, TextCodec);
        dependencies.before_request = Some(BeforeRequest::new(|_| false, Some(refusal)));
        let error = fixture
            .manager
            .get_request_resolver(&echo(), dependencies)
            .expect_err("only this side's admissions are refusals");
        assert_eq!(
            error.to_string(),
            "echo refuses with a failure that is not an admission's of the server's table"
        );
    }
    let mut dependencies = NotificationResolverDependencies::new(
        RequestResolverDependencies::new(TextCodec, TextCodec),
        TextCodec,
    );
    dependencies.before_request = Some(BeforeRequest::new(
        |_| false,
        Some(Failure::protocol(
            ProtocolCode::ACCESS_DENIED,
            RouterSide::Client,
        )),
    ));
    fixture
        .manager
        .get_notification_resolver(&echo(), dependencies)
        .expect_err("the notification's admission belongs to the other side");
    fixture
        .router
        .owner()
        .run(|state| assert!(locked(&state.core().resolvers).is_empty()))
        .await
        .expect("no callback is registered");
    fixture.router.dispose().await;
}

#[tokio::test]
async fn keeps_its_refusal_session_required_whatever_the_call_presented_for_its_router_to_answer() {
    for credential in [
        None,
        Some(Credential::Opaque(
            crate::SessionToken::new([1; 16]).expect("a token"),
        )),
        Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
        Some(Credential::Elsewhere),
    ] {
        let request = AdmissionRequest {
            connection_handle: handle_of(1),
            header: crate::envelope::RequestHeader {
                credential,
                ..header()
            },
            session: None,
            carried: None,
        };
        for refusal in [
            Some(Failure::protocol(
                ProtocolCode::SESSION_REQUIRED,
                RouterSide::Server,
            )),
            Some(
                Failure::protocol(ProtocolCode::SESSION_REQUIRED, RouterSide::Server)
                    .saying("sign in first"),
            ),
            None,
        ] {
            let expected = refusal.clone().unwrap_or_else(|| {
                Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server)
            });
            let admission = BeforeRequest::new(|_| false, refusal);
            let refused = admission.admission(RouterSide::Server)(&request)
                .expect("the admission settles")
                .expect("the request is refused");
            assert_eq!(refused.failure.record(), expected.record());
            assert_eq!(refused.failure.side(), expected.side());
            assert!(refused.by.is_none());
        }
    }
}

#[tokio::test]
async fn hands_before_request_the_connection_the_header_and_the_calls_session_alone_never_a_bearer_credential_its_call_came_with()
 {
    let handed = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&handed);
    let before = BeforeRequest::new(
        move |request| {
            locked(&hearing).push(request.clone());
            true
        },
        None,
    );
    let session = Arc::new(CallSession {
        data: Some(serde_json::json!("ada")),
        ..CallSession::default()
    });
    let header = crate::envelope::RequestHeader {
        credential: Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
        ..header()
    };
    assert!(
        before.admission(RouterSide::Server)(&AdmissionRequest {
            connection_handle: handle_of(1),
            header: header.clone(),
            session: Some(Arc::clone(&session)),
            carried: Some(Carried {
                header,
                transport_credential: Some("Bearer e".to_owned())
            }),
        })
        .expect("the admission settles")
        .is_none()
    );
    let handed = locked(&handed);
    assert_eq!(handed.len(), 1);
    let request = &handed[0];
    assert_eq!(request.connection_handle, handle_of(1));
    assert_eq!(
        request.header,
        crate::envelope::RequestHeader {
            credential: Some(Credential::Jwt(Bytes::new())),
            ..self::header()
        }
    );
    assert!(Arc::ptr_eq(
        request.session.as_ref().expect("its session"),
        &session
    ));
    drop(handed);
    crate::testing::surface::Consumer::new().refuses(
        "pub fn check(request: &bead::AdmissionRequest) { let _ = &request.carried; }",
        ("E0616", "private"),
    );
}

#[tokio::test]
async fn hands_the_router_a_procedures_payload_limit_with_its_requests_and_its_resolver_and_nothing_else_it_carries()
 {
    let fixture = Fixture::new();
    let limited = crate::identity::Procedure {
        maximum_payload_bytes: Some(64),
        procedure_kind: None,
        ..echo()
    };
    let declared = Arc::new(Mutex::new(Vec::new()));
    let declaring = Arc::clone(&declared);
    let called = Arc::new(Mutex::new(Vec::new()));
    let calling = Arc::clone(&called);
    fixture
        .router
        .observe_requester(crate::testing::scripted::RequesterProbe {
            declared: Arc::new(move |procedure, _| {
                locked(&declaring).push(procedure.clone());
            }),
            called: Arc::new(move |request| {
                locked(&calling).push(request.procedure.clone());
            }),
        });
    fixture
        .manager
        .get_request_resolver(
            &limited,
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("defined")
        .on(Arc::new(|_, _| Box::pin(async { Ok(()) })))
        .expect("registered");
    assert_eq!(
        super::admissions::handler(&fixture, 1)
            .await
            .maximum_payload_bytes,
        Some(64)
    );
    let requester = fixture
        .manager
        .get_command(&limited, RequestDependencies::new(TextCodec, TextCodec))
        .expect("declared");
    fixture.transport.open(&handle_of(1), true);
    let waiting = requester
        .call("hi".to_owned(), &CommandOptions::new(handle_of(1)))
        .expect("a command");
    fixture.clock.settle().await;
    assert_eq!(
        locked(&declared).as_slice(),
        core::slice::from_ref(&limited)
    );
    assert_eq!(*locked(&called), [limited]);
    assert_eq!(
        fixture.transport.take(),
        [(
            handle_of(1),
            Envelope::Request {
                header: crate::envelope::RequestHeader {
                    call_id: 2,
                    ..header()
                },
                payload: Bytes::from_static(b"hi"),
            }
        )]
    );
    fixture.transport.deliver(
        &Envelope::Result {
            header: ResultHeader {
                call_id: 2,
                total: None,
                credential: None,
            },
            payload: Bytes::new(),
        },
        &handle_of(1),
    );
    fixture.clock.settle().await;
    assert_eq!(waiting.await.expect("answered"), "");
    fixture.router.dispose().await;
    // A Rust declaration has no dynamic properties to copy onto a handler.
    crate::testing::surface::Consumer::new().refuses(
        "pub fn check(mut procedure: bead::Procedure) { procedure.extra = \"kept here\"; }",
        ("E0609", "no field"),
    );
}

// spec 16.11
#[tokio::test]
async fn types_a_client_s_services_and_a_server_s_by_their_side_each_without_the_other_s_makers() {
    let consumer = crate::testing::surface::Consumer::new();

    // * each side's services hold its side's three makers alone, so the other side's does not compile
    consumer.accepts("pub fn check(client: &bead::Client, server: &bead::Server) { let _ = (bead::ServiceManagerClient::get_request::<bead::TextCodec, bead::TextCodec>, bead::ServiceManagerClient::get_notification::<bead::TextCodec, bead::TextCodec, bead::TextCodec>, bead::ServiceManagerClient::get_command_resolver::<bead::TextCodec, bead::TextCodec>, bead::ServiceManagerServer::get_command::<bead::TextCodec, bead::TextCodec>, bead::ServiceManagerServer::get_request_resolver::<bead::TextCodec, bead::TextCodec>, bead::ServiceManagerServer::get_notification_resolver::<bead::TextCodec, bead::TextCodec, bead::TextCodec>); let _ = (client.services().is_debugging(), server.services().is_debugging()); }");
    for method in [
        "get_command",
        "get_request_resolver",
        "get_notification_resolver",
    ] {
        consumer.refuses(
            &format!("pub fn check(client: &bead::Client) {{ client.services().{method}(); }}"),
            ("E0599", &format!("no method named `{method}`")),
        );
    }
    for method in [
        "get_request",
        "get_notification",
        "get_command_resolver",
        "on_dropped",
    ] {
        consumer.refuses(
            &format!("pub fn check(server: &bead::Server) {{ server.services().{method}(); }}"),
            ("E0599", &format!("no method named `{method}`")),
        );
    }
    // a facade alone gives its side's services
    consumer.refuses(
        "pub fn check(router: bead::RouterClient) { let _ = bead::ServiceManagerClient::new(router, &bead::ServiceManagerOptions::default()); }",
        ("E0624", "is private"),
    );

    // what compiles makes each maker and hears each event on its own side
    let pair = crate::testing::pair::Pair::connected(
        crate::testing::instants::new_year(),
        &crate::testing::pair::PairOptions::default(),
    )
    .await
    .expect("a connected pair");
    let of_kind = |procedure_id, procedure_kind| crate::identity::Procedure {
        procedure_id,
        procedure_kind: Some(procedure_kind),
        ..echo()
    };
    let requesting = || RequestDependencies::new(TextCodec, TextCodec);
    let resolving = || RequestResolverDependencies::new(TextCodec, TextCodec);
    let client = pair.client.services();
    let server = pair.server.services();

    client
        .get_request(&echo(), requesting())
        .expect("a client makes requests");
    client
        .get_notification(
            &of_kind(2, ProcedureKind::Notifies),
            NotificationDependencies::new(requesting(), TextCodec),
        )
        .expect("a client hears notifications");
    client
        .get_command_resolver(&of_kind(3, ProcedureKind::Command), resolving())
        .expect("a client answers commands");
    server
        .get_command(&of_kind(3, ProcedureKind::Command), requesting())
        .expect("a server makes commands");
    server
        .get_request_resolver(&echo(), resolving())
        .expect("a server answers requests");
    server
        .get_notification_resolver(
            &of_kind(2, ProcedureKind::Notifies),
            NotificationResolverDependencies::new(resolving(), TextCodec),
        )
        .expect("a server notifies");

    let client_heard = [
        client.on_debug(Arc::new(|_, _| {})),
        client.on_deprecated(Arc::new(|_| {})),
        client.on_dropped(Arc::new(|_, _| {})),
    ];
    let server_heard = [
        server.on_debug(Arc::new(|_, _| {})),
        server.on_deprecated(Arc::new(|_| {})),
    ];

    assert!(client.is_debugging() && server.is_debugging());
    for listener in client_heard {
        client.off(listener);
    }
    for listener in server_heard {
        server.off(listener);
    }
    assert!(!client.is_debugging() && !server.is_debugging());
}
