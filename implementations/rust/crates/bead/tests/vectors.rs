//! `spec/vectors.json` played: a trial per entry, named by its own name, its group its kind; every
//! group but those ahead, each named by its read.

use std::collections::BTreeMap;
use std::process::ExitCode;

use bead::internal::{
    LARGEST_PACKET_SIZE, LARGEST_REMAINING_LENGTH, MAXIMUM_DETAIL_BYTES, MqttPacket, MqttPublish,
    MqttPublishShapeOptions, MqttReading, ReadEnvelopeOptions, ReadHeader, header_bytes_of,
    largest_payload, publish_bytes, read_envelope, read_failure, read_header, read_packet,
    read_prefix, verify_jwt, write_envelope, write_header, write_publish,
};
use bead::json::JsonRefusal;
use bead::testing::instants;
use bead::testing::parcels::{self, ParcelReading, ParcelRefusalVector, ParcelVector};
use bead::testing::vectors::{
    self, EnvelopeVector, FailureRefusalVector, FailureVector, HeaderVector, PrefixVector,
    ReadVector, RefusalVector,
};
use bead::{
    Failure, FailureOrigin, FailureScope, JwtAgainst, JwtAlgorithm, JwtKey, JwtSessionIdentifier,
    JwtVerdict, RouterSide, json,
};
use std::sync::Arc;

use bead::internal::Envelope;
use bead::testing::SteppingClock;
use bead::{
    AccessRefusal, AccessRefusalStage, BoxFuture, ConnectionHandle, Credential, CredentialScheme,
    Credentials, ElsewhereSession, ElsewhereVerdict, JsonCodec, Procedure, RequestHeader,
    RequestResolverDependencies, RouterError, Sent, Server, ServerListener, ServerOptions,
    ServerTransport, SessionToken, SharedClock, TransportMessage,
};
use bytes::Bytes;
use libtest_mimic::{Arguments, Failed, Trial};
use serde::Deserialize;
use serde_json::{Map, Value};

/// A key as a verdict gives it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VectorKey {
    issuer: String,
    algorithm: String,
    jwk: Map<String, Value>,
}

/// A `JWT`, the keys, the audience or a set of them, the wall clock's reading, and its verdict.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct JwtVerdictVector {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    token: String,
    keys: Vec<VectorKey>,
    audience: Value,
    now: String,
    verdict: Map<String, Value>,
}

// a check that holds, or says what it found
fn hold<S: FnOnce() -> String>(holds: bool, said: S) -> Result<(), Failed> {
    if holds { Ok(()) } else { Err(said().into()) }
}

// a refusal of the protocol's, raised here by `side`, of `code`
fn refused(
    failure: &Failure,
    (code, side, detail): (u16, RouterSide, Option<&str>),
) -> Result<(), Failed> {
    hold(
        failure.code().get() == code
            && failure.scope() == FailureScope::Protocol
            && failure.origin() == FailureOrigin::Local
            && failure.side() == Some(side)
            && detail.is_none_or(|detail| failure.detail() == detail),
        || format!("refused with {failure:?}, not code {code} of the {side}, detail {detail:?}"),
    )
}

fn headers() -> Result<Vec<Trial>, String> {
    let entries: Vec<HeaderVector> = vectors::of("headers")?;

    Ok(entries
        .into_iter()
        .map(|vector| {
            Trial::test(
                format!("reads {}, and writes it back", vector.name),
                move || {
                    let expected = vectors::bytes_of(&vector.bytes)?;
                    let header = vectors::header_of(&vector.header)?;
                    let mut written = Vec::new();

                    hold(
                        write_header(&header, &mut written)? == expected.len(),
                        || "the length written".to_owned(),
                    )?;
                    hold(written == expected, || format!("wrote {written:02X?}"))?;
                    hold(header_bytes_of(&header)? == expected.len(), || {
                        "its length".to_owned()
                    })?;

                    let read = read_header(&expected, RouterSide::Server)?;

                    hold(
                        read == Some(ReadHeader {
                            header,
                            header_bytes: expected.len(),
                        }),
                        || format!("read {read:?}"),
                    )
                },
            )
            .with_kind("headers")
        })
        .collect())
}

