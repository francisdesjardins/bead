using System.Globalization;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace Bead;

/// <summary>
/// A client's TLS (spec 15.39, decision 0053): the authorities it judges its server by, and the
/// certificate it presents with its key, each PEM text (RFC 7468). Every member is optional, and one
/// that gives none is none. A transport's client holds it in the clear and uses it on a connect over
/// TLS alone; a broker's adapter refuses it over a URL that is not TLS. Its client refuses it as it
/// is built, an <see cref="ArgumentException"/> naming <c>options</c>: a <see cref="Certificate"/>
/// without its <see cref="Key"/>, or a key without its certificate, authorities or a certificate that
/// hold no certificate that reads, a key that does not read or is encrypted, and a key of another
/// certificate.
/// </summary>
public sealed record TlsOptions
{
    /// <summary>
    /// One or more <c>CERTIFICATE</c> blocks: the trust anchors its server's certificate chains to
    /// (RFC 5280 §6.1.1), in place of the platform's roots, never added to them. The platform's roots
    /// and verifier when none.
    /// </summary>
    public string? Authorities { get; init; }

    /// <summary>
    /// Its certificate first, then the intermediates that certify it, each certifying the one before
    /// (RFC 8446 §4.4.2): presented where its server asks for one at the handshake, and given with its
    /// <see cref="Key"/> alone. None when none.
    /// </summary>
    public string? Certificate { get; init; }

    /// <summary>
    /// Its certificate's private key, unencrypted: PKCS #8 (<c>PRIVATE KEY</c>), SEC1
    /// (<c>EC PRIVATE KEY</c>) or PKCS #1 (<c>RSA PRIVATE KEY</c>). An encrypted key
    /// (<c>ENCRYPTED PRIVATE KEY</c>) is refused, and no passphrase is taken. Given with its
    /// <see cref="Certificate"/> alone, and never printed. None when none.
    /// </summary>
    public string? Key { get; init; }

    // every member as the compiler writes it, but its key, written <redacted> where one is given
    private bool PrintMembers(StringBuilder builder)
    {
        // ! a private key reaches no log, no exception's message and no debugger
        builder.Append(CultureInfo.InvariantCulture, $"Authorities = {Authorities}, Certificate = {Certificate}, Key = {(Key is null ? "" : "<redacted>")}");

        return true;
    }
}

/// <summary>
/// A client's <see cref="TlsOptions"/> held to its rules as its client is built, and read into what
/// its handshakes present and trust (spec 15.39).
/// </summary>
internal static class Tls
{
    // the labels of an unencrypted private key, PKCS #8, SEC1 and PKCS #1 (RFC 7468 §10, §11)
    private static readonly string[] KeyLabels = ["PRIVATE KEY", "EC PRIVATE KEY", "RSA PRIVATE KEY"];

    /// <summary>
    /// The options as taken: none when none are given, or none of their members; otherwise refused in
    /// the order of spec 15.39, an <see cref="ArgumentException"/> naming
    /// <paramref name="paramName"/>. What it reads to judge them is let go of before it returns.
    /// </summary>
    public static TlsOptions? Assert(TlsOptions? tls, string paramName)
    {
        if (tls is null || !IsGiven(tls))
        {
            return null;
        }

        if ((tls.Certificate is null) != (tls.Key is null))
        {
            throw new ArgumentException("a TLS client certificate is given with its key, and a key with its certificate", paramName);
        }

        if (tls.Authorities is { } authorities)
        {
            Release(CertificatesOf(authorities) ?? throw new ArgumentException("authorities reads as no certificate", paramName));
        }

        if (tls.Certificate is { } certificate)
        {
            Release(CertificatesOf(certificate) ?? throw new ArgumentException("certificate reads as no certificate", paramName));

            var key = KeyOf(tls.Key!) ?? throw new ArgumentException("key reads as no key", paramName);

            using var leaf = LeafOf((certificate, key)) ?? throw new ArgumentException("the key is not the certificate's", paramName);
        }

        return tls;
    }

    /// <summary>Whether <paramref name="tls"/> gives a member: one that gives none is none.</summary>
    public static bool IsGiven(TlsOptions? tls)
    {
        return tls is not null && (tls.Authorities is not null || tls.Certificate is not null || tls.Key is not null);
    }

    /// <summary>What a client's handshakes present and trust, read from options <see cref="Assert"/> took.</summary>
    public static TlsCredentials CredentialsOf(TlsOptions tls)
    {
        X509Certificate2? leaf = null;
        X509Certificate2Collection? intermediates = null;

        if (tls.Certificate is { } certificate)
        {
            using var ephemeral = LeafOf((certificate, KeyOf(tls.Key!)!))!;

            // ! imported again from PKCS #12: Schannel refuses an ephemeral key, "the credentials
            // supplied to the package were not recognized", where SslStream presents it by a context
            leaf = X509CertificateLoader.LoadPkcs12(ephemeral.Export(X509ContentType.Pkcs12), null);
            intermediates = CertificatesOf(certificate)!;
            intermediates[0].Dispose();
            intermediates.RemoveAt(0);
        }

        return new TlsCredentials((leaf, intermediates), tls.Authorities is { } authorities ? CertificatesOf(authorities) : null);
    }

