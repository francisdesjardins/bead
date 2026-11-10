//! TLS for the socket transports (RFC 8446), on rustls over aws-lc-rs: every config built on that
//! provider, given by name, never on a default installed for the process, which panics where an
//! application's graph enables both of rustls's providers; a server's certificate verified by the
//! platform's own verifier, as a page's browser, Node and .NET verify it; a server's config the
//! application's own, the protocols it offers by ALPN (RFC 7301) Bead's.

use std::sync::Arc;

use rustls::ClientConfig;
#[cfg(feature = "http")]
use rustls::ServerConfig;
use rustls::pki_types::ServerName;
use rustls_platform_verifier::BuilderVerifierExt;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

// HTTP/1.1's protocol by ALPN (RFC 7301): the one a WebSocket's upgrade speaks (RFC 6455 §4.1), a
// server that offers HTTP/2 besides never asked for it, which an upgrade does not cross
const HTTP_1_1: &[u8] = b"http/1.1";

/// HTTP/2's protocol over TLS, by ALPN (RFC 9113 §3.2).
#[cfg(feature = "http")]
pub(crate) const H2: &[u8] = b"h2";

/// A client's config: the platform's verifier, its safe protocol versions, no certificate of its
/// own.
///
/// # Errors
///
/// What rustls or the platform's verifier refuses it for.
pub(crate) fn platform_client_config() -> Result<ClientConfig, rustls::Error> {
    Ok(
        ClientConfig::builder_with_provider(
            Arc::new(rustls::crypto::aws_lc_rs::default_provider()),
        )
        .with_safe_default_protocol_versions()?
        .with_platform_verifier()?
        .with_no_client_auth(),
    )
}

/// The config a client's HTTP/1.1 goes over, a WebSocket's upgrade or the HTTP client's exchanges: a
/// copy of `given`, or of the platform's, that offers HTTP/1.1 alone by ALPN.
///
/// # Errors
///
/// What rustls or the platform's verifier refuses the platform's for.
pub(crate) fn http1_config_of(
    given: Option<&Arc<ClientConfig>>,
) -> Result<Arc<ClientConfig>, rustls::Error> {
    let mut config = match given {
        Some(given) => ClientConfig::clone(given),
        None => platform_client_config()?,
    };

    config.alpn_protocols = vec![HTTP_1_1.to_vec()];

    Ok(Arc::new(config))
}

/// The config an HTTP server serves under: a copy of `given`, the application's, that offers
/// HTTP/2, then HTTP/1.1, by ALPN, one port serving both.
#[cfg(feature = "http")]
pub(crate) fn serving_config_of(given: &Arc<ServerConfig>) -> Arc<ServerConfig> {
    let mut config = ServerConfig::clone(given);

    config.alpn_protocols = vec![H2.to_vec(), HTTP_1_1.to_vec()];

    Arc::new(config)
}

/// `socket` under TLS, its handshake done with `host`, a name in ASCII or an IP address, bare.
///
/// # Errors
///
/// A host no certificate can name, or what the handshake failed with.
pub(crate) async fn connect_tls(
    (socket, host): (TcpStream, &str),
    config: &Arc<ClientConfig>,
) -> std::io::Result<TlsStream<TcpStream>> {
    let name = ServerName::try_from(host.to_owned())
        .map_err(|refused| std::io::Error::new(std::io::ErrorKind::InvalidInput, refused))?;

    TlsConnector::from(Arc::clone(config))
        .connect(name, socket)
        .await
}
