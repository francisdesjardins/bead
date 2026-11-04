namespace Bead;

// ! the one manager implements both sides' interfaces, so a type test or a cast between them
// proves no router's side; each maker's refusal as it is made holds past it
/// <summary>
/// A client's services, on a client's router (spec 16.11): the requests and notifications it makes
/// of its server, and the resolvers of the commands it answers. A server's makers are none of its
/// own: what <see cref="IClient.Services"/> gives.
/// </summary>
public interface IServiceManagerClient
{
    /// <summary>A notification dropped, as <see cref="ServiceManager.Dropped"/> tells it.</summary>
    event Action<Procedure, Failure?>? Dropped;

    /// <summary>One step of a call, as <see cref="ServiceManager.Debug"/> tells it.</summary>
    event Action<Exception?, DebugEvent>? Debug;

    /// <summary>A deprecated procedure was called, as <see cref="ServiceManager.Deprecated"/> tells it.</summary>
    event Action<Procedure>? Deprecated;

    /// <summary>Whether anyone hears <see cref="Debug"/>.</summary>
    bool IsDebugging { get; }

    /// <summary>The notification of <paramref name="procedure"/>, as <see cref="ServiceManager.GetNotification{TRequest, TResponse, TNotification}"/> gives it.</summary>
    INotification<TRequest, TNotification> GetNotification<TRequest, TResponse, TNotification>(
        Procedure procedure,
        NotificationDependencies<TRequest, TResponse, TNotification> dependencies);

    /// <summary>A requester of <paramref name="procedure"/>, as <see cref="ServiceManager.GetRequest{TRequest, TResponse}"/> makes one.</summary>
    Func<TRequest, BoundCall<TResponse>> GetRequest<TRequest, TResponse>(
        Procedure procedure,
        RequestDependencies<TRequest, TResponse> dependencies);

    /// <summary>The resolver of a command, as <see cref="ServiceManager.GetCommandResolver{TRequest, TResponse}"/> gives one.</summary>
    Func<RequestResolverCallback<TRequest, TResponse>, IRequestResolver> GetCommandResolver<TRequest, TResponse>(
        Procedure procedure,
        RequestResolverDependencies<TRequest, TResponse> dependencies);

    // ! internal, so the one manager alone implements this interface: no other assembly can, and a
    // member the manager gains breaks no implementer
    internal ServiceManager Manager { get; }
}
