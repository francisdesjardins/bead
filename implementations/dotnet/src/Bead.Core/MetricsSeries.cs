namespace Bead;

/// <summary>How a call ended, as its handled count names it (spec/debugging.md, 8.4).</summary>
internal enum CallOutcome
{
    /// <summary>Its result went, or came, whole.</summary>
    Result,

    /// <summary>A failure, by its code.</summary>
    Failure,

    /// <summary>Its time passed: a call made's alone.</summary>
    Timeout,

    /// <summary>Its requester, or its caller, cancelled it.</summary>
    Cancelled,

    /// <summary>Its connection closed, was not open, or its side was disposed.</summary>
    Closed,

    /// <summary>Anything else: no answer handed to its transport, or a transport that refused it.</summary>
    Error,
}

/// <summary>A call's role, which parts the call families (8.2): the calls a side makes, and those it answers.</summary>
internal enum CallRole
{
    /// <summary>A call the side makes.</summary>
    Client,

    /// <summary>A call the side answers.</summary>
    Server,
}

/// <summary>
/// The codes a series takes, as spec/debugging.md 7.6 lists them: section 8's by their number, then
/// <c>application</c> and <c>_OTHER</c>, each with its index among the 24, from which every table
/// below is cut.
/// </summary>
internal static class MetricsCodes
{
    // constants

    /// <summary>The index of <c>application</c>, a procedure's own failure.</summary>
    public const int Application = 22;

    /// <summary>The index of <c>_OTHER</c>, a code section 8 names none of.</summary>
    public const int Other = 23;

    /// <summary>The index of <c>PROCEDURE_FAILED</c>.</summary>
    public const int ProcedureFailed = 20;

    /// <summary>Every code a label holds, in the exposition's order: section 8's by number, then the two.</summary>
    public static readonly string[] Names =
    [
        "ENVELOPE_MALFORMED", "LAYOUT_UNSUPPORTED", "KIND_UNSUPPORTED", "ENVELOPE_TOO_LARGE",
        "DESTINATION_UNKNOWN", "DESTINATION_UNREACHABLE", "SERVICE_UNKNOWN", "PROCEDURE_UNKNOWN",
        "CALL_UNKNOWN", "SUBSCRIPTION_UNKNOWN", "SUBSCRIPTION_UNSUPPORTED",
        "SESSION_REQUIRED", "ACCESS_DENIED", "PAYLOAD_TOO_LARGE", "CAPACITY_EXCEEDED", "CREDENTIAL_UNSUPPORTED",
        "CHUNK_INVALID", "CREDIT_EXCEEDED", "PAYLOAD_UNDECODABLE", "TRANSFER_STALLED",
        "PROCEDURE_FAILED", "DESTINATION_LOST",
        "application", "_OTHER",
    ];

    // section 8's numbers, in the order of the names above
    private static readonly ushort[] Numbers = [1, 2, 3, 4, 16, 17, 18, 19, 20, 21, 22, 32, 33, 34, 35, 36, 48, 49, 50, 51, 64, 65];

    // by a protocol code's number, its index; -1 for a number section 8 names none of
    private static readonly int[] ByNumber = IndexOfNumbers();

    /// <summary>The 12 codes of a procedure's series in the server families, by their indices.</summary>
    public static readonly int[] Server = [IndexOf(22), IndexOf(32), IndexOf(33), IndexOf(34), IndexOf(35), IndexOf(36), IndexOf(48), IndexOf(49), IndexOf(50), IndexOf(51), IndexOf(64), Application];

    /// <summary>Every one of the 24, by its index.</summary>
    public static readonly int[] Every = [.. Enumerable.Range(0, Names.Length)];

    // helpers

    private static int[] IndexOfNumbers()
    {
        var indices = new int[Numbers[^1] + 1];

        Array.Fill(indices, -1);

        for (var index = 0; index < Numbers.Length; index += 1)
        {
            indices[Numbers[index]] = index;
        }

        return indices;
    }

