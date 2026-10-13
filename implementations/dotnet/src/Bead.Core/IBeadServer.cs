namespace Bead;

/// <summary>
/// A server of Bead: its layers — its transport, its router, its services and its sessions — the
/// admissions it gives a procedure, what each layer holds, and its disposal. <see cref="Server{TData}"/>
/// is one, and each transport's server, which holds one.
/// </summary>
/// <typeparam name="TData">What a session keeps.</typeparam>
public interface IBeadServer<TData> : IAsyncDisposable
{
    /// <summary>Its transport.</summary>
    IServerTransport Transport { get; }

    /// <summary>Its router.</summary>
    RouterServer Router { get; }

    /// <summary>Its services.</summary>
    ServiceManager Services { get; }

    /// <summary>Its sessions.</summary>
    SessionManager<TData> Sessions { get; }

    /// <summary>The admission of a procedure that needs a session, as <see cref="Server{TData}.RequireSession"/> says.</summary>
    BeforeRequest RequireSession { get; }

    /// <summary>A relay's admission by default, as <see cref="Server{TData}.RequireCredential"/> says.</summary>
    BeforeRequest RequireCredential { get; }

    /// <summary>A relay's admission that lends leg B's session, as <see cref="Server{TData}.ShareLegBSession"/> says.</summary>
    BeforeRequest ShareLegBSession { get; }

    /// <summary>What each layer holds, as <see cref="Server{TData}.Gauges"/> gives it.</summary>
    Task<ServerGauges> Gauges();

    /// <summary>The verdict on its gauges, as <see cref="Server{TData}.Health"/> gives it.</summary>
    Task<Health> Health();
}
