//! The C# source's service-1 JSON echo, ask and clock, sharing one metrics registry.

use std::sync::Arc;

use bead::testing::pair::{Pair, PairOptions};
use bead::{
    ClientOptions, JsonCodec, MetricsRegistry, MetricsRegistryOptions, RequestDependencies,
    RequestOptions, RequestResolverDependencies, ServerOptions,
};
use serde_json::{Value, json};

pub(super) async fn play() {
    let registry = MetricsRegistry::new(&MetricsRegistryOptions::default()).expect("a registry");
    let mut server = ServerOptions::default();
    server.metrics_registry = Some(registry.clone());
    let mut client = ClientOptions::default();
    client.metrics_registry = Some(registry.clone());
    let mut options = PairOptions::default();
    options.server = Some(server);
    options.client = Some(client);
    let pair = Pair::connected(bead::testing::instants::new_year(), &options)
        .await
        .expect("a connected pair");
    let _interop = bead_interop::offer_interop(&pair.server).expect("the interop offered");
    let procedures = bead_interop::interop_procedures(None).expect("the interop descriptors");
    pair.client
        .services()
        .get_command_resolver(
            procedures.clock.procedure(),
            RequestResolverDependencies::new(JsonCodec, JsonCodec),
        )
        .expect("clock resolved")
        .on(Arc::new(|request, response| {
            assert_eq!(request.payload, json!("What time is it where you are?"));
            response.result(json!("noon"))
        }))
        .expect("clock offered");
    for (procedure, payload, expected) in [
        (procedures.echo.procedure(), json!(1), json!(1)),
        (procedures.ask.procedure(), Value::Null, json!("noon")),
    ] {
        let request = pair
            .client
            .services()
            .get_request(procedure, RequestDependencies::new(JsonCodec, JsonCodec))
            .expect("a requester");
        assert_eq!(
            request
                .call(payload, &RequestOptions::default())
                .expect("the call starts")
                .await
                .expect("the result"),
            expected
        );
    }
    pair.settle().await;
    let mut actual = registry
        .exposition()
        .text
        .lines()
        .filter(|line| {
            line.starts_with("bead_")
                && !line.ends_with(" 0")
                && !line.contains("_sum{")
                && !line.contains("_bucket{")
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    actual.sort();
    assert_eq!(actual, super::expected_calls(1));
    assert!(
        pair.server_reports
            .lock()
            .expect("server reports")
            .is_empty()
    );
    assert!(
        pair.client_reports
            .lock()
            .expect("client reports")
            .is_empty()
    );
    pair.client.dispose().await;
    pair.server.dispose().await.expect("the server disposed");
}
