//! TLS for the tests of a transport over TLS: the TypeScript side's fixture, and Bead's test PKI.
//!
//! `TLS_FIXTURE` is a key and the certificate it signed itself, for `localhost` and 127.0.0.1, good
//! until 2126. The PKI, `spec/pki/`, is read at run time, with the TLS front a test puts before a
//! server in the clear. They guard nothing — anyone may read them here.

use core::net::Ipv4Addr;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::WebPkiClientVerifier;
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, ProtocolVersion, RootCertStore,
    ServerConfig, SignatureScheme,
};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;

use crate::TlsOptions;
use crate::testing::{files, spawn};

/// The certificate, in PEM: P-256, for `localhost` and 127.0.0.1.
pub const CERTIFICATE: &str = "-----BEGIN CERTIFICATE-----
MIIBmjCCAUGgAwIBAgIUP4UczNFBowowMSh0U63OGdJL4Y0wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkzMDA1Mjg0NFoYDzIxMjYwOTA2
MDUyODQ0WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAT1wVAvZqtAUXTdWGIGQPdbYXuLAH8LaMUZ2RDe45nE3vlRGW+trdeb
Spc1C5051YZ8kaSGx8WaqaJmwCxvCCxMo28wbTAdBgNVHQ4EFgQUo+pMjGUwcP2b
b7jUHhN5rJ2GVYAwHwYDVR0jBBgwFoAUo+pMjGUwcP2bb7jUHhN5rJ2GVYAwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDRwAwRAIgBJ615Fg0220CPpLimCXxjBTBGtZ3rW1rPtWzafaLvtkCIC57
1zHXf4peYTZDXawXKCbQe8hJzM0qxh7K8j+wPz0J
-----END CERTIFICATE-----
";

/// Its key, in PEM: PKCS #8.
// a test's key, the TypeScript fixture's, that guards nothing
// nosemgrep: generic.secrets.security.detected-private-key.detected-private-key
pub const KEY: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgOK27HlYYTvZWNX0P
xvAw7AyXGDlQ02ozYvs7wiDSIqyhRANCAAT1wVAvZqtAUXTdWGIGQPdbYXuLAH8L
aMUZ2RDe45nE3vlRGW+trdebSpc1C5051YZ8kaSGx8WaqaJmwCxvCCxM
-----END PRIVATE KEY-----
";

// a refusal of the fixture's, as rustls names one
fn refused(what: &str) -> rustls::Error {
    rustls::Error::General(format!("the fixture's {what} does not read"))
}

// aws-lc-rs's provider, given by name, as Bead builds every config
fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}

/// A server's config of the certificate and its key, no client's asked for.
///
/// # Errors
///
/// What rustls refuses it for.
pub fn server_config() -> Result<Arc<ServerConfig>, rustls::Error> {
    let certificate = CertificateDer::from_pem_slice(CERTIFICATE.as_bytes())
        .map_err(|_unread| refused("certificate"))?;
    let key = PrivateKeyDer::from_pem_slice(KEY.as_bytes()).map_err(|_unread| refused("key"))?;

    Ok(Arc::new(
        ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_no_client_auth()
            .with_single_cert(vec![certificate], key)?,
    ))
}

// a verifier that takes the certificate alone, its signatures checked by the provider: the
// fixture signed itself, a CA's certificate as its end entity, which webpki's path never takes
#[derive(Debug)]
struct Pinned {
    certificate: CertificateDer<'static>,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if end_entity.as_ref() == self.certificate.as_ref() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(
                CertificateError::UnknownIssuer,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signed: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, certificate, signed, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signed: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, certificate, signed, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// A client's config that trusts the certificate alone, by its bytes, as the C# side's
/// `TlsWire` does: the fixture signed itself, its certificate a CA's.
///
/// # Errors
///
/// What rustls refuses it for.
pub fn client_config() -> Result<Arc<ClientConfig>, rustls::Error> {
    let certificate = CertificateDer::from_pem_slice(CERTIFICATE.as_bytes())
        .map_err(|_unread| refused("certificate"))?;
    let provider = provider();
    let pinned = Pinned {
        certificate,
        algorithms: provider.signature_verification_algorithms,
    };

    Ok(Arc::new(
        ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(pinned))
            .with_no_client_auth(),
    ))
}

// ── Bead's test PKI ──────────────────────────────────────────────────────────────────────────

/// The file `name` of `spec/pki/`, Bead's test PKI, its text whole.
///
/// The PKI holds a root, an intermediate under it, a client under the intermediate and a server
/// under the root, then a stranger root with a client and a server of its own. Its keys guard
/// nothing.
///
/// # Errors
///
/// What reading it refuses, saying which file.
pub fn pki(name: &str) -> Result<String, String> {
    files::text_of(&format!("pki/{name}"))
}

/// The `tls` of the PKI's client: `root.pem` its authorities, `client-chain.pem` its certificate,
/// the intermediate after it, and `client.key` its key.
///
/// # Errors
///
/// What reading a file of the PKI refuses.
pub fn pki_client() -> Result<TlsOptions, String> {
    Ok(TlsOptions {
        authorities: Some(pki("root.pem")?),
        certificate: Some(pki("client-chain.pem")?),
        key: Some(pki("client.key")?),
    })
}

