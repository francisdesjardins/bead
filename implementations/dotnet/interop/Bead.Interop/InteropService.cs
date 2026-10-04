using System.Collections.Concurrent;
using System.Text.Json;

namespace Bead.Interop;

/// <summary>
/// The procedures of Bead's interop service, <c>spec/interop-service.json</c>, as the C# side
/// offers them: what a client of any implementation calls, and what
/// <c>spec/conversations.json</c> plays against.
/// </summary>
public static class InteropService
{
    // constants

    private static readonly JsonElement Manifest = Load();

    // the question ask puts to its client's clock, and how long it waits for the answer
    private const string Question = "What time is it where you are?";

    private static readonly TimeSpan ClockTimeout = TimeSpan.FromSeconds(10);

    private static readonly JsonPayloads Payloads = new();

    /// <summary>What the interop service's payloads are, to answer: JSON, in UTF-8. What is not JSON throws.</summary>
    public static IRequestSerializerServer<JsonElement, JsonElement> Json
    {
        get
        {
            return Payloads;
        }
    }

    /// <summary>What the interop service's notifications are: JSON, in UTF-8.</summary>
    public static INotificationSerializerServer<JsonElement, JsonElement, JsonElement> JsonNotified
    {
        get
        {
            return Payloads;
        }
    }

    /// <summary>What the interop service's payloads are, to ask: JSON, in UTF-8.</summary>
    public static IRequestSerializerClient<JsonElement, JsonElement> JsonAsked
    {
        get
        {
            return Payloads;
        }
    }

    // helpers

