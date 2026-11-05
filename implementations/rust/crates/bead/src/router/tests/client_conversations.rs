//! Typed calls and commands through a pair, and a result refused by its caller's codec.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use serde_json::{Value, json};

use super::{Scripted, locked, request_header_of};
use crate::constants::{ProcedureKind, ProtocolCode, RouterSide};
use crate::debug::DebugDirection;
use crate::envelope::{Envelope, ResultHeader};
use crate::errors::{CallError, ResolverError};
use crate::failure::{FailureOrigin, ProcedureAddress};
use crate::managers::service::{
    CommandOptions, RequestDependencies, RequestOptions, RequestResolverDependencies,
};
use crate::payloads::{CodecRefusal, JsonCodec, PayloadCodec, TextCodec};
use crate::router::types::RouterAnswer;
use crate::testing::pair::{Pair, PairOptions, echo};

async fn pair() -> Pair {
    Pair::connected(super::january_first(), &PairOptions::default())
        .await
        .expect("a connected pair")
}

fn offer_echo(pair: &Pair) {
    pair.server
        .services()
        .get_request_resolver(
            &echo(),
            RequestResolverDependencies::new(JsonCodec, JsonCodec),
        )
        .expect("echo defined")
        .on(Arc::new(|request, response| {
            response.result(request.payload)
        }))
        .expect("echo offered");
}

#[tokio::test]
async fn calls_a_procedure_with_a_payload_then_options_and_gives_its_result_decoded() {
    let pair = pair().await;
    offer_echo(&pair);
    let request = pair
        .client
        .services()
        .get_request(&echo(), RequestDependencies::new(JsonCodec, JsonCodec))
        .expect("echo's requester");
    let result = request
        .call(json!({"a": [1, "two"]}), &RequestOptions::default())
        .expect("the call starts")
        .await
        .expect("the decoded result");
    assert_eq!(result, json!({"a": [1, "two"]}));
    assert!(locked(&pair.server_reports).is_empty());
    assert!(locked(&pair.client_reports).is_empty());
}

#[derive(Debug)]
struct Unreadable;

impl PayloadCodec for Unreadable {
    type Value = i32;

    fn decode(&self, _bytes: &Bytes) -> Result<i32, CodecRefusal> {
        Err(CodecRefusal::new("cannot read that result"))
    }

    fn encode(&self, value: &i32) -> Result<Bytes, CodecRefusal> {
        JsonCodec.encode(&json!(value))
    }

    fn encoding(&self) -> &'static str {
        "json"
    }
}

// spec 17.2.2
#[tokio::test]
async fn fails_a_result_that_does_not_decode_here_as_undecodable() {
    let pair = pair().await;
    offer_echo(&pair);
    let request = pair
        .client
        .services()
        .get_request(&echo(), RequestDependencies::new(JsonCodec, Unreadable))
        .expect("the caller's decoder");
    let Err(CallError::Failure(failure)) = request
        .call(Value::from(1), &RequestOptions::default())
        .expect("the call starts")
        .await
    else {
        panic!("the result is undecodable here");
    };
    assert_eq!(failure.code(), ProtocolCode::PAYLOAD_UNDECODABLE.get());
    assert_eq!(failure.origin(), FailureOrigin::Local);
    assert_eq!(failure.side(), Some(RouterSide::Client));
    assert_eq!(
        failure.procedure(),
        Some(ProcedureAddress {
            service_id: 2,
            procedure_id: 1
        })
    );
}

#[tokio::test]
async fn go_to_the_resolver_registered_for_their_procedure_on_even_call_ids_which_answers() {
    scripted_command().await;
    command_roundtrip().await;
}

async fn scripted_command() {
    let scripted = Scripted::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&seen);
    scripted
        .router
        .register_resolver((
            &crate::identity::Procedure {
                procedure_kind: Some(ProcedureKind::Command),
                ..echo()
            },
            super::client_commands::handler(Arc::new(move |props| {
                locked(&hearing).push((props.connection_handle, props.payload));
                Box::pin(async move {
                    props
                        .answerer
                        .respond(RouterAnswer::Result(Bytes::from_static(&[7])))
                        .await
                        .map_err(ResolverError::other)
                })
            })),
        ))
        .expect("the resolver registered");
    scripted.transport.deliver(&Envelope::Request {
        header: request_header_of(30),
        payload: Bytes::from_static(&[3]),
    });
    scripted.settle().await;
    assert_eq!(
        *locked(&seen),
        [(Arc::from("server"), Bytes::from_static(&[3]))]
    );
    assert_eq!(
        scripted.transport.envelopes(),
        [Envelope::Result {
            header: ResultHeader {
                call_id: 30,
                total: None,
                credential: None
            },
            payload: Bytes::from_static(&[7]),
        }]
    );
    assert_eq!(scripted.codes(), Vec::<String>::new());
}

