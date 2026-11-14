//! `spec/transcoding.json` played against the Rust side's transcoding, a trial each entry, named
//! `<group>: <name>`, as the TypeScript and C# sides play the same file.
//!
//! Its templates through the core's; its readings and its writings through [`JsonForm`], Bead's
//! mapping of protobuf's JSON, over the messages beadc's table of the `Transcoding` service embeds;
//! its bindings through the core's templates and that table's forms; its failures and its events
//! through the core's problems and streams; and its exchanges through an [`HttpGateway`] of that
//! table on its own listener, over a real socket, in front of a server of the service, each request
//! on a socket of its own. A message read or bound is held to the entry's payload as the other
//! sides' players hold theirs: each set field by its value, a `float` and a `double` by their bits,
//! a map by its keys, its unknown fields as they came. Every refusal is a
//! [`MessageFormError::Form`], its reason the entry's, exactly, and its place the entry's: a
//! pointer, a parameter, or none. An exchange a row of the support matrix excuses this side from is
//! not played.

#![expect(
    clippy::arithmetic_side_effects,
    reason = "a response's offsets lie within the bytes it read"
)]

use core::fmt::Write as _;
use core::future::Future;
use core::num::NonZeroU16;
use core::time::Duration;
use std::collections::BTreeMap;
use std::process::ExitCode;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bead::internal::{
    Arose, CallFailure, EVENT_STREAM_MEDIA_TYPE, Encoding, EventHeartbeat, EventSink, EventStream,
    PROBLEM_MEDIA_TYPE, Problem, ProblemOptions, ProblemRoute, Taken, Template, VariableValue,
    is_tie, parse_template, problem_of_failure, problem_of_own, raw_data_of, raw_path_of,
    route_index_of, template_of, text_data_of, variables_of,
};
use bead::testing::wire::latin1_of;
use bead::testing::{
    Difference, SteppingClock, files, hexadecimal, instants, is_excused, patience, rest, spawn,
};
use bead::{
    BindingOptions, FailureScope, GatewayAuthorization, HttpGatewayOptions, HttpMethod, HttpRoute,
    HttpRouteTemplate, JsonFormError, MessageForm, MessageFormError, OwnFailure, OwnProblemOptions,
    RequestPlace, SharedClock,
};
use bead_interop::transcoding::generated::bead_http::{HttpRoutes, OPENAPI_DOCUMENT};
use bead_interop::transcoding::generated::messages::bead::transcoding::v1::Everything;
use bead_interop::transcoding::{TranscodingFixture, TranscodingFixtureOptions, gateway_options};
use bead_protobuf::{JsonForm, ProtoSchema};
use buffa::DecodeOptions;
use buffa_descriptor::reflect::DynamicMessage;
use buffa_descriptor::{DescriptorPool, MessageIndex, MethodDescriptor};
use libtest_mimic::{Arguments, Failed, Trial};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::tcp::OwnedWriteHalf;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ── The file ──────────────────────────────────────────────────────────────────

/// A body read as a message, and the payload it reads as, or why it is refused and where.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Reading {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    message: String,
    body: Option<String>,
    body_bytes: Option<String>,
    payload: Option<String>,
    refused: Option<String>,
    pointer: Option<String>,
    #[serde(rename = "upb")]
    _upb: Option<String>,
}

/// A payload written as a message, and the text it writes, or why it is refused.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Writing {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    message: String,
    payload: String,
    body: Option<String>,
    refused: Option<String>,
    #[serde(rename = "upb")]
    _upb: Option<String>,
}

/// A route's rule: its method, its template and its body.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Rule {
    method: String,
    template: String,
    body: Option<String>,
}

/// A request bound from its route's target and its body, and the payload it binds, or why it is
/// refused and where its request carried it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    procedure: String,
    route: Rule,
    target: String,
    body: Option<String>,
    payload: Option<String>,
    refused: Option<String>,
    parameter: Option<String>,
    pointer: Option<String>,
}

// ── The fixture ───────────────────────────────────────────────────────────────

// the service whose procedures the file's bindings name
const SERVICE: &str = "bead.transcoding.v1.TranscodingService";

// how deep a payload the file writes nests: one past the mapping's 100, for a message nested 100
// deep below the request
const EXPECTED_DEPTH: u32 = 101;

/// The pool beadc's table of `spec/transcoding.proto` embeds, its imports among it, read by
/// descriptors, and the form of its messages: the table's own.
#[derive(Debug)]
struct Fixture {
    pool: Arc<DescriptorPool>,
    form: JsonForm,
}

impl Fixture {
    fn new() -> Self {
        let pool = Arc::clone(ProtoSchema::of::<Everything>().pool());

        Self {
            form: JsonForm::new(Arc::clone(&pool)),
            pool,
        }
    }

    fn index_of(&self, name: &str) -> Result<MessageIndex, Failed> {
        self.pool
            .message_index(name)
            .ok_or_else(|| Failed::from(format!("{name} is no message of the fixture")))
    }

    fn form_of(&self, index: MessageIndex) -> Arc<dyn MessageForm> {
        self.form
            .form_of(ProtoSchema::new(Arc::clone(&self.pool), index))
    }

    // the request's message of the service's procedure `name`, as the file names it, in
    // lowerCamelCase
    fn request_of(&self, name: &str) -> Result<MessageIndex, Failed> {
        let mut letters = name.chars();
        let method: String = letters
            .next()
            .map(|first| first.to_ascii_uppercase())
            .into_iter()
            .chain(letters)
            .collect();

        self.pool
            .service_by_name(SERVICE)
            .and_then(|service| service.method(&method))
            .map(MethodDescriptor::input)
            .ok_or_else(|| Failed::from(format!("{name} is no procedure of {SERVICE}")))
    }

    // a payload as its message holds it, comparable byte for byte: read by its stock library and
    // written again, its fields by number, an implicit one at its default left out, a float by
    // its bits, a map by its keys, its unknown fields as they came
    fn comparable(&self, index: MessageIndex, payload: &[u8]) -> Result<Vec<u8>, Failed> {
        let options = DecodeOptions::new()
            .with_recursion_limit(EXPECTED_DEPTH)
            .with_unknown_field_limit(usize::MAX)
            .with_element_memory_limit(usize::MAX);

        DynamicMessage::decode_with_options(Arc::clone(&self.pool), index, payload, &options)
            .map(|message| message.encode_to_vec())
            .map_err(|error| Failed::from(format!("a payload its message does not read: {error}")))
    }
}

