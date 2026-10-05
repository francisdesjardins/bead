using System.Globalization;
using System.Text;

namespace Bead;

/// <summary>How a metrics registry is built.</summary>
public sealed record MetricsRegistryOptions
{
    /// <summary>
    /// The procedures each group of its families names at most — its client families, its server
    /// families, its notification families — above 0; 1,000 when none is said. A declaration that
    /// would name one more is an <see cref="ArgumentException"/>, as it is made; <c>_OTHER</c>'s
    /// series count against none.
    /// </summary>
    public int MaximumProcedures { get; init; } = 1_000;
}

/// <summary>What a registry writes: its media type, and its text.</summary>
/// <param name="ContentType">
/// The media type of the Prometheus text format 0.0.4, which a scrape is served with:
/// <c>text/plain; version=0.0.4; charset=utf-8</c>.
/// </param>
/// <param name="Text">Its families, each line ended by a line feed; empty for a registry that holds no series.</param>
public sealed record MetricsExposition(string ContentType, string Text);

/// <summary>
/// The series of a requester's calls, which its router's <c>DeclareRequester</c> gives back as the
/// requester is made, and which each of its calls carries to its router's request as
/// <see cref="RouterRequest.Series"/>: a call reaches its series through it, with no lookup. A router
/// given no registry gives none.
/// </summary>
public sealed class ProcedureSeries
{
    internal ProcedureSeries(CallSeries calls)
    {
        Calls = calls;
    }

    /// <summary>Its calls, in the client families.</summary>
    internal CallSeries Calls { get; }
}

/// <summary>
/// What a side counts of its calls and its notifications, beside the wire (spec/debugging.md,
/// sections 7 to 12): a router given one counts at its gates, and one given to two routers sums
/// them. It holds the series of what its routers declare, made at 0 as each is declared, and its
/// routers' <c>_OTHER</c> series, made as it is given to each; a count never makes a series. It
/// writes them in the Prometheus text format 0.0.4, as <see cref="Exposition"/> gives them, for an
/// application to serve where it likes: Bead opens no port. Counted from any thread, with no lock.
/// </summary>
public sealed class MetricsRegistry
{
    // constants

    private const string MediaType = "text/plain; version=0.0.4; charset=utf-8";

    // the label a value a series does not know is written as, for its service and its procedure
    private const string Other = "_OTHER";

    // what a lone surrogate is written as: U+FFFD, REPLACEMENT CHARACTER
    private const char Replacement = (char)0xFFFD;

    // the families, in the order of their names, each with its type and its help (8.1)
    private const string ClientDuration = "bead_client_call_duration_seconds";
    private const string ClientHandled = "bead_client_call_handled_total";
    private const string ClientStarted = "bead_client_call_started_total";
    private const string Heard = "bead_notifications_heard_total";
    private const string Sent = "bead_notifications_sent_total";
    private const string ServerDuration = "bead_server_call_duration_seconds";
    private const string ServerHandled = "bead_server_call_handled_total";
    private const string ServerStarted = "bead_server_call_started_total";
    private const string Dropped = "bead_subscriptions_dropped_total";

    private static readonly Dictionary<string, (string Type, string Help)> Families = new(StringComparer.Ordinal)
    {
        [ClientDuration] = ("histogram", "How long each call this side made took, from its start to its end, in seconds."),
        [ClientHandled] = ("counter", "Each call this side made, as it ended, by its outcome."),
        [ClientStarted] = ("counter", "Each call this side made, as its router took it."),
        [Heard] = ("counter", "Each notification heard under a subscription this side holds."),
        [Sent] = ("counter", "Each notification for one subscription, handed to its transport or not."),
        [ServerDuration] = ("histogram", "How long each call this side answered took, from its arrival to its end, in seconds."),
        [ServerHandled] = ("counter", "Each call this side answered, as it ended, by its outcome."),
        [ServerStarted] = ("counter", "Each call this side answered, as its request opened it."),
        [Dropped] = ("counter", "Each subscription ended other than by its client's cancel, at this end."),
    };

