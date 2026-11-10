//! Its connect and its reconnection given up as an answer comes: what it drew is let go of, never
//! opened.

use super::*;
use crate::clock::Timer;

type Hook = Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>;

// a clock whose timers, as each is cancelled, run its hook once: a connect's timeout is cancelled
// as its attempt ends, after its answer came and before its connect settles
struct Disposing {
    clock: Arc<SteppingClock>,
    hook: Hook,
}

impl fmt::Debug for Disposing {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Disposing").finish_non_exhaustive()
    }
}

struct DisposingTimer {
    timer: Arc<dyn Timer>,
    hook: Hook,
}

impl fmt::Debug for DisposingTimer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DisposingTimer")
            .finish_non_exhaustive()
    }
}

impl Timer for DisposingTimer {
    fn cancel(&self) {
        self.timer.cancel();

        let hook = locked(&self.hook).take();

        if let Some(hook) = hook {
            hook();
        }
    }
}

impl crate::clock::Clock for Disposing {
    fn monotonic(&self) -> Duration {
        self.clock.monotonic()
    }

    fn wall(&self) -> SystemTime {
        self.clock.wall()
    }

    fn arm(
        &self,
        schedule: Schedule,
        callback: crate::clock::TimerCallback,
    ) -> Result<Arc<dyn Timer>, ProgrammerError> {
        let timer = self.clock.arm(schedule, callback)?;

        Ok(Arc::new(DisposingTimer {
            timer,
            hook: Arc::clone(&self.hook),
        }))
    }
}

/// What a reconnection's or a connect's methods were, the two that race — a `DELETE` nobody waits
/// on and the attempt's `POST` — in the order the other sides' executors take them.
fn ordered(mut methods: Vec<String>) -> Vec<String> {
    if methods.len() >= 3 && methods[1] == "POST" && methods[2] == "DELETE" {
        methods.swap(1, 2);
    }

    methods
}

#[tokio::test]
async fn releases_a_late_reconnection_answer_without_opening_after_cancellation() {
    let faked = connected(fake().await, &not_listening()).await;
    let cancelling = CancellationToken::new();
    let reconnecting = faked
        .client
        .reconnect(&TransportClientReconnectOptions {
            signal: Some(cancelling.clone()),
            delay: Some(crate::TransportClientReconnectDelay::Fixed(Duration::ZERO)),
            ..TransportClientReconnectOptions::default()
        })
        .unwrap();

    // the DELETE of the connection replaced, then the attempt
    faked.fake.call_of(2).await;
    cancelling.cancel();

    let cancelled = within(reconnecting).await;

    assert!(
        matches!(&cancelled, Err(TransportError::Cancelled { .. })),
        "{cancelled:?}"
    );
    assert_eq!(faked.client.ready_state(), ReadyState::Closed, "closed");

    let attempt = faked
        .fake
        .calls()
        .into_iter()
        .skip(1)
        .find(|call| call.method == "POST")
        .unwrap();

    attempt.answer(&drawn(false));
    faked.fake.call_of(3).await;

    assert!(faked.told.closes().is_empty(), "no close");
    assert_eq!(
        ordered(faked.fake.methods()),
        ["POST", "DELETE", "POST", "DELETE"],
        "its late answer let go of"
    );
}

// spec 15.15
#[tokio::test]
async fn bounds_an_unresponsive_http_connect_by_cancellation_timeout_and_disposal() {
    for ending in ["cancel", "timeout", "dispose"] {
        let clock = stepping();
        let fake = fake().await;
        let cancelling = CancellationToken::new();
        let client = client_of(&HttpTransportClientOptions {
            clock: Some(on_clock(&clock)),
            ..not_listening()
        });
        let connecting = client.connect(&HttpTransportClientConnectOptions {
            timeout: Some(Duration::from_millis(100)),
            signal: Some(cancelling.clone()),
            ..to(fake.port)
        });
        let call = fake.call_of(0).await;

        match ending {
            "cancel" => cancelling.cancel(),
            "timeout" => clock.advance(Duration::from_millis(100)).await,
            _ => client.dispose(),
        }

        let failure = settled(connecting).await;

        assert!(
            match ending {
                "cancel" => matches!(&failure, Err(TransportError::Cancelled { .. })),
                "timeout" => matches!(&failure, Err(TransportError::TimedOut(_))),
                _ =>
                    matches!(&failure, Err(TransportError::Connect(error)) if error.to_string() == DISPOSED),
            },
            "{ending}: {failure:?}"
        );
        assert_eq!(client.ready_state(), ReadyState::Closed, "{ending}");

        call.answer(&drawn(false));
        fake.call_of(1).await;

        assert_eq!(fake.methods(), ["POST", "DELETE"], "{ending}");
        assert_eq!(client.ready_state(), ReadyState::Closed, "{ending}");
    }
}

