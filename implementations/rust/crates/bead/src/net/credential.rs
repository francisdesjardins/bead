//! What hands a client the secret its link carries at each attempt: a WebSocket client's credential,
//! written on its upgrade, or a broker adapter's password, written in its CONNECT (decision 0050).

use std::error::Error;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::router::types::BoxFuture;

/// What a credential provider fails with.
pub type CredentialProviderError = Box<dyn Error + Send + Sync>;

/// What hands the credential an attempt carries: a WebSocket client's upgrade, or a broker
/// adapter's CONNECT, as its password.
///
/// Called at each attempt — the connect's, and each of a reconnection's, or each start of a broker
/// adapter's link — before what it carries goes, given a signal cancelled once the attempt ends,
/// opened or not: a renewed credential reaches the next connection.
pub type CredentialProvider = Arc<
    dyn Fn(CancellationToken) -> BoxFuture<Result<String, CredentialProviderError>> + Send + Sync,
>;
