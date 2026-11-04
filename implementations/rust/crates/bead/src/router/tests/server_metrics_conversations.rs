//! One registry at both call ends, a raw handler's failure and each subscription ending.

mod interop;

use core::time::Duration;
use std::sync::Arc;

use super::metrics::counts_of;
use super::server::{Served, counted_options, first, registry, request_of, second, subscribing_of};
use super::{cancel_of, locked};
use crate::constants::{FailureScope, ProcedureKind, ProtocolCode, RouterSide};
use crate::envelope::{Envelope, FailureHeader, FailureRecord};
use crate::errors::ResolverError;
use crate::failure::Failure;
use crate::identity::Procedure;
use crate::managers::service::{
    RequestDependencies, RequestOptions, RequestResolverDependencies, Response,
};
use crate::metrics::MetricsRegistry;
use crate::payloads::TextCodec;
use crate::testing::pair::{Pair, PairOptions, echo};

fn procedure((id, name): (u16, &str)) -> Procedure {
    Procedure {
        procedure_id: id,
        procedure_name: name.to_owned(),
        ..echo()
    }
}

fn third() -> crate::ConnectionHandle {
    Arc::from("type=WS;ip=127.0.0.1;port=50003;ordinal=1")
}

fn dropped(registry: &MetricsRegistry) -> Vec<String> {
    counts_of(registry)
        .into_iter()
        .filter(|line| line.starts_with("bead_subscriptions_dropped_total"))
        .collect()
}

fn expected_calls(service: u16) -> Vec<String> {
    let mut expected = Vec::new();
    for (procedure, kind) in [
        ("echo", "request"),
        ("ask", "request"),
        ("clock", "command"),
    ] {
        for side in ["client", "server"] {
            let labels = format!("service=\"{service}\",procedure=\"{procedure}\",type=\"{kind}\"");
            expected.extend([
                format!("bead_{side}_call_duration_seconds_count{{{labels}}} 1"),
                format!("bead_{side}_call_handled_total{{{labels},outcome=\"result\"}} 1"),
                format!("bead_{side}_call_started_total{{{labels}}} 1"),
            ]);
        }
    }
    expected.sort();
    expected
}