// spec 15.15
#[tokio::test]
async fn refuses_a_connection_disposed_between_its_answer_and_the_end_of_connect() {
    let hook: Hook = Arc::default();
    let clock: SharedClock = Arc::new(Disposing {
        clock: stepping(),
        hook: Arc::clone(&hook),
    });
    let fake = fake().await;
    let client = client_of(&HttpTransportClientOptions {
        clock: Some(clock),
        ..not_listening()
    });
    let told = recorded(&client);
    let completions = Arc::new(AtomicUsize::new(0));
    let (disposing, counting) = (client.clone(), Arc::clone(&completions));

    *locked(&hook) = Some(Box::new(move || {
        counting.fetch_add(1, Ordering::SeqCst);
        disposing.dispose();
    }));

    let connecting = client.connect(&to(fake.port));

    fake.call_of(0).await.answer(&drawn(false));

    let failure = settled(connecting).await;

    assert!(
        matches!(&failure, Err(TransportError::Connect(error)) if error.to_string() == DISPOSED),
        "{failure:?}"
    );
    assert_eq!(
        (completions.load(Ordering::SeqCst), client.ready_state()),
        (1, ReadyState::Closed),
        "disposed once, closed"
    );
    assert!(told.events().is_empty(), "nothing told");

    let deleted = fake.call_of(1).await;

    assert_eq!(
        (
            deleted.method.as_str(),
            deleted.field(CONNECTION_TOKEN_HEADER)
        ),
        ("DELETE", Some(TOKEN)),
        "what it drew let go of"
    );

    let again = client.connect(&to(fake.port));

    fake.call_of(2).await.answer(&drawn(false));
    settled(again).await.unwrap();
    assert_eq!(client.ready_state(), ReadyState::Open, "open");
    disconnected(&client, &quick()).await;
    assert_eq!(client.ready_state(), ReadyState::Closed, "closed");
    assert_eq!(told.events(), ["close true true"], "its close alone");

    let deleted = fake.call_of(3).await;

    assert_eq!(
        (
            deleted.method.as_str(),
            deleted.field(CONNECTION_TOKEN_HEADER)
        ),
        ("DELETE", Some(TOKEN)),
        "its DELETE"
    );
}

#[tokio::test]
async fn releases_a_replacement_opened_by_its_close_listener_before_dispose_completes() {
    // a listener that connects again as the client closes
    struct Replacing {
        client: HttpTransportClient,
        port: u16,
        replacement: Mutex<Option<Connect>>,
    }

    impl ClientListener for Replacing {
        fn on_close(&self, _was_clean: bool, _is_quick: bool) {
            *locked(&self.replacement) = Some(self.client.connect(&to(self.port)));
        }
    }

    let fake = fake_of(&ScriptOptions {
        responder: Some(Arc::new(|call: &Call| {
            Some(if call.method == "POST" {
                drawn(false)
            } else {
                Answer::of(204)
            })
        })),
        ..ScriptOptions::default()
    })
    .await;
    let faked = connected(fake, &not_listening()).await;
    let replacing = Arc::new(Replacing {
        client: faked.client.clone(),
        port: faked.fake.port,
        replacement: Mutex::default(),
    });

    faked.client.listen(Arc::<Replacing>::clone(&replacing));
    within(faked.client.close()).await;

    assert_eq!(faked.client.ready_state(), ReadyState::Closed, "closed");

    let replacement = locked(&replacing.replacement).take();
    let outcome = settled(replacement.expect("a replacement")).await;

    assert!(
        matches!(&outcome, Ok(()) | Err(TransportError::Connect(_))),
        "{outcome:?}"
    );
    faked.fake.call_of(3).await;
    assert_eq!(
        (faked.client.ready_state(), faked.told.events()),
        (ReadyState::Closed, vec!["close true false".to_owned()]),
        "closed once, nothing reported"
    );
    assert!(faked.told.messages().is_empty(), "nothing heard");
    assert_eq!(
        faked.fake.methods(),
        ["POST", "DELETE", "POST", "DELETE"],
        "the replacement let go of"
    );
}
