//! Credentials presented by a client's facade, their renewal and the defaults a refusal withdraws.

use std::sync::{Arc, Mutex};

use bytes::Bytes;

use super::client::Notified;
use super::{Scripted, TIMEOUT, answered, failure_of, locked, request_of, result_of, token};
use crate::clock::SharedClock;
use crate::constants::{CredentialScheme, FailureScope, ProtocolCode, RouterSide};
use crate::credentials::{Credentials, JwtKeySet};
use crate::envelope::{Credential, Envelope};
use crate::errors::CallError;
use crate::failure::{Failure, FailureOrigin};
use crate::jwt_verifier::{JwtAlgorithm, JwtKey};
use crate::router::client::{RouterClient, RouterClientOptions};
use crate::router::server::Call;
use crate::router::types::{RequestCredential, RouterError, RouterLimitsOptions, TransportMessage};
use crate::testing::SteppingClock;
use crate::testing::scripted::{ScriptedClient, bytes_of, envelope_of};
use crate::testing::surface::Consumer;

use crate::transport::{ClientListener, ReadyState, RouterClientTransport, Sent};

const CARRIED: &str = "Bearer mF_9.B5f-4.1JqM";

// A WebSocket upgrade carries these bytes alone; its messages and listeners are scripted.
#[derive(Debug)]
struct Upgraded {
    transport: Arc<ScriptedClient>,
    credential: &'static str,
}

impl RouterClientTransport for Upgraded {
    fn send(&self, message: TransportMessage) -> Result<Sent, RouterError> {
        self.transport.send(message)
    }

    fn listen(&self, listener: Arc<dyn ClientListener>) {
        self.transport.listen(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ClientListener>) {
        self.transport.unlisten(listener);
    }

    fn pause(&self) {
        self.transport.pause();
    }

    fn disconnect(&self) {
        RouterClientTransport::disconnect(&*self.transport);
    }

    fn resume(&self) {
        self.transport.resume();
    }

    fn clock(&self) -> Option<SharedClock> {
        self.transport.clock()
    }

    fn ready_state(&self) -> ReadyState {
        self.transport.ready_state()
    }

    fn is_secure(&self) -> bool {
        true
    }

    fn carries(&self, credential: &str) -> bool {
        credential == self.credential
    }
}

pub(super) fn upgraded(carried: &'static str, credential: Option<RequestCredential>) -> Scripted {
    let clock = SteppingClock::new(super::january_first());
    let transport = ScriptedClient::new(Arc::<SteppingClock>::clone(&clock));
    let router = RouterClient::new(
        Arc::new(Upgraded {
            transport: Arc::clone(&transport),
            credential: carried,
        }),
        &RouterClientOptions {
            credential,
            ..RouterClientOptions::default()
        },
    )
    .expect("a router over the upgrade");
    let errors = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&errors);

    router.on_error(Arc::new(move |error| {
        locked(&hearing).push(error.clone());
    }));

    Scripted {
        clock,
        transport,
        router,
        errors,
    }
}

async fn unreachable(call: Call) -> Failure {
    let CallError::Failure(failure) = answered(call).await.expect_err("DESTINATION_UNREACHABLE")
    else {
        panic!("a protocol failure")
    };

    assert_eq!(failure.code(), ProtocolCode::DESTINATION_UNREACHABLE.get());
    assert_eq!(failure.origin(), FailureOrigin::Local);
    assert_eq!(failure.side(), Some(RouterSide::Client));
    assert_eq!(
        failure.detail(),
        "its transport does not carry the credential ELSEWHERE stands for beside an envelope: none, or another"
    );
    failure
}

