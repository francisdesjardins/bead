//! What a call counted allocates against one uncounted (`spec/debugging.md` 3.3 and 3.4): a call
//! made and answered over the in-memory transport, each end given a registry or none, every
//! allocation of the process counted by its global allocator. The binary holds this one test, so
//! nothing else allocates beside it.

#![expect(
    clippy::expect_used,
    reason = "the test's helper fails it as its own lines do"
)]

use std::alloc::System;
use std::time::UNIX_EPOCH;

use bead::testing::pair::{Pair, PairOptions, echo};
use bead::{
    ClientOptions, MetricsRegistry, MetricsRegistryOptions, RequestDependencies, RequestOptions,
    RequestResolverDependencies, Response, ServerOptions, TextCodec,
};
use stats_alloc::{INSTRUMENTED_SYSTEM, Region, StatsAlloc};

// * every allocation of the process, counted; the allocator's `unsafe impl` is its crate's own
#[global_allocator]
static GLOBAL: &StatsAlloc<System> = &INSTRUMENTED_SYSTEM;

// the rounds measured, of which the least counts: what else runs only ever adds
const ROUNDS: usize = 8;

/// What a round allocated: allocations, reallocations, and the bytes both asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Allocated {
    allocations: usize,
    reallocations: usize,
    bytes: usize,
}

// a call to echo made and answered, each end given `registry` or none: the least each count reads
// over the rounds, once a first call allocated what is allocated once and for all
async fn allocated_of(registry: Option<&MetricsRegistry>) -> Allocated {
    let mut options = PairOptions::default();
    let mut server = ServerOptions::default();
    let mut client = ClientOptions::default();

    server.metrics_registry = registry.cloned();
    client.metrics_registry = registry.cloned();
    options.server = Some(server);
    options.client = Some(client);

    let pair = Pair::connected(UNIX_EPOCH, &options)
        .await
        .expect("a pair connected");

    pair.server
        .services()
        .get_request_resolver(
            &echo(),
            RequestResolverDependencies::new(TextCodec, TextCodec),
        )
        .expect("echo resolved")
        .on(std::sync::Arc::new(
            |request, response: Response<TextCodec>| response.result(request.payload),
        ))
        .expect("echo registered");

    let ask = pair
        .client
        .services()
        .get_request(&echo(), RequestDependencies::new(TextCodec, TextCodec))
        .expect("echo asked");
    let options = RequestOptions::default();
    let mut least = Allocated {
        allocations: usize::MAX,
        reallocations: usize::MAX,
        bytes: usize::MAX,
    };

    for round in 0..=ROUNDS {
        let payload = "x".to_owned();
        let region = Region::new(GLOBAL);
        let call = ask.call(payload, &options).expect("a call");

        pair.settle().await;
        assert_eq!(call.await.expect("an answer"), "x", "echo's answer");

        let change = region.change();

        // the first round allocates what every round after it reuses
        if round > 0 {
            least = Allocated {
                allocations: least.allocations.min(change.allocations),
                reallocations: least.reallocations.min(change.reallocations),
                bytes: least.bytes.min(
                    change
                        .bytes_allocated
                        .saturating_add(change.bytes_reallocated.unsigned_abs()),
                ),
            };
        }
    }

    least
}

// debugging 3.3 and 3.4
#[tokio::test]
async fn allocates_not_a_byte_more_for_a_call_it_counts_than_for_one_it_does_not() {
    let registry = MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let uncounted = allocated_of(None).await;
    let counted = allocated_of(Some(&registry)).await;

    assert!(
        uncounted.allocations > 0 && uncounted.bytes > 0,
        "an uncounted call allocates, so the counts read something: {uncounted:?}"
    );
    assert_eq!(
        counted, uncounted,
        "a counted call allocates as much as an uncounted one, not a byte more"
    );
    assert!(
        registry
            .exposition()
            .text
            .contains("bead_server_call_handled_total{service=\"2\",procedure=\"echo\",type=\"request\",outcome=\"result\"} 9"),
        "every call counted"
    );
}
