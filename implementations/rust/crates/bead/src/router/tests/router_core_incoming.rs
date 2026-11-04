//! Incoming calls, unsupported layouts, stray chunks and a closing connection's signals.

use core::time::Duration;
use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::router_core_rest::{asking, deliver_bytes, failed, held, serving};
use super::server::{first, request_of, second};
use super::{Handed, answer, answered, locked};
use crate::envelope::{ChunkHeader, CreditHeader, Envelope};
use crate::errors::CallError;
use crate::router::core::RequestResolverProps;
use crate::router::types::{CallAddress, RouterAnswer, SignalReason};
use crate::testing::pair::echo;

// debugging 5.2: Rust's transport boundary carries bytes, with no string frame or TypeError.
#[tokio::test]
async fn read_traced_then_dispatched_what_does_not_read_is_reported_not_traced() {
    use crate::constants::ProtocolCode;
    use crate::debug::DebugDirection;
    use crate::router::core as router_core;
    use crate::router::types::{RouterError, TransportMessage};
    use crate::testing::core_port::scripted_header;
    use crate::testing::scripted;

    let (peer, handed, admitted) = super::router_core_sessions::serving(None).await;
    let seen = Arc::clone(&handed);
    peer.owner
        .run(move |state| {
            state.on_trace = Some(Box::new(move |_, _| {
                assert!(locked(&seen).is_empty(), "traced before dispatch");
            }));
            for (data, handle) in [
                (Bytes::from_static(b"text"), "a"),
                (Bytes::from_static(&[0x0a, 0xff]), "b"),
                (
                    scripted::bytes_of(&Envelope::Request {
                        header: scripted_header(1),
                        payload: Bytes::from_static(&[7]),
                    }),
                    "a",
                ),
            ] {
                router_core::receive(
                    state,
                    (
                        TransportMessage {
                            data,
                            ..TransportMessage::default()
                        },
                        &Arc::from(handle),
                    ),
                );
            }
            assert_eq!(state.reports.len(), 2);
            for ((handle, error), expected) in state.reports.iter().zip(["a", "b"]) {
                assert_eq!(handle.as_ref(), expected);
                assert!(matches!(error, RouterError::Failure(failure)
                    if failure.protocol_code() == Some(ProtocolCode::ENVELOPE_MALFORMED)));
            }
            assert_eq!(state.traces.len(), 1);
            let (direction, traced) = &state.traces[0];
            assert_eq!(*direction, DebugDirection::Rx);
            assert_eq!(traced.connection_handle.as_ref(), "a");
            assert_eq!(
                traced.header,
                crate::envelope::EnvelopeHeader::Request(scripted_header(1))
            );
        })
        .await
        .expect("the read and trace turn");
    peer.settle().await;
    let seen = locked(&handed);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].connection_handle.as_ref(), "a");
    assert_eq!(seen[0].header, scripted_header(1));
    assert!(seen[0].is_admitted);
    assert_eq!(seen[0].payload, Bytes::from_static(&[7]));
    assert!(!seen[0].signal.is_aborted());
    drop(seen);
    assert_eq!(locked(&admitted).len(), 1, "admitted once before dispatch");
}

// spec 9.0
#[tokio::test]
async fn answers_a_request_its_codec_throws_on_other_than_a_refusal_envelope_malformed_with_no_detail_and_reports_the_error_with_its_connection()
 {
    use crate::constants::{FailureScope, ProtocolCode, RouterSide};
    use crate::envelope::{Credential, ReadEnvelopeOptions};
    use crate::router::types::RouterError;
    use crate::testing::core_port::{Peer, scripted_header};
    use std::error::Error;

    let peer = Peer::new(
        RouterSide::Server,
        &crate::router::types::RouterLimitsOptions::default(),
    );
    peer.owner
        .run(|state| {
            state.reader = Some(Box::new(|bytes| {
                let envelope = crate::envelope::read_envelope(
                    bytes,
                    RouterSide::Server,
                    &ReadEnvelopeOptions::default(),
                )
                .expect("the actual request reads")
                .expect("a request");
                let Envelope::Request { header, .. } = envelope else {
                    panic!("a request")
                };
                assert_eq!(header.call_id, 1);
                assert_eq!(
                    header.credential,
                    Some(Credential::Jwt(Bytes::from_static(b"a.b.c")))
                );
                panic!("internal: 10.0.0.5:8443");
            }));
        })
        .await
        .expect("the reader scripted");
    peer.receive((
        Envelope::Request {
            header: crate::envelope::RequestHeader {
                credential: Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
                ..scripted_header(1)
            },
            payload: Bytes::new(),
        },
        Arc::from("a"),
    ));
    peer.settle().await;
    peer.owner
        .run(|state| {
            assert_eq!(state.sent.len(), 1);
            let (handle, Envelope::Failure { header, failure }) = &state.sent[0] else {
                panic!("a failure answered")
            };
            assert_eq!(handle.as_ref(), "a");
            assert_eq!(header.call_id, 1);
            assert_eq!(failure.code, ProtocolCode::ENVELOPE_MALFORMED.get());
            assert_eq!(failure.scope, FailureScope::Protocol);
            assert_eq!(failure.detail, "");
            assert_eq!(state.reports.len(), 1);
            let (handle, RouterError::Failure(failure)) = &state.reports[0] else {
                panic!("a malformed envelope reported")
            };
            assert_eq!(handle.as_ref(), "a");
            assert_eq!(
                failure.protocol_code(),
                Some(ProtocolCode::ENVELOPE_MALFORMED)
            );
            assert_eq!(failure.detail(), "internal: 10.0.0.5:8443");
            let source = failure.source().expect("the codec's panic retained");
            assert!(source.is::<crate::transport::Panicked>());
            assert_eq!(
                source.to_string(),
                "an envelope codec panicked: internal: 10.0.0.5:8443"
            );
            assert!(!state.core.is_disposed());
        })
        .await
        .expect("the router stays live");
}

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
    let served = serving(Arc::new(move |props: RequestResolverProps| {
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
        matches!(answered(call).await, Err(CallError::Cancelled(_))),
        "the pending call stays until cancelled"
    );
}