#[tokio::test]
async fn fails_an_elsewhere_over_a_transport_that_carries_none_before_it_goes_or_over_a_websocket_whose_upgrade_carried_other_bytes_destination_unreachable_nothing_sent_the_default_kept_no_event()
 {
    let scripted = scripted(elsewhere());
    let withdrawn = withdrawals(&scripted);

    scripted.transport.carry(false);

    for credential in [
        None,
        Some(RequestCredential::Elsewhere("Bearer renewed".to_owned())),
    ] {
        unreachable(ask(&scripted, credential)).await;
    }
    assert_eq!(presented(&scripted), []);

    let jwt = ask(&scripted, Some(jwt()));
    succeed(&scripted, (1, jwt)).await;
    assert_eq!(presented(&scripted), [(1, Some(jwt_header("a.b.c")), None)]);
    assert_eq!(scripted.router.credential(), Some(elsewhere()));
    assert_eq!(*locked(&withdrawn), []);
    assert_eq!(scripted.codes(), Vec::<String>::new());

    let over_upgrade = upgraded("Interop sub=bob", Some(elsewhere()));
    let withdrawn = withdrawals(&over_upgrade);
    let refused = unreachable(ask(&over_upgrade, None)).await;

    assert!(
        !format!("{:?}", refused.record()).contains(CARRIED),
        "no credential in its refusal"
    );
    assert_eq!(presented(&over_upgrade), []);

    let carried = ask(
        &over_upgrade,
        Some(RequestCredential::Elsewhere("Interop sub=bob".to_owned())),
    );

    succeed(&over_upgrade, (1, carried)).await;
    assert_eq!(
        presented(&over_upgrade),
        [(
            1,
            Some(Credential::Elsewhere),
            Some("Interop sub=bob".to_owned())
        )]
    );
    assert_eq!(over_upgrade.router.credential(), Some(elsewhere()));
    assert_eq!(*locked(&withdrawn), []);
    assert_eq!(over_upgrade.codes(), Vec::<String>::new());
    over_upgrade.router.dispose().await;
    scripted.router.dispose().await;
}

fn jwt() -> RequestCredential {
    RequestCredential::Jwt("a.b.c".to_owned())
}
fn renewed() -> RequestCredential {
    RequestCredential::Jwt("d.e.f".to_owned())
}
fn elsewhere() -> RequestCredential {
    RequestCredential::Elsewhere(CARRIED.to_owned())
}

fn scripted(credential: RequestCredential) -> Scripted {
    Scripted::with(&RouterClientOptions {
        credential: Some(credential),
        ..RouterClientOptions::default()
    })
}

fn ask(scripted: &Scripted, credential: Option<RequestCredential>) -> Call {
    let mut request = request_of((None, TIMEOUT));
    request.options.credential = credential;
    scripted
        .router
        .request(Bytes::new(), request)
        .expect("a request")
}

fn withdrawals(scripted: &Scripted) -> Arc<Mutex<Vec<CredentialScheme>>> {
    let withdrawn = Arc::new(Mutex::new(Vec::new()));
    let hearing = Arc::clone(&withdrawn);
    scripted
        .router
        .on_credential_withdrawn(Arc::new(move |scheme| {
            locked(&hearing).push(scheme);
        }));
    withdrawn
}

fn presented(scripted: &Scripted) -> Vec<(u32, Option<Credential>, Option<String>)> {
    scripted
        .transport
        .sent()
        .into_iter()
        .map(|message| {
            let Envelope::Request { header, .. } = envelope_of(&message.data, RouterSide::Server)
            else {
                panic!("a request")
            };
            (header.call_id, header.credential, message.credential)
        })
        .collect()
}

fn jwt_header(value: &str) -> Credential {
    Credential::Jwt(Bytes::copy_from_slice(value.as_bytes()))
}

async fn required(call: Call) -> Failure {
    let CallError::Failure(failure) = answered(call).await.expect_err("SESSION_REQUIRED") else {
        panic!("a failure")
    };
    assert_eq!(failure.code(), ProtocolCode::SESSION_REQUIRED.get());
    failure
}

async fn succeed(scripted: &Scripted, (call_id, call): (u32, Call)) {
    scripted.settle().await;
    scripted.transport.deliver(&result_of(call_id, None));
    answered(call).await.expect("the result");
}

#[expect(
    clippy::disallowed_methods,
    reason = "the test repeats its own string a bounded number of times"
)]
fn key() -> JwtKey {
    JwtKey {
        algorithm: JwtAlgorithm::Hs256,
        issuer: "https://issuer.example".to_owned(),
        jwk: serde_json::from_value(serde_json::json!({ "kty": "oct", "k": "A".repeat(43) }))
            .expect("a JWK"),
    }
}