fn reads() -> Result<Vec<Trial>, String> {
    let entries: Vec<ReadVector> = vectors::of("reads")?;

    Ok(entries
        .into_iter()
        .map(|vector| {
            Trial::test(format!("reads {}", vector.name), move || {
                let bytes = vectors::bytes_of(&vector.bytes)?;
                let read = read_header(&bytes, vectors::side_of(&vector.side)?)?;
                let expected = vector
                    .header
                    .as_ref()
                    .map(vectors::header_of)
                    .transpose()?
                    .map(|header| ReadHeader {
                        header,
                        header_bytes: bytes.len(),
                    });

                hold(read == expected, || format!("read {read:?}"))
            })
            .with_kind("reads")
        })
        .collect())
}

fn prefixes() -> Result<Vec<Trial>, String> {
    let entries: Vec<PrefixVector> = vectors::of("prefixes")?;
    let refusals: Vec<RefusalVector> = vectors::of("prefixRefusals")?;
    let mut trials: Vec<Trial> = entries
        .into_iter()
        .map(|vector| {
            Trial::test(format!("reads {}", vector.name), move || {
                let prefix = read_prefix(&vectors::bytes_of(&vector.bytes)?, RouterSide::Client)?;

                hold(
                    (prefix.call_id, prefix.kind, prefix.layout)
                        == (
                            vector.prefix.call_id,
                            vector.prefix.kind,
                            vector.prefix.layout,
                        ),
                    || format!("read {prefix:?}"),
                )
            })
            .with_kind("prefixes")
        })
        .collect();

    trials.extend(refusals.into_iter().map(|vector| {
        Trial::test(format!("refuses {}", vector.name), move || {
            let bytes = vectors::bytes_of(&vector.bytes)?;

            match read_prefix(&bytes, RouterSide::Client) {
                Ok(prefix) => Err(format!("read {prefix:?}").into()),
                Err(failure) => refused(
                    &failure,
                    (vector.code, RouterSide::Client, vector.detail.as_deref()),
                ),
            }
        })
        .with_kind("prefixRefusals")
    }));

    Ok(trials)
}

fn header_refusals() -> Result<Vec<Trial>, String> {
    let mut entries: Vec<RefusalVector> = vectors::of("prefixRefusals")?;

    let header_refusals: Vec<RefusalVector> = vectors::of("headerRefusals")?;

    entries.extend(header_refusals);

    Ok(entries
        .into_iter()
        .map(|vector| {
            Trial::test(
                format!("a header's read refuses {}", vector.name),
                move || match read_header(&vectors::bytes_of(&vector.bytes)?, RouterSide::Server) {
                    Ok(read) => Err(format!("read {read:?}").into()),
                    Err(failure) => refused(
                        &failure,
                        (vector.code, RouterSide::Server, vector.detail.as_deref()),
                    ),
                },
            )
            .with_kind("headerRefusals")
        })
        .collect())
}

fn envelopes() -> Result<Vec<Trial>, String> {
    let entries: Vec<EnvelopeVector> = vectors::of("envelopes")?;
    let refusals: Vec<RefusalVector> = vectors::of("envelopeRefusals")?;
    let mut trials: Vec<Trial> = entries
        .into_iter()
        .map(|vector| {
            Trial::test(
                format!("reads {}, and writes it back", vector.name),
                move || {
                    let bytes = vectors::bytes_of(&vector.bytes)?;
                    let expected = vectors::envelope_of(&vector.envelope)?;
                    let read =
                        read_envelope(&bytes, RouterSide::Server, &ReadEnvelopeOptions::default())?;

                    hold(read.as_ref() == Some(&expected), || {
                        format!("read {read:?}")
                    })?;

                    let written = write_envelope(&expected, MAXIMUM_DETAIL_BYTES)?;

                    hold(written == bytes, || format!("wrote {written:02X?}"))
                },
            )
            .with_kind("envelopes")
        })
        .collect();

    trials.extend(refusals.into_iter().map(|vector| {
        Trial::test(format!("refuses {}", vector.name), move || {
            let mut options = ReadEnvelopeOptions::default();

            options.maximum_envelope_bytes = vector.maximum_envelope_bytes;

            match read_envelope(
                &vectors::bytes_of(&vector.bytes)?,
                RouterSide::Server,
                &options,
            ) {
                Ok(read) => Err(format!("read {read:?}").into()),
                Err(failure) => refused(
                    &failure,
                    (vector.code, RouterSide::Server, vector.detail.as_deref()),
                ),
            }
        })
        .with_kind("envelopeRefusals")
    }));

    Ok(trials)
}

