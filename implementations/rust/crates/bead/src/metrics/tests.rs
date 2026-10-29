//! The metrics registry's tests: a declaration refused as it is made, naming its address, its
//! names and its reason, and declaring nothing; names folded in ASCII alone; a service at a second
//! revision counted into its series; a duration held in whole microseconds; and calls counted
//! exactly as many threads make them at once.

use core::time::Duration;
use std::sync::Arc;

use serde_json::json;

use super::{MetricsRegistry, MetricsRegistryOptions};
use crate::client::ClientOptions;
use crate::constants::RouterSide;
use crate::identity::Procedure;
use crate::managers::service::{
    RequestDependencies, RequestOptions, ResolverDependencies, Response,
};
use crate::payloads::JsonCodec;
use crate::server::ServerOptions;
use crate::testing::pair::{Pair, PairOptions, echo};

// echo, of service 1
fn echo_of_1() -> Procedure {
    Procedure {
        service_id: 1,
        service_revision: 1,
        kind: None,
        ..echo()
    }
}

fn named((id, name): (u16, &str)) -> Procedure {
    Procedure {
        id,
        name: name.to_owned(),
        ..echo_of_1()
    }
}

fn registry_of(maximum_procedures: Option<usize>) -> MetricsRegistry {
    MetricsRegistry::new(&MetricsRegistryOptions { maximum_procedures }).expect("a registry")
}

// spec 16.7
#[test]
fn refuses_a_declaration_as_it_is_made_in_sentences_that_name_its_address_its_names_and_its_reason_declaring_nothing()
 {
    let registry = registry_of(Some(2));
    let server = registry.attach(RouterSide::Server);

    server
        .declare_resolver(&echo_of_1(), false)
        .expect("echo declared");
    server
        .declare_resolver(&named((2, "fail")), false)
        .expect("fail declared");

    let before = registry.exposition().text;
    let refusals = [
        server.declare_requester(&named((1, "other"))).map(drop),
        server
            .declare_resolver(&named((3, "echo")), false)
            .map(drop),
        server.declare_requester(&named((3, "ECHO"))).map(drop),
        server
            .declare_resolver(&named((3, "slow")), false)
            .map(drop),
    ]
    .map(|refused| refused.expect_err("refused").message().to_owned());

    assert_eq!(
        refusals,
        [
            "the metrics registry holds 1/1 as \"echo\", and is given \"other\": another name at its address",
            "the metrics registry holds \"echo\" at 1/1, and is given \"echo\" at 1/3: its name at another address",
            "the metrics registry holds \"echo\" at 1/1, and is given \"ECHO\" at 1/3: its name at another address",
            "the metrics registry's server families name 2 procedures at most, and 1/3 is one more: past the ceiling",
        ],
        "each refused, saying why"
    );
    assert_eq!(registry.exposition().text, before, "nothing declared");

    // refused, it declared nothing: its address is free for its own name, in other families
    server
        .declare_requester(&named((3, "slow")))
        .expect("slow declared");

    assert!(
        registry
            .exposition()
            .text
            .split('\n')
            .any(|line| line == "bead_client_call_started_total{service=\"1\",procedure=\"slow\",type=\"command\"} 0"),
        "slow among the calls the server makes"
    );
}

// spec 16.7
#[test]
fn refuses_a_name_its_service_holds_at_another_address_in_another_case_declaring_nothing() {
    let registry = registry_of(None);
    let server = registry.attach(RouterSide::Server);

    server
        .declare_resolver(&named((1, "getHTTPStatus")), false)
        .expect("declared");

    assert_eq!(
        server
            .declare_requester(&named((2, "getHttpStatus")))
            .expect_err("refused")
            .message(),
        "the metrics registry holds \"getHTTPStatus\" at 1/1, and is given \"getHttpStatus\" at 1/2: its name at another address",
        "said why"
    );

    // refused, it declared nothing: the address takes another name, and another service holds the
    // name
    server
        .declare_resolver(&named((2, "fail")), false)
        .expect("fail declared");
    server
        .declare_resolver(
            &Procedure {
                service_id: 2,
                ..named((1, "getHttpStatus"))
            },
            false,
        )
        .expect("another service's");

    let text = registry.exposition().text;
    let started: Vec<&str> = text
        .split('\n')
        .filter(|line| {
            line.starts_with("bead_server_call_started_total{service=\"")
                && !line.contains("_OTHER")
        })
        .collect();

    assert_eq!(
        started,
        [
            "bead_server_call_started_total{service=\"1\",procedure=\"getHTTPStatus\",type=\"request\"} 0",
            "bead_server_call_started_total{service=\"1\",procedure=\"fail\",type=\"request\"} 0",
            "bead_server_call_started_total{service=\"2\",procedure=\"getHttpStatus\",type=\"request\"} 0",
        ],
        "each declared once"
    );
}

// spec 16.7
#[test]
fn folds_ascii_letters_alone_as_it_compares_names_a_name_outside_ascii_its_own_and_takes_a_name_at_its_address_exactly()
 {
    let server = registry_of(None).attach(RouterSide::Server);

    for (id, name) in [
        (1, "caf\u{e9}"),
        (2, "caf\u{c9}"),
        (3, "key"),
        (4, "\u{212a}ey"),
    ] {
        server
            .declare_resolver(&named((id, name)), false)
            .expect("declared");
    }

    server
        .declare_requester(&named((1, "caf\u{e9}")))
        .expect("its name at its address");

    assert_eq!(
        server
            .declare_requester(&named((1, "CAF\u{e9}")))
            .expect_err("refused")
            .message(),
        "the metrics registry holds 1/1 as \"caf\u{e9}\", and is given \"CAF\u{e9}\": another name at its address",
        "a name at its address taken exactly"
    );
    assert_eq!(
        server
            .declare_resolver(&named((5, "KEY")), false)
            .expect_err("refused")
            .message(),
        "the metrics registry holds \"key\" at 1/3, and is given \"KEY\" at 1/5: its name at another address",
        "ASCII folded"
    );
}

