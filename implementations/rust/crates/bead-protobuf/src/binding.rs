//! A request bound from its route's variables, its query and its body into one JSON value, then read
//! by Bead's mapping, so one reader judges every field wherever it came from (spec/transcoding.md
//! 4, `http.proto`'s rules alone), under the feature `transcoding`.

#[cfg(test)]
mod tests;

use std::sync::Arc;

use bead::internal::query_decode_of;
use bead::{BindingOptions, MessageFormError, ProgrammerError, RequestPlace};
use buffa_descriptor::reflect::{DynamicMessage, Value};
use buffa_descriptor::{
    DescriptorPool, FieldDescriptor, FieldKind, MessageDescriptor, MessageIndex, ScalarType,
    SingularKind,
};
use bytes::Bytes;

use crate::json_form::text::is_integer_text;
use crate::json_form::{
    JsonForm, MessageJsonForm, Node, Refusal, Token, cut_of, encoded, field_named, is_in_oneof,
    is_wrapper, pointer_of, put, read_draft, read_message, read_text,
};
use crate::records::ProtoSchema;

const UPDATE_MASK: &str = "update_mask";
const FIELD_MASK: &str = "google.protobuf.FieldMask";

/// A request bound from its route, then read by Bead's mapping (transcoding 4): the binding a
/// [`JsonForm`]'s message forms bind by, which a gateway reaches through
/// [`MessageForm::bind`](bead::MessageForm::bind).
#[derive(Debug, Clone)]
pub struct HttpBinding {
    form: JsonForm,
}

impl HttpBinding {
    /// The binding of `form`'s messages, an `Any` among a request naming a message of its pool.
    #[must_use]
    pub const fn new(form: JsonForm) -> Self {
        Self { form }
    }

    /// A request of `schema` bound from its route's variables, its query and its body, then read by
    /// Bead's mapping, encoded.
    ///
    /// # Errors
    ///
    /// [`MessageFormError::Form`] for what the binding or the mapping refuses, at its place in the
    /// request, which a gateway answers 400 `PAYLOAD_UNDECODABLE`; [`MessageFormError::Programmer`]
    /// for a variable that names no field.
    pub fn bind(
        &self,
        schema: &ProtoSchema,
        options: &BindingOptions<'_>,
    ) -> Result<Bytes, MessageFormError> {
        self.form.form_of(schema.clone()).bind(options)
    }
}

// the well-known types whose JSON is a string a query parameter carries whole (4.3.2)
fn is_string_form(full_name: &str) -> bool {
    matches!(
        full_name,
        "google.protobuf.Duration" | "google.protobuf.FieldMask" | "google.protobuf.Timestamp"
    )
}

fn is_well_known(message: &MessageDescriptor) -> bool {
    message.full_name().starts_with("google.protobuf.")
}

fn singular_message(field: &FieldDescriptor) -> Option<MessageIndex> {
    match field.kind() {
        FieldKind::Singular(SingularKind::Message(index)) => Some(index),
        FieldKind::Singular(SingularKind::Scalar(_) | SingularKind::Enum(_))
        | FieldKind::List(_)
        | FieldKind::Map { .. } => None,
    }
}

/// A scalar's text made the JSON Bead's mapping reads of it (4.2): a string's a string; a number's
/// a string, which its reading reads as a number given so; a `bool`'s its word where it is one; an
/// enum's a number where it is an integer, a string otherwise; `bytes`' a string of base64.
fn scalar_node_of(text: &str, kind: SingularKind) -> Node {
    match kind {
        SingularKind::Enum(_) if is_integer_text(text) => Node::Number {
            text: text.to_owned(),
            value: text.parse::<f64>().unwrap_or_default(),
        },
        SingularKind::Scalar(ScalarType::Bool) if text == "true" || text == "false" => {
            Node::Bool(text == "true")
        }
        SingularKind::Enum(_) | SingularKind::Scalar(_) | SingularKind::Message(_) => {
            Node::String(text.to_owned())
        }
    }
}