fn bytes_of(text: &str) -> Result<Vec<u8>, Failed> {
    hexadecimal::bytes_of(text).ok_or_else(|| Failed::from(format!("{text} is no hexadecimal")))
}

// ── Refusals ──────────────────────────────────────────────────────────────────

/// A refusal as an entry states it: its reason, and where it was met.
#[derive(Debug, PartialEq, Eq)]
struct Refused {
    reason: String,
    place: Option<RequestPlace>,
}

// the form's refusal; any other error fails the trial
fn refused_of(error: &MessageFormError) -> Result<Refused, Failed> {
    if let MessageFormError::Form(form) = error {
        Ok(Refused {
            reason: form.reason().to_owned(),
            place: form.place().cloned(),
        })
    } else {
        Err(Failed::from(format!("refused otherwise: {error:?}")))
    }
}

fn held(refused: &Refused, expected: &Refused) -> Result<(), Failed> {
    if refused.reason != expected.reason {
        return Err(Failed::from(format!(
            "refused for {:?}, where it is refused for {:?}",
            refused.reason, expected.reason
        )));
    }

    if refused.place != expected.place {
        return Err(Failed::from(format!(
            "placed at {:?}, not {:?}",
            refused.place, expected.place
        )));
    }

    Ok(())
}

// ── The groups ────────────────────────────────────────────────────────────────

fn read(fixture: &Fixture, entry: &Reading) -> Result<(), Failed> {
    let index = fixture.index_of(&entry.message)?;
    let body = match (&entry.body_bytes, &entry.body) {
        (Some(bytes), _) => bytes_of(bytes)?,
        (None, Some(text)) => text.clone().into_bytes(),
        (None, None) => Vec::new(),
    };
    let read = fixture.form_of(index).read(&body);

    match (&entry.payload, &entry.refused) {
        (Some(payload), None) => {
            let read = read.map_err(|error| Failed::from(format!("refused: {error:?}")))?;

            if fixture.comparable(index, &read)?
                == fixture.comparable(index, &bytes_of(payload)?)?
            {
                Ok(())
            } else {
                Err(Failed::from(format!(
                    "read {}",
                    hexadecimal::text_of(&read)
                )))
            }
        }
        (None, Some(reason)) => match read {
            Ok(read) => Err(Failed::from(format!(
                "read {}, where it is refused",
                hexadecimal::text_of(&read)
            ))),
            // * where its reading met it, `#` the body whole (7.4)
            Err(error) => held(
                &refused_of(&error)?,
                &Refused {
                    reason: reason.clone(),
                    place: entry.pointer.clone().map(RequestPlace::Pointer),
                },
            ),
        },
        _ => Err(Failed::from("an entry of a payload or of a refusal")),
    }
}

fn write(fixture: &Fixture, entry: &Writing) -> Result<(), Failed> {
    let index = fixture.index_of(&entry.message)?;
    // * read by its stock library first, as the gateway reads a result
    let written = fixture
        .form_of(index)
        .write(&bytes_of(&entry.payload)?, None);

    match (&entry.body, &entry.refused) {
        (Some(body), None) => {
            let written = written.map_err(|error| Failed::from(format!("refused: {error:?}")))?;

            if &written == body {
                Ok(())
            } else {
                Err(Failed::from(format!("wrote {written}")))
            }
        }
        (None, Some(reason)) => match written {
            Ok(written) => Err(Failed::from(format!(
                "wrote {written}, where it is refused"
            ))),
            Err(error) => {
                let refused = refused_of(&error)?;

                if &refused.reason == reason {
                    Ok(())
                } else {
                    Err(Failed::from(format!(
                        "refused for {:?}, where it is refused for {reason:?}",
                        refused.reason
                    )))
                }
            }
        },
        _ => Err(Failed::from("an entry of a body or of a refusal")),
    }
}

// the request bound as its gateway binds it: its variables decoded first, a value that does not
// decode refused at its own parameter
fn bound(fixture: &Fixture, entry: &Binding) -> Result<Result<Vec<u8>, MessageFormError>, Failed> {
    let index = fixture.request_of(&entry.procedure)?;
    let (path_text, query) = entry
        .target
        .split_once('?')
        .map_or((entry.target.as_str(), None), |(path, query)| {
            (path, Some(query))
        });
    let template = template_of(&entry.route.template)
        .map_err(|error| Failed::from(format!("{}: {error}", entry.route.template)))?;
    let path =
        raw_path_of(path_text).ok_or_else(|| Failed::from(format!("{path_text} is no path")))?;

    // * a target its template matches, as the other sides require it
    if route_index_of([&template], &path) != Some(0) {
        return Err(Failed::from(format!(
            "{} is not of {}",
            entry.target, entry.route.template
        )));
    }

    let variables: Vec<VariableValue> = match variables_of(&template, &path) {
        Ok(variables) => variables,
        Err(refusal) => {
            return Ok(Err(MessageFormError::Form(
                JsonFormError::new(refusal.reason).at(RequestPlace::Parameter(refusal.field_path)),
            )));
        }
    };
    let mut options = BindingOptions::new(&variables);

    options.body = entry.body.as_deref().map(str::as_bytes);
    options.is_patch = Some(entry.route.method == "PATCH");
    options.query = query;
    options.route_body = entry.route.body.as_deref();

    Ok(fixture
        .form_of(index)
        .bind(&options)
        .map(|payload| payload.to_vec()))
}

