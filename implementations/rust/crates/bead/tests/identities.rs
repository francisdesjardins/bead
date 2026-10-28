//! `spec/identities.json` played: each name, address, revision and kind declared each of the six
//! ways a side declares, each on a router of its own, taken or refused by the first reason of spec
//! 16.10 that applies, a declaration refused declaring nothing; and which two names are one (16.6).

use std::process::ExitCode;
use std::sync::Arc;

use bead::testing::files;
use bead::{
    BoxFuture, ClientListener, ClientTransport, ConnectionHandle, IdentityRefusal, JsonCodec,
    NotificationLike, Procedure, ProcedureKind, ProgrammerError, ReadyState, Refusal,
    ResolverDependencies, Response, RouterClient, RouterClientOptions, RouterError, RouterServer,
    RouterServerOptions, Sent, ServerListener, ServerTransport, ServiceManager,
    ServiceManagerOptions, ServiceRouter, TransportMessage, are_one_name,
};
use bytes::Bytes;
use libtest_mimic::{Arguments, Failed, Trial};
use serde_json::Value;

// the language a differs names to excuse this side
const LANGUAGE: &str = "Rust";

// the ways the file names, each by its id
const WAYS: [&str; 6] = [
    "client-resolver",
    "server-resolver",
    "server-notification-resolver",
    "client-requester",
    "server-requester",
    "client-notification",
];

// a client's transport never connected
#[derive(Debug)]
struct Unconnected;

impl ClientTransport for Unconnected {
    fn send(&self, _message: TransportMessage) -> Result<Sent, RouterError> {
        Ok(Sent::Done)
    }

    fn listen(&self, _listener: Arc<dyn ClientListener>) {}

    fn unlisten(&self, _listener: &Arc<dyn ClientListener>) {}

    fn ready_state(&self) -> ReadyState {
        ReadyState::Uninitialized
    }
}

// a server's transport of no connection
#[derive(Debug)]
struct Unconnecting;

impl ServerTransport for Unconnecting {
    fn send(
        &self,
        _message: TransportMessage,
        _connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        Ok(Sent::Done)
    }

    fn close(&self, _connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        Box::pin(async { false })
    }

    fn listen(&self, _listener: Arc<dyn ServerListener>) {}

    fn unlisten(&self, _listener: &Arc<dyn ServerListener>) {}

    fn start(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }

    fn stop(&self) -> BoxFuture<()> {
        Box::pin(async {})
    }
}

// a notification no payload reaches
#[derive(Debug)]
struct Heard(Procedure);

impl NotificationLike for Heard {
    fn procedure(&self) -> &Procedure {
        &self.0
    }

    fn trigger(
        &self,
        _payload: Bytes,
    ) -> Result<BoxFuture<Vec<Result<(), Arc<dyn std::error::Error + Send + Sync>>>>, RouterError>
    {
        Ok(Box::pin(async { Vec::new() }))
    }
}

// a client's router and a server's, each of its own, and the managers over them
struct Routers {
    client: RouterClient,
    server: RouterServer,
    client_services: ServiceManager,
    server_services: ServiceManager,
}

fn routers() -> Result<Routers, ProgrammerError> {
    let client = RouterClient::new(Arc::new(Unconnected), &RouterClientOptions::default())?;
    let server = RouterServer::new(Arc::new(Unconnecting), &RouterServerOptions::default())?;

    Ok(Routers {
        client_services: ServiceManager::new(
            ServiceRouter::Client(client.clone()),
            &ServiceManagerOptions::default(),
        )?,
        server_services: ServiceManager::new(
            ServiceRouter::Server(server.clone()),
            &ServiceManagerOptions::default(),
        )?,
        client,
        server,
    })
}

fn answering() -> bead::ResolverCallback<JsonCodec, JsonCodec> {
    Arc::new(|request, response: Response<JsonCodec>| response.result(request.payload))
}