    // the declarations, and the series they made, kept under one lock: declared from any thread
    private readonly Lock _gate = new();
    private readonly int _maximumProcedures;

    // the one name each address is held under
    private readonly Dictionary<ProcedureAddress, string> _names = [];

    // the one revision each service is held at
    private readonly Dictionary<ushort, int> _revisions = [];

    // the addresses each group of families names, for its ceiling (7.4)
    private readonly HashSet<ProcedureAddress> _client = [];
    private readonly HashSet<ProcedureAddress> _server = [];
    private readonly HashSet<ProcedureAddress> _notification = [];

    // the series made: of calls by role, address — none for _OTHER — and type; of notifications by
    // address
    private readonly Dictionary<(CallRole Role, ProcedureAddress? Address, bool IsCommand), CallSeries> _calls = [];
    private readonly Dictionary<ProcedureAddress, NotifyingSeries> _notifying = [];
    private readonly Dictionary<ProcedureAddress, HearingSeries> _hearing = [];
    private readonly Dictionary<ProcedureAddress, DroppedSeries> _dropped = [];

    /// <summary>
    /// A registry, with its options: a ceiling not above 0 is an <see cref="ArgumentException"/>.
    /// </summary>
    public MetricsRegistry(MetricsRegistryOptions? options = null)
    {
        var maximumProcedures = (options ?? new MetricsRegistryOptions()).MaximumProcedures;

        if (maximumProcedures < 1)
        {
            throw new ArgumentException(
                $"{nameof(MetricsRegistryOptions.MaximumProcedures)} is a whole number above 0, not {maximumProcedures}",
                nameof(options));
        }

        _maximumProcedures = maximumProcedures;
    }

    // helpers

    // a call's type, by its role and its router's side (8.2): a client's router makes requests and
    // answers commands, a server's the reverse
    private static bool IsCommand(CallRole role, RouterSide side)
    {
        return (role == CallRole.Client) != (side == RouterSide.Client);
    }

    // a label's value as 0.0.4 writes it (12.4): a backslash, a quote and a line feed escaped, and a
    // lone surrogate written U+FFFD, as spec 7.4 writes a detail
    private static string Escaped(string value)
    {
        var written = new StringBuilder(value.Length);

        for (var index = 0; index < value.Length; index += 1)
        {
            var character = value[index];

            if (char.IsHighSurrogate(character) && index + 1 < value.Length && char.IsLowSurrogate(value[index + 1]))
            {
                written.Append(character).Append(value[index + 1]);
                index += 1;

                continue;
            }

            if (character is '\\' or '"')
            {
                written.Append('\\').Append(character);
            }
            else if (character == '\n')
            {
                written.Append("\\n");
            }
            else
            {
                written.Append(char.IsSurrogate(character) ? Replacement : character);
            }
        }

        return written.ToString();
    }

    // a help as 0.0.4 writes it: a backslash and a line feed escaped
    private static string HelpOf(string help)
    {
        return help.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\n", "\\n", StringComparison.Ordinal);
    }

    // a _sum, from its whole microseconds (12.5): its whole seconds, then, when microseconds remain,
    // a point and their six digits less their trailing zeros; never an exponent
    private static string SecondsOf(long microseconds)
    {
        var whole = (microseconds / 1_000_000).ToString(CultureInfo.InvariantCulture);
        var under = microseconds % 1_000_000;

        return under == 0 ? whole : $"{whole}.{under.ToString("D6", CultureInfo.InvariantCulture).TrimEnd('0')}";
    }

    private static string CountOf(long count)
    {
        return count.ToString(CultureInfo.InvariantCulture);
    }

    // the order of series within a family (12.3): by service id, then procedure id, as numbers,
    // _OTHER last
    private static (bool IsOther, int ServiceId, int ProcedureId) OrderOf(ProcedureAddress? address)
    {
        return address is { } held ? (false, held.ServiceId, held.ProcedureId) : (true, 0, 0);
    }

