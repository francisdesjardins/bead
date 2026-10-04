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
            "paced", "total", "credential",
        ],
        [EnvelopeKind.Result] = ["callId", "kind", "total", "credential"],
        [EnvelopeKind.Failure] = ["callId", "kind", "credential"],
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

    // absent, no block; else its scheme, by name or, to come, by its number, and its credential:
    // an OPAQUE token's bytes and a scheme to come's in hexadecimal, a JWT's token as its text
    private static Credential? CredentialOf(JsonElement json)
    {
        if (!json.TryGetProperty("credential", out var credential))
        {
            return null;
        }

        var scheme = credential.GetProperty("scheme");
        var name = scheme.ValueKind == JsonValueKind.Number ? null : scheme.GetString();
        string[] read = name switch
        {
            "NONE" or "ELSEWHERE" => ["scheme"],
            "JWT" => ["scheme", "token"],
            _ => ["scheme", "bytes"],
        };
        var unknown = credential.EnumerateObject()
            .Select((field) =>
            {
                return field.Name;
            })
            .Except(read)
            .ToList();

        Assert.True(unknown.Count == 0, $"a vector's credential says what no test reads: {string.Join(", ", unknown)}");

        if (name is null)
        {
            return Credential.Of((CredentialScheme)scheme.GetUInt16(), BytesOf(credential, "bytes"));
        }

        return name switch
        {
            "NONE" => Credential.None,
            "OPAQUE" => Credential.Opaque(SessionToken.FromBytes(BytesOf(credential, "bytes"))),
            "JWT" => Credential.Jwt(credential.GetProperty("token").GetString()!),
            "ELSEWHERE" => Credential.Elsewhere,
            _ => throw new ArgumentException($"no credential scheme {name}", nameof(json)),
        };
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
    /// The header a vector writes, field by field: an absent credential and one of scheme
    /// <c>NONE</c> differ, as a header without a CREDENTIAL block and one that announces its
    /// session's end do.
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
                Total = OptionalOf(json, "total", (value) =>
                {
                    return value.GetInt64();
                }),
                Credential = CredentialOf(json),
            },
            EnvelopeKind.Result => new ResultHeader
            {
                CallId = callId,
                Total = OptionalOf(json, "total", (value) =>
                {
                    return value.GetInt64();
                }),
                Credential = CredentialOf(json),
            },
            EnvelopeKind.Failure => new FailureHeader { CallId = callId, Credential = CredentialOf(json) },
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
            Relays = json.GetProperty("relays").GetByte(),
            Scope = (FailureScope)json.GetProperty("scope").GetByte(),
        };
    }

    /// <summary>The side a vector names.</summary>
    public static RouterSide SideOf(JsonElement vector)
    {
        return vector.GetProperty("side").GetString() == "client" ? RouterSide.Client : RouterSide.Server;
    }
}
