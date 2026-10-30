//! The interop service's resolvers, as Bead's Rust side answers them: what a client of any side
//! calls, and what `spec/conversations.json` plays against. Only the resolvers, the hook and the
//! rules of `checked` are written here.

use core::time::Duration;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bead::{
    AdmissionHook, BoxFuture, CallSession, ConnectionHandle, DestinationOptions,
    DestinationRegistration, Failure, JsonCodec, Judged, NotifyOptions, ProgrammerError,
    ProtocolCode, RelayTarget, RequestOptions, RequestProps, ResolverCallback, ResolverError,
    Response, RouterSide, Schedule, Server, ServiceServer, ServiceServerOptions, SessionIdentifier,
    Validate, ValidateOptions, Violation, ViolationHolder, hold_finite, session_key_of,
};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use crate::descriptors::{InteropProcedures, ON_PURPOSE, REGISTERED_ALREADY, interop_procedures};

const QUESTION: &str = "What time is it where you are?";
const CLOCK_MILLISECONDS: u64 = 10_000;

// the rules of `checked`, as spec/interop-service.json states them: 50 names at most, each of 1 to
// 3 characters, counted as code points
const MAXIMUM_NAMES: usize = 50;
const MINIMUM_CHARACTERS: usize = 1;
const MAXIMUM_CHARACTERS: usize = 3;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ── checked's rules ──────────────────────────────────────────────────────────────────────────

// the judging of one value: each violation held under its bound, the path as steps
struct Sink {
    fail_fast: bool,
    holder: ViolationHolder,
    path: Vec<(String, Option<usize>)>,
    violations: Vec<Violation>,
    more: u64,
    is_full: bool,
}

impl Sink {
    fn path_of(&self) -> Option<String> {
        (!self.path.is_empty()).then(|| {
            self.path
                .iter()
                .map(|(name, index)| {
                    index
                        .as_ref()
                        .map_or_else(|| name.clone(), |index| format!("{name}[{index}]"))
                })
                .collect::<Vec<_>>()
                .join(".")
        })
    }

    // a violation of `rule`, of `value`: whether the judging stops
    fn add(
        &mut self,
        (rule_id, message, bounds): (&str, String, Option<(&str, String)>),
        value: &Value,
    ) -> bool {
        if !self.is_full {
            let violation = Violation {
                bounds: bounds.map(|(name, bound)| {
                    let mut bounds = Map::new();

                    bounds.insert(name.to_owned(), Value::String(bound));

                    bounds
                }),
                field_path: self.path_of(),
                for_key: false,
                message: Some(message),
                rule_id: rule_id.to_owned(),
                value: Some(value.clone()),
            };

            if self.holder.hold(&violation) {
                self.violations.push(violation);

                return self.fail_fast;
            }

            self.is_full = true;
        }

        self.more = self.more.saturating_add(1);

        self.fail_fast
    }
}

fn names_of(request: &Value) -> Option<Vec<String>> {
    request
        .get("names")?
        .as_array()?
        .iter()
        .map(|name| name.as_str().map(str::to_owned))
        .collect()
}

/// `checked`'s rules, judged of `request`.
#[must_use]
pub fn judge_checked(request: &Value, options: ValidateOptions) -> Judged {
    let mut sink = Sink {
        fail_fast: options.fail_fast,
        holder: ViolationHolder::new(options.maximum_bytes),
        path: Vec::new(),
        violations: Vec::new(),
        more: 0,
        is_full: false,
    };
    let stopped = judge_names(request, &mut sink) && options.fail_fast;

    Judged {
        violations: sink.violations,
        more: sink.more,
        stopped,
    }
}