    // a procedure's labels as a series writes them first: its service's id in decimal, its name
    private string LabelsOf(ProcedureAddress? address)
    {
        return address is { } held
            ? string.Create(CultureInfo.InvariantCulture, $"service=\"{held.ServiceId}\",procedure=\"{Escaped(_names[held])}\"")
            : $"service=\"{Other}\",procedure=\"{Other}\"";
    }

    // a declaration of a procedure to some groups of families, or its refusal (7.3): an address held
    // under another name, compared exactly; a name its service holds at another address, the two
    // one by spec 16.6; a service held at another revision; or one procedure past a group's
    // ceiling. Under the lock; a declaration refused declares nothing
    private void Declare(Procedure procedure, HashSet<ProcedureAddress>[] groups)
    {
        var address = procedure.Address;
        var name = procedure.ProcedureName;
        var revision = procedure.ServiceRevision;

        if (_names.TryGetValue(address, out var held) && !string.Equals(held, name, StringComparison.Ordinal))
        {
            throw new ArgumentException(
                string.Create(CultureInfo.InvariantCulture, $"a metrics registry holds {address.ServiceId}/{address.ProcedureId} as \"{held}\": \"{name}\" is another name at its address"),
                nameof(procedure));
        }

        foreach (var (other, otherName) in _names)
        {
            if (other.ServiceId == address.ServiceId && other != address && Identity.AreOneName(otherName, name))
            {
                throw new ArgumentException(
                    string.Create(CultureInfo.InvariantCulture, $"a metrics registry holds \"{otherName}\" at {other.ServiceId}/{other.ProcedureId}: \"{name}\" at {address.ServiceId}/{address.ProcedureId} is its name at another address"),
                    nameof(procedure));
            }
        }

        if (_revisions.TryGetValue(address.ServiceId, out var heldRevision) && heldRevision != revision)
        {
            throw new ArgumentException(
                string.Create(CultureInfo.InvariantCulture, $"a metrics registry holds service {address.ServiceId} at revision {heldRevision}: \"{name}\" at {address.ServiceId}/{address.ProcedureId}, revision {revision}, is another revision of its service"),
                nameof(procedure));
        }

        foreach (var group in groups)
        {
            if (!group.Contains(address) && group.Count >= _maximumProcedures)
            {
                throw new ArgumentException(
                    string.Create(CultureInfo.InvariantCulture, $"a metrics registry's families name {_maximumProcedures} procedures at most: \"{name}\" at {address.ServiceId}/{address.ProcedureId} is past the ceiling"),
                    nameof(procedure));
            }
        }

        _names[address] = name;
        _revisions[address.ServiceId] = revision;

        foreach (var group in groups)
        {
            group.Add(address);
        }
    }

    // a procedure's subscriptions dropped, made at none and the codes given; under the lock
    private DroppedSeries DroppedOf(ProcedureAddress address, int[] codes)
    {
        if (!_dropped.TryGetValue(address, out var dropped))
        {
            dropped = new DroppedSeries(LabelsOf(address));
            _dropped[address] = dropped;
        }

        dropped.Make(codes);

        return dropped;
    }

    // definition

