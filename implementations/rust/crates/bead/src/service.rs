//! The service layer: a service's procedures as typed descriptors, one value each — its procedure,
//! who may call it, the failures it answers and its payloads' codecs — its failures as a catalogue,
//! and the server of one service, its resolvers registered by descriptor, offered on one server.

use core::any::Any;
use core::fmt;
use core::num::NonZeroU16;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::constants::{ProcedureKind, ProtocolCode, RouterSide};
use crate::errors::{CallError, ProgrammerError};
use crate::failure::Failure;
use crate::identity::Procedure;
use crate::managers::service::{
    Command, Lookup, NotificationResolverDependencies, NotificationResolverOf, Notifier,
    RequestDependencies, RequestResolverDependencies, ResolverCallback, Validate,
};
use crate::payloads::PayloadCodec;
use crate::router::admissions::{BeforeRequest, require_session};
use crate::router::core::AdmissionRequest;
use crate::server::Server;

#[cfg(test)]
mod tests;

// ── Failures ─────────────────────────────────────────────────────────────────────────────────

/// A failure a service lists: its name and its code (spec 9.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListedFailure {
    name: &'static str,
    code: NonZeroU16,
}

impl ListedFailure {
    /// The failure `name`, of `code`.
    #[must_use]
    pub const fn new(name: &'static str, code: NonZeroU16) -> Self {
        Self { name, code }
    }

    /// Its name.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        self.name
    }

    /// Its code.
    #[must_use]
    pub const fn code(&self) -> u16 {
        self.code.get()
    }

    /// The failure a resolver answers, saying `detail`.
    #[must_use]
    pub fn of(&self, detail: &str) -> Failure {
        Failure::application(self.code, detail)
    }
}

/// A service's failures, as a catalogue of names and their codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailureCatalogue {
    service_id: u16,
    failures: Vec<ListedFailure>,
}

/// The catalogue of `failures`, of the service `service_id`.
///
/// # Errors
///
/// A [`ProgrammerError`] for a service's id of 0, or two failures of one code.
pub fn failures_of(
    service_id: u16,
    failures: &[ListedFailure],
) -> Result<FailureCatalogue, ProgrammerError> {
    if service_id == 0 {
        return Err(ProgrammerError::new(
            "a service's id is a whole number from 1 to 65535, not 0",
        ));
    }

    let mut named: BTreeMap<u16, &'static str> = BTreeMap::new();

    for failure in failures {
        if let Some(other) = named.insert(failure.code.get(), failure.name) {
            return Err(ProgrammerError::new(format!(
                "{} and {other} are both failure {}",
                failure.name, failure.code
            )));
        }
    }

    Ok(FailureCatalogue {
        service_id,
        failures: failures.to_vec(),
    })
}

impl FailureCatalogue {
    /// Its service's id.
    #[must_use]
    pub const fn service_id(&self) -> u16 {
        self.service_id
    }

    /// Its failures.
    #[must_use]
    pub fn failures(&self) -> &[ListedFailure] {
        &self.failures
    }

    /// Whether `error` is the failure `listed` of this service, as its caller hears it.
    #[must_use]
    pub fn is(&self, error: &CallError, listed: &ListedFailure) -> bool {
        matches!(error, CallError::Failure(failure)
            if failure.is_application()
                && failure.code() == listed.code
                && failure.procedure().is_some_and(|address| address.service_id == self.service_id))
    }
}

// ── Descriptors ──────────────────────────────────────────────────────────────────────────────

/// Who may call a procedure: anybody, a call with a session, or a hook of its server's by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum AdmissionRule {
    /// Anybody.
    None,
    /// A call with a session.
    Session,
    /// The hook of this name its server's options give.
    Hook(&'static str),
}

/// What a descriptor is made of: its procedure, who may call it, the failures it lists, its
/// codecs and its rules.
pub struct DescriptorInit<Req: PayloadCodec, Res: PayloadCodec> {
    /// Its procedure.
    pub procedure: Procedure,
    /// Who may call it.
    pub admission: AdmissionRule,
    /// The failures it answers.
    pub failures: Vec<ListedFailure>,
    /// The request's codec.
    pub request: Req,
    /// The result's codec.
    pub result: Res,
    /// The rules its request is judged by.
    pub validate: Option<Validate<Req::Value>>,
}

