using System.Collections.Concurrent;
using System.Text.Json;

namespace Bead.Interop;

/// <summary>
/// The resolvers of Bead's interop service, its API <c>spec/interop-blueprint.json</c>, generated
/// into <c>Generated/InteropBead.cs</c>, and its behaviour <c>spec/interop-service.json</c>, as the
/// C# side answers them: what a client of any implementation calls, and what
/// <c>spec/conversations.json</c> plays against. Only the resolvers and the hook are written here.
/// </summary>
public static class InteropHandlers
{
    // constants

    // the question ask puts to its client's clock, and how long it waits for the answer
    private const string Question = "What time is it where you are?";

    private static readonly TimeSpan ClockTimeout = TimeSpan.FromSeconds(10);

    // helpers

    private static JsonElement Null
    {
        get
        {
            return JsonSerializer.SerializeToElement<object?>(null);
        }
    }

    // the name a call's session holds: the one login gave its connection's session, or the sub of
    // its credential's data, a JWT's claims set or what the ELSEWHERE verifier gave
    private static string? NameOf(CallSession? session)
    {
        return session?.Data switch
        {
            string name => name,
            JsonElement { ValueKind: JsonValueKind.Object } data when data.TryGetProperty("sub", out var sub) && sub.ValueKind == JsonValueKind.String => sub.GetString(),
            _ => null,
        };
    }

    // a credential's session's identifier, as endSession takes it: an object of these members alone,
    // each a string — {"issuer","sub"} or {"issuer","sid"}, a JWT's; {"id"}, an ELSEWHERE's
    private static SessionIdentifier IdentifierOf(JsonElement request)
    {
        var members = request.ValueKind == JsonValueKind.Object
            ? request.EnumerateObject().ToDictionary(
                (member) =>
                {
                    return member.Name;
                },
                (member) =>
                {
                    return member.Value;
                },
                StringComparer.Ordinal)
            : [];

        if (members.Values.Any((value) =>
        {
            return value.ValueKind != JsonValueKind.String;
        }))
        {
            throw new ArgumentException("endSession names a credential's session by strings alone", nameof(request));
        }

        string StringOf(string name)
        {
            return members[name].GetString()!;
        }

        return members.Keys.Order(StringComparer.Ordinal).ToList() switch
        {
            ["issuer", "sub"] => new SessionIdentifier { Scheme = CredentialScheme.Jwt, Issuer = StringOf("issuer"), Sub = StringOf("sub") },
            ["issuer", "sid"] => new SessionIdentifier { Scheme = CredentialScheme.Jwt, Issuer = StringOf("issuer"), Sid = StringOf("sid") },
            ["id"] => new SessionIdentifier { Scheme = CredentialScheme.Elsewhere, Id = StringOf("id") },
            _ => throw new ArgumentException("endSession names a credential's session by {issuer, sub}, {issuer, sid} or {id}", nameof(request)),
        };
    }