fn bind(fixture: &Fixture, entry: &Binding) -> Result<(), Failed> {
    let bound = bound(fixture, entry)?;

    match (&entry.payload, &entry.refused) {
        (Some(payload), None) => {
            let index = fixture.request_of(&entry.procedure)?;
            let bound = bound.map_err(|error| Failed::from(format!("refused: {error:?}")))?;

            if fixture.comparable(index, &bound)?
                == fixture.comparable(index, &bytes_of(payload)?)?
            {
                Ok(())
            } else {
                Err(Failed::from(format!(
                    "bound {}",
                    hexadecimal::text_of(&bound)
                )))
            }
        }
        (None, Some(reason)) => {
            // * where the request carried it (7.4)
            let place = match (&entry.parameter, &entry.pointer) {
                (Some(parameter), _) => Some(RequestPlace::Parameter(parameter.clone())),
                (None, Some(pointer)) => Some(RequestPlace::Pointer(pointer.clone())),
                (None, None) => None,
            };

            match bound {
                Ok(bound) => Err(Failed::from(format!(
                    "bound {}, where it is refused",
                    hexadecimal::text_of(&bound)
                ))),
                Err(error) => held(
                    &refused_of(&error)?,
                    &Refused {
                        reason: reason.clone(),
                        place,
                    },
                ),
            }
        }
        _ => Err(Failed::from("an entry of a payload or of a refusal")),
    }
}

// ── The comparison's own ──────────────────────────────────────────────────────

fn compares_payload_signed_zeros_nans_and_unknown_fields(fixture: &Fixture) -> Result<(), Failed> {
    let index = fixture.index_of("bead.transcoding.v1.Edges")?;
    let cases = [
        (
            "C1 01 00 00 00 00 00 00 00 80",
            "C1 01 00 00 00 00 00 00 00 00",
            false,
        ),
        ("3A 05 0D 00 00 00 80", "3A 05 0D 00 00 00 00", false),
        (
            "BA 01 0A C1 01 00 00 00 00 00 00 00 80",
            "BA 01 0A C1 01 00 00 00 00 00 00 00 00",
            false,
        ),
        (
            "C1 01 00 00 00 00 00 00 F8 7F",
            "C1 01 00 00 00 00 00 00 F8 7F",
            true,
        ),
        (
            "C1 01 00 00 00 00 00 00 F8 7F",
            "C1 01 01 00 00 00 00 00 F8 7F",
            false,
        ),
        (
            "5A 05 08 01 12 01 61 5A 05 08 02 12 01 62",
            "5A 05 08 02 12 01 62 5A 05 08 01 12 01 61",
            true,
        ),
        ("", "A0 06 01", false),
        ("A0 06 01", "A0 06 01", true),
        ("A0 06 01", "A0 06 02", false),
    ];

    for (one, other, expected) in cases {
        if (fixture.comparable(index, &bytes_of(one)?)?
            == fixture.comparable(index, &bytes_of(other)?)?)
            != expected
        {
            return Err(Failed::from(format!("{one} / {other}: not {expected}")));
        }
    }

    Ok(())
}

// ── Matching ─────────────────────────────────────────────────────────────────

/// A path a table of templates answers: the route that matches it, none for none, and its
/// variables and verb, or why its variables are refused.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TemplatePath {
    path: String,
    route: Option<usize>,
    variables: Option<BTreeMap<String, String>>,
    refused: Option<String>,
    verb: Option<String>,
}

/// Templates parsed, refused, tied or matched against paths.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Matching {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    templates: Vec<String>,
    paths: Option<Vec<TemplatePath>>,
    refused: Option<String>,
    tie: Option<bool>,
}

fn template(text: &str) -> Result<Template, Failed> {
    template_of(text).map_err(|error| Failed::from(format!("{text}: {error}")))
}

fn match_path(templates: &[Template], expected: &TemplatePath) -> Result<(), Failed> {
    let path = raw_path_of(&expected.path);
    let index = path
        .as_ref()
        .and_then(|path| route_index_of(templates.iter(), path));

    if index != expected.route {
        return Err(Failed::from(format!(
            "{}: route {index:?}, not {:?}",
            expected.path, expected.route
        )));
    }

    let (Some(template), Some(path)) = (index.and_then(|at| templates.get(at)), path) else {
        return Ok(());
    };

    match (variables_of(template, &path), &expected.refused) {
        (Ok(values), None) => {
            let read: BTreeMap<String, String> = values
                .into_iter()
                .map(|value| (value.field_path, value.value))
                .collect();

            if read != expected.variables.clone().unwrap_or_default() {
                return Err(Failed::from(format!(
                    "{}: variables {read:?}",
                    expected.path
                )));
            }

            if path.verb != expected.verb {
                return Err(Failed::from(format!(
                    "{}: verb {:?}",
                    expected.path, path.verb
                )));
            }

            Ok(())
        }
        (Err(refusal), Some(reason)) if refusal.reason == reason => Ok(()),
        (read, _) => Err(Failed::from(format!("{}: read {read:?}", expected.path))),
    }
}

fn match_templates(entry: &Matching) -> Result<(), Failed> {
    if let Some(tie) = entry.tie {
        let [one, other] = entry.templates.as_slice() else {
            return Err(Failed::from("a tie is of two templates"));
        };

        return if is_tie(&template(one)?, &template(other)?) == tie {
            Ok(())
        } else {
            Err(Failed::from(format!("a tie {}", !tie)))
        };
    }

    let Some(paths) = &entry.paths else {
        let first = entry
            .templates
            .first()
            .ok_or_else(|| Failed::from("a template refused"))?;
        let reason = parse_template(first).err();

        return if reason == entry.refused.as_deref() {
            Ok(())
        } else {
            Err(Failed::from(format!("refused for {reason:?}")))
        };
    };
    let templates = entry
        .templates
        .iter()
        .map(|text| template(text))
        .collect::<Result<Vec<_>, _>>()?;

    for expected in paths {
        match_path(&templates, expected)?;
    }

    Ok(())
}

// ── Failures ──────────────────────────────────────────────────────────────────

/// A failure as a gateway's client read it, or a failure of the gateway's own.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FailureOf {
    code: Option<u16>,
    arose: Option<String>,
    scope: Option<String>,
    detail: Option<String>,
    credential: Option<bool>,
    encoding: Option<String>,
    challenge: Option<String>,
    pointer: Option<String>,
    parameter: Option<String>,
    own: Option<String>,
}

/// A failure, and the problem it is answered with.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Failing {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    failure: FailureOf,
    status: u16,
    fields: BTreeMap<String, String>,
    problem: String,
    // none where not given, null where the definitions give none
    #[serde(default, deserialize_with = "nullable")]
    problem_types: Option<Value>,
    procedure: Option<String>,
    route: Option<Rule>,
}

// a member given null, told apart from one not given
fn nullable<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