fn failures() -> Result<Vec<Trial>, String> {
    let entries: Vec<FailureVector> = vectors::of("failures")?;
    let refusals: Vec<FailureRefusalVector> = vectors::of("failureRefusals")?;
    let mut trials: Vec<Trial> = entries
        .into_iter()
        .map(|vector| {
            Trial::test(format!("reads {}", vector.name), move || {
                let mut options = ReadEnvelopeOptions::default();

                options.maximum_detail_bytes = vector.maximum_detail_bytes;

                let record = read_failure(
                    &vectors::bytes_of(&vector.record)?,
                    RouterSide::Server,
                    &options,
                )?;
                let expected = vectors::record_of(&vector.failure)?;

                hold(record == expected, || format!("read {record:?}"))
            })
            .with_kind("failures")
        })
        .collect();

    trials.extend(refusals.into_iter().map(|vector| {
        Trial::test(
            format!("refuses {}", vector.name),
            move || match read_failure(
                &vectors::bytes_of(&vector.record)?,
                RouterSide::Server,
                &ReadEnvelopeOptions::default(),
            ) {
                Ok(read) => Err(format!("read {read:?}").into()),
                Err(failure) => refused(&failure, (vector.code, RouterSide::Server, None)),
            },
        )
        .with_kind("failureRefusals")
    }));

    Ok(trials)
}

// the verdict as the vectors write it
fn verdict_json(verdict: &JwtVerdict) -> Value {
    let mut written = Map::new();

    match verdict {
        JwtVerdict::Holds {
            claims,
            end,
            identifier,
        } => {
            let mut named = Map::new();

            match identifier {
                JwtSessionIdentifier::Sid { issuer, sid } => {
                    named.insert("issuer".to_owned(), Value::String(issuer.clone()));
                    named.insert("sid".to_owned(), Value::String(sid.clone()));
                }
                JwtSessionIdentifier::Sub { issuer, sub } => {
                    named.insert("issuer".to_owned(), Value::String(issuer.clone()));
                    named.insert("sub".to_owned(), Value::String(sub.clone()));
                }
                _ => {}
            }

            written.insert("holds".to_owned(), Value::Bool(true));
            written.insert("identifier".to_owned(), Value::Object(named));
            written.insert("claims".to_owned(), Value::Object(claims.clone()));
            written.insert("end".to_owned(), Value::Number((*end).into()));
        }
        JwtVerdict::Refused(reason) => {
            written.insert("holds".to_owned(), Value::Bool(false));
            written.insert(
                "reason".to_owned(),
                Value::String(reason.as_str().to_owned()),
            );
        }
        _ => {}
    }

    Value::Object(written)
}

