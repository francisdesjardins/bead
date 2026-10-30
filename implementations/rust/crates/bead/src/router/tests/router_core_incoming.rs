//! Incoming calls, unsupported layouts, stray chunks and a closing connection's signals.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::router_core_rest::{asking, deliver_bytes, failed, held, serving};
use super::server::{first, request_of, second};
use super::{Handed, answer, answered, locked};
use crate::envelope::{ChunkHeader, CreditHeader, Envelope};
use crate::errors::CallError;
use crate::router::core::ResolverProps;
use crate::router::types::{CallAddress, RouterAnswer, SignalReason};
use crate::testing::pair::echo;

// spec 9.1
#[tokio::test]
async fn reports_a_request_of_its_own_parity_or_on_a_call_open_and_answers_the_open_one_once() {
    let (served, handed) = held();

    for (call_id, handle) in [(5, first()), (5, first()), (4, first()), (5, second())] {
        served
            .transport
            .deliver(&request_of((call_id, &echo(), "")), &handle);
    }
    served.settle().await;
    assert_eq!(
        locked(&handed).len(),
        2,
        "only the two distinct calls dispatched"
    );
    answer(&handed, (0, &[2])).await;
    answer(&handed, (1, &[2])).await;
    served.settle().await;

    assert_eq!(
        served.reported(),
        ["ENVELOPE_MALFORMED first", "ENVELOPE_MALFORMED first"],
        "the duplicate and this side's parity reported"
    );
    let sent = served.transport.take();

    assert_eq!(
        sent.iter()
            .map(|(handle, envelope)| {
                if let Envelope::Result { header, payload } = envelope {
                    (Arc::clone(handle), header.call_id, payload.clone())
                } else {
                    panic!("a result expected: {envelope:?}");
                }
            })
            .collect::<Vec<_>>(),
        [
            (first(), 5, Bytes::from_static(&[2])),
            (second(), 5, Bytes::from_static(&[2]))
        ],
        "each connection's call answered once"
    );
    served
        .transport
        .deliver(&request_of((5, &echo(), "")), &first());
    served.settle().await;

    assert_eq!(
        locked(&handed).len(),
        3,
        "the answered call id is the peer's again"
    );
    answer(&handed, (2, &[3])).await;
}

// spec 9.0
#[tokio::test]
async fn abort_the_signal_of_each_call_a_closing_connection_opened_and_of_no_other_once_nothing_can_answer_it()
 {
    let handed = Handed::default();
    let keeping = Arc::clone(&handed);
    let answers = Arc::new(Mutex::new(Vec::new()));
    let answering = Arc::clone(&answers);
    let served = serving(Arc::new(move |props: ResolverProps| {
        let signal = props.signal.clone();
        let answerer = Arc::clone(&props.answerer);
        let answering = Arc::clone(&answering);

        locked(&keeping).push(props);
        Box::pin(async move {
            signal.token().cancelled().await;
            let outcome = answerer
                .respond(RouterAnswer::Result(Bytes::from_static(&[1])))
                .await;

            locked(&answering).push(outcome);
            failed("stopped")
        })
    }));

    served
        .transport
        .deliver(&request_of((5, &echo(), "")), &first());
    served
        .transport
        .deliver(&request_of((5, &echo(), "")), &second());
    served.settle().await;
    served
        .router
        .owner()
        .run(|state| {
            crate::router::core::reject_pending(state, ("a closed", Some(&first())));
        })
        .await
        .expect("first closed");
    served.settle().await;

    assert_eq!(
        locked(&handed)
            .iter()
            .map(|props| props.signal.reason())
            .collect::<Vec<_>>(),
        [
            Some(SignalReason::Disconnected("a closed".to_owned())),
            None
        ],
        "only the closing connection's signal aborted, with its reason"
    );
    assert!(
        matches!(locked(&answers).as_slice(), [Ok(())]),
        "only its resolver attempts an answer, after the call is detached"
    );
    assert!(
        served.transport.take().is_empty(),
        "the detached call answers nothing"
    );
    assert!(
        served.reported().is_empty(),
        "the cancelled resolver's failure is not reported"
    );
}

