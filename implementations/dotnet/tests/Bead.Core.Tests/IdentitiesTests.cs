using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// Bead's identities, <c>spec/identities.json</c>, played whole (decision 0017): each entry of
/// <c>names</c> and <c>ids</c> declared each of the five ways a side declares, on routers of its
/// own given no metrics registry, taken, or refused for the reason it names, which the refusal's
/// sentence holds, the router then taking a declaration as if it had not been made; and each pair
/// of <c>folds</c> through <see cref="Identity.AreOneName"/>, which every comparison of names on
/// this side goes through. An entry a row of the support matrix excuses this side from, an id or a
/// revision no C# type holds, is counted and not played. The TypeScript side plays the same file.
/// </summary>
public sealed class IdentitiesTests
{
    // constants

    // the language a differs names to excuse this side
    private const string Language = "C#";

    private static readonly JsonElement Root = Load();

    // what a refused declaration leaves the router able to take: the procedure every ids entry is
    // named under, at the address every names entry is declared at
    private static readonly Procedure Echo = new() { ServiceId = 1, ProcedureId = 1, ProcedureName = "echo", ServiceRevision = 1 };

    // each way the file names, by its id, and what declares a procedure that way on a client's
    // router and a server's, each of its own
    private static readonly Dictionary<string, Func<Procedure, (RouterClient Client, RouterServer Server), Task>> Ways = new(StringComparer.Ordinal)
    {
        ["client-resolver"] = (procedure, routers) =>
        {
            routers.Client.RegisterResolver(new Resolver(procedure));

            return Task.CompletedTask;
        },
        ["server-resolver"] = (procedure, routers) =>
        {
            routers.Server.RegisterResolver(new Resolver(procedure));

            return Task.CompletedTask;
        },
        ["client-requester"] = (procedure, routers) =>
        {
            routers.Client.DeclareRequester(procedure);

            return Task.CompletedTask;
        },
        ["server-requester"] = (procedure, routers) =>
        {
            routers.Server.DeclareRequester(procedure);

            return Task.CompletedTask;
        },
        ["client-notification"] = (procedure, routers) =>
        {
            return routers.Client.RegisterNotification(new Heard(procedure));
        },
    };

