//! The grammar's selectors and the last valid filter kept for calls and envelopes.

use core::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use crate::constants::EnvelopeKind;
use crate::debug::{
    CallAsked, DebugDirection, DebugFilter, DebugFilterSource, DebugType, EnvelopeAsked,
    FilterKeeper, GivenFilter, parse_debug_filter,
};

fn spec(value: &str) -> DebugFilterSource {
    DebugFilterSource::Given(GivenFilter::Spec(value.to_owned()))
}

fn events() -> [CallAsked<'static>; 5] {
    [
        ("getStatus", DebugDirection::Tx, DebugType::Request),
        ("getStatus", DebugDirection::Rx, DebugType::Request),
        ("GetTime", DebugDirection::Rx, DebugType::Request),
        ("ping", DebugDirection::Tx, DebugType::Command),
        ("news", DebugDirection::Rx, DebugType::Notification),
    ]
    .map(|(procedure_name, direction, call_type)| CallAsked {
        direction,
        call_type,
        procedure_name,
    })
}

fn heard(source: DebugFilterSource) -> Vec<String> {
    let keeper = FilterKeeper::new(source).expect("a filter");
    events()
        .iter()
        .filter(|event| keeper.keeps_call(event))
        .map(|event| {
            format!(
                "{} {} {}",
                event.procedure_name,
                event.direction.as_str(),
                event.call_type.as_str()
            )
        })
        .collect()
}

#[test]
fn reads_words_parted_by_commas_or_white_space_selectors_names_to_keep_names_to_leave_out() {
    assert_eq!(
        parse_debug_filter(" d(rx),t(r|C)  get*, -getStatus\tping ").expect("a filter"),
        DebugFilter {
            directions: vec![DebugDirection::Rx],
            types: vec![DebugType::Request, DebugType::Command],
            include: vec!["get*".to_owned(), "ping".to_owned()],
            exclude: vec!["getStatus".to_owned()],
            kinds: Vec::new(),
        }
    );
    assert_eq!(
        parse_debug_filter("").expect("empty filter"),
        DebugFilter::default()
    );
}

#[test]
fn keeps_every_direction_and_every_type_its_selectors_name_however_many_there_are() {
    let filter = parse_debug_filter("d(rx), D(tx), t(n), t(c)").expect("a filter");
    assert_eq!(filter.directions, [DebugDirection::Rx, DebugDirection::Tx]);
    assert_eq!(filter.types, [DebugType::Notification, DebugType::Command]);
}

#[test]
fn refuses_a_direction_or_a_type_that_is_not_one_and_a_selector_that_names_none() {
    for spec in ["d(up)", "t(p)", "t(n|r|x)", "t(constructor)", "d()", "t()"] {
        parse_debug_filter(spec).expect_err("not a selector's value");
    }
    assert_eq!(
        parse_debug_filter("t(request|R)").expect("a filter").types,
        [DebugType::Request; 2]
    );
}

#[test]
fn refuses_a_filter_in_sentences_that_name_the_word_or_the_value_as_it_was_written_quoted_as_json()
{
    for (spec, sentence) in [
        (
            "ping E()",
            "a debug filter's selector names a value, not \"E()\"",
        ),
        (
            "d(rx|)",
            "a debug filter's selector leaves no value empty, not \"d(rx|)\"",
        ),
        (
            "d(UP)",
            "a debug filter takes a direction among rx, tx, not \"UP\"",
        ),
        (
            "t(r\\n)",
            "a debug filter takes a type among request, command, notification, r, c, n, not \"r\\\\n\"",
        ),
        (
            "e(\"fail\")",
            "a debug filter takes a kind among request, result, failure, notification, chunk, credit, cancel, not \"\\\"fail\\\"\"",
        ),
        (
            "d(rx,tx)",
            "a debug filter holds a parenthesis in a selector alone, d(…), t(…) or e(…), not \"d(rx\"",
        ),
        (
            "d(a\u{1})",
            "a debug filter takes a direction among rx, tx, not \"a\\u0001\"",
        ),
    ] {
        assert_eq!(
            parse_debug_filter(spec).expect_err("refused").to_string(),
            sentence
        );
    }
    // A surrogate alone is refused before it becomes a Rust string.
    String::from_utf16(&[0x64, 0x28, 0x61, 1, 0xd800, 0x29]).expect_err("no scalar value");
}

