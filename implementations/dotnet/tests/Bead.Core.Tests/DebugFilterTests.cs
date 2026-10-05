namespace Bead.Tests;

/// <summary>
/// <see cref="DebugFilter"/> and <see cref="DebugFilters"/>: a spec read, the calls and the envelopes
/// a listener then hears, and a filter a function gives at each event.
/// </summary>
public sealed class DebugFilterTests
{
    // constants

    private static readonly DebugEvent[] Events =
    [
        EventOf("getStatus"),
        EventOf("getStatus", (DebugDirection.Rx, DebugType.Request)),
        EventOf("GetTime", (DebugDirection.Rx, DebugType.Request)),
        EventOf("ping", (DebugDirection.Tx, DebugType.Command)),
        EventOf("news", (DebugDirection.Rx, DebugType.Notification)),
    ];

    private static readonly (DebugDirection Direction, TracedEnvelope Envelope)[] Envelopes =
    [
        EnvelopeOf(new RequestHeader { CallId = 3, ServiceId = 2, ProcedureId = 1 }, DebugDirection.Tx),
        EnvelopeOf(new ResultHeader { CallId = 3 }, DebugDirection.Rx),
        EnvelopeOf(new FailureHeader { CallId = 3 }, DebugDirection.Rx),
        EnvelopeOf(new CancelHeader { CallId = 3 }, DebugDirection.Tx),
    ];

    private static readonly Action<Exception?, DebugEvent> Unheard = (_, _) =>
    {
    };

    private static readonly Action<DebugDirection, TracedEnvelope> UnheardEnvelope = (_, _) =>
    {
    };

    // helpers

    // a debug event of a procedure's, going a direction, of a type
    private static DebugEvent EventOf(string procedureName, (DebugDirection Direction, DebugType Type)? step = null)
    {
        return new DebugEvent
        {
            Direction = step?.Direction ?? DebugDirection.Tx,
            ProcedureId = 1,
            ProcedureName = procedureName,
            ServiceId = 2,
            ServiceRevision = 1,
            StartedAt = DateTimeOffset.UnixEpoch,
            Type = step?.Type ?? DebugType.Request,
        };
    }

    private static (DebugDirection, TracedEnvelope) EnvelopeOf(IEnvelopeHeader header, DebugDirection direction)
    {
        return (direction, new TracedEnvelope("a", header));
    }

    // what a listener the filter made hears of the events given: each one's name, direction and type
    private static List<string> HeardOf(Func<Action<Exception?, DebugEvent>, Action<Exception?, DebugEvent>> filtered, DebugEvent[] events)
    {
        var heard = new List<string>();
        var listener = filtered((_, debugEvent) =>
        {
            heard.Add($"{debugEvent.ProcedureName} {Lowered(debugEvent.Direction)} {Lowered(debugEvent.Type)}");
        });

        foreach (var debugEvent in events)
        {
            listener(null, debugEvent);
        }

        return heard;
    }

    private static List<string> HeardOf(string spec, DebugEvent[] events)
    {
        return HeardOf(
            (listener) =>
            {
                return DebugFilters.FilterDebug(listener, spec);
            },
            events);
    }

    // what a listener the filter made hears of the envelopes above: each one's kind and direction
    private static List<string> EnvelopesHeardOf(Func<Action<DebugDirection, TracedEnvelope>, Action<DebugDirection, TracedEnvelope>> filtered)
    {
        var heard = new List<string>();
        var listener = filtered((direction, envelope) =>
        {
            heard.Add($"{(int)envelope.Header.Kind} {Lowered(direction)}");
        });

        foreach (var (direction, envelope) in Envelopes)
        {
            listener(direction, envelope);
        }

        return heard;
    }

    private static List<string> EnvelopesHeardOf(string spec)
    {
        return EnvelopesHeardOf((listener) =>
        {
            return DebugFilters.FilterEnvelopeDebug(listener, spec);
        });
    }

    private static string Lowered<TValue>(TValue value)
        where TValue : struct, Enum
    {
        return value.ToString().ToLowerInvariant();
    }

    // definition

    [Fact]
    public void Reads_words_parted_by_commas_or_white_space_selectors_names_to_keep_names_to_leave_out()
    {
        var filter = DebugFilter.Parse(" d(rx),t(r|C)  get*, -getStatus\tping ");

        Assert.Equal(
            new DebugFilter
            {
                Directions = [DebugDirection.Rx],
                Exclude = ["getStatus"],
                Include = ["get*", "ping"],
                Types = [DebugType.Request, DebugType.Command],
            },
            filter);
        Assert.Equal(new DebugFilter(), DebugFilter.Parse(""));
    }