// declares `procedure` the way `way` names
fn declare(way: &str, (procedure, routers): (&Procedure, &Routers)) -> Result<(), ProgrammerError> {
    match way {
        "client-resolver" => routers
            .client_services
            .get_command_resolver(procedure, ResolverDependencies::of(JsonCodec, JsonCodec))?
            .on(answering()),
        "server-resolver" => routers
            .server_services
            .get_request_resolver(procedure, ResolverDependencies::of(JsonCodec, JsonCodec))?
            .on(answering()),
        "server-notification-resolver" => routers
            .server_services
            .get_notification_resolver(
                procedure,
                (ResolverDependencies::of(JsonCodec, JsonCodec), JsonCodec),
            )?
            .on(answering())
            .map(drop),
        "client-requester" => routers.client.declare_requester(procedure).map(drop),
        "server-requester" => routers.server.declare_requester(procedure).map(drop),
        "client-notification" => routers
            .client
            .register_notification(Arc::new(Heard(procedure.clone()))),
        other => Err(ProgrammerError::new(format!("no way {other}"))),
    }
}

fn echo() -> Procedure {
    Procedure {
        service_id: 1,
        id: 1,
        service_revision: 1,
        name: "echo".to_owned(),
        kind: None,
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

// whether an entry's differs names this side
fn is_excused(entry: &Value) -> bool {
    entry
        .get("differs")
        .and_then(Value::as_array)
        .is_some_and(|differs| {
            differs.iter().any(|difference| {
                difference.get("language").and_then(Value::as_str) == Some(LANGUAGE)
            })
        })
}

// the reason an entry is refused for at a way: at every way, or at those its refusedAt lists
fn refused_of(entry: &Value, way: &str) -> Option<String> {
    let refused = entry.get("refused").and_then(Value::as_str)?;
    let is_refused_here = entry
        .get("refusedAt")
        .and_then(Value::as_array)
        .is_none_or(|refused_at| refused_at.iter().any(|at| at.as_str() == Some(way)));

    is_refused_here.then(|| refused.to_owned())
}

fn refusal_of(reason: &str) -> Option<IdentityRefusal> {
    [
        IdentityRefusal::OutOfItsRange,
        IdentityRefusal::OffItsForm,
        IdentityRefusal::AgainstItsKind,
    ]
    .into_iter()
    .find(|refusal| refusal.as_str() == reason)
}

// declares a procedure each way, each on routers of its own: taken, or refused for its entry's
// reason at every way, or at the ways its refusedAt lists, and then declaring nothing, the same way
// taking echo
fn plays_each_way(procedure: &Procedure, entry: &Value) -> Result<(), Failed> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let entered = runtime.enter();

    for way in WAYS {
        let routers = routers()?;
        let declared = declare(way, (procedure, &routers));

        match refused_of(entry, way) {
            None => declared.map_err(|error| format!("{way}: refused: {error}"))?,
            Some(reason) => {
                let Err(error) = declared else {
                    return Err(format!("{way}: taken, where it is {reason}").into());
                };
                let expected =
                    refusal_of(&reason).ok_or_else(|| format!("{reason} is no reason"))?;

                if error.reason() != Some(Refusal::Identity(expected))
                    || !error.message().contains(&format!(" is {reason}: "))
                {
                    return Err(format!("{way}: refused as {error}, not {reason}").into());
                }

                declare(way, (&echo(), &routers))
                    .map_err(|error| format!("{way}: a refusal declared something: {error}"))?;
            }
        }
    }

    drop(entered);

    Ok(())
}

fn ids_of(entry: &Value) -> Option<(u16, u16, u32)> {
    let id = |name: &str| {
        entry
            .get(name)
            .and_then(Value::as_u64)
            .and_then(|id| u16::try_from(id).ok())
    };
    let revision = entry
        .get("serviceRevision")
        .and_then(Value::as_u64)
        .and_then(|revision| u32::try_from(revision).ok());

    Some((id("serviceId")?, id("procedureId")?, revision?))
}

fn kind_of(kind: &str) -> Option<ProcedureKind> {
    match kind {
        "request" => Some(ProcedureKind::Request),
        "notifies" => Some(ProcedureKind::Notifies),
        "command" => Some(ProcedureKind::Command),
        _ => None,
    }
}

fn named(entry: &Value) -> String {
    entry
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

#[expect(
    clippy::too_many_lines,
    reason = "every group of the file, a trial each, as the other sides play them"
)]
fn trials() -> Result<Vec<Trial>, String> {
    let file: Value = files::read("identities.json")?;
    let group = |name: &str| -> Vec<Value> {
        file.get(name)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let ways: Vec<String> = group("ways")
        .iter()
        .filter_map(|way| way.as_str().map(str::to_owned))
        .collect();
    let mut trials = Vec::new();

    trials.push(Trial::test(
        "its table declares every way the file names and no other",
        move || {
            let mut named: Vec<&str> = ways.iter().map(String::as_str).collect();
            let mut table = WAYS.to_vec();

            named.sort_unstable();
            table.sort_unstable();

            if named == table {
                Ok(())
            } else {
                Err(format!("the file names {named:?}").into())
            }
        },
    ));

    let ids = group("ids");
    let others: Vec<Value> = [group("names"), group("folds"), group("procedureKinds")].concat();

    trials.push(Trial::test(
        "plays every entry but those holding an id or a revision no Rust type holds, each excused by its row",
        move || {
            // * excused exactly where this side cannot be given the input: a u16 holds 0 to 65535,
            // a u32 0 to 2³² − 1, and neither a fraction, a string, a boolean or null
            let mut excused = Vec::new();

            for entry in &ids {
                let is_held = ids_of(entry).is_some();

                if is_held == is_excused(entry) {
                    return Err(format!("{} is excused {}", named(entry), is_excused(entry)).into());
                }

                if !is_held {
                    excused.push(named(entry));
                }
            }

            if excused.len() != 17 || others.iter().any(is_excused) || excused.contains(&"revision 2147483648".to_owned()) {
                return Err(format!("excused {excused:?}").into());
            }

            Ok(())
        },
    ));

    for entry in group("names")
        .into_iter()
        .filter(|entry| !is_excused(entry))
    {
        trials.push(
            Trial::test(named(&entry), move || {
                let procedure = Procedure {
                    name: entry
                        .get("procedureName")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    ..echo()
                };

                plays_each_way(&procedure, &entry)
            })
            .with_kind("names"),
        );
    }

    for entry in group("ids").into_iter().filter(|entry| !is_excused(entry)) {
        trials.push(
            Trial::test(named(&entry), move || {
                let (service_id, id, service_revision) =
                    ids_of(&entry).ok_or("ids a Rust type holds")?;
                let procedure = Procedure {
                    service_id,
                    id,
                    service_revision,
                    name: entry
                        .get("procedureName")
                        .and_then(Value::as_str)
                        .unwrap_or("echo")
                        .to_owned(),
                    ..echo()
                };

                plays_each_way(&procedure, &entry)
            })
            .with_kind("ids"),
        );
    }

    for entry in group("procedureKinds")
        .into_iter()
        .filter(|entry| !is_excused(entry))
    {
        trials.push(
            Trial::test(named(&entry), move || {
                let procedure = Procedure {
                    kind: entry
                        .get("procedureKind")
                        .and_then(Value::as_str)
                        .and_then(kind_of),
                    name: entry
                        .get("procedureName")
                        .and_then(Value::as_str)
                        .unwrap_or("echo")
                        .to_owned(),
                    service_id: entry
                        .get("serviceId")
                        .and_then(Value::as_u64)
                        .and_then(|id| u16::try_from(id).ok())
                        .unwrap_or(1),
                    ..echo()
                };

                plays_each_way(&procedure, &entry)
            })
            .with_kind("procedureKinds"),
        );
    }

    for entry in group("folds")
        .into_iter()
        .filter(|entry| !is_excused(entry))
    {
        trials.push(
            Trial::test(named(&entry), move || {
                let names: Vec<&str> = entry
                    .get("names")
                    .and_then(Value::as_array)
                    .map(|names| names.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let (Some(one), Some(other)) = (names.first(), names.get(1)) else {
                    return Err("a fold names two names".into());
                };
                let is_one = entry.get("one").and_then(Value::as_bool).unwrap_or(false);

                // either way round
                if (are_one_name(one, other), are_one_name(other, one)) == (is_one, is_one) {
                    Ok(())
                } else {
                    Err(format!("{one} and {other} are one: {}", !is_one).into())
                }
            })
            .with_kind("folds"),
        );
    }

    Ok(trials)
}

fn main() -> ExitCode {
    let arguments = Arguments::from_args();
    let trials = trials().unwrap_or_else(|error| {
        vec![Trial::test("reads identities.json", move || {
            Err(error.into())
        })]
    });

    libtest_mimic::run(&arguments, trials).exit_code()
}
