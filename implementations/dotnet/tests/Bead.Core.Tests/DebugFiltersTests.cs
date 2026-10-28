using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// Bead's debug filters, <c>spec/debug-filters.json</c>: what each filter reads as and which calls
/// and envelopes it keeps, or why it is refused, and what a filter given as a function does from
/// event to event. The TypeScript side plays the same file.
/// </summary>
// debugging 1.1
public sealed class DebugFiltersTests
{
    // constants

    private static readonly JsonElement Root = Load();

    // the first words of each refusal's sentence, this side's own, by the reason it gives; the value
    // or the word it names follows, quoted as JSON
    private static readonly (string Words, string Reason)[] Refusals =
    [
        ("a debug filter's selector names a value, not ", "selector empty"),
        ("a debug filter's selector leaves no value empty, not ", "value empty"),
        ("a debug filter takes a direction among rx, tx, not ", "names nothing"),
        ("a debug filter takes a type among request, command, notification, r, c, n, not ", "names nothing"),
        ("a debug filter takes a kind among request, result, failure, notification, chunk, credit, cancel, not ", "names nothing"),
        ("a debug filter holds a parenthesis in a selector alone, d(…), t(…) or e(…), not ", "holds a parenthesis"),
    ];

    // helpers

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "debug-filters.json")));

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

    private static List<string> StringsOf(JsonElement strings)
    {
        return [.. strings.EnumerateArray().Select((each) =>
        {
            return each.GetString()!;
        })];
    }

    private static List<int> IndicesOf(JsonElement indices)
    {
        return [.. indices.EnumerateArray().Select((each) =>
        {
            return each.GetInt32();
        })];
    }

    private static DebugDirection DirectionOf(JsonElement fixture)
    {
        return fixture.GetProperty("direction").GetString() == "rx" ? DebugDirection.Rx : DebugDirection.Tx;
    }

    // a call's fixture, as a trace's event tells it
    private static DebugEvent CallOf(JsonElement fixture)
    {
        return new DebugEvent
        {
            Direction = DirectionOf(fixture),
            ProcedureId = 1,
            ProcedureName = fixture.GetProperty("procedureName").GetString()!,
            ServiceId = 1,
            ServiceRevision = 1,
            StartedAt = DateTimeOffset.UnixEpoch,
            Type = fixture.GetProperty("type").GetString() switch
            {
                "request" => DebugType.Request,
                "command" => DebugType.Command,
                _ => DebugType.Notification,
            },
        };
    }

    // an envelope's fixture, as a router's trace tells it: a header of its kind
    private static (DebugDirection Direction, TracedEnvelope Envelope) EnvelopeOf(JsonElement fixture)
    {
        IEnvelopeHeader header = fixture.GetProperty("kind").GetString() switch
        {
            "request" => new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1 },
            "result" => new ResultHeader { CallId = 1 },
            "failure" => new FailureHeader { CallId = 1 },
            "notification" => new NotificationHeader { CallId = 1 },
            "chunk" => new ChunkHeader { CallId = 1, IsLast = true, Offset = 0 },
            "credit" => new CreditHeader { CallId = 1, CreditEnd = 1 },
            _ => new CancelHeader { CallId = 1 },
        };

        return (DirectionOf(fixture), new TracedEnvelope("connection", header));
    }

    // the reason of a refusal, and what it names as written, read back from this side's sentence
    private static (string Reason, string Written) RefusalOf(ArgumentException refused)
    {
        foreach (var (words, reason) in Refusals)
        {
            if (refused.Message.StartsWith(words, StringComparison.Ordinal))
            {
                return (reason, JsonSerializer.Deserialize<string>(refused.Message[words.Length..])!);
            }
        }

        throw new ArgumentException($"a refusal no test reads: {refused.Message}", nameof(refused));
    }

    // the indices of the calls a call's listener given `filter` hears, and of the envelopes an
    // envelope's listener hears
    private static (List<int> Calls, List<int> Envelopes) KeptBy(string filter)
    {
        var calls = new List<int>();
        var envelopes = new List<int>();
        var heard = -1;
        var call = DebugFilters.FilterDebug(
            (_, _) =>
            {
                calls.Add(heard);
            },
            filter);
        var envelope = DebugFilters.FilterEnvelopeDebug(
            (_, _) =>
            {
                envelopes.Add(heard);
            },
            filter);

        for (var index = 0; index < Root.GetProperty("calls").GetArrayLength(); index += 1)
        {
            heard = index;
            call(null, CallOf(Root.GetProperty("calls")[index]));
        }

        for (var index = 0; index < Root.GetProperty("envelopes").GetArrayLength(); index += 1)
        {
            var (direction, traced) = EnvelopeOf(Root.GetProperty("envelopes")[index]);

            heard = index;
            envelope(direction, traced);
        }

        return (calls, envelopes);
    }

    // definition

    /// <summary>The names of every filter.</summary>
    public static TheoryData<string> Filters { get; } = NamesOf("filters");

    /// <summary>The names of every filter given as a function.</summary>
    public static TheoryData<string> Sources { get; } = NamesOf("sources");

    [Theory]
    [MemberData(nameof(Filters))]
    public void Reads_each_filter_and_keeps_what_it_keeps_or_refuses_it_naming_what_was_written(string name)
    {
        var entry = EntryOf(("filters", name));
        var filter = entry.GetProperty("filter").GetString()!;

        if (entry.TryGetProperty("refused", out var refused))
        {
            Assert.Equal(
                (refused.GetProperty("reason").GetString(), refused.GetProperty("written").GetString()),
                RefusalOf(Assert.Throws<ArgumentException>(() =>
                {
                    return DebugFilter.Parse(filter);
                })));

            // refused as a listener's filter too, as it is made
            Assert.Throws<ArgumentException>(() =>
            {
                return DebugFilters.FilterDebug(
                    (_, _) =>
                    {
                    },
                    filter);
            });

            return;
        }

        var parsed = DebugFilter.Parse(filter);
        var expected = entry.GetProperty("parsed");

        // the five lists, kinds and types by the grammar's names, in lower case
        Assert.Equal(
            StringsOf(expected.GetProperty("directions")),
            parsed.Directions.Select((direction) =>
            {
                return direction == DebugDirection.Rx ? "rx" : "tx";
            }));
        Assert.Equal(
            StringsOf(expected.GetProperty("types")),
            parsed.Types.Select((type) =>
            {
                return type.ToString().ToLowerInvariant();
            }));
        Assert.Equal(
            StringsOf(expected.GetProperty("kinds")),
            parsed.Kinds.Select((kind) =>
            {
                return kind.ToString().ToLowerInvariant();
            }));
        Assert.Equal(StringsOf(expected.GetProperty("include")), parsed.Include);
        Assert.Equal(StringsOf(expected.GetProperty("exclude")), parsed.Exclude);

        var keeps = entry.GetProperty("keeps");
        var (calls, envelopes) = KeptBy(filter);

        Assert.Equal(IndicesOf(keeps.GetProperty("calls")), calls);
        Assert.Equal(IndicesOf(keeps.GetProperty("envelopes")), envelopes);
    }

    [Theory]
    [MemberData(nameof(Sources))]
    public void Asks_a_filter_given_as_a_function_at_each_event_and_keeps_the_last_that_held(string name)
    {
        var entry = EntryOf(("sources", name));
        var isCall = entry.GetProperty("listener").GetString() == "call";

        // the function's state, which the steps move
        string? given = null;
        var throws = false;
        var heard = false;

        string? Source()
        {
            return throws ? throw new InvalidOperationException("this filter's function fails, on purpose") : given;
        }

        Action<int>? listener = null;

        foreach (var step in entry.GetProperty("steps").EnumerateArray())
        {
            if (step.TryGetProperty("gives", out var gives))
            {
                given = gives.GetString();
                throws = false;
            }
            else if (step.TryGetProperty("throws", out _))
            {
                throws = true;
            }
            else if (step.TryGetProperty("made", out var made))
            {
                void Make()
                {
                    if (isCall)
                    {
                        var call = DebugFilters.FilterDebug(
                            (_, _) =>
                            {
                                heard = true;
                            },
                            Source);

                        listener = (index) =>
                        {
                            call(null, CallOf(Root.GetProperty("calls")[index]));
                        };

                        return;
                    }

                    var envelope = DebugFilters.FilterEnvelopeDebug(
                        (_, _) =>
                        {
                            heard = true;
                        },
                        Source);

                    listener = (index) =>
                    {
                        var (direction, traced) = EnvelopeOf(Root.GetProperty("envelopes")[index]);

                        envelope(direction, traced);
                    };
                }

                if (made.GetBoolean())
                {
                    Make();
                }
                else
                {
                    // the first filter that does not hold, or a function that throws, makes none
                    Assert.ThrowsAny<Exception>(Make);
                    Assert.Null(listener);
                }
            }
            else
            {
                heard = false;
                listener!(step.GetProperty("event").GetInt32());
                Assert.Equal(step.GetProperty("heard").GetBoolean(), heard);
            }
        }
    }
}
