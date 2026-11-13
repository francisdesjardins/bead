//! A consumer of beadc's Rust goldens, compiled against the libraries this crate builds with: what
//! the compiler refuses of a server class, a client class and their options, each by its error's
//! code, the twin of the TypeScript target's type-check of `use-subsets.ts` and the C# side's
//! `SubsetsTests`; and what it reports of a consumer's uses of what beadc marks deprecated, the
//! twin of `typescript.test.ts`'s lint of `use-deprecated.ts` and the C# side's `ConsumerTests`.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use bead::testing::surface::{Compiled, Consumer, ConsumerOptions, Refusal};
use bead::{JsonCodec, RequestProps, ResolverError, Response};
use bead_goldens::subsets::services::{ShopServer, ShopServerOptions};
use serde_json::Value;

// the goldens, beside the side's folder
const GOLDENS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../builder/test/golden/rust"
);

// the libraries a consumer of the goldens names, each after what depends on it
const CRATES: [&str; 6] = [
    "bead_goldens",
    "bead_protobuf",
    "bead",
    "buffa",
    "buffa_descriptor",
    "buffa_types",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

// a consumer of the goldens as another crate names them, the output of `messages: external`'s
// include file where this crate's build script wrote it
fn consumer() -> Result<Consumer, String> {
    let mut options = ConsumerOptions::default();

    options.crates = Some(CRATES.iter().map(|name| (*name).to_owned()).collect());
    options.environment = Some(BTreeMap::from([(
        "OUT_DIR".to_owned(),
        env!("OUT_DIR").to_owned(),
    )]));
    options.probe = Some(
        "pub fn check(_: &bead_goldens::subsets::services::ShopServer, _: &bead::Server) {}"
            .to_owned(),
    );

    Consumer::of(&options)
}

// a diagnostic's member, as text
fn text_of<'a>(value: &'a Value, member: &str) -> &'a str {
    value
        .get(member)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

// what rustc reports of `fixture`, a consumer under tests/consumer that mounts a golden output
// whole: each `deprecated` diagnostic, at its file's name and its line; and what the fixture says
// it reports, the line after each `// reported:` comment
fn reports_of(fixture: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/consumer")
        .join(fixture);
    let source = fs::read_to_string(&path)
        .map_err(|error| format!("{}: {error}", path.display()))?
        .replace("\r\n", "\n");
    let compiled: Compiled =
        consumer()?.compiled(&source.replace("GOLDENS", &GOLDENS.replace('\\', "/")))?;
    let expected = source
        .lines()
        .enumerate()
        .filter_map(|(at, line)| {
            line.trim_start()
                .strip_prefix("// reported: ")
                .map(|said| format!("consumer.rs:{}: {said}", at.saturating_add(2)))
        })
        .collect();
    let is_deprecated = |diagnostic: &&Value| {
        diagnostic
            .get("code")
            .and_then(|code| code.get("code"))
            .and_then(Value::as_str)
            == Some("deprecated")
    };
    let reported = compiled
        .diagnostics
        .iter()
        .filter(is_deprecated)
        .map(|diagnostic| {
            let span = diagnostic
                .get("spans")
                .and_then(|spans| spans.get(0))
                .cloned()
                .unwrap_or_default();
            let name = Path::new(text_of(&span, "file_name"))
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_owned();

            format!(
                "{name}:{}: {}",
                span.get("line_start").and_then(Value::as_u64).unwrap_or(0),
                text_of(diagnostic, "message")
            )
        })
        .collect();
    if compiled.succeeded {
        Ok((expected, reported))
    } else {
        Err(compiled.stderr)
    }
}

async fn place_order(
    request: RequestProps<Value>,
    response: Response<JsonCodec>,
) -> Result<(), ResolverError> {
    drop((request, response));

    Ok(())
}

// ── The classes ───────────────────────────────────────────────────────────────

#[test]
fn a_server_class_refuses_a_resolver_of_a_procedure_it_does_not_serve() {
    let consumer = consumer().expect("a consumer of the goldens");

    // * no hook named: audit's, auditor, is a procedure called here, not served
    assert_eq!(consumer.takes("use bead_goldens::subsets::services::ShopServer;\npub fn check(server: &ShopServer) { let _ = server.on_place_order(|_, _| async { Ok(()) }); }"), Ok(()), "taken");
    assert_eq!(
        consumer.refusal(
            "use bead_goldens::subsets::services::ShopServer;\npub fn check(server: &ShopServer) { let _ = server.on_list_orders(|_, _| async { Ok(()) }); }",
            &Refusal {
                code: "E0599",
                detail: "on_list_orders",
            }
        ),
        Ok(()),
        "refused"
    );
}

#[test]
fn a_client_class_refuses_a_requester_of_a_procedure_it_does_not_call() {
    let consumer = consumer().expect("a consumer of the goldens");

    assert_eq!(consumer.takes("use bead_goldens::subsets::services::ShopClient;\npub fn check(client: &ShopClient) { let _ = &client.request().list_orders; }"), Ok(()), "taken");
    assert_eq!(
        consumer.refusal(
            "use bead_goldens::subsets::services::ShopClient;\npub fn check(client: &ShopClient) { let _ = &client.request().place_order; }",
            &Refusal {
                code: "E0609",
                detail: "place_order",
            }
        ),
        Ok(()),
        "refused"
    );
}

