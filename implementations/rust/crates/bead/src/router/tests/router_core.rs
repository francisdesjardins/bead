//! The router core's tests, through a server's router over a scripted transport: what it takes in
//! and what it answers or reports, the resolvers it registers, and a cancel's call.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::server::{Served, first, header_of, name_of, request_of, second};
use super::{Handed, answer, cancel_of, failures_of, keeping, locked};
use crate::constants::{FailureScope, ProtocolCode};
use crate::envelope::{Credential, Envelope, FailureRecord, RequestHeader};
use crate::identity::Procedure;
use crate::router::core::{Handler, ResolveFn, ResolverProps};
use crate::router::server::RouterServerOptions;
use crate::router::types::{ConnectionHandle, RouterLimitsOptions, TransportMessage};
use crate::testing::pair::echo;

// a handler of `resolve`, which admits all and forwards nothing
fn handler_of(resolve: ResolveFn) -> Handler {
    Handler {
        resolve,
        admit: None,
        maximum_payload_bytes: None,
        forwards_credentials: false,
        notifies: false,
    }
}

// a server on `options`, both connections open, resolving `procedure` by keeping what it is handed
fn served_keeping((options, procedure): (&RouterServerOptions, &Procedure)) -> (Served, Handed) {
    let served = Served::new(options);
    let handed: Handed = Arc::default();

    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served
        .router
        .register_resolver((procedure, handler_of(keeping((&handed, None)))))
        .expect("registered");

    (served, handed)
}

// what each failure the server sent says: its connection, its call id and its code by name
fn answers_of(served: &Served) -> Vec<String> {
    served.sent_since()
}

fn bytes_of_hexadecimal(text: &str) -> Bytes {
    Bytes::from(crate::testing::hexadecimal::bytes_of(text).expect("hexadecimal"))
}

fn deliver_bytes(served: &Served, (bytes, handle): (Bytes, &ConnectionHandle)) {
    served.transport.deliver_message(
        &TransportMessage {
            data: bytes,
            ..TransportMessage::default()
        },
        handle,
    );
}

// a payload of `length` bytes, the alphabet over and over
fn pattern_of(length: usize) -> String {
    "abcdefghijklmnopqrstuvwxyz"
        .chars()
        .cycle()
        .take(length)
        .collect()
}

fn call_ids_of(handed: &Handed) -> Vec<u32> {
    locked(handed)
        .iter()
        .map(|props| props.header.call_id)
        .collect()
}

// ── What it takes in ─────────────────────────────────────────────────────────────────────────

// spec 9.3
#[tokio::test]
async fn refuses_a_request_for_a_destination_a_service_or_a_procedure_it_does_not_know_on_its_call_id_alone()
 {
    let nine = Procedure { id: 9, ..echo() };
    let (served, _handed) = served_keeping((&RouterServerOptions::default(), &nine));
    let eight = Procedure {
        service_id: 8,
        ..echo()
    };

    served
        .transport
        .deliver(&request_of((1, &eight, "")), &first());
    served
        .transport
        .deliver(&request_of((3, &echo(), "")), &first());
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                destination_id: Some(4),
                ..header_of((5, &echo()))
            },
            payload: Bytes::new(),
        },
        &second(),
    );
    served.settle().await;

    let sent = served.transport.take();

    assert_eq!(
        sent.iter()
            .map(|(handle, envelope)| match envelope {
                Envelope::Failure { header, failure } => format!(
                    "{} {} {} {:?}",
                    name_of(Some(handle)),
                    header.call_id,
                    ProtocolCode::new(failure.code).name().unwrap_or("?"),
                    header.credential
                ),
                Envelope::Request { .. }
                | Envelope::Result { .. }
                | Envelope::Notification { .. }
                | Envelope::Chunk { .. }
                | Envelope::Credit { .. }
                | Envelope::Cancel { .. } => format!("{envelope:?}"),
            })
            .collect::<Vec<_>>(),
        [
            "first 1 SERVICE_UNKNOWN None",
            "first 3 PROCEDURE_UNKNOWN None",
            "second 5 DESTINATION_UNKNOWN None"
        ],
        "each on its call id alone"
    );
    assert!(
        matches!(
            sent.first(),
            Some((_, Envelope::Failure { failure: FailureRecord { detail, relays: 0, scope: FailureScope::Protocol, .. }, .. }))
                if detail == "no service 8"
        ),
        "its record: {sent:?}"
    );
}