    private static int IndexOf(ushort number)
    {
        return ByNumber[number];
    }

    // definition

    /// <summary>
    /// A failure's code, by its index: a procedure's own <c>application</c>; a protocol code by its
    /// name in section 8; one section 8 names none of, <c>_OTHER</c>.
    /// </summary>
    public static int IndexOf(Failure failure)
    {
        if (failure.Scope == FailureScope.Application)
        {
            return Application;
        }

        return failure.Code < ByNumber.Length && ByNumber[failure.Code] is var index and >= 0 ? index : Other;
    }
}

/// <summary>
/// The buckets of a call's duration, A66's 41 bounds and <c>+Inf</c> (spec/debugging.md 11.3), each
/// written as its <c>le</c> from a table: no number is formatted as it is written.
/// </summary>
internal static class MetricsBuckets
{
    /// <summary>How many buckets a histogram writes: 41 bounds and <c>+Inf</c>.</summary>
    public const int Count = 42;

    /// <summary>Each bucket's <c>le</c>, OpenMetrics' canonical number for its bound, rising, then <c>+Inf</c>.</summary>
    public static readonly string[] Les =
    [
        "0.0", "1e-05", "5e-05", "0.0001", "0.0003", "0.0006", "0.0008", "0.001", "0.002", "0.003", "0.004", "0.005", "0.006",
        "0.008", "0.01", "0.013", "0.016", "0.02", "0.025", "0.03", "0.04", "0.05", "0.065", "0.08", "0.1", "0.13", "0.16",
        "0.2", "0.25", "0.3", "0.4", "0.5", "0.65", "0.8", "1.0", "2.0", "5.0", "10.0", "20.0", "50.0", "100.0", "+Inf",
    ];

    // the bounds, in microseconds, rising
    private static readonly long[] Bounds =
    [
        0, 10, 50, 100, 300, 600, 800, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 8_000, 10_000, 13_000, 16_000, 20_000,
        25_000, 30_000, 40_000, 50_000, 65_000, 80_000, 100_000, 130_000, 160_000, 200_000, 250_000, 300_000, 400_000,
        500_000, 650_000, 800_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000, 100_000_000,
    ];

    /// <summary>
    /// The first bucket a duration falls in, whose bound is it or more: an integer comparison; past
    /// the last bound, <c>+Inf</c>'s. It falls in every one after too.
    /// </summary>
    public static int Of(long microseconds)
    {
        var index = Array.BinarySearch(Bounds, microseconds);

        return index >= 0 ? index : ~index;
    }
}

/// <summary>
/// What a series of calls counts by its outcome: its columns, in the exposition's order — an outcome,
/// and under <c>failure</c> each code its family's exits can end with (7.6) — and where each end
/// counts.
/// </summary>
internal sealed class CallTable
{
    // the outcomes of a call answered, and of a call made, in their order (12.3)
    private static readonly CallOutcome[] Answered = [CallOutcome.Result, CallOutcome.Failure, CallOutcome.Cancelled, CallOutcome.Closed, CallOutcome.Error];
    private static readonly CallOutcome[] Made = [CallOutcome.Result, CallOutcome.Failure, CallOutcome.Timeout, CallOutcome.Cancelled, CallOutcome.Closed, CallOutcome.Error];

    // by an outcome, its column; -1 for failure, which its code places, and for one the role has not
    private readonly int[] _outcomes = new int[Made.Length];

    // by a code's index, its column under failure; -1 for one the table has not
    private readonly int[] _codes = new int[MetricsCodes.Names.Length];