    [Fact]
    public void Names_a_kind_as_its_constant_does_however_it_is_written()
    {
        Assert.Equal(
            [EnvelopeKind.Request, EnvelopeKind.Failure, EnvelopeKind.Cancel],
            DebugFilter.Parse("e(request|FAILURE), E(cancel)").Kinds);

        foreach (var spec in new[] { "e(r)", "e(chunks)", "e(constructor)", "e()" })
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return DebugFilter.Parse(spec);
            });
        }
    }

    [Fact]
    public void Keeps_every_direction_and_every_type_its_selectors_name_however_many_there_are()
    {
        var filter = DebugFilter.Parse("d(rx), D(tx), t(n), t(c)");

        Assert.Equal([DebugDirection.Rx, DebugDirection.Tx], filter.Directions);
        Assert.Equal([DebugType.Notification, DebugType.Command], filter.Types);
    }

    [Fact]
    public void Refuses_a_direction_or_a_type_that_is_not_one_and_a_selector_that_names_none()
    {
        foreach (var spec in new[] { "d(up)", "t(p)", "t(n|r|x)", "t(constructor)", "d()", "t()" })
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return DebugFilter.Parse(spec);
            });
        }

        Assert.Equal([DebugType.Request, DebugType.Request], DebugFilter.Parse("t(request|R)").Types);
    }

    [Fact]
    public void Refuses_a_filter_in_sentences_that_name_the_word_or_the_value_as_it_was_written_quoted_as_JSON()
    {
        string RefusalOf(string spec)
        {
            return Assert.Throws<ArgumentException>(() =>
            {
                return DebugFilter.Parse(spec);
            }).Message;
        }

        Assert.Equal("a debug filter's selector names a value, not \"E()\"", RefusalOf("ping E()"));
        Assert.Equal("a debug filter's selector leaves no value empty, not \"d(rx|)\"", RefusalOf("d(rx|)"));
        Assert.Equal("a debug filter takes a direction among rx, tx, not \"UP\"", RefusalOf("d(UP)"));
        Assert.Equal("a debug filter takes a type among request, command, notification, r, c, n, not \"r\\\\n\"", RefusalOf("t(r\\n)"));
        Assert.Equal(
            "a debug filter takes a kind among request, result, failure, notification, chunk, credit, cancel, not \"\\\"fail\\\"\"",
            RefusalOf("e(\"fail\")"));
        Assert.Equal("a debug filter holds a parenthesis in a selector alone, d(…), t(…) or e(…), not \"d(rx\"", RefusalOf("d(rx,tx)"));

        // a control character and a lone surrogate escaped as JSON.stringify writes them
        Assert.Equal("a debug filter takes a direction among rx, tx, not \"a\\u0001\\ud800\"", RefusalOf("d(a\u0001\ud800)"));
    }

    [Fact]
    public void Refuses_a_filter_given_whole_in_the_grammar_s_names_as_it_is_made()
    {
        string RefusalOf(DebugFilter filter)
        {
            return Assert.Throws<ArgumentException>(() =>
            {
                return DebugFilters.FilterEnvelopeDebug(UnheardEnvelope, filter);
            }).Message;
        }

        Assert.Equal("a debug filter takes a direction among rx, tx, not \"7\"", RefusalOf(new DebugFilter { Directions = [(DebugDirection)7] }));
        Assert.Equal(
            "a debug filter takes a kind among request, result, failure, notification, chunk, credit, cancel, not \"9\"",
            RefusalOf(new DebugFilter { Kinds = [(EnvelopeKind)9] }));
        Assert.Equal(
            "a debug filter takes a type among request, command, notification, not \"5\"",
            Assert.Throws<ArgumentException>(() =>
            {
                return DebugFilters.FilterDebug(Unheard, new DebugFilter { Types = [(DebugType)5] });
            }).Message);
    }

    [Fact]
    public void Two_filters_of_the_same_lists_are_equal_whatever_lists_hold_them()
    {
        var filter = new DebugFilter { Directions = new List<DebugDirection> { DebugDirection.Rx }, Include = ["get*"] };
        var alike = new DebugFilter { Directions = [DebugDirection.Rx], Include = new List<string> { "get*" } };

        Assert.Equal(filter, alike);
        Assert.Equal(filter.GetHashCode(), alike.GetHashCode());
        Assert.NotEqual(new DebugFilter { Include = ["get*"] }, new DebugFilter { Exclude = ["get*"] });
        Assert.False(new DebugFilter().Equals(null));
    }

    [Fact]
    public void Keeps_every_event_without_a_filter_or_with_an_empty_one()
    {
        Assert.Equal(Events.Length, HeardOf("", Events).Count);
        Assert.Equal(Events.Length, HeardOf(
            (listener) =>
            {
                return DebugFilters.FilterDebug(listener, new DebugFilter());
            },
            Events).Count);
        Assert.Equal(Events.Length, HeardOf(
            (listener) =>
            {
                return DebugFilters.FilterDebug(listener, () =>
                {
                    return (string?)null;
                });
            },
            Events).Count);
    }

    [Fact]
    public void Keeps_a_direction_a_type_and_the_names_that_match_without_regard_to_case()
    {
        Assert.Equal(["getStatus rx request", "GetTime rx request", "news rx notification"], HeardOf("d(rx)", Events));
        Assert.Equal(["ping tx command", "news rx notification"], HeardOf("t(c|n)", Events));
        Assert.Equal(["getStatus tx request", "getStatus rx request", "GetTime rx request"], HeardOf("get*", Events));
        Assert.Equal(["getStatus rx request", "GetTime rx request"], HeardOf("d(rx), get*", Events));
    }

    [Fact]
    public void Leaves_out_what_an_exclusion_names_which_wins_over_what_is_kept()
    {
        Assert.Equal(["GetTime rx request", "ping tx command", "news rx notification"], HeardOf("-getStatus", Events));
        Assert.Equal(["GetTime rx request"], HeardOf("get*, -getstatus", Events));
    }

    [Fact]
    public void Matches_a_whole_name_and_takes_every_other_character_literally()
    {
        DebugEvent[] names = [EventOf("get+status"), EventOf("a.b"), EventOf("axb"), EventOf("getStatusNow")];

        Assert.Equal(["get+status tx request"], HeardOf("get+status", names));
        Assert.Equal(["a.b tx request"], HeardOf("a.b", names));
        Assert.Empty(HeardOf("getStatus, a+b, [x], ^a", names));

        // neither its start nor its end alone
        Assert.Empty(HeardOf("status, getStatu", [EventOf("getStatus")]));
    }

    [Fact]
    public void Takes_a_filter_as_it_is_its_values_checked_once_as_it_is_given()
    {
        Assert.Equal(
            ["getStatus tx request"],
            HeardOf(
                (listener) =>
                {
                    return DebugFilters.FilterDebug(listener, new DebugFilter { Directions = [DebugDirection.Tx], Exclude = ["p*"] });
                },
                Events));
        Assert.Throws<ArgumentException>(() =>
        {
            return DebugFilters.FilterDebug(Unheard, new DebugFilter { Types = [(DebugType)9] });
        });
    }

    [Fact]
    public void Refuses_as_it_is_made_a_first_filter_that_does_not_hold()
    {
        Assert.Throws<ArgumentException>(() =>
        {
            return DebugFilters.FilterDebug(Unheard, "d(up)");
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return DebugFilters.FilterDebug(Unheard, () =>
            {
                return "t(x)";
            });
        });
    }

    [Fact]
    public void Asks_a_function_at_each_event_and_keeps_the_last_filter_that_held_when_one_does_not()
    {
        string[] specs = ["d(rx)", "d(rx)", "d(up)", "d(tx)"];
        var asked = 0;
        var heard = new List<DebugDirection>();
        var listener = DebugFilters.FilterDebug(
            (_, debugEvent) =>
            {
                heard.Add(debugEvent.Direction);
            },
            () =>
            {
                var spec = specs[Math.Min(asked, specs.Length - 1)];

                asked += 1;

                return asked == 4 ? throw new InvalidOperationException("no spec") : spec;
            });

        // asked once as it is made, then at each event
        foreach (var direction in new[] { DebugDirection.Rx, DebugDirection.Tx, DebugDirection.Rx, DebugDirection.Tx, DebugDirection.Tx })
        {
            listener(null, EventOf("echo", (direction, DebugType.Request)));
        }

        Assert.Equal(6, asked);

        // d(rx); d(rx) kept though d(up) does not hold; d(rx) kept though the function threw; d(tx)
        Assert.Equal([DebugDirection.Rx, DebugDirection.Rx, DebugDirection.Tx, DebugDirection.Tx], heard);
    }

    [Fact]
    public void Takes_a_function_that_gives_filters_as_they_are_and_a_filter_given_anew_alike_as_the_same()
    {
        var asked = 0;
        var heard = HeardOf(
            (listener) =>
            {
                return DebugFilters.FilterDebug(listener, () =>
                {
                    asked += 1;

                    // a new filter each time: of the same lists, asked as it is made and at the first two
                    // events; another at the last two
                    return asked < 4 ? new DebugFilter { Directions = [DebugDirection.Rx] } : new DebugFilter { Directions = [DebugDirection.Tx] };
                });
            },
            [
                EventOf("echo", (DebugDirection.Rx, DebugType.Request)),
                EventOf("echo"),
                EventOf("echo", (DebugDirection.Rx, DebugType.Request)),
                EventOf("echo"),
            ]);

        Assert.Equal(["echo rx request", "echo tx request"], heard);
    }

    [Fact]
    public void Passes_the_error_and_the_event_on_as_they_came()
    {
        var failure = new InvalidOperationException("failed");
        var debugEvent = EventOf("echo");
        var heard = new List<object?>();

        DebugFilters.FilterDebug(
            (error, told) =>
            {
                heard.Add(error);
                heard.Add(told);
            },
            "echo")(failure, debugEvent);

        Assert.Equal<object?>([failure, debugEvent], heard);
    }

    [Fact]
    public void An_envelope_listener_keeps_a_direction_and_the_kinds_named_and_every_envelope_without_a_filter()
    {
        Assert.Equal(Envelopes.Length, EnvelopesHeardOf("").Count);
        Assert.Equal(["17 rx", "18 rx"], EnvelopesHeardOf("d(rx)"));
        Assert.Equal(["16 tx", "22 tx"], EnvelopesHeardOf("e(request|cancel)"));
        Assert.Equal(["18 rx"], EnvelopesHeardOf((listener) =>
        {
            return DebugFilters.FilterEnvelopeDebug(listener, new DebugFilter { Directions = [DebugDirection.Rx], Kinds = [EnvelopeKind.Failure] });
        }));
        Assert.Equal(["16 tx", "22 tx"], EnvelopesHeardOf((listener) =>
        {
            return DebugFilters.FilterEnvelopeDebug(listener, () =>
            {
                return new DebugFilter { Directions = [DebugDirection.Tx] };
            });
        }));
    }

    [Fact]
    public void An_envelope_listener_serves_the_same_spec_as_the_calls_the_names_and_the_types_of_calls_are_not_asked()
    {
        var events = new List<string>();
        var spec = "d(rx), t(r), e(failure), getStatus";

        DebugFilters.FilterDebug(
            (_, debugEvent) =>
            {
                events.Add(debugEvent.ProcedureName);
            },
            spec)(null, EventOf("getStatus", (DebugDirection.Rx, DebugType.Request)));

        Assert.Equal(["getStatus"], events);
        Assert.Equal(["18 rx"], EnvelopesHeardOf(spec));
        Assert.Equal(Envelopes.Length, EnvelopesHeardOf("-*, t(c)").Count);
    }

    [Fact]
    public void An_envelope_listener_refuses_a_first_filter_that_does_not_hold_and_keeps_the_last_that_held_after()
    {
        string[] specs = ["e(result)", "e(result)", "e(nothing)", "e(cancel)"];
        var asked = 0;

        Assert.Throws<ArgumentException>(() =>
        {
            return DebugFilters.FilterEnvelopeDebug(UnheardEnvelope, "e(nothing)");
        });
        Assert.Throws<ArgumentException>(() =>
        {
            return DebugFilters.FilterEnvelopeDebug(UnheardEnvelope, new DebugFilter { Kinds = [(EnvelopeKind)0x99] });
        });

        var heard = new List<int>();
        var listener = DebugFilters.FilterEnvelopeDebug(
            (_, envelope) =>
            {
                heard.Add((int)envelope.Header.Kind);
            },
            () =>
            {
                var spec = specs[Math.Min(asked, specs.Length - 1)];

                asked += 1;

                return spec;
            });

        // e(result) twice; e(nothing) does not hold, so e(result) stays for the result; then e(cancel)
        foreach (var (direction, envelope) in Envelopes.Concat(Envelopes))
        {
            listener(direction, envelope);
        }

        Assert.Equal([17, 22, 22], heard);
    }
}