    /// <summary>
    /// Writes every series, in the Prometheus text format 0.0.4 (12.1 to 12.6): the families in the
    /// order of their names, each one group, its <c># HELP</c> then its <c># TYPE</c>, a family that
    /// holds none left out; its series by service, procedure, type, outcome and code; each count read
    /// as it is written, so a family's handled counts are read before its started ones, and what is
    /// under way never reads below 0.
    /// </summary>
    public MetricsExposition Exposition()
    {
        List<((CallRole Role, ProcedureAddress? Address, bool IsCommand) Key, CallSeries Series)> calls;
        List<(ProcedureAddress Address, NotifyingSeries Series)> notifying;
        List<(ProcedureAddress Address, HearingSeries Series)> hearing;
        List<(ProcedureAddress Address, DroppedSeries Series)> dropped;

        lock (_gate)
        {
            calls = [.. _calls.Select((entry) =>
            {
                return (entry.Key, entry.Value);
            }).OrderBy((entry) =>
            {
                return (OrderOf(entry.Key.Address), entry.Key.IsCommand);
            })];
            notifying = [.. _notifying.Select((entry) =>
            {
                return (entry.Key, entry.Value);
            }).OrderBy((entry) =>
            {
                return OrderOf(entry.Key);
            })];
            hearing = [.. _hearing.Select((entry) =>
            {
                return (entry.Key, entry.Value);
            }).OrderBy((entry) =>
            {
                return OrderOf(entry.Key);
            })];
            dropped = [.. _dropped.Select((entry) =>
            {
                return (entry.Key, entry.Value);
            }).OrderBy((entry) =>
            {
                return OrderOf(entry.Key);
            })];
        }

        var text = new StringBuilder();

        // a family's lines, under its HELP and its TYPE, when it holds a series
        void Write(string family, IReadOnlyList<string> lines)
        {
            if (lines.Count == 0)
            {
                return;
            }

            var (type, help) = Families[family];

            text.Append("# HELP ").Append(family).Append(' ').Append(HelpOf(help)).Append('\n');
            text.Append("# TYPE ").Append(family).Append(' ').Append(type).Append('\n');

            foreach (var line in lines)
            {
                text.Append(line).Append('\n');
            }
        }

        foreach (var role in new[] { CallRole.Client, CallRole.Server })
        {
            var ofRole = calls.Where((entry) =>
            {
                return entry.Key.Role == role;
            }).Select((entry) =>
            {
                return entry.Series;
            }).ToList();
            var (duration, handled, started) = role == CallRole.Client
                ? (ClientDuration, ClientHandled, ClientStarted)
                : (ServerDuration, ServerHandled, ServerStarted);

            Write(duration, [.. ofRole.SelectMany(DurationLinesOf(duration))]);
            Write(handled, [.. ofRole.SelectMany(HandledLinesOf(handled))]);
            Write(started, [.. ofRole.Select((series) =>
            {
                return $"{started}{{{series.Labels}}} {CountOf(series.Started())}";
            })]);

            if (role == CallRole.Client)
            {
                Write(Heard, [.. hearing.Select((entry) =>
                {
                    return $"{Heard}{{{entry.Series.Labels}}} {CountOf(entry.Series.Count())}";
                })]);
                Write(Sent, [.. notifying.SelectMany((entry) =>
                {
                    var (sent, failed) = entry.Series.Counts();

                    return new[]
                    {
                        $"{Sent}{{{entry.Series.Labels},outcome=\"sent\"}} {CountOf(sent)}",
                        $"{Sent}{{{entry.Series.Labels},outcome=\"failed\"}} {CountOf(failed)}",
                    };
                })]);
            }
        }

        Write(Dropped, [.. dropped.SelectMany((entry) =>
        {
            return entry.Series.Series().Select((series) =>
            {
                return series.Code is { } code
                    ? $"{Dropped}{{{entry.Series.Labels},code=\"{code}\"}} {CountOf(series.Count)}"
                    : $"{Dropped}{{{entry.Series.Labels}}} {CountOf(series.Count)}";
            });
        })]);

        return new MetricsExposition(MediaType, text.ToString());
    }

    // a histogram's lines of one series: its buckets rising to +Inf, each holding those under it,
    // then its _sum, then its _count, which is its +Inf bucket's
    private static Func<CallSeries, IEnumerable<string>> DurationLinesOf(string family)
    {
        return (series) =>
        {
            var lines = new List<string>(MetricsBuckets.Count + 2);
            var count = 0L;

            for (var index = 0; index < MetricsBuckets.Count; index += 1)
            {
                count += series.Bucket(index);
                lines.Add($"{family}_bucket{{{series.Labels},le=\"{MetricsBuckets.Les[index]}\"}} {CountOf(count)}");
            }

            lines.Add($"{family}_sum{{{series.Labels}}} {SecondsOf(series.Sum())}");
            lines.Add($"{family}_count{{{series.Labels}}} {CountOf(count)}");

            return lines;
        };
    }