impl<Req: PayloadCodec, Res: PayloadCodec> fmt::Debug for DescriptorInit<Req, Res> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DescriptorInit")
            .field("procedure", &self.procedure)
            .field("admission", &self.admission)
            .field("failures", &self.failures)
            .finish_non_exhaustive()
    }
}

/// A procedure, described: what serves and calls it reads it.
pub struct Descriptor<Req: PayloadCodec, Res: PayloadCodec> {
    init: Arc<DescriptorInit<Req, Res>>,
}

impl<Req: PayloadCodec, Res: PayloadCodec> Clone for Descriptor<Req, Res> {
    fn clone(&self) -> Self {
        Self {
            init: Arc::clone(&self.init),
        }
    }
}

impl<Req: PayloadCodec, Res: PayloadCodec> fmt::Debug for Descriptor<Req, Res> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Descriptor")
            .field("procedure", &self.init.procedure)
            .field("admission", &self.init.admission)
            .finish_non_exhaustive()
    }
}

/// A procedure that notifies, described, with its notification's codec.
pub struct NotifyingDescriptor<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> {
    descriptor: Descriptor<Req, Res>,
    notification: Arc<Not>,
}

impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> Clone
    for NotifyingDescriptor<Req, Res, Not>
{
    fn clone(&self) -> Self {
        Self {
            descriptor: self.descriptor.clone(),
            notification: Arc::clone(&self.notification),
        }
    }
}

impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> fmt::Debug
    for NotifyingDescriptor<Req, Res, Not>
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NotifyingDescriptor")
            .field("descriptor", &self.descriptor)
            .finish_non_exhaustive()
    }
}

fn describe<Req: PayloadCodec, Res: PayloadCodec>(
    mut init: DescriptorInit<Req, Res>,
    kind: ProcedureKind,
) -> Result<Descriptor<Req, Res>, ProgrammerError> {
    let name = &init.procedure.procedure_name;

    if let Some(stated) = init.procedure.procedure_kind
        && stated != kind
    {
        return Err(ProgrammerError::new(format!(
            "{name} is of kind {}, not {}",
            stated.as_str(),
            kind.as_str()
        )));
    }

    if let AdmissionRule::Hook(hook) = init.admission
        && hook.is_empty()
    {
        return Err(ProgrammerError::new(format!(
            "{name}'s admission is none, session or a hook by name"
        )));
    }

    init.procedure.procedure_kind = Some(kind);

    Ok(Descriptor {
        init: Arc::new(init),
    })
}

/// A request's descriptor: a procedure that answers.
///
/// # Errors
///
/// A [`ProgrammerError`] for a procedure of another kind, or a hook of no name.
pub fn request_of<Req: PayloadCodec, Res: PayloadCodec>(
    init: DescriptorInit<Req, Res>,
) -> Result<Descriptor<Req, Res>, ProgrammerError> {
    describe(init, ProcedureKind::Request)
}

/// A notifying request's descriptor, with its notification's codec.
///
/// # Errors
///
/// A [`ProgrammerError`] for a procedure of another kind, or a hook of no name.
pub fn notifying_of<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec>(
    init: DescriptorInit<Req, Res>,
    notification: Not,
) -> Result<NotifyingDescriptor<Req, Res, Not>, ProgrammerError> {
    Ok(NotifyingDescriptor {
        descriptor: describe(init, ProcedureKind::Notifies)?,
        notification: Arc::new(notification),
    })
}

/// A command's descriptor: a call of the server's own, to a client.
///
/// # Errors
///
/// A [`ProgrammerError`] for a procedure of another kind, or a hook of no name.
pub fn command_of<Req: PayloadCodec, Res: PayloadCodec>(
    init: DescriptorInit<Req, Res>,
) -> Result<Descriptor<Req, Res>, ProgrammerError> {
    describe(init, ProcedureKind::Command)
}

impl<Req: PayloadCodec, Res: PayloadCodec> Descriptor<Req, Res> {
    /// Its procedure, its kind stated.
    #[must_use]
    pub fn procedure(&self) -> &Procedure {
        &self.init.procedure
    }

    /// Who may call it.
    #[must_use]
    pub fn admission(&self) -> AdmissionRule {
        self.init.admission
    }

    /// The failures it answers.
    #[must_use]
    pub fn failures(&self) -> &[ListedFailure] {
        &self.init.failures
    }

    /// The request's codec.
    #[must_use]
    pub fn request(&self) -> &Req {
        &self.init.request
    }