    /// <summary>Lets go of each certificate of <paramref name="certificates"/>.</summary>
    public static void Release(X509Certificate2Collection? certificates)
    {
        foreach (var certificate in certificates ?? [])
        {
            certificate.Dispose();
        }
    }

    // the certificates a PEM text holds, its other blocks skipped; none when none reads
    private static X509Certificate2Collection? CertificatesOf(string pem)
    {
        var certificates = new X509Certificate2Collection();

        try
        {
            certificates.ImportFromPem(pem);
        }
        catch (CryptographicException)
        {
            Release(certificates);

            return null;
        }

        return certificates.Count > 0 ? certificates : null;
    }

    // the first private key a PEM text holds, as its own text: none where it holds none, where that
    // one is encrypted, and where it reads as no RSA or EC key
    private static string? KeyOf(string pem)
    {
        var rest = pem.AsSpan();

        while (PemEncoding.TryFind(rest, out var fields))
        {
            var label = rest[fields.Label].ToString();

            if (label == "ENCRYPTED PRIVATE KEY")
            {
                return null;
            }

            if (KeyLabels.Contains(label))
            {
                var key = rest[fields.Location].ToString();

                return IsKey((RSA.Create(), key)) || IsKey((ECDsa.Create(), key)) ? key : null;
            }

            rest = rest[fields.Location.End..];
        }

        return null;
    }

    // whether `key` reads as a private key of the algorithm given, which is let go of
    private static bool IsKey((AsymmetricAlgorithm Algorithm, string Key) read)
    {
        var (algorithm, key) = read;

        using (algorithm)
        {
            try
            {
                algorithm.ImportFromPem(key);

                return true;
            }
            catch (Exception reason) when (reason is CryptographicException or ArgumentException)
            {
                return false;
            }
        }
    }

    // its certificate's first block, with its key: none where the key is another certificate's
    private static X509Certificate2? LeafOf((string Certificate, string Key) given)
    {
        try
        {
            return X509Certificate2.CreateFromPem(given.Certificate, given.Key);
        }
        catch (Exception reason) when (reason is CryptographicException or ArgumentException)
        {
            return null;
        }
    }
}

/// <summary>
/// What a client's TLS holds while its handshakes use it: its certificate with its private key, the
/// intermediates that certify it and the authorities it trusts, let go of together.
/// </summary>
internal sealed class TlsCredentials : IDisposable
{
    private readonly X509Certificate2? _leaf;
    private readonly X509Certificate2Collection? _intermediates;
    private readonly SslStreamCertificateContext? _context;

    /// <summary>What a client's handshakes present and trust: its leaf and its intermediates, then its authorities.</summary>
    public TlsCredentials((X509Certificate2? Leaf, X509Certificate2Collection? Intermediates) certificate, X509Certificate2Collection? authorities)
    {
        (_leaf, _intermediates) = certificate;
        Authorities = authorities;

        if (_leaf is not null)
        {
            // * the certificate first, then its intermediates, each certifying the one before (RFC
            // 8446 §4.4.2), presented whatever authorities its server names; on Windows, the
            // platform writes the intermediates into the user's CA store, from which Schannel sends
            // them
            _context = SslStreamCertificateContext.Create(_leaf, _intermediates, offline: true);
            Certificates = [_leaf, .. _intermediates ?? []];
        }
    }

    /// <summary>The authorities its server's certificate chains to, in place of the platform's roots; none when none.</summary>
    public X509Certificate2Collection? Authorities { get; }

    /// <summary>
    /// Its certificate, then its intermediates, for a library that takes a collection: one that
    /// presents its leaf alone, or none, where the platform builds no chain to the authorities its
    /// server names. None when none.
    /// </summary>
    public X509Certificate2Collection? Certificates { get; }

    /// <summary>
    /// A handshake's options of its own: its certificate presented by a context, and its server judged
    /// by a chain to its authorities alone, no revocation checked, as SslStream checks none by
    /// default; the platform's for what it does not give.
    /// </summary>
    public SslClientAuthenticationOptions SslOptions()
    {
        var options = new SslClientAuthenticationOptions();

        if (_context is not null)
        {
            options.ClientCertificateContext = _context;
        }

        if (Authorities is not null)
        {
            options.CertificateChainPolicy = PolicyOf(Authorities);
        }

        return options;
    }

    /// <summary>A chain to <paramref name="authorities"/> alone, in place of the platform's roots.</summary>
    public static X509ChainPolicy PolicyOf(X509Certificate2Collection authorities)
    {
        var policy = new X509ChainPolicy { TrustMode = X509ChainTrustMode.CustomRootTrust, RevocationMode = X509RevocationMode.NoCheck };

        policy.CustomTrustStore.AddRange(authorities);

        return policy;
    }

    /// <summary>Lets go of its certificates, its key with its leaf.</summary>
    public void Dispose()
    {
        _leaf?.Dispose();
        Tls.Release(_intermediates);
        Tls.Release(Authorities);
    }
}
