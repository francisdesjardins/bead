//! TLS for the socket transports (RFC 8446), on rustls over aws-lc-rs: every config built on that
//! provider, given by name, never on a default installed for the process, which panics where an
//! application's graph enables both of rustls's providers; a server's certificate verified by the
//! platform's own verifier, as a page's browser, Node and .NET verify it, or by webpki over the
//! authorities its application names in their place (spec 15.39); a client's certificate presented
//! when its server asks for one; a server's config the application's own, the protocols it offers by
//! ALPN (RFC 7301) Bead's.

use core::fmt;
use std::sync::Arc;

#[cfg(feature = "http")]
use rustls::ServerConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::sign::{CertifiedKey, SingleCertAndKey};
use rustls::{ClientConfig, InconsistentKeys, RootCertStore};
use rustls_platform_verifier::BuilderVerifierExt;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use crate::errors::ProgrammerError;

#[cfg(test)]
mod tests;

// HTTP/1.1's protocol by ALPN (RFC 7301): the one a WebSocket's upgrade speaks (RFC 6455 §4.1), a
// server that offers HTTP/2 besides never asked for it, which an upgrade does not cross
const HTTP_1_1: &[u8] = b"http/1.1";

/// HTTP/2's protocol over TLS, by ALPN (RFC 9113 §3.2).
#[cfg(feature = "http")]
pub(crate) const H2: &[u8] = b"h2";

// what a certificate given without its key, or a key without its certificate, is refused with
const UNPAIRED: &str =
    "a TLS client certificate is given with its key, and a key with its certificate";

// what a key of another certificate is refused with
const NOT_ITS_KEY: &str = "the key is not the certificate's";

// ── Its options ──────────────────────────────────────────────────────────────────────────────

/// What a client's TLS judges its server by and presents (spec 15.39), each as PEM text (RFC
/// 7468), read as its client or its adapter is built; one given none of them is none.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct TlsOptions {
    /// One or more `CERTIFICATE` blocks: the trust anchors its server's certificate chains to (RFC
    /// 5280 §6.1.1), in place of the platform's roots, never added to them. The platform's roots
    /// and verifier when none.
    pub authorities: Option<String>,
    /// Its certificate first, then the intermediates that certify it, each certifying the one
    /// before (RFC 8446 §4.4.2), presented when its server asks for one at the handshake: none
    /// when none. Refused without its `key`.
    pub certificate: Option<String>,
    /// The certificate's private key, unencrypted: PKCS #8 (`PRIVATE KEY`), SEC1 (`EC PRIVATE KEY`)
    /// or PKCS #1 (`RSA PRIVATE KEY`). Refused without its `certificate`, encrypted, or of another
    /// certificate.
    pub key: Option<String>,
}

/// A client's `tls` when it is given none.
#[cfg(any(feature = "websocket", feature = "http"))]
pub(crate) static NO_TLS: TlsOptions = TlsOptions {
    authorities: None,
    certificate: None,
    key: None,
};

impl TlsOptions {
    /// Whether it is given none of its members, which is none.
    pub(crate) const fn is_empty(&self) -> bool {
        self.authorities.is_none() && self.certificate.is_none() && self.key.is_none()
    }
}

impl fmt::Debug for TlsOptions {
    // ! the key redacted, never written
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut written = formatter.debug_struct("TlsOptions");

        written
            .field("authorities", &self.authorities)
            .field("certificate", &self.certificate);

        match &self.key {
            Some(_) => written.field("key", &format_args!("<redacted>")),
            None => written.field("key", &None::<String>),
        };

        written.finish()
    }
}

// ── Its options, read ────────────────────────────────────────────────────────────────────────

/// A client's `tls` as it read: the authorities it trusts, and its certificate with its key.
#[derive(Clone, Default)]
pub(crate) struct ReadTls {
    authorities: Option<Arc<RootCertStore>>,
    certified: Option<Arc<CertifiedKey>>,
}

impl fmt::Debug for ReadTls {
    // ! whether it holds a key, never the key
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReadTls")
            .field("has_authorities", &self.authorities.is_some())
            .field("has_certificate", &self.certified.is_some())
            .finish()
    }
}

/// The TLS a client's secured connects speak: a config its application built, or what its `tls`
/// read, the platform's alone when it gave none.
#[derive(Clone)]
pub(crate) enum ClientTls {
    /// Its application's own.
    #[cfg(any(feature = "websocket", feature = "http"))]
    Given(Arc<ClientConfig>),
    /// Of its `tls`, read.
    Read(ReadTls),
}

impl Default for ClientTls {
    fn default() -> Self {
        Self::Read(ReadTls::default())
    }
}

impl fmt::Debug for ClientTls {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            #[cfg(any(feature = "websocket", feature = "http"))]
            Self::Given(_) => formatter.write_str("Given"),
            Self::Read(read) => formatter.debug_tuple("Read").field(read).finish(),
        }
    }
}

/// A transport client's TLS, of its `client_config` or of its `tls`, none when it is given no
/// member, refused as it is built when it is given both, or when `tls` does not read.
///
/// # Errors
///
/// A [`ProgrammerError`] beside a `client_config`, or as [`read_tls`] refuses it.
#[cfg(any(feature = "websocket", feature = "http"))]
pub(crate) fn client_tls_of(
    client_config: Option<&Arc<ClientConfig>>,
    tls: &TlsOptions,
) -> Result<ClientTls, ProgrammerError> {
    match (client_config, (!tls.is_empty()).then_some(tls)) {
        (Some(_), Some(_)) => Err(ProgrammerError::new(
            "tls is refused beside a client_config, which keeps a TLS of its own",
        )),
        (Some(config), None) => Ok(ClientTls::Given(Arc::clone(config))),
        (None, Some(tls)) => Ok(ClientTls::Read(read_tls(tls)?)),
        (None, None) => Ok(ClientTls::default()),
    }
}

