using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Bead.Tests;

namespace Bead.Core.Tests;

/// <summary>
/// <see cref="TlsOptions"/>, held to its rules as a client that takes it is built, and printed
/// without its key (spec 15.39).
/// </summary>
public sealed class TlsOptionsTests
{
    // helpers

    // what a client takes it as, or the words it is refused with, its parameter checked
    private static string Refusal(TlsOptions tls)
    {
        var refusal = Assert.Throws<ArgumentException>(() =>
        {
            return Tls.Assert(tls, "options");
        });

        Assert.Equal("options", refusal.ParamName);

        return refusal.Message.Split(" (Parameter", 2)[0];
    }

    // spec 15.39
    [Fact]
    public void Refuses_as_it_is_built_a_certificate_without_its_key_or_a_key_without_its_certificate_a_key_of_another_an_encrypted_one_and_a_certificate_or_authorities_that_read_as_no_certificate()
    {
        var client = Pki.Client();
        using var key = ECDsa.Create();

        key.ImportFromPem(Pki.Read("client.key"));

        var encrypted = key.ExportEncryptedPkcs8PrivateKeyPem("bead", new PbeParameters(PbeEncryptionAlgorithm.Aes256Cbc, HashAlgorithmName.SHA256, 1_000));
        var unread = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";

        Assert.Equal(
            [
                "a TLS client certificate is given with its key, and a key with its certificate",
                "a TLS client certificate is given with its key, and a key with its certificate",
                "the key is not the certificate's",
                "key reads as no key",
                "key reads as no key",
                "key reads as no key",
                "certificate reads as no certificate",
                "certificate reads as no certificate",
                "authorities reads as no certificate",
                "authorities reads as no certificate",
            ],
            new[]
            {
                client with { Key = null },
                client with { Certificate = null },
                client with { Key = Pki.Read("stranger-client.key") },
                client with { Key = encrypted },
                client with { Key = "nope" },
                client with { Key = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" },
                client with { Certificate = Pki.Read("client.key") },
                client with { Certificate = unread },
                client with { Authorities = "nope" },
                client with { Authorities = unread },
            }.Select(Refusal));

        // * taken: its key in PKCS #8, SEC1 or PKCS #1, and a TLS of no member as none
        using var rsa = RSA.Create(2_048);
        using var made = new CertificateRequest("CN=Bead test RSA client", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1).CreateSelfSigned(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch.AddYears(100));

        foreach (var taken in new[]
        {
            client,
            client with { Key = key.ExportECPrivateKeyPem() },
            new TlsOptions { Certificate = made.ExportCertificatePem(), Key = rsa.ExportRSAPrivateKeyPem() },
            new TlsOptions { Authorities = Pki.Read("root.pem") },
        })
        {
            Assert.Same(taken, Tls.Assert(taken, "options"));
        }

        Assert.Null(Tls.Assert(new TlsOptions(), "options"));
        Assert.Null(Tls.Assert(null, "options"));
    }

    [Fact]
    public void Writes_its_key_as_redacted_where_it_is_printed()
    {
        var client = Pki.Client();
        var printed = client.ToString();

        Assert.DoesNotContain(client.Key!, printed, StringComparison.Ordinal);
        Assert.DoesNotContain("PRIVATE KEY", printed, StringComparison.Ordinal);
        Assert.EndsWith("Key = <redacted> }", printed, StringComparison.Ordinal);
        Assert.Contains("Certificate = -----BEGIN CERTIFICATE-----", printed, StringComparison.Ordinal);
        Assert.EndsWith("Key =  }", new TlsOptions { Authorities = Pki.Read("root.pem") }.ToString(), StringComparison.Ordinal);
    }
}
