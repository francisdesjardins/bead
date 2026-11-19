using System.Net;

namespace Bead;

/// <summary>
/// The proxy of every handler Bead builds: none for a host on the loopback, as
/// <see cref="TransportSecurity.IsLoopback"/> judges it, a localhost name or an IP literal of
/// 127.0.0.0/8 or <c>::1</c> (spec 13.4); the platform's, <see cref="HttpClient.DefaultProxy"/>, for
/// any other, read at each request, so an application that sets it later is followed.
/// </summary>
internal sealed class LoopbackBypassProxy : IWebProxy
{
    private LoopbackBypassProxy()
    {
    }

    /// <summary>The one every handler shares.</summary>
    public static LoopbackBypassProxy Instance { get; } = new();

    /// <summary>The platform's proxy's credentials, read and written through.</summary>
    public ICredentials? Credentials
    {
        get
        {
            return HttpClient.DefaultProxy.Credentials;
        }
        set
        {
            HttpClient.DefaultProxy.Credentials = value;
        }
    }

    /// <summary>The platform's proxy for <paramref name="destination"/>.</summary>
    public Uri? GetProxy(Uri destination)
    {
        return HttpClient.DefaultProxy.GetProxy(destination);
    }

    /// <summary>Whether a request to <paramref name="host"/> goes direct: on the loopback, or as the platform's proxy says.</summary>
    public bool IsBypassed(Uri host)
    {
        ArgumentNullException.ThrowIfNull(host);

        return TransportSecurity.IsLoopback(host.Host) || HttpClient.DefaultProxy.IsBypassed(host);
    }
}