fn jwt_verdicts() -> Result<Vec<Trial>, String> {
    let entries: Vec<JwtVerdictVector> = vectors::of("jwtVerdicts")?;

    Ok(entries
        .into_iter()
        .map(|vector| {
            Trial::test(
                format!("gives each JWT its verdict: {}", vector.name),
                move || {
                    let keys = vector
                        .keys
                        .iter()
                        .map(|key| {
                            Ok(JwtKey {
                                algorithm: JwtAlgorithm::named(&key.algorithm)
                                    .ok_or_else(|| format!("{} is no algorithm", key.algorithm))?,
                                issuer: key.issuer.clone(),
                                jwk: key.jwk.clone(),
                            })
                        })
                        .collect::<Result<Vec<JwtKey>, String>>()?;
                    let audiences: Vec<String> = match &vector.audience {
                        Value::String(audience) => vec![audience.clone()],
                        Value::Array(audiences) => audiences
                            .iter()
                            .filter_map(|audience| audience.as_str().map(str::to_owned))
                            .collect(),
                        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Object(_) => {
                            return Err("an audience is a string or a set of them".into());
                        }
                    };
                    let now = instants::instant_of(&vector.now).ok_or("now is an instant")?;
                    let token = vectors::latin1_bytes_of(&vector.token)?;
                    let verdict = verify_jwt(
                        &token,
                        &JwtAgainst {
                            audiences: &audiences,
                            keys: &keys,
                            now: &move || now,
                        },
                    )?;
                    // * compared member by member, each in its canonical form, so a number is the
                    // double it stands for, and a claims set nested 64 deep, as a token's may be,
                    // is written whole below no level of the verdict's own
                    let canonical = |verdict: Map<String, Value>| {
                        verdict
                            .into_iter()
                            .map(|(name, value)| Ok((name, json::write(&value)?)))
                            .collect::<Result<BTreeMap<String, Vec<u8>>, JsonRefusal>>()
                    };
                    let Value::Object(given) = verdict_json(&verdict) else {
                        return Err("a verdict is an object".into());
                    };
                    let got = canonical(given)?;
                    let expected = canonical(vector.verdict)?;

                    hold(got == expected, || {
                        let written = got
                            .iter()
                            .map(|(name, value)| {
                                format!("{name:?}: {}", String::from_utf8_lossy(value))
                            })
                            .collect::<Vec<String>>();

                        format!("gave {{{}}}", written.join(", "))
                    })
                },
            )
            .with_kind("jwtVerdicts")
        })
        .collect())
}

// ── credentialRefusals: each credential refused, told by its reason ──────────────────────────

/// A credential refused, the situation it is refused in, and its code and reason.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialRefusalVector {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    scheme: Value,
    situation: String,
    code: u16,
    reason: String,
}

fn locked<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// a transport server of two connections, which records what it sends
#[derive(Default)]
struct Recording {
    sent: std::sync::Mutex<Vec<(ConnectionHandle, Bytes)>>,
    listeners: std::sync::Mutex<Vec<Arc<dyn ServerListener>>>,
}

impl core::fmt::Debug for Recording {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.debug_struct("Recording").finish_non_exhaustive()
    }
}

impl Recording {
    fn tell<C: Fn(&dyn ServerListener)>(&self, call: C) {
        let listeners = locked(&self.listeners).clone();

        for listener in listeners {
            call(listener.as_ref());
        }
    }
}

impl ServerTransport for Recording {
    fn send(
        &self,
        message: TransportMessage,
        connection_handle: &ConnectionHandle,
    ) -> Result<Sent, RouterError> {
        locked(&self.sent).push((Arc::clone(connection_handle), message.data));

        Ok(Sent::Done)
    }

    fn close(&self, _connection_handle: &ConnectionHandle) -> BoxFuture<bool> {
        Box::pin(async { false })
    }

    fn listen(&self, listener: Arc<dyn ServerListener>) {
        locked(&self.listeners).push(listener);
    }

    fn unlisten(&self, listener: &Arc<dyn ServerListener>) {
        locked(&self.listeners).retain(|held| !Arc::ptr_eq(held, listener));
    }

    // a pause holds nothing here: a vector hands a few envelopes, far under any bound
    fn pause(&self, _connection_handle: &ConnectionHandle) {}

    fn resume(&self, _connection_handle: &ConnectionHandle) {}

    fn is_secure(&self, _connection_handle: &ConnectionHandle) -> bool {
        true
    }

    fn carries_credential(&self, _connection_handle: &ConnectionHandle) -> bool {
        true
    }

    fn stop(&self) -> BoxFuture<Result<(), RouterError>> {
        Box::pin(async { Ok(()) })
    }
}