// spec 9.2
#[tokio::test]
async fn answers_capacity_exceeded_a_request_past_the_calls_its_peer_has_it_answer_on_its_connection_before_its_route_its_credential_or_its_transfer_and_takes_one_once_a_call_ends()
 {
    let options = RouterServerOptions {
        limits: Some(RouterLimitsOptions {
            buffered_bytes_budget: Some(1_024),
            chunk_bytes: Some(64),
            maximum_answering_calls: Some(2),
            maximum_envelope_bytes: Some(1_024),
            maximum_payload_bytes: Some(1_024),
            window_bytes: Some(128),
            ..RouterLimitsOptions::default()
        }),
        ..RouterServerOptions::default()
    };
    let (served, handed) = served_keeping((&options, &echo()));
    let eight = Procedure {
        service_id: 8,
        ..echo()
    };

    served
        .transport
        .deliver(&request_of((1, &echo(), "")), &first());
    served
        .transport
        .deliver(&request_of((3, &echo(), "")), &first());
    // another connection's calls are its own
    served
        .transport
        .deliver(&request_of((1, &echo(), "")), &second());
    served
        .transport
        .deliver(&request_of((5, &eight, "")), &first());
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                destination_id: Some(4),
                ..header_of((7, &echo()))
            },
            payload: Bytes::new(),
        },
        &first(),
    );
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                credential: Some(Credential::Jwt(Bytes::from_static(b"a.b.c"))),
                ..header_of((9, &echo()))
            },
            payload: Bytes::new(),
        },
        &first(),
    );
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                total: Some(100),
                ..header_of((11, &echo()))
            },
            payload: Bytes::from(pattern_of(8)),
        },
        &first(),
    );
    served.settle().await;

    assert_eq!(locked(&handed).len(), 3, "three taken");
    assert_eq!(
        failures_of(&served)
            .first()
            .map(|(_, detail)| detail.as_str()),
        Some("the calls a connection has answered at once are 2 at most"),
        "its detail"
    );
    assert_eq!(
        answers_of(&served),
        [
            "first failure 5 CAPACITY_EXCEEDED",
            "first failure 7 CAPACITY_EXCEEDED",
            "first failure 9 CAPACITY_EXCEEDED",
            "first failure 11 CAPACITY_EXCEEDED"
        ],
        "each refused before its route, its credential or its transfer"
    );

    // a call answered gives its place back, and the next request is taken
    answer(&handed, (0, b"")).await;
    served
        .transport
        .deliver(&request_of((13, &echo(), "")), &first());
    served.settle().await;

    assert_eq!(call_ids_of(&handed), [1, 3, 1, 13], "13 taken");
}

// spec 12.2
#[tokio::test]
async fn answers_envelope_too_large_a_request_that_came_whole_past_chunk_bytes_and_holds_nothing_of_it()
 {
    let options = RouterServerOptions {
        limits: Some(RouterLimitsOptions {
            buffered_bytes_budget: Some(1_024),
            chunk_bytes: Some(64),
            maximum_envelope_bytes: Some(1_024),
            maximum_payload_bytes: Some(1_024),
            window_bytes: Some(128),
            ..RouterLimitsOptions::default()
        }),
        ..RouterServerOptions::default()
    };
    let (served, handed) = served_keeping((&options, &echo()));

    // 12 bytes of header, then 53 of payload: one past chunkBytes, within an envelope
    served
        .transport
        .deliver(&request_of((1, &echo(), &pattern_of(53))), &first());
    // an opening past it too
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                total: Some(300),
                ..header_of((3, &echo()))
            },
            payload: Bytes::from(pattern_of(49)),
        },
        &first(),
    );
    // a request of chunkBytes, taken
    served
        .transport
        .deliver(&request_of((5, &echo(), &pattern_of(52))), &first());
    served.settle().await;

    let failures = failures_of(&served);

    assert_eq!(
        answers_of(&served),
        [
            "first failure 1 ENVELOPE_TOO_LARGE",
            "first failure 3 ENVELOPE_TOO_LARGE"
        ],
        "both refused"
    );
    assert_eq!(
        failures.first().map(|(_, detail)| detail.as_str()),
        Some("a request is 64 bytes at most, not 65"),
        "its detail"
    );
    assert_eq!(call_ids_of(&handed), [5], "the one of chunkBytes taken");

    let gauges = served.router.gauges().await;

    assert_eq!(
        (
            gauges.counts.get("answeringCalls"),
            gauges.counts.get("receivingTransfers")
        ),
        (Some(&1), Some(&0)),
        "nothing held of the others"
    );
}

