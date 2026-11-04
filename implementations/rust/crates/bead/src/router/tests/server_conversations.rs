//! The interop's slow answer on its server's clock, pending until the due.

use core::future::Future;
use core::pin::pin;
use core::task::{Context, Poll, Waker};
use core::time::Duration;

use bead::testing::pair::{Pair, PairOptions};
use bead::{JsonCodec, RequestDependencies, RequestOptions};
use serde_json::{Value, json};

async fn pair() -> Pair {
    Pair::connected(bead::testing::instants::new_year(), &PairOptions::default())
        .await
        .expect("a connected pair")
}

#[tokio::test]
async fn answers_slow_once_its_servers_clock_passed_its_wait_never_before() {
    let pair = pair().await;
    let _interop = bead_interop::offer_interop(&pair.server).expect("the interop offered");
    let procedures = bead_interop::interop_procedures(None).expect("the interop descriptors");
    let request = pair
        .client
        .services()
        .get_request(
            procedures.slow.procedure(),
            RequestDependencies::new(JsonCodec, JsonCodec),
        )
        .expect("slow's requester");
    let mut slow = pin!(
        request
            .call(json!({"milliseconds": 1_000}), &RequestOptions::default())
            .expect("the call starts")
    );
    pair.settle().await;
    pair.clock.advance(Duration::from_millis(999)).await;
    assert!(matches!(
        slow.as_mut().poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    pair.clock.advance(Duration::from_millis(1)).await;
    assert_eq!(
        slow.await.expect("the answer at the due"),
        Value::from(1_000)
    );
}
