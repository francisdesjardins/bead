//! The Rust side's testee of protobuf's conformance suite (decisions 0028 and 0044), as the suite's
//! runner drives one: on the standard input, each `ConformanceRequest` after its length, a 32-bit
//! little-endian integer; on the standard output, each `ConformanceResponse` alike, until the input
//! ends. Each message is read and written back through `bead_protobuf`'s codec of the code Buffa
//! generates for it, found by the message's full name: its records checked, its view decoded within
//! the bound, its required fields walked, then the owned message, written back. Its JSON, which the
//! other sides read and write by Bead's own mapping (decision 0037), goes through Buffa's dynamic
//! message by the pool the generated code embeds until Rust's gateway brings that mapping: a JSON
//! payload is read into the dynamic message, then its bytes read as the codec reads a payload.

use std::io::{self, Read, Write};
use std::process::ExitCode;
use std::sync::{Arc, LazyLock};

use bead::PayloadCodec;
use bead_protobuf::{ProtoCodec, ProtoSchema};
use buffa::{EnumValue, Message};
use buffa_descriptor::reflect::{DynamicMessage, ReflectMessage};
use bytes::Bytes;

/// The suite's messages, its exchange and `Probe`, as the build script generates them.
mod generated {
    include!(concat!(env!("OUT_DIR"), "/_include.rs"));
}

use generated::conformance::__buffa::oneof::conformance_request::Payload;
use generated::conformance::__buffa::oneof::conformance_response::Result as Answer;
use generated::conformance::{ConformanceRequest, ConformanceResponse, TestCategory, WireFormat};
use generated::protobuf_test_messages::{editions, proto2, proto3};

/// A message the suite sends, read and written back through its codec.
trait Codec: Send + Sync {
    /// Its message's schema, by the pool its generated code embeds.
    fn schema(&self) -> &ProtoSchema;

    /// `bytes` read, then written back as bytes or, where `json` says, as JSON.
    fn round_trip(&self, bytes: &Bytes, json: bool) -> Answer;
}

impl<M> Codec for ProtoCodec<M>
where
    M: ReflectMessage,
    ProtoCodec<M>: PayloadCodec<Value = M>,
{
    fn schema(&self) -> &ProtoSchema {
        ProtoCodec::schema(self)
    }

    fn round_trip(&self, bytes: &Bytes, json: bool) -> Answer {
        let message = match self.decode(bytes) {
            Ok(message) => message,
            Err(refusal) => return Answer::ParseError(refusal.to_string()),
        };

        if json {
            return match message.to_dynamic().to_json() {
                Ok(json) => Answer::JsonPayload(json),
                Err(error) => Answer::SerializeError(format!("json: {error}")),
            };
        }

        match self.encode(&message) {
            Ok(written) => Answer::ProtobufPayload(written.to_vec()),
            Err(refusal) => Answer::SerializeError(refusal.to_string()),
        }
    }
}

// each message the suite sends, by its full name, and its codec
static CODECS: LazyLock<Vec<(&str, Box<dyn Codec>)>> = LazyLock::new(|| {
    vec![
        (
            "protobuf_test_messages.proto3.TestAllTypesProto3",
            Box::new(ProtoCodec::<proto3::TestAllTypesProto3>::new()),
        ),
        (
            "protobuf_test_messages.proto2.TestAllTypesProto2",
            Box::new(ProtoCodec::<proto2::TestAllTypesProto2>::new()),
        ),
        (
            "protobuf_test_messages.editions.TestAllTypesEdition2023",
            Box::new(ProtoCodec::<editions::TestAllTypesEdition2023>::new()),
        ),
        (
            "protobuf_test_messages.editions.proto2.TestAllTypesProto2",
            Box::new(ProtoCodec::<editions::proto2::TestAllTypesProto2>::new()),
        ),
        (
            "protobuf_test_messages.editions.proto3.TestAllTypesProto3",
            Box::new(ProtoCodec::<editions::proto3::TestAllTypesProto3>::new()),
        ),
        (
            "bead.codecs.v1.Probe",
            Box::new(ProtoCodec::<generated::bead::codecs::v1::Probe>::new()),
        ),
    ]
});

