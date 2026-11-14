use std::sync::{Arc, LazyLock};

use bead::internal::VariableValue;
use bead::{BindingOptions, MessageForm, MessageFormError, RequestPlace};
use buffa_descriptor::DescriptorPool;

use crate::json_form::JsonForm;
use crate::records::ProtoSchema;

// ── The fixture's pool ────────────────────────────────────────────────────────

static POOL: LazyLock<Arc<DescriptorPool>> = LazyLock::new(|| {
    Arc::new(
        DescriptorPool::decode(include_bytes!("../../proto/tests.binpb"))
            .expect("the tests' descriptor set reads"),
    )
});

static BASE: LazyLock<ProtoSchema> = LazyLock::new(|| {
    ProtoSchema::new(
        Arc::clone(&POOL),
        POOL.message_index(GET_BOOK)
            .expect("the pool holds GetBookRequest"),
    )
});

const GET_BOOK: &str = "bead.transcoding.v1.GetBookRequest";
const UPDATE_BOOK: &str = "bead.transcoding.v1.UpdateBookRequest";
const EVERYTHING: &str = "bead.transcoding.v1.Everything";

fn form_of(name: &str) -> Arc<dyn MessageForm> {
    let index = POOL
        .message_index(name)
        .unwrap_or_else(|| panic!("the pool holds {name}"));

    JsonForm::new(Arc::clone(&POOL)).form_of(BASE.at(index))
}

// what a request is bound from, as a test gives it
#[derive(Default)]
struct Request<'a> {
    body: Option<&'a str>,
    is_patch: bool,
    query: Option<&'a str>,
    route_body: Option<&'a str>,
    variables: &'a [(&'a str, &'a str)],
}

// the request `name` binds, written back in Bead's proto JSON form
fn bind(name: &str, request: &Request<'_>) -> Result<String, MessageFormError> {
    let variables: Vec<VariableValue> = request
        .variables
        .iter()
        .map(|(field_path, value)| VariableValue {
            field_path: (*field_path).to_owned(),
            value: (*value).to_owned(),
        })
        .collect();
    let mut options = BindingOptions::new(&variables);

    options.body = request.body.map(str::as_bytes);
    options.is_patch = Some(request.is_patch);
    options.query = request.query;
    options.route_body = request.route_body;

    let form = form_of(name);
    let payload = form.bind(&options)?;

    form.write(&payload, None)
}

fn bound(name: &str, request: &Request<'_>) -> String {
    bind(name, request).unwrap_or_else(|error| panic!("a request binds: {error}"))
}

// why the binding refuses, in the words of transcoding 4 and 5, and where
fn refusal_of(name: &str, request: &Request<'_>) -> Option<(String, Option<RequestPlace>)> {
    match bind(name, request) {
        Ok(_) => None,
        Err(MessageFormError::Form(error)) => {
            Some((error.reason().to_owned(), error.place().cloned()))
        }
        Err(error) => panic!("refused otherwise: {error}"),
    }
}

fn reason_of(name: &str, request: &Request<'_>) -> Option<String> {
    refusal_of(name, request).map(|(reason, _)| reason)
}

// why binding `query` to `getBook`'s default `GET` is refused
fn query_refusal(query: &str) -> Option<String> {
    reason_of(
        GET_BOOK,
        &Request {
            query: Some(query),
            ..Request::default()
        },
    )
}

fn update_book(body: &str, query: Option<&str>) -> Result<String, MessageFormError> {
    bind(
        UPDATE_BOOK,
        &Request {
            body: Some(body),
            is_patch: true,
            query,
            route_body: Some("book"),
            variables: &[("book.name", "shelves/1/books/2")],
        },
    )
}