const FIRST: &str = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";
const SECOND: &str = "type=WS;ip=127.0.0.1;port=50002;ordinal=1";

// a request of echo's, on call 1, presenting `credential`
fn echo_presenting(credential: Credential) -> Result<Bytes, String> {
    write_envelope(
        &Envelope::Request {
            header: RequestHeader {
                call_id: 1,
                service_id: 1,
                procedure_id: 1,
                destination_id: None,
                opens_subscription: false,
                paced: false,
                total: None,
                credential: Some(credential),
            },
            payload: Bytes::from_static(b"{}"),
        },
        MAXIMUM_DETAIL_BYTES,
    )
    .map_err(|error| error.to_string())
}

fn scheme_of(scheme: &Value) -> Result<CredentialScheme, String> {
    match scheme {
        Value::Number(number) => number
            .as_u64()
            .and_then(|number| u16::try_from(number).ok())
            .map(CredentialScheme::new)
            .ok_or_else(|| "a scheme to come is a number".to_owned()),
        Value::String(name) => match name.as_str() {
            "OPAQUE" => Ok(CredentialScheme::OPAQUE),
            "JWT" => Ok(CredentialScheme::JWT),
            "ELSEWHERE" => Ok(CredentialScheme::ELSEWHERE),
            other => Err(format!("{other} is no scheme")),
        },
        Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => {
            Err("a scheme is a name or a number".to_owned())
        }
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "one server built, refused and read, as the other sides' twin does"
)]
async fn refused_credential(vector: &CredentialRefusalVector) -> Result<(), Failed> {
    let now = instants::instant_of("2026-01-01T00:00:00Z").ok_or("an instant")?;
    let clock = SteppingClock::new(now);
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let scheme = scheme_of(&vector.scheme)?;
    let situation = vector.situation.as_str();
    let mut credentials = Credentials::default();

    // the verifier's settling, or none: none makes no session, a past end one whose end came
    if !matches!(situation, "no-verifier" | "no-keys" | "scheme-to-come") {
        let ended_at = i64::try_from(
            now.duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_millis(),
        )
        .map_err(|error| error.to_string())?;
        let settled = (situation == "end-come").then(|| ElsewhereSession {
            id: "ada".to_owned(),
            data: Some(Value::String("ada".to_owned())),
            end: Value::from(ended_at).as_f64(),
        });

        credentials.verify = Some(Arc::new(
            move |_carried: String, _signal| -> BoxFuture<ElsewhereVerdict> {
                let settled = settled.clone();

                Box::pin(async move { Ok(settled) })
            },
        ));
    }

    let transport = Arc::new(Recording::default());
    let mut options = ServerOptions::default();

    options.clock = Some(Arc::clone(&shared));
    options.credentials = Some(credentials);

    let server = Server::new(Arc::<Recording>::clone(&transport), &options)?;
    let told: Arc<std::sync::Mutex<Vec<AccessRefusal>>> = Arc::default();
    let telling = Arc::clone(&told);

    server
        .router()
        .on_access_refused(Arc::new(move |refusal: &AccessRefusal| {
            locked(&telling).push(refusal.clone());
        }));

    let echo = Procedure {
        service_id: 1,
        procedure_id: 1,
        service_revision: 1,
        procedure_name: "echo".to_owned(),
        procedure_kind: Some(bead::ProcedureKind::Request),
        maximum_payload_bytes: None,
        deprecation: None,
    };

    server
        .services()
        .get_request_resolver(
            &echo,
            RequestResolverDependencies::new(JsonCodec, JsonCodec),
        )?
        .on(Arc::new(|request, response: bead::Response<JsonCodec>| {
            response.result(request.payload)
        }))?;

    let (first, second): (ConnectionHandle, ConnectionHandle) =
        (Arc::from(FIRST), Arc::from(SECOND));

    transport.tell(|listener| listener.on_connection(&first));
    transport.tell(|listener| listener.on_connection(&second));
    clock.settle().await;

    // an OPAQUE holds on the connection whose session its token is: second's here
    let stored = server
        .sessions()
        .set(server.sessions().create(Arc::clone(&second)))?
        .await?;
    let token = stored
        .session_token
        .ok_or("a session stored draws its token")?;
    let credential = match situation {
        "another-connections-session" => Credential::Opaque(token),
        "no-session" => Credential::Opaque(SessionToken::new([7; 16])?),
        "no-keys" => Credential::Jwt(Bytes::from_static(b"a.b.c")),
        "scheme-to-come" => Credential::ToCome {
            scheme,
            bytes: Bytes::new(),
        },
        "nothing-carried" | "no-verifier" | "verifier-makes-none" | "end-come" => {
            Credential::Elsewhere
        }
        other => {
            return Err(format!("{other} is no credential situation this player plays").into());
        }
    };
    let carried = (situation != "nothing-carried").then(|| "Interop sub=ada".to_owned());
    let data = echo_presenting(credential)?;

    transport.tell(|listener| {
        let mut message = TransportMessage::default();

        message.data = data.clone();
        message.credential.clone_from(&carried);
        listener.on_message(message, &first);
    });
    clock.settle().await;

    let answers: Vec<(ConnectionHandle, u32, Option<u16>)> = locked(&transport.sent)
        .iter()
        .filter_map(|(handle, bytes)| {
            match read_envelope(bytes, RouterSide::Client, &ReadEnvelopeOptions::default()) {
                Ok(Some(Envelope::Failure { header, failure })) => {
                    Some((Arc::clone(handle), header.call_id, Some(failure.code.get())))
                }
                Ok(Some(envelope)) => Some((Arc::clone(handle), envelope.call_id(), None)),
                _ => None,
            }
        })
        .collect();
    let told = locked(&told).clone();

    server.dispose().await?;

    hold(
        answers == vec![(Arc::clone(&first), 1, Some(vector.code))],
        || format!("{}: answered {answers:?}", vector.name),
    )?;

    let refusal = told.first().ok_or("a refusal told")?;

    hold(
        told.len() == 1
            && refusal.code == vector.code
            && refusal.connection_handle == first
            && refusal.credential_scheme == Some(scheme)
            && refusal.procedure_id == 1
            && refusal.service_id == 1
            && refusal.reason.as_deref() == Some(vector.reason.as_str())
            && refusal.stage == AccessRefusalStage::Credential,
        || format!("{}: told {told:?}", vector.name),
    )
}

