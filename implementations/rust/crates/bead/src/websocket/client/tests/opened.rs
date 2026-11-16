//! Its connect given up between its socket's open and its end: what it opened is let go of, never
//! kept, the TypeScript client's owed twin.

use super::*;

type Hook = Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>;

// a clock whose timers, as each is cancelled, run its hook once: a connect's timeout is cancelled
// as its attempt ends, after its socket opened and before its connect settles
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

        let hook = self.hook.lock().unwrap().take();

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

// spec 15.15
#[tokio::test]
async fn a_dispose_between_the_open_and_the_end_of_connect_is_not_undone() {
    let hook: Hook = Arc::default();
    let clock: SharedClock = Arc::new(Disposing {
        clock: stepping(),
        hook: Arc::clone(&hook),
    });
    let server = hearing(None).await;
    let client = client_of(&WebSocketTransportClientOptions {
        clock: Some(clock),
        ..WebSocketTransportClientOptions::default()
    });
    let recorder = recorded(&client);
    let completions = Arc::new(AtomicUsize::new(0));
    let (disposing, counting) = (client.clone(), Arc::clone(&completions));

    *hook.lock().unwrap() = Some(Box::new(move || {
        counting.fetch_add(1, Ordering::SeqCst);
        disposing.dispose();
    }));

    // its timeout armed, so that its end cancels it
    let connecting = client.connect(&to(server.port));
    let mut opened = server.next_upgraded().await;
    let failure = settled(connecting).await;

    assert!(is_disposed(&failure), "{failure:?}");
    assert_eq!(
        (completions.load(Ordering::SeqCst), client.ready_state()),
        (1, ReadyState::Closed),
        "disposed once, closed"
    );
    assert!(
        matches!(client.send(binary(&[1])), Err(RouterError::Disconnected(reason)) if reason == "the transport client is closed, not open"),
        "refused"
    );
    opened.ended().await;
    assert!(recorder.closes().is_empty(), "nothing told");

    settled(client.connect(&to(server.port))).await.unwrap();
    assert!(is_state(&client, ReadyState::Open), "open");
    client.dispose();
}
