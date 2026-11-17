//! Each identity vector declared through the six real makers, with no registry.

use std::sync::Arc;

use serde_json::Value;

use super::{IdentityRefusal, Procedure, ProcedureKind, Refusal, are_one_name};
use crate::managers::service::{
    NotificationResolverDependencies, RequestResolverDependencies, ServiceManager,
    ServiceManagerOptions, ServiceRouter,
};
use crate::testing::files;
use crate::{
    JsonCodec, ProgrammerError, RouterClient, RouterClientOptions, RouterServer,
    RouterServerOptions,
};

const WAYS: [&str; 6] = [
    "client-resolver",
    "server-resolver",
    "server-notification-resolver",
    "client-requester",
    "server-requester",
    "client-notification",
];

struct Routers {
    client: RouterClient,
    server: RouterServer,
    client_services: ServiceManager,
    server_services: ServiceManager,
}

#[derive(Debug)]
struct Heard(Procedure);

impl crate::NotificationLike for Heard {
    fn procedure(&self) -> &Procedure {
        &self.0
    }

    fn trigger(
        &self,
        _payload: bytes::Bytes,
    ) -> Result<
        crate::BoxFuture<Vec<Result<(), Arc<dyn std::error::Error + Send + Sync>>>>,
        crate::RouterError,
    > {
        Ok(Box::pin(async { Vec::new() }))
    }
}

impl Routers {
    fn new() -> Self {
        let clock = crate::testing::SteppingClock::new(crate::testing::instants::new_year());
        let client = RouterClient::new(
            crate::testing::scripted::ScriptedClient::new(
                Arc::<crate::testing::SteppingClock>::clone(&clock),
            ),
            &RouterClientOptions::default(),
        )
        .expect("a client's router without a registry");
        let server = RouterServer::new(
            crate::testing::scripted::ScriptedServer::new(clock),
            &RouterServerOptions::default(),
        )
        .expect("a server's router without a registry");
        Self {
            client_services: ServiceManager::new(
                ServiceRouter::Client(client.clone()),
                &ServiceManagerOptions::default(),
            )
            .expect("client services"),
            server_services: ServiceManager::new(
                ServiceRouter::Server(server.clone()),
                &ServiceManagerOptions::default(),
            )
            .expect("server services"),
            client,
            server,
        }
    }

    async fn dispose(&self) {
        self.client.dispose().await;
        self.server.dispose().await;
    }
}

fn echo() -> Procedure {
    Procedure {
        service_id: 1,
        procedure_id: 1,
        service_revision: 1,
        procedure_name: "echo".to_owned(),
        procedure_kind: None,
        maximum_payload_bytes: None,
        deprecation: None,
    }
}

fn callback() -> crate::ResolverCallback<JsonCodec, JsonCodec> {
    Arc::new(|request, response| response.result(request.payload))
}

fn declare(way: &str, (procedure, routers): (&Procedure, &Routers)) -> Result<(), ProgrammerError> {
    match way {
        "client-resolver" => routers
            .client_services
            .get_command_resolver(
                procedure,
                RequestResolverDependencies::new(JsonCodec, JsonCodec),
            )?
            .on(callback()),
        "server-resolver" => routers
            .server_services
            .get_request_resolver(
                procedure,
                RequestResolverDependencies::new(JsonCodec, JsonCodec),
            )?
            .on(callback()),
        "server-notification-resolver" => routers
            .server_services
            .get_notification_resolver(
                procedure,
                NotificationResolverDependencies::new(
                    RequestResolverDependencies::new(JsonCodec, JsonCodec),
                    JsonCodec,
                ),
            )?
            .on(callback())
            .map(drop),
        "client-requester" => routers.client.declare_requester(procedure).map(drop),
        "server-requester" => routers.server.declare_requester(procedure).map(drop),
        "client-notification" => routers
            .client
            .register_notification(Arc::new(Heard(procedure.clone()))),
        other => panic!("no identity declaration way {other}"),
    }
}

fn group(name: &str) -> Vec<Value> {
    let file: Value = files::read("identities.json").expect("the identity file");
    let entries = file
        .get(name)
        .and_then(Value::as_array)
        .expect("the named vector group");
    assert!(!entries.is_empty(), "{name} has its entries");
    entries.clone()
}

