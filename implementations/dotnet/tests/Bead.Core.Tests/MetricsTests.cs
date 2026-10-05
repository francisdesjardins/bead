using System.Globalization;
using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// Bead's metrics, <c>spec/metrics.json</c>: each exposition, a registry played on its own through
/// what its routers count with, written byte for byte; and each exit, a conversation of the interop
/// service's server given a registry, the series each of its steps moved. The TypeScript side plays
/// the same file.
/// </summary>
public sealed class MetricsTests
{
    // constants

    private static readonly JsonElement Root = Load();

    // where every exit's wall clock starts: the conversations'
    private static readonly DateTimeOffset WallClock = DateTimeOffset.Parse(Root.GetProperty("wallClock").GetString()!, CultureInfo.InvariantCulture);

    // helpers

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "metrics.json")));

        return document.RootElement.Clone();
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

    private static TheoryData<string> NamesOf(string group)
    {
        return new TheoryData<string>(Root.GetProperty(group).EnumerateArray().Select((entry) =>
        {
            return entry.GetProperty("name").GetString()!;
        }));
    }

    // a code as a label writes it, as the failure a router would end with: section 8's by its name,
    // application a procedure's own, _OTHER a code section 8 names none of
    internal static Failure FailureOf(string code)
    {
        return code switch
        {
            "application" => Failure.OfApplication(7),
            "_OTHER" => new Failure { Code = 99, Scope = FailureScope.Protocol },
            _ => Failure.OfProtocol(Enum.Parse<ProtocolCode>(string.Concat(code.Split('_').Select((word) =>
            {
                return word[..1] + word[1..].ToLowerInvariant();
            })))),
        };
    }

    // what a count says a call ended with: its outcome, and its failure's code under failure
    private static (CallOutcome Outcome, Failure? Failure) EndingOf(JsonElement count)
    {
        var outcome = count.GetProperty("outcome").GetString() switch
        {
            "result" => CallOutcome.Result,
            "failure" => CallOutcome.Failure,
            "timeout" => CallOutcome.Timeout,
            "cancelled" => CallOutcome.Cancelled,
            "closed" => CallOutcome.Closed,
            "error" => CallOutcome.Error,
            var other => throw new ArgumentException($"a count ends with an outcome no test reads: {other}", nameof(count)),
        };

        return (outcome, count.TryGetProperty("code", out var code) ? FailureOf(code.GetString()!) : null);
    }

    private static ProcedureAddress? AddressOf(JsonElement entry)
    {
        return entry.TryGetProperty("serviceId", out var serviceId)
            ? new ProcedureAddress(serviceId.GetUInt16(), entry.GetProperty("procedureId").GetUInt16())
            : null;
    }

    // the lines an exposition writes, each ended by a line feed
    internal static string TextOf(JsonElement lines)
    {
        return string.Concat(lines.EnumerateArray().Select((line) =>
        {
            return $"{line.GetString()}\n";
        }));
    }

    /// <summary>
    /// What a registry counted, for a twin to read: each line of a count, a <c>_count</c>, or the
    /// bucket of 0, that is not 0; a bucket of another bound and a <c>_sum</c> left out.
    /// </summary>
    internal static List<string> CountsOf(MetricsRegistry registry)
    {
        return [.. registry.Exposition().Text.Split('\n', StringSplitOptions.RemoveEmptyEntries).Where((line) =>
        {
            return !line.StartsWith('#')
                && !line.EndsWith(" 0", StringComparison.Ordinal)
                && !line.Contains("_sum{", StringComparison.Ordinal)
                && (!line.Contains("_bucket{", StringComparison.Ordinal) || line.Contains("le=\"0.0\"", StringComparison.Ordinal));
        })];
    }

    // definition

    /// <summary>The names of every exposition.</summary>
    public static TheoryData<string> Expositions { get; } = NamesOf("expositions");

    [Theory]
    [MemberData(nameof(Expositions))]
    public void Writes_each_exposition_byte_for_byte(string name)
    {
        var entry = EntryOf(("expositions", name));
        var registry = new MetricsRegistry(entry.TryGetProperty("maximumProcedures", out var maximum)
            ? new MetricsRegistryOptions { MaximumProcedures = maximum.GetInt32() }
            : null);

        // each router given the registry, in order, making its _OTHER series
        var routers = entry.GetProperty("routers").EnumerateArray().Select((side) =>
        {
            return registry.Give(side.GetString() == "client" ? RouterSide.Client : RouterSide.Server);
        }).ToList();

        // what each declaration gave, by its router and its address, as a router holds it
        var resolvers = new Dictionary<(int Router, ProcedureAddress Address), ResolverSeries>();
        var requesters = new Dictionary<(int Router, ProcedureAddress Address), CallSeries>();
        var notifications = new Dictionary<(int Router, ProcedureAddress Address), HearingSeries>();

        foreach (var declaration in entry.GetProperty("declarations").EnumerateArray())
        {
            var router = declaration.GetProperty("router").GetInt32();
            var procedure = new Procedure
            {
                ServiceId = declaration.GetProperty("serviceId").GetUInt16(),
                ProcedureId = declaration.GetProperty("procedureId").GetUInt16(),
                ProcedureName = declaration.GetProperty("procedureName").GetString()!,
                ServiceRevision = 1,
            };
            var key = (router, procedure.Address);

            void Declare()
            {
                switch (declaration.GetProperty("as").GetString())
                {
                    case "resolver":
                        resolvers[key] = routers[router].DeclareResolver(
                            procedure,
                            declaration.TryGetProperty("notifies", out var notifies) && notifies.GetBoolean());
                        break;
                    case "requester":
                        requesters[key] = routers[router].DeclareRequester(procedure);
                        break;
                    default:
                        notifications[key] = routers[router].DeclareNotification(procedure);
                        break;
                }
            }

            if (declaration.TryGetProperty("refused", out var refused))
            {
                // the reason is the sentence's own words; the sentence stays with the twins
                Assert.Contains(refused.GetString()!, Assert.Throws<ArgumentException>(Declare).Message, StringComparison.Ordinal);

                continue;
            }

            Declare();
        }

        foreach (var count in entry.GetProperty("counts").EnumerateArray())
        {
            var router = count.GetProperty("router").GetInt32();
            var address = AddressOf(count);

            if (count.TryGetProperty("call", out var call))
            {
                var series = call.GetString() == "answered"
                    ? address is { } answered ? resolvers[(router, answered)].Calls : routers[router].Answered
                    : address is { } made ? requesters[(router, made)] : routers[router].Made;

                series.Start();

                if (count.TryGetProperty("outcome", out _))
                {
                    series.End(EndingOf(count), count.GetProperty("microseconds").GetInt64());
                }

                continue;
            }

            var key = (router, address!.Value);
            var dropping = count.TryGetProperty("code", out var code) ? FailureOf(code.GetString()!) : null;

            if (count.TryGetProperty("notification", out var notification))
            {
                switch (notification.GetString())
                {
                    case "sent":
                        resolvers[key].Notifying!.Sent();
                        break;
                    case "failed":
                        resolvers[key].Notifying!.Failed();
                        break;
                    default:
                        notifications[key].Heard();
                        break;
                }

                continue;
            }

            if (count.GetProperty("dropped").GetString() == "notifies")
            {
                resolvers[key].Notifying!.Dropped.Drop(dropping);
            }
            else
            {
                notifications[key].Dropped.Drop(dropping);
            }
        }

        var exposition = registry.Exposition();

        Assert.Equal(Root.GetProperty("mediaType").GetString(), exposition.ContentType);
        Assert.Equal(TextOf(entry.GetProperty("exposition")), exposition.Text);
    }

    /// <summary>The names of every exit.</summary>
    public static TheoryData<string> Exits { get; } = NamesOf("exits");

    [Theory]
    [MemberData(nameof(Exits))]
    public async Task Counts_each_exit_of_the_interop_server_at_its_gates(string name)
    {
        await ConversationPlayer.Play(EntryOf(("exits", name)), new PlayerOptions { MetricsRegistry = new MetricsRegistry(), WallClock = WallClock });
    }
}
