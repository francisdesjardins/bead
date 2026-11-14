use core::num::NonZeroU16;

use bytes::Bytes;
use serde_json::{Value, json};

use super::{
    Arose, CallFailure, Encoding, OwnFailure, OwnProblemOptions, PROTOCOL_TYPES, Problem,
    ProblemField, ProblemOptions, ProblemRoute, RoutedFieldPath, place_by, problem_of_failure,
    problem_of_own, problem_of_refusal,
};
use crate::constants::{FailureScope, ProtocolCode};
use crate::errors::ProgrammerError;
use crate::service::ListedFailure;
use crate::transcoding::form::{BindingOptions, MessageForm, MessageFormError, RequestPlace};
use crate::transcoding::routes::{HttpMethod, HttpRouteTemplate};

// ── A form of the fixture's names ───────────────────────────────────────────

// each field of spec/transcoding.proto's messages these tests name: its message, its proto name,
// its JSON name, and the message it holds, none for a scalar or an enum
const FIELDS: &[(&str, &str, &str, Option<&str>)] = &[
    ("Everything", "a_string", "aString", None),
    ("Everything", "labels", "labels", None),
    ("Everything", "inners", "inners", Some("Inner")),
    ("Everything", "by_id", "byId", Some("Inner")),
    ("Everything", "custom_named", "renamed", None),
    ("Inner", "name", "name", None),
    ("UpdateBookRequest", "book", "book", Some("Book")),
    (
        "UpdateBookRequest",
        "update_mask",
        "updateMask",
        Some("FieldMask"),
    ),
    ("Book", "name", "name", None),
    ("Book", "title", "title", None),
];

// a message's form that holds its names alone, as bead-protobuf's `JsonForm` holds a pool's: what
// it places is what these tests pin, every other method its caller's bug
#[derive(Debug)]
struct NamedForm {
    message: &'static str,
}

fn unused() -> MessageFormError {
    MessageFormError::Programmer(ProgrammerError::new("a problem's form only places"))
}

impl MessageForm for NamedForm {
    fn full_name(&self) -> &str {
        self.message
    }

    fn bind(&self, _options: &BindingOptions<'_>) -> Result<Bytes, MessageFormError> {
        Err(unused())
    }

    fn read(&self, _body: &[u8]) -> Result<Bytes, MessageFormError> {
        Err(unused())
    }

    fn write(&self, _payload: &[u8], _field: Option<&str>) -> Result<String, MessageFormError> {
        Err(unused())
    }