fn is_excused(entry: &Value) -> bool {
    let differs: Vec<crate::testing::Difference> = serde_json::from_value(
        entry
            .get("differs")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .expect("valid differences");
    crate::testing::is_excused(&differs)
}

async fn each_way(entry: &Value, procedure: &Procedure) {
    for way in WAYS {
        let routers = Routers::new();
        let outcome = declare(way, (procedure, &routers));
        let refused_here = entry
            .get("refusedAt")
            .and_then(Value::as_array)
            .is_none_or(|ways| ways.iter().any(|at| at.as_str() == Some(way)));
        let reason = entry
            .get("refused")
            .and_then(Value::as_str)
            .filter(|_| refused_here);
        if let Some(reason) = reason {
            let error = outcome.expect_err("the declaration is refused");
            let expected = [
                IdentityRefusal::OutOfItsRange,
                IdentityRefusal::OffItsForm,
                IdentityRefusal::AgainstItsKind,
            ]
            .into_iter()
            .find(|refusal| refusal.as_str() == reason)
            .expect("an identity refusal");
            assert_eq!(
                error.reason(),
                Some(Refusal::Identity(expected)),
                "{}: {way}",
                entry["name"]
            );
            assert!(
                error.message().contains(&format!(" is {reason}: ")),
                "{error}"
            );
            declare(way, (&echo(), &routers)).expect("a refused declaration declared nothing");
        } else {
            outcome.expect("the declaration holds");
        }
        routers.dispose().await;
    }
}

#[test]
fn its_table_plays_the_ways_the_file_lists_and_no_other() {
    let mut given: Vec<String> = group("ways")
        .into_iter()
        .map(|way| way.as_str().expect("a way").to_owned())
        .collect();
    let mut table = WAYS.map(str::to_owned).to_vec();
    given.sort_unstable();
    table.sort_unstable();
    assert_eq!(given, table);
}

#[tokio::test]
async fn names_entry_name() {
    for entry in group("names") {
        assert!(!is_excused(&entry));
        let procedure = Procedure {
            procedure_name: entry["procedureName"].as_str().expect("a name").to_owned(),
            ..echo()
        };
        each_way(&entry, &procedure).await;
    }
}

#[tokio::test]
async fn ids_entry_name() {
    let mut native = 0;
    for entry in group("ids") {
        let ids = entry["serviceId"]
            .as_u64()
            .and_then(|id| u16::try_from(id).ok())
            .zip(
                entry["procedureId"]
                    .as_u64()
                    .and_then(|id| u16::try_from(id).ok()),
            );
        let revision = entry["serviceRevision"]
            .as_u64()
            .and_then(|id| u32::try_from(id).ok());
        let Some(((service_id, procedure_id), service_revision)) = ids.zip(revision) else {
            assert!(is_excused(&entry), "{} has its matrix row", entry["name"]);
            native += 1;
            continue;
        };
        assert!(!is_excused(&entry), "{} is played", entry["name"]);
        let procedure = Procedure {
            service_id,
            procedure_id,
            service_revision,
            procedure_name: entry
                .get("procedureName")
                .and_then(Value::as_str)
                .unwrap_or("echo")
                .to_owned(),
            ..echo()
        };
        each_way(&entry, &procedure).await;
    }
    assert_eq!(native, 17, "only the matrix's unrepresentable id inputs");
}

#[tokio::test]
async fn procedure_kinds_entry_name() {
    for entry in group("procedureKinds") {
        assert!(!is_excused(&entry));
        let kind = entry.get("procedureKind").map(|kind| {
            ProcedureKind::named(kind.as_str().expect("a kind name")).expect("a named kind")
        });
        let service_id = entry.get("serviceId").map_or(1, |id| {
            u16::try_from(id.as_u64().expect("an id")).expect("a u16 id")
        });
        let procedure = Procedure {
            service_id,
            procedure_name: entry
                .get("procedureName")
                .and_then(Value::as_str)
                .unwrap_or("echo")
                .to_owned(),
            procedure_kind: kind,
            ..echo()
        };
        each_way(&entry, &procedure).await;
    }
}

#[test]
fn folds_entry_name() {
    for entry in group("folds") {
        assert!(!is_excused(&entry));
        let names = entry["names"].as_array().expect("two names");
        let one = names[0].as_str().expect("one name");
        let other = names[1].as_str().expect("another name");
        let same = entry["one"].as_bool().expect("whether they are one");
        assert_eq!(are_one_name(one, other), same, "{}", entry["name"]);
        assert_eq!(are_one_name(other, one), same, "{}", entry["name"]);
    }
}
