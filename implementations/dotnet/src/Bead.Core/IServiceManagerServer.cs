namespace Bead;

// ! the one manager implements both sides' interfaces, so a type test or a cast between them
// proves no router's side; each maker's refusal as it is made holds past it
/// <summary>
/// A server's services, on a server's router (spec 16.11): the commands it makes of a client, and
/// the resolvers of the requests and notifications it answers. A client's makers are none of its
/// own, nor is <see cref="ServiceManager.Dropped"/>: a server makes no notification to drop. What
/// <see cref="IBeadServer{TData}.Services"/> gives.
/// </summary>
public interface IServiceManagerServer
{
    /// <summary>One step of a call, as <see cref="ServiceManager.Debug"/> tells it.</summary>
    event Action<Exception?, DebugEvent>? Debug;

    /// <summary>A deprecated procedure was called, as <see cref="ServiceManager.Deprecated"/> tells it.</summary>
    event Action<Procedure>? Deprecated;

    /// <summary>Whether anyone hears <see cref="Debug"/>.</summary>
    bool IsDebugging { get; }

    /// <summary>A requester of a command, as <see cref="ServiceManager.GetCommand{TRequest, TResponse}"/> makes one.</summary>
    Func<TRequest, BoundCommand<TResponse>> GetCommand<TRequest, TResponse>(
        Procedure procedure,
        RequestDependencies<TRequest, TResponse> dependencies);

    /// <summary>The resolver of <paramref name="procedure"/>, as <see cref="ServiceManager.GetRequestResolver{TRequest, TResponse}"/> gives one.</summary>
    Func<RequestResolverCallback<TRequest, TResponse>, IRequestResolver> GetRequestResolver<TRequest, TResponse>(
        Procedure procedure,
        RequestResolverDependencies<TRequest, TResponse> dependencies);

    /// <summary>The resolver of a notification's <paramref name="procedure"/>, as <see cref="ServiceManager.GetNotificationResolver{TRequest, TResponse, TNotification}"/> gives one.</summary>
    Func<NotificationResolverCallback<TRequest, TResponse>, INotificationResolver<TNotification>> GetNotificationResolver<TRequest, TResponse, TNotification>(
        Procedure procedure,
        NotificationResolverDependencies<TRequest, TResponse, TNotification> dependencies);

    // ! internal, so the one manager alone implements this interface: no other assembly can, and a
    // member the manager gains breaks no implementer
    internal ServiceManager Manager { get; }
}
