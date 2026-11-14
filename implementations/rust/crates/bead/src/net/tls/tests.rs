//! A client's `tls`, the twin of `tls.test.ts` and `TlsOptionsTests`: what it refuses as it is
//! read, each refusal in the order every side checks, and its key never written.

use super::*;
use crate::testing::tls::pki;

// the PKI's file `name`; each one read, as what reads below holds
fn of(name: &str) -> Option<String> {
    pki(name).ok()
}

fn tls_of(
    (authorities, certificate): (Option<String>, Option<String>),
    key: Option<String>,
) -> TlsOptions {
    TlsOptions {
        authorities,
        certificate,
        key,
    }
}

fn refusal_of(tls: &TlsOptions) -> String {
    read_tls(tls).unwrap_err().message().to_owned()
}

// spec 15.39
#[test]
fn refuses_as_it_is_built_a_certificate_without_its_key_or_a_key_without_its_certificate_a_key_of_another_an_encrypted_one_and_a_certificate_or_authorities_that_read_as_no_certificate()
 {
    let key = pki("client.key").unwrap();
    // * a key under the label of one encrypted (RFC 5958 §3), which no side decrypts
    let encrypted = key.replace("PRIVATE KEY", "ENCRYPTED PRIVATE KEY");
    let no_block = Some("no PEM here".to_owned());
    let cases = [
        (
            tls_of((None, of("client-chain.pem")), None),
            "a TLS client certificate is given with its key, and a key with its certificate",
        ),
        (
            tls_of((None, None), of("client.key")),
            "a TLS client certificate is given with its key, and a key with its certificate",
        ),
        (
            tls_of((None, of("client-chain.pem")), of("stranger-client.key")),
            "the key is not the certificate's",
        ),
        (
            tls_of((None, of("client-chain.pem")), Some(encrypted)),
            "key reads as no key",
        ),
        (
            tls_of((None, of("client-chain.pem")), of("client.pem")),
            "key reads as no key",
        ),
        (
            tls_of((None, no_block.clone()), of("client.key")),
            "certificate reads as no certificate",
        ),
        (
            tls_of((None, of("client.key")), of("client.key")),
            "certificate reads as no certificate",
        ),
        (
            tls_of((no_block, None), None),
            "authorities reads as no certificate",
        ),
        (
            tls_of((of("client.key"), None), None),
            "authorities reads as no certificate",
        ),
        // * the pair is checked first, in one order on every side
        (
            tls_of((Some(String::new()), of("client-chain.pem")), None),
            "a TLS client certificate is given with its key, and a key with its certificate",
        ),
    ];

    for (tls, refusal) in &cases {
        assert_eq!(refusal_of(tls), *refusal, "{tls:?}");
    }

    // what reads: the authorities alone, the certificate with its key alone, and all three
    for tls in [
        tls_of((of("root.pem"), None), None),
        tls_of((None, of("client-chain.pem")), of("client.key")),
        tls_of((of("root.pem"), of("client.pem")), of("client.key")),
    ] {
        let read = read_tls(&tls);

        assert!(read.is_ok(), "{tls:?}: {read:?}");
    }

    // one given no member is none, beside a client_config among it
    let config = crate::testing::tls::client_config().unwrap();

    assert!(matches!(
        client_tls_of(Some(&config), &TlsOptions::default()),
        Ok(ClientTls::Given(_))
    ));
    assert!(matches!(
        client_tls_of(None, &TlsOptions::default()),
        Ok(ClientTls::Read(read)) if read.certified.is_none()
    ));
}

#[test]
fn writes_its_key_as_redacted_where_it_is_printed() {
    let key = pki("client.key").unwrap();
    let tls = tls_of((None, of("client-chain.pem")), Some(key.clone()));
    let written = format!("{tls:?}");

    assert!(written.contains("key: <redacted>"), "{written}");
    assert!(!written.contains(key.trim()), "{written}");
    assert!(
        format!("{:?}", TlsOptions::default()).contains("key: None"),
        "none when none"
    );
    // * nor what it read
    assert!(
        !format!("{:?}", read_tls(&tls).unwrap()).contains(key.trim()),
        "read"
    );
}
