//! A procedure's identity: its name's form, one name whatever its ASCII case, its declaration
//! within its ranges and its kind.

use super::{
    DeclarationWay, IdentityRefusal, Procedure, are_one_name, check_declaration,
    check_procedure_kind, is_procedure_name,
};
use crate::constants::ProcedureKind;
use crate::errors::Refusal;
use crate::testing::pair::echo;

#[test]
fn refuses_an_id_or_a_revision_out_of_its_range_service_0_and_revision_0_among_them() {
    for procedure in [
        Procedure {
            service_id: 0,
            ..echo()
        },
        Procedure {
            procedure_id: 0,
            ..echo()
        },
        Procedure {
            service_revision: 0,
            ..echo()
        },
        Procedure {
            service_revision: 1 << 31,
            ..echo()
        },
        Procedure {
            service_revision: u32::MAX,
            ..echo()
        },
    ] {
        assert_eq!(
            check_declaration(&procedure)
                .expect_err("out of range")
                .reason(),
            Some(Refusal::Identity(IdentityRefusal::OutOfItsRange))
        );
    }
    let consumer = crate::testing::surface::Consumer::new();
    consumer.accepts("pub fn check(p: &mut bead::Procedure) { p.procedure_id = 65535; p.service_id = 65535; p.service_revision = 2147483647; }");
    for field in ["procedure_id", "service_id"] {
        consumer.refuses(
            &format!("pub fn check(p: &mut bead::Procedure) {{ p.{field} = 65536; }}"),
            ("overflowing_literals", "u16"),
        );
    }
    consumer.refuses(
        "pub fn check(p: &mut bead::Procedure) { p.service_revision = -1; }",
        ("E0600", "cannot apply unary operator"),
    );
}

#[test]
fn refuses_a_name_off_its_form_and_refuses_out_of_its_range_first() {
    for name in ["", "Echo", "_OTHER", &"a".repeat(64), "get_thing"] {
        assert_eq!(
            check_declaration(&Procedure {
                procedure_name: name.to_owned(),
                ..echo()
            })
            .expect_err("off its form")
            .reason(),
            Some(Refusal::Identity(IdentityRefusal::OffItsForm))
        );
    }
    assert_eq!(
        check_declaration(&Procedure {
            procedure_name: "Echo".to_owned(),
            service_id: 0,
            ..echo()
        })
        .expect_err("its range first")
        .reason(),
        Some(Refusal::Identity(IdentityRefusal::OutOfItsRange))
    );
    crate::testing::surface::Consumer::new().refuses(
        "pub fn check(p: &mut bead::Procedure) { p.procedure_name = 1; }",
        ("E0308", "mismatched types"),
    );
}

#[test]
fn says_which_ids_revision_and_name_it_was_given() {
    assert_eq!(
        check_declaration(&Procedure {
            service_id: 0,
            ..echo()
        })
        .expect_err("out of range")
        .to_string(),
        "\"echo\" at 0/1, revision 3, is out of its range: a service and a procedure are from 1 to 65535, a revision from 1 to 2147483647 (spec 16.2)"
    );
    assert_eq!(
        check_declaration(&Procedure {
            procedure_name: "_OTHER".to_owned(),
            ..echo()
        })
        .expect_err("off its form")
        .to_string(),
        "\"_OTHER\" at 2/1 is off its form: a procedure's name is a lower-case ASCII letter, then up to 62 ASCII letters or digits (spec 16.4)"
    );
}

#[test]
fn refuses_a_name_holding_a_surrogate_alone_off_its_form_and_folds_none_but_an_ascii_letter() {
    // A Rust string holds Unicode scalar values alone: a surrogate is refused as it is read.
    for units in [
        &[0x61_u16, 0xd800, 0x62][..],
        &[0x65, 0x63, 0x68, 0x6f, 0xdc00],
    ] {
        String::from_utf16(units).expect_err("a surrogate alone is no scalar value");
    }
    for surrogate in [0xd800, 0xdc00] {
        assert_eq!(char::from_u32(surrogate), None);
    }
    assert!(!is_procedure_name("a\u{1f600}"));
    assert!(are_one_name("a\u{1f600}", "A\u{1f600}"));
    assert!(!are_one_name("a\u{1f600}", "a\u{1f601}"));
    assert!(!are_one_name("[", "{"));
}