fn answer(request: &ConformanceRequest) -> Answer {
    // the runner asks first which tests a testee expects to fail: none of its own, the failure list
    // the tool gives the runner names them
    if request.message_type == "conformance.FailureSet" {
        return Answer::ProtobufPayload(Vec::new());
    }

    let output = request.requested_output_format;

    // ! Bead's proto carries the binary form and protobuf's JSON mapping alone; a skip never hides
    // a binary or a JSON test of a form Bead reads
    if matches!(
        request.payload,
        Some(Payload::JspbPayload(_) | Payload::TextPayload(_))
    ) || output == EnumValue::from(WireFormat::JSPB)
        || output == EnumValue::from(WireFormat::TEXT_FORMAT)
    {
        return Answer::Skipped(
            "Bead's proto carries the binary form and protobuf's JSON mapping alone".to_owned(),
        );
    }

    if request.test_category == EnumValue::from(TestCategory::JSON_IGNORE_UNKNOWN_PARSING_TEST) {
        return Answer::Skipped(
            "Bead's mapping refuses an unknown member, and takes no option to ignore one"
                .to_owned(),
        );
    }

    if request
        .message_type
        .starts_with("protobuf_test_messages.edition_unstable.")
    {
        return Answer::Skipped(
            "an unstable edition, which no stock generator compiles".to_owned(),
        );
    }

    // ! a message gone fails its tests, rather than skipping them
    let Some((_, codec)) = CODECS
        .iter()
        .find(|(name, _)| *name == request.message_type)
    else {
        return Answer::RuntimeError(format!("no procedure binds {}", request.message_type));
    };

    // * a JSON payload read by the dynamic message, then its bytes read as the codec reads a payload
    let bytes = match &request.payload {
        Some(Payload::ProtobufPayload(bytes)) => Bytes::copy_from_slice(bytes),
        Some(Payload::JsonPayload(json)) => {
            let schema = codec.schema();

            match DynamicMessage::from_json(Arc::clone(schema.pool()), schema.message(), json) {
                Ok(message) => Bytes::from(message.encode_to_vec()),
                Err(error) => return Answer::ParseError(format!("json: {error}")),
            }
        }
        _ => return Answer::RuntimeError("no payload".to_owned()),
    };

    codec.round_trip(&bytes, output == EnumValue::from(WireFormat::JSON))
}

// one exchange: a request read after its length, its response written after its own; none once
// the input ends
fn exchange(input: &mut impl Read, output: &mut impl Write) -> io::Result<bool> {
    let mut head = [0_u8; 4];

    if let Err(error) = input.read_exact(&mut head) {
        return if error.kind() == io::ErrorKind::UnexpectedEof {
            Ok(false)
        } else {
            Err(error)
        };
    }

    let length = usize::try_from(u32::from_le_bytes(head)).map_err(io::Error::other)?;
    let mut bytes = vec![0_u8; length];

    input.read_exact(&mut bytes)?;

    let request = ConformanceRequest::decode_from_slice(&bytes).map_err(io::Error::other)?;
    let response = ConformanceResponse {
        result: Some(answer(&request)),
        ..ConformanceResponse::default()
    }
    .encode_to_vec();
    let length = u32::try_from(response.len()).map_err(io::Error::other)?;

    output.write_all(&length.to_le_bytes())?;
    output.write_all(&response)?;
    output.flush()?;

    Ok(true)
}

fn main() -> ExitCode {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();

    loop {
        match exchange(&mut input, &mut output) {
            Ok(true) => {}
            Ok(false) => return ExitCode::SUCCESS,
            Err(error) => {
                let _ = writeln!(io::stderr(), "testee: {error}");

                return ExitCode::FAILURE;
            }
        }
    }
}