    private CallTable((CallOutcome[] Outcomes, int[] Codes) taken)
    {
        var columns = new List<(string Outcome, string? Code)>();

        Array.Fill(_outcomes, -1);
        Array.Fill(_codes, -1);

        foreach (var outcome in taken.Outcomes)
        {
            if (outcome != CallOutcome.Failure)
            {
                _outcomes[(int)outcome] = columns.Count;
                columns.Add((NameOf(outcome), null));

                continue;
            }

            foreach (var code in taken.Codes)
            {
                _codes[code] = columns.Count;
                columns.Add(("failure", MetricsCodes.Names[code]));
            }
        }

        Columns = columns;
    }

    /// <summary>A procedure's, in the server families: 16 columns, 12 codes.</summary>
    public static CallTable ServerProcedure { get; } = new((Answered, MetricsCodes.Server));

    /// <summary><c>_OTHER</c>'s, in the server families: 28 columns, every code.</summary>
    public static CallTable ServerOther { get; } = new((Answered, MetricsCodes.Every));

    /// <summary>A procedure's and <c>_OTHER</c>'s, in the client families: 29 columns, every code.</summary>
    public static CallTable Client { get; } = new((Made, MetricsCodes.Every));

    /// <summary>Its columns, in the exposition's order: an outcome, and its code under failure.</summary>
    public IReadOnlyList<(string Outcome, string? Code)> Columns { get; }

    private static string NameOf(CallOutcome outcome)
    {
        return outcome switch
        {
            CallOutcome.Result => "result",
            CallOutcome.Timeout => "timeout",
            CallOutcome.Cancelled => "cancelled",
            CallOutcome.Closed => "closed",
            _ => "error",
        };
    }

    /// <summary>
    /// The column an end counts in: its outcome's, or, for a failure, its code's; a code its table
    /// has none of counts as PROCEDURE_FAILED.
    /// </summary>
    public int ColumnOf((CallOutcome Outcome, Failure? Failure) ending)
    {
        if (ending.Outcome != CallOutcome.Failure)
        {
            // ! a role counts the outcomes it has alone: a call answered never times out
            return _outcomes[(int)ending.Outcome] is var column and >= 0 ? column : _outcomes[(int)CallOutcome.Error];
        }

        var coded = ending.Failure is { } failure ? _codes[MetricsCodes.IndexOf(failure)] : -1;

        // a code its table has no column for, which a resolver registered on its router itself
        // alone can answer, counts as PROCEDURE_FAILED, the code a service manager answers in its
        // place, since no count makes a series (spec/debugging.md 9.8); a table of every code has a
        // column for each, _OTHER among them
        return coded >= 0 ? coded : _codes[MetricsCodes.ProcedureFailed];
    }
}

/// <summary>
/// What one series of calls held at one reading: its started count, its handled counts by column,
/// each bucket's own count, and its sum in whole microseconds.
/// </summary>
/// <param name="Started">Its started count, never below the sum of its handled counts.</param>
/// <param name="Handled">Its handled counts, by column; their sum is its <c>_count</c>.</param>
/// <param name="Buckets">Each bucket's own count, their sum never above its handled counts'.</param>
/// <param name="Sum">Its sum, in whole microseconds.</param>
internal sealed record CallReading(long Started, long[] Handled, long[] Buckets, long Sum);

/// <summary>
/// One series of calls, made at 0 as its procedure is declared, or as its registry is given to a
/// router for <c>_OTHER</c>: its started count, its handled counts by column, and its duration's
/// buckets and sum, each in whole microseconds. Counted with no lock and no allocation, from any
/// thread; read by the exposition, once a series.
/// </summary>
internal sealed class CallSeries(CallTable table, string labels)
{
    private readonly long[] _handled = new long[table.Columns.Count];

    // each bucket's own count, the exposition adding them up as it writes them
    private readonly long[] _buckets = new long[MetricsBuckets.Count];
    private long _started;
    private long _sum;

    /// <summary>Its labels as the exposition writes them, but <c>outcome</c>, <c>code</c> and <c>le</c>.</summary>
    public string Labels { get; } = labels;

    /// <summary>Its columns.</summary>
    public CallTable Table { get; } = table;