#[test]
fn reads_a_name_whole_a_character_at_a_time_never_as_a_case_mapping_or_a_regular_expression_would()
{
    for name in [
        "echo\n",
        "\u{212a}elvin",
        "\u{17f}tatus",
        "\u{130}d",
        "caf\u{e9}",
        "\u{feff}echo",
        "echo\0",
    ] {
        assert!(!is_procedure_name(name), "{name:?}");
    }
    String::from_utf16(&[0x65, 0x63, 0x68, 0x6f, 0xd800])
        .expect_err("a surrogate alone is no scalar value");
    assert!(is_procedure_name("x9"));
}

#[test]
fn refuses_a_kind_its_way_does_not_take_against_its_kind_and_takes_a_procedure_that_states_none() {
    assert_eq!(
        check_procedure_kind(&echo(), DeclarationWay::ServerRequester)
            .expect_err("a request is no command")
            .to_string(),
        "\"echo\" at 2/1 is against its kind: a request, which a requester on a server's router does not take; it takes a command (spec 16.11)"
    );
    for way in [
        DeclarationWay::ClientRequester,
        DeclarationWay::ServerResolver,
        DeclarationWay::ClientNotification,
    ] {
        check_procedure_kind(
            &Procedure {
                procedure_kind: None,
                ..echo()
            },
            way,
        )
        .expect("no kind stated");
    }
}

#[derive(Debug)]
struct Notification(Procedure);

impl crate::router::client::NotificationLike for Notification {
    fn procedure(&self) -> &Procedure {
        &self.0
    }

    fn trigger(
        &self,
        _payload: bytes::Bytes,
    ) -> Result<
        crate::router::types::BoxFuture<crate::router::client::Settled>,
        crate::router::types::RouterError,
    > {
        Ok(Box::pin(async { Vec::new() }))
    }
}

#[tokio::test]
async fn a_refused_declaration_declares_nothing_its_registry_holding_no_series_of_it() {
    use crate::client::ClientOptions;
    use crate::metrics::{MetricsRegistry, MetricsRegistryOptions};
    use crate::testing::pair::{Pair, PairOptions};
    use std::sync::Arc;

    let registry = MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let pair = Pair::connected(
        crate::testing::instants::new_year(),
        &PairOptions {
            client: Some(ClientOptions {
                metrics_registry: Some(registry.clone()),
                ..ClientOptions::default()
            }),
            ..PairOptions::default()
        },
    )
    .await
    .expect("connected");
    let router = pair.client.router();
    let before = registry.exposition().text;
    assert!(
        router
            .declare_requester(&Procedure {
                service_revision: 0,
                ..echo()
            })
            .expect_err("out of range")
            .to_string()
            .contains(" is out of its range: ")
    );
    assert!(
        router
            .register_notification(Arc::new(Notification(Procedure {
                procedure_name: "Echo".to_owned(),
                ..echo()
            })))
            .expect_err("off its form")
            .to_string()
            .contains(" is off its form: ")
    );
    assert_eq!(registry.exposition().text, before);
    router
        .declare_requester(&echo())
        .expect("the address is free");
    assert!(registry.exposition().text.lines().any(|line| line
        == "bead_client_call_started_total{service=\"2\",procedure=\"echo\",type=\"request\"} 0"));
    pair.client.dispose().await;
    pair.server.dispose().await.expect("disposed");
}