    /// The result's codec.
    #[must_use]
    pub fn result(&self) -> &Res {
        &self.init.result
    }

    /// Whether its request is judged by rules.
    #[must_use]
    pub fn validates(&self) -> bool {
        self.init.validate.is_some()
    }
}

impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec> NotifyingDescriptor<Req, Res, Not> {
    /// The descriptor of its request.
    #[must_use]
    pub const fn descriptor(&self) -> &Descriptor<Req, Res> {
        &self.descriptor
    }

    /// The notification's codec.
    #[must_use]
    pub fn notification(&self) -> &Not {
        &self.notification
    }
}

// ── The server of one service ────────────────────────────────────────────────────────────────

/// A hook a procedure is admitted by: whether a request may reach it, and what a refusal says.
#[derive(Clone)]
pub struct AdmissionHook {
    /// Whether a request may reach its procedure.
    pub admits: Arc<dyn Fn(&AdmissionRequest) -> bool + Send + Sync>,
    /// What a refusal says.
    pub detail: Option<String>,
}

impl fmt::Debug for AdmissionHook {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AdmissionHook")
            .field("detail", &self.detail)
            .finish_non_exhaustive()
    }
}

/// How a service's server is built.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct ServiceServerOptions {
    /// The hooks its procedures are admitted by, by name: none when no procedure names a hook, and
    /// refused as the server is built when one does and finds none.
    pub admissions: Option<BTreeMap<&'static str, AdmissionHook>>,
    /// Whether its rules stop at the first violation: `false` when none.
    pub fail_fast: Option<bool>,
    /// Whether its commands judge their requests by their rules: `false` when none.
    pub validates: Option<bool>,
}

// what a requester or a notifier is, kept by name and found again by its type
type Made = Arc<dyn Any + Send + Sync>;

// what makes a command's requester as its service is offered
type CommandMaker =
    Arc<dyn Fn(&Server, (bool, bool)) -> Result<Made, ProgrammerError> + Send + Sync>;

// what registers a resolver on the server offered, and gives its notifier, when it notifies
type Binder = Arc<dyn Fn(&Server, &Bound) -> Result<Option<Made>, ProgrammerError> + Send + Sync>;

/// A procedure of a service, as its server is told it: its descriptor, its types set aside.
#[derive(Clone)]
pub struct ServiceProcedure {
    procedure: Procedure,
    descriptor: Made,
    admission: AdmissionRule,
    command: Option<CommandMaker>,
}

impl fmt::Debug for ServiceProcedure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServiceProcedure")
            .field("procedure", &self.procedure)
            .field("admission", &self.admission)
            .finish_non_exhaustive()
    }
}

/// The procedure a descriptor describes: a request, or a command its server makes as it is
/// offered.
impl<Req, Res> From<&Descriptor<Req, Res>> for ServiceProcedure
where
    Req: PayloadCodec + Clone,
    Res: PayloadCodec + Clone,
    Req::Value: Clone + fmt::Debug + Sync,
    Res::Value: Clone + fmt::Debug + Sync,
{
    fn from(descriptor: &Descriptor<Req, Res>) -> Self {
        let command =
            (descriptor.procedure().procedure_kind == Some(ProcedureKind::Command)).then(|| {
                let descriptor = descriptor.clone();
                let maker: CommandMaker = Arc::new(
                    move |server: &Server, (validates, fail_fast): (bool, bool)| {
                        let init = &descriptor.init;
                        let requester = server.services().get_command(
                            &init.procedure,
                            RequestDependencies {
                                request: init.request.clone(),
                                result: init.result.clone(),
                                validate: if validates {
                                    init.validate.clone()
                                } else {
                                    None
                                },
                                fail_fast,
                            },
                        )?;

                        let made: Made = Arc::new(requester);

                        Ok(made)
                    },
                );

                maker
            });

        Self {
            procedure: descriptor.procedure().clone(),
            descriptor: Arc::<DescriptorInit<Req, Res>>::clone(&descriptor.init),
            admission: descriptor.admission(),
            command,
        }
    }
}

/// The procedure a notifying descriptor describes.
impl<Req: PayloadCodec, Res: PayloadCodec, Not: PayloadCodec>
    From<&NotifyingDescriptor<Req, Res, Not>> for ServiceProcedure
{
    fn from(descriptor: &NotifyingDescriptor<Req, Res, Not>) -> Self {
        Self {
            procedure: descriptor.descriptor.procedure().clone(),
            descriptor: Arc::<DescriptorInit<Req, Res>>::clone(&descriptor.descriptor.init),
            admission: descriptor.descriptor.admission(),
            command: None,
        }
    }
}

