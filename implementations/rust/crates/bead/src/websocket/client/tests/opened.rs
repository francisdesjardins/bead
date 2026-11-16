//! Between its socket's open and its connect's end: a dispose lets go of what it opened, never
//! kept, and a close its server wrote with its 101 is read once its connect ended.

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

// each message its client tells, with the client's state as it came
struct HeardWith {
    client: WebSocketTransportClient,
    heard: Mutex<Vec<(Vec<u8>, ReadyState)>>,
}

impl ClientListener for HeardWith {
    fn on_message(&self, message: TransportMessage) {
        let ready = self.client.ready_state();

        self.heard
            .lock()
            .unwrap()
            .push((message.data.to_vec(), ready));
    }
}

// spec 15.15; RFC 6455 §4.1: a WebSocket opens with its 101, whatever its server wrote after it
#[tokio::test]
async fn opens_on_a_101_written_together_with_a_close_hears_what_came_before_it_once_open_and_tells_one_close()
 {
    let close = close_frame(1000);

    for (frames, expected) in [
        (close.clone(), Vec::new()),
        (
            [frame_of(0x2, &[0x2a]), close].concat(),
            vec![(vec![0x2a], ReadyState::Open)],
        ),
    ] {
        let mut server = raw_writing(frames).await;
        let client = client();
        let recorder = recorded(&client);
        let heard = Arc::new(HeardWith {
            client: client.clone(),
            heard: Mutex::default(),
        });
        let listener: Arc<dyn ClientListener> = Arc::<HeardWith>::clone(&heard);

        client.listen(Arc::clone(&listener));
        settled(client.connect(&to(server.port))).await.unwrap();

        // its close answered, the server ends its socket
        let mut socket = server.next().await;

        assert_eq!(close_code_from(&mut socket).await, Some(1000), "answered");
        socket.shutdown().await.unwrap();

        let closes = closes_within(&recorder, 1).await;

        client.unlisten(&listener);

        // * what came before the close, heard open, then one unclean close
        assert_eq!(heard.heard.lock().unwrap().clone(), expected, "heard open");
        assert_eq!(closes, vec![(false, false)], "one close");
        assert!(is_state(&client, ReadyState::Closed), "closed");
    }
}