fn judge_names(request: &Value, sink: &mut Sink) -> bool {
    sink.path.push(("names".to_owned(), None));

    let Some(names) = names_of(request) else {
        return sink.add(("required", "value is required".to_owned(), None), request);
    };
    let all: Value = names.iter().cloned().map(Value::String).collect();

    if names.len() > MAXIMUM_NAMES
        && sink.add(
            (
                "repeated.max_items",
                format!("must contain no more than {MAXIMUM_NAMES} item(s)"),
                Some(("max_items", MAXIMUM_NAMES.to_string())),
            ),
            &all,
        )
    {
        return true;
    }

    sink.path.pop();

    for (index, name) in names.iter().enumerate() {
        let length = name.chars().count();
        let value = Value::String(name.clone());

        sink.path.push(("names".to_owned(), Some(index)));

        if length < MINIMUM_CHARACTERS
            && sink.add(
                (
                    "string.min_len",
                    format!("must be at least {MINIMUM_CHARACTERS} characters"),
                    Some(("min_len", MINIMUM_CHARACTERS.to_string())),
                ),
                &value,
            )
        {
            return true;
        }

        if length > MAXIMUM_CHARACTERS
            && sink.add(
                (
                    "string.max_len",
                    format!("must be at most {MAXIMUM_CHARACTERS} characters"),
                    Some(("max_len", MAXIMUM_CHARACTERS.to_string())),
                ),
                &value,
            )
        {
            return true;
        }

        sink.path.pop();
    }

    false
}

// ── The resolvers ────────────────────────────────────────────────────────────────────────────

// a tick held, until the ticks of its session on its connection notified it enough
struct Hold {
    remaining: f64,
    released: oneshot::Sender<()>,
    answered: oneshot::Receiver<()>,
}

// what the interop service keeps between its calls
struct Kept {
    cancellations: Mutex<BTreeMap<ConnectionHandle, u64>>,
    // by destination, its registration and the connection that registered it, in the order
    // registered
    destinations: Mutex<Vec<(u32, ConnectionHandle, DestinationRegistration)>>,
    // by connection and session, the ticks answers held, in the order they came
    holds: Mutex<BTreeMap<String, Vec<Hold>>>,
}

type Props = RequestProps<Value>;
type Answer = Response<JsonCodec>;

fn callback_of<
    F: Fn(Props, Answer) -> BoxFuture<Result<(), ResolverError>> + Send + Sync + 'static,
>(
    callback: F,
) -> ResolverCallback<JsonCodec, JsonCodec> {
    Arc::new(callback)
}

fn duration_of(name: &str, given: Option<&Value>) -> Result<Option<Duration>, ProgrammerError> {
    let Some(given) = given else {
        return Ok(None);
    };
    let milliseconds = given
        .as_f64()
        .filter(|milliseconds| milliseconds.is_finite() && *milliseconds >= 0.0)
        .ok_or_else(|| {
            ProgrammerError::new(format!("{name} is a number of milliseconds, not {given}"))
        })?;

    hold_finite(name, Duration::from_secs_f64(milliseconds / 1_000.0)).map(Some)
}

