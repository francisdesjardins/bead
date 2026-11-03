//! Inactivity ends an outgoing request by timeout and a result by a protocol failure.

use super::locked;
use super::router_core_requester::quiet;
use super::router_core_sending_edges::{asked, pattern};
use super::router_core_sessions::request;
use super::router_core_transfer_edges::{limits, serving};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::Envelope;
use crate::errors::CallError;
use crate::failure::FailureOrigin;
use crate::router::types::{RouterAnswer, RouterLimitsOptions};
use crate::testing::core_port::{Peer, completed, request_of};
use bytes::Bytes;
use core::time::Duration;
use std::sync::Arc;

async fn kinds(peer: &Peer) -> Vec<(crate::constants::EnvelopeKind, u32)> {
    peer.sent()
        .await
        .iter()
        .map(|(handle, envelope)| {
            assert_eq!(handle.as_ref(), "a");
            (envelope.kind(), envelope.call_id())
        })
        .collect()
}

fn stalled(outcome: Result<(), CallError>) {
    let Err(CallError::Failure(failure)) = outcome else {
        panic!("a stalled result, not {outcome:?}")
    };
    assert_eq!(failure.code(), ProtocolCode::TRANSFER_STALLED.get());
    assert_eq!(failure.side(), Some(RouterSide::Server));
    assert_eq!(failure.origin(), FailureOrigin::Local);
}

async fn last_failure(peer: &Peer, timeout: u64) {
    let sent = peer.sent().await;
    let (handle, Envelope::Failure { header, failure }) =
        sent.last().expect("the result's failure")
    else {
        panic!("a failure")
    };
    assert_eq!(handle.as_ref(), "a");
    assert_eq!(header.call_id, 1);
    assert_eq!(header.credential, None);
    assert_eq!(failure.code, ProtocolCode::TRANSFER_STALLED.get());
    assert_eq!(
        failure.detail,
        format!("no credit came for {timeout} milliseconds")
            .chars()
            .take(32)
            .collect::<String>()
    );
}

