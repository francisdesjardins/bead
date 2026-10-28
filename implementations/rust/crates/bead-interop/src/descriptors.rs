//! The interop service's descriptors, written by hand as beadc would write them from
//! `spec/interop-blueprint.json`, until its Rust target generates them: each procedure's id, name,
//! kind, admission, failures and codecs.

use bead::{
    AdmissionRule, Descriptor, DescriptorInit, FailureCatalogue, JsonCodec, ListedFailure,
    NotifyingDescriptor, Procedure, ProcedureKind, ProgrammerError, ServiceProcedure, Validate,
    command_of, failures_of, notifying_of, request_of,
};
use serde_json::Value;

/// The interop service's id.
pub const SERVICE_ID: u16 = 1;

/// The interop service's name.
pub const SERVICE_NAME: &str = "Interop";

/// The interop service's revision.
pub const SERVICE_REVISION: u32 = 2;

/// This procedure fails, on purpose.
pub const ON_PURPOSE: ListedFailure = ListedFailure::new("ON_PURPOSE", 7);

/// That destination is registered already.
pub const REGISTERED_ALREADY: ListedFailure = ListedFailure::new("REGISTERED_ALREADY", 8);

/// A procedure of the interop service, every payload JSON.
pub type InteropDescriptor = Descriptor<JsonCodec, JsonCodec>;

/// The interop service's procedures, each by its name.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct InteropProcedures {
    /// Answers its request's payload.
    pub echo: InteropDescriptor,
    /// Answers an application failure, on purpose.
    pub fail: InteropDescriptor,
    /// Answers once a delay passed, and counts the calls cancelled first.
    pub slow: InteropDescriptor,
    /// Answers how many calls to slow its connection cancelled.
    pub cancellations: InteropDescriptor,
    /// Admits nobody.
    pub denied: InteropDescriptor,
    /// Throws before it answers.
    pub broken: InteropDescriptor,
    /// Answers a string of the length asked for.
    pub bytes: InteropDescriptor,
    /// Answers what its client's clock answers.
    pub ask: InteropDescriptor,
    /// Answers the time where its client is.
    pub clock: InteropDescriptor,
    /// Notifies what tick notifies, to its call's session's subscription.
    pub ticks: NotifyingDescriptor<JsonCodec, JsonCodec, JsonCodec>,
    /// Notifies a value to the subscription to ticks.
    pub tick: InteropDescriptor,
    /// Opens a new session for its connection.
    pub login: InteropDescriptor,
    /// Ends its connection's session.
    pub logout: InteropDescriptor,
    /// Answers the name its call's session holds.
    pub whoami: InteropDescriptor,
    /// Registers its caller's connection as a destination of the relay.
    pub register: InteropDescriptor,
    /// Takes out the destination its caller's connection registered last.
    pub unregister: InteropDescriptor,
    /// Ends a credential's session on every connection that keeps it.
    pub end_session: InteropDescriptor,
    /// Ends every credential's session of an issuer.
    pub end_sessions_of: InteropDescriptor,
    /// Counts the names it is given, held to its rules before its resolver.
    pub checked: InteropDescriptor,
}