fn method_of(name: &str) -> Result<HttpMethod, Failed> {
    match name {
        "DELETE" => Ok(HttpMethod::Delete),
        "GET" => Ok(HttpMethod::Get),
        "PATCH" => Ok(HttpMethod::Patch),
        "POST" => Ok(HttpMethod::Post),
        "PUT" => Ok(HttpMethod::Put),
        other => Err(Failed::from(format!("{other} is no route's method"))),
    }
}

fn own_of(name: &str) -> Result<OwnFailure, Failed> {
    match name {
        "closed" => Ok(OwnFailure::Closed),
        "failed" => Ok(OwnFailure::Failed),
        "jwt" => Ok(OwnFailure::Jwt),
        "scheme" => Ok(OwnFailure::Scheme),
        "timeout" => Ok(OwnFailure::Timeout),
        "unwritable" => Ok(OwnFailure::Unwritable),
        other => Err(Failed::from(format!(
            "{other} is no failure of the gateway's own"
        ))),
    }
}

fn call_failure_of(failure: &FailureOf) -> Result<CallFailure, Failed> {
    let arose = match failure.arose.as_deref().unwrap_or("server") {
        "answer" => Arose::Answer,
        "client" => Arose::Client,
        "gateway" => Arose::Gateway,
        "server" => Arose::Server,
        other => return Err(Failed::from(format!("{other} is nowhere a failure arises"))),
    };
    let scope = match failure.scope.as_deref().unwrap_or("protocol") {
        "application" => FailureScope::Application,
        "protocol" => FailureScope::Protocol,
        other => return Err(Failed::from(format!("{other} is no scope"))),
    };
    // * none is no proto encoding, as the other sides read it
    let encoding = match failure.encoding.as_deref() {
        Some("json") => Encoding::Json,
        Some("proto") => Encoding::Proto,
        Some("raw") => Encoding::Raw,
        None | Some("text") => Encoding::Text,
        Some(other) => return Err(Failed::from(format!("{other} is no encoding"))),
    };
    let place = match (&failure.parameter, &failure.pointer) {
        (Some(parameter), _) => Some(RequestPlace::Parameter(parameter.clone())),
        (None, Some(pointer)) => Some(RequestPlace::Pointer(pointer.clone())),
        (None, None) => None,
    };

    Ok(CallFailure {
        arose,
        code: NonZeroU16::new(failure.code.unwrap_or(0))
            .ok_or_else(|| Failed::from("a failure of a code"))?,
        scope,
        detail: failure.detail.clone().unwrap_or_default(),
        credential: failure.credential.unwrap_or(false),
        encoding,
        place,
    })
}

// the table's route of the procedure the file names
fn route_named(name: &str) -> Result<&'static HttpRoute, Failed> {
    let routes = HttpRoutes::get().map_err(|error| Failed::from(error.to_string()))?;

    routes
        .all
        .iter()
        .find(|route| route.procedure().procedure().procedure_name == name)
        .ok_or_else(|| Failed::from(format!("{name} is no route of the table")))
}

fn answer_failure(defaults: &Defaults, entry: &Failing) -> Result<(), Failed> {
    let failure = &entry.failure;
    let challenge = failure
        .challenge
        .clone()
        .unwrap_or_else(|| defaults.challenge.clone());
    let problem = if let Some(own) = &failure.own {
        let mut options = OwnProblemOptions::default();

        options.challenge = Some(challenge);
        problem_of_own(
            own_of(own)?,
            failure.detail.as_deref().unwrap_or(""),
            &options,
        )
    } else {
        let routes = HttpRoutes::get().map_err(|error| Failed::from(error.to_string()))?;
        let catalogue = routes
            .all
            .first()
            .ok_or_else(|| Failed::from("a table of routes"))?
            .failures();
        let problem_types = match &entry.problem_types {
            None => defaults.problem_types.clone(),
            Some(Value::String(types)) => Some(types.clone()),
            Some(_) => None,
        };
        let template = entry
            .route
            .as_ref()
            .map(|rule| -> Result<HttpRouteTemplate, Failed> {
                Ok(HttpRouteTemplate {
                    method: method_of(&rule.method)?,
                    template: rule.template.clone(),
                    body: rule.body.clone(),
                    response_body: None,
                })
            })
            .transpose()?;
        let form = entry
            .procedure
            .as_deref()
            .map(|name| -> Result<&Arc<dyn MessageForm>, Failed> {
                route_named(name)?
                    .request()
                    .form()
                    .ok_or_else(|| Failed::from(format!("{name}'s request is no message")))
            })
            .transpose()?;
        let mut options = ProblemOptions::default();

        options.catalogue = Some(catalogue);
        options.challenge = Some(&challenge);
        options.problem_types = problem_types.as_deref();
        options.route = form
            .zip(template.as_ref())
            .map(|(form, route)| ProblemRoute {
                form: form.as_ref(),
                route,
            });

        problem_of_failure(&call_failure_of(failure)?, &options)
    };
    let fields: BTreeMap<String, String> = problem
        .fields
        .iter()
        .map(|field| (field.name.to_owned(), field.value.clone()))
        .collect();

    if problem.status != entry.status {
        return Err(Failed::from(format!("answered {}", problem.status)));
    }

    if fields != entry.fields {
        return Err(Failed::from(format!("its fields {fields:?}")));
    }

    if problem.body != entry.problem {
        return Err(Failed::from(format!("its problem {}", problem.body)));
    }

    Ok(())
}

// ── Events ────────────────────────────────────────────────────────────────────

/// An event's data as the file writes it: a JSON text, a text, or bytes in hexadecimal.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum EventData {
    Json(String),
    Text { text: String },
    Raw { raw: String },
}

/// A failure that ends a stream: its status and its problem.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EventFailure {
    status: u16,
    problem: String,
}

/// A step of a stream: its result, a notification, its failure or a heartbeat's while.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EventStep {
    result: Option<EventData>,
    notification: Option<EventData>,
    failure: Option<EventFailure>,
    #[serde(rename = "heartbeat")]
    _heartbeat: Option<bool>,
}

/// A stream's steps, and the response they write.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Events {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    steps: Vec<EventStep>,
    status: u16,
    content_type: String,
    body: String,
}