#[test]
fn refuses_on_of_a_command_on_the_server_side_and_of_a_request_on_the_client_side() {
    let consumer = consumer().expect("a consumer of the goldens");

    assert_eq!(consumer.takes("use bead_goldens::subsets::services::ShopClient;\npub fn check(client: &ShopClient) { let _ = client.on_refresh_catalogue(|_, _| async { Ok(()) }); }"), Ok(()), "taken");
    assert_eq!(
        consumer.refusal(
            "use bead_goldens::subsets::services::ShopServer;\npub fn check(server: &ShopServer) { let _ = server.on_refresh_catalogue(|_, _| async { Ok(()) }); }",
            &Refusal {
                code: "E0599",
                detail: "on_refresh_catalogue",
            }
        ),
        Ok(()),
        "refused"
    );
    assert_eq!(
        consumer.refusal(
            "use bead_goldens::subsets::services::ShopClient;\npub fn check(client: &ShopClient) { let _ = client.on_list_orders(|_, _| async { Ok(()) }); }",
            &Refusal {
                code: "E0599",
                detail: "on_list_orders",
            }
        ),
        Ok(()),
        "refused"
    );
}

#[test]
fn refuses_a_window_for_a_procedure_that_does_not_notify() {
    let consumer = consumer().expect("a consumer of the goldens");

    assert_eq!(consumer.takes("use bead_goldens::subsets::services::ShopWindows;\npub fn check() -> ShopWindows { let mut windows = ShopWindows::default(); windows.watch_orders = Some(1); windows }"), Ok(()), "taken");
    // * the form another crate writes, over its default
    assert_eq!(
        consumer.refusal(
            "use bead_goldens::subsets::services::ShopWindows;\npub fn check() -> ShopWindows { let mut windows = ShopWindows::default(); windows.place_order = Some(1); windows }",
            &Refusal {
                code: "E0609",
                detail: "place_order",
            }
        ),
        Ok(()),
        "refused"
    );
    // a literal, which a non-exhaustive struct of another crate refuses whatever it names
    assert_eq!(
        consumer.refusal(
            "use bead_goldens::subsets::services::ShopWindows;\npub fn check() -> ShopWindows { ShopWindows { watch_orders: Some(1), ..ShopWindows::default() } }",
            &Refusal {
                code: "E0639",
                detail: "non-exhaustive",
            }
        ),
        Ok(()),
        "refused"
    );
}

#[test]
fn refuses_options_without_admissions_where_a_procedure_names_a_hook() {
    let consumer = consumer().expect("a consumer of the goldens");

    assert_eq!(consumer.takes("use bead_goldens::deprecations::services::{InteropAdmissions, InteropServerOptions};\npub fn check(admissions: InteropAdmissions) -> InteropServerOptions { InteropServerOptions::new(admissions) }"), Ok(()), "taken");
    assert_eq!(
        consumer.refusal(
            "use bead_goldens::deprecations::services::InteropServerOptions;\npub fn check() -> InteropServerOptions { InteropServerOptions::new() }",
            &Refusal {
                code: "E0061",
                detail: "1 argument",
            }
        ),
        Ok(()),
        "refused"
    );
    assert_eq!(
        consumer.refusal(
            "use bead_goldens::deprecations::services::InteropServerOptions;\npub fn check() -> InteropServerOptions { InteropServerOptions::default() }",
            &Refusal {
                code: "E0599",
                detail: "default",
            }
        ),
        Ok(()),
        "refused"
    );
}

#[test]
fn takes_an_async_fn_as_a_resolver_by_its_name() {
    let server = ShopServer::new(&ShopServerOptions::default()).expect("its server");

    server.on_place_order(place_order).expect("registered");

    assert!(
        !server
            .procedures_without_resolver()
            .iter()
            .any(|procedure| procedure.procedure_name == "placeOrder"),
        "placeOrder has its resolver"
    );
}

// ── The marks ─────────────────────────────────────────────────────────────────

#[test]
fn a_mapped_member_keeps_its_descriptor_s_deprecated() {
    // * each command's requester, notifier, resolver and window of a deprecated descriptor is
    // reported at each use, and none of another
    let (expected, reported) = reports_of("use_mapped.rs").expect("its reports");

    assert!(!expected.is_empty(), "the fixture says what it reports");
    assert_eq!(reported, expected, "each mapped member's use");
}

#[test]
fn a_consumer_s_every_use_of_a_marked_declaration_is_reported_and_the_file_s_own_uses_are_not() {
    let (expected, reported) = reports_of("use_deprecated.rs").expect("its reports");

    assert!(!expected.is_empty(), "the fixture says what it reports");
    // the line under each that says what it is reported, and no other line, the goldens' none
    assert_eq!(reported, expected, "each use, and none of the output's own");
}