fn procedure_of((id, name): (u16, &str), kind: ProcedureKind) -> Procedure {
    Procedure {
        service_id: SERVICE_ID,
        id,
        service_revision: SERVICE_REVISION,
        name: name.to_owned(),
        kind: Some(kind),
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

fn init_of(
    (id, name): (u16, &str),
    (kind, admission, failures): (ProcedureKind, AdmissionRule, &[ListedFailure]),
) -> DescriptorInit<JsonCodec, JsonCodec> {
    DescriptorInit {
        procedure: procedure_of((id, name), kind),
        admission,
        failures: failures.to_vec(),
        request: JsonCodec,
        result: JsonCodec,
        validate: None,
    }
}

fn request(
    (id, name): (u16, &str),
    (admission, failures): (AdmissionRule, &[ListedFailure]),
) -> Result<InteropDescriptor, ProgrammerError> {
    request_of(init_of(
        (id, name),
        (ProcedureKind::Request, admission, failures),
    ))
}

/// The interop service's failures.
///
/// # Errors
///
/// None: its codes hold.
pub fn interop_failures() -> Result<FailureCatalogue, ProgrammerError> {
    failures_of(SERVICE_ID, &[ON_PURPOSE, REGISTERED_ALREADY])
}

/// The interop service's procedures, `checked` judged by `validate`.
///
/// # Errors
///
/// None: its procedures hold.
pub fn interop_procedures(
    validate: Option<Validate<Value>>,
) -> Result<InteropProcedures, ProgrammerError> {
    let none = AdmissionRule::None;
    let session = AdmissionRule::Session;

    Ok(InteropProcedures {
        echo: request((1, "echo"), (none, &[]))?,
        fail: request((2, "fail"), (none, &[ON_PURPOSE]))?,
        slow: request((3, "slow"), (none, &[]))?,
        cancellations: request((4, "cancellations"), (none, &[]))?,
        denied: request((5, "denied"), (AdmissionRule::Hook("nobody"), &[]))?,
        broken: request((6, "broken"), (none, &[]))?,
        bytes: request((7, "bytes"), (none, &[]))?,
        ask: request((8, "ask"), (none, &[]))?,
        clock: command_of(init_of((9, "clock"), (ProcedureKind::Command, none, &[])))?,
        ticks: notifying_of(
            init_of(
                (10, "ticks"),
                (ProcedureKind::Notifies, none, &[ON_PURPOSE]),
            ),
            JsonCodec,
        )?,
        tick: request((11, "tick"), (none, &[]))?,
        login: request((12, "login"), (none, &[]))?,
        logout: request((13, "logout"), (session, &[]))?,
        whoami: request((14, "whoami"), (session, &[]))?,
        register: request((15, "register"), (none, &[REGISTERED_ALREADY]))?,
        unregister: request((16, "unregister"), (none, &[]))?,
        end_session: request((17, "endSession"), (none, &[]))?,
        end_sessions_of: request((18, "endSessionsOf"), (none, &[]))?,
        checked: request_of(DescriptorInit {
            validate,
            ..init_of((19, "checked"), (ProcedureKind::Request, none, &[]))
        })?,
    })
}

impl InteropProcedures {
    /// Each procedure, in its blueprint's order, as a service's server is told it.
    #[must_use]
    pub fn all(&self) -> Vec<ServiceProcedure> {
        vec![
            ServiceProcedure::of(&self.echo),
            ServiceProcedure::of(&self.fail),
            ServiceProcedure::of(&self.slow),
            ServiceProcedure::of(&self.cancellations),
            ServiceProcedure::of(&self.denied),
            ServiceProcedure::of(&self.broken),
            ServiceProcedure::of(&self.bytes),
            ServiceProcedure::of(&self.ask),
            ServiceProcedure::of(&self.clock),
            ServiceProcedure::of_notifying(&self.ticks),
            ServiceProcedure::of(&self.tick),
            ServiceProcedure::of(&self.login),
            ServiceProcedure::of(&self.logout),
            ServiceProcedure::of(&self.whoami),
            ServiceProcedure::of(&self.register),
            ServiceProcedure::of(&self.unregister),
            ServiceProcedure::of(&self.end_session),
            ServiceProcedure::of(&self.end_sessions_of),
            ServiceProcedure::of(&self.checked),
        ]
    }

    /// Each procedure, in its blueprint's order: its procedure, its admission, the failures it
    /// lists, and whether its request is judged by rules.
    #[must_use]
    pub fn described(&self) -> Vec<(Procedure, AdmissionRule, Vec<ListedFailure>, bool)> {
        let of = |descriptor: &InteropDescriptor| {
            (
                descriptor.procedure().clone(),
                descriptor.admission(),
                descriptor.failures().to_vec(),
                descriptor.validates(),
            )
        };

        vec![
            of(&self.echo),
            of(&self.fail),
            of(&self.slow),
            of(&self.cancellations),
            of(&self.denied),
            of(&self.broken),
            of(&self.bytes),
            of(&self.ask),
            of(&self.clock),
            of(self.ticks.descriptor()),
            of(&self.tick),
            of(&self.login),
            of(&self.logout),
            of(&self.whoami),
            of(&self.register),
            of(&self.unregister),
            of(&self.end_session),
            of(&self.end_sessions_of),
            of(&self.checked),
        ]
    }
}
