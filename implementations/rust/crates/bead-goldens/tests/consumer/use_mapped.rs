//! A consumer of the goldens' `deprecations` output, compiled with them as one crate by
//! `tests/consumer.rs`: each member the server and the client map from a deprecated descriptor,
//! the line after a `// reported:` comment that says what rustc reports of it, beside its
//! replacement's, which it does not report. Never run.

#![warn(deprecated)]

#[path = "GOLDENS/deprecations/mod.rs"]
pub mod generated;

use bead::{JsonCodec, PayloadCodec, RequestProps, ResolverError, Response};
use generated::services::{InteropClient, InteropServer, InteropWindows};

async fn resolver(
    _: RequestProps<<JsonCodec as PayloadCodec>::Value>,
    _: Response<JsonCodec>,
) -> Result<(), ResolverError> {
    Ok(())
}

/// Each command's requester, notifier, resolver and window of the server side and the client side.
pub fn uses(server: &InteropServer, client: &InteropClient) -> InteropWindows {
    let _ = server.on_tick(resolver);
    // reported: use of deprecated method `generated::services::InteropServer::on_ticks`: Use tick.
    let _ = server.on_ticks(resolver);
    // reported: use of deprecated field `generated::services::InteropCommands::clock`: No replacement is named.
    let _ = &server.command().clock;
    // reported: use of deprecated field `generated::services::InteropNotifiers::ticks`: Use tick.
    let _ = &server.notify().ticks;
    let _ = &client.request().tick;
    // reported: use of deprecated field `generated::services::InteropRequesters::ticks`: Use tick.
    let _ = &client.request().ticks;
    // reported: use of deprecated field `generated::services::InteropNotifications::ticks`: Use tick.
    let _ = &client.notifications().ticks;
    // reported: use of deprecated method `generated::services::InteropClient::on_clock`: No replacement is named.
    let _ = client.on_clock(resolver);
    let mut windows = InteropWindows::default();
    // reported: use of deprecated field `generated::services::InteropWindows::ticks`: Use tick.
    windows.ticks = Some(1);

    windows
}