    // a series' handled lines, by outcome, then by code under failure
    private static Func<CallSeries, IEnumerable<string>> HandledLinesOf(string family)
    {
        return (series) =>
        {
            return series.Table.Columns.Select((column, index) =>
            {
                var code = column.Code is { } named ? $",code=\"{named}\"" : "";

                return $"{family}{{{series.Labels},outcome=\"{column.Outcome}\"{code}}} {CountOf(series.Handled(index))}";
            });
        };
    }

    /// <summary>Its series for a router of <paramref name="side"/>: its <c>_OTHER</c> series made, in its call families.</summary>
    internal RouterSeries Give(RouterSide side)
    {
        return new RouterSeries((this, side));
    }

    /// <summary>
    /// The series of calls of a role and an address — none for <c>_OTHER</c> — under the type a
    /// router of <paramref name="side"/> gives it, made at 0 the first time.
    /// </summary>
    internal CallSeries CallsOf((CallRole Role, ProcedureAddress? Address) call, RouterSide side)
    {
        lock (_gate)
        {
            return CallsHeld(call, side);
        }
    }

    // as CallsOf, under the lock
    private CallSeries CallsHeld((CallRole Role, ProcedureAddress? Address) call, RouterSide side)
    {
        var key = (call.Role, call.Address, IsCommand(call.Role, side));

        if (!_calls.TryGetValue(key, out var series))
        {
            var table = call.Role == CallRole.Client
                ? CallTable.Client
                : call.Address is null ? CallTable.ServerOther : CallTable.ServerProcedure;

            series = new CallSeries(table, $"{LabelsOf(call.Address)},type=\"{(key.Item3 ? "command" : "request")}\"");
            _calls[key] = series;
        }

        return series;
    }

    /// <summary>
    /// A resolver registered on a router of <paramref name="side"/>, its procedure declared to the
    /// server families, and to the notification families as the side that notifies when it notifies;
    /// an <see cref="ArgumentException"/> for one refused (7.3).
    /// </summary>
    internal ResolverSeries DeclareResolver((Procedure Procedure, bool Notifies) resolver, RouterSide side)
    {
        var (procedure, notifies) = resolver;

        lock (_gate)
        {
            Declare(procedure, notifies ? [_server, _notification] : [_server]);

            var calls = CallsHeld((CallRole.Server, procedure.Address), side);

            if (!notifies)
            {
                return new ResolverSeries(calls, null);
            }

            var address = procedure.Address;
            var dropped = DroppedOf(address, MetricsCodes.Notifying);

            if (!_notifying.TryGetValue(address, out var notifying))
            {
                notifying = new NotifyingSeries(LabelsOf(address), dropped);
                _notifying[address] = notifying;
            }

            return new ResolverSeries(calls, notifying);
        }
    }

    /// <summary>
    /// A requester made on a router of <paramref name="side"/>, its procedure declared to the client
    /// families; an <see cref="ArgumentException"/> for one refused (7.3).
    /// </summary>
    internal CallSeries DeclareRequester(Procedure procedure, RouterSide side)
    {
        lock (_gate)
        {
            Declare(procedure, [_client]);

            return CallsHeld((CallRole.Client, procedure.Address), side);
        }
    }

    /// <summary>
    /// A notification registered on the side that hears, its procedure declared to the notification
    /// families; an <see cref="ArgumentException"/> for one refused (7.3).
    /// </summary>
    internal HearingSeries DeclareNotification(Procedure procedure)
    {
        lock (_gate)
        {
            Declare(procedure, [_notification]);

            var address = procedure.Address;
            var dropped = DroppedOf(address, MetricsCodes.Every);

            if (!_hearing.TryGetValue(address, out var hearing))
            {
                hearing = new HearingSeries(LabelsOf(address), dropped);
                _hearing[address] = hearing;
            }

            return hearing;
        }
    }
}