fn data_of(data: &EventData) -> Result<String, Failed> {
    match data {
        EventData::Json(text) => Ok(text.clone()),
        EventData::Text { text } => {
            text_data_of(text.as_bytes()).ok_or_else(|| Failed::from("a text of no UTF-8"))
        }
        EventData::Raw { raw } => Ok(raw_data_of(&bytes_of(raw)?)),
    }
}

/// What a stream wrote: its response's status, its media type and its body.
#[derive(Debug, Default, PartialEq, Eq)]
struct Written {
    status: u16,
    content_type: String,
    body: String,
}

/// The response a stream is written on, held for the trial to read.
struct Sink(Arc<Mutex<Written>>);

impl EventSink for Sink {
    fn answer(&mut self, problem: Problem) {
        let mut written = locked(&self.0);

        written.status = problem.status;
        PROBLEM_MEDIA_TYPE.clone_into(&mut written.content_type);
        written.body = problem.body;
    }

    fn end(&mut self) {}

    fn open(&mut self) {
        let mut written = locked(&self.0);

        written.status = 200;
        EVENT_STREAM_MEDIA_TYPE.clone_into(&mut written.content_type);
    }

    fn write(&mut self, text: String) -> Taken {
        locked(&self.0).body.push_str(&text);

        Box::pin(async { true })
    }
}

async fn stream_events(entry: &Events, every: Duration) -> Result<(), Failed> {
    let clock = SteppingClock::new(instants::new_year());
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let written = Arc::new(Mutex::new(Written::default()));
    let stream = EventStream::new(
        Box::new(Sink(Arc::clone(&written))),
        EventHeartbeat {
            clock: shared,
            every,
        },
    );

    for step in &entry.steps {
        if let Some(data) = &step.result {
            stream
                .result(data_of(data)?)
                .map_err(|error| Failed::from(error.to_string()))?;
        } else if let Some(data) = &step.notification {
            // * its credit's settling is not waited on, as the other sides' players leave it
            drop(
                stream
                    .notification(data_of(data)?)
                    .map_err(|error| Failed::from(error.to_string()))?,
            );
        } else if let Some(failure) = &step.failure {
            stream.failure(Problem {
                status: failure.status,
                fields: Vec::new(),
                body: failure.problem.clone(),
            });
        } else {
            clock.advance(every).await;
        }
    }

    stream.close();

    let expected = Written {
        status: entry.status,
        content_type: entry.content_type.clone(),
        body: entry.body.clone(),
    };
    let written = core::mem::take(&mut *locked(&written));

    if written == expected {
        Ok(())
    } else {
        Err(Failed::from(format!("wrote {written:?}")))
    }
}

// ── Exchanges ─────────────────────────────────────────────────────────────────

/// A response's field as an exchange expects it: its value, or an entity tag's shape, captured
/// under a name; absent where the file gives null.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ExpectedField {
    Value(String),
    Shape {
        #[serde(rename = "shape")]
        _shape: String,
        capture: Option<String>,
    },
}

/// What a response is expected to be.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Expected {
    status: u16,
    fields: BTreeMap<String, Option<ExpectedField>>,
    body: Option<String>,
    body_bytes: Option<String>,
    stream: Option<String>,
}

/// A request's head, in exact octets, and its body in hexadecimal.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sent {
    head: String,
    body: Option<String>,
}

/// A step of an exchange: a request sent, a response read, a socket closed, or a wait on counts.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExchangeStep {
    on: Option<String>,
    send: Option<Sent>,
    expect: Option<Expected>,
    close: Option<String>,
    until: Option<BTreeMap<String, u64>>,
}

/// Requests sent to a gateway in front of the `Transcoding` service, each socket its own, and what
/// comes back on each.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Exchange {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    steps: Vec<ExchangeStep>,
    options: Option<Map<String, Value>>,
    #[serde(rename = "realTime")]
    _real_time: Option<bool>,
    #[serde(default)]
    differs: Vec<Difference>,
}

/// The file's defaults: a gateway's options by the gateway's names.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Defaults {
    hosts: Vec<String>,
    origins: Vec<String>,
    trusted_proxies: Vec<String>,
    unnamed_proxies: u64,
    authorization: String,
    challenge: String,
    timeout: u64,
    window: u64,
    heartbeat: u64,
    maximum_exchanges: u64,
    maximum_exchanges_per_address: u64,
    maximum_connections: u64,
    maximum_connections_per_address: u64,
    body_bytes_budget: u64,
    maximum_body_bytes: u64,
    headers_timeout: u64,
    minimum_body_bytes_per_second: u64,
    body_grace_period: u64,
    minimum_send_bytes_per_second: u64,
    send_grace_period: u64,
    maximum_unsent_bytes: u64,
    problem_types: Option<String>,
    document: bool,
}

// how long an exchange waits for what it expects, on the real clock
const PATIENCE: Duration = Duration::from_secs(5);

// how long a read rests before it looks again, whatever came
const LOOK: Duration = Duration::from_millis(50);

// how long a wait on counts rests between looks
const COUNT_LOOK: Duration = Duration::from_millis(10);

// what a socket is read by at once
const READ_BYTES: usize = 16_384;

const HEAD_END: &[u8] = b"\r\n\r\n";
const CRLF: &[u8] = b"\r\n";