#[tokio::test]
async fn presents_a_default_jwt_on_every_call_that_gives_none_of_its_own_and_hands_a_default_elsewheres_carried_value_to_its_transport_with_scheme_3_in_the_block()
 {
    for carried in [CARRIED, "Interop sub=ada"] {
        let scripted = scripted(jwt());
        let first = ask(&scripted, None);
        let second = ask(&scripted, None);
        let elsewhere = RequestCredential::Elsewhere(carried.to_owned());
        scripted
            .router
            .set_credential(Some(elsewhere.clone()))
            .expect("the default set");
        let third = ask(&scripted, None);
        for (call_id, call) in [(1, first), (3, second), (5, third)] {
            succeed(&scripted, (call_id, call)).await;
        }
        assert_eq!(
            presented(&scripted),
            [
                (1, Some(jwt_header("a.b.c")), None),
                (3, Some(jwt_header("a.b.c")), None),
                (5, Some(Credential::Elsewhere), Some(carried.to_owned()))
            ]
        );
        assert_eq!(scripted.router.credential(), Some(elsewhere));
        assert_eq!(
            scripted
                .transport
                .sent()
                .iter()
                .map(|message| message.data[2])
                .collect::<Vec<_>>(),
            [0x08; 3]
        );
    }
}

#[tokio::test]
async fn a_calls_own_credential_wins_over_the_default_none_presents_none_whatever_the_default_and_opaque_presents_the_session_learned()
 {
    for order in [
        [
            RequestCredential::None,
            RequestCredential::Opaque,
            renewed(),
            elsewhere(),
        ],
        [
            renewed(),
            RequestCredential::None,
            RequestCredential::Opaque,
            elsewhere(),
        ],
    ] {
        let scripted = scripted(jwt());
        scripted
            .transport
            .deliver(&result_of(99, Some(Credential::Opaque(token()))));
        scripted.settle().await;
        let expected: Vec<_> = order
            .iter()
            .enumerate()
            .map(|(index, credential)| {
                let (header, carried) = match credential {
                    RequestCredential::None => (None, None),
                    RequestCredential::Opaque => (Some(Credential::Opaque(token())), None),
                    RequestCredential::Jwt(value) => (Some(jwt_header(value)), None),
                    RequestCredential::Elsewhere(value) => {
                        (Some(Credential::Elsewhere), Some(value.clone()))
                    }
                };
                (
                    u32::try_from(index)
                        .expect("an index")
                        .saturating_mul(2)
                        .saturating_add(1),
                    header,
                    carried,
                )
            })
            .collect();
        let calls: Vec<_> = order
            .into_iter()
            .map(|credential| ask(&scripted, Some(credential)))
            .collect();
        for ((call_id, _, _), call) in expected.iter().zip(calls) {
            succeed(&scripted, (*call_id, call)).await;
        }
        assert_eq!(presented(&scripted), expected);
        assert_eq!(scripted.router.credential(), Some(jwt()));
    }
}

#[tokio::test]
async fn refuses_opaque_as_its_default_credential_and_a_jwt_under_limits_that_hold_no_header_of_1020_bytes()
 {
    let transport = ScriptedClient::new(SteppingClock::new(super::january_first()));
    for credential in [RequestCredential::Opaque, RequestCredential::None] {
        RouterClient::new(
            Arc::<ScriptedClient>::clone(&transport),
            &RouterClientOptions {
                credential: Some(credential),
                ..RouterClientOptions::default()
            },
        )
        .expect_err("no OPAQUE or NONE default");
    }
    let given = scripted(jwt());
    for credential in [RequestCredential::Opaque, RequestCredential::None] {
        given
            .router
            .set_credential(Some(credential))
            .expect_err("a default refused");
        assert_eq!(given.router.credential(), Some(jwt()));
    }
    let consumer = Consumer::new();
    consumer.refuses(
        "pub fn check(options: &mut bead::RouterClientOptions) { options.credential = Some(4); }",
        ("E0308", "mismatched types"),
    );
    consumer.refuses("pub fn check(options: &mut bead::RouterClientOptions, token: bead::SessionToken) { options.credential = Some(bead::Credential::Opaque(token)); }", ("E0308", "mismatched types"));
    for (chunk, window) in [(1_000, 2_000), (512, 1_024)] {
        let limits = RouterLimitsOptions {
            chunk_bytes: Some(chunk),
            maximum_envelope_bytes: Some(chunk),
            window_bytes: Some(window),
            ..RouterLimitsOptions::default()
        };
        for (credential, credentials) in [
            (Some(jwt()), None),
            (
                None,
                Some(Credentials {
                    audience: Some("https://bead.example".to_owned()),
                    keys: vec![key()],
                    ..Credentials::default()
                }),
            ),
        ] {
            RouterClient::new(
                Arc::<ScriptedClient>::clone(&transport),
                &RouterClientOptions {
                    credential,
                    credentials,
                    limits: Some(limits.clone()),
                    ..RouterClientOptions::default()
                },
            )
            .expect_err("a JWT's header needs its room");
        }
        let small = Scripted::with(&RouterClientOptions {
            credential: Some(elsewhere()),
            limits: Some(limits),
            ..RouterClientOptions::default()
        });
        small
            .router
            .set_credential(Some(jwt()))
            .expect_err("a JWT default needs its header's room");
        assert_eq!(small.router.credential(), Some(elsewhere()));
    }
}