// the PKI's file `name`, read as certificates
fn pki_certificates(name: &str) -> Result<Vec<CertificateDer<'static>>, String> {
    CertificateDer::pem_slice_iter(pki(name)?.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|unread| format!("{name}: {unread}"))
}

/// How a server of the PKI serves: under which certificate, asking what of its client, up to which
/// TLS version.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct PkiServerOptions {
    /// Whether it serves under `stranger-server.pem`, which chains to the stranger root, rather
    /// than `server.pem`, under the root: `false` when none.
    pub is_stranger: Option<bool>,
    /// Whether its handshake requires a client certificate under `root.pem`, or asks for none:
    /// `true` when none.
    pub requires_certificate: Option<bool>,
    /// The highest TLS version it speaks, 1.2 or 1.3: TLS 1.3 when none.
    pub highest: Option<ProtocolVersion>,
}

/// A server's config of the PKI, as `options` say.
///
/// # Errors
///
/// What reading the PKI or rustls refuses it for.
pub fn pki_server_config(options: &PkiServerOptions) -> Result<Arc<ServerConfig>, String> {
    let name = if options.is_stranger.unwrap_or(false) {
        "stranger-server"
    } else {
        "server"
    };
    let chain = pki_certificates(&format!("{name}.pem"))?;
    let key = PrivateKeyDer::from_pem_slice(pki(&format!("{name}.key"))?.as_bytes())
        .map_err(|unread| format!("{name}.key: {unread}"))?;
    let versions: &[&'static rustls::SupportedProtocolVersion] =
        if options.highest == Some(ProtocolVersion::TLSv1_2) {
            &[&rustls::version::TLS12]
        } else {
            &[&rustls::version::TLS13, &rustls::version::TLS12]
        };
    let provider = provider();
    let versioned = ServerConfig::builder_with_provider(Arc::clone(&provider))
        .with_protocol_versions(versions)
        .map_err(|refused| refused.to_string())?;
    let verified = if options.requires_certificate.unwrap_or(true) {
        let mut roots = RootCertStore::empty();

        for root in pki_certificates("root.pem")? {
            roots.add(root).map_err(|refused| refused.to_string())?;
        }

        let verifier = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider)
            .build()
            .map_err(|refused| refused.to_string())?;

        versioned.with_client_cert_verifier(verifier)
    } else {
        versioned.with_no_client_auth()
    };

    Ok(Arc::new(
        verified
            .with_single_cert(chain, key)
            .map_err(|refused| refused.to_string())?,
    ))
}

// ── Its TLS front ────────────────────────────────────────────────────────────────────────────

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A front of TLS before a server in the clear, the test kit's twins' peer.
///
/// As the TypeScript side's over `node:tls` and the C# side's over `SslStream` are, it listens on
/// 127.0.0.1, takes TLS as a [`pki_server_config`] of its options, and pipes each connection whose
/// handshake it took to that server's port, both ways; a handshake it refused, it drops.
pub struct TlsFront {
    port: u16,
    versions: Arc<Mutex<Vec<ProtocolVersion>>>,
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
    accepting: JoinHandle<()>,
}

impl core::fmt::Debug for TlsFront {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("TlsFront")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

// one connection it took: its handshake, then its bytes piped to `port`, both ways
async fn piped(
    (acceptor, near): (TlsAcceptor, TcpStream),
    (port, versions): (u16, Arc<Mutex<Vec<ProtocolVersion>>>),
) {
    // * a handshake it refused is dropped, its client told by its alert
    let Ok(mut secured) = acceptor.accept(near).await else {
        return;
    };

    if let Some(version) = secured.get_ref().1.protocol_version() {
        locked(&versions).push(version);
    }

    let Ok(mut far) = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await else {
        return;
    };

    tokio::io::copy_bidirectional(&mut secured, &mut far)
        .await
        .ok();
}

impl TlsFront {
    /// A front before the server in the clear on 127.0.0.1's `port`, serving as `options` say.
    ///
    /// # Errors
    ///
    /// Where its config does not build, or where it cannot listen.
    pub async fn to(port: u16, options: &PkiServerOptions) -> io::Result<Self> {
        let acceptor = TlsAcceptor::from(pki_server_config(options).map_err(io::Error::other)?);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let local = listener.local_addr()?.port();
        let versions: Arc<Mutex<Vec<ProtocolVersion>>> = Arc::default();
        let tasks: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
        let taken = Arc::clone(&versions);
        let held = Arc::clone(&tasks);
        let accepting = spawn(async move {
            while let Ok((near, _)) = listener.accept().await {
                let piping = spawn(piped((acceptor.clone(), near), (port, Arc::clone(&taken))));

                locked(&held).push(piping);
            }
        });

        Ok(Self {
            port: local,
            versions,
            tasks,
            accepting,
        })
    }

    /// The port a client connects to it by, on 127.0.0.1.
    #[must_use]
    pub const fn port(&self) -> u16 {
        self.port
    }

    /// The TLS version of each handshake it took, in their order.
    #[must_use]
    pub fn versions(&self) -> Vec<ProtocolVersion> {
        locked(&self.versions).clone()
    }

    /// Stops listening, and drops each connection it pipes.
    pub fn dispose(&self) {
        self.accepting.abort();

        for task in locked(&self.tasks).drain(..) {
            task.abort();
        }
    }
}

impl Drop for TlsFront {
    fn drop(&mut self) {
        self.dispose();
    }
}