fn credential_refusals() -> Result<Vec<Trial>, String> {
    let entries: Vec<CredentialRefusalVector> = vectors::of("credentialRefusals")?;

    Ok(entries
        .into_iter()
        .map(|vector| {
            Trial::test(
                format!(
                    "tells each credential refused by its reason: {}",
                    vector.name
                ),
                move || {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|error| error.to_string())?;

                    runtime.block_on(refused_credential(&vector))
                },
            )
            .with_kind("credentialRefusals")
        })
        .collect())
}

// spec 15.17: each parcel read to its fields and written back to its bytes, but those no writer
// writes, which the side's writer refuses
fn parcels() -> Result<Vec<Trial>, String> {
    let entries: Vec<ParcelVector> = vectors::of("parcels")?;
    let refusals: Vec<ParcelRefusalVector> = vectors::of("parcelRefusals")?;
    let mut trials: Vec<Trial> = entries
        .into_iter()
        .map(|vector| {
            Trial::test(format!("reads the parcel {}", vector.name), move || {
                let bytes = vectors::bytes_of(&vector.bytes)?;
                let expected = parcels::normalized(&vector.parcel)?;
                let ParcelReading::Parcel(read) = parcels::read(&bytes) else {
                    return Err(format!("read {:?}", parcels::read(&bytes)).into());
                };

                hold(read == expected, || {
                    format!("read {read:?}, not {expected:?}")
                })?;

                // * written back byte for byte, but what a side reads and no writer writes
                match (vector.written, parcels::write(&read)) {
                    (Some(false), Ok(written)) => {
                        Err(format!("wrote {written:02X?}, which no writer writes").into())
                    }
                    (Some(false), Err(_)) => Ok(()),
                    (_, Ok(written)) => hold(written == bytes.as_ref(), || {
                        format!("wrote {written:02X?}")
                    }),
                    (_, Err(refused)) => Err(format!("refused to write it: {refused}").into()),
                }
            })
            .with_kind("parcels")
        })
        .collect();

    trials.extend(refusals.into_iter().map(|vector| {
        Trial::test(format!("refuses the parcel {}", vector.name), move || {
            let bytes = vectors::bytes_of(&vector.bytes)?;
            let refused = match parcels::read(&bytes) {
                ParcelReading::NoParcel(_) => "no-parcel",
                ParcelReading::DoesNotRead(..) => "does-not-read",
                ParcelReading::Parcel(_) => "a parcel",
            };

            hold(refused == vector.refused, || format!("read as {refused}"))
        })
        .with_kind("parcelRefusals")
    }));

    Ok(trials)
}