    // the issuer endSessionsOf takes: an object of this member alone, a string — {"issuer"}
    internal static string IssuerOf(JsonElement request)
    {
        if (request.ValueKind != JsonValueKind.Object
            || request.EnumerateObject().Count() != 1
            || !request.TryGetProperty("issuer", out var issuer)
            || issuer.ValueKind != JsonValueKind.String)
        {
            throw new ArgumentException("endSessionsOf names an issuer by {issuer}, a string, alone", nameof(request));
        }

        return issuer.GetString()!;
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

    // definition

    /// <summary>
    /// The interop service, served on <paramref name="server"/>, its resolvers registered and
    /// offered there. The calls to <c>slow</c> each connection cancelled are counted per
    /// connection, for <c>cancellations</c> to answer; a session holds the name its <c>login</c>
    /// gave, which <c>whoami</c> answers from its call's session, as it answers a credential's
    /// <c>sub</c>; the ticks of <c>ticks</c> and <c>tick</c> are held per connection and per
    /// session, its call's. A connection registers itself as a destination of the server's relay by
    /// <c>register</c>, with the audience it verifies; the destination it registered last is kept
    /// by its handle, once it closed too, for <c>unregister</c> to take out. <c>endSession</c> ends
    /// a credential's session on every connection that keeps it, and nothing else;
    /// <c>endSessionsOf</c>, every credential's session of an issuer alike. One service a server:
    /// the counts are its connections'.
    /// </summary>
    public static InteropServer<string> Offer(IBeadServer<string> server)
    {
        ArgumentNullException.ThrowIfNull(server);

        var sessionManager = server.Sessions;
        var router = server.Router;
        var interop = new InteropServer<string>(new ServiceServerOptions<InteropProcedures>
        {
            Admissions = new InteropAdmissions
            {
                Nobody = new AdmissionHook
                {
                    Admits = (_) =>
                    {
                        return false;
                    },
                    Detail = "this procedure admits nobody",
                },
            },
        });
        var cancellations = new ConcurrentDictionary<string, int>();

        // by connection and session, its call's — none for its connection's — the ticks held
        var holds = new Dictionary<(string ConnectionHandle, SessionIdentifier? Session), List<Hold>>();

        // by connection, the destination it registered last: kept once it closed, so whoever
        // connects under its handle next takes it out
        var registered = new Dictionary<string, DestinationRegistration>();

        interop.On(InteropProcedures.Echo, (request, response) =>
        {
            return response.Answer(request.Payload);
        });

        interop.On(InteropProcedures.Fail, (_, response) =>
        {
            return response.Fail(InteropFailures.Fail.OnPurpose, "this procedure fails, on purpose");
        });

        // cancelled first, it answers all the same, an answer its router must not send; it waits on
        // its server's clock
        interop.On(InteropProcedures.Slow, async (request, response) =>
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

        interop.On(InteropProcedures.Cancellations, (request, response) =>
        {
            return response.Answer(JsonSerializer.SerializeToElement(cancellations.GetValueOrDefault(request.ConnectionHandle)));
        });

        // its hook admits nobody: the resolver is never reached
        interop.On(InteropProcedures.Denied, (_, response) =>
        {
            return response.Answer(Null);
        });

        interop.On(InteropProcedures.Broken, (_, _) =>
        {
            throw new InvalidOperationException("this procedure breaks, on purpose");
        });

        interop.On(InteropProcedures.Bytes, (request, response) =>
        {
            var length = request.Payload.GetProperty("length").GetInt32();

            return response.Answer(JsonSerializer.SerializeToElement(new string('x', length)));
        });

        // the server asks its client back, by a command, before it answers
        interop.On(InteropProcedures.Ask, async (request, response) =>
        {
            var time = await interop.Command.Clock(JsonSerializer.SerializeToElement(Question))(new RequestOptions
            {
                ConnectionHandle = request.ConnectionHandle,
                Timeout = ClockTimeout,
            });

            await response.Answer(time);
        });

        // held, it subscribes its requester first, then answers once its ticks notified
        interop.On(InteropProcedures.Ticks, async (request, response) =>
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
                var place = (request.ConnectionHandle, request.Session?.Identifier);

                if (!holds.TryGetValue(place, out var connectionHolds))
                {
                    connectionHolds = [];
                    holds[place] = connectionHolds;
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
                await (fail ? response.Fail(InteropFailures.Ticks.OnPurpose, "this procedure fails, on purpose") : response.Answer(Null));
            }
            finally
            {
                answered.TrySetResult();
            }
        });

        // notifies the subscription its call's session holds on its own connection, then lets the
        // ticks of that session it was the last for answer, before it does
        interop.On(InteropProcedures.Tick, async (request, response) =>
        {
            var connectionHandle = request.ConnectionHandle;
            var session = request.Session?.Identifier;
            var key = request.Payload.TryGetProperty("key", out var given) ? given.GetString() : null;
            var due = new List<Hold>();

            await interop.Notify.Ticks(
                request.Payload.GetProperty("value"),
                new NotifyOptions
                {
                    Filter = (subscriber) =>
                    {
                        return subscriber.ConnectionHandle == connectionHandle && subscriber.Identifier == session;
                    },
                    Key = key,
                });

            lock (holds)
            {
                foreach (var held in holds.GetValueOrDefault((connectionHandle, session)) ?? [])
                {
                    held.Remaining -= 1;

                    if (held.Remaining == 0)
                    {
                        due.Add(held);
                    }
                }

                holds.GetValueOrDefault((connectionHandle, session))?.RemoveAll((held) =>
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
        interop.On(InteropProcedures.Login, (request, response) =>
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
        interop.On(InteropProcedures.Logout, (request, response) =>
        {
            if (request.Session?.Identifier is not null)
            {
                return response.Fail(AdmissionFailure.AccessDenied("a call in a credential's session ends no connection's session"));
            }

            sessionManager.Delete(request.ConnectionHandle);

            return response.Answer(Null);
        });

        // the name its call's session holds, which may be another than its connection's holds now
        interop.On(InteropProcedures.Whoami, (request, response) =>
        {
            return response.Answer(JsonSerializer.SerializeToElement(NameOf(request.Session)));
        });

        // its caller's connection, as the destination it names; looked up and registered under one
        // lock, so two registers of one destination cannot both pass
        interop.On(InteropProcedures.Register, (request, response) =>
        {
            var destinationId = request.Payload.GetProperty("destination").GetUInt32();
            var timeout = DurationOf(request.Payload, "timeout");
            var audience = request.Payload.TryGetProperty("audience", out var verified) ? verified.GetString() : null;
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
                        new DestinationOptions { Audience = audience, DestinationId = destinationId, Timeout = timeout });
                }
            }

            if (isTaken)
            {
                return response.Fail(InteropFailures.Register.RegisteredAlready, "that destination is registered already");
            }

            return response.Answer(JsonSerializer.SerializeToElement(destinationId));
        });

        // the destination its caller's handle registered last, taken out and forgotten
        interop.On(InteropProcedures.Unregister, (request, response) =>
        {
            bool isTakenOut;

            lock (registered)
            {
                isTakenOut = registered.Remove(request.ConnectionHandle, out var registration) && registration.Unregister();
            }

            return response.Answer(JsonSerializer.SerializeToElement(isTakenOut));
        });

        // a credential's session ended by its identifier, on every connection that keeps it, and
        // nothing else: a credential that still holds opens it anew
        interop.On(InteropProcedures.EndSession, async (request, response) =>
        {
            await router.EndSession(IdentifierOf(request.Payload));
            await response.Answer(Null);
        });

        // every credential's session of an issuer ended by that issuer, on every connection that
        // keeps one, and nothing else: a credential that still holds opens its session anew
        interop.On(InteropProcedures.EndSessionsOf, async (request, response) =>
        {
            await router.EndSessionsOf(IssuerOf(request.Payload));
            await response.Answer(Null);
        });

        interop.Offer(server);

        return interop;
    }

    /// <summary>What a client of the interop service answers its server: the <c>clock</c> command, <c>"noon"</c>.</summary>
    public static void OfferClient(InteropClient interop)
    {
        ArgumentNullException.ThrowIfNull(interop);

        interop.On(InteropProcedures.Clock, (_, response) =>
        {
            return response.Answer(JsonSerializer.SerializeToElement("noon"));
        });
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
}