// the gateway's options of the file's defaults and an exchange's own
fn gateway_of(
    defaults: &Map<String, Value>,
    options: Option<&Map<String, Value>>,
) -> Result<HttpGatewayOptions, Failed> {
    let mut merged = defaults.clone();

    merged.extend(options.cloned().unwrap_or_default());

    let given: Defaults = serde_json::from_value(Value::Object(merged))
        .map_err(|error| Failed::from(format!("an exchange's options: {error}")))?;
    let authorization = match given.authorization.as_str() {
        "elsewhere" => GatewayAuthorization::Elsewhere,
        "bearer-jwt" => GatewayAuthorization::BearerJwt,
        other => return Err(Failed::from(format!("{other} is no authorization"))),
    };

    let mut options = gateway_options().map_err(Failed::from)?;

    {
        options.hosts = Some(given.hosts);
        options.origins = Some(given.origins);
        options.trusted_proxies = Some(given.trusted_proxies);
        options.unnamed_proxies = Some(given.unnamed_proxies);
        options.authorization = Some(authorization);
        options.challenge = Some(given.challenge);
        options.timeout = Some(Duration::from_millis(given.timeout));
        options.window = Some(given.window);
        options.heartbeat = Some(Duration::from_millis(given.heartbeat));
        options.maximum_exchanges = Some(given.maximum_exchanges);
        options.maximum_exchanges_per_address = Some(given.maximum_exchanges_per_address);
        options.maximum_connections = Some(given.maximum_connections);
        options.maximum_connections_per_address = Some(given.maximum_connections_per_address);
        options.body_bytes_budget = Some(given.body_bytes_budget);
        options.maximum_body_bytes = Some(given.maximum_body_bytes);
        options.headers_timeout = Some(Duration::from_millis(given.headers_timeout));
        options.minimum_body_bytes_per_second = Some(given.minimum_body_bytes_per_second);
        options.body_grace_period = Some(Duration::from_millis(given.body_grace_period));
        options.minimum_send_bytes_per_second = Some(given.minimum_send_bytes_per_second);
        options.send_grace_period = Some(Duration::from_millis(given.send_grace_period));
        options.maximum_unsent_bytes = Some(given.maximum_unsent_bytes);
        options.problem_types = given.problem_types;

        if !given.document {
            options.document = None;
        }
    }

    Ok(options)
}

/// What came on a socket so far, and whether it ended.
#[derive(Debug, Default)]
struct Heard {
    bytes: Vec<u8>,
    is_ended: bool,
}

/// A socket of an exchange, and what came on it so far.
struct Peer {
    method: String,
    heard: Arc<Mutex<Heard>>,
    woken: Arc<Notify>,
    taken: usize,
    writer: Option<OwnedWriteHalf>,
    reader: Option<JoinHandle<()>>,
}

impl Peer {
    // a socket to the gateway, `request` written on it
    async fn open(port: u16, request: &[u8]) -> Result<Self, Failed> {
        let socket = TcpStream::connect(("127.0.0.1", port))
            .await
            .map_err(|error| Failed::from(format!("a socket to the gateway: {error}")))?;
        let (mut read, mut writer) = socket.into_split();
        let heard = Arc::new(Mutex::new(Heard::default()));
        let woken = Arc::new(Notify::new());

        writer
            .write_all(request)
            .await
            .map_err(|error| Failed::from(format!("a request written: {error}")))?;

        let reader = {
            let heard = Arc::clone(&heard);
            let woken = Arc::clone(&woken);

            spawn(async move {
                let mut buffer = vec![0; READ_BYTES];

                loop {
                    match read.read(&mut buffer).await {
                        Ok(0) | Err(_) => {
                            locked(&heard).is_ended = true;
                            woken.notify_one();
                            break;
                        }
                        Ok(count) => {
                            locked(&heard)
                                .bytes
                                .extend_from_slice(buffer.get(..count).unwrap_or_default());
                            woken.notify_one();
                        }
                    }
                }
            })
        };

        Ok(Self {
            method: String::from_utf8_lossy(
                request
                    .split(|&byte| byte == b' ')
                    .next()
                    .unwrap_or_default(),
            )
            .into_owned(),
            heard,
            woken,
            taken: 0,
            writer: Some(writer),
            reader: Some(reader),
        })
    }

    // a peer of no socket, whose bytes came whole and whose socket ended
    fn heard(method: &str, bytes: &[u8]) -> Self {
        Self {
            method: method.to_owned(),
            heard: Arc::new(Mutex::new(Heard {
                bytes: bytes.to_vec(),
                is_ended: true,
            })),
            woken: Arc::new(Notify::new()),
            taken: 0,
            writer: None,
            reader: None,
        }
    }

    fn close(&mut self) {
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }

        self.writer = None;
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.close();
    }
}

