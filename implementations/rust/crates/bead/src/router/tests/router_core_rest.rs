//! The core's admissions, malformed requests, and answers crossing a call's replacement.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::oneshot;

use super::server::{Served, first, header_of, request_of, second};
use super::{Handed, Scripted, answer, cancel_of, keeping, locked};
use crate::constants::{ProtocolCode, RouterSide};
use crate::envelope::{ChunkHeader, Envelope, RequestHeader};
use crate::errors::{CallError, ResolverError};
use crate::failure::Failure;
use crate::router::core::{AdmissionRefusal, Handler, ResolveFn, ResolverProps};
use crate::router::server::RouterServerOptions;
use crate::router::types::{RouterAnswer, RouterLimitsOptions, TransportMessage};
use crate::testing::pair::echo;
use crate::testing::scripted::Sending;

fn handler(resolve: ResolveFn) -> Handler {
    Handler {
        resolve,
        admit: None,
        maximum_payload_bytes: None,
        forwards_credentials: false,
        notifies: false,
    }
}

fn serving(resolve: ResolveFn) -> Served {
    let served = Served::new(&RouterServerOptions::default());

    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served
        .router
        .register_resolver((&echo(), handler(resolve)))
        .expect("echo registered");

    served
}

fn held() -> (Served, Handed) {
    let handed = Handed::default();
    let served = serving(keeping((&handed, None)));

    (served, handed)
}

fn call_ids(handed: &Handed) -> Vec<u32> {
    locked(handed)
        .iter()
        .map(|props| props.header.call_id)
        .collect()
}

fn deliver_bytes(served: &Served, hexadecimal: &str) {
    served.transport.deliver_message(
        &TransportMessage {
            data: Bytes::from(crate::testing::hexadecimal::bytes_of(hexadecimal).expect("bytes")),
            ..TransportMessage::default()
        },
        &first(),
    );
}

type ResolverEnd = Result<(), ResolverError>;

// Each resolver waits for its own release. A call after the last release completes at once.
fn gated(releases: Vec<oneshot::Receiver<ResolverEnd>>) -> (ResolveFn, Handed) {
    let releases = Mutex::new(VecDeque::from(releases));
    let handed = Handed::default();
    let keeping = Arc::clone(&handed);
    let resolve: ResolveFn = Arc::new(move |props: ResolverProps| {
        locked(&keeping).push(props);
        let release = locked(&releases).pop_front();

        Box::pin(async move {
            match release {
                Some(release) => release.await.expect("resolver released"),
                None => Ok(()),
            }
        })
    });

    (resolve, handed)
}

fn failed(message: &str) -> ResolverEnd {
    Err(ResolverError::other(std::io::Error::other(
        message.to_owned(),
    )))
}

