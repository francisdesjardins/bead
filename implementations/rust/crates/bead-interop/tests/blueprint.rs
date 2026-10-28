//! The interop service's descriptors, written by hand until the builder's Rust target writes them,
//! held to `spec/interop-blueprint.json`: its service, its failures, and each procedure's id, name,
//! kind, admission, failures and encodings, in its order.

use bead::{AdmissionRule, ListedFailure, PayloadCodec, ProcedureKind};
use bead_interop::{
    SERVICE_ID, SERVICE_NAME, SERVICE_REVISION, interop_failures, interop_procedures,
};
use serde_json::{Value, json};

fn blueprint() -> Result<Value, String> {
    bead::testing::files::read::<Value>("interop-blueprint.json")
}

fn admission_of(rule: AdmissionRule) -> Value {
    match rule {
        AdmissionRule::Session => json!("session"),
        AdmissionRule::Hook(name) => json!({ "hook": name }),
        AdmissionRule::None | _ => json!("none"),
    }
}

#[test]
fn holds_the_interop_service_to_its_blueprint() {
    let blueprint = blueprint().expect("the blueprint read");
    let service = blueprint
        .get("services")
        .and_then(|services| services.get(0))
        .expect("the interop service");

    assert_eq!(
        (
            service.get("serviceId"),
            service.get("serviceName"),
            service.get("serviceRevision")
        ),
        (
            Some(&json!(SERVICE_ID)),
            Some(&json!(SERVICE_NAME)),
            Some(&json!(SERVICE_REVISION))
        ),
        "its service"
    );

    let failures = interop_failures().expect("its failures");
    let listed: Vec<Value> = failures
        .failures()
        .iter()
        .map(|failure| json!({ "code": failure.code(), "failureName": failure.name() }))
        .collect();
    let blueprinted: Vec<Value> = service
        .get("failures")
        .and_then(Value::as_array)
        .expect("its failures")
        .iter()
        .map(|failure| json!({ "code": failure.get("code"), "failureName": failure.get("failureName") }))
        .collect();

    assert_eq!(listed, blueprinted, "its failures, in their order");
}

#[test]
fn holds_each_interop_procedure_to_its_blueprint_in_its_order() {
    let blueprint = blueprint().expect("the blueprint read");
    let procedures = blueprint
        .get("services")
        .and_then(|services| services.get(0))
        .and_then(|service| service.get("procedures"))
        .and_then(Value::as_array)
        .expect("its procedures")
        .clone();
    let interop = interop_procedures(None).expect("its descriptors");
    let described = interop.described();

    assert_eq!(
        described.len(),
        procedures.len(),
        "one descriptor a procedure"
    );

    for ((procedure, admission, failures, _validates), blueprinted) in
        described.iter().zip(&procedures)
    {
        let name = &procedure.name;
        let kind = procedure.kind.map(ProcedureKind::as_str);

        assert_eq!(
            Some(&json!(procedure.id)),
            blueprinted.get("procedureId"),
            "{name}: its id"
        );
        assert_eq!(
            Some(&json!(name)),
            blueprinted.get("procedureName"),
            "{name}: its name"
        );
        assert_eq!(
            kind.map(|kind| json!(kind)).as_ref(),
            blueprinted.get("procedureKind"),
            "{name}: its kind"
        );
        assert_eq!(
            Some(&admission_of(*admission)),
            blueprinted.get("admission"),
            "{name}: its admission"
        );
        assert_eq!(
            Some(&json!(
                failures.iter().map(ListedFailure::name).collect::<Vec<_>>()
            )),
            blueprinted.get("failures"),
            "{name}: its failures"
        );
        assert_eq!(procedure.service_id, SERVICE_ID, "{name}: its service");
        assert_eq!(
            procedure.service_revision, SERVICE_REVISION,
            "{name}: its revision"
        );
    }

    // each payload json, as every procedure of the blueprint is
    let encoding = interop.echo.request().encoding();

    for blueprinted in &procedures {
        for part in ["request", "result"] {
            assert_eq!(
                blueprinted
                    .get(part)
                    .and_then(|written| written.get("encoding")),
                Some(&json!(encoding)),
                "{part}: json"
            );
        }
    }

    assert_eq!(
        procedures
            .iter()
            .filter(|blueprinted| blueprinted.get("notification").is_some())
            .filter_map(|blueprinted| blueprinted.get("procedureName"))
            .collect::<Vec<_>>(),
        [&json!(interop.ticks.descriptor().procedure().name)],
        "ticks alone notifies"
    );
    assert_eq!(
        interop.ticks.notification().encoding(),
        encoding,
        "its notification json"
    );
}