// the update_mask a PATCH of `body` binds
fn mask_of(body: &str, query: Option<&str>) -> String {
    let written = update_book(body, query).unwrap_or_else(|error| panic!("{body} binds: {error}"));
    let value: serde_json::Value = serde_json::from_str(&written).expect("a JSON text");

    value["updateMask"].as_str().unwrap_or_default().to_owned()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
fn reads_raw_unicode_query_values_and_keeps_malformed_percent_escapes_literal() {
    for (given, value) in [
        ("é", "é"),
        ("😀", "😀"),
        ("A😀Z", "A😀Z"),
        ("%C3%A9", "é"),
        ("%F0%9F%98%80", "😀"),
        ("%", "%"),
        ("%F", "%F"),
        ("%G0", "%G0"),
        ("%0G", "%0G"),
        ("100%done", "100%done"),
    ] {
        assert_eq!(
            bound(
                GET_BOOK,
                &Request {
                    query: Some(&format!("tags={given}")),
                    variables: &[("name", "2")],
                    ..Request::default()
                }
            ),
            format!(
                "{{\"name\":\"2\",\"tags\":[{}]}}",
                serde_json::to_string(value).unwrap_or_default()
            ),
            "{given}"
        );
    }
}

#[test]
fn keeps_arbitrary_struct_members_out_of_an_inferred_patch_mask() {
    for body in [
        "{}",
        "{\"customKey\":1}",
        "{\"customKey\":1,\"other_key\":{\"nested\":false}}",
    ] {
        let written = bound(
            "bead.transcoding.tests.PatchStructRequest",
            &Request {
                body: Some(body),
                is_patch: true,
                route_body: Some("profile"),
                ..Request::default()
            },
        );
        let value: serde_json::Value = serde_json::from_str(&written).expect("a JSON text");
        let given: serde_json::Value = serde_json::from_str(body).expect("a JSON text");

        assert_eq!(value["profile"], given, "{body}: its Struct");
        assert_eq!(
            value["updateMask"],
            serde_json::json!(""),
            "{body}: its mask, empty"
        );
    }
}

#[test]
fn binds_a_path_variable_the_query_and_the_body_into_one_request_as_http_proto_s_rules_state() {
    assert_eq!(
        bound(
            GET_BOOK,
            &Request {
                query: Some(
                    "revision=3&tags=a+b&tags=c%2Bd&sub.name=x&sub.count=1e1&at=1970-01-01T00:00:01Z&color=2&flag=true"
                ),
                variables: &[("name", "shelves/1/books/2")],
                ..Request::default()
            }
        ),
        "{\"name\":\"shelves/1/books/2\",\"revision\":\"3\",\"sub\":{\"name\":\"x\",\"count\":10},\"tags\":[\"a b\",\"c+d\"],\"at\":\"1970-01-01T00:00:01Z\",\"color\":\"COLOR_GREEN\",\"flag\":true}"
    );
    // a body of the request whole, beside a variable
    assert_eq!(
        bound(
            GET_BOOK,
            &Request {
                body: Some("{\"revision\":\"4\",\"sub\":{\"name\":\"y\"}}"),
                route_body: Some("*"),
                variables: &[("name", "shelves/1/books/2")],
                ..Request::default()
            }
        ),
        "{\"name\":\"shelves/1/books/2\",\"revision\":\"4\",\"sub\":{\"name\":\"y\"}}"
    );
    // one field, one value; no query under a body of the request whole
    assert_eq!(
        reason_of(
            GET_BOOK,
            &Request {
                body: Some("{\"name\":\"x\"}"),
                route_body: Some("*"),
                variables: &[("name", "shelves/1/books/2")],
                ..Request::default()
            }
        )
        .as_deref(),
        Some("a field that two of the request set")
    );
    assert_eq!(
        reason_of(
            GET_BOOK,
            &Request {
                body: Some("{}"),
                query: Some("revision=1"),
                route_body: Some("*"),
                ..Request::default()
            }
        )
        .as_deref(),
        Some("a query beside a body of the whole request")
    );
    assert_eq!(
        reason_of(
            GET_BOOK,
            &Request {
                body: Some(""),
                route_body: Some("*"),
                ..Request::default()
            }
        )
        .as_deref(),
        Some("not JSON")
    );
}

#[test]
fn refuses_a_parameter_no_field_names_a_field_named_twice_and_a_repeated_message_or_a_map_in_the_query()
 {
    for (query, reason) in [
        ("nope=1", Some("a parameter no field path names")),
        ("inners.name=x", Some("a parameter no field path names")),
        (
            "revision=1&revision=2",
            Some("a field the query names twice"),
        ),
        (
            "sub.count=1&sub.count=2",
            Some("a field the query names twice"),
        ),
        (
            "inners=x",
            Some("a parameter of a map or a repeated message"),
        ),
        (
            "labels=x",
            Some("a parameter of a map or a repeated message"),
        ),
        ("sub=x", Some("a parameter of a message")),
        ("name=%FF", Some("a query whose bytes are not UTF-8")),
        (
            "revision=1e3",
            Some("an int64 string off -?(0|[1-9][0-9]*)"),
        ),
        ("flag=1", Some("no bool")),
        // a repeated scalar repeats, by either of its names; an empty sequence is skipped
        ("tags=a&&tags=b", None),
    ] {
        assert_eq!(query_refusal(query).as_deref(), reason, "{query}");
    }

    assert_eq!(
        bound(
            GET_BOOK,
            &Request {
                query: Some("name=100%"),
                ..Request::default()
            }
        ),
        "{\"name\":\"100%\"}"
    );
    assert_eq!(
        reason_of(
            GET_BOOK,
            &Request {
                query: Some("name=x"),
                variables: &[("name", "shelves/1/books/2")],
                ..Request::default()
            }
        )
        .as_deref(),
        Some("a parameter of a field the route binds otherwise")
    );
}

#[test]
fn fills_a_patch_s_update_mask_with_the_keys_its_body_holds() {
    assert_eq!(
        mask_of("{\"title\":\"New\",\"pages\":\"3\"}", None),
        "title,pages"
    );
    assert_eq!(
        mask_of(
            "{\"author\":{\"name\":\"a\",\"count\":1},\"title\":\"t\"}",
            None
        ),
        "author.name,author.count,title"
    );
    assert_eq!(mask_of("{\"author\":{}}", None), "author");
    assert_eq!(mask_of("{\"title\":null}", None), "title");
    assert_eq!(mask_of("{}", None), "");
    // the query's own, which the body's keys leave as it is
    assert_eq!(
        mask_of(
            "{\"title\":\"x\",\"pages\":\"1\"}",
            Some("updateMask=title")
        ),
        "title"
    );
    assert!(
        matches!(
            update_book("{\"name\":\"other\"}", None),
            Err(MessageFormError::Form(error)) if error.reason() == "a field that two of the request set"
        ),
        "a name the body and the variable both set"
    );

    let written = update_book("{\"title\":\"x\"}", None).expect("a PATCH binds");

    assert!(
        written.starts_with("{\"book\":{\"name\":\"shelves/1/books/2\""),
        "the variable's name kept: {written}"
    );
}

#[test]
fn binds_a_wrapper_and_a_well_known_type_of_a_string_form_from_a_parameter_never_a_struct_a_value_or_a_list_value()
 {
    assert_eq!(
        bound(
            EVERYTHING,
            &Request {
                query: Some(
                    "wrappedInt64=7&wrappedBool=true&took=1.5s&wrappedString=x&at=1970-01-01T00:00:01Z"
                ),
                ..Request::default()
            }
        ),
        "{\"at\":\"1970-01-01T00:00:01Z\",\"took\":\"1.500s\",\"wrappedInt64\":\"7\",\"wrappedString\":\"x\",\"wrappedBool\":true}"
    );

    for query in ["extra=x", "anyValue=x", "list=x"] {
        assert_eq!(
            reason_of(
                EVERYTHING,
                &Request {
                    query: Some(query),
                    ..Request::default()
                }
            )
            .as_deref(),
            Some("a parameter of a message"),
            "{query}"
        );
    }
}

#[test]
fn reads_a_parameter_without_its_equals_as_an_empty_value_and_an_enum_s_by_its_name_or_its_number()
{
    assert_eq!(
        bound(
            GET_BOOK,
            &Request {
                query: Some("name&revision=2&color=COLOR_GREEN"),
                ..Request::default()
            }
        ),
        "{\"revision\":\"2\",\"color\":\"COLOR_GREEN\"}"
    );
    assert_eq!(
        bound(
            GET_BOOK,
            &Request {
                query: Some("color=1"),
                ..Request::default()
            }
        ),
        "{\"color\":\"COLOR_RED\"}"
    );
    assert_eq!(query_refusal("flag").as_deref(), Some("no bool"));
    // * an empty sequence skipped, a name with no `=` an empty value, false a bool, a character
    // beyond the BMP percent-encoded
    assert_eq!(
        bound(
            GET_BOOK,
            &Request {
                query: Some("&flag=false&&tags&tags=%F0%9F%98%80&sub.name=a=b&"),
                variables: &[("name", "2")],
                ..Request::default()
            }
        ),
        "{\"name\":\"2\",\"sub\":{\"name\":\"a=b\"},\"tags\":[\"\",\"😀\"]}"
    );
    assert_eq!(
        bound(
            GET_BOOK,
            &Request {
                query: Some("flag=true&revision=-1"),
                variables: &[("name", "2")],
                ..Request::default()
            }
        ),
        "{\"name\":\"2\",\"revision\":\"-1\",\"flag\":true}"
    );
}

#[test]
fn refuses_a_body_that_is_no_object_as_the_request_whole_or_under_a_field_a_variable_sets_inside() {
    assert_eq!(
        refusal_of(
            GET_BOOK,
            &Request {
                body: Some("1"),
                route_body: Some("*"),
                variables: &[("name", "shelves/1/books/2")],
                ..Request::default()
            }
        ),
        Some((
            "a GetBookRequest that is no object".to_owned(),
            Some(RequestPlace::Pointer("#".to_owned()))
        ))
    );
    assert_eq!(
        reason_of(
            GET_BOOK,
            &Request {
                body: Some("1"),
                route_body: Some("sub"),
                variables: &[("sub.name", "x")],
                ..Request::default()
            }
        )
        .as_deref(),
        Some("a field that two of the request set")
    );
}

#[test]
fn fills_no_update_mask_path_of_a_patch_s_body_that_is_no_object_and_refuses_a_member_of_it_that_names_no_field()
 {
    assert_eq!(
        bound(
            UPDATE_BOOK,
            &Request {
                body: Some("null"),
                is_patch: true,
                route_body: Some("book"),
                ..Request::default()
            }
        ),
        "{\"updateMask\":\"\"}"
    );
    assert!(
        matches!(
            update_book("{\"title\":\"t\",\"nope\":1}", None),
            Err(MessageFormError::Form(error)) if error.reason() == "a key no field names"
        ),
        "a member of no field"
    );
}

#[test]
fn fills_a_patch_mask_from_snake_case_fields_through_nested_and_empty_message_bodies() {
    for body in [
        "{\"displayName\":\"Ada\",\"nestedProfile\":{\"displayName\":\"Grace\"},\"emptyProfile\":{}}",
        "{\"display_name\":\"Ada\",\"nested_profile\":{\"display_name\":\"Grace\"},\"empty_profile\":{}}",
    ] {
        assert_eq!(
            bound(
                "bead.transcoding.tests.PatchRequest",
                &Request {
                    body: Some(body),
                    is_patch: true,
                    route_body: Some("profile"),
                    ..Request::default()
                }
            ),
            "{\"profile\":{\"displayName\":\"Ada\",\"nestedProfile\":{\"displayName\":\"Grace\"},\"emptyProfile\":{}},\"updateMask\":\"displayName,nestedProfile.displayName,emptyProfile\"}",
            "{body}"
        );
    }
}

#[test]
fn throws_a_programmer_s_error_for_a_variable_that_names_no_field() {
    assert!(
        matches!(
            bind(
                GET_BOOK,
                &Request {
                    variables: &[("sub.nope", "x")],
                    ..Request::default()
                }
            ),
            Err(MessageFormError::Programmer(_))
        ),
        "a programmer's error, never a panic"
    );
}