/// A row of `mqttPublishBounds`: a topic, a bound and a shape, and the largest payload within it
/// and the packet it makes, none where an empty one does not fit.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MqttPublishBound {
    name: String,
    topic: String,
    maximum_packet_size: u64,
    qos: u8,
    expiry: bool,
    largest_payload: Option<u64>,
    packet_bytes: Option<u64>,
}

// the largest packet written to check the count against, so that no vector's 268 MB is allocated
const WRITTEN_UP_TO: u64 = 17_000_000;

// spec 15.30: each row's largest payload within its bound found exactly, the packet it makes counted
// to its every byte, and that count held to the bytes the client writes a PUBLISH in
fn mqtt_publish_bounds() -> Result<Vec<Trial>, String> {
    let entries: Vec<MqttPublishBound> = vectors::of("mqttPublishBounds")?;

    Ok(vec![Trial::test(
        "plays_mqtt_publish_bounds_a_publish_counted_to_its_every_byte_and_the_largest_payload_within_a_bound_found_exactly",
        move || {
            hold(!entries.is_empty(), || "no row".to_owned())?;

            for vector in &entries {
                let name = &vector.name;
                let mut shape = MqttPublishShapeOptions::default();

                shape.is_at_most_once = Some(vector.qos == 0);
                shape.has_life = Some(vector.expiry);

                let topic_bytes = u64::try_from(vector.topic.len()).map_err(|error| error.to_string())?;
                let found = largest_payload(&vector.topic, vector.maximum_packet_size, &shape);

                hold(found == vector.largest_payload, || {
                    format!("{name}: its largest payload {found:?}")
                })?;

                let Some(found) = found else {
                    hold(
                        publish_bytes(topic_bytes, 0, &shape) > vector.maximum_packet_size,
                        || format!("{name}: an empty one fits"),
                    )?;
                    hold(vector.packet_bytes.is_none(), || {
                        format!("{name}: its packet")
                    })?;

                    continue;
                };
                let counted = publish_bytes(topic_bytes, found, &shape);

                hold(Some(counted) == vector.packet_bytes, || {
                    format!("{name}: its packet of {counted} bytes")
                })?;
                // * exactly: one byte more passes the bound, or the largest Remaining Length
                hold(
                    publish_bytes(topic_bytes, found.saturating_add(1), &shape)
                        > vector.maximum_packet_size
                        || found.saturating_add(1) > u64::from(LARGEST_REMAINING_LENGTH),
                    || format!("{name}: one byte more fits"),
                )?;

                if counted <= WRITTEN_UP_TO {
                    let mut publish = MqttPublish::default();

                    publish.topic.clone_from(&vector.topic);
                    publish.packet_identifier = (vector.qos == 1).then_some(1);
                    publish.message_expiry_interval = vector.expiry.then_some(60);
                    publish.payload = Bytes::from(vec![
                        0;
                        usize::try_from(found).map_err(|error| error.to_string())?
                    ]);

                    let written = write_publish(&publish).map_err(|error| error.to_string())?;

                    hold(u64::try_from(written.len()) == Ok(counted), || {
                        format!("{name}: written in {} bytes", written.len())
                    })?;
                }
            }

            hold(LARGEST_PACKET_SIZE == 268_435_460, || {
                "the largest packet MQTT 5 writes".to_owned()
            })
        },
    )
    .with_kind("mqttPublishBounds")])
}

