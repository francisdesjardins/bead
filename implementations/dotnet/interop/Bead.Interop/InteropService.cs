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
    /// <c>cancellations</c> to answer; a session holds the name its <c>login</c> gave.
    /// </summary>
    public static void Offer(Server<string> server)
    {
        ArgumentNullException.ThrowIfNull(server);

        Offer(server.Services, (server.Sessions, server.RequireSession));
    }

    /// <summary>As <see cref="Offer(Server{string})"/>, on services and sessions given apart.</summary>
    public static void Offer(ServiceManager services, (SessionManager<string> Sessions, BeforeRequest RequireSession) sessions)
    {
        ArgumentNullException.ThrowIfNull(services);

        var (sessionManager, requireSession) = sessions;

        var cancellations = new ConcurrentDictionary<string, int>();
        var holds = new Dictionary<string, List<Hold>>();
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

        // a new session each time, as the one it replaces ends: its token is drawn anew
        services.GetRequestResolver(ProcedureOf("login"), dependencies)((request, response) =>
        {
            var name = request.Payload.GetProperty("name").GetString();

            sessionManager.Set(sessionManager.Create(request.ConnectionHandle) with { Data = name });

            return response.Answer(JsonSerializer.SerializeToElement(name));
        });

        // ended before it answers, so its answer — or the failure ending a subscription — announces it
        services.GetRequestResolver(ProcedureOf("logout"), dependencies with { BeforeRequest = requireSession })((request, response) =>
        {
            sessionManager.Delete(request.ConnectionHandle);

            return response.Answer(Null);
        });

        services.GetRequestResolver(ProcedureOf("whoami"), dependencies with { BeforeRequest = requireSession })((request, response) =>
        {
            return response.Answer(JsonSerializer.SerializeToElement(sessionManager.Get(request.ConnectionHandle)?.Data));
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

        // cancelled first, it answers all the same, an answer its router must not send
        services.GetRequestResolver(ProcedureOf("slow"), dependencies)(async (request, response) =>
        {
            var milliseconds = request.Payload.GetProperty("milliseconds").GetInt64();

            try
            {
                await Task.Delay(TimeSpan.FromMilliseconds(milliseconds), request.Signal);
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
