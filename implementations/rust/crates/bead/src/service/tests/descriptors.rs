//! A descriptor states its kind and requires a procedure and complete codecs.

use crate::constants::ProcedureKind;
use crate::payloads::TextCodec;
use crate::service::{AdmissionRule, DescriptorInit, command_of, notifying_of, request_of};
use crate::testing::pair::echo;
use crate::testing::surface::Consumer;

fn init() -> DescriptorInit<TextCodec, TextCodec> {
    DescriptorInit {
        procedure: crate::identity::Procedure {
            procedure_kind: None,
            ..echo()
        },
        admission: AdmissionRule::None,
        failures: vec![],
        request: TextCodec,
        result: TextCodec,
        validate: None,
    }
}

#[test]
fn sets_a_requests_kind_a_notifying_requests_and_a_commands() {
    for (service_id, name) in [(7, "sayHello"), (8, "echo")] {
        let mut given = init().procedure;
        given.service_id = service_id;
        given.procedure_name = name.to_owned();
        let request = request_of(DescriptorInit {
            procedure: given.clone(),
            ..init()
        })
        .expect("a request");
        let notifying = notifying_of(
            DescriptorInit {
                procedure: given.clone(),
                ..init()
            },
            TextCodec,
        )
        .expect("a notifying request");
        let command = command_of(DescriptorInit {
            procedure: given.clone(),
            ..init()
        })
        .expect("a command");
        assert_eq!(
            [
                request.procedure().procedure_kind,
                notifying.descriptor().procedure().procedure_kind,
                command.procedure().procedure_kind
            ],
            [
                Some(ProcedureKind::Request),
                Some(ProcedureKind::Notifies),
                Some(ProcedureKind::Command)
            ]
        );
        assert_eq!(given.procedure_kind, None);
        let stated = crate::identity::Procedure {
            procedure_kind: Some(ProcedureKind::Command),
            ..given
        };
        let command = command_of(DescriptorInit {
            procedure: stated.clone(),
            ..init()
        })
        .expect("its own kind stated");
        assert_eq!(*command.procedure(), stated);
    }
    let consumer = Consumer::new();
    consumer.accepts("pub fn check(d: &bead::Descriptor<bead::TextCodec, bead::TextCodec>) { let _ = d.procedure().procedure_id; }");
    consumer.refuses("pub fn check(d: &bead::Descriptor<bead::TextCodec, bead::TextCodec>) { d.procedure().procedure_id = 9; }", ("E0594", "cannot assign"));
}

#[test]
fn refuses_a_procedure_that_states_another_kind() {
    let mut request = init();
    request.procedure.procedure_kind = Some(ProcedureKind::Command);
    assert_eq!(
        request_of(request)
            .expect_err("a request cannot state command")
            .message(),
        "echo is of kind command, not request"
    );
    let mut notifying = init();
    notifying.procedure.procedure_kind = Some(ProcedureKind::Request);
    notifying_of(notifying, TextCodec).expect_err("a notifying request cannot state request");
    let mut command = init();
    command.procedure.procedure_kind = Some(ProcedureKind::Notifies);
    command_of(command).expect_err("a command cannot state notifies");
}

#[test]
fn refuses_a_descriptor_without_a_procedure() {
    let consumer = Consumer::new();
    let source = "pub fn check(p: bead::Procedure) { let init = bead::DescriptorInit { procedure: p, admission: bead::AdmissionRule::None, failures: vec![], request: bead::TextCodec, result: bead::TextCodec, validate: None }; let _ = bead::request_of(init); }";
    consumer.accepts(source);
    consumer.refuses(
        &source.replace("procedure: p, ", ""),
        ("E0063", "procedure"),
    );
    for procedure in ["None", "1", "\"echo\""] {
        for call in [
            "bead::request_of(init)",
            "bead::command_of(init)",
            "bead::notifying_of(init, bead::TextCodec)",
        ] {
            let invalid = source
                .replace("procedure: p", &format!("procedure: {procedure}"))
                .replace("bead::request_of(init)", call);
            consumer.refuses(&invalid, ("E0308", "mismatched types"));
        }
    }
}

#[test]
fn refuses_a_codec_missing() {
    let consumer = Consumer::new();
    let source = "pub fn check(p: bead::Procedure) { let init = bead::DescriptorInit { procedure: p, admission: bead::AdmissionRule::None, failures: vec![], request: bead::TextCodec, result: bead::TextCodec, validate: None }; let _ = bead::request_of(init); }";
    consumer.accepts(source);
    for member in ["request", "result"] {
        consumer.refuses(
            &source.replace(&format!("{member}: bead::TextCodec, "), ""),
            ("E0063", member),
        );
        consumer.refuses(
            &source.replace(
                &format!("{member}: bead::TextCodec"),
                &format!("{member}: ()"),
            ),
            ("E0277", "PayloadCodec"),
        );
    }
    consumer.refuses(
        &source.replace("bead::request_of(init)", "bead::notifying_of(init, ())"),
        ("E0277", "PayloadCodec"),
    );
    consumer.refuses(
        &source.replace("bead::request_of(init)", "bead::notifying_of(init)"),
        ("E0061", "2 arguments"),
    );
    consumer.refuses(
        &source.replace(
            "admission: bead::AdmissionRule::None",
            "admission: \"everyone\"",
        ),
        ("E0308", "mismatched types"),
    );
    consumer.refuses(
        &source.replace("validate: None", "validate: Some(true)"),
        ("E0308", "mismatched types"),
    );
    consumer.refuses(
        &source.replace(
            "bead::request_of(init)",
            "bead::command_of(init, bead::TextCodec)",
        ),
        ("E0061", "1 argument"),
    );
}

// a rule is a value of three: anybody, a session, or a hook by its name; a hook of no name is
// refused as its descriptor is made, where C# refuses it as the rule is made
#[test]
fn makes_a_rule_of_every_call_a_session_or_a_hook_by_its_name() {
    let hook_of = |rule: AdmissionRule| match rule {
        AdmissionRule::Hook(name) => Some(name),
        AdmissionRule::None | AdmissionRule::Session => None,
    };
    assert_eq!(
        [
            hook_of(AdmissionRule::None),
            hook_of(AdmissionRule::Session),
            hook_of(AdmissionRule::Hook("loud"))
        ],
        [None, None, Some("loud")]
    );
    assert_eq!(AdmissionRule::Hook("loud"), AdmissionRule::Hook("loud"));
    assert_ne!(AdmissionRule::None, AdmissionRule::Session);
    assert_eq!(
        request_of(DescriptorInit {
            admission: AdmissionRule::Hook(""),
            ..init()
        })
        .expect_err("a hook of no name")
        .message(),
        "echo's admission is none, session or a hook by name"
    );
}