#[test]
fn keeps_every_event_without_a_filter_or_with_an_empty_one() {
    for source in [
        spec(""),
        DebugFilterSource::Given(GivenFilter::Filter(DebugFilter::default())),
        DebugFilterSource::Function(Arc::new(|| Ok(None))),
    ] {
        assert_eq!(heard(source).len(), events().len());
    }
}

#[test]
fn keeps_a_direction_a_type_and_the_names_that_match_without_regard_to_case() {
    assert_eq!(
        heard(spec("d(rx)")),
        [
            "getStatus rx request",
            "GetTime rx request",
            "news rx notification"
        ]
    );
    assert_eq!(
        heard(spec("t(c|n)")),
        ["ping tx command", "news rx notification"]
    );
    assert_eq!(
        heard(spec("get*")),
        [
            "getStatus tx request",
            "getStatus rx request",
            "GetTime rx request"
        ]
    );
    assert_eq!(
        heard(spec("d(rx), get*")),
        ["getStatus rx request", "GetTime rx request"]
    );
}

#[test]
fn leaves_out_what_an_exclusion_names_which_wins_over_what_is_kept() {
    assert_eq!(
        heard(spec("-getStatus")),
        [
            "GetTime rx request",
            "ping tx command",
            "news rx notification"
        ]
    );
    assert_eq!(heard(spec("get*, -getstatus")), ["GetTime rx request"]);
}

#[test]
fn takes_a_filter_given_whole_its_values_checked_once_as_it_is_given() {
    assert_eq!(
        heard(DebugFilterSource::Given(GivenFilter::Filter(DebugFilter {
            directions: vec![DebugDirection::Tx],
            exclude: vec!["p*".to_owned()],
            ..DebugFilter::default()
        }))),
        ["getStatus tx request"]
    );
    let consumer = crate::testing::surface::Consumer::new();
    consumer.accepts(
        "pub fn check(f: &mut bead::DebugFilter) { f.types = vec![bead::DebugType::Request]; }",
    );
    consumer.refuses(
        "pub fn check(f: &mut bead::DebugFilter) { f.types = vec![\"publisher\"]; }",
        ("E0308", "mismatched types"),
    );
}

#[test]
fn refuses_as_it_is_made_a_first_filter_that_does_not_hold() {
    FilterKeeper::new(spec("d(up)")).expect_err("invalid first filter");
    FilterKeeper::new(DebugFilterSource::Function(Arc::new(|| {
        Ok(Some(GivenFilter::Spec("t(x)".to_owned())))
    })))
    .expect_err("invalid first dynamic filter");
}

#[test]
fn asks_a_function_at_each_event_and_keeps_the_last_filter_that_held_when_one_does_not() {
    let asked = Arc::new(AtomicUsize::new(0));
    let asking = Arc::clone(&asked);
    let keeper = FilterKeeper::new(DebugFilterSource::Function(Arc::new(move || {
        let index = asking.fetch_add(1, Ordering::SeqCst);
        if index == 3 {
            return Err(std::io::Error::other("no spec").into());
        }
        Ok(Some(GivenFilter::Spec(
            ["d(rx)", "d(rx)", "d(up)", "d(tx)"][index.min(3)].to_owned(),
        )))
    })))
    .expect("a first filter");
    let heard = [
        DebugDirection::Rx,
        DebugDirection::Tx,
        DebugDirection::Rx,
        DebugDirection::Tx,
        DebugDirection::Tx,
    ]
    .into_iter()
    .filter(|&direction| {
        keeper.keeps_call(&CallAsked {
            direction,
            call_type: DebugType::Request,
            procedure_name: "echo",
        })
    })
    .collect::<Vec<_>>();
    assert_eq!(asked.load(Ordering::SeqCst), 6);
    assert_eq!(
        heard,
        [
            DebugDirection::Rx,
            DebugDirection::Rx,
            DebugDirection::Tx,
            DebugDirection::Tx
        ]
    );
}

