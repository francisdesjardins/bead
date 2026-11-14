use super::{HttpMethod, HttpPayload, HttpRouteInit, HttpRouteTemplate, route_of};
use crate::constants::ProcedureKind;
use crate::identity::Procedure;
use crate::payloads::JsonCodec;
use crate::service::{AdmissionRule, DescriptorInit, ServiceProcedure, notifying_of, request_of};

fn procedure(name: &str, procedure_id: u16) -> Procedure {
    Procedure {
        service_id: 7,
        procedure_id,
        service_revision: 1,
        procedure_name: name.to_owned(),
        procedure_kind: None,
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

fn init(procedure: Procedure) -> DescriptorInit<JsonCodec, JsonCodec> {
    DescriptorInit {
        procedure,
        admission: AdmissionRule::None,
        failures: vec![],
        request: JsonCodec,
        result: JsonCodec,
        validate: None,
    }
}

fn get_book() -> ServiceProcedure {
    let descriptor = request_of(init(procedure("getBook", 1))).expect("getBook described");

    ServiceProcedure::from(&descriptor)
}

fn ticks() -> ServiceProcedure {
    let mut ticking = procedure("ticks", 2);

    ticking.procedure_kind = Some(ProcedureKind::Notifies);

    let descriptor = notifying_of(init(ticking), JsonCodec).expect("ticks described");

    ServiceProcedure::from(&descriptor)
}

fn route_init(procedure: ServiceProcedure) -> HttpRouteInit {
    HttpRouteInit {
        procedure,
        request: HttpPayload::Json,
        result: HttpPayload::Raw,
        notification: None,
        failures: vec![],
        no_side_effects: false,
        routes: vec![HttpRouteTemplate {
            method: HttpMethod::Get,
            template: "/v1/{name=shelves/*/books/*}".to_owned(),
            body: None,
            response_body: None,
        }],
    }
}

// what `route_of` refuses of `init`, its message
fn refusal_of(init: HttpRouteInit) -> Option<String> {
    route_of(init).err().map(|error| error.message().to_owned())
}

#[test]
fn refuses_a_payload_of_no_schema_nor_encoding_a_notification_only_one_side_has_and_a_route_of_no_method_or_no_template()
 {
    // * a payload of no form nor encoding, and a method none of http.proto's patterns names, are no
    // values of their types
    assert_eq!(
        refusal_of(HttpRouteInit {
            notification: Some(HttpPayload::Json),
            ..route_init(get_book())
        }),
        Some("getBook's notification is its route's exactly where it notifies".to_owned()),
        "a notification of a procedure that does not notify"
    );
    assert_eq!(
        refusal_of(route_init(ticks())),
        Some("ticks's notification is its route's exactly where it notifies".to_owned()),
        "a procedure that notifies without one"
    );
    assert_eq!(
        refusal_of(HttpRouteInit {
            routes: vec![HttpRouteTemplate {
                method: HttpMethod::Get,
                template: String::new(),
                body: None,
                response_body: None,
            }],
            ..route_init(get_book())
        }),
        Some("getBook's route is a method of http.proto's and a template".to_owned()),
        "a route of no template"
    );

    let held = route_of(HttpRouteInit {
        notification: Some(HttpPayload::Text),
        ..route_init(ticks())
    })
    .expect("a route that notifies with its notification");

    assert!(
        matches!(held.notification(), Some(HttpPayload::Text)),
        "its notification held"
    );
    assert!(
        matches!(held.request(), HttpPayload::Json),
        "its request held"
    );
    assert_eq!(held.routes().len(), 1, "its routes held");
    assert_eq!(
        HttpMethod::Patch.as_str(),
        "PATCH",
        "a method as HTTP spells it"
    );
}
