//! The issuer reader takes every held request and refuses every other shape in the shared file.

use serde_json::Value;

#[path = "tests/notifications.rs"]
mod notifications;
#[path = "tests/server.rs"]
mod server;

#[test]
fn bounds_the_interop_bytes_before_allocating_and_reserves_them_fallibly() {
    for length in [2_147_483_648, 1_u64 << 40, u64::MAX] {
        super::bytes_of(length).expect_err("outside the C# handler's Int32 range");
    }
    for length in [0, 1, 1_000, 3 * 1_048_576] {
        let value = super::bytes_of(length).expect("a held length");
        assert_eq!(u64::try_from(value.len()).expect("the length fits"), length);
        assert!(
            value.bytes().all(|byte| byte == b'x'),
            "the requested bytes"
        );
    }
}

#[test]
fn refuses_an_interop_duration_outside_its_range_without_panicking() {
    for given in [
        serde_json::json!(1e300),
        serde_json::json!(-1),
        Value::Null,
        serde_json::json!(0),
        serde_json::json!(2_147_483_648_u64),
    ] {
        let refusal =
            super::duration_of("timeout", Some(&given)).expect_err("outside the duration's range");
        assert!(
            refusal.message().starts_with("timeout is "),
            "the duration is named"
        );
    }
    assert_eq!(super::duration_of("timeout", None).expect("absent"), None);
    assert_eq!(
        super::duration_of("timeout", Some(&serde_json::json!(1.5))).expect("rounded"),
        Some(core::time::Duration::from_millis(2))
    );
    assert_eq!(
        super::duration_of("timeout", Some(&serde_json::json!(2_147_483_647_u64)))
            .expect("the ceiling"),
        Some(core::time::Duration::from_millis(2_147_483_647))
    );
}

#[test]
fn the_interop_services_end_sessions_of_takes_an_issuer_alone_a_string_and_throws_for_anything_else()
 {
    let service: Value =
        serde_json::from_str(crate::INTEROP_SERVICE).expect("the interop service reads");
    let cases = &service["verifiers"]["endSessionsOf"];
    let takes = cases["takes"].as_array().expect("taken requests");
    let refuses = cases["refuses"].as_array().expect("refused requests");
    assert_ne!(takes, &Vec::<Value>::new());
    assert_ne!(refuses, &Vec::<Value>::new());
    for taken in takes {
        assert_eq!(
            super::issuer_of(&taken["request"]).expect("an issuer alone"),
            taken["issuer"].as_str().expect("an issuer")
        );
    }
    for request in refuses {
        assert_eq!(
            super::issuer_of(request)
                .expect_err("no issuer alone")
                .to_string(),
            cases["refusal"].as_str().expect("the refusal")
        );
    }
    // JavaScript's undefined has no serde_json::Value; null is the file's explicit absent value.
}

// the procedures a registry holds a resolver's series of, by name: those its side answers, each
// series of a call answered named `bead_server_call_…` on either side
fn answered_in(exposition: &str) -> Vec<String> {
    let mut names: Vec<String> = exposition
        .lines()
        .filter_map(|line| {
            line.strip_prefix("bead_server_call_handled_total{service=\"1\",procedure=\"")
        })
        .filter_map(|rest| rest.split('"').next())
        .map(str::to_owned)
        .collect();
    names.sort_unstable();
    names.dedup();
    names
}

// every procedure answered by the side its kind names: a command by the client, any other by the
// server, as the registries each side declares to tell
#[tokio::test]
async fn every_procedure_of_the_interop_services_api_is_offered_on_the_side_its_kind_names() {
    use bead::testing::pair::{Pair, PairOptions};
    use bead::{
        ClientOptions, MetricsRegistry, MetricsRegistryOptions, ProcedureKind, ServerOptions,
    };

    let server_registry =
        MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let client_registry =
        MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let mut options = PairOptions::default();
    let mut server = ServerOptions::default();
    server.metrics_registry = Some(server_registry.clone());
    options.server = Some(server);
    let mut client = ClientOptions::default();
    client.metrics_registry = Some(client_registry.clone());
    options.client = Some(client);
    let pair = Pair::connected(bead::testing::instants::new_year(), &options)
        .await
        .expect("a pair connected");

    let interop = crate::offer_interop(&pair.server).expect("the interop offered");
    crate::offer_interop_client(&pair.client).expect("its client half offered");

    let names_of = |is_command: bool| {
        let mut names: Vec<String> = interop
            .procedures
            .all()
            .iter()
            .map(bead::ServiceProcedure::procedure)
            .filter(|procedure| {
                (procedure.procedure_kind == Some(ProcedureKind::Command)) == is_command
            })
            .map(|procedure| procedure.procedure_name.clone())
            .collect();
        names.sort_unstable();
        names
    };
    assert_eq!(interop.service.procedures_without_resolver(), []);
    let server_text = server_registry.exposition().text;
    let client_text = client_registry.exposition().text;
    assert_eq!(answered_in(&server_text), names_of(false), "{server_text}");
    assert_eq!(answered_in(&client_text), names_of(true), "{client_text}");
    pair.client.dispose().await;
}
