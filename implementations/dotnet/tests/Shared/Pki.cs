using System.Security.Cryptography.X509Certificates;

namespace Bead.Tests;

/// <summary>
/// The test PKI every side's TLS tests read, <c>spec/pki/</c>, by path as the conformance players
/// read <c>spec/</c> (spec 15.39): a root, an intermediate under it, a client under the intermediate
/// and a server under the root, and a stranger root's client and server, which no test trusts.
/// </summary>
internal static class Pki
{
    /// <summary>A file of the PKI, as PEM text.</summary>
    public static string Read(string name)
    {
        return File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "pki", name));
    }

    /// <summary>
    /// The client's TLS that presents its certificate under the intermediate, the intermediate after
    /// it, and trusts the root alone.
    /// </summary>
    public static TlsOptions Client()
    {
        return new TlsOptions { Authorities = Read("root.pem"), Certificate = Read("client-chain.pem"), Key = Read("client.key") };
    }

    /// <summary>A certificate of the PKI with its key, as a server serves it.</summary>
    public static X509Certificate2 Serving(string name)
    {
        using var ephemeral = X509Certificate2.CreateFromPem(Read($"{name}.pem"), Read($"{name}.key"));

        // imported again, so SslStream can use its key on Windows
        return X509CertificateLoader.LoadPkcs12(ephemeral.Export(X509ContentType.Pkcs12), null);
    }
}