// spec 3.4
#[tokio::test]
async fn reports_the_kinds_to_come_and_skips_the_advisory_ones_in_silence() {
    let served = Served::new(&RouterServerOptions::default());
    let traced: Arc<Mutex<Vec<u32>>> = Arc::default();
    let tracing = Arc::clone(&traced);

    served.transport.open(&first(), true);
    served.router.on_debug(Arc::new(
        move |_direction: crate::debug::DebugDirection, envelope: &crate::debug::TracedEnvelope| {
            locked(&tracing).push(envelope.header.call_id());
        },
    ));

    for kind in ["17", "7F", "80", "FF"] {
        deliver_bytes(
            &served,
            (
                bytes_of_hexadecimal(&format!("A1 {kind} 00 02  00 00 00 03")),
                &first(),
            ),
        );
    }

    served.settle().await;

    assert!(served.transport.take().is_empty(), "nothing sent");
    assert_eq!(
        served.reported(),
        ["KIND_UNSUPPORTED first", "KIND_UNSUPPORTED first"],
        "the kinds to come reported, the advisory ones skipped"
    );
    // none traced: the advisory ones skipped before it, the others reported as they do not read
    assert!(locked(&traced).is_empty(), "none traced");
}

// spec 12.2
#[tokio::test]
async fn routes_a_request_that_opens_a_transfer_then_refuses_it_its_route_first() {
    let (served, handed) = served_keeping((&RouterServerOptions::default(), &echo()));
    let transfer = "00 00 00 00 02 80 00 00";
    let nine = Procedure {
        service_id: 9,
        ..echo()
    };

    deliver_bytes(
        &served,
        (
            bytes_of_hexadecimal(&format!(
                "A1 10 04 05  00 00 00 01  00 08 00 01  {transfer}"
            )),
            &first(),
        ),
    );
    deliver_bytes(
        &served,
        (
            bytes_of_hexadecimal(&format!(
                "A1 10 06 06  00 00 00 03  00 02 00 01  00 00 00 04  {transfer}"
            )),
            &first(),
        ),
    );
    deliver_bytes(
        &served,
        (
            bytes_of_hexadecimal(&format!(
                "A1 10 04 05  00 00 00 05  00 02 00 01  {transfer}  01"
            )),
            &first(),
        ),
    );
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                total: Some(300),
                ..header_of((7, &nine))
            },
            payload: Bytes::from(pattern_of(44)),
        },
        &first(),
    );
    served.transport.deliver(
        &Envelope::Request {
            header: RequestHeader {
                destination_id: Some(7),
                total: Some(300),
                ..header_of((9, &echo()))
            },
            payload: Bytes::from(pattern_of(40)),
        },
        &first(),
    );
    served.settle().await;

    assert_eq!(
        answers_of(&served),
        [
            "first failure 1 SERVICE_UNKNOWN",
            "first failure 3 DESTINATION_UNKNOWN",
            "first failure 5 PAYLOAD_TOO_LARGE",
            "first failure 7 SERVICE_UNKNOWN",
            "first failure 9 DESTINATION_UNKNOWN"
        ],
        "its route first"
    );
    assert!(locked(&handed).is_empty(), "none taken");
}

// spec 5.2
#[tokio::test]
async fn answers_an_envelope_larger_than_it_reads_on_its_call_id() {
    let served = Served::new(&RouterServerOptions::default());
    let mut large = vec![0_u8; 16_778_241];

    served.transport.open(&first(), true);
    large[..12].copy_from_slice(
        &crate::testing::hexadecimal::bytes_of("A1 10 00 03  00 00 00 03  00 02 00 01")
            .expect("hexadecimal"),
    );
    deliver_bytes(&served, (Bytes::from(large), &first()));
    served.settle().await;

    assert_eq!(
        answers_of(&served),
        ["first failure 3 ENVELOPE_TOO_LARGE"],
        "on its call id"
    );
}

// a resolver that fails at once, as the TypeScript side's throws, or once it has waited, as its
// rejects
fn failing(waits: bool) -> ResolveFn {
    Arc::new(move |_props: ResolverProps| {
        Box::pin(async move {
            if waits {
                tokio::task::yield_now().await;

                return Err(crate::errors::ResolverError::other(std::io::Error::other(
                    "rejected",
                )));
            }

            Err(crate::errors::ResolverError::other(std::io::Error::other(
                "thrown",
            )))
        })
    })
}

// spec 9.0
#[tokio::test]
async fn reports_a_resolver_that_throws_or_rejects_with_its_connection() {
    let served = Served::new(&RouterServerOptions::default());
    let two = Procedure { id: 2, ..echo() };

    served.transport.open(&first(), true);
    served.transport.open(&second(), true);
    served
        .router
        .register_resolver((&echo(), handler_of(failing(false))))
        .expect("registered");
    served
        .router
        .register_resolver((&two, handler_of(failing(true))))
        .expect("registered");
    served
        .transport
        .deliver(&request_of((1, &echo(), "")), &first());
    served
        .transport
        .deliver(&request_of((3, &two, "")), &second());
    served.settle().await;

    assert_eq!(
        served.reported(),
        ["thrown first", "rejected second"],
        "each with its connection"
    );
}

