//! Refusals counted in their owner turn, including credential placement and exhausted call IDs.

use core::time::Duration;
use std::sync::Arc;

use bytes::Bytes;
use tokio_util::sync::CancellationToken;

use super::router_core_requester::{limits, pattern};
use crate::call_session::{Carriage, presented_credential_of, uncarried_of};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::Credential;
use crate::errors::CallError;
use crate::metrics::{MetricsRegistry, MetricsRegistryOptions, ProcedureSeries};
use crate::router::core as router_core;
use crate::router::requester::CoreRequest;
use crate::router::types::RequestCredential;
use crate::testing::core_port::{Completion, Peer, PeerOptions, State, completed, request_of};

struct Counted {
    peer: Peer,
    registry: MetricsRegistry,
    series: ProcedureSeries,
}

impl Counted {
    async fn new(side: RouterSide, last: u32) -> Self {
        let peer = Peer::with_options(
            side,
            &PeerOptions {
                limits: Some(limits()),
                last_call_id: Some(last),
                ..PeerOptions::default()
            },
        )
        .expect("the source call ID range");
        let registry =
            MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
        let metrics = registry.attach(side);
        let series = metrics
            .declare_requester(&crate::testing::pair::echo())
            .expect("echo counted");
        peer.owner
            .run(move |state| {
                state.core.metrics = Some(metrics);
            })
            .await
            .expect("the core counts");
        Self {
            peer,
            registry,
            series,
        }
    }

    fn ask(
        &self,
        payload: Bytes,
        mut request: CoreRequest<State>,
    ) -> Completion<crate::router::types::RouterResult> {
        request.series = Some(self.series.clone());
        self.peer.request((payload, request))
    }

    async fn checkpoint(&self, expected: &[&str]) {
        let reading = self.registry.clone();
        let actual = self
            .peer
            .owner
            .run(move |_| super::metrics::counts_of(&reading))
            .await
            .expect("read immediately behind the requests on their owner");
        let mut actual = actual
            .iter()
            .map(|line| {
                line.replace("service=\"2\",procedure=\"echo\",type=\"request\"", "")
                    .replace("service=\"2\",procedure=\"echo\",type=\"command\"", "")
                    .replace("{,", "{")
            })
            .collect::<Vec<_>>();
        actual.sort();
        let mut expected = expected
            .iter()
            .map(|line| format!("bead_client_call_{line}"))
            .collect::<Vec<_>>();
        expected.sort();
        assert_eq!(actual, expected);
        assert!(self.registry.exposition().text.lines().any(|line| {
            line.starts_with("bead_client_call_duration_seconds_sum{") && line.ends_with(" 0")
        }));
    }
}

async fn uncounted(counted: &Counted) {
    let mut invalid_timeout = request_of("a");
    invalid_timeout.options.timeout = Duration::ZERO;
    let mut invalid_limit = request_of("a");
    invalid_limit.maximum_payload_bytes = Some(0);
    let mut invalid_header = request_of("a");
    invalid_header.credential = Some(Credential::Jwt(Bytes::from(vec![b'x'; 1_005])));
    for mut request in [invalid_timeout, invalid_limit, invalid_header] {
        request.refusal = Some(CallError::Disconnected(
            "the connection is closed".to_owned(),
        ));
        assert!(matches!(
            completed(counted.ask(Bytes::new(), request)).await,
            Err(CallError::Refused(_))
        ));
    }
    let signal = CancellationToken::new();
    signal.cancel();
    let mut request = request_of("a");
    request.options.signal = Some(signal);
    request.refusal = Some(CallError::Disconnected(
        "the connection is closed".to_owned(),
    ));
    assert!(matches!(
        completed(counted.ask(Bytes::new(), request)).await,
        Err(CallError::Cancelled(_))
    ));
}

async fn counted_server() {
    let counted = Counted::new(RouterSide::Server, 2).await;
    let mut request = request_of("a");
    request.maximum_payload_bytes = Some(8);
    let too_large = counted.ask(Bytes::from(vec![0; 9]), request);
    counted
        .checkpoint(&[
            "duration_seconds_bucket{le=\"0.0\"} 1",
            "duration_seconds_count{} 1",
            "handled_total{outcome=\"failure\",code=\"PAYLOAD_TOO_LARGE\"} 1",
            "started_total{} 1",
        ])
        .await;
    let mut request = request_of("a");
    request.credential = Some(Credential::Jwt(Bytes::from(vec![b'x'; 40])));
    let no_opening = counted.ask(pattern(100), request);
    let waiting = counted.ask(Bytes::new(), request_of("a"));
    let no_id = counted.ask(Bytes::new(), request_of("a"));
    let expected = [
        "duration_seconds_bucket{le=\"0.0\"} 3",
        "duration_seconds_count{} 3",
        "handled_total{outcome=\"failure\",code=\"CAPACITY_EXCEEDED\"} 1",
        "handled_total{outcome=\"failure\",code=\"PAYLOAD_TOO_LARGE\"} 2",
        "started_total{} 4",
    ];
    counted.checkpoint(&expected).await;
    uncounted(&counted).await;
    counted.checkpoint(&expected).await;
    counted
        .peer
        .receive((super::result_of(2, None), Arc::from("a")));
    completed(waiting).await.expect("the sole waiting call");
    for (call, code) in [
        (too_large, ProtocolCode::PAYLOAD_TOO_LARGE),
        (no_opening, ProtocolCode::PAYLOAD_TOO_LARGE),
        (no_id, ProtocolCode::CAPACITY_EXCEEDED),
    ] {
        assert!(
            matches!(completed(call).await, Err(CallError::Failure(failure)) if failure.code() == code.get())
        );
    }
}

