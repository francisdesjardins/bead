//! The interop verifier and key set, asked directly as the other sides' tests ask them.

use core::task::{Context, Waker};
use core::time::Duration;
use std::sync::Arc;
use std::time::SystemTime;

use bead::testing::{SteppingClock, patience};
use bead::{BoxFuture, RouterLimitsOptions, SharedClock, Signal};
use serde_json::Value;

use super::{INTEROP_SERVICE, interop_credentials_of};

fn service() -> Value {
    serde_json::from_str(INTEROP_SERVICE).expect("the interop service reads")
}

fn pending<T>(future: &mut BoxFuture<T>) -> bool {
    future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
        .is_pending()
}

#[tokio::test]
async fn the_interop_services_elsewhere_verifier_holds_refuses_and_fails_each_value_as_its_words_say_at_its_time_on_its_servers_clock()
 {
    let service = service();
    let elsewhere = &service["verifiers"]["elsewhere"];
    let rows = elsewhere["verdicts"].as_array().expect("verdicts");
    assert_ne!(rows, &Vec::<Value>::new());
    let ended = Signal::new();
    ended.token().cancel();
    // The TypeScript source shares a clock across rows; the C# theory starts each at the epoch.
    for fresh in [false, true] {
        let shared = SteppingClock::new(bead::testing::instants::new_year());
        for row in rows {
            let clock = if fresh {
                SteppingClock::new(SystemTime::UNIX_EPOCH)
            } else {
                Arc::clone(&shared)
            };
            let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
            let verify = interop_credentials_of(&shared, &RouterLimitsOptions::default())
                .expect("credentials")
                .verify
                .expect("a verifier");
            let mut verifying = verify(
                row["carried"].as_str().expect("carried words").to_owned(),
                ended.token().clone(),
            );
            if let Some(after) = row["after"].as_u64() {
                assert!(pending(&mut verifying));
                clock.advance(Duration::from_millis(after - 1)).await;
                assert!(
                    pending(&mut verifying),
                    "{} a millisecond short",
                    row["carried"]
                );
                clock.advance(Duration::from_millis(1)).await;
            }
            let outcome = patience(Duration::from_secs(10), verifying)
                .await
                .expect("the verdict settles");
            match row["verdict"].as_str().expect("a verdict") {
                "holds" => {
                    let session = outcome.expect("held").expect("a session");
                    let sub = row["sub"].as_str().expect("a sub");
                    assert_eq!(session.id, sub);
                    assert_eq!(session.data, Some(serde_json::json!({"sub": sub})));
                    assert_eq!(
                        session.end.map(f64::to_bits),
                        row["end"].as_f64().map(f64::to_bits)
                    );
                }
                "none" => assert_eq!(outcome.expect("refused"), None),
                "rejects" => assert_eq!(
                    outcome.expect_err("the verifier fails").to_string(),
                    elsewhere["rejection"].as_str().expect("its failure")
                ),
                other => panic!("no verdict of this side is {other}"),
            }
            assert_eq!(clock.dues(), Vec::<Duration>::new());
        }
    }
}

#[tokio::test]
async fn the_interop_services_key_set_answers_each_issuer_it_names_as_its_words_say_on_its_servers_clock_whatever_its_signal_and_fails_at_once_for_any_other()
 {
    const KEYS: &str = "https://keys.interop.bead.example";
    const ROTATED: &str = "https://rotated.interop.bead.example";
    const STALLED: &str = "https://stalled.interop.bead.example";
    const KIDLESS: &str = "https://kidless.interop.bead.example";
    let clock = SteppingClock::new(SystemTime::UNIX_EPOCH);
    let shared: SharedClock = Arc::<SteppingClock>::clone(&clock);
    let set = interop_credentials_of(&shared, &RouterLimitsOptions::default())
        .expect("credentials")
        .key_set
        .expect("a key set");
    let ended = Signal::new();
    ended.token().cancel();
    assert_eq!(set.issuers, [KEYS, ROTATED, STALLED, KIDLESS]);
    assert_eq!(
        set.maximum_waiting_calls,
        service()["credentials"]["jwt"]["keySet"]["maximumWaitingCalls"].as_u64()
    );
    assert_eq!(set.maximum_waiting_calls, Some(2));
    let mut asked: Vec<_> = [KEYS, ROTATED, ROTATED, KIDLESS, KIDLESS]
        .into_iter()
        .map(|issuer| (set.ask)(issuer.to_owned(), ended.token().clone()))
        .collect();
    let mut stalled = (set.ask)(STALLED.to_owned(), ended.token().clone());
    assert_eq!(clock.dues(), [Duration::from_millis(1_000); 5]);
    clock.advance(Duration::from_millis(999)).await;
    assert!(asked.iter_mut().all(pending));
    assert!(pending(&mut stalled));
    clock.advance(Duration::from_millis(1)).await;
    let mut answered = Vec::new();
    for asking in asked {
        answered.push(
            patience(Duration::from_secs(10), asking)
                .await
                .expect("the ask settles")
                .expect("its keys"),
        );
    }
    assert_eq!(
        answered.iter().map(Vec::len).collect::<Vec<_>>(),
        [1, 1, 0, 1, 1]
    );
    for keys in &answered[..2] {
        assert_eq!(keys[0].jwk["kid"], "018c0ae5-4d9b-471b-bfd6-eef314bc7037");
    }
    assert_ne!(answered[0][0].jwk["k"], answered[1][0].jwk["k"]);
    for keys in &answered[3..] {
        assert!(!keys[0].jwk.contains_key("kid"));
        assert_eq!(keys[0].jwk["k"], answered[0][0].jwk["k"]);
    }
    assert!(pending(&mut stalled));
    assert_eq!(clock.dues(), Vec::<Duration>::new());
    let another = interop_credentials_of(&shared, &RouterLimitsOptions::default())
        .expect("another server's credentials")
        .key_set
        .expect("another key set");
    let asking = (another.ask)(ROTATED.to_owned(), ended.token().clone());
    clock.advance(Duration::from_millis(1_000)).await;
    assert_eq!(
        patience(Duration::from_secs(10), asking)
            .await
            .expect("the ask settles")
            .expect("keys")
            .len(),
        1
    );
    let mut unnamed = (set.ask)(
        "https://unnamed.interop.bead.example".to_owned(),
        ended.token().clone(),
    );
    let ready = unnamed
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()));
    let core::task::Poll::Ready(Err(error)) = ready else {
        panic!("an unnamed issuer fails at once")
    };
    assert_eq!(
        error.to_string(),
        "the interop key set names no issuer https://unnamed.interop.bead.example"
    );
    assert_eq!(clock.dues(), Vec::<Duration>::new());
}