// a u16 holds no service or procedure 0x10000 nor 1.5: those the TypeScript side refuses, the
// type refuses here
// spec 16.2
#[tokio::test]
async fn refuses_a_second_resolver_for_one_procedure_and_an_address_a_revision_or_a_name_outside_section_16()
 {
    let served = Served::new(&RouterServerOptions::default());
    let register = |procedure: &Procedure| {
        served
            .router
            .register_resolver((procedure, handler_of(failing(false))))
    };

    register(&echo()).expect("echo registered");

    assert!(
        register(&Procedure {
            name: "again".to_owned(),
            ..echo()
        })
        .is_err(),
        "a second resolver"
    );

    for procedure in [
        Procedure { id: 0, ..echo() },
        Procedure {
            service_id: 0,
            ..echo()
        },
        Procedure {
            service_revision: 0,
            ..echo()
        },
        Procedure {
            service_revision: 1 << 31,
            ..echo()
        },
    ] {
        let refusal = register(&Procedure {
            id: if procedure.id == 0 { 0 } else { 2 },
            ..procedure
        })
        .map_or_else(|error| error.to_string(), |()| String::new());

        assert!(
            refusal.contains(" is out of its range: "),
            "out of its range: {refusal}"
        );
    }

    for name in ["Echo", "_OTHER", "echo\n", "get_thing", &"a".repeat(64)] {
        let refusal = register(&Procedure {
            id: 2,
            name: name.to_owned(),
            ..echo()
        })
        .map_or_else(|error| error.to_string(), |()| String::new());

        assert!(
            refusal.contains(" is off its form: "),
            "{name:?} off its form: {refusal}"
        );
    }

    // its identity before any reason of the router's: a payload limit of 0, at service 0
    let limited = |procedure: Procedure| {
        served.router.register_resolver((
            &procedure,
            Handler {
                maximum_payload_bytes: Some(0),
                ..handler_of(failing(false))
            },
        ))
    };

    assert!(
        limited(Procedure { id: 9, ..echo() }).is_err(),
        "a limit of 0"
    );
    assert!(
        limited(Procedure {
            service_id: 0,
            ..echo()
        })
        .map_or_else(|error| error.to_string(), |()| String::new())
        .contains(" is out of its range: "),
        "its identity first"
    );

    register(&Procedure {
        id: 0xffff,
        service_id: 0xffff,
        service_revision: (1 << 31) - 1,
        ..echo()
    })
    .expect("the last of each range");
}

// ── A cancel ─────────────────────────────────────────────────────────────────────────────────

// what the TypeScript side offers its port's onCancel is the server's own here, which ends the
// subscriptions the call opened; what is observed is the call: its signal, its call id, silence
// spec 10.2
#[tokio::test]
async fn forgets_a_call_its_requester_cancels_then_cancels_its_signal_nothing_answers_it_and_its_call_id_is_free()
 {
    let (served, handed) = served_keeping((&RouterServerOptions::default(), &echo()));

    served
        .transport
        .deliver(&request_of((5, &echo(), "")), &first());
    served.transport.deliver(&cancel_of(5), &first());
    served.settle().await;

    // an answer from what hears the signal finds no call to answer
    let answered = locked(&handed)
        .first()
        .map(|props| Arc::clone(&props.answerer))
        .expect("handed");

    // what it settles to is no one's to hear of: nothing goes out, as the end asserts
    drop(
        answered
            .respond(crate::router::types::RouterAnswer::Result(
                Bytes::from_static(b"1"),
            ))
            .await,
    );

    // free again: a request on it is dispatched
    served
        .transport
        .deliver(&request_of((5, &echo(), "")), &first());
    served.settle().await;

    assert_eq!(call_ids_of(&handed), [5, 5], "dispatched again");
    assert_eq!(
        locked(&handed)
            .iter()
            .map(|props| props.signal.reason())
            .collect::<Vec<_>>(),
        [Some(crate::router::types::SignalReason::Cancelled), None],
        "the first one's signal cancelled, as its requester cancelled it"
    );
    assert!(served.transport.take().is_empty(), "nothing answers it");
    assert!(served.reported().is_empty(), "nothing reported");
}

// spec 10.2
#[tokio::test]
async fn takes_a_cancel_of_no_call_in_silence_offered_to_the_side_and_reports_one_of_its_own_parity()
 {
    let served = Served::new(&RouterServerOptions::default());

    served.transport.open(&first(), true);
    // crossed its answer, say
    served.transport.deliver(&cancel_of(7), &first());
    // a call this side opened is not the peer's to cancel
    served.transport.deliver(&cancel_of(2), &first());
    served.settle().await;

    assert_eq!(
        served.reported(),
        ["ENVELOPE_MALFORMED first"],
        "its own parity reported"
    );
    assert!(served.transport.take().is_empty(), "nothing sent");
}
