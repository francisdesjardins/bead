//! A consumer's compile-time twins: private internals and values the typed surface refuses.

use crate::testing::surface::Consumer;

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
        "SessionRequest",
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
    for item in ["ResolverProps", "AdmissionRequest"] {
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
    consumer.accepts("pub fn check() -> bead::AdmissionRefusal { bead::AdmissionRefusal { failure: bead::Failure::application(core::num::NonZeroU16::MIN, \"\"), by: None } }");
    consumer.refuses("pub fn check() -> bead::AdmissionRefusal { bead::AdmissionRefusal { failure: bead::Failure::application(0, \"\"), by: None } }", ("E0308", "mismatched types"));
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
