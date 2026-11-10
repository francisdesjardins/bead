//! The TypeScript side's `TLS_FIXTURE`, for the tests of a transport over TLS alone.
//!
//! A key and the certificate it signed itself, for `localhost` and 127.0.0.1, good until 2126. It
//! guards nothing — anyone may read it here.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, ServerConfig, SignatureScheme,
};

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