    private static JsonElement Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "interop-service.json");

        using var document = JsonDocument.Parse(File.ReadAllText(path));

        return document.RootElement.Clone();
    }

    /// <summary>
    /// The names of the manifest's procedures, and whether each is a command a client offers: what
    /// <see cref="Offer(Server{string})"/> and <see cref="OfferClient"/> register between them.
    /// </summary>
    public static IReadOnlyList<(string ProcedureName, bool IsOfferedByClient)> Procedures { get; } =
        [.. Manifest.GetProperty("procedures").EnumerateArray().Select((procedure) =>
        {
            return (
                procedure.GetProperty("procedureName").GetString()!,
                procedure.TryGetProperty("offeredBy", out var side) && side.GetString() == "client");
        })];

    /// <summary>The procedure of the interop service named <paramref name="procedureName"/>.</summary>
    public static Procedure ProcedureOf(string procedureName)
    {
        foreach (var procedure in Manifest.GetProperty("procedures").EnumerateArray())
        {
            if (procedure.GetProperty("procedureName").GetString() == procedureName)
            {
                return new Procedure
                {
                    ServiceId = Manifest.GetProperty("serviceId").GetUInt16(),
                    ProcedureId = procedure.GetProperty("procedureId").GetUInt16(),
                    ProcedureName = procedureName,
                    ServiceRevision = Manifest.GetProperty("serviceRevision").GetInt32(),
                };
            }
        }

        throw new ArgumentException($"the interop service has no procedure {procedureName}", nameof(procedureName));
    }

    // definition

    /// <summary>
    /// Registers the interop service's resolvers on <paramref name="server"/>. The calls to
    /// <c>slow</c> each connection cancelled are counted per connection, for
    /// <c>cancellations</c> to answer; a session holds the name its <c>login</c> gave, which
    /// <c>whoami</c> answers from its call's session. A connection
    /// registers itself as a destination of the server's relay by <c>register</c>; the destination
    /// it registered last is kept by its handle, once it closed too, for <c>unregister</c> to take
    /// out.
    /// </summary>
    public static void Offer(Server<string> server)
    {
        ArgumentNullException.ThrowIfNull(server);

        Offer(server.Services, (server.Sessions, server.RequireSession, server.Router));
    }

    /// <summary>
    /// As <see cref="Offer(Server{string})"/>, on services, and sessions and the router whose relay
    /// takes the destinations, given apart.
    /// </summary>
    public static void Offer(ServiceManager services, (SessionManager<string> Sessions, BeforeRequest RequireSession, RouterServer Router) server)
    {
        ArgumentNullException.ThrowIfNull(services);

        var (sessionManager, requireSession, router) = server;

        ArgumentNullException.ThrowIfNull(router);

        var cancellations = new ConcurrentDictionary<string, int>();
        var holds = new Dictionary<string, List<Hold>>();

        // by connection, the destination it registered last: kept once it closed, so whoever
        // connects under its handle next takes it out
        var registered = new Dictionary<string, DestinationRegistration>();

        var dependencies = new RequestResolverDependencies<JsonElement, JsonElement> { Serializer = Json };
        var clock = services.GetCommand(ProcedureOf("clock"), new RequestDependencies<JsonElement, JsonElement> { Serializer = JsonAsked });

        // held, it subscribes its requester first, then answers once its ticks notified
        var ticks = services.GetNotificationResolver(
            ProcedureOf("ticks"),
            new NotificationResolverDependencies<JsonElement, JsonElement, JsonElement> { Serializer = JsonNotified })(async (request, response) =>
            {
                var isObject = request.Payload.ValueKind == JsonValueKind.Object;
                var hold = isObject && request.Payload.TryGetProperty("hold", out var held) ? held.GetInt32() : 0;
                var fail = isObject && request.Payload.TryGetProperty("fail", out var failing) && failing.ValueKind == JsonValueKind.True;

                if (hold < 1)
                {
                    await response.Answer(Null);

                    return;
                }

                await response.RegisterNotification();

                var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var answered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

                lock (holds)
                {
                    if (!holds.TryGetValue(request.ConnectionHandle, out var connectionHolds))
                    {
                        connectionHolds = [];
                        holds[request.ConnectionHandle] = connectionHolds;
                    }

                    connectionHolds.Add(new Hold(
                        () =>
                        {
                            released.TrySetResult();

                            return answered.Task;
                        },
                        hold));
                }

                await released.Task;

                try
                {
                    await (fail ? response.Fail(Failure.OfApplication(7, "this procedure fails, on purpose")) : response.Answer(Null));
                }
                finally
                {
                    answered.TrySetResult();
                }
            });

        // notifies its own connection, then lets the ticks it was the last for answer, before it does
        services.GetRequestResolver(ProcedureOf("tick"), dependencies)(async (request, response) =>
        {
            var connectionHandle = request.ConnectionHandle;
            var key = request.Payload.TryGetProperty("key", out var given) ? given.GetString() : null;
            var due = new List<Hold>();

            await ticks.Notify(
                request.Payload.GetProperty("value"),
                new NotifyOptions
                {
                    Filter = (handle) =>
                    {
                        return handle == connectionHandle;
                    },
                    Key = key,
                });

            lock (holds)
            {
                foreach (var held in holds.GetValueOrDefault(connectionHandle) ?? [])
                {
                    held.Remaining -= 1;

                    if (held.Remaining == 0)
                    {
                        due.Add(held);
                    }
                }

                holds.GetValueOrDefault(connectionHandle)?.RemoveAll((held) =>
                {
                    return held.Remaining == 0;
                });
            }

            await Task.WhenAll(due.Select((held) =>
            {
                return held.Release();
            }));
            await response.Answer(Null);
        });

        // a new session each time, as the one it replaces ends: its token is drawn anew, whatever its
        // call presents. A timeout not given is left out, for the sessions' default, without end
        services.GetRequestResolver(ProcedureOf("login"), dependencies)((request, response) =>
        {
            var name = request.Payload.GetProperty("name").GetString();

            sessionManager.Set(sessionManager.Create(request.ConnectionHandle) with
            {
                ConnectionInactivityTimeout = DurationOf(request.Payload, "connectionTimeout"),
                Data = name,
                SessionInactivityTimeout = DurationOf(request.Payload, "sessionTimeout"),
            });

            return response.Answer(JsonSerializer.SerializeToElement(name));
        });

        // ended before it answers, so its answer — or the failure ending a subscription — announces it.
        // A call in a credential's session is refused ACCESS_DENIED, never SESSION_REQUIRED, which
        // would have its client withdraw a credential that holds
        services.GetRequestResolver(ProcedureOf("logout"), dependencies with { BeforeRequest = requireSession })((request, response) =>
        {
            if (request.Header.Credential?.Scheme is CredentialScheme.Jwt or CredentialScheme.Elsewhere)
            {
                return response.Fail(Failure.OfProtocol(ProtocolCode.AccessDenied, "logout ends its connection's session, which this call does not run in"));
            }

            sessionManager.Delete(request.ConnectionHandle);

            return response.Answer(Null);
        });

        // the name its call's session holds, which may be another than its connection's holds now
        services.GetRequestResolver(ProcedureOf("whoami"), dependencies with { BeforeRequest = requireSession })((request, response) =>
        {
            return response.Answer(JsonSerializer.SerializeToElement(request.Session?.Data as string));
        });

        // the server asks its client back, by a command, before it answers
        services.GetRequestResolver(ProcedureOf("ask"), dependencies)(async (request, response) =>
        {
            var time = await clock(JsonSerializer.SerializeToElement(Question))(new RequestOptions
            {
                ConnectionHandle = request.ConnectionHandle,
                Timeout = ClockTimeout,
            });

            await response.Answer(time);
        });

        services.GetRequestResolver(ProcedureOf("echo"), dependencies)((request, response) =>
        {
            return response.Answer(request.Payload);
        });

        services.GetRequestResolver(ProcedureOf("fail"), dependencies)((_, response) =>
        {
            return response.Fail(Failure.OfApplication(7, "this procedure fails, on purpose"));
        });

        // cancelled first, it answers all the same, an answer its router must not send; it waits on
        // its server's clock
        services.GetRequestResolver(ProcedureOf("slow"), dependencies)(async (request, response) =>
        {
            var milliseconds = request.Payload.GetProperty("milliseconds").GetInt64();

            try
            {
                await Task.Delay(TimeSpan.FromMilliseconds(milliseconds), router.Clock, request.Signal);
            }
            catch (OperationCanceledException)
            {
                cancellations.AddOrUpdate(
                    request.ConnectionHandle,
                    1,
                    (_, count) =>
                    {
                        return count + 1;
                    });
            }

            await response.Answer(JsonSerializer.SerializeToElement(milliseconds));
        });

        services.GetRequestResolver(ProcedureOf("cancellations"), dependencies)((request, response) =>
        {
            return response.Answer(JsonSerializer.SerializeToElement(cancellations.GetValueOrDefault(request.ConnectionHandle)));
        });

        services.GetRequestResolver(
            ProcedureOf("denied"),
            dependencies with
            {
                BeforeRequest = new BeforeRequest(
                    (_) =>
                    {
                        return false;
                    },
                    Failure.OfProtocol(ProtocolCode.AccessDenied, "this procedure admits nobody")),
            })((_, response) =>
            {
                return response.Answer(JsonSerializer.SerializeToElement<object?>(null));
            });

        services.GetRequestResolver(ProcedureOf("broken"), dependencies)((_, _) =>
        {
            throw new InvalidOperationException("this procedure breaks, on purpose");
        });

        services.GetRequestResolver(ProcedureOf("bytes"), dependencies)((request, response) =>
        {
            var length = request.Payload.GetProperty("length").GetInt32();

            return response.Answer(JsonSerializer.SerializeToElement(new string('x', length)));
        });

        // its caller's connection, as the destination it names; looked up and registered under one
        // lock, so two registers of one destination cannot both pass
        services.GetRequestResolver(ProcedureOf("register"), dependencies)((request, response) =>
        {
            var destinationId = request.Payload.GetProperty("destination").GetUInt32();
            var timeout = DurationOf(request.Payload, "timeout");
            bool isTaken;

            lock (registered)
            {
                isTaken = router.Destinations().Any((destination) =>
                {
                    return destination.DestinationId == destinationId;
                });

                if (!isTaken)
                {
                    registered[request.ConnectionHandle] = router.RegisterDestination(
                        new ConnectionTarget(request.ConnectionHandle),
                        new DestinationOptions { DestinationId = destinationId, Timeout = timeout });
                }
            }

            if (isTaken)
            {
                return response.Fail(Failure.OfApplication(8, "that destination is registered already"));
            }

            return response.Answer(JsonSerializer.SerializeToElement(destinationId));
        });

        // the destination its caller's handle registered last, taken out and forgotten
        services.GetRequestResolver(ProcedureOf("unregister"), dependencies)((request, response) =>
        {
            bool isTakenOut;

            lock (registered)
            {
                isTakenOut = registered.Remove(request.ConnectionHandle, out var registration) && registration.Unregister();
            }

            return response.Answer(JsonSerializer.SerializeToElement(isTakenOut));
        });
    }

    /// <summary>Registers what a client of the interop service offers its server: the <c>clock</c> command.</summary>
    public static void OfferClient(ServiceManager services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.GetCommandResolver(
            ProcedureOf("clock"),
            new RequestResolverDependencies<JsonElement, JsonElement> { Serializer = Json })((_, response) =>
            {
                return response.Answer(JsonSerializer.SerializeToElement("noon"));
            });
    }

    private static JsonElement Null
    {
        get
        {
            return JsonSerializer.SerializeToElement<object?>(null);
        }
    }

    // a duration a payload gives, in milliseconds, held as spec 1.4 holds one given: rounded, and
    // refused under a millisecond or past 2³¹ − 1, as given, by a throw its server answers with
    // PROCEDURE_FAILED; none when not given. JSON writes no never, so -1, .NET's, is refused too
    private static TimeSpan? DurationOf(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var given))
        {
            return null;
        }

        return Clocks.AssertHeldFinite((name, name), TimeSpan.FromMilliseconds(given.GetDouble()));
    }

    // a ticks answer held: the ticks it waits for still, and what lets it answer, then says it did
    private sealed class Hold(Func<Task> release, int remaining)
    {
        public int Remaining { get; set; } = remaining;

        public Task Release()
        {
            return release();
        }
    }

    // JSON, in UTF-8, written without a space, either way
    private sealed class JsonPayloads : INotificationSerializerServer<JsonElement, JsonElement, JsonElement>, IRequestSerializerClient<JsonElement, JsonElement>
    {
        public JsonElement Decode(ReadOnlyMemory<byte> request)
        {
            using var document = JsonDocument.Parse(request);

            return document.RootElement.Clone();
        }

        public ReadOnlyMemory<byte> Encode(JsonElement response)
        {
            return JsonSerializer.SerializeToUtf8Bytes(response);
        }

        public ReadOnlyMemory<byte> EncodeNotification(JsonElement notification)
        {
            return JsonSerializer.SerializeToUtf8Bytes(notification);
        }
    }
}