/// A value's text made the JSON of `field`: a scalar's, or a well-known type's whose JSON is a
/// string.
fn value_node_of(pool: &DescriptorPool, (text, field): (&str, &FieldDescriptor)) -> Node {
    let kind = match field.kind() {
        FieldKind::Singular(kind) | FieldKind::List(kind) | FieldKind::Map { value: kind, .. } => {
            kind
        }
    };

    if let FieldKind::Singular(SingularKind::Message(index)) = field.kind() {
        let message = pool.message(index);

        if is_wrapper(message)
            && let Some(FieldKind::Singular(inner)) =
                message.fields().first().map(FieldDescriptor::kind)
        {
            return scalar_node_of(text, inner);
        }

        return Node::String(text.to_owned());
    }

    scalar_node_of(text, kind)
}

/// The fields a variable's field path names, by proto names, through singular message fields.
fn variable_path_of(
    pool: &DescriptorPool,
    (root, field_path): (MessageIndex, &str),
) -> Result<Vec<FieldDescriptor>, ProgrammerError> {
    let mut fields = Vec::new();
    let mut message = Some(root);

    for name in field_path.split('.') {
        let field = message
            .and_then(|index| {
                pool.message(index)
                    .fields()
                    .iter()
                    .find(|field| field.name() == name)
            })
            .ok_or_else(|| {
                ProgrammerError::new(format!(
                    "{field_path} names no field of {}",
                    pool.message(root).full_name()
                ))
            })?;

        message = singular_message(field);
        fields.push(field.clone());
    }

    Ok(fields)
}

fn two_set(parameter: &str) -> Refusal {
    Refusal::new("a field that two of the request set")
        .placed(RequestPlace::Parameter(parameter.to_owned()))
}

/// What one of the request sets: the parameter that sets it, its path of fields, and its value.
struct Setting<'a> {
    parameter: &'a str,
    path: &'a [FieldDescriptor],
    value: Node,
}

/// Sets `value` at `path` of `draft`, each object on the way made a draft of its own; a field set
/// already, but to `null`, which sets nothing (5.2.2), or a message the body gave no object for,
/// refused at the parameter that sets it: one field, one value (4.1).
fn set_at(draft: &mut Vec<(String, Node)>, setting: Setting<'_>) -> Result<(), Refusal> {
    let Setting {
        parameter,
        path,
        value,
    } = setting;
    let Some((field, rest)) = path.split_first() else {
        return Ok(());
    };
    let held = draft
        .iter()
        .position(|(name, _)| name == field.name() || name == field.json_name());
    let is_set = held
        .and_then(|index| draft.get(index))
        .is_some_and(|(_, node)| !matches!(node, Node::Null));

    if rest.is_empty() {
        if is_set {
            return Err(two_set(parameter));
        }

        if let Some(index) = held {
            draft.remove(index);
        }

        draft.push((field.name().to_owned(), value));

        return Ok(());
    }

    if !is_set {
        let mut below = Vec::new();

        set_at(
            &mut below,
            Setting {
                parameter,
                path: rest,
                value,
            },
        )?;

        match held.and_then(|index| draft.get_mut(index)) {
            Some((_, node)) => *node = Node::Object(below),
            None => draft.push((field.name().to_owned(), Node::Object(below))),
        }

        return Ok(());
    }

    match held.and_then(|index| draft.get_mut(index)) {
        Some((_, Node::Object(below))) => set_at(
            below,
            Setting {
                parameter,
                path: rest,
                value,
            },
        ),
        Some(_) | None => Err(two_set(parameter)),
    }
}

/// The query's parameters, in order, as the form decoding reads them (4.3).
fn parameters_of(query: &str) -> Result<Vec<(String, String)>, Refusal> {
    query
        .split('&')
        .filter(|sequence| !sequence.is_empty())
        .map(|sequence| {
            let (name, value) = sequence.split_once('=').unwrap_or((sequence, ""));
            let decode = |text: &str| query_decode_of(&text.replace('+', " "));

            decode(name)
                .zip(decode(value))
                .ok_or_else(|| Refusal::new("a query whose bytes are not UTF-8"))
        })
        .collect()
}