#[tokio::test]
async fn refuses_as_it_is_built_keys_or_a_key_set_without_an_audience() {
    let transport = ScriptedClient::new(SteppingClock::new(super::january_first()));
    for mut credentials in [
        Credentials {
            keys: vec![key()],
            ..Credentials::default()
        },
        Credentials {
            key_set: Some(JwtKeySet {
                issuers: vec!["https://keys.example".to_owned()],
                ask: Arc::new(|_, _| Box::pin(async { Ok(Vec::new()) })),
                maximum_waiting_calls: None,
            }),
            ..Credentials::default()
        },
    ] {
        RouterClient::new(
            Arc::<ScriptedClient>::clone(&transport),
            &RouterClientOptions {
                credentials: Some(credentials.clone()),
                ..RouterClientOptions::default()
            },
        )
        .expect_err("an audience is required");
        credentials.audience = Some("https://bead.example".to_owned());
        let router = RouterClient::new(
            Arc::<ScriptedClient>::clone(&transport),
            &RouterClientOptions {
                credentials: Some(credentials),
                ..RouterClientOptions::default()
            },
        )
        .expect("an audience given");
        assert_eq!(router.credential(), None);
        router.dispose().await;
    }
}

#[tokio::test]
async fn withdraws_its_default_once_a_call_that_presented_it_is_refused_session_required_the_next_call_that_would_present_it_fails_before_it_goes_session_required_nothing_sent_and_credential_withdrawn_fires_once_its_scheme_alone()
 {
    let scripted = scripted(jwt());
    let withdrawn = withdrawals(&scripted);
    let first = ask(&scripted, None);
    let second = ask(&scripted, None);
    scripted.settle().await;
    scripted
        .transport
        .deliver(&failure_of(1, (ProtocolCode::SESSION_REQUIRED, None)));
    scripted
        .transport
        .deliver(&failure_of(3, (ProtocolCode::SESSION_REQUIRED, None)));
    assert!(!required(first).await.may_overtake());
    required(second).await;
    let next = required(ask(&scripted, None)).await;
    assert_eq!(
        (next.detail(), next.origin(), next.scope(), next.side()),
        (
            "the default credential was withdrawn",
            FailureOrigin::Local,
            FailureScope::Protocol,
            Some(RouterSide::Client)
        )
    );
    assert_eq!(*locked(&withdrawn), [CredentialScheme::JWT]);
    assert_eq!(scripted.router.credential(), None);
    assert!(scripted.router.is_credential_withdrawn());
    assert_eq!(
        presented(&scripted),
        [
            (1, Some(jwt_header("a.b.c")), None),
            (3, Some(jwt_header("a.b.c")), None)
        ]
    );
}