// spec 3.1, 9.1
#[tokio::test]
async fn answers_a_request_of_a_layout_to_come_with_the_layouts_it_reads_under_one_rule() {
    let (served, _handed) = held();

    served
        .transport
        .deliver(&request_of((7, &echo(), "")), &first());
    served
        .router
        .owner()
        .run(|state| {
            state
                .notifications
                .register(
                    echo().address(),
                    &crate::managers::notification::SubscribingCall {
                        call_id: 9,
                        connection_handle: first(),
                        end: None,
                        identifier: None,
                        paced: false,
                        series: None,
                    },
                )
                .expect("call 9 held by the side");
        })
        .await
        .expect("call held");
    for layout in ["A2", "AF"] {
        for tail in [
            "10 00 03  00 00 00 03  00 02 00 01",
            "10 00 03  00 00 00 04  00 02 00 01",
            "10 00 03  00 00 00 07  00 02 00 01",
            "10 00 03  00 00 00 09  00 02 00 01",
            "11 00 02  00 00 00 0B",
            "10 00 03  00 00 00",
        ] {
            deliver_bytes(&served, &format!("{layout} {tail}"));
        }
    }
    served.settle().await;

    let sent = served.transport.envelopes(&first());

    assert!(
        matches!(sent.first(), Some(Envelope::Failure { failure, .. }) if failure.detail == "0xA1"),
        "the layouts it reads named as detail"
    );
    assert_eq!(
        served.sent_since(),
        [
            "first failure 3 LAYOUT_UNSUPPORTED",
            "first failure 3 LAYOUT_UNSUPPORTED"
        ],
        "only a free call id of the peer's parity answered"
    );
    let per_layout = [
        "LAYOUT_UNSUPPORTED first",
        "LAYOUT_UNSUPPORTED first",
        "LAYOUT_UNSUPPORTED first",
        "LAYOUT_UNSUPPORTED first",
        "ENVELOPE_MALFORMED first",
    ];

    assert_eq!(
        served.reported(),
        per_layout.repeat(2),
        "its own parity, an open call, a held call, a result, then a cut prefix reported for each layout"
    );
}

// spec 10.4, 12.2
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the twin plays peer and local calls, a reservation, stray credits and the pending call cancelled"
)]
async fn report_a_chunk_no_transfer_takes_on_a_call_open_without_one_or_on_none_and_drop_one_on_a_call_id_reserved_and_a_credit_in_silence()
 {
    let (served, _handed) = held();
    let call = asking(&served, Duration::from_secs(1));

    served
        .transport
        .deliver(&request_of((1, &echo(), "")), &first());
    served
        .router
        .owner()
        .run(|state| {
            crate::router::requester::reserve(
                state,
                (
                    &CallAddress {
                        connection_handle: first(),
                        call_id: 6,
                    },
                    Some(Duration::from_secs(5)),
                ),
            );
        })
        .await
        .expect("call 6 reserved");
    for call_id in [1, 3, 2, 4, 6] {
        served.transport.deliver(
            &Envelope::Chunk {
                header: ChunkHeader {
                    call_id,
                    offset: 0,
                    is_last: false,
                },
                payload: Bytes::from_static(&[1]),
            },
            &first(),
        );
    }
    for call_id in [1, 2, 9] {
        served.transport.deliver(
            &Envelope::Credit {
                header: CreditHeader {
                    call_id,
                    credit_end: 8,
                    paced: false,
                },
            },
            &first(),
        );
    }
    served.settle().await;

    assert_eq!(
        served.sent_since(),
        ["first request 2 "],
        "nothing sent for a stray chunk or credit"
    );
    assert_eq!(
        served.reported(),
        [
            "ENVELOPE_MALFORMED first",
            "CALL_UNKNOWN first",
            "ENVELOPE_MALFORMED first",
            "CALL_UNKNOWN first"
        ],
        "only unreserved chunks reported, with their connection"
    );
    {
        let reports = locked(&served.reports);

        assert!(
            reports[0]
                .0
                .to_string()
                .contains("call 1 receives no transfer"),
            "the peer's open call named"
        );
        assert!(
            reports[2]
                .0
                .to_string()
                .contains("call 2 receives no transfer"),
            "this side's open call named"
        );
        drop(reports);
    }
    served
        .router
        .owner()
        .run(|state| {
            crate::router::requester::cancel(
                state,
                (
                    &CallAddress {
                        connection_handle: first(),
                        call_id: 2,
                    },
                    None,
                ),
            );
        })
        .await
        .expect("call cancelled");

    assert!(
        matches!(answered(call).await, Err(CallError::Cancelled)),
        "the pending call stays until cancelled"
    );
}