/// A row of `mqttAcknowledgementCodes`: a packet, its type, and the Reason Codes its table names.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct MqttAcknowledgementCodes {
    name: String,
    #[serde(rename = "clauses")]
    _clauses: Vec<String>,
    packet: String,
    #[serde(rename = "type")]
    kind: u8,
    named: Vec<u8>,
}

// a packet of its row's type answering identifier 1 with `code`: a PUBACK's code after its
// identifier, a SUBACK's and an UNSUBACK's after its properties' length
fn acknowledgement_bytes(kind: u8, code: u8) -> Vec<u8> {
    let first = kind.checked_shl(4).unwrap_or_default();

    if kind == 4 {
        vec![first, 0x03, 0x00, 0x01, code]
    } else {
        vec![first, 0x04, 0x00, 0x01, 0x00, code]
    }
}

// spec 15.27, 15.28, 15.29: every code of each row read by its packet's table, named, a refusal of
// 0x80 or more, or under 0x80 a packet its client cannot read
fn mqtt_acknowledgement_codes() -> Result<Vec<Trial>, String> {
    let entries: Vec<MqttAcknowledgementCodes> = vectors::of("mqttAcknowledgementCodes")?;

    Ok(vec![
        Trial::test("plays_mqtt_acknowledgement_codes", move || {
            hold(entries.len() == 3, || format!("{} rows", entries.len()))?;

            for vector in &entries {
                let name = &vector.name;

                for code in 0..=u8::MAX {
                    let bytes = acknowledgement_bytes(vector.kind, code);
                    let is_named = vector.named.contains(&code);

                    match read_packet(&bytes, LARGEST_PACKET_SIZE) {
                        Ok(MqttReading::Packet { packet, .. }) => {
                            let ((4, MqttPacket::Puback(read))
                            | (9, MqttPacket::Suback(read))
                            | (11, MqttPacket::Unsuback(read))) = (vector.kind, &packet)
                            else {
                                return Err(format!(
                                    "{name}: 0x{code:02X} read as {packet:?}, no {}",
                                    vector.packet
                                )
                                .into());
                            };

                            // * named, or a refusal its adapter tells by a code of 0x80 or more
                            hold(is_named || code >= 0x80, || {
                                format!("{name}: 0x{code:02X}, unreadable, read")
                            })?;
                            hold(read.reason_code() == code, || {
                                format!("{name}: 0x{code:02X} read as {:?}", read.reason_codes)
                            })?;
                        }
                        Ok(MqttReading::Partial) => {
                            return Err(format!("{name}: 0x{code:02X} wants more bytes").into());
                        }
                        Err(refusal) => {
                            hold(!is_named && code < 0x80, || {
                                format!("{name}: 0x{code:02X} refused: {refusal}")
                            })?;
                            hold(refusal.to_string().contains(&vector.packet), || {
                                format!("{name}: 0x{code:02X} refused as {refusal}")
                            })?;
                        }
                    }
                }
            }

            Ok(())
        })
        .with_kind("mqttAcknowledgementCodes"),
    ])
}

fn main() -> ExitCode {
    let arguments = Arguments::from_args();
    let mut trials = Vec::new();

    for group in [
        headers(),
        reads(),
        prefixes(),
        header_refusals(),
        envelopes(),
        failures(),
        jwt_verdicts(),
        credential_refusals(),
        parcels(),
        mqtt_publish_bounds(),
        mqtt_acknowledgement_codes(),
    ] {
        match group {
            Ok(group) => trials.extend(group),
            Err(error) => trials.push(Trial::test("reads its group", move || Err(error.into()))),
        }
    }

    libtest_mimic::run(&arguments, trials).exit_code()
}