#[tokio::test]
async fn after_a_withdrawal_a_call_that_gives_its_own_credential_or_none_goes_and_a_default_given_again_or_none_given_ends_the_withdrawal()
 {
    for (own, replacement) in [
        ([renewed(), RequestCredential::None], renewed()),
        (
            [RequestCredential::None, renewed()],
            RequestCredential::Jwt("g.h.i".to_owned()),
        ),
    ] {
        let scripted = scripted(jwt());
        let withdrawn = withdrawals(&scripted);
        assert!(!scripted.router.is_credential_withdrawn());
        let first = ask(&scripted, None);
        scripted.settle().await;
        scripted
            .transport
            .deliver(&failure_of(1, (ProtocolCode::SESSION_REQUIRED, None)));
        required(first).await;
        assert!(scripted.router.is_credential_withdrawn());
        let three = ask(&scripted, Some(own[0].clone()));
        let five = ask(&scripted, Some(own[1].clone()));
        succeed(&scripted, (3, three)).await;
        succeed(&scripted, (5, five)).await;
        assert!(scripted.router.is_credential_withdrawn());
        scripted
            .router
            .set_credential(Some(replacement.clone()))
            .expect("a default given again");
        assert!(!scripted.router.is_credential_withdrawn());
        let seven = ask(&scripted, None);
        succeed(&scripted, (7, seven)).await;
        let nine = ask(&scripted, None);
        scripted.settle().await;
        scripted
            .transport
            .deliver(&failure_of(9, (ProtocolCode::SESSION_REQUIRED, None)));
        required(nine).await;
        assert!(scripted.router.is_credential_withdrawn());
        scripted.router.set_credential(None).expect("none given");
        assert!(!scripted.router.is_credential_withdrawn());
        let eleven = ask(&scripted, None);
        succeed(&scripted, (11, eleven)).await;
        let own_header = |credential: &RequestCredential| match credential {
            RequestCredential::Jwt(value) => Some(jwt_header(value)),
            RequestCredential::None => None,
            RequestCredential::Opaque | RequestCredential::Elsewhere(_) => {
                panic!("the two credentials of the scenario")
            }
        };
        assert_eq!(
            presented(&scripted),
            [
                (1, Some(jwt_header("a.b.c")), None),
                (3, own_header(&own[0]), None),
                (5, own_header(&own[1]), None),
                (7, own_header(&replacement), None),
                (9, own_header(&replacement), None),
                (11, None, None)
            ]
        );
        assert_eq!(
            *locked(&withdrawn),
            [CredentialScheme::JWT, CredentialScheme::JWT]
        );
    }
}

#[tokio::test]
async fn withdraws_its_default_alike_when_the_refusal_crossed_a_relay() {
    let scripted = scripted(elsewhere());
    let withdrawn = withdrawals(&scripted);
    // the same request, each time anew
    let request = || {
        let mut request = request_of((None, TIMEOUT));
        request.options.destination_id = Some(7);
        request
    };
    let first = scripted
        .router
        .request(Bytes::new(), request())
        .expect("a relayed request");
    scripted.settle().await;
    let Envelope::Failure {
        header,
        mut failure,
    } = failure_of(1, (ProtocolCode::SESSION_REQUIRED, None))
    else {
        panic!("a failure")
    };
    failure.relays = 1;
    scripted
        .transport
        .deliver(&Envelope::Failure { header, failure });
    assert_eq!(required(first).await.origin(), FailureOrigin::Relayed);
    assert_eq!(*locked(&withdrawn), [CredentialScheme::ELSEWHERE]);
    assert_eq!(scripted.router.credential(), None);
    let second = scripted
        .router
        .request(Bytes::new(), request())
        .expect("a request future");
    let failure = required(second).await;
    assert_eq!(
        (failure.origin(), failure.destination_id()),
        (FailureOrigin::Local, Some(7))
    );
    assert_eq!(scripted.transport.sent().len(), 1);
}

#[tokio::test]
async fn withdraws_nothing_and_fires_nothing_on_the_refusal_of_a_call_that_presented_a_default_since_given_anew()
 {
    let scripted = scripted(jwt());
    let withdrawn = withdrawals(&scripted);
    let first = ask(&scripted, None);
    scripted.settle().await;
    scripted
        .router
        .set_credential(Some(renewed()))
        .expect("a renewed default");
    scripted
        .transport
        .deliver(&failure_of(1, (ProtocolCode::SESSION_REQUIRED, None)));
    required(first).await;
    assert_eq!(*locked(&withdrawn), Vec::new());
    assert_eq!(scripted.router.credential(), Some(renewed()));
}