#[tokio::test]
async fn end_a_transfer_it_sends_that_no_credit_comes_for_a_request_with_a_timeout_a_result_with_a_failure()
 {
    use crate::constants::EnvelopeKind::{Cancel, Failure, Request, Result};
    for dotnet in [false, true] {
        let (peer, handed) = serving(
            false,
            &RouterLimitsOptions {
                transfer_inactivity_timeout: Some(Duration::from_millis(250)),
                ..limits()
            },
        )
        .await;
        let answerer = asked(&peer, (&handed, Bytes::new())).await;
        let asking = peer.request((pattern((200, dotnet)), request_of("a")));
        let responding = answerer.respond(RouterAnswer::Result(pattern((150, dotnet))));
        peer.settle().await;
        assert_eq!(
            peer.armed(),
            [Duration::from_millis(250), Duration::from_millis(250)]
        );
        peer.clock.advance(Duration::from_millis(250)).await;
        let error = completed(asking)
            .await
            .expect_err("the outgoing request times out");
        assert!(
            matches!(error, CallError::TimedOut(timeout) if timeout == Duration::from_millis(250))
        );
        assert_eq!(error.to_string(), "no answer came in 250 milliseconds");
        stalled(responding.await);
        peer.settle().await;
        assert_eq!(
            kinds(&peer).await,
            [(Request, 2), (Result, 1), (Cancel, 2), (Failure, 1)]
        );
        last_failure(&peer, 250).await;
        peer.receive((request(1, None), Arc::from("a")));
        peer.settle().await;
        assert_eq!(locked(&handed).len(), 2);
        quiet(&peer).await;

        let options = RouterLimitsOptions {
            transfer_inactivity_timeout: Some(Duration::from_millis(2_000)),
            ..limits()
        };
        let client = Peer::new(RouterSide::Client, &options);
        let mut request_options = request_of("a");
        request_options.options.timeout = Duration::MAX;
        let asking = client.request((pattern((300, dotnet)), request_options));
        client.settle().await;
        client.clock.advance(Duration::from_millis(2_000)).await;
        let error = completed(asking)
            .await
            .expect_err("the transfer bounds an otherwise unbounded call");
        assert!(
            matches!(error, CallError::TimedOut(timeout) if timeout == Duration::from_millis(2_000))
        );
        assert_eq!(error.to_string(), "no answer came in 2000 milliseconds");
        client.settle().await;
        assert_eq!(kinds(&client).await, [(Request, 1), (Cancel, 1)]);
        quiet(&client).await;

        let (server, handed) = serving(false, &options).await;
        let answerer = asked(&server, (&handed, Bytes::from_static(&[1]))).await;
        let responding = answerer.respond(RouterAnswer::Result(pattern((300, dotnet))));
        server.settle().await;
        server.clock.advance(Duration::from_millis(2_000)).await;
        stalled(responding.await);
        server.settle().await;
        assert_eq!(kinds(&server).await, [(Result, 1), (Failure, 1)]);
        last_failure(&server, 2_000).await;
        server.receive((
            Envelope::Request {
                header: crate::testing::core_port::scripted_header(1),
                payload: Bytes::from_static(&[2]),
            },
            Arc::from("a"),
        ));
        server.settle().await;
        assert_eq!(locked(&handed).len(), 2);
        quiet(&server).await;
    }
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the twin keeps the combined, progressed and unbounded receiving scenarios together"
)]
async fn end_a_transfer_nothing_comes_for_a_requests_with_a_failure_a_results_with_a_timeout() {
    use super::router_core_requester::opening as result_opening;
    use super::router_core_transfer_edges::{chunk, opening};
    use crate::constants::EnvelopeKind::{Cancel, Credit, Failure, Request};
    for dotnet in [false, true] {
        let options = RouterLimitsOptions {
            transfer_inactivity_timeout: Some(Duration::from_millis(250)),
            ..limits()
        };
        let (peer, handed) = serving(false, &options).await;
        peer.receive((opening(1, (Bytes::from(vec![0; 40]), 200)), Arc::from("a")));
        let asking = peer.request((Bytes::new(), request_of("a")));
        peer.receive((
            result_opening(2, (Bytes::from(vec![0; 32]), 200)),
            Arc::from("a"),
        ));
        peer.settle().await;
        peer.clock.advance(Duration::from_millis(250)).await;
        let error = completed(asking)
            .await
            .expect_err("the result transfer times out");
        assert!(
            matches!(error, CallError::TimedOut(timeout) if timeout == Duration::from_millis(250))
        );
        assert_eq!(error.to_string(), "no answer came in 250 milliseconds");
        peer.receive((
            chunk(1, (40, Bytes::from(vec![0; 48]), 200)),
            Arc::from("a"),
        ));
        peer.receive((
            chunk(2, (32, Bytes::from(vec![0; 48]), 200)),
            Arc::from("a"),
        ));
        peer.settle().await;
        assert_eq!(
            kinds(&peer).await,
            [
                (Credit, 1),
                (Request, 2),
                (Credit, 2),
                (Failure, 1),
                (Cancel, 2)
            ]
        );
        let sent = peer.sent().await;
        assert!(
            matches!(&sent[0].1, Envelope::Credit {header} if header.credit_end == 168 && !header.paced)
        );
        assert!(
            matches!(&sent[2].1, Envelope::Credit {header} if header.credit_end == 160 && !header.paced)
        );
        assert!(
            matches!(&sent[3].1, Envelope::Failure {header, failure} if header.call_id == 1 && header.credential.is_none() && failure.code == ProtocolCode::TRANSFER_STALLED.get())
        );
        assert!(locked(&handed).is_empty());
        quiet(&peer).await;

        let options = RouterLimitsOptions {
            transfer_inactivity_timeout: Some(Duration::from_millis(2_000)),
            ..limits()
        };
        let (progressing, handed) = serving(false, &options).await;
        let bytes = pattern((300, dotnet));
        progressing.receive((opening(1, (bytes.slice(..44), 300)), Arc::from("a")));
        progressing.settle().await;
        progressing
            .clock
            .advance(Duration::from_millis(1_500))
            .await;
        progressing.receive((chunk(1, (44, bytes.slice(44..92), 300)), Arc::from("a")));
        progressing.settle().await;
        progressing
            .clock
            .advance(Duration::from_millis(1_500))
            .await;
        assert_eq!(kinds(&progressing).await, [(Credit, 1)]);
        progressing.clock.advance(Duration::from_millis(500)).await;
        progressing.settle().await;
        assert_eq!(kinds(&progressing).await, [(Credit, 1), (Failure, 1)]);
        let sent = progressing.sent().await;
        assert!(
            matches!(&sent[0].1, Envelope::Credit {header} if header.credit_end == 172 && !header.paced)
        );
        assert!(
            matches!(&sent[1].1, Envelope::Failure {failure, ..} if failure.code == ProtocolCode::TRANSFER_STALLED.get())
        );
        assert!(locked(&handed).is_empty());
        quiet(&progressing).await;

        let client = Peer::new(RouterSide::Client, &options);
        let mut options = request_of("a");
        options.options.timeout = Duration::MAX;
        let asking = client.request((Bytes::from_static(&[1]), options));
        client.receive((result_opening(1, (bytes.slice(..32), 300)), Arc::from("a")));
        client.settle().await;
        client.clock.advance(Duration::from_millis(2_000)).await;
        let error = completed(asking)
            .await
            .expect_err("the incoming transfer bounds an unbounded request");
        assert!(
            matches!(error, CallError::TimedOut(timeout) if timeout == Duration::from_millis(2_000))
        );
        assert_eq!(error.to_string(), "no answer came in 2000 milliseconds");
        client.settle().await;
        assert_eq!(
            kinds(&client).await,
            [(Request, 1), (Credit, 1), (Cancel, 1)]
        );
        assert!(
            matches!(&client.sent().await[1].1, Envelope::Credit {header} if header.credit_end == 160 && !header.paced)
        );
        quiet(&client).await;
    }
}