    /// <summary>A call started.</summary>
    public void Start()
    {
        Interlocked.Increment(ref _started);
    }

    /// <summary>A call ended, so long after it started: every end is observed (11.2).</summary>
    public void End((CallOutcome Outcome, Failure? Failure) ending, long microseconds)
    {
        // ! counted in this order, which Read reads backwards: its handled count first
        Interlocked.Increment(ref _handled[Table.ColumnOf(ending)]);
        Interlocked.Increment(ref _buckets[MetricsBuckets.Of(microseconds)]);
        Interlocked.Add(ref _sum, microseconds);
    }

    /// <summary>
    /// Its counts at one reading (spec/debugging.md 8.5), read in the reverse of the order a call
    /// counts them — its sum, its buckets, its handled counts, then its started count — while other
    /// threads go on counting: an end it reads in a bucket it reads among its handled counts too, and
    /// a call it reads ended it reads started.
    /// </summary>
    public CallReading Read()
    {
        var sum = Volatile.Read(ref _sum);
        var buckets = new long[_buckets.Length];
        var handled = new long[_handled.Length];

        for (var index = 0; index < buckets.Length; index += 1)
        {
            buckets[index] = Volatile.Read(ref _buckets[index]);
        }

        for (var index = 0; index < handled.Length; index += 1)
        {
            handled[index] = Volatile.Read(ref _handled[index]);
        }

        return new CallReading(Volatile.Read(ref _started), handled, buckets, sum);
    }
}

/// <summary>
/// A procedure's subscriptions dropped, at either end, by code: none and every one of the 24 (7.6),
/// made at 0 as it is declared; the side that notifies and the side that hears count into the same.
/// </summary>
internal sealed class DroppedSeries(string labels)
{
    // by a code's index, then none at the end
    private readonly long[] _counts = new long[MetricsCodes.Names.Length + 1];

    /// <summary>Its labels as the exposition writes them, but <c>code</c>.</summary>
    public string Labels { get; } = labels;

    // where none counts
    private static int None
    {
        get
        {
            return MetricsCodes.Names.Length;
        }
    }

    /// <summary>A subscription dropped: by its failure's code, or none for none; every code has its series.</summary>
    public void Drop(Failure? failure)
    {
        Interlocked.Increment(ref _counts[failure is null ? None : MetricsCodes.IndexOf(failure)]);
    }

    /// <summary>Its series, in the exposition's order: none first, then by code; each with its count.</summary>
    public IEnumerable<(string? Code, long Count)> Series()
    {
        yield return (null, Volatile.Read(ref _counts[None]));

        for (var index = 0; index < MetricsCodes.Names.Length; index += 1)
        {
            yield return (MetricsCodes.Names[index], Volatile.Read(ref _counts[index]));
        }
    }
}

/// <summary>A procedure's notifications at the side that notifies: sent and failed, and its subscriptions dropped there.</summary>
internal sealed class NotifyingSeries(string labels, DroppedSeries dropped)
{
    private long _sent;
    private long _failed;

    /// <summary>Its labels as the exposition writes them, but <c>outcome</c>.</summary>
    public string Labels { get; } = labels;

    /// <summary>Its subscriptions dropped, which the side that hears counts into too.</summary>
    public DroppedSeries Dropped { get; } = dropped;

    /// <summary>A notification handed to its transport for one subscription.</summary>
    public void Sent()
    {
        Interlocked.Increment(ref _sent);
    }

    /// <summary>A notification that could not be.</summary>
    public void Failed()
    {
        Interlocked.Increment(ref _failed);
    }

    /// <summary>Its sent count, then its failed one.</summary>
    public (long Sent, long Failed) Counts()
    {
        return (Volatile.Read(ref _sent), Volatile.Read(ref _failed));
    }
}