// spec 9.2, 12.2
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the twin plays whole and transferred requests, admitted and refused, in one scenario"
)]
async fn asks_a_request_s_admission_on_its_header_once_past_its_route_and_before_its_payload_a_refusal_answers_it_before_any_credit()
 {
    let served = Served::new(&RouterServerOptions {
        limits: Some(RouterLimitsOptions {
            buffered_bytes_budget: Some(1_024),
            maximum_payload_bytes: Some(1_024),
            maximum_envelope_bytes: Some(1_024),
            chunk_bytes: Some(64),
            window_bytes: Some(128),
            ..RouterLimitsOptions::default()
        }),
        ..RouterServerOptions::default()
    });
    let handed = Handed::default();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let asking = Arc::clone(&asked);

    served.transport.open(&first(), true);
    served
        .router
        .register_resolver((
            &echo(),
            Handler {
                admit: Some(Arc::new(move |request| {
                    locked(&asking).push((
                        request.header.call_id,
                        Arc::clone(&request.connection_handle),
                        request.header.total.is_none(),
                    ));

                    Ok(
                        matches!(request.header.call_id, 3 | 7).then(|| AdmissionRefusal {
                            failure: Failure::protocol(
                                ProtocolCode::ACCESS_DENIED,
                                RouterSide::Server,
                            ),
                            by: None,
                        }),
                    )
                })),
                ..handler(keeping((&handed, None)))
            },
        ))
        .expect("echo registered");

    for call_id in [1, 3] {
        served
            .transport
            .deliver(&request_of((call_id, &echo(), "")), &first());
    }

    let payload = Bytes::from("abcdefghijklmnopqrstuvwxyz".repeat(4)).slice(..100);
    let opening = |call_id| Envelope::Request {
        header: RequestHeader {
            total: Some(100),
            ..header_of((call_id, &echo()))
        },
        payload: payload.slice(..40),
    };

    served.transport.deliver(&opening(5), &first());
    for (offset, end) in [(40, 88), (88, 100)] {
        served.transport.deliver(
            &Envelope::Chunk {
                header: ChunkHeader {
                    call_id: 5,
                    offset,
                    is_last: end == 100,
                },
                payload: payload.slice(usize::try_from(offset).expect("offset")..end),
            },
            &first(),
        );
    }
    served.transport.deliver(&opening(7), &first());
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                service_id: 8,
                ..header_of((9, &echo()))
            },
            payload: Bytes::new(),
        },
        &first(),
    );
    served.settle().await;

    assert_eq!(
        *locked(&asked),
        [
            (1, first(), true),
            (3, first(), true),
            (5, first(), false),
            (7, first(), false)
        ],
        "asked once per routed header, before the transfer is whole"
    );
    // AdmissionRequest's type holds the connection, header and session, never a payload.
    assert_eq!(
        call_ids(&handed),
        [1, 5],
        "only admitted requests dispatched"
    );
    assert_eq!(
        locked(&handed)[0].payload,
        Bytes::new(),
        "the whole request"
    );
    assert_eq!(
        locked(&handed)[1].payload,
        payload,
        "the transfer assembled"
    );
    assert_eq!(
        served
            .transport
            .envelopes(&first())
            .iter()
            .filter_map(|envelope| {
                if let Envelope::Credit { header } = envelope {
                    Some((header.call_id, header.credit_end, header.paced))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>(),
        [(5, 100, false)],
        "only the admitted transfer receives credit"
    );
    assert_eq!(
        served.sent_since(),
        [
            "first failure 3 ACCESS_DENIED",
            "first Credit 5",
            "first failure 7 ACCESS_DENIED",
            "first failure 9 SERVICE_UNKNOWN",
        ],
        "refused before any credit, the admitted transfer credited once"
    );
    assert!(served.reported().is_empty(), "nothing reported");
}

// spec 9.0
#[tokio::test]
async fn answers_as_failed_a_request_whose_admission_throws_and_reports_why() {
    for message in ["thrown", "the admission broke"] {
        let served = Served::new(&RouterServerOptions::default());
        let handed = Handed::default();

        served.transport.open(&first(), true);
        served
            .router
            .register_resolver((
                &echo(),
                Handler {
                    admit: Some(Arc::new(move |_| {
                        Err(ResolverError::other(std::io::Error::other(message)))
                    })),
                    ..handler(keeping((&handed, None)))
                },
            ))
            .expect("echo registered");
        served
            .transport
            .deliver(&request_of((1, &echo(), "\u{1}")), &first());
        served.settle().await;

        assert!(locked(&handed).is_empty(), "never dispatched");
        assert_eq!(
            served.sent_since(),
            ["first failure 1 PROCEDURE_FAILED"],
            "answered as failed"
        );
        assert_eq!(
            served.reported(),
            [format!("{message} first")],
            "reported with its connection"
        );
    }
}

// spec 3.1, 3.2
#[tokio::test]
async fn never_answers_what_is_not_an_envelope_and_answers_a_request_of_this_layout_that_does_not_read()
 {
    let served = Served::new(&RouterServerOptions::default());

    served.transport.open(&first(), true);
    for bytes in [
        "0A 10 00 03  00 00 00 03  00 02 00 01",
        "00 10 00 03  00 00 00 03  00 02 00 01",
        "A1 10 01 03  00 00 00 05  00 02 00 01",
    ] {
        deliver_bytes(&served, bytes);
    }
    served.settle().await;

    assert_eq!(
        served.sent_since(),
        ["first failure 5 ENVELOPE_MALFORMED"],
        "only this layout answered"
    );
    assert_eq!(
        served.reported(),
        ["ENVELOPE_MALFORMED first", "ENVELOPE_MALFORMED first"],
        "non-envelopes reported"
    );
}

// spec 3.1, 9.1
#[tokio::test]
async fn answers_under_the_same_rule_on_a_client_s_core_whose_peer_opens_even_call_ids() {
    let scripted = Scripted::new();

    for bytes in [
        "A2 10 00 03  00 00 00 04  00 02 00 01",
        "A2 10 00 03  00 00 00 03  00 02 00 01",
    ] {
        scripted.transport.deliver_message(&TransportMessage {
            data: Bytes::from(crate::testing::hexadecimal::bytes_of(bytes).expect("bytes")),
            ..TransportMessage::default()
        });
    }
    scripted.settle().await;

    assert!(
        matches!(
            scripted.transport.envelopes().as_slice(),
            [Envelope::Failure { header, failure }]
                if header.call_id == 4 && failure.code == ProtocolCode::LAYOUT_UNSUPPORTED.get()
        ),
        "only the peer's parity answered"
    );
    assert_eq!(
        scripted.codes(),
        ["LAYOUT_UNSUPPORTED"],
        "the client's parity reported"
    );
    assert!(
        matches!(
            locked(&scripted.errors).as_slice(),
            [crate::router::types::RouterError::Failure(failure)]
                if failure.side() == Some(RouterSide::Client)
        ),
        "reported as the client side"
    );
}

// spec 3.1
#[tokio::test]
async fn reports_a_refusal_of_the_gate_that_cannot_go_out() {
    let served = Served::new(&RouterServerOptions::default());

    served.transport.open(&first(), true);
    served
        .transport
        .send_as((&first(), Sending::Thrown("gone".to_owned())));
    deliver_bytes(&served, "A2 10 00 03  00 00 00 03  00 02 00 01");
    served.settle().await;

    assert_eq!(
        served.reported(),
        ["gone first"],
        "the send failure reported with its connection"
    );
}

// spec 9.0, 10.2
#[tokio::test]
async fn lets_go_of_the_call_id_of_a_resolver_that_fails_without_answering_and_of_that_one_alone() {
    let (fail, failing) = oneshot::channel();
    let (cancel, cancelled) = oneshot::channel();
    let (resolve, handed) = gated(vec![failing, cancelled]);
    let served = serving(resolve);

    served
        .transport
        .deliver(&request_of((5, &echo(), "\u{1}")), &first());
    served.settle().await;
    fail.send(failed("rejected")).expect("first released");
    served.settle().await;
    served
        .transport
        .deliver(&request_of((5, &echo(), "\u{2}")), &first());
    served.settle().await;

    assert_eq!(call_ids(&handed), [5, 5], "the failed call's id free again");
    assert_eq!(
        served.reported(),
        ["rejected first"],
        "the failure reported"
    );
    assert_eq!(
        served.sent_since(),
        ["first failure 5 PROCEDURE_FAILED"],
        "the first call answered"
    );

    served.transport.deliver(&cancel_of(5), &first());
    served
        .transport
        .deliver(&request_of((5, &echo(), "\u{3}")), &first());
    cancel
        .send(failed("rejected"))
        .expect("cancelled resolver released");
    served.settle().await;
    answer(&handed, (2, &[3])).await;
    served.settle().await;

    assert_eq!(
        call_ids(&handed),
        [5, 5, 5],
        "the cancelled call's id free again"
    );
    assert_eq!(
        served.reported(),
        ["rejected first"],
        "the cancelled resolver's failure unreported"
    );
    assert!(
        matches!(served.transport.take().as_slice(),
            [(handle, Envelope::Result { header, payload })]
                if *handle == first() && header.call_id == 5 && payload.as_ref() == [3]
        ),
        "the replacement answers with its own payload"
    );
}

// spec 9.0
#[tokio::test]
async fn sends_nothing_for_an_answer_whose_call_its_connection_took_away_though_the_peer_opens_its_call_id_again()
 {
    let (served, handed) = held();

    served
        .transport
        .deliver(&request_of((5, &echo(), "\u{1}")), &first());
    served.settle().await;
    served
        .router
        .owner()
        .run(|state| {
            crate::router::core::reject_pending(state, ("a replaced", Some(&first())));
        })
        .await
        .expect("connection replaced");
    served
        .transport
        .deliver(&request_of((5, &echo(), "\u{2}")), &first());
    served.settle().await;
    answer(&handed, (0, &[0])).await;
    served.settle().await;

    assert!(
        served.transport.take().is_empty(),
        "the replaced call answers nothing"
    );
    served
        .transport
        .deliver(&request_of((5, &echo(), "\u{3}")), &first());
    answer(&handed, (1, &[1])).await;
    served.settle().await;

    assert_eq!(
        call_ids(&handed),
        [5, 5],
        "the replacement stays open until answered"
    );
    assert_eq!(
        served.reported(),
        ["ENVELOPE_MALFORMED first"],
        "the duplicate request reported"
    );
    assert!(
        matches!(served.transport.take().as_slice(),
            [(handle, Envelope::Result { header, payload })]
                if *handle == first() && header.call_id == 5 && payload.as_ref() == [1]
        ),
        "only the replacement answers"
    );
}

// spec 9.0
#[tokio::test]
async fn lets_a_resolver_that_fails_after_it_answered_take_nothing_from_the_call_holding_its_call_id_now()
 {
    let (fail, failing) = oneshot::channel();
    let (hold, holding) = oneshot::channel();
    let (resolve, handed) = gated(vec![failing, holding]);
    let served = serving(resolve);

    served
        .transport
        .deliver(&request_of((5, &echo(), "")), &first());
    served.settle().await;
    answer(&handed, (0, b"")).await;
    served
        .transport
        .deliver(&request_of((5, &echo(), "")), &first());
    served.settle().await;
    fail.send(failed("late")).expect("first resolver released");
    served.settle().await;
    served
        .transport
        .deliver(&request_of((5, &echo(), "")), &first());
    served.settle().await;

    assert_eq!(
        call_ids(&handed),
        [5, 5],
        "the replacement stays open after the late failure"
    );
    assert_eq!(
        served.reported(),
        ["late first", "ENVELOPE_MALFORMED first"],
        "the late failure and the duplicate reported"
    );
    assert_eq!(
        served.sent_since(),
        ["first result 5 "],
        "only the first result sent"
    );
    hold.send(Ok(())).expect("second resolver released");
    served.settle().await;

    // The C# twin also fails its first resolver before the replacement arrives.
    let (fail, failing) = oneshot::channel();
    let (resolve, handed) = gated(vec![failing]);
    let served = serving(resolve);

    served
        .transport
        .deliver(&request_of((1, &echo(), "\u{1}")), &first());
    served.settle().await;
    answer(&handed, (0, &[1])).await;
    fail.send(failed("the resolver broke after its answer"))
        .expect("answered resolver released");
    served.settle().await;

    assert_eq!(
        served.reported(),
        ["the resolver broke after its answer first"],
        "reported after its result"
    );
    assert!(
        matches!(served.transport.take().as_slice(),
            [(handle, Envelope::Result { header, payload })]
                if *handle == first() && header.call_id == 1 && payload.as_ref() == [1]
        ),
        "the first resolver's result sent alone"
    );
    served
        .transport
        .deliver(&request_of((1, &echo(), "\u{2}")), &first());
    served
        .transport
        .deliver(&request_of((1, &echo(), "\u{3}")), &first());
    served.settle().await;

    assert_eq!(
        call_ids(&handed),
        [1, 1],
        "the replacement holds its call id"
    );
    assert_eq!(
        served.reported(),
        [
            "the resolver broke after its answer first",
            "ENVELOPE_MALFORMED first"
        ],
        "only the late failure and duplicate reported"
    );
}

// spec 9.0
#[tokio::test]
async fn free_the_call_of_an_answer_that_could_not_go_out_so_its_call_id_opens_again() {
    for message in [
        "the transport is closing",
        "the transport refused the result",
    ] {
        let (served, handed) = held();
        let payload = if message == "the transport is closing" {
            ""
        } else {
            "\u{1}"
        };

        served
            .transport
            .deliver(&request_of((1, &echo(), payload)), &first());
        served.settle().await;
        served
            .transport
            .send_as((&first(), Sending::Thrown(message.to_owned())));
        let answerer = Arc::clone(&locked(&handed)[0].answerer);
        let refused = answerer
            .respond(RouterAnswer::Result(Bytes::from_static(&[1])))
            .await;

        assert!(
            matches!(refused, Err(CallError::Other(error)) if error.to_string() == message),
            "the transport's failure reaches the answerer"
        );
        served.transport.send_as((&first(), Sending::Taken));
        let payload = if payload.is_empty() { "" } else { "\u{2}" };

        served
            .transport
            .deliver(&request_of((1, &echo(), payload)), &first());
        served.settle().await;

        assert_eq!(
            call_ids(&handed),
            [1, 1],
            "the failed answer frees the call id"
        );
        assert!(
            served.reported().is_empty(),
            "the answer's caller hears the failure alone"
        );
    }
}

// spec 9.0, 12.2
#[tokio::test]
async fn keep_a_call_open_when_its_answer_cannot_go_out_so_a_fallback_answers_it() {
    let (served, handed) = held();

    served
        .transport
        .deliver(&request_of((5, &echo(), "")), &first());
    served.settle().await;
    let answerer = Arc::clone(&locked(&handed)[0].answerer);
    let refused = answerer
        .respond(RouterAnswer::Result(Bytes::from(vec![0; 0x100_0001])))
        .await;

    assert!(
        matches!(refused, Err(CallError::Failure(failure))
        if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get()),
        "the payload's limit refuses the answer"
    );
    assert!(
        served.transport.take().is_empty(),
        "the oversized answer sends nothing"
    );
    served
        .transport
        .deliver(&request_of((5, &echo(), "")), &first());
    served.settle().await;
    answerer
        .respond(RouterAnswer::Failure(
            Failure::protocol(ProtocolCode::PROCEDURE_FAILED, RouterSide::Server).record(),
        ))
        .await
        .expect("fallback answered");
    served
        .transport
        .deliver(&request_of((5, &echo(), "")), &first());
    served.settle().await;
    let answerer = Arc::clone(&locked(&handed)[1].answerer);

    let refused = answerer
        .respond(RouterAnswer::Result(Bytes::from(vec![0; 0x100_0001])))
        .await;

    assert!(
        matches!(refused, Err(CallError::Failure(failure))
            if failure.code() == ProtocolCode::PAYLOAD_TOO_LARGE.get()),
        "the replacement's oversized answer is refused too"
    );
    answerer
        .respond(RouterAnswer::Failure(
            Failure::protocol(ProtocolCode::PROCEDURE_FAILED, RouterSide::Server).record(),
        ))
        .await
        .expect("replacement answered");
    served.settle().await;

    assert_eq!(call_ids(&handed), [5, 5], "the fallback frees the call id");
    assert_eq!(
        served.reported(),
        ["ENVELOPE_MALFORMED first"],
        "the duplicate before the fallback reported"
    );
    assert_eq!(
        served.sent_since(),
        [
            "first failure 5 PROCEDURE_FAILED",
            "first failure 5 PROCEDURE_FAILED"
        ],
        "the fallback answers each call"
    );
}