#[test]
fn takes_a_function_that_gives_filters_as_they_are_and_a_filter_given_anew_alike_as_the_same() {
    let asked = Arc::new(AtomicUsize::new(0));
    let asking = Arc::clone(&asked);
    let keeper = FilterKeeper::new(DebugFilterSource::Function(Arc::new(move || {
        let asked = asking.fetch_add(1, Ordering::SeqCst).saturating_add(1);
        Ok(Some(GivenFilter::Filter(DebugFilter {
            directions: vec![if asked < 4 {
                DebugDirection::Rx
            } else {
                DebugDirection::Tx
            }],
            ..DebugFilter::default()
        })))
    })))
    .expect("a first filter");
    let heard = [
        DebugDirection::Rx,
        DebugDirection::Tx,
        DebugDirection::Rx,
        DebugDirection::Tx,
    ]
    .into_iter()
    .filter(|&direction| {
        keeper.keeps_call(&CallAsked {
            direction,
            call_type: DebugType::Request,
            procedure_name: "echo",
        })
    })
    .collect::<Vec<_>>();
    assert_eq!(heard, [DebugDirection::Rx, DebugDirection::Tx]);
    assert_eq!(asked.load(Ordering::SeqCst), 5);
}

fn envelopes() -> [EnvelopeAsked; 4] {
    [
        (EnvelopeKind::Request, DebugDirection::Tx),
        (EnvelopeKind::Result, DebugDirection::Rx),
        (EnvelopeKind::Failure, DebugDirection::Rx),
        (EnvelopeKind::Cancel, DebugDirection::Tx),
    ]
    .map(|(kind, direction)| EnvelopeAsked { direction, kind })
}

fn kept_envelopes(source: DebugFilterSource) -> Vec<(u8, DebugDirection)> {
    let keeper = FilterKeeper::new(source).expect("a filter");
    envelopes()
        .into_iter()
        .filter(|&event| keeper.keeps_envelope(event))
        .map(|event| (event.kind.byte(), event.direction))
        .collect()
}

#[test]
fn an_envelope_listener_keeps_a_direction_and_the_kinds_named_and_every_envelope_without_a_filter()
{
    assert_eq!(kept_envelopes(spec("")).len(), 4);
    assert_eq!(
        kept_envelopes(spec("d(rx)")),
        [(17, DebugDirection::Rx), (18, DebugDirection::Rx)]
    );
    assert_eq!(
        kept_envelopes(spec("e(request|cancel)")),
        [(16, DebugDirection::Tx), (22, DebugDirection::Tx)]
    );
    assert_eq!(
        kept_envelopes(DebugFilterSource::Given(GivenFilter::Filter(DebugFilter {
            directions: vec![DebugDirection::Rx],
            kinds: vec![EnvelopeKind::Failure],
            ..DebugFilter::default()
        }))),
        [(18, DebugDirection::Rx)]
    );
    assert_eq!(
        kept_envelopes(DebugFilterSource::Function(Arc::new(|| Ok(Some(
            GivenFilter::Filter(DebugFilter {
                directions: vec![DebugDirection::Tx],
                ..DebugFilter::default()
            })
        ))))),
        [(16, DebugDirection::Tx), (22, DebugDirection::Tx)]
    );
}

#[test]
fn an_envelope_listener_serves_the_same_spec_as_the_calls_the_names_and_the_types_of_calls_are_not_asked()
 {
    let spec_value = "d(rx), t(r), e(failure), getStatus";
    assert_eq!(heard(spec(spec_value)), ["getStatus rx request"]);
    assert_eq!(kept_envelopes(spec(spec_value)), [(18, DebugDirection::Rx)]);
    assert_eq!(kept_envelopes(spec("-*, t(c)")).len(), 4);
}

#[test]
fn an_envelope_listener_refuses_a_first_filter_that_does_not_hold_and_keeps_the_last_that_held_after()
 {
    FilterKeeper::new(spec("e(nothing)")).expect_err("invalid first filter");
    crate::testing::surface::Consumer::new().refuses(
        "pub fn check(f: &mut bead::DebugFilter) { f.kinds = vec![0x99]; }",
        ("E0308", "mismatched types"),
    );
    let asked = Arc::new(AtomicUsize::new(0));
    let asking = Arc::clone(&asked);
    let keeper = FilterKeeper::new(DebugFilterSource::Function(Arc::new(move || {
        let index = asking.fetch_add(1, Ordering::SeqCst);
        Ok(Some(GivenFilter::Spec(
            ["e(result)", "e(result)", "e(nothing)", "e(cancel)"][index.min(3)].to_owned(),
        )))
    })))
    .expect("a first filter");
    let heard = envelopes()
        .into_iter()
        .chain(envelopes())
        .filter(|&event| keeper.keeps_envelope(event))
        .map(|event| event.kind.byte())
        .collect::<Vec<_>>();
    assert_eq!(heard, [17, 22, 22]);
}