/// A response read: its status, its fields, each name in lower case, its body.
#[derive(Debug)]
struct Read {
    status: u16,
    fields: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn find(bytes: &[u8], (needle, from): (&[u8], usize)) -> Option<usize> {
    bytes
        .get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

/// A chunked body's bytes so far, whether its last chunk came, and how many bytes it took.
#[derive(Debug)]
struct Dechunked {
    body: Vec<u8>,
    is_whole: bool,
    taken: usize,
}

fn dechunk(bytes: &[u8]) -> Dechunked {
    let mut body = Vec::new();
    let mut at = 0;

    loop {
        let Some(end) = find(bytes, (CRLF, at)) else {
            return Dechunked {
                body,
                is_whole: false,
                taken: at,
            };
        };
        let size = core::str::from_utf8(bytes.get(at..end).unwrap_or_default())
            .ok()
            .and_then(|text| usize::from_str_radix(text.trim(), 16).ok())
            .unwrap_or(0);

        if size == 0 {
            let mut trailer = end + CRLF.len();

            loop {
                let Some(line_end) = find(bytes, (CRLF, trailer)) else {
                    return Dechunked {
                        body,
                        is_whole: false,
                        taken: at,
                    };
                };

                if line_end == trailer {
                    return Dechunked {
                        body,
                        is_whole: true,
                        taken: line_end + CRLF.len(),
                    };
                }

                trailer = line_end + CRLF.len();
            }
        }

        let data = end + CRLF.len();

        if bytes.len() < data + size + CRLF.len() {
            body.extend_from_slice(bytes.get(data..).unwrap_or_default());

            return Dechunked {
                body,
                is_whole: false,
                taken: at,
            };
        }

        body.extend_from_slice(bytes.get(data..data + size).unwrap_or_default());
        at = data + size + CRLF.len();
    }
}

// one response of what came, its bytes taken; none until it is whole, or for a stream until its
// body begins with `stream`
fn response_of(peer: &mut Peer, stream: Option<&str>) -> Result<Option<Read>, Failed> {
    let came = locked(&peer.heard);
    let bytes = came.bytes.get(peer.taken..).unwrap_or_default();
    let Some(at) = find(bytes, (HEAD_END, 0)) else {
        return if came.is_ended {
            Err(Failed::from("the socket ended before a response came"))
        } else {
            Ok(None)
        };
    };
    let head: String = bytes
        .get(..at)
        .unwrap_or_default()
        .iter()
        .map(|&byte| char::from(byte))
        .collect();
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|status| status.parse().ok())
        .ok_or_else(|| Failed::from(format!("no status line: {head}")))?;
    let mut fields = BTreeMap::<String, String>::new();

    for line in lines {
        let (name, value) = line.split_once(':').unwrap_or((line, ""));

        // * a field given twice is one, its values joined (RFC 9110 5.3), as the C# side reads it
        fields
            .entry(name.trim().to_ascii_lowercase())
            .and_modify(|before| {
                before.push_str(", ");
                before.push_str(value.trim());
            })
            .or_insert_with(|| value.trim().to_owned());
    }

    let start = at + HEAD_END.len();
    let rest = bytes.get(start..).unwrap_or_default();
    let length = fields
        .get("content-length")
        .and_then(|length| length.parse::<usize>().ok());
    let is_chunked = fields.get("transfer-encoding").map(String::as_str) == Some("chunked");

    if peer.method == "HEAD" || (100..200).contains(&status) || status == 204 || status == 304 {
        drop(came);
        peer.taken += start;

        return Ok(Some(Read {
            status,
            fields,
            body: Vec::new(),
        }));
    }

    if !is_chunked && let Some(length) = length.filter(|&length| rest.len() >= length) {
        let body = rest.get(..length).unwrap_or_default().to_vec();

        drop(came);
        peer.taken += start + length;

        return Ok(Some(Read {
            status,
            fields,
            body,
        }));
    }

    if is_chunked {
        let dechunked = dechunk(rest);
        let begins = stream.is_some_and(|stream| {
            dechunked.taken > 0 && String::from_utf8_lossy(&dechunked.body).starts_with(stream)
        });

        if dechunked.is_whole || begins {
            drop(came);
            peer.taken += start + dechunked.taken;

            return Ok(Some(Read {
                status,
                fields,
                body: dechunked.body,
            }));
        }
    }

    if length.is_none() && !is_chunked && came.is_ended {
        let body = rest.to_vec();
        let whole = bytes.len();

        drop(came);
        peer.taken += whole;

        return Ok(Some(Read {
            status,
            fields,
            body,
        }));
    }

    Ok(None)
}

/// What came on `peer` as one response: its head, then its body by its length, de-chunked to its
/// end, or to its socket's end; for a stream, as soon as its body begins with `stream`.
async fn read_on(peer: &mut Peer, stream: Option<&str>) -> Result<Read, Failed> {
    let woken = Arc::clone(&peer.woken);

    patience(PATIENCE, async {
        loop {
            if let Some(read) = response_of(peer, stream)? {
                return Ok(read);
            }

            drop(patience(LOOK, woken.notified()).await);
        }
    })
    .await
    .map_err(|_elapsed| Failed::from(format!("no whole response within {PATIENCE:?}")))?
}

fn held_to(
    read: &Read,
    (expected, captured): (&Expected, &mut BTreeMap<String, String>),
) -> Result<(), Failed> {
    if read.status != expected.status {
        return Err(Failed::from(format!(
            "answered {}, not {}",
            read.status, expected.status
        )));
    }

    let tag = etag_of(OPENAPI_DOCUMENT.as_bytes());

    for (name, value) in &expected.fields {
        let held = read.fields.get(&name.to_ascii_lowercase());
        let is_held = match value {
            None => held.is_none(),
            Some(ExpectedField::Value(value)) => held == Some(value),
            Some(ExpectedField::Shape { capture, .. }) => {
                if let (Some(capture), Some(held)) = (capture, held) {
                    captured.insert(capture.clone(), held.clone());
                }

                held == Some(&tag)
            }
        };

        if !is_held {
            return Err(Failed::from(format!("{name}: {held:?}, where {value:?}")));
        }
    }

    let is_body = if let Some(bytes) = &expected.body_bytes {
        read.body == bytes_of(bytes)?
    } else if let Some(stream) = &expected.stream {
        String::from_utf8_lossy(&read.body).starts_with(stream.as_str())
    } else {
        read.body
            == expected
                .body
                .as_deref()
                .unwrap_or("")
                .replace("{document}", OPENAPI_DOCUMENT)
                .into_bytes()
    };

    if is_body {
        Ok(())
    } else {
        Err(Failed::from(format!(
            "its body {}",
            String::from_utf8_lossy(&read.body)
        )))
    }
}

// a document's entity tag: its SHA-256, quoted
fn etag_of(document: &[u8]) -> String {
    let digest = Sha256::digest(document);
    let hexadecimal = digest.iter().fold(String::new(), |mut text, byte| {
        write!(text, "{byte:02x}").ok();
        text
    });

    format!("\"{hexadecimal}\"")
}

async fn until_counted(
    fixture: &TranscodingFixture,
    until: &BTreeMap<String, u64>,
) -> Result<(), Failed> {
    for (name, value) in until {
        patience(PATIENCE, async {
            while fixture.counts.by_name(name) != Some(*value) {
                rest(COUNT_LOOK).await;
            }
        })
        .await
        .map_err(|_elapsed| Failed::from(format!("{name} never reached {value}")))?;
    }

    Ok(())
}

async fn steps_of(fixture: &TranscodingFixture, entry: &Exchange) -> Result<(), Failed> {
    let mut peers = BTreeMap::<String, Peer>::new();
    let mut captured = BTreeMap::<String, String>::new();

    for step in &entry.steps {
        if let (Some(sent), Some(on)) = (&step.send, &step.on) {
            let mut head = sent
                .head
                .replace("{host}", &format!("127.0.0.1:{}", fixture.port));

            for (name, value) in &captured {
                head = head.replace(&format!("{{{name}}}"), value);
            }

            let mut request = latin1_of(&head).ok_or_else(|| Failed::from("a head of latin-1"))?;

            request.extend(bytes_of(sent.body.as_deref().unwrap_or(""))?);
            peers.insert(on.clone(), Peer::open(fixture.port, &request).await?);
        } else if let (Some(expected), Some(on)) = (&step.expect, &step.on) {
            let peer = peers
                .get_mut(on)
                .ok_or_else(|| Failed::from(format!("no exchange {on}")))?;
            let read = read_on(peer, expected.stream.as_deref()).await?;

            held_to(&read, (expected, &mut captured)).map_err(|failed| {
                Failed::from(format!("{on}: {}", failed.message().unwrap_or_default()))
            })?;
        } else if let Some(on) = &step.close {
            if let Some(peer) = peers.get_mut(on) {
                peer.close();
            }
        } else if let Some(until) = &step.until {
            until_counted(fixture, until).await?;
        }
    }

    Ok(())
}

async fn exchange(defaults: &Map<String, Value>, entry: &Exchange) -> Result<(), Failed> {
    let gateway = gateway_of(defaults, entry.options.as_ref())?;
    let fixture = TranscodingFixture::start(&TranscodingFixtureOptions::new(&gateway))
        .await
        .map_err(Failed::from)?;
    let played = steps_of(&fixture, entry).await;

    fixture
        .dispose()
        .await
        .map_err(|error| Failed::from(format!("disposed: {error}")))?;

    played
}

// both responses and the next head arrive together: no read may replay or eat its neighbour
async fn reads_consecutive_responses_from_their_own_bytes() -> Result<(), Failed> {
    let bytes = b"HTTP/1.1 200 OK\r\ncontent-length: 3\r\n\r\none\
HTTP/1.1 201 Created\r\ntransfer-encoding: chunked\r\n\r\n3\r\ntwo\r\n0\r\nx-end: yes\r\n\r\n\
HTTP/1.1 204 No Content\r\n\r\n";
    let mut peer = Peer::heard("GET", bytes);
    let first = read_on(&mut peer, None).await?;
    let second = read_on(&mut peer, None).await?;
    let third = read_on(&mut peer, None).await?;
    let read = [
        (first.status, first.body),
        (second.status, second.body),
        (third.status, third.body),
    ];
    let expected = [
        (200, b"one".to_vec()),
        (201, b"two".to_vec()),
        (204, Vec::new()),
    ];

    if read != expected {
        return Err(Failed::from(format!("read {read:?}")));
    }

    if peer.taken != bytes.len() {
        return Err(Failed::from(format!(
            "took {} of {}",
            peer.taken,
            bytes.len()
        )));
    }

    Ok(())
}

// ── The trials ────────────────────────────────────────────────────────────────

/// The file, the groups this player plays.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscodingFile {
    transcoding_version: String,
    defaults: Map<String, Value>,
    templates: Vec<Matching>,
    readings: Vec<Reading>,
    writings: Vec<Writing>,
    bindings: Vec<Binding>,
    failures: Vec<Failing>,
    events: Vec<Events>,
    exchanges: Vec<Exchange>,
}