/// The fields a parameter's name names, by JSON or proto names, through singular message fields.
fn parameter_path_of(
    pool: &DescriptorPool,
    (root, name): (MessageIndex, &str),
) -> Result<Vec<FieldDescriptor>, Refusal> {
    let mut fields = Vec::new();
    let mut message = Some(root);

    for segment in name.split('.') {
        let field = message
            .and_then(|index| field_named(pool.message(index), segment))
            .ok_or_else(|| {
                Refusal::new("a parameter no field path names")
                    .placed(RequestPlace::Parameter(cut_of(name)))
            })?;

        message = singular_message(field).filter(|index| !is_well_known(pool.message(*index)));
        fields.push(field.clone());
    }

    Ok(fields)
}

fn names_of(path: &[FieldDescriptor]) -> String {
    path.iter()
        .map(FieldDescriptor::name)
        .collect::<Vec<_>>()
        .join(".")
}

/// The JSON names of a path of fields, by `.`, as a query's parameter is placed (7.4, item 1).
fn json_names_of(path: &[FieldDescriptor]) -> String {
    path.iter()
        .map(FieldDescriptor::json_name)
        .collect::<Vec<_>>()
        .join(".")
}

/// Whether a place's tokens begin with a path of fields, by their JSON names.
fn is_within(tokens: &[Token], path: &[FieldDescriptor]) -> bool {
    path.iter().enumerate().all(|(index, field)| {
        tokens
            .get(index)
            .is_some_and(|token| !token.is_given && token.text == field.json_name())
    })
}

/// What a request's binding knows of where its fields came from.
struct Bound<'a> {
    body_field: Option<&'a FieldDescriptor>,
    queried: &'a [Vec<FieldDescriptor>],
    route_body: Option<&'a str>,
    variables: &'a [(String, Vec<FieldDescriptor>)],
}

/// Where the request carried the value its reading refused at `tokens` (7.4): a variable's field
/// path as its template writes it, or a query's by JSON names; or a pointer into its body, the
/// field a `body` names its root. A field left unset (5.2, step 4) is placed as a violation's field
/// is: a parameter by JSON names where its route's body is not where it lies, else the member the
/// body's object lacks.
fn place_of_reading(tokens: &[Token], (is_unset, bound): (bool, &Bound<'_>)) -> RequestPlace {
    if let Some((field_path, _)) = bound
        .variables
        .iter()
        .find(|(_, path)| is_within(tokens, path))
    {
        return RequestPlace::Parameter(field_path.clone());
    }

    if let Some(path) = bound.queried.iter().find(|path| is_within(tokens, path)) {
        return RequestPlace::Parameter(json_names_of(path));
    }

    let is_whole = bound.route_body == Some("*");
    let is_in_body = is_whole
        || bound.body_field.is_some_and(|field| {
            tokens
                .first()
                .is_some_and(|token| token.text == field.json_name())
        });

    if is_unset && !is_in_body {
        return RequestPlace::Parameter(
            tokens
                .iter()
                .map(|token| token.text.as_str())
                .collect::<Vec<_>>()
                .join("."),
        );
    }

    RequestPlace::Pointer(pointer_of(if is_whole {
        tokens
    } else {
        tokens.get(1..).unwrap_or_default()
    }))
}

/// A refusal of a reading placed where the request carried it.
fn placed(refused: Refusal, place: &dyn Fn(&[Token], bool) -> RequestPlace) -> Refusal {
    match refused.tokens() {
        Some(tokens) => {
            let at = place(tokens, refused.is_unset());

            refused.placed(at)
        }
        None => refused,
    }
}

/// A `PATCH`'s body, or an object of it: its message, its JSON, and the path its members' follow.
#[derive(Clone, Copy)]
struct MaskBody<'a> {
    index: MessageIndex,
    node: &'a Node,
    prefix: &'a str,
}