#[derive(Default)]
struct ClientOptions {
    credential: Option<RequestCredential>,
    maximum: Option<u64>,
    secure: bool,
    closed: bool,
}

fn client_request(options: &ClientOptions) -> CoreRequest<State> {
    let mut request = request_of("a");
    request.options.timeout = crate::duration::NEVER;
    request.maximum_payload_bytes = options.maximum;
    match presented_credential_of(options.credential.as_ref(), (RouterSide::Client, None)) {
        Err(error) => request.refusal = Some(error),
        Ok(presented) => {
            let uncarried = uncarried_of(
                presented.credential.as_ref(),
                &Carriage {
                    carried: presented.carried.as_deref(),
                    takes: &|_| false,
                    side: RouterSide::Client,
                    is_secure: options.secure,
                },
            );
            request.refusal = uncarried.map(CallError::Failure).or_else(|| {
                options
                    .closed
                    .then(|| CallError::Disconnected("the connection is closed".to_owned()))
            });
            request.credential = presented.credential;
            request.transport_credential = presented.carried;
        }
    }
    request
}

async fn counted_client() {
    let counted = Counted::new(RouterSide::Client, 3).await;
    for (length, options, code) in [
        (
            1,
            ClientOptions {
                credential: Some(RequestCredential::Opaque),
                ..ClientOptions::default()
            },
            ProtocolCode::SESSION_REQUIRED,
        ),
        (
            1,
            ClientOptions {
                credential: Some(RequestCredential::Elsewhere("x".to_owned())),
                ..ClientOptions::default()
            },
            ProtocolCode::DESTINATION_UNREACHABLE,
        ),
        (
            8,
            ClientOptions {
                maximum: Some(4),
                ..ClientOptions::default()
            },
            ProtocolCode::PAYLOAD_TOO_LARGE,
        ),
        (
            9,
            ClientOptions {
                credential: Some(RequestCredential::Jwt(
                    String::from_utf8(vec![b'a'; 40]).expect("ASCII"),
                )),
                secure: true,
                ..ClientOptions::default()
            },
            ProtocolCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        assert!(
            matches!(completed(counted.ask(pattern(length), client_request(&options))).await, Err(CallError::Failure(failure)) if failure.code() == code.get())
        );
    }
    assert!(matches!(
        completed(counted.ask(
            Bytes::from_static(&[0]),
            client_request(&ClientOptions {
                closed: true,
                ..ClientOptions::default()
            })
        ))
        .await,
        Err(CallError::Disconnected(_))
    ));
    let first = counted.ask(
        Bytes::from_static(&[0]),
        client_request(&ClientOptions::default()),
    );
    let second = counted.ask(
        Bytes::from_static(&[0]),
        client_request(&ClientOptions::default()),
    );
    assert!(
        matches!(completed(counted.ask(Bytes::from_static(&[0]), client_request(&ClientOptions::default()))).await, Err(CallError::Failure(failure)) if failure.code() == ProtocolCode::CAPACITY_EXCEEDED.get())
    );
    let expected = [
        "duration_seconds_bucket{le=\"0.0\"} 6",
        "duration_seconds_count{} 6",
        "handled_total{outcome=\"failure\",code=\"CAPACITY_EXCEEDED\"} 1",
        "handled_total{outcome=\"failure\",code=\"DESTINATION_UNREACHABLE\"} 1",
        "handled_total{outcome=\"failure\",code=\"PAYLOAD_TOO_LARGE\"} 2",
        "handled_total{outcome=\"failure\",code=\"SESSION_REQUIRED\"} 1",
        "handled_total{outcome=\"closed\"} 1",
        "started_total{} 8",
    ];
    counted.checkpoint(&expected).await;
    uncounted(&counted).await;
    counted.checkpoint(&expected).await;
    counted
        .peer
        .owner
        .run(router_core::dispose)
        .await
        .expect("the pending calls closed");
    for call in [first, second] {
        assert!(matches!(
            completed(call).await,
            Err(CallError::Disconnected(_))
        ));
    }
}

#[tokio::test]
async fn count_a_call_made_refused_before_it_goes_no_call_id_free_or_payload_too_large_as_started_and_ended_in_the_turn_it_started_and_a_programmers_error_or_an_aborted_signal_as_nothing()
 {
    counted_server().await;
    counted_client().await;
}