// the companion's version, as its status line states it
fn companion_version() -> Result<String, Failed> {
    let text = files::text_of("transcoding.md").map_err(Failed::from)?;
    let after = text
        .split_once("**Version: ")
        .map(|(_, after)| after)
        .ok_or_else(|| Failed::from("transcoding.md states no version"))?;

    after
        .split_once("**")
        .map(|(version, _)| version.to_owned())
        .ok_or_else(|| Failed::from("transcoding.md states no version"))
}

fn on_runtime<F: Future<Output = Result<(), Failed>>>(
    threads: usize,
    future: F,
) -> Result<(), Failed> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(threads)
        .enable_all()
        .build()
        .map_err(|error| Failed::from(format!("a runtime: {error}")))?
        .block_on(future)
}

fn trials() -> Result<Vec<Trial>, String> {
    let file: TranscodingFile = files::read("transcoding.json")?;
    let fixture = Arc::new(Fixture::new());
    let defaults: Defaults = serde_json::from_value(Value::Object(file.defaults.clone()))
        .map_err(|error| format!("the file's defaults: {error}"))?;
    let defaults = Arc::new(defaults);
    let given = Arc::new(file.defaults);
    let version = file.transcoding_version;
    let mut trials = vec![
        Trial::test("its version is the companion's", move || {
            let companion = companion_version()?;

            if version == companion {
                Ok(())
            } else {
                Err(Failed::from(format!(
                    "{version}, where the companion is {companion}"
                )))
            }
        }),
        Trial::test("compares_payload_signed_zeros_nans_and_unknown_fields", {
            let fixture = Arc::clone(&fixture);
            move || compares_payload_signed_zeros_nans_and_unknown_fields(&fixture)
        }),
        Trial::test("reads_consecutive_responses_from_their_own_bytes", || {
            on_runtime(1, reads_consecutive_responses_from_their_own_bytes())
        }),
    ];

    for entry in file.templates {
        trials.push(Trial::test(
            format!("templates: {}", entry.name),
            move || match_templates(&entry),
        ));
    }

    for entry in file.readings {
        let fixture = Arc::clone(&fixture);

        trials.push(Trial::test(
            format!("readings: {}", entry.name),
            move || read(&fixture, &entry),
        ));
    }

    for entry in file.bindings {
        let fixture = Arc::clone(&fixture);

        trials.push(Trial::test(
            format!("bindings: {}", entry.name),
            move || bind(&fixture, &entry),
        ));
    }

    for entry in file.failures {
        let defaults = Arc::clone(&defaults);

        trials.push(Trial::test(
            format!("failures: {}", entry.name),
            move || answer_failure(&defaults, &entry),
        ));
    }

    for entry in file.events {
        let every = Duration::from_millis(defaults.heartbeat);

        trials.push(Trial::test(format!("events: {}", entry.name), move || {
            on_runtime(1, stream_events(&entry, every))
        }));
    }

    for entry in file.exchanges {
        // * an exchange a row of the support matrix excuses this side from is not played
        if is_excused(&entry.differs) {
            continue;
        }

        let given = Arc::clone(&given);

        trials.push(Trial::test(
            format!("exchanges: {}", entry.name),
            move || on_runtime(2, exchange(&given, &entry)),
        ));
    }

    for entry in file.writings {
        let fixture = Arc::clone(&fixture);

        trials.push(Trial::test(
            format!("writings: {}", entry.name),
            move || write(&fixture, &entry),
        ));
    }

    Ok(trials)
}

fn main() -> ExitCode {
    let arguments = Arguments::from_args();
    let trials = trials().unwrap_or_else(|error| {
        vec![Trial::test("reads transcoding.json", move || {
            Err(error.into())
        })]
    });

    libtest_mimic::run(&arguments, trials).exit_code()
}