// spec 16.7
#[test]
fn counts_a_service_declared_at_a_second_revision_into_its_series() {
    let registry = registry_of(None);
    let (first, second, client) = (
        registry.attach(RouterSide::Server),
        registry.attach(RouterSide::Server),
        registry.attach(RouterSide::Client),
    );

    // an address the registry holds, at another revision on another router, takes its series; a
    // third revision of the service, at an address of its own, a series of its own
    let echo = first
        .declare_resolver(&echo_of_1(), false)
        .expect("echo declared");
    let revised = second
        .declare_resolver(
            &Procedure {
                service_revision: 2,
                ..echo_of_1()
            },
            false,
        )
        .expect("echo at revision 2");
    let fail = client
        .declare_requester(&Procedure {
            service_revision: 3,
            ..named((2, "fail"))
        })
        .expect("fail declared");

    echo.calls.start();
    revised.calls.start();
    fail.start();

    let text = registry.exposition().text;
    let started: Vec<&str> = text
        .split('\n')
        .filter(|line| line.contains("_call_started_total{service=\"1\""))
        .collect();

    assert_eq!(
        started,
        [
            "bead_client_call_started_total{service=\"1\",procedure=\"fail\",type=\"request\"} 1",
            "bead_server_call_started_total{service=\"1\",procedure=\"echo\",type=\"request\"} 2",
        ],
        "both revisions in one series"
    );
}

// a platform's shape: a Duration counts nanoseconds, so a microsecond's fraction is its
// nanoseconds past a thousand, dropped
// debugging 11.4
#[test]
fn holds_a_duration_in_whole_microseconds_its_fraction_dropped_a_duration_s_nanoseconds_over_1_000()
{
    let registry = registry_of(None);
    let client = registry.attach(RouterSide::Client);
    let series = client
        .declare_requester(&echo_of_1())
        .expect("echo declared");

    for nanoseconds in [1_999, 99_999] {
        series.start();
        series.end(
            super::CallEnding::Result,
            crate::router::core::microseconds_of(Duration::from_nanos(nanoseconds)),
        );
    }

    let text = registry.exposition().text;

    // 1 µs and 99 µs: 100 µs, 0.0001 s, in all
    assert!(
        text.split('\n')
            .any(|line| line == "bead_client_call_duration_seconds_sum{service=\"1\",procedure=\"echo\",type=\"request\"} 0.0001"),
        "each held in whole microseconds: {text}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn counts_exactly_under_calls_made_at_once_from_many_threads() {
    const THREADS: usize = 8;
    const CALLS: usize = 25;

    let registry = MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let options = PairOptions {
        server: ServerOptions {
            metrics_registry: Some(registry.clone()),
            ..ServerOptions::default()
        },
        client: ClientOptions {
            metrics_registry: Some(registry.clone()),
            ..ClientOptions::default()
        },
    };
    let pair = Pair::connected((crate::testing::instants::new_year(), options))
        .await
        .expect("a pair connected");

    pair.server
        .services()
        .get_request_resolver(&echo(), ResolverDependencies::of(JsonCodec, JsonCodec))
        .expect("echo resolved")
        .on(Arc::new(|request, response: Response<JsonCodec>| {
            response.result(request.payload)
        }))
        .expect("echo registered");

    let asking = pair
        .client
        .services()
        .get_request(&echo(), RequestDependencies::of(JsonCodec, JsonCodec))
        .expect("echo asked");
    let threads: Vec<_> = (0..THREADS)
        .map(|thread| {
            let asking = asking.clone();

            tokio::spawn(async move {
                for _ in 0..CALLS {
                    asking
                        .call(json!(thread.to_string()), RequestOptions::default())
                        .expect("echo called")
                        .await
                        .expect("echo answered");
                }
            })
        })
        .collect();

    for thread in threads {
        thread.await.expect("its calls made");
    }

    // ! the server ends a call as its answer is handed to its transport, after the client may
    // have it: let both ends settle before reading what they counted
    pair.settle().await;

    let each = THREADS * CALLS;
    let labels = "service=\"2\",procedure=\"echo\",type=\"request\"";
    let mut counted: Vec<String> = registry
        .exposition()
        .text
        .split('\n')
        .filter(|line| {
            line.contains("procedure=\"echo\"")
                && (line.contains("_call_duration_seconds_count{")
                    || line.contains("_call_handled_total{")
                    || line.contains("_call_started_total{"))
                && !line.ends_with(" 0")
        })
        .map(str::to_owned)
        .collect();

    counted.sort();

    assert_eq!(
        counted,
        [
            format!("bead_client_call_duration_seconds_count{{{labels}}} {each}"),
            format!("bead_client_call_handled_total{{{labels},outcome=\"result\"}} {each}"),
            format!("bead_client_call_started_total{{{labels}}} {each}"),
            format!("bead_server_call_duration_seconds_count{{{labels}}} {each}"),
            format!("bead_server_call_handled_total{{{labels},outcome=\"result\"}} {each}"),
            format!("bead_server_call_started_total{{{labels}}} {each}"),
        ],
        "every call counted at both ends"
    );
}