    fn place_of(&self, field_path: &str, route: &HttpRouteTemplate) -> Option<RequestPlace> {
        let mut at = Some(self.message);

        place_by(&RoutedFieldPath { field_path, route }, &mut |name| {
            let &(_, _, json_name, holds) = FIELDS
                .iter()
                .find(|&&(message, proto_name, ..)| Some(message) == at && proto_name == name)?;

            at = holds;
            Some(json_name.to_owned())
        })
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn code(value: u16) -> NonZeroU16 {
    NonZeroU16::new(value).expect("a code is never 0")
}

fn failure_of(arose: Arose, protocol: ProtocolCode) -> CallFailure {
    CallFailure {
        arose,
        code: protocol.get(),
        scope: FailureScope::Protocol,
        detail: String::new(),
        credential: false,
        encoding: Encoding::Proto,
        place: None,
    }
}

fn status_of(arose: Arose, protocol: ProtocolCode) -> u16 {
    problem_of_failure(&failure_of(arose, protocol), &ProblemOptions::default()).status
}

fn fields_of(problem: &Problem) -> Vec<(&'static str, &str)> {
    problem
        .fields
        .iter()
        .map(|ProblemField { name, value }| (*name, value.as_str()))
        .collect()
}

// a route of `template` whose body is `body`: its method places nothing
fn route(template: &str, body: &str) -> HttpRouteTemplate {
    HttpRouteTemplate {
        method: HttpMethod::Post,
        template: template.to_owned(),
        body: Some(body.to_owned()),
        response_body: None,
    }
}

// the body of `PAYLOAD_INVALID`'s problem of `detail`, its request bound by `route` where it is given
fn invalid(detail: &str, route: Option<ProblemRoute<'_>>) -> Value {
    let failure = CallFailure {
        detail: detail.to_owned(),
        ..failure_of(Arose::Server, ProtocolCode::PAYLOAD_INVALID)
    };
    let options = ProblemOptions {
        route,
        ..ProblemOptions::default()
    };
    let problem = problem_of_failure(&failure, &options);

    serde_json::from_str(&problem.body).expect("a problem is one JSON text")
}

fn violation_of(field_path: &str) -> String {
    json!({ "fieldPath": field_path, "message": "m", "ruleId": "string.min_len" }).to_string()
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[test]
#[expect(
    clippy::too_many_lines,
    reason = "each status, challenge and problem of the twin the other sides hold, in their order"
)]
fn answers_each_protocol_code_with_its_status_by_where_it_arose_and_its_problem() {
    // the caller's, the server's answer the gateway could not take, and between them alone
    assert_eq!(
        status_of(Arose::Server, ProtocolCode::PAYLOAD_TOO_LARGE),
        413
    );
    assert_eq!(
        status_of(Arose::Client, ProtocolCode::ENVELOPE_TOO_LARGE),
        413
    );
    assert_eq!(
        status_of(Arose::Answer, ProtocolCode::PAYLOAD_TOO_LARGE),
        502
    );
    assert_eq!(
        status_of(Arose::Gateway, ProtocolCode::PAYLOAD_UNDECODABLE),
        400
    );
    assert_eq!(
        problem_of_failure(
            &CallFailure {
                encoding: Encoding::Text,
                ..failure_of(Arose::Server, ProtocolCode::PAYLOAD_UNDECODABLE)
            },
            &ProblemOptions::default()
        )
        .status,
        400
    );
    assert_eq!(
        status_of(Arose::Server, ProtocolCode::PAYLOAD_UNDECODABLE),
        502
    );
    assert_eq!(
        status_of(Arose::Answer, ProtocolCode::PAYLOAD_UNDECODABLE),
        502
    );
    assert_eq!(
        status_of(Arose::Server, ProtocolCode::LAYOUT_UNSUPPORTED),
        502
    );
    assert_eq!(status_of(Arose::Answer, ProtocolCode::CALL_UNKNOWN), 500);
    assert_eq!(
        status_of(Arose::Server, ProtocolCode::PROCEDURE_UNKNOWN),
        501
    );
    assert_eq!(status_of(Arose::Server, ProtocolCode::ACCESS_DENIED), 403);
    assert_eq!(
        status_of(Arose::Server, ProtocolCode::CREDENTIAL_UNSUPPORTED),
        500
    );
    assert_eq!(
        status_of(Arose::Client, ProtocolCode::TRANSFER_STALLED),
        504
    );
    assert_eq!(
        status_of(Arose::Client, ProtocolCode::DESTINATION_LOST),
        502
    );
    assert_eq!(status_of(Arose::Server, ProtocolCode::new(code(99))), 500);

    let unreachable = problem_of_failure(
        &CallFailure {
            detail: "the connection is gone".to_owned(),
            ..failure_of(Arose::Client, ProtocolCode::DESTINATION_UNREACHABLE)
        },
        &ProblemOptions::default(),
    );

    // * the gateway's own error between it and its server: its code alone, whatever its detail
    assert_eq!(
        unreachable,
        Problem {
            status: 503,
            fields: vec![ProblemField {
                name: "retry-after",
                value: "1".to_owned(),
            }],
            body: format!(
                "{{\"code\":17,\"scope\":\"protocol\",\"status\":503,\"title\":\"DESTINATION_UNREACHABLE\",\"type\":\"{PROTOCOL_TYPES}DESTINATION_UNREACHABLE\"}}"
            ),
        }
    );

    // a 401's challenge, its error after a space, or after `, ` where it holds parameters
    let required = failure_of(Arose::Server, ProtocolCode::SESSION_REQUIRED);
    let presented = CallFailure {
        credential: true,
        ..required.clone()
    };

    assert_eq!(
        fields_of(&problem_of_failure(&required, &ProblemOptions::default())),
        [("www-authenticate", "Bearer")]
    );
    assert_eq!(
        fields_of(&problem_of_failure(&presented, &ProblemOptions::default())),
        [("www-authenticate", "Bearer error=\"invalid_token\"")]
    );
    assert_eq!(
        fields_of(&problem_of_failure(
            &presented,
            &ProblemOptions {
                challenge: Some("Bearer realm=\"bead\""),
                ..ProblemOptions::default()
            }
        )),
        [(
            "www-authenticate",
            "Bearer realm=\"bead\", error=\"invalid_token\""
        )]
    );

    // an application failure, under its problem types or about:blank
    let refused = CallFailure {
        arose: Arose::Server,
        code: code(1),
        scope: FailureScope::Application,
        detail: "no".to_owned(),
        credential: false,
        encoding: Encoding::Proto,
        place: None,
    };
    let catalogue = [ListedFailure::new("REFUSED", code(1))];

    assert_eq!(
        problem_of_failure(
            &refused,
            &ProblemOptions {
                catalogue: Some(&catalogue),
                problem_types: Some("https://p.example/"),
                ..ProblemOptions::default()
            }
        )
        .body,
        "{\"code\":1,\"detail\":\"no\",\"scope\":\"application\",\"status\":400,\"title\":\"REFUSED\",\"type\":\"https://p.example/REFUSED\"}"
    );
    assert_eq!(
        problem_of_failure(&refused, &ProblemOptions::default()).body,
        "{\"code\":1,\"detail\":\"no\",\"scope\":\"application\",\"status\":400,\"title\":\"Bad Request\",\"type\":\"about:blank\"}"
    );

    // the gateway's own
    assert_eq!(
        problem_of_own(
            OwnFailure::Timeout,
            "no answer",
            &OwnProblemOptions::default()
        ),
        Problem {
            status: 504,
            fields: vec![],
            body: "{\"detail\":\"no answer\",\"status\":504,\"title\":\"Gateway Timeout\",\"type\":\"about:blank\"}"
                .to_owned(),
        }
    );
    assert_eq!(
        fields_of(&problem_of_own(
            OwnFailure::Scheme,
            "x",
            &OwnProblemOptions::default()
        )),
        [("www-authenticate", "Bearer error=\"invalid_request\"")]
    );
    assert_eq!(
        fields_of(&problem_of_own(
            OwnFailure::Scheme,
            "x",
            &OwnProblemOptions {
                challenge: Some("Bearer realm=\"bead\"".to_owned()),
            }
        )),
        [(
            "www-authenticate",
            "Bearer realm=\"bead\", error=\"invalid_request\""
        )]
    );
    assert_eq!(
        problem_of_own(OwnFailure::Jwt, "x", &OwnProblemOptions::default()).status,
        431
    );
    assert_eq!(
        problem_of_refusal(404, "no route").body,
        "{\"detail\":\"no route\",\"status\":404,\"title\":\"Not Found\",\"type\":\"about:blank\"}"
    );
}

#[test]
fn writes_payload_invalid_s_violations_as_errors_each_pointer_by_json_names() {
    let everything = NamedForm {
        message: "Everything",
    };
    let whole = route("/v1/{a_string}", "*");
    let lines = [
        r#"{"fieldPath":"labels[\"a/b~c dé\"]","forKey":true,"ruleId":"string.min_len","bounds":{"min_len":"2"}}"#,
        r#"{"fieldPath":"inners[1].name","message":"short","ruleId":"string.min_len"}"#,
        r#"{"fieldPath":"by_id[-1]","message":"short","ruleId":"string.min_len"}"#,
        r#"{"fieldPath":"custom_named","message":"short","ruleId":"string.min_len"}"#,
        r#"{"fieldPath":"labels[\"kk\"...]","message":"cut","ruleId":"int32.gt"}"#,
        r#"{"fieldPath":"choice","message":"one","ruleId":"required"}"#,
        r#"{"message":"one of a or b","ruleId":"message.oneof"}"#,
        r#"{"more":2}"#,
    ];

    assert_eq!(
        invalid(
            &lines.join("\n"),
            Some(ProblemRoute {
                form: &everything,
                route: &whole,
            })
        ),
        json!({
            "code": 52,
            "errors": [
                {
                    "bounds": { "min_len": "2" },
                    "detail": "must be at least 2 characters",
                    "fieldPath": "labels[\"a/b~c dé\"]",
                    "forKey": true,
                    "pointer": "#/labels/a~1b~0c%20d%C3%A9",
                    "ruleId": "string.min_len",
                },
                {
                    "detail": "short",
                    "fieldPath": "inners[1].name",
                    "pointer": "#/inners/1/name",
                    "ruleId": "string.min_len",
                },
                { "detail": "short", "fieldPath": "by_id[-1]", "pointer": "#/byId/-1", "ruleId": "string.min_len" },
                {
                    "detail": "short",
                    "fieldPath": "custom_named",
                    "pointer": "#/renamed",
                    "ruleId": "string.min_len",
                },
                { "detail": "cut", "fieldPath": "labels[\"kk\"...]", "pointer": "#/labels", "ruleId": "int32.gt" },
                { "detail": "one", "fieldPath": "choice", "pointer": "#", "ruleId": "required" },
                { "detail": "one of a or b", "pointer": "#", "ruleId": "message.oneof" },
            ],
            "more": 2,
            "scope": "protocol",
            "status": 422,
            "title": "PAYLOAD_INVALID",
            "type": format!("{PROTOCOL_TYPES}PAYLOAD_INVALID"),
        })
    );

    // under a body of one field, a pointer from it, a variable's and the query's a parameter
    let update = NamedForm {
        message: "UpdateBookRequest",
    };
    let one_field = route("/v1/{book.name=books/*}", "book");
    let book = [
        r#"{"fieldPath":"book.title","message":"short","ruleId":"string.min_len"}"#,
        r#"{"fieldPath":"book.name","message":"no name","ruleId":"string.pattern"}"#,
        r#"{"fieldPath":"update_mask","message":"value is required","ruleId":"required"}"#,
        r#"{"message":"one of a or b","ruleId":"message.oneof"}"#,
        r#"{"stopped":true}"#,
    ];
    let problem = invalid(
        &book.join("\n"),
        Some(ProblemRoute {
            form: &update,
            route: &one_field,
        }),
    );
    let places = problem["errors"]
        .as_array()
        .expect("its errors")
        .iter()
        .map(|error| {
            (
                error.get("pointer").cloned(),
                error.get("parameter").cloned(),
            )
        })
        .collect::<Vec<_>>();

    assert_eq!(
        places,
        [
            (Some(json!("#/title")), None),
            (None, Some(json!("book.name"))),
            (None, Some(json!("updateMask"))),
            (None, None),
        ]
    );
    assert_eq!(problem["errors"][3]["detail"], json!("one of a or b"));
    assert_eq!(problem["stopped"], json!(true));
}

#[test]
fn places_a_violation_off_18_4_s_field_path_grammar_at_the_body_whole_or_nowhere_under_a_body_of_one_field_and_one_below_a_scalar_at_that_scalar()
 {
    let everything = NamedForm {
        message: "Everything",
    };
    let whole = route("/api/Transcoding/echo", "*");

    assert_eq!(
        invalid(
            &[
                violation_of("!bad"),
                violation_of("a_string[0]x"),
                violation_of("a_string.inner"),
            ]
            .join("\n"),
            Some(ProblemRoute {
                form: &everything,
                route: &whole,
            })
        )["errors"],
        json!([
            { "detail": "m", "fieldPath": "!bad", "pointer": "#", "ruleId": "string.min_len" },
            { "detail": "m", "fieldPath": "a_string[0]x", "pointer": "#", "ruleId": "string.min_len" },
            { "detail": "m", "fieldPath": "a_string.inner", "pointer": "#/aString", "ruleId": "string.min_len" },
        ])
    );

    let update = NamedForm {
        message: "UpdateBookRequest",
    };
    let one_field = route("/v1/books", "book");

    assert_eq!(
        invalid(
            &[violation_of("!bad"), violation_of("book.title[0]x")].join("\n"),
            Some(ProblemRoute {
                form: &update,
                route: &one_field,
            })
        )["errors"],
        json!([
            { "detail": "m", "fieldPath": "!bad", "ruleId": "string.min_len" },
            { "detail": "m", "fieldPath": "book.title[0]x", "ruleId": "string.min_len" },
        ])
    );

    // without its route, no violation is placed; without its message, none is told
    assert_eq!(
        invalid(r#"{"fieldPath":"a_string","ruleId":"x.y"}"#, None)["errors"],
        json!([{ "fieldPath": "a_string", "ruleId": "x.y" }])
    );
}

#[test]
fn answers_a_refusal_of_a_status_without_a_phrase_by_its_number_and_one_without_words_with_no_detail()
 {
    assert_eq!(
        problem_of_refusal(599, "").body,
        "{\"status\":599,\"title\":\"599\",\"type\":\"about:blank\"}"
    );
}