/// The paths of the members of a `PATCH`'s body (4.5): each by its field's proto name, into a
/// message's object that is no well-known type's, by its own path where it holds none.
fn mask_paths_of(pool: &DescriptorPool, body: MaskBody<'_>) -> Vec<String> {
    let MaskBody {
        index,
        node,
        prefix,
    } = body;
    let Node::Object(members) = node else {
        return vec![];
    };
    let message = pool.message(index);

    members
        .iter()
        .flat_map(|(name, value)| {
            let Some(field) = field_named(message, name) else {
                return vec![];
            };
            let path = format!("{prefix}{}", field.name());

            match (singular_message(field), value) {
                (Some(held), Node::Object(inner))
                    if !is_well_known(pool.message(held)) && !inner.is_empty() =>
                {
                    mask_paths_of(
                        pool,
                        MaskBody {
                            index: held,
                            node: value,
                            prefix: &format!("{path}."),
                        },
                    )
                }
                _ => vec![path],
            }
        })
        .collect()
}

fn form_error(refused: Refusal) -> MessageFormError {
    MessageFormError::Form(refused.into_error())
}

/// A request of `form`'s message bound from its route's variables, its query and its body, then
/// read by Bead's mapping (transcoding 4), encoded: a variable by its proto names; the query's
/// parameters by their field paths, each field by its JSON name or its proto name, when its route
/// has no body or one that names a field; the body whole or that field's; and a `PATCH`'s
/// `update_mask`, unset, the paths of the keys its body holds by proto names, set on the message
/// once it is read (4.5); then step 4 of 5.2, a required field unset.
#[expect(
    clippy::too_many_lines,
    reason = "each of transcoding 4's steps in its order, as the other sides hold them"
)]
pub(crate) fn bind(
    form: &MessageJsonForm,
    options: &BindingOptions<'_>,
) -> Result<Bytes, MessageFormError> {
    let schema = form.schema();
    let pool: &Arc<DescriptorPool> = schema.pool();
    let root = schema.message();
    let descriptor = pool.message(root);
    let route_body = options.route_body;
    let body = options
        .body
        .map(read_text)
        .transpose()
        .map_err(form_error)?;
    let body_field = route_body.filter(|body| *body != "*").and_then(|name| {
        descriptor
            .fields()
            .iter()
            .find(|field| field.name() == name)
    });
    let mut draft = Vec::new();

    if route_body == Some("*")
        && let Some(node) = &body
    {
        let Node::Object(members) = node else {
            // * not an object: the reading refuses it as the message's, with nothing bound beside it
            let message = read_message(schema, node).map_err(|refused| {
                form_error(placed(refused, &|tokens, _| {
                    RequestPlace::Pointer(pointer_of(tokens))
                }))
            })?;

            return encoded(&message);
        };

        draft.clone_from(members);
    }

    if let (Some(field), Some(node)) = (body_field, &body) {
        draft.push((field.name().to_owned(), node.clone()));
    }

    let mut variables = Vec::with_capacity(options.variables.len());

    for variable in options.variables {
        let path = variable_path_of(pool, (root, &variable.field_path))
            .map_err(MessageFormError::Programmer)?;

        variables.push((variable.field_path.clone(), path));
    }

    for ((field_path, path), variable) in variables.iter().zip(options.variables) {
        if let Some(last) = path.last() {
            let value = value_node_of(pool, (&variable.value, last));

            set_at(
                &mut draft,
                Setting {
                    parameter: field_path,
                    path,
                    value,
                },
            )
            .map_err(form_error)?;
        }
    }

    let parameters = options
        .query
        .map(parameters_of)
        .transpose()
        .map_err(form_error)?
        .unwrap_or_default();

    if route_body == Some("*") && !parameters.is_empty() {
        return Err(form_error(Refusal::new(
            "a query beside a body of the whole request",
        )));
    }

    let bound_names: Vec<String> = variables.iter().map(|(_, path)| names_of(path)).collect();
    // each repeated scalar's items, in their order, set once the query is read
    let mut repeated: Vec<(Vec<FieldDescriptor>, Vec<Node>)> = Vec::new();
    let mut named: Vec<String> = Vec::new();
    // the paths the query binds, where a refusal of their reading is placed
    let mut queried: Vec<Vec<FieldDescriptor>> = Vec::new();
    let mut is_mask_given = false;

    for (name, value) in &parameters {
        let path = parameter_path_of(pool, (root, name)).map_err(form_error)?;
        let Some(field) = path.last().cloned() else {
            continue;
        };
        let parameter = json_names_of(&path);
        let refused = |reason: &str| {
            form_error(Refusal::new(reason).placed(RequestPlace::Parameter(parameter.clone())))
        };
        let is_repeated_scalar = matches!(
            field.kind(),
            FieldKind::List(SingularKind::Scalar(_) | SingularKind::Enum(_))
        );

        if matches!(field.kind(), FieldKind::Map { .. })
            || (matches!(field.kind(), FieldKind::List(_)) && !is_repeated_scalar)
        {
            return Err(refused("a parameter of a map or a repeated message"));
        }

        if let Some(held) = singular_message(&field) {
            let message = pool.message(held);

            if !is_string_form(message.full_name()) && !is_wrapper(message) {
                return Err(refused("a parameter of a message"));
            }
        }

        let path_names = names_of(&path);
        let is_body_field = body_field.is_some_and(|body| {
            path.first()
                .is_some_and(|first| first.number() == body.number())
        });

        if bound_names.contains(&path_names) || is_body_field {
            return Err(refused("a parameter of a field the route binds otherwise"));
        }

        if named.contains(&path_names) && !is_repeated_scalar {
            return Err(refused("a field the query names twice"));
        }

        named.push(path_names.clone());
        is_mask_given |= path.len() == 1 && field.name() == UPDATE_MASK;

        let node = value_node_of(pool, (value, &field));

        if is_repeated_scalar {
            match repeated
                .iter_mut()
                .find(|(held, _)| names_of(held) == path_names)
            {
                Some((_, items)) => items.push(node),
                None => repeated.push((path.clone(), vec![node])),
            }
        } else {
            set_at(
                &mut draft,
                Setting {
                    parameter: &parameter,
                    path: &path,
                    value: node,
                },
            )
            .map_err(form_error)?;
        }

        queried.push(path);
    }

    for (path, items) in repeated {
        set_at(
            &mut draft,
            Setting {
                parameter: &json_names_of(&path),
                path: &path,
                value: Node::Array(items),
            },
        )
        .map_err(form_error)?;
    }

    let mask = descriptor
        .fields()
        .iter()
        .find(|field| field.name() == UPDATE_MASK);
    let derived = match (options.is_patch, body_field, &body, mask) {
        (Some(true), Some(field), Some(node), Some(mask))
            if !is_mask_given && !is_in_oneof(descriptor, mask) =>
        {
            match (singular_message(field), singular_message(mask)) {
                (Some(held), Some(mask_index))
                    if pool.message(mask_index).full_name() == FIELD_MASK =>
                {
                    Some((
                        mask.number(),
                        mask_index,
                        mask_paths_of(
                            pool,
                            MaskBody {
                                index: held,
                                node,
                                prefix: "",
                            },
                        ),
                    ))
                }
                _ => None,
            }
        }
        _ => None,
    };
    let bound = Bound {
        body_field,
        queried: &queried,
        route_body,
        variables: &variables,
    };
    let place = |tokens: &[Token], is_unset: bool| place_of_reading(tokens, (is_unset, &bound));
    let mut message = read_draft(schema, &Node::Object(draft))
        .map_err(|refused| form_error(placed(refused, &place)))?;

    // * a PATCH's update_mask, unset by its query and its body, the keys its body holds by proto
    // names, set on the message read: never read back through 5.4.3, which no `line_1` survives
    if let Some((mask_number, mask_index, paths)) = derived {
        let mut field_mask = DynamicMessage::new(Arc::clone(pool), mask_index);

        if let Some(paths_field) = pool.message(mask_index).field(1)
            && !paths.is_empty()
        {
            put(
                &mut field_mask,
                (
                    paths_field,
                    Value::List(paths.into_iter().map(Value::String).collect()),
                ),
            )
            .map_err(form_error)?;
        }

        if let Some(mask) = descriptor.field(mask_number) {
            put(&mut message, (mask, Value::Message(field_mask))).map_err(form_error)?;
        }
    }

    crate::json_form::judge_unset(&message, schema)
        .map_err(|refused| form_error(placed(refused, &place)))?;

    encoded(&message)
}
