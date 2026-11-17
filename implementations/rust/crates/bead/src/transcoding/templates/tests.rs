use super::{
    RawPath, Segment, Template, Variable, VariableRefusal, is_tie, parse_template, raw_path_of,
    route_index_of, template_of, variables_of,
};

// `path` read raw, for a path the test knows matches some route
fn path_of(path: &str) -> RawPath {
    raw_path_of(path).expect("a path some route matches")
}

// the variables of a route's answer, by their field paths
type Values = Vec<(String, String)>;

// the route of `templates` that answers `path`, and its variables
fn answer_of(templates: &[&str], path: &str) -> (Option<usize>, Option<Values>) {
    let parsed: Vec<Template> = templates
        .iter()
        .map(|text| template_of(text).expect("a template"))
        .collect();
    let raw = raw_path_of(path);
    let index = raw.as_ref().and_then(|raw| route_index_of(&parsed, raw));
    let variables = index
        .and_then(|index| parsed.get(index))
        .zip(raw.as_ref())
        .and_then(|(template, raw)| variables_of(template, raw).ok())
        .map(|values| {
            values
                .into_iter()
                .map(|value| (value.field_path, value.value))
                .collect()
        });

    (index, variables)
}

fn values(pairs: &[(&str, &str)]) -> Values {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect()
}

fn literal(text: &str) -> Segment {
    Segment::Literal(text.to_owned())
}

#[test]
fn parses_a_template_as_http_proto_s_grammar_states_it_and_refuses_any_other() {
    let template =
        parse_template("/v1/{book.name=shelves/*/books/**}:archive").expect("a template");

    assert_eq!(
        template.segments,
        [
            literal("v1"),
            literal("shelves"),
            Segment::Star,
            literal("books"),
            Segment::Stars
        ],
        "its segments"
    );
    assert_eq!(
        template.variables,
        [Variable {
            field_path: "book.name".to_owned(),
            start: 1,
            end: 5,
            is_multi_segment: true,
        }],
        "its variable"
    );
    assert_eq!(template.verb.as_deref(), Some("archive"), "its verb");
    assert_eq!(
        parse_template("/v1/{name}").expect("a template").variables,
        [Variable {
            field_path: "name".to_owned(),
            start: 1,
            end: 2,
            is_multi_segment: false,
        }],
        "a single-segment variable"
    );

    for (text, reason) in [
        ("v1", "a template that does not begin with /"),
        ("/v1/**/x", "a ** that is not its last segment"),
        ("/v1/{a={b}}", "a variable within a variable"),
        ("/v1/{a=*", "a variable that does not close"),
        ("/v1/{1a}", "a variable that names no field path"),
        ("/v1/{}", "a variable that names no field path"),
        ("/v1/bo%6Fks", "a literal that is no segment"),
        ("/v1/a%20b", "a literal that is no segment"),
        ("/v1//b", "a literal that is no segment"),
        ("/v1:", "a verb that is no literal"),
    ] {
        assert_eq!(parse_template(text), Err(reason), "{text}");
    }

    let refusal = template_of("/v1/{").expect_err("no template");

    assert!(
        refusal.message().starts_with("/v1/{ is no template"),
        "a programmer's error: {}",
        refusal.message()
    );

    let tie = |one: &str, other: &str| {
        is_tie(
            &template_of(one).expect("a template"),
            &template_of(other).expect("a template"),
        )
    };

    assert!(tie("/v1/{a}/x", "/v1/{b=*}/x"), "one shape, two names");
    assert!(!tie("/v1/{a=*}", "/v1/{a=**}"), "a star and a double star");
    assert!(!tie("/v1/{a}:x", "/v1/{a}:y"), "two verbs");
}

#[test]
fn matches_a_raw_path_a_single_segment_decoded_whole_and_a_multi_segment_one_but_its_2f() {
    assert_eq!(
        answer_of(&["/v1/books/{name}"], "/v1/books/a%2Fb%20c"),
        (Some(0), Some(values(&[("name", "a/b c")]))),
        "a single segment"
    );
    assert_eq!(
        answer_of(
            &["/v1/{name=shelves/*/books/*}"],
            "/v1/shelves/a%2Fb/books/%2f%41"
        ),
        (
            Some(0),
            Some(values(&[("name", "shelves/a%2Fb/books/%2fA")]))
        ),
        "a multi-segment one"
    );
    assert_eq!(
        answer_of(&["/v1/{name=**}"], "/v1"),
        (Some(0), Some(values(&[("name", "")]))),
        "a double star of none"
    );

    // a literal its segment's text exactly, raw and case-sensitive
    assert_eq!(
        answer_of(&["/api/Hello/sayHello"], "/api/hello/sayHello").0,
        None,
        "case"
    );
    assert_eq!(answer_of(&["/v1/books"], "/v1/bo%6Fks").0, None, "raw");

    let template = template_of("/v1/books/{name}").expect("a template");

    for (path, reason) in [
        (
            "/v1/books/%ZZ",
            "a % that two hexadecimal digits do not follow",
        ),
        (
            "/v1/books/%4",
            "a % that two hexadecimal digits do not follow",
        ),
        ("/v1/books/%FF", "a value whose bytes are not UTF-8"),
        ("/v1/books/%C3%28", "a value whose bytes are not UTF-8"),
    ] {
        assert_eq!(
            variables_of(&template, &path_of(path)),
            Err(VariableRefusal {
                field_path: "name".to_owned(),
                reason,
            }),
            "{path}"
        );
    }
}