#[tokio::test]
async fn withdraws_a_default_set_again_to_the_same_bytes_by_a_late_refusal_and_keeps_one_given_other_bytes()
 {
    for (initial, given, kept, scheme) in [
        (jwt(), jwt(), false, CredentialScheme::JWT),
        (jwt(), renewed(), true, CredentialScheme::JWT),
        (elsewhere(), elsewhere(), false, CredentialScheme::ELSEWHERE),
        (
            elsewhere(),
            RequestCredential::Elsewhere(format!("{CARRIED}, renewed")),
            true,
            CredentialScheme::ELSEWHERE,
        ),
        (
            RequestCredential::Elsewhere("Interop sub=ada".to_owned()),
            RequestCredential::Elsewhere("Interop sub=ada".to_owned()),
            false,
            CredentialScheme::ELSEWHERE,
        ),
        (
            RequestCredential::Elsewhere("Interop sub=ada".to_owned()),
            RequestCredential::Elsewhere("Interop sub=bob".to_owned()),
            true,
            CredentialScheme::ELSEWHERE,
        ),
    ] {
        let scripted = scripted(initial);
        let withdrawn = withdrawals(&scripted);
        let first = ask(&scripted, None);
        scripted.settle().await;
        scripted
            .router
            .set_credential(Some(given.clone()))
            .expect("the default set by value");
        scripted
            .transport
            .deliver(&failure_of(1, (ProtocolCode::SESSION_REQUIRED, None)));
        required(first).await;
        assert_eq!(scripted.router.credential(), kept.then_some(given));
        assert_eq!(
            *locked(&withdrawn),
            if kept { Vec::new() } else { vec![scheme] }
        );
    }
}

#[tokio::test]
async fn withdraws_nothing_when_a_call_that_presented_its_own_credential_is_refused_session_required()
 {
    let scripted = scripted(jwt());
    let withdrawn = withdrawals(&scripted);
    let first = ask(&scripted, Some(renewed()));
    let second = ask(&scripted, Some(RequestCredential::None));
    scripted.settle().await;
    scripted
        .transport
        .deliver(&failure_of(1, (ProtocolCode::SESSION_REQUIRED, None)));
    scripted
        .transport
        .deliver(&failure_of(3, (ProtocolCode::SESSION_REQUIRED, None)));
    required(first).await;
    required(second).await;
    assert_eq!(*locked(&withdrawn), Vec::new());
    assert_eq!(scripted.router.credential(), Some(jwt()));
}

#[tokio::test]
async fn withdraws_nothing_when_session_required_ends_an_answered_subscription() {
    let scripted = scripted(jwt());
    let withdrawn = withdrawals(&scripted);
    let notification = Notified::new(None);
    let subscribing = scripted.subscribe((&notification.like(), TIMEOUT)).await;
    succeed(&scripted, (1, subscribing)).await;
    scripted
        .transport
        .deliver(&failure_of(1, (ProtocolCode::SESSION_REQUIRED, None)));
    scripted.settle().await;
    assert_eq!(*locked(&withdrawn), Vec::new());
    assert_eq!(scripted.router.credential(), Some(jwt()));
    assert_eq!(
        notification.dropped(),
        [Some(ProtocolCode::SESSION_REQUIRED.get().get())]
    );
    assert!(!scripted.router.has_notification(&notification.like()));
}

#[tokio::test]
async fn withdraws_nothing_when_session_required_that_ends_a_subscription_overtakes_its_result_the_call_failing_with_it_marked()
 {
    let scripted = scripted(jwt());
    let withdrawn = withdrawals(&scripted);
    let notification = Notified::new(None);
    let subscribing = scripted.subscribe((&notification.like(), TIMEOUT)).await;
    scripted.transport.deliver_message(&TransportMessage {
        data: bytes_of(&failure_of(1, (ProtocolCode::SESSION_REQUIRED, None))),
        may_overtake: true,
        ..TransportMessage::default()
    });
    assert!(required(subscribing).await.may_overtake());
    scripted.transport.deliver(&result_of(1, None));
    scripted.settle().await;
    assert_eq!(*locked(&withdrawn), Vec::new());
    assert_eq!(scripted.router.credential(), Some(jwt()));
    assert_eq!(scripted.codes(), ["CALL_UNKNOWN"]);
}