impl ServiceProcedure {
    /// Its procedure.
    #[must_use]
    pub const fn procedure(&self) -> &Procedure {
        &self.procedure
    }
}

#[derive(Clone)]
struct Bound {
    hooks: BTreeMap<&'static str, AdmissionHook>,
    fail_fast: bool,
}

struct Inner {
    procedures: Vec<ServiceProcedure>,
    bound: Bound,
    validates: bool,
    // each resolver registered, by its procedure's name, in the order registered
    binders: Vec<(String, Binder)>,
    offered: Option<Server>,
    commands: BTreeMap<String, Made>,
    notifiers: BTreeMap<String, Made>,
}

/// The server of one service: its resolvers registered by descriptor, offered on one server, its
/// commands made and its notifications sent there.
#[derive(Clone)]
pub struct ServiceServer {
    inner: Arc<Mutex<Inner>>,
}

impl fmt::Debug for ServiceServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServiceServer")
            .finish_non_exhaustive()
    }
}

fn locked(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(PoisonError::into_inner)
}

// a handle's lookup in its service's maps: what the offer, or the registration of its resolver, made
// of its procedure, by its name, which the service holds once
struct Looking {
    inner: Arc<Mutex<Inner>>,
    name: String,
    // whether it looks among the commands, or the notifiers
    is_command: bool,
}

impl<Given: Clone + Send + Sync + 'static> Lookup<Given> for Looking {
    fn current(&self) -> Option<Given> {
        let inner = locked(&self.inner);
        let made = if self.is_command {
            &inner.commands
        } else {
            &inner.notifiers
        };

        made.get(&self.name)
            .and_then(|made| made.downcast_ref::<Given>())
            .cloned()
    }
}

// the admission a procedure's rule asks: a session's, or a hook's, refusing ACCESS_DENIED
fn admission_of(admission: AdmissionRule, bound: &Bound) -> Option<BeforeRequest> {
    match admission {
        AdmissionRule::None => None,
        AdmissionRule::Session => Some(require_session()),
        AdmissionRule::Hook(name) => bound.hooks.get(name).map(|hook| {
            let admits = Arc::clone(&hook.admits);
            let denied = Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server);
            let refusal = match &hook.detail {
                Some(detail) => denied.saying(detail.clone()),
                None => denied,
            };

            BeforeRequest::new(
                move |request: &AdmissionRequest| admits(request),
                Some(refusal),
            )
        }),
    }
}

fn dependencies_of<Req: PayloadCodec + Clone, Res: PayloadCodec + Clone>(
    descriptor: &Descriptor<Req, Res>,
    bound: &Bound,
) -> (RequestResolverDependencies<Req, Res>, Arc<[u16]>) {
    let init = &descriptor.init;

    (
        RequestResolverDependencies {
            request: init.request.clone(),
            result: init.result.clone(),
            before_request: admission_of(init.admission, bound),
            validate: init.validate.clone(),
            fail_fast: bound.fail_fast,
        },
        init.failures.iter().map(ListedFailure::code).collect(),
    )
}