// aws-lc-rs's provider, given by name, as every config is built
fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}

fn reads_as_no(member: &str, what: &str) -> ProgrammerError {
    ProgrammerError::new(format!("{member} reads as no {what}"))
}

// the `CERTIFICATE` blocks of `member`'s `text`, at least one
fn certificates_of(
    (member, text): (&str, &str),
) -> Result<Vec<CertificateDer<'static>>, ProgrammerError> {
    let certificates = CertificateDer::pem_slice_iter(text.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_unread| reads_as_no(member, "certificate"))?;

    if certificates.is_empty() {
        return Err(reads_as_no(member, "certificate"));
    }

    Ok(certificates)
}

/// `tls`, read: its authorities, each a certificate webpki takes as a trust anchor; its
/// certificate, its end certificate first; its key, unencrypted, and its certificate's.
///
/// # Errors
///
/// A [`ProgrammerError`] for a certificate without its key or a key without its certificate, then
/// for authorities, a certificate or a key that read as none, an encrypted key among them, and for
/// a key of another certificate.
pub(crate) fn read_tls(tls: &TlsOptions) -> Result<ReadTls, ProgrammerError> {
    if tls.certificate.is_some() != tls.key.is_some() {
        return Err(ProgrammerError::new(UNPAIRED));
    }

    let authorities = match &tls.authorities {
        Some(text) => {
            let mut store = RootCertStore::empty();

            for certificate in certificates_of(("authorities", text))? {
                store
                    .add(certificate)
                    .map_err(|_unread| reads_as_no("authorities", "certificate"))?;
            }

            Some(Arc::new(store))
        }
        None => None,
    };
    let certified = match (&tls.certificate, &tls.key) {
        (Some(certificate), Some(key)) => {
            let chain = certificates_of(("certificate", certificate))?;
            // ! an `ENCRYPTED PRIVATE KEY` is no block this reads, so it reads as no key
            let key = PrivateKeyDer::from_pem_slice(key.as_bytes())
                .map_err(|_unread| reads_as_no("key", "key"))?;
            let signing = provider()
                .key_provider
                .load_private_key(key)
                .map_err(|_unread| reads_as_no("key", "key"))?;
            let certified = CertifiedKey::new(chain, signing);

            match certified.keys_match() {
                // * a key that cannot name its public key is taken, as rustls takes it
                Ok(()) | Err(rustls::Error::InconsistentKeys(InconsistentKeys::Unknown)) => {}
                Err(rustls::Error::InconsistentKeys(_)) => {
                    return Err(ProgrammerError::new(NOT_ITS_KEY));
                }
                Err(_) => return Err(reads_as_no("certificate", "certificate")),
            }

            Some(Arc::new(certified))
        }
        _ => None,
    };

    Ok(ReadTls {
        authorities,
        certified,
    })
}

// ── Its configs ──────────────────────────────────────────────────────────────────────────────

/// A client's config of what its `tls` read: webpki over its authorities, or the platform's
/// verifier when it names none; its safe protocol versions; its certificate, or none.
///
/// # Errors
///
/// What rustls or the platform's verifier refuses it for.
pub(crate) fn client_config_of(read: &ReadTls) -> Result<ClientConfig, rustls::Error> {
    let versioned =
        ClientConfig::builder_with_provider(provider()).with_safe_default_protocol_versions()?;
    let verified = match &read.authorities {
        Some(authorities) => versioned.with_root_certificates(Arc::clone(authorities)),
        None => versioned.with_platform_verifier()?,
    };

    Ok(match &read.certified {
        Some(certified) => verified
            .with_client_cert_resolver(Arc::new(SingleCertAndKey::from(Arc::clone(certified)))),
        None => verified.with_no_client_auth(),
    })
}

/// The config a client's secured connection speaks as it was given or read: the platform's
/// verifier, no certificate of its own, when it was given none.
///
/// # Errors
///
/// What rustls or the platform's verifier refuses it for.
#[cfg(feature = "mqtt")]
pub(crate) fn config_of(tls: &ClientTls) -> Result<Arc<ClientConfig>, rustls::Error> {
    match tls {
        #[cfg(any(feature = "websocket", feature = "http"))]
        ClientTls::Given(given) => Ok(Arc::clone(given)),
        ClientTls::Read(read) => Ok(Arc::new(client_config_of(read)?)),
    }
}

/// The config a client's HTTP/1.1 goes over, a WebSocket's upgrade or the HTTP client's exchanges: a
/// copy of [`config_of`]'s that offers HTTP/1.1 alone by ALPN.
///
/// # Errors
///
/// What rustls or the platform's verifier refuses it for.
pub(crate) fn http1_config_of(tls: &ClientTls) -> Result<Arc<ClientConfig>, rustls::Error> {
    let mut config = match tls {
        #[cfg(any(feature = "websocket", feature = "http"))]
        ClientTls::Given(given) => ClientConfig::clone(given),
        ClientTls::Read(read) => client_config_of(read)?,
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