#[tokio::test]
async fn checks_a_declaration_before_the_router_s_reasons_and_its_registry_s() {
    use crate::client::ClientOptions;
    use crate::metrics::{MetricsRegistry, MetricsRegistryOptions};
    use crate::router::core::Handler;
    use crate::server::ServerOptions;
    use crate::testing::pair::{Pair, PairOptions};
    use std::sync::Arc;

    let registry = || MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let pair = Pair::connected(
        crate::testing::instants::new_year(),
        &PairOptions {
            client: Some(ClientOptions {
                metrics_registry: Some(registry()),
                ..ClientOptions::default()
            }),
            server: Some(ServerOptions {
                metrics_registry: Some(registry()),
                ..ServerOptions::default()
            }),
        },
    )
    .await
    .expect("connected");
    let handler = || Handler {
        resolve: Arc::new(|_| Box::pin(async { Ok(()) })),
        admit: None,
        maximum_payload_bytes: None,
        forwards_credentials: false,
        notifies: false,
    };
    let server = pair.server.router();
    let client = pair.client.router();
    let procedure = Procedure {
        procedure_kind: None,
        ..echo()
    };
    server
        .register_resolver((&procedure, handler()))
        .expect("a resolver");
    server.declare_requester(&procedure).expect("a requester");
    client.declare_requester(&procedure).expect("a requester");
    let named = Procedure {
        procedure_name: "Echo".to_owned(),
        ..procedure
    };
    for refusal in [
        server
            .register_resolver((&named, handler()))
            .expect_err("form before duplicate"),
        server
            .declare_requester(&named)
            .expect_err("form before registry"),
        client
            .register_notification(Arc::new(Notification(named)))
            .expect_err("form before kind"),
    ] {
        assert!(refusal.to_string().contains(" is off its form: "));
        assert_eq!(
            refusal.reason(),
            Some(Refusal::Identity(IdentityRefusal::OffItsForm))
        );
    }
    pair.client.dispose().await;
    pair.server.dispose().await.expect("disposed");
}

#[test]
fn names_a_procedure_by_a_lower_case_letter_then_letters_and_digits_63_at_most() {
    let longest = "a".repeat(63);
    let past = "a".repeat(64);

    for name in ["echo", "endSessionsOf", "a1", longest.as_str()] {
        assert!(is_procedure_name(name), "{name} a name");
    }

    for name in ["", "Echo", "1a", "end_session", "caf\u{e9}", past.as_str()] {
        assert!(!is_procedure_name(name), "{name} no name");
    }
}

#[test]
fn folds_ascii_letters_alone_as_it_compares_names() {
    assert!(are_one_name("echo", "eCHO"), "ASCII folded");
    assert!(
        !are_one_name("caf\u{e9}", "caf\u{c9}"),
        "a name outside ASCII its own"
    );
    assert!(!are_one_name("echo", "echos"), "another name");
}

#[test]
fn refuses_a_declaration_out_of_its_range_then_off_its_form_then_against_its_kind() {
    let reason_of = |procedure: &Procedure| {
        check_declaration(procedure)
            .err()
            .and_then(|refused| refused.reason())
    };

    assert_eq!(reason_of(&echo()), None, "echo holds");
    assert_eq!(
        reason_of(&Procedure {
            service_id: 0,
            procedure_name: "Off".to_owned(),
            ..echo()
        }),
        Some(Refusal::Identity(IdentityRefusal::OutOfItsRange)),
        "its range first"
    );
    assert_eq!(
        reason_of(&Procedure {
            procedure_name: "Off".to_owned(),
            ..echo()
        }),
        Some(Refusal::Identity(IdentityRefusal::OffItsForm)),
        "then its form"
    );

    let command = Procedure {
        procedure_kind: Some(ProcedureKind::Command),
        ..echo()
    };

    assert!(
        check_procedure_kind(&command, DeclarationWay::ClientResolver).is_ok(),
        "a command a client resolves"
    );
    assert_eq!(
        check_procedure_kind(&command, DeclarationWay::ClientRequester)
            .err()
            .and_then(|refused| refused.reason()),
        Some(Refusal::Identity(IdentityRefusal::AgainstItsKind)),
        "a command a client never asks"
    );
    assert!(
        check_procedure_kind(
            &Procedure {
                procedure_kind: None,
                ..echo()
            },
            DeclarationWay::ClientRequester
        )
        .is_ok(),
        "no kind taken every way"
    );
}
