using System.Net;
using System.Text;

namespace Bead.Fuzz;

/// <summary>
/// Raw bytes as a request's field, read as the HTTP transport's server reads its fields. The first
/// byte picks the field, modulo the five below; the others are its value, one character an octet,
/// in Latin-1, as the TypeScript side reads what Node hands on, each line feed parting two of its
/// lines. No parser here refuses by throwing: each returns, and any exception is a finding. The
/// TypeScript side's <c>tools/fuzz/http-fields.ts</c> is its twin, slot for slot, with the same
/// server around it.
/// </summary>
internal sealed class HttpFieldsTarget : IFuzzTarget
{
    // the fields, by the first byte's slot: bead-after, bead-wait and bead-listen, each an Item of
    // RFC 9651, a count or a Boolean; Authorization; X-Forwarded-For; the request's target, its first
    // line, then its Host's lines; Origin
    private const int ItemSlot = 0;
    private const int AuthorizationSlot = 1;
    private const int ForwardedForSlot = 2;
    private const int HostSlot = 3;
    private const int SlotCount = 5;

    // the server the fields come to: its socket's peer, a proxy it names, and what it takes
    private const string OwnAuthority = "localhost:8080";
    private static readonly IPAddress RemoteAddress = IPAddress.Parse("10.0.0.1");
    private static readonly ProxyTrust Trust = TrustedProxies.TrustOf((["10.0.0.0/8", "2001:db8::/32"], "TrustedProxies"), (2, "UnnamedProxies"));
    private static readonly string[] Hosts = ["example.test"];
    private static readonly string[] Origins = ["https://app.example.test"];

    /// <inheritdoc/>
    public string Name
    {
        get
        {
            return "http-fields";
        }
    }

    // helpers

    private static void ReadForwardedFor(string value)
    {
        foreach (var entry in value.Split(','))
        {
            TrustedProxies.AddressOfEntry(entry);
        }

        TrustedProxies.ClientAddressOf(RemoteAddress, (value, Trust));
    }

    private static void ReadHost(string[] lines)
    {
        var hostLines = lines[1..];
        var targetAuthority = HostsAndOrigins.TargetAuthorityOf(lines[0]);

        HostsAndOrigins.IsWellFormedHost(hostLines, true);
        HostsAndOrigins.IsWellFormedHost(hostLines, (true, targetAuthority));

        var authority = HostsAndOrigins.AuthorityOf(hostLines, targetAuthority);

        foreach (var named in new[] { authority, targetAuthority, hostLines.FirstOrDefault() })
        {
            if (named is not null)
            {
                HostsAndOrigins.IsAuthority(named);
                HostsAndOrigins.HostPartOf(named);
                HostsAndOrigins.IsTakenHost(named, Hosts);
                HostsAndOrigins.OwnAuthorityOf(named, Hosts);
            }
        }
    }

    private static void ReadOrigin(string[] lines)
    {
        var origin = HostsAndOrigins.OriginOf(lines);

        HostsAndOrigins.IsTakenOrigin(origin, (OwnAuthority, Origins));
        HostsAndOrigins.IsListedOrigin(origin, Origins);
    }

    // definition

    /// <inheritdoc/>
    public void Run(ReadOnlySpan<byte> data)
    {
        var value = Encoding.Latin1.GetString(data.IsEmpty ? data : data[1..]);
        var lines = value.Split('\n');

        foreach (var line in lines)
        {
            HostsAndOrigins.IsVisibleField(line);
        }

        switch ((data.IsEmpty ? 0 : data[0]) % SlotCount)
        {
            case ItemSlot:
                StructuredFields.ParseItem(value);
                break;
            case AuthorizationSlot:
                HostsAndOrigins.CredentialOf(lines);
                break;
            case ForwardedForSlot:
                ReadForwardedFor(value);
                break;
            case HostSlot:
                ReadHost(lines);
                break;
            default:
                // the Origin's slot
                ReadOrigin(lines);
                break;
        }
    }
}