/// <summary>A procedure's notifications at the side that hears: heard, and its subscriptions dropped there.</summary>
internal sealed class HearingSeries(string labels, DroppedSeries dropped)
{
    private long _heard;

    /// <summary>Its labels as the exposition writes them.</summary>
    public string Labels { get; } = labels;

    /// <summary>Its subscriptions dropped, which the side that notifies counts into too.</summary>
    public DroppedSeries Dropped { get; } = dropped;

    /// <summary>A notification its router paired with a subscription it holds.</summary>
    public void Heard()
    {
        Interlocked.Increment(ref _heard);
    }

    /// <summary>Its heard count.</summary>
    public long Count()
    {
        return Volatile.Read(ref _heard);
    }
}

/// <summary>A resolver's series: its calls answered, and its notifications sent when its procedure notifies.</summary>
/// <param name="Calls">Its calls, in the server families.</param>
/// <param name="Notifying">Its notifications, at the side that notifies; none when its procedure notifies none.</param>
internal sealed record ResolverSeries(CallSeries Calls, NotifyingSeries? Notifying);

/// <summary>
/// What one router counts into: its registry, its side — which gives each call its type (8.2) — and
/// its <c>_OTHER</c> series, made as the registry is given to it. What it declares goes to its
/// registry, under the type its side gives.
/// </summary>
internal sealed class RouterSeries((MetricsRegistry Registry, RouterSide Side) given)
{
    /// <summary>The calls it answers that it has no declaration for.</summary>
    public CallSeries Answered { get; } = given.Registry.CallsOf((CallRole.Server, null), given.Side);

    /// <summary>The calls it makes that carry no series.</summary>
    public CallSeries Made { get; } = given.Registry.CallsOf((CallRole.Client, null), given.Side);

    /// <summary>A resolver registered: its procedure to the server families, and to the notification families when it notifies.</summary>
    public ResolverSeries DeclareResolver(Procedure procedure, bool notifies)
    {
        return given.Registry.DeclareResolver((procedure, notifies), given.Side);
    }

    /// <summary>A requester made: its procedure to the client families.</summary>
    public CallSeries DeclareRequester(Procedure procedure)
    {
        return given.Registry.DeclareRequester(procedure, given.Side);
    }

    /// <summary>A notification registered, on the side that hears: its procedure to the notification families.</summary>
    public HearingSeries DeclareNotification(Procedure procedure)
    {
        return given.Registry.DeclareNotification(procedure);
    }
}

/// <summary>
/// A call counted as it started: its series, and its clock's monotonic reading then, which its end
/// reads again, for its duration in whole microseconds (spec/debugging.md 11.1).
/// </summary>
internal readonly struct StartedCall
{
    /// <summary>The series it counts into.</summary>
    public required CallSeries Series { get; init; }

    /// <summary>The clock its router runs on.</summary>
    public required TimeProvider Clock { get; init; }

    /// <summary>Its clock's monotonic reading as it started.</summary>
    public required long Timestamp { get; init; }

    /// <summary>
    /// How a call that failed with <paramref name="reason"/> ended: a failure by its code; its time
    /// passed; cancelled; its connection closed, not open, or its side disposed; anything else an
    /// error.
    /// </summary>
    public static (CallOutcome Outcome, Failure? Failure) EndingOf(Exception reason)
    {
        return reason switch
        {
            FailureException failure => (CallOutcome.Failure, failure.Failure),
            TimeoutException => (CallOutcome.Timeout, null),
            OperationCanceledException => (CallOutcome.Cancelled, null),
            DisconnectException => (CallOutcome.Closed, null),
            _ => (CallOutcome.Error, null),
        };
    }

    /// <summary>It ended, now: a ticks' difference over 10, its fraction dropped.</summary>
    public void End((CallOutcome Outcome, Failure? Failure) ending)
    {
        Series.End(ending, Clock.GetElapsedTime(Timestamp).Ticks / TimeSpan.TicksPerMicrosecond);
    }
}
