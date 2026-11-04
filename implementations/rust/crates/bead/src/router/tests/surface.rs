//! A consumer's compile-time twins: private internals and values the typed surface refuses.

use crate::testing::surface::Consumer;

#[test]
fn lets_snapshot_records_grow_and_keeps_wire_records_exhaustive() {
    let consumer = Consumer::new();
    consumer.accepts("pub fn check(gauges: bead::Gauges, limits: bead::RouterLimits) { let bead::Gauges { counts, .. } = gauges; let bead::RouterLimits { chunk_bytes, .. } = limits; drop(counts); let _ = chunk_bytes; }");
    consumer.refuses("pub fn check(gauges: bead::Gauges) { let bead::Gauges { counts, ceilings, connection_handles, anomalies } = gauges; }", ("E0638", "`..` required"));
    consumer.refuses("pub fn check() { let _ = bead::Gauges { counts: Default::default(), ceilings: Default::default(), connection_handles: Default::default(), anomalies: Vec::new() }; }", ("E0639", "non-exhaustive"));
    consumer.accepts("pub fn check() { let _ = bead::ProcedureAddress { service_id: 1, procedure_id: 2 }; let _ = bead::RequestHeader { call_id: 1, service_id: 1, procedure_id: 2, destination_id: None, opens_subscription: false, paced: false, total: None, credential: None }; let _ = bead::AdmissionRefusal::new(bead::Failure::protocol(bead::ProtocolCode::ACCESS_DENIED, bead::RouterSide::Server)); }");
}

#[test]
fn keeps_the_router_core_the_envelope_codec_and_the_transports_credential_out_of_the_public_surface()
 {
    let consumer = Consumer::new();
    for item in [
        "core::Core",
        "core::Side",
        "core::Dispatch",
        "requester::CoreRequest",
        "core::BeforeAnswer",
        "core::SessionRequest",
    ] {
        consumer.refuses(
            &format!("use bead::router::{item};"),
            ("E0603", "module `router` is private"),
        );
    }
    for item in [
        "Core",
        "Side",
        "Dispatch",
        "CoreRequest",
        "BeforeAnswer",
        "Envelope",
        "Prefix",
        "ReadEnvelopeOptions",
        "read_envelope",
        "write_envelope",
    ] {
        consumer.refuses(
            &format!("use bead::{item};"),
            ("E0432", "unresolved import"),
        );
    }
    // * the session provider's request is public, as the other sides' is, and holds no credential
    consumer.refuses(
        "pub fn check(request: &bead::SessionRequest<'_>) { let _secret = &request.carried; }",
        ("E0609", "no field `carried`"),
    );
    for item in ["RequestResolverProps", "AdmissionRequest"] {
        consumer.refuses(
            &format!("pub fn check(props: &bead::{item}) {{ let _secret = &props.carried; }}"),
            ("E0616", "field `carried`"),
        );
        consumer.refuses(&format!("pub fn check(props: &bead::{item}) {{ let _secret = &props.transport_credential; }}"), ("E0609", "no field `transport_credential`"));
    }
    consumer.refuses("pub fn check(resolver: &bead::ResolverOf<bead::TextCodec, bead::TextCodec>) { let _forward = resolver.forwards_credentials; }", ("E0609", "no field `forwards_credentials`"));
}

#[test]
fn refuse_a_failure_whose_code_is_not_one_sending_nothing_and_telling_nothing() {
    let consumer = Consumer::new();
    consumer.accepts("pub fn check() -> bead::FailureRecord { bead::FailureRecord { code: core::num::NonZeroU16::MIN, scope: bead::FailureScope::Application, detail: String::new(), relays: 0 } }");
    consumer.refuses("pub fn check() -> bead::RouterAnswer { bead::RouterAnswer::Failure(bead::FailureRecord { code: 0, scope: bead::FailureScope::Application, detail: String::new(), relays: 0 }) }", ("E0308", "mismatched types"));
}

#[test]
fn reports_a_refusal_of_admission_that_cannot_be_written_and_leaves_no_call_open_behind_it() {
    let consumer = Consumer::new();
    consumer.accepts("pub fn check() -> bead::AdmissionRefusal { bead::AdmissionRefusal::new(bead::Failure::application(core::num::NonZeroU16::MIN, \"\")) }");
    consumer.refuses("pub fn check() -> bead::AdmissionRefusal { bead::AdmissionRefusal::new(bead::Failure::application(0, \"\")) }", ("E0308", "mismatched types"));
}

#[test]
fn a_server_does_not_subscribe_it_notifies() {
    let consumer = Consumer::new();
    consumer.accepts("pub fn check(router: &bead::RouterServer) { let _notify = bead::RouterServer::notify; let _unsubscribe = bead::RouterServer::unsubscribe; let _manager = bead::ServiceManager::new(bead::ServiceRouter::Server(router.clone()), &bead::ServiceManagerOptions::default()); }");
    for method in [
        "has_notification",
        "register_notification",
        "unregister_notification",
    ] {
        consumer.refuses(
            &format!("pub fn check(router: &bead::RouterServer) {{ router.{method}(); }}"),
            ("E0599", "no method named"),
        );
    }
}

#[test]
fn refuses_end_sessions_of_an_issuer_that_is_no_string_ending_nothing() {
    let consumer = Consumer::new();
    consumer.accepts("pub fn check(router: &bead::RouterServer) { drop(router.end_sessions_of(String::new())); }");
    for value in [
        "()",
        "None::<String>",
        "7",
        "bead::SessionIdentifier::Elsewhere { id: String::new() }",
    ] {
        consumer.refuses(&format!("pub fn check(router: &bead::RouterServer) {{ drop(router.end_sessions_of({value})); }}"), ("E0308", "mismatched types"));
    }
}
#[test]
fn exposes_the_runtime_types_its_options_name_and_owns_a_draws_error() {
    let consumer = Consumer::new();

    consumer.accepts("pub fn check(runtime: Option<bead::Handle>, signal: Option<bead::CancellationToken>) { let mut clock = bead::SystemClockOptions::default(); clock.runtime = runtime; let mut request = bead::RequestOptions::default(); request.signal = signal; }");
    consumer.accepts("pub fn check() -> Result<bead::SessionToken, bead::SessionTokenDrawError> { bead::SessionToken::draw(|_| false) }");
}
#[test]
fn seals_an_answerer_types_a_listed_code_and_exposes_each_refusal_as_an_error() {
    let consumer = Consumer::new();

    consumer.accepts("fn error<E: std::error::Error>() {} pub fn check() { error::<bead::DurationRefusal>(); error::<bead::IdentityRefusal>(); error::<bead::FilterRefusal>(); error::<bead::JwtRefusal>(); let _failure = bead::ListedFailure::new(\"CODE\", core::num::NonZeroU16::MIN); }");
    consumer.refuses(
        "pub fn check() { let _failure = bead::ListedFailure::new(\"CODE\", 0); }",
        ("E0308", "mismatched types"),
    );
    consumer.refuses("pub struct Outside; impl bead::Answerer for Outside { fn respond(&self, _: bead::RouterAnswer) -> bead::BoxFuture<Result<(), bead::CallError>> { Box::pin(async { Ok(()) }) } fn answered(&self) -> bead::BoxFuture<Option<bead::FailureRecord>> { Box::pin(async { None }) } fn subscribe(&self) -> bead::BoxFuture<Result<u32, bead::CallError>> { Box::pin(async { Ok(1) }) } }", ("E0277", "sealed::Answerer"));
}