#[test]
fn matches_no_path_with_an_empty_or_a_dot_segment() {
    for path in [
        "/v1/books/..",
        "/v1/books/.",
        "/v1/books/%2E%2e",
        "/v1/books/%2e",
        "/v1/books/",
        "/v1//books",
        "/",
        "v1/books",
    ] {
        assert_eq!(raw_path_of(path), None, "{path}");
    }

    assert_eq!(
        raw_path_of("/v1/books/..."),
        Some(RawPath {
            segments: vec!["v1".to_owned(), "books".to_owned(), "...".to_owned()],
            verb: None,
        }),
        "three dots are a segment"
    );
}

#[test]
fn answers_by_a_literal_before_a_star_a_star_before_a_double_star_and_a_route_that_ends_before_a_double_star_of_none()
 {
    let books = ["/v1/books/{name}", "/v1/books/special"];

    assert_eq!(
        answer_of(&books, "/v1/books/special").0,
        Some(1),
        "the literal"
    );
    assert_eq!(answer_of(&books, "/v1/books/other").0, Some(0), "the star");

    let things = ["/v1/{name=things/**}", "/v1/things/{id}"];

    assert_eq!(
        answer_of(&things, "/v1/things/a"),
        (Some(1), Some(values(&[("id", "a")]))),
        "a star before a double star"
    );
    assert_eq!(
        answer_of(&things, "/v1/things/a/b").0,
        Some(0),
        "the double star"
    );

    let operations = ["/v1/{name=operations/**}", "/v1/{name=operations}"];

    assert_eq!(
        answer_of(&operations, "/v1/operations"),
        (Some(1), Some(values(&[("name", "operations")]))),
        "the one that ends where the path ends"
    );
    assert_eq!(
        answer_of(&operations, "/v1/operations/abc"),
        (Some(0), Some(values(&[("name", "operations/abc")]))),
        "the double star"
    );

    // and whatever their order: the one that ends where the path ends given first
    let reversed = ["/v1/{name=operations}", "/v1/{name=operations/**}"];

    assert_eq!(
        answer_of(&reversed, "/v1/operations"),
        (Some(0), Some(values(&[("name", "operations")]))),
        "reversed, the one that ends"
    );
    assert_eq!(
        answer_of(&reversed, "/v1/operations/abc").0,
        Some(1),
        "reversed, the rest"
    );
    assert_eq!(answer_of(&operations, "/v2/operations").0, None, "none");
    assert_eq!(
        answer_of(
            &["/api/{name=**}", "/api/Hello/sayHello"],
            "/api/Hello/sayHello"
        )
        .0,
        Some(1),
        "literals before a double star"
    );
}

#[test]
fn splits_the_verb_at_the_last_colon_its_last_segment_holds_unencoded() {
    assert_eq!(
        raw_path_of("/v1/books/a:b:archive"),
        Some(RawPath {
            segments: vec!["v1".to_owned(), "books".to_owned(), "a:b".to_owned()],
            verb: Some("archive".to_owned()),
        }),
        "the last colon"
    );
    assert_eq!(
        raw_path_of("/v1/books/a%3Aarchive"),
        Some(RawPath {
            segments: vec![
                "v1".to_owned(),
                "books".to_owned(),
                "a%3Aarchive".to_owned()
            ],
            verb: None,
        }),
        "an encoded colon"
    );

    let templates = ["/v1/{name=books/*}:archive", "/v1/{name=books/*}"];

    assert_eq!(
        answer_of(&templates, "/v1/books/a:b:archive"),
        (Some(0), Some(values(&[("name", "books/a:b")]))),
        "the verb's route"
    );
    assert_eq!(
        answer_of(&templates, "/v1/books/2%3Aarchive"),
        (Some(1), Some(values(&[("name", "books/2:archive")]))),
        "no verb"
    );
    assert_eq!(
        answer_of(&templates, "/v1/books/2:frobnicate").0,
        None,
        "another verb"
    );
    assert_eq!(
        answer_of(&["/v1/books/{name}"], "/v1/books/a:b").0,
        None,
        "a verb no route has"
    );
}

#[test]
fn answers_a_path_two_tying_templates_match_by_the_first_of_them() {
    let templates: Vec<Template> = ["/v1/{a}/x", "/v1/{b=*}/x"]
        .iter()
        .map(|text| template_of(text).expect("a template"))
        .collect();
    let reversed: Vec<Template> = templates.iter().rev().cloned().collect();

    assert_eq!(
        route_index_of(&templates, &path_of("/v1/q/x")),
        Some(0),
        "the first"
    );
    assert_eq!(
        route_index_of(&reversed, &path_of("/v1/q/x")),
        Some(0),
        "the first, reversed"
    );
}
