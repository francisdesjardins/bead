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

#[test]
fn shares_notification_counts_across_repeated_declarations_and_keeps_another_procedure_separate() {
    let registry = registry_of(None);
    let first = registry
        .attach(RouterSide::Server)
        .declare_resolver(&echo_of_1(), true)
        .expect("a resolver")
        .notifying
        .expect("a notifying series");
    let second = registry
        .attach(RouterSide::Server)
        .declare_resolver(
            &Procedure {
                service_revision: 2,
                ..echo_of_1()
            },
            true,
        )
        .expect("a resolver at another revision")
        .notifying
        .expect("a notifying series");
    let other = registry
        .attach(RouterSide::Server)
        .declare_resolver(&named((2, "other")), true)
        .expect("another resolver")
        .notifying
        .expect("a notifying series");
    assert!(Arc::ptr_eq(&first.state, &second.state));
    assert_eq!(first.key, second.key);
    assert_ne!(first.key, other.key);
    first.sent();
    second.sent();
    second.failed();
    other.failed();
    assert_eq!(
        registry
            .exposition()
            .text
            .lines()
            .filter(|line| line.starts_with("bead_notifications_sent_total{"))
            .collect::<Vec<_>>(),
        [
            "bead_notifications_sent_total{service=\"1\",procedure=\"echo\",outcome=\"sent\"} 2",
            "bead_notifications_sent_total{service=\"1\",procedure=\"echo\",outcome=\"failed\"} 1",
            "bead_notifications_sent_total{service=\"1\",procedure=\"other\",outcome=\"sent\"} 0",
            "bead_notifications_sent_total{service=\"1\",procedure=\"other\",outcome=\"failed\"} 1",
        ]
    );
}

// One series in an exposition: its starts, sum of outcomes, histogram count and rising buckets.
fn one_reading(text: &str, family_and_labels: (&str, &str)) -> (u64, u64) {
    let (family, labels) = family_and_labels;
    let selected = |suffix: &str| -> Vec<u64> {
        let prefix = format!("bead_{family}_call_{suffix}{{{labels}");
        text.lines()
            .filter(|line| line.starts_with(&prefix))
            .map(|line| {
                line.rsplit_once(' ')
                    .expect("a sample")
                    .1
                    .parse()
                    .expect("a count")
            })
            .collect()
    };
    let started = selected("started_total");
    let handled = selected("handled_total").iter().sum();
    let count = selected("duration_seconds_count");
    let buckets = selected("duration_seconds_bucket");
    assert_eq!(started.len(), 1);
    assert_eq!(count, [handled]);
    assert!(started[0] >= handled);
    assert_eq!(buckets.last(), Some(&handled));
    assert!(buckets.windows(2).all(|pair| pair[0] <= pair[1]));
    (started[0], handled)
}

#[test]
fn writes_each_series_from_one_reading_of_its_counts() {
    use super::CallEnding;
    use core::sync::atomic::{AtomicBool, Ordering};

    let registry = registry_of(None);
    let metrics = registry.attach(RouterSide::Server);
    let echoing = metrics
        .declare_resolver(&echo(), false)
        .expect("echo")
        .calls;
    let failing = metrics
        .declare_resolver(
            &Procedure {
                id: 2,
                name: "fail".to_owned(),
                ..echo()
            },
            false,
        )
        .expect("fail")
        .calls;
    for series in [
        &echoing,
        &echoing,
        &echoing,
        &failing,
        metrics.other_server(),
    ] {
        series.start();
    }
    echoing.end(CallEnding::Result, 10);
    echoing.end(CallEnding::Application, 20);
    failing.end(CallEnding::Timeout, 30);
    let text = registry.exposition().text;
    for (labels, in_flight) in [
        ("service=\"2\",procedure=\"echo\",type=\"request\"", 1),
        ("service=\"2\",procedure=\"fail\",type=\"request\"", 0),
        (
            "service=\"_OTHER\",procedure=\"_OTHER\",type=\"request\"",
            1,
        ),
    ] {
        let (started, handled) = one_reading(&text, ("server", labels));
        assert_eq!(started.saturating_sub(handled), in_flight);
    }
    assert!(
        text.find("# HELP bead_server_call_handled_total")
            < text.find("# HELP bead_server_call_started_total")
    );

    // The C# twin counts on four threads while reading 200 snapshots.
    let registry = registry_of(None);
    let calls = registry
        .attach(RouterSide::Client)
        .declare_requester(&echo_of_1())
        .expect("echo");
    let running = AtomicBool::new(true);
    let ready = std::sync::Barrier::new(5);
    let labels = "service=\"1\",procedure=\"echo\",type=\"request\"";
    let snapshots = std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                calls.start();
                calls.end(CallEnding::Result, 0);
                ready.wait();
                let mut call = 0_u64;
                while running.load(Ordering::SeqCst) {
                    calls.start();
                    calls.end(
                        if call.is_multiple_of(2) {
                            CallEnding::Result
                        } else {
                            CallEnding::Application
                        },
                        call % 1_000,
                    );
                    call = call.saturating_add(1);
                }
            });
        }
        ready.wait();
        let snapshots = (0..200)
            .map(|_| registry.exposition().text)
            .collect::<Vec<_>>();
        running.store(false, Ordering::SeqCst);
        snapshots
    });
    for text in snapshots {
        one_reading(&text, ("client", labels));
    }
    let (started, handled) = one_reading(&registry.exposition().text, ("client", labels));
    assert!(started > 0);
    assert_eq!(started, handled);
}

#[test]
fn refuses_a_ceiling_that_is_not_a_whole_number_above_0_and_names_1000_procedures_by_default() {
    assert_eq!(super::MAXIMUM_PROCEDURES, 1_000);
    assert_eq!(
        registry_of(None).state.lock().expect("a registry").maximum,
        1_000
    );
    assert_eq!(
        MetricsRegistry::new(&MetricsRegistryOptions {
            maximum_procedures: Some(0)
        })
        .expect_err("zero refused")
        .to_string(),
        "maximumProcedures is a whole number above 0, not 0"
    );
    let consumer = crate::testing::surface::Consumer::new();
    consumer.accepts(
        "pub fn check(o: &mut bead::MetricsRegistryOptions) { o.maximum_procedures = Some(1000); }",
    );
    consumer.refuses(
        "pub fn check(o: &mut bead::MetricsRegistryOptions) { o.maximum_procedures = Some(-1); }",
        ("E0600", "cannot apply unary operator"),
    );
    consumer.refuses(
        "pub fn check(o: &mut bead::MetricsRegistryOptions) { o.maximum_procedures = Some(1.5); }",
        ("E0308", "mismatched types"),
    );
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
        server: Some(ServerOptions {
            metrics_registry: Some(registry.clone()),
            ..ServerOptions::default()
        }),
        client: Some(ClientOptions {
            metrics_registry: Some(registry.clone()),
            ..ClientOptions::default()
        }),
    };
    let pair = Pair::connected(crate::testing::instants::new_year(), &options)
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

            crate::testing::spawn(async move {
                for _ in 0..CALLS {
                    asking
                        .call(json!(thread.to_string()), &RequestOptions::default())
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