impl ServiceServer {
    /// The server of the service of `procedures`.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a hook a procedure names that the options do not give, or one
    /// given that no procedure names.
    pub fn new(
        procedures: Vec<ServiceProcedure>,
        options: &ServiceServerOptions,
    ) -> Result<Self, ProgrammerError> {
        let given = options.admissions.clone().unwrap_or_default();
        let mut named: Vec<&'static str> = Vec::new();

        for described in &procedures {
            if let AdmissionRule::Hook(hook) = described.admission {
                if !given.contains_key(hook) {
                    return Err(ProgrammerError::new(format!(
                        "{} is admitted by the hook {hook}, which the options do not give",
                        described.procedure.procedure_name
                    )));
                }

                named.push(hook);
            }
        }

        if let Some(unnamed) = given.keys().find(|name| !named.contains(name)) {
            return Err(ProgrammerError::new(format!(
                "the hook {unnamed} is given, and no procedure names it"
            )));
        }

        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                procedures,
                bound: Bound {
                    hooks: given,
                    fail_fast: options.fail_fast.unwrap_or(false),
                },
                validates: options.validates.unwrap_or(false),
                binders: Vec::new(),
                offered: None,
                commands: BTreeMap::new(),
                notifiers: BTreeMap::new(),
            })),
        })
    }

    // a resolver of `procedure`, registered now on the server offered, or once it is
    fn add(
        &self,
        (procedure, kind, descriptor): (&Procedure, ProcedureKind, &Made),
        binder: &Binder,
    ) -> Result<(), ProgrammerError> {
        let (offered, bound) = {
            let mut inner = locked(&self.inner);
            let is_answered = inner.procedures.iter().any(|known| {
                Arc::ptr_eq(&known.descriptor, descriptor)
                    && known.procedure.procedure_kind == Some(kind)
            });

            if !is_answered {
                return Err(ProgrammerError::new(format!(
                    "{} is no procedure this service's server answers",
                    procedure.procedure_name
                )));
            }

            if inner
                .binders
                .iter()
                .any(|(name, _)| *name == procedure.procedure_name)
            {
                return Err(ProgrammerError::new(format!(
                    "{} is already a registered resolver",
                    procedure.procedure_name
                )));
            }

            inner
                .binders
                .push((procedure.procedure_name.clone(), Arc::clone(binder)));

            (inner.offered.clone(), inner.bound.clone())
        };

        if let Some(server) = offered
            && let Some(notifier) = binder(&server, &bound)?
        {
            locked(&self.inner)
                .notifiers
                .insert(procedure.procedure_name.clone(), notifier);
        }

        Ok(())
    }

    /// Registers `callback` as the resolver of `descriptor`'s procedure, on the server offered, or
    /// once it is.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure of no request of this service, one registered already,
    /// or one its server refuses.
    pub fn on<Req, Res>(
        &self,
        descriptor: &Descriptor<Req, Res>,
        callback: ResolverCallback<Req, Res>,
    ) -> Result<(), ProgrammerError>
    where
        Req: PayloadCodec + Clone,
        Res: PayloadCodec + Clone,
        Req::Value: Clone + fmt::Debug + Sync,
        Res::Value: Clone + fmt::Debug + Sync,
    {
        let procedure = descriptor.procedure().clone();
        let identity: Made = Arc::<DescriptorInit<Req, Res>>::clone(&descriptor.init);
        let descriptor = descriptor.clone();
        let binder: Binder = Arc::new(move |server: &Server, bound: &Bound| {
            let (dependencies, listed) = dependencies_of(&descriptor, bound);

            server
                .services()
                .get_request_resolver(descriptor.procedure(), dependencies)?
                .register((Arc::clone(&callback), Some(listed)), false)?;

            Ok(None)
        });

        self.add((&procedure, ProcedureKind::Request, &identity), &binder)
    }

    /// Registers `callback` as the resolver of `descriptor`'s procedure that notifies.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a procedure of no notifying request of this service, one
    /// registered already, or one its server refuses.
    pub fn on_notifying<Req, Res, Not>(
        &self,
        descriptor: &NotifyingDescriptor<Req, Res, Not>,
        callback: ResolverCallback<Req, Res>,
    ) -> Result<(), ProgrammerError>
    where
        Req: PayloadCodec + Clone,
        Res: PayloadCodec + Clone,
        Not: PayloadCodec + Clone,
        Req::Value: Clone + fmt::Debug + Sync,
        Res::Value: Clone + fmt::Debug + Sync,
        Not::Value: Clone + fmt::Debug + Sync,
    {
        let procedure = descriptor.descriptor.procedure().clone();
        let identity: Made = Arc::<DescriptorInit<Req, Res>>::clone(&descriptor.descriptor.init);
        let descriptor = descriptor.clone();
        let binder: Binder = Arc::new(move |server: &Server, bound: &Bound| {
            let (dependencies, listed) = dependencies_of(&descriptor.descriptor, bound);
            let resolver: NotificationResolverOf<Req, Res, Not> =
                server.services().get_notification_resolver(
                    descriptor.descriptor.procedure(),
                    NotificationResolverDependencies::new(
                        dependencies,
                        (*descriptor.notification).clone(),
                    ),
                )?;
            let notifier: Notifier<Not> =
                resolver.register((Arc::clone(&callback), Some(listed)))?;

            let made: Made = Arc::new(notifier);

            Ok(Some(made))
        });

        self.add((&procedure, ProcedureKind::Notifies, &identity), &binder)
    }

    /// Offers the service on `server`: its commands made, its resolvers registered.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a service offered already, or a resolver its server refuses.
    pub fn offer(&self, server: &Server) -> Result<(), ProgrammerError> {
        let (procedures, binders, bound, validates) = {
            let mut inner = locked(&self.inner);

            if inner.offered.is_some() {
                return Err(ProgrammerError::new(
                    "a service is offered on one server, once",
                ));
            }

            inner.offered = Some(server.clone());

            (
                inner.procedures.clone(),
                inner.binders.clone(),
                inner.bound.clone(),
                inner.validates,
            )
        };

        for described in &procedures {
            if let Some(make) = &described.command {
                let made = make(server, (validates, bound.fail_fast))?;

                locked(&self.inner)
                    .commands
                    .insert(described.procedure.procedure_name.clone(), made);
            }
        }

        for (name, binder) in binders {
            if let Some(notifier) = binder(server, &bound)? {
                locked(&self.inner).notifiers.insert(name, notifier);
            }
        }

        Ok(())
    }

    // the lookup of what is made of `descriptor`'s procedure, a procedure of `kind` this service
    // holds as that same descriptor, refused otherwise, as the other sides' handles are
    fn looking<Req: PayloadCodec, Res: PayloadCodec>(
        &self,
        descriptor: &Descriptor<Req, Res>,
        kind: ProcedureKind,
    ) -> Result<Looking, ProgrammerError> {
        let identity: Made = Arc::<DescriptorInit<Req, Res>>::clone(&descriptor.init);
        let name = &descriptor.procedure().procedure_name;
        let held = locked(&self.inner)
            .procedures
            .iter()
            .find(|known| Arc::ptr_eq(&known.descriptor, &identity))
            .map(|known| known.procedure.procedure_kind);

        match held {
            None => Err(ProgrammerError::new(format!(
                "{name} is no procedure of this service"
            ))),
            Some(held) if held != Some(kind) => Err(ProgrammerError::new(format!(
                "{name} is no {} of this service",
                if kind == ProcedureKind::Command {
                    "command"
                } else {
                    "procedure that notifies"
                }
            ))),
            Some(_) => Ok(Looking {
                inner: Arc::clone(&self.inner),
                name: name.clone(),
                is_command: kind == ProcedureKind::Command,
            }),
        }
    }

    /// The requester of the command `descriptor` describes, given before the service is offered:
    /// its calls go once the service is offered, and one made before is refused.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a descriptor other than the one this service was built with, or
    /// one of no command.
    pub fn command_of<Req, Res>(
        &self,
        descriptor: &Descriptor<Req, Res>,
    ) -> Result<Command<Req, Res>, ProgrammerError>
    where
        Req: PayloadCodec,
        Res: PayloadCodec,
    {
        let looking = self.looking(descriptor, ProcedureKind::Command)?;

        Ok(Lookup::<Command<Req, Res>>::current(&looking)
            .unwrap_or_else(|| Command::looked(descriptor.procedure().clone(), Arc::new(looking))))
    }

    /// The notifier of the procedure `descriptor` describes, given before the service is offered:
    /// it sends to nobody, and resolves, until the service is offered and its resolver registered.
    ///
    /// # Errors
    ///
    /// A [`ProgrammerError`] for a descriptor other than the one this service was built with.
    pub fn notifier_of<Req, Res, Not>(
        &self,
        descriptor: &NotifyingDescriptor<Req, Res, Not>,
    ) -> Result<Notifier<Not>, ProgrammerError>
    where
        Req: PayloadCodec,
        Res: PayloadCodec,
        Not: PayloadCodec,
    {
        let looking = self.looking(&descriptor.descriptor, ProcedureKind::Notifies)?;

        Ok(
            Lookup::<Notifier<Not>>::current(&looking).unwrap_or_else(|| {
                Notifier::looked(descriptor.descriptor.procedure().clone(), Arc::new(looking))
            }),
        )
    }

    /// The procedures that answer, and hold no resolver yet.
    #[must_use]
    pub fn procedures_without_resolver(&self) -> Vec<Procedure> {
        let inner = locked(&self.inner);

        inner
            .procedures
            .iter()
            .filter(|described| {
                described.procedure.procedure_kind != Some(ProcedureKind::Command)
                    && !inner
                        .binders
                        .iter()
                        .any(|(name, _)| *name == described.procedure.procedure_name)
            })
            .map(|described| described.procedure.clone())
            .collect()
    }
}