    // helpers

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "identities.json")));

        return document.RootElement.Clone();
    }

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    // whether an entry's differs names this side
    private static bool IsExcused(JsonElement entry)
    {
        return entry.TryGetProperty("differs", out var differs) && differs.EnumerateArray().Any((difference) =>
        {
            return difference.GetProperty("language").GetString() == Language;
        });
    }

    private static JsonElement EntryOf((string Group, string Name) entry)
    {
        foreach (var each in Root.GetProperty(entry.Group).EnumerateArray())
        {
            if (each.GetProperty("name").GetString() == entry.Name)
            {
                return each;
            }
        }

        throw new KeyNotFoundException($"no {entry.Group} entry \"{entry.Name}\"");
    }

    // the names of a group's entries this side plays
    private static TheoryData<string> PlayedOf(string group)
    {
        return new TheoryData<string>(Root.GetProperty(group).EnumerateArray().Where((entry) =>
        {
            return !IsExcused(entry);
        }).Select((entry) =>
        {
            return entry.GetProperty("name").GetString()!;
        }));
    }

    // an entry's ids and revision as this side's types hold them: none for a value they cannot hold
    private static (ushort? ServiceId, ushort? ProcedureId, int? ServiceRevision) IdsOf(JsonElement entry)
    {
        static ushort? IdOf(JsonElement value)
        {
            return value.ValueKind == JsonValueKind.Number && value.TryGetUInt16(out var id) ? id : null;
        }

        var revision = entry.GetProperty("serviceRevision");

        return (
            IdOf(entry.GetProperty("serviceId")),
            IdOf(entry.GetProperty("procedureId")),
            revision.ValueKind == JsonValueKind.Number && revision.TryGetInt32(out var held) ? held : null);
    }

    // declares a procedure each way, each on routers of its own: taken, or refused for its reason,
    // and then declaring nothing, the same way taking Echo
    private static async Task PlaysEachWay(Procedure procedure, string? refused)
    {
        foreach (var way in Root.GetProperty("ways").EnumerateArray())
        {
            var declare = Ways[way.GetString()!];

            using var client = new RouterClient(new UnconnectedClient());
            using var server = new RouterServer(new UnconnectedServer());

            if (refused is null)
            {
                await declare(procedure, (client, server)).WaitAsync(Cancelled);

                continue;
            }

            var refusal = await Assert.ThrowsAsync<ArgumentException>(() =>
            {
                return declare(procedure, (client, server));
            });

            Assert.Contains(refused, refusal.Message, StringComparison.Ordinal);
            await declare(Echo, (client, server)).WaitAsync(Cancelled);
        }
    }

    private static string? RefusedOf(JsonElement entry)
    {
        return entry.TryGetProperty("refused", out var refused) ? refused.GetString() : null;
    }

    // definition

    /// <summary>The names of every entry of <c>names</c>, which no row excuses this side from.</summary>
    public static TheoryData<string> Names { get; } = PlayedOf("names");

    /// <summary>The names of every entry of <c>ids</c> this side plays.</summary>
    public static TheoryData<string> Ids { get; } = PlayedOf("ids");

    /// <summary>The names of every entry of <c>folds</c>.</summary>
    public static TheoryData<string> Folds { get; } = PlayedOf("folds");

    [Theory]
    [MemberData(nameof(Names))]
    public Task Declares_each_name_each_way_taken_or_refused_off_its_form_declaring_nothing(string name)
    {
        var entry = EntryOf(("names", name));

        return PlaysEachWay(Echo with { ProcedureName = entry.GetProperty("procedureName").GetString()! }, RefusedOf(entry));
    }

    [Theory]
    [MemberData(nameof(Ids))]
    public Task Declares_each_address_and_revision_each_way_taken_or_refused_out_of_its_range_before_off_its_form(string name)
    {
        var entry = EntryOf(("ids", name));
        var (serviceId, procedureId, serviceRevision) = IdsOf(entry);
        var procedure = new Procedure
        {
            ServiceId = serviceId!.Value,
            ProcedureId = procedureId!.Value,
            ProcedureName = entry.TryGetProperty("procedureName", out var procedureName) ? procedureName.GetString()! : Echo.ProcedureName,
            ServiceRevision = serviceRevision!.Value,
        };

        return PlaysEachWay(procedure, RefusedOf(entry));
    }

    [Theory]
    [MemberData(nameof(Folds))]
    public void Reads_two_names_as_one_when_they_are_equal_but_for_the_case_of_their_ASCII_letters(string name)
    {
        var entry = EntryOf(("folds", name));
        var names = entry.GetProperty("names");

        Assert.Equal(
            entry.GetProperty("one").GetBoolean(),
            Identity.AreOneName(names[0].GetString()!, names[1].GetString()!));
    }

    [Fact]
    public void Its_table_declares_every_way_the_file_names_and_no_other()
    {
        Assert.Equal(
            Root.GetProperty("ways").EnumerateArray().Select((way) =>
            {
                return way.GetString()!;
            }).Order(StringComparer.Ordinal),
            Ways.Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Plays_every_entry_but_those_holding_an_id_or_a_revision_no_C_sharp_type_holds_each_excused_by_its_row()
    {
        // * excused exactly where this side cannot be given the input: a ushort holds 0 to 65535, an
        // int −2³¹ to 2³¹ − 1, and neither a fraction, a string, a boolean or null
        var excused = new List<string>();

        foreach (var entry in Root.GetProperty("ids").EnumerateArray())
        {
            var (serviceId, procedureId, serviceRevision) = IdsOf(entry);
            var isHeld = serviceId is not null && procedureId is not null && serviceRevision is not null;

            Assert.Equal(!isHeld, IsExcused(entry));

            if (!isHeld)
            {
                excused.Add(entry.GetProperty("name").GetString()!);
            }
        }

        Assert.Equal(17, excused.Count);
        Assert.DoesNotContain(Root.GetProperty("names").EnumerateArray(), IsExcused);
        Assert.DoesNotContain(Root.GetProperty("folds").EnumerateArray(), IsExcused);
        Assert.Contains("revision -1", Ids.Select((row) =>
        {
            return row.Data;
        }));
    }

    // a resolver of a procedure, which no call reaches
    private sealed class Resolver(Procedure procedure) : IRequestResolver
    {
        public Procedure Procedure { get; } = procedure;

        public int? MaximumPayloadBytes
        {
            get
            {
                return null;
            }
        }

        public Failure? Admit(AdmissionRequest request)
        {
            return null;
        }

        public Task Handle(RequestResolverProps props)
        {
            return Task.CompletedTask;
        }
    }

    // a notification of a procedure, which nothing triggers
    private sealed class Heard(Procedure procedure) : INotificationLike
    {
        public Procedure Procedure { get; } = procedure;

        public int? Window
        {
            get
            {
                return null;
            }
        }

        public Task<IReadOnlyList<Exception>> Trigger(ReadOnlyMemory<byte> payload)
        {
            return Task.FromResult<IReadOnlyList<Exception>>([]);
        }

        public void Drop(Failure? failure)
        {
        }
    }

    // a client's transport that never connects
    private sealed class UnconnectedClient : IRouterClientTransport
    {
        public TimeProvider Clock
        {
            get
            {
                return TimeProvider.System;
            }
        }

        public event Action<TransportMessage>? Message
        {
            add
            {
            }

            remove
            {
            }
        }

        public event Action<bool, bool>? Close
        {
            add
            {
            }

            remove
            {
            }
        }

        public Task Send(TransportMessage message)
        {
            return Task.CompletedTask;
        }
    }

    // a server's transport whose connections never open
    private sealed class UnconnectedServer : IRouterServerTransport
    {
        public TimeProvider Clock
        {
            get
            {
                return TimeProvider.System;
            }
        }

        public event Action<string>? Connection
        {
            add
            {
            }

            remove
            {
            }
        }

        public event Action<TransportMessage, string>? Message
        {
            add
            {
            }

            remove
            {
            }
        }

        public event Action<bool, string>? Close
        {
            add
            {
            }

            remove
            {
            }
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            return Task.CompletedTask;
        }
    }
}
