using System.Text.Json;

namespace Bead.Tests;

/// <summary>
/// Bead's conformance vectors, read from <c>spec/vectors.json</c>: the bytes of envelopes and
/// what they say, written once, and read by every implementation's tests — the TypeScript ones, and these. A
/// vector only one implementation reads is a vector nobody checks.
/// </summary>
internal static class Vectors
{
    // constants

    // what each kind's header may say in a vector; any other field would pass unread
    private static readonly Dictionary<EnvelopeKind, HashSet<string>> Fields = new()
    {
        [EnvelopeKind.Request] =
        [
            "callId", "kind", "serviceId", "procedureId", "destinationId", "opensSubscription",
            "paced", "sessionToken", "total",
        ],
        [EnvelopeKind.Result] = ["callId", "kind", "sessionToken", "total"],
        [EnvelopeKind.Failure] = ["callId", "kind", "sessionToken"],
        [EnvelopeKind.Notification] = ["callId", "kind"],
        [EnvelopeKind.Chunk] = ["callId", "kind", "offset", "isLast"],
        [EnvelopeKind.Credit] = ["callId", "kind", "creditEnd", "paced"],
        [EnvelopeKind.Cancel] = ["callId", "kind"],
    };

    private static readonly JsonElement Root = Load();

    // helpers

    private static JsonElement Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "vectors.json");

        using var document = JsonDocument.Parse(File.ReadAllText(path));

        return document.RootElement.Clone();
    }

    private static T? OptionalOf<T>(JsonElement json, string field, Func<JsonElement, T> read)
        where T : struct
    {
        return json.TryGetProperty(field, out var value) ? read(value) : null;
    }

    private static bool IsSet(JsonElement json, string field)
    {
        return json.TryGetProperty(field, out var value) && value.GetBoolean();
    }

    // absent, no block; null, the end of a session; a string, its token
    private static SessionAnnouncement? SessionOf(JsonElement json)
    {
        if (!json.TryGetProperty("sessionToken", out var value))
        {
            return null;
        }

        return value.ValueKind == JsonValueKind.Null
            ? SessionAnnouncement.Ended
            : SessionToken.Parse(value.GetString()!);
    }

    // definition

    /// <summary>The names of a group's vectors, one theory row each.</summary>
    public static TheoryData<string> NamesOf(string group)
    {
        var names = new TheoryData<string>();

        foreach (var vector in Root.GetProperty(group).EnumerateArray())
        {
            names.Add(vector.GetProperty("name").GetString()!);
        }

        return names;
    }

    /// <summary>The vector of <paramref name="group"/> named <paramref name="name"/>.</summary>
    public static JsonElement Of(string group, string name)
    {
        foreach (var vector in Root.GetProperty(group).EnumerateArray())
        {
            if (vector.GetProperty("name").GetString() == name)
            {
                return vector;
            }
        }

        throw new KeyNotFoundException($"no vector \"{name}\" in {group}");
    }

    /// <summary>The bytes a hexadecimal string spells, spaces and bars aside.</summary>
    public static byte[] FromHexadecimal(string text)
    {
        return Convert.FromHexString(text.Replace(" ", "", StringComparison.Ordinal).Replace("|", "", StringComparison.Ordinal));
    }

    /// <summary>The bytes a vector's field spells.</summary>
    public static byte[] BytesOf(JsonElement vector, string field)
    {
        return FromHexadecimal(vector.GetProperty(field).GetString()!);
    }

    /// <summary>
    /// The header a vector writes, field by field: an absent token and a <c>null</c> one differ, as
    /// a header without a session block and one that ends its session do.
    /// </summary>
    public static IEnvelopeHeader HeaderOf(JsonElement json)
    {
        var callId = json.GetProperty("callId").GetUInt32();
        var kind = (EnvelopeKind)json.GetProperty("kind").GetByte();
        var unknown = json.EnumerateObject()
            .Select((field) =>
            {
                return field.Name;
            })
            .Except(Fields[kind])
            .ToList();

        Assert.True(unknown.Count == 0, $"a vector's header says what no test reads: {string.Join(", ", unknown)}");

        return kind switch
        {
            EnvelopeKind.Request => new RequestHeader
            {
                CallId = callId,
                ServiceId = json.GetProperty("serviceId").GetUInt16(),
                ProcedureId = json.GetProperty("procedureId").GetUInt16(),
                DestinationId = OptionalOf(json, "destinationId", (value) =>
                {
                    return value.GetUInt32();
                }),
                OpensSubscription = IsSet(json, "opensSubscription"),
                Paced = IsSet(json, "paced"),
                SessionToken = SessionOf(json)?.Token,
                Total = OptionalOf(json, "total", (value) =>
                {
                    return value.GetInt64();
                }),
            },
            EnvelopeKind.Result => new ResultHeader
            {
                CallId = callId,
                Session = SessionOf(json),
                Total = OptionalOf(json, "total", (value) =>
                {
                    return value.GetInt64();
                }),
            },
            EnvelopeKind.Failure => new FailureHeader { CallId = callId, Session = SessionOf(json) },
            EnvelopeKind.Notification => new NotificationHeader { CallId = callId },
            EnvelopeKind.Chunk => new ChunkHeader
            {
                CallId = callId,
                Offset = json.GetProperty("offset").GetInt64(),
                IsLast = json.GetProperty("isLast").GetBoolean(),
            },
            EnvelopeKind.Credit => new CreditHeader
            {
                CallId = callId,
                CreditEnd = json.GetProperty("creditEnd").GetInt64(),
                Paced = IsSet(json, "paced"),
            },
            EnvelopeKind.Cancel => new CancelHeader { CallId = callId },
            _ => throw new ArgumentException($"no kind {kind}", nameof(json)),
        };
    }

    /// <summary>The failure a vector writes.</summary>
    public static Failure FailureOf(JsonElement json)
    {
        return new Failure
        {
            Code = json.GetProperty("code").GetUInt16(),
            Detail = json.GetProperty("detail").GetString()!,
            Hops = json.GetProperty("hops").GetByte(),
            Scope = (FailureScope)json.GetProperty("scope").GetByte(),
        };
    }

    /// <summary>The side a vector names.</summary>
    public static RouterSide SideOf(JsonElement vector)
    {
        return vector.GetProperty("side").GetString() == "client" ? RouterSide.Client : RouterSide.Server;
    }
}