#[tokio::test]
async fn one_registry_given_to_a_clients_router_and_a_servers_counts_a_call_at_each_of_its_ends_a_command_among_them()
 {
    interop::play().await;
    let registry = registry();
    let pair = Pair::connected(
        super::january_first(),
        &PairOptions {
            server: Some(crate::server::ServerOptions {
                metrics_registry: Some(registry.clone()),
                ..crate::server::ServerOptions::default()
            }),
            client: Some(crate::client::ClientOptions {
                metrics_registry: Some(registry.clone()),
                ..crate::client::ClientOptions::default()
            }),
        },
    )
    .await
    .expect("a connected pair");
    let clock = Procedure {
        procedure_kind: Some(ProcedureKind::Command),
        ..procedure((3, "clock"))
    };
    let ask = procedure((2, "ask"));
    let services = pair.server.services();
    let command = services
        .get_command(&clock, RequestDependencies::new(TextCodec, TextCodec))
        .expect("clock's command");
    services
        .get_request_resolver(
            &echo(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("echo resolved")
        .on(Arc::new(|request, response: Response<TextCodec>| {
            response.result(request.payload)
        }))
        .expect("echo registered");
    services
        .get_request_resolver(&ask, RequestResolverDependencies::new(TextCodec, TextCodec))
        .expect("ask resolved")
        .on(Arc::new(move |request, response: Response<TextCodec>| {
            let command = command.clone();
            Box::pin(async move {
                let noon = command
                    .call(
                        "now".to_owned(),
                        &RequestOptions {
                            connection_handle: Some(request.connection_handle),
                            timeout: Some(Duration::from_secs(1)),
                            ..RequestOptions::default()
                        },
                    )
                    .map_err(ResolverError::other)?
                    .await
                    .map_err(ResolverError::other)?;
                response.result(noon).await
            })
        }))
        .expect("ask registered");
    pair.client
        .services()
        .get_command_resolver(
            &clock,
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("clock resolved")
        .on(Arc::new(|request, response: Response<TextCodec>| {
            assert_eq!(request.payload, "now");
            response.result("noon".to_owned())
        }))
        .expect("clock registered");
    for (procedure, payload, expected) in [(echo(), "hi", "hi"), (ask, "", "noon")] {
        let requester = pair
            .client
            .services()
            .get_request(&procedure, RequestDependencies::new(TextCodec, TextCodec))
            .expect("a requester");
        assert_eq!(
            requester
                .call(payload.to_owned(), &RequestOptions::default())
                .expect("the call starts")
                .await
                .expect("the call answers"),
            expected
        );
    }
    pair.settle().await;
    let mut actual = counts_of(&registry)
        .into_iter()
        .filter(|line| !line.contains("_bucket{"))
        .collect::<Vec<_>>();
    actual.sort();
    assert_eq!(actual, expected_calls(2));
    assert!(locked(&pair.server_reports).is_empty());
    assert!(locked(&pair.client_reports).is_empty());
    pair.client.dispose().await;
    pair.server.dispose().await.expect("the server disposed");
}

#[tokio::test]
async fn answers_a_call_whose_handler_fails_before_it_answers_procedure_failed_and_counts_it_so() {
    let registry = registry();
    let served = Served::new(&counted_options(&registry));
    let other = procedure((7, "other"));
    served
        .router
        .register_resolver((
            &other,
            super::client_commands::handler(Arc::new(|_| {
                Box::pin(async {
                    Err(ResolverError::other(std::io::Error::other(
                        "this handler breaks, on purpose",
                    )))
                })
            })),
        ))
        .expect("the raw handler registered");
    served.transport.open(&first(), true);
    served
        .transport
        .deliver(&request_of((1, &other, "")), &first());
    served.settle().await;
    assert_eq!(
        served.transport.take(),
        [(
            first(),
            Envelope::Failure {
                header: FailureHeader {
                    call_id: 1,
                    credential: None
                },
                failure: FailureRecord {
                    code: ProtocolCode::PROCEDURE_FAILED.get(),
                    scope: FailureScope::Protocol,
                    detail: String::new(),
                    relays: 0
                },
            }
        )]
    );
    assert_eq!(served.reported(), ["this handler breaks, on purpose first"]);
    assert!(registry.exposition().text.contains("bead_server_call_duration_seconds_bucket{service=\"2\",procedure=\"other\",type=\"request\",le=\"0.0\"} 1\n"));
    assert_eq!(
        counts_of(&registry)
            .into_iter()
            .filter(|line| !line.contains("_bucket{"))
            .collect::<Vec<_>>(),
        [
            "bead_server_call_duration_seconds_count{service=\"2\",procedure=\"other\",type=\"request\"} 1",
            "bead_server_call_handled_total{service=\"2\",procedure=\"other\",type=\"request\",outcome=\"failure\",code=\"PROCEDURE_FAILED\"} 1",
            "bead_server_call_started_total{service=\"2\",procedure=\"other\",type=\"request\"} 1",
        ]
    );
    served.router.dispose().await;
}

#[tokio::test]
async fn drops_each_subscription_a_close_or_its_disposal_ends_with_no_code_and_none_its_client_cancels()
 {
    let registry = registry();
    let served = Served::new(&counted_options(&registry));
    let _news = served.news();
    for handle in [first(), second(), third()] {
        served.transport.open(&handle, true);
        served.transport.deliver(&subscribing_of(1), &handle);
    }
    served.settle().await;
    assert_eq!(
        served.sent_since(),
        [
            "first result 1 ok",
            "second result 1 ok",
            "type=WS;ip=127.0.0.1;port=50003;ordinal=1 result 1 ok"
        ]
    );
    served.transport.deliver(&cancel_of(1), &third());
    served.settle().await;
    assert_eq!(dropped(&registry), Vec::<String>::new());
    served.transport.close_connection(&first());
    served.settle().await;
    assert_eq!(
        dropped(&registry),
        ["bead_subscriptions_dropped_total{service=\"2\",procedure=\"news\"} 1"]
    );
    served.router.dispose().await;
    served.settle().await;
    assert_eq!(
        dropped(&registry),
        ["bead_subscriptions_dropped_total{service=\"2\",procedure=\"news\"} 2"]
    );
    assert_eq!(served.transport.take(), []);
    assert_eq!(served.reported(), Vec::<String>::new());
}

#[tokio::test]
async fn counts_a_subscription_its_application_drops_under_the_code_of_the_failure_that_ends_it_whatever_its_code()
 {
    let registry = registry();
    let served = Served::new(&counted_options(&registry));
    let _news = served.news();
    let ending = [
        (
            first(),
            Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server),
        ),
        (
            second(),
            Failure::application(9.try_into().expect("a nonzero application code"), ""),
        ),
        (
            third(),
            Failure::protocol(
                ProtocolCode::new(99.try_into().expect("a nonzero protocol code")),
                RouterSide::Server,
            ),
        ),
    ];
    for (handle, _) in &ending {
        served.transport.open(handle, true);
        served.transport.deliver(&subscribing_of(1), handle);
    }
    served.settle().await;
    assert_eq!(served.transport.take().len(), 3);
    for (handle, failure) in &ending {
        served
            .router
            .drop_subscriptions(Arc::clone(handle), failure.clone())
            .await;
    }
    served.settle().await;
    assert_eq!(
        served.transport.take(),
        ending
            .iter()
            .map(|(handle, failure)| (
                Arc::clone(handle),
                Envelope::Failure {
                    header: FailureHeader {
                        call_id: 1,
                        credential: None
                    },
                    failure: failure.record(),
                }
            ))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        dropped(&registry),
        [
            "bead_subscriptions_dropped_total{service=\"2\",procedure=\"news\",code=\"ACCESS_DENIED\"} 1",
            "bead_subscriptions_dropped_total{service=\"2\",procedure=\"news\",code=\"application\"} 1",
            "bead_subscriptions_dropped_total{service=\"2\",procedure=\"news\",code=\"_OTHER\"} 1",
        ]
    );
    assert_eq!(
        registry
            .exposition()
            .text
            .lines()
            .filter(|line| line
                .starts_with("bead_subscriptions_dropped_total{service=\"2\",procedure=\"news\""))
            .count(),
        26
    );
    assert_eq!(served.reported(), Vec::<String>::new());
    served.router.dispose().await;
}