async fn command_roundtrip() {
    let pair = pair().await;
    let clock = crate::identity::Procedure {
        procedure_id: 3,
        procedure_name: "clock".to_owned(),
        procedure_kind: Some(ProcedureKind::Command),
        ..echo()
    };
    let ask = crate::identity::Procedure {
        procedure_id: 2,
        procedure_name: "ask".to_owned(),
        ..echo()
    };
    let command = pair
        .server
        .services()
        .get_command(&clock, RequestDependencies::new(TextCodec, TextCodec))
        .expect("the server's command");
    pair.server
        .services()
        .get_request_resolver(&ask, RequestResolverDependencies::new(TextCodec, TextCodec))
        .expect("ask defined")
        .on(Arc::new(move |request, response| {
            let asked = command
                .call(
                    "now".to_owned(),
                    &CommandOptions {
                        timeout: Some(super::TIMEOUT),
                        ..CommandOptions::new(request.connection_handle)
                    },
                )
                .expect("the command starts");
            Box::pin(async move {
                response
                    .result(asked.await.map_err(ResolverError::other)?)
                    .await
            })
        }))
        .expect("ask offered");
    pair.client
        .services()
        .get_command_resolver(
            &clock,
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("clock defined")
        .on(Arc::new(|_request, response| {
            response.result("noon".to_owned())
        }))
        .expect("clock offered");
    let received = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&received);
    pair.client
        .router()
        .on_debug(Arc::new(move |direction, traced| {
            if direction == DebugDirection::Rx
                && matches!(traced.header, crate::envelope::EnvelopeHeader::Request(_))
            {
                locked(&hearing).push(traced.header.call_id());
            }
        }));
    let answer = pair
        .client
        .services()
        .get_request(&ask, RequestDependencies::new(TextCodec, TextCodec))
        .expect("ask's requester")
        .call(String::new(), &RequestOptions::default())
        .expect("the request starts")
        .await
        .expect("the command's answer returns through ask");
    assert_eq!(answer, "noon");
    assert_eq!(*locked(&received), [2]);
    assert!(locked(&pair.server_reports).is_empty());
    assert!(locked(&pair.client_reports).is_empty());
}

#[tokio::test]
async fn answers_the_command_its_server_asks_it_on_an_even_call_id() {
    scripted_command().await;
    let pair = bead::testing::pair::Pair::connected(
        bead::testing::instants::new_year(),
        &bead::testing::pair::PairOptions::default(),
    )
    .await
    .expect("a connected pair");
    let _interop = bead_interop::offer_interop(&pair.server).expect("the interop offered");
    let procedures = bead_interop::interop_procedures(None).expect("the interop descriptors");
    pair.client
        .services()
        .get_command_resolver(
            procedures.clock.procedure(),
            bead::RequestResolverDependencies::new(bead::JsonCodec, bead::JsonCodec),
        )
        .expect("the client's clock definition")
        .on(Arc::new(|request, response| {
            assert_eq!(
                request.payload,
                Value::String("What time is it where you are?".to_owned())
            );
            response.result(Value::String("noon".to_owned()))
        }))
        .expect("the clock offered");
    let received = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&received);
    pair.client
        .router()
        .on_debug(Arc::new(move |direction, traced| {
            if direction == bead::DebugDirection::Rx
                && matches!(traced.header, bead::EnvelopeHeader::Request(_))
            {
                hearing
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(traced.header.call_id());
            }
        }));
    let request = pair
        .client
        .services()
        .get_request(
            procedures.ask.procedure(),
            bead::RequestDependencies::new(bead::JsonCodec, bead::JsonCodec),
        )
        .expect("ask's requester");
    assert_eq!(
        request
            .call(Value::Null, &bead::RequestOptions::default())
            .expect("the call starts")
            .await
            .expect("the clock's answer"),
        Value::String("noon".to_owned())
    );
    assert_eq!(
        *received
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        [2]
    );
}