fn name_of(session: Option<&CallSession>) -> Value {
    let Some(session) = session else {
        return Value::Null;
    };

    if session.identifier.is_none() {
        return session.data.clone().unwrap_or(Value::Null);
    }

    session
        .data
        .as_ref()
        .and_then(|data| data.get("sub"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn named_of(request: &Value) -> (Vec<&str>, Option<&Map<String, Value>>) {
    let given = request.as_object();
    let mut keys: Vec<&str> = given
        .map(|given| given.keys().map(String::as_str).collect())
        .unwrap_or_default();

    keys.sort_unstable();

    (keys, given)
}

/// The session `request` names: a `JWT`'s by its issuer and its `sub` or `sid`, or an
/// `ELSEWHERE`'s by its id.
///
/// # Errors
///
/// A [`ProgrammerError`] for a request that names it otherwise.
pub fn identifier_of(request: &Value) -> Result<SessionIdentifier, ProgrammerError> {
    let (keys, given) = named_of(request);
    let text = |name: &str| {
        given
            .and_then(|given| given.get(name))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };

    match (
        keys.as_slice(),
        text("issuer"),
        text("sub"),
        text("sid"),
        text("id"),
    ) {
        (["issuer", "sub"], Some(issuer), Some(sub), _, _) => {
            Ok(SessionIdentifier::JwtSub { issuer, sub })
        }
        (["issuer", "sid"], Some(issuer), _, Some(sid), _) => {
            Ok(SessionIdentifier::JwtSid { issuer, sid })
        }
        (["id"], _, _, _, Some(id)) => Ok(SessionIdentifier::Elsewhere { id }),
        _ => Err(ProgrammerError::new(
            "endSession names a session by {\"issuer\",\"sub\"}, {\"issuer\",\"sid\"} or {\"id\"} alone",
        )),
    }
}

/// The issuer `request` names.
///
/// # Errors
///
/// A [`ProgrammerError`] for a request that names it otherwise.
pub fn issuer_of(request: &Value) -> Result<String, ProgrammerError> {
    let (keys, given) = named_of(request);

    match (
        keys.as_slice(),
        given
            .and_then(|given| given.get("issuer"))
            .and_then(Value::as_str),
    ) {
        (["issuer"], Some(issuer)) => Ok(issuer.to_owned()),
        _ => Err(ProgrammerError::new(
            "endSessionsOf names an issuer by {\"issuer\"} alone, a string",
        )),
    }
}

// the key a call's ticks are held under: its connection's, in its call's session
fn holds_key_of(props: &Props) -> String {
    json!([
        props.connection_handle.as_ref(),
        session_key_of(
            props
                .session
                .as_ref()
                .and_then(|session| session.identifier.as_ref())
        )
    ])
    .to_string()
}

fn failed(error: ProgrammerError) -> ResolverError {
    ResolverError::other(error)
}

/// The interop service, offered on `server`.
///
/// # Errors
///
/// A [`ProgrammerError`] its server refuses a resolver with.
#[expect(
    clippy::too_many_lines,
    reason = "one resolver per procedure, as the service states them"
)]
pub fn offer_interop(server: &Server) -> Result<ServiceServer, ProgrammerError> {
    let validate: Validate<Value> = Arc::new(judge_checked);
    let procedures = Arc::new(interop_procedures(Some(validate))?);
    let mut options = ServiceServerOptions::default();

    options.admissions = vec![(
        "nobody",
        AdmissionHook {
            admits: Arc::new(|_request| false),
            detail: Some("this procedure admits nobody".to_owned()),
        },
    )];

    let interop = ServiceServer::new(procedures.all(), options)?;
    let kept = Arc::new(Kept {
        cancellations: Mutex::new(BTreeMap::new()),
        destinations: Mutex::new(Vec::new()),
        holds: Mutex::new(BTreeMap::new()),
    });
    let router = server.router().clone();
    let sessions = server.sessions().clone();
    let procedures_of: &InteropProcedures = &procedures;

    interop.on(
        &procedures_of.echo,
        callback_of(|request, response| response.result(request.payload)),
    )?;

    interop.on(
        &procedures_of.fail,
        callback_of(|_request, response| {
            response.failure(&ON_PURPOSE.of("this procedure fails, on purpose"))
        }),
    )?;

    // cancelled first, it answers all the same, an answer its router must not send; it waits on its
    // server's clock, which its router runs on
    {
        let kept = Arc::clone(&kept);
        let clock = router.clock();

        interop.on(
            &procedures_of.slow,
            callback_of(move |request, response| {
                let kept = Arc::clone(&kept);
                let milliseconds = request
                    .payload
                    .get("milliseconds")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let (woken, wait) = oneshot::channel::<()>();
                let mut woken = Some(woken);
                let timer = clock.arm(
                    Schedule::Once(Duration::from_millis(milliseconds)),
                    Box::new(move || {
                        if let Some(woken) = woken.take() {
                            woken.send(()).ok();
                        }
                    }),
                );

                Box::pin(async move {
                    let signal = request.signal.token().clone();
                    let mut wait = core::pin::pin!(wait);
                    let mut cancelled = core::pin::pin!(signal.cancelled());
                    let is_cancelled = core::future::poll_fn(|context| {
                        if wait.as_mut().poll(context).is_ready() {
                            return core::task::Poll::Ready(false);
                        }

                        if cancelled.as_mut().poll(context).is_ready() {
                            return core::task::Poll::Ready(true);
                        }

                        core::task::Poll::Pending
                    })
                    .await;

                    if is_cancelled {
                        timer.cancel();

                        let mut cancellations = locked(&kept.cancellations);
                        let count = cancellations
                            .entry(Arc::clone(&request.connection_handle))
                            .or_insert(0);

                        *count = count.saturating_add(1);
                        drop(cancellations);
                    }

                    response.result(json!(milliseconds)).await
                })
            }),
        )?;
    }

    {
        let kept = Arc::clone(&kept);

        interop.on(
            &procedures_of.cancellations,
            callback_of(move |request, response| {
                let count = locked(&kept.cancellations)
                    .get(&request.connection_handle)
                    .copied()
                    .unwrap_or(0);

                response.result(json!(count))
            }),
        )?;
    }

    interop.on(
        &procedures_of.denied,
        callback_of(|_request, response| response.result(Value::Null)),
    )?;

    interop.on(
        &procedures_of.broken,
        callback_of(|_request, _response| {
            Box::pin(async { Err(ResolverError::other("this procedure breaks, on purpose")) })
        }),
    )?;

    interop.on(
        &procedures_of.bytes,
        callback_of(|request, response| {
            let length = request
                .payload
                .get("length")
                .and_then(Value::as_u64)
                .and_then(|length| usize::try_from(length).ok())
                .unwrap_or(0);

            response.result(Value::String("x".repeat(length)))
        }),
    )?;

    // held, it subscribes its requester first, in its call's session, then answers once that
    // session's ticks on its connection notified
    {
        let kept = Arc::clone(&kept);

        interop.on_notifying(
            &procedures_of.ticks,
            callback_of(move |request, response| {
                let kept = Arc::clone(&kept);

                Box::pin(async move {
                    let fail = request.payload.get("fail") == Some(&Value::Bool(true));
                    let hold = request
                        .payload
                        .get("hold")
                        .and_then(Value::as_f64)
                        .filter(|hold| *hold >= 1.0);
                    let Some(hold) = hold else {
                        return response.result(Value::Null).await;
                    };

                    response
                        .register_notification()
                        .await
                        .map_err(ResolverError::other)?;

                    let (released, release) = oneshot::channel::<()>();
                    let (answered, answer) = oneshot::channel::<()>();
                    let key = holds_key_of(&request);

                    let remaining = hold;

                    locked(&kept.holds).entry(key).or_default().push(Hold {
                        remaining,
                        released,
                        answered: answer,
                    });

                    drop(release.await);

                    let outcome = if fail {
                        response
                            .failure(&ON_PURPOSE.of("this procedure fails, on purpose"))
                            .await
                    } else {
                        response.result(Value::Null).await
                    };

                    answered.send(()).ok();

                    outcome
                })
            }),
        )?;
    }

    // notifies the subscription its call's session holds on its connection, then lets the ticks of
    // that session it was the last for answer, before it does
    {
        let kept = Arc::clone(&kept);
        let interop_of = interop.clone();
        let ticks = procedures_of.ticks.clone();

        interop.on(
            &procedures_of.tick,
            callback_of(move |request, response| {
                let kept = Arc::clone(&kept);
                let interop = interop_of.clone();
                let ticks = ticks.clone();

                Box::pin(async move {
                    let key = request
                        .payload
                        .get("key")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let value = request.payload.get("value").cloned().unwrap_or(Value::Null);
                    let handle = Arc::clone(&request.connection_handle);
                    let session_key = session_key_of(
                        request
                            .session
                            .as_ref()
                            .and_then(|session| session.identifier.as_ref()),
                    );
                    let held = holds_key_of(&request);
                    let mut options = NotifyOptions::default();

                    options.filter = Some(Arc::new(move |subscriber: &bead::Subscriber| {
                        subscriber.connection_handle == handle
                            && session_key_of(subscriber.identifier.as_ref()) == session_key
                    }));
                    options.key = key.map(bead::NotificationKey::Text);

                    interop.notify(&ticks, (value, &options)).await;

                    let due: Vec<Hold> = {
                        let mut holds = locked(&kept.holds);
                        let mut due = Vec::new();
                        let mut still = Vec::new();

                        for mut hold in holds.remove(&held).unwrap_or_default() {
                            hold.remaining -= 1.0;

                            // * a hold counted down to 0 exactly, as the other sides count it
                            if hold.remaining.abs() < f64::EPSILON {
                                due.push(hold);
                            } else {
                                still.push(hold);
                            }
                        }

                        holds.insert(held, still);

                        due
                    };

                    for hold in due {
                        hold.released.send(()).ok();
                        drop(hold.answered.await);
                    }

                    response.result(Value::Null).await
                })
            }),
        )?;
    }

    // a new session each time, as the one it replaces ends: its token is drawn anew; a timeout not
    // given is left out, for the sessions' default, without end
    {
        let sessions = sessions.clone();

        interop.on(
            &procedures_of.login,
            callback_of(move |request, response| {
                let sessions = sessions.clone();

                Box::pin(async move {
                    let payload = &request.payload;
                    let connection_timeout =
                        duration_of("connectionTimeout", payload.get("connectionTimeout"))
                            .map_err(failed)?;
                    let session_timeout =
                        duration_of("sessionTimeout", payload.get("sessionTimeout"))
                            .map_err(failed)?;
                    let name = payload.get("name").cloned().unwrap_or(Value::Null);
                    let mut session = sessions.create(Arc::clone(&request.connection_handle));

                    session.connection_inactivity_timeout = connection_timeout;
                    session.session_inactivity_timeout = session_timeout;
                    session.data = Some(name.clone());
                    sessions
                        .set(session)
                        .map_err(ResolverError::other)?
                        .await
                        .map_err(ResolverError::other)?;

                    response.result(name).await
                })
            }),
        )?;
    }

    // ended before it answers, so its answer — or the failure ending a subscription — announces
    // it; a call in a credential's session is denied
    {
        interop.on(
            &procedures_of.logout,
            callback_of(move |request, response| {
                let sessions = sessions.clone();

                Box::pin(async move {
                    if request
                        .session
                        .as_ref()
                        .is_some_and(|session| session.identifier.is_some())
                    {
                        return response
                            .failure(
                                &Failure::protocol(ProtocolCode::ACCESS_DENIED, RouterSide::Server)
                                    .saying("a call in a credential's session ends no connection's session"),
                            )
                            .await;
                    }

                    sessions.delete(Arc::clone(&request.connection_handle)).await;

                    response.result(Value::Null).await
                })
            }),
        )?;
    }

    // the name its call's session holds, whatever its connection's holds meanwhile
    interop.on(
        &procedures_of.whoami,
        callback_of(|request, response| response.result(name_of(request.session.as_ref()))),
    )?;

    // the server asks its client back, by a command, before it answers
    {
        let interop_of = interop.clone();
        let clock = procedures_of.clock.clone();

        interop.on(
            &procedures_of.ask,
            callback_of(move |request, response| {
                let interop = interop_of.clone();
                let clock = clock.clone();

                Box::pin(async move {
                    let mut options = RequestOptions::default();

                    options.connection_handle = Some(Arc::clone(&request.connection_handle));
                    options.timeout = Some(Duration::from_millis(CLOCK_MILLISECONDS));

                    let time = interop
                        .command(&clock)
                        .map_err(failed)?
                        .call(Value::String(QUESTION.to_owned()), options)
                        .map_err(failed)?
                        .await
                        .map_err(ResolverError::other)?;

                    response.result(time).await
                })
            }),
        )?;
    }

    // its caller's connection, as the destination it names, with the audience it verifies
    {
        let kept = Arc::clone(&kept);
        let router = router.clone();

        interop.on(
            &procedures_of.register,
            callback_of(move |request, response| {
                let kept = Arc::clone(&kept);
                let router = router.clone();

                Box::pin(async move {
                    let payload = &request.payload;
                    let audience = payload
                        .get("audience")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let destination = payload
                        .get("destination")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let destination = u32::try_from(destination).map_err(|_overflow| {
                        failed(ProgrammerError::new(format!(
                            "a destination is an integer from 1 to 4294967295, not {destination}"
                        )))
                    })?;
                    let timeout = duration_of("timeout", payload.get("timeout")).map_err(failed)?;
                    let is_registered = router
                        .destinations()
                        .iter()
                        .any(|held| held.destination_id == destination);
                    let replaced = locked(&kept.destinations)
                        .iter()
                        .find(|(held, _, _)| *held == destination)
                        .map(|(_, _, registration)| registration.clone());

                    if is_registered
                        && !replaced
                            .as_ref()
                            .is_some_and(DestinationRegistration::is_closed)
                    {
                        return response
                            .failure(
                                &REGISTERED_ALREADY.of("that destination is registered already"),
                            )
                            .await;
                    }

                    let mut options = DestinationOptions::default();

                    options.audience = audience;
                    options.destination_id = Some(destination);
                    options.replaces = if is_registered { replaced } else { None };
                    options.timeout = timeout;

                    let registration = router
                        .register_destination((
                            RelayTarget::Connection(Arc::clone(&request.connection_handle)),
                            options,
                        ))
                        .map_err(failed)?;

                    // ! taken out first, so the order kept is the order registered
                    {
                        let mut destinations = locked(&kept.destinations);

                        destinations.retain(|(held, _, _)| *held != destination);
                        destinations.push((
                            destination,
                            Arc::clone(&request.connection_handle),
                            registration,
                        ));
                    }

                    response.result(json!(destination)).await
                })
            }),
        )?;
    }

    // the destination its caller's connection registered last, taken out and forgotten
    {
        let kept = Arc::clone(&kept);

        interop.on(
            &procedures_of.unregister,
            callback_of(move |request, response| {
                let taken = {
                    let mut destinations = locked(&kept.destinations);
                    let last = destinations
                        .iter()
                        .rposition(|(_, handle, _)| *handle == request.connection_handle);
                    let taken = last.map(|at| destinations.remove(at));

                    drop(destinations);

                    taken
                };

                match taken {
                    None => response.result(Value::Bool(false)),
                    Some((_, _, registration)) => {
                        response.result(Value::Bool(registration.unregister()))
                    }
                }
            }),
        )?;
    }

    // ends a credential's session by its identifier on every connection that keeps it, and answers
    // once it did
    {
        let router = router.clone();

        interop.on(
            &procedures_of.end_session,
            callback_of(move |request, response| {
                let router = router.clone();

                Box::pin(async move {
                    let identifier = identifier_of(&request.payload).map_err(failed)?;

                    router.end_session(identifier).await;

                    response.result(Value::Null).await
                })
            }),
        )?;
    }

    {
        interop.on(
            &procedures_of.end_sessions_of,
            callback_of(move |request, response| {
                let router = router.clone();

                Box::pin(async move {
                    let issuer = issuer_of(&request.payload).map_err(failed)?;

                    router.end_sessions_of(issuer).await;

                    response.result(Value::Null).await
                })
            }),
        )?;
    }

    // its rules took it before it came: an array of names, each of 1 to 3 characters
    interop.on(
        &procedures_of.checked,
        callback_of(|request, response| {
            let count = names_of(&request.payload).map_or(0, |names| names.len());

            response.result(json!(count))
        }),
    )?;

    interop.offer(server)?;

    Ok(interop)
}
