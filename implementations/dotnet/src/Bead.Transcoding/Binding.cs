using System.Text;
using Google.Protobuf;
using Google.Protobuf.Reflection;
using Google.Protobuf.WellKnownTypes;

namespace Bead.Transcoding;

/// <summary>
/// What a request is bound from (transcoding 4): its variables, decoded, its query, raw, its body, and
/// its route's body and whether its route is a <c>patch</c> rule's.
/// </summary>
public sealed record BindingOptions
{
    /// <summary>Each variable's value, decoded, by its field path of proto names.</summary>
    public required IReadOnlyDictionary<string, string> Variables { get; init; }

    /// <summary>Its query, raw, after the first <c>?</c>; none where its target has none.</summary>
    public string? Query { get; init; }

    /// <summary>Its body's bytes, a <c>proto</c> body's JSON text; none where its route takes none.</summary>
    public ReadOnlyMemory<byte>? Body { get; init; }

    /// <summary>Its route's body: <c>*</c>, a top-level field's proto name, or none.</summary>
    public string? RouteBody { get; init; }

    /// <summary>Whether its route is a <c>patch</c> rule's, whose <c>update_mask</c> its body's keys fill (4.5).</summary>
    public bool IsPatch { get; init; }
}

/// <summary>
/// A <c>proto</c> request bound from its route's variables, its query and its body into one JSON
/// value of its message, then read by Bead's mapping, so that one reader judges every field wherever
/// it came from (transcoding 4, <c>http.proto</c>'s rules); a <c>PATCH</c>'s <c>update_mask</c>
/// filled with the members its body holds, set on the message by proto names (4.5); then the
/// message judged by its required fields, 5.2's step 4. A refusal is a
/// <see cref="JsonFormException"/>, which a gateway answers 400 <c>PAYLOAD_UNDECODABLE</c>, placed
/// where the request carried what it refuses (7.4), a required field unset as a violation's field.
/// </summary>
public sealed class HttpBinding
{
    private const string Whole = "*";
    private const string UpdateMask = "update_mask";

    // the well-known types whose JSON is a string, which a query's parameter carries whole (4.3, item 2)
    private static readonly HashSet<string> StringForms = new(StringComparer.Ordinal)
    {
        Timestamp.Descriptor.FullName,
        Duration.Descriptor.FullName,
        FieldMask.Descriptor.FullName,
    };

    private static readonly UTF8Encoding Strict = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    private readonly JsonForm _form;

    /// <summary>A binding that reads what it binds by <paramref name="form"/>.</summary>
    public HttpBinding(JsonForm form)
    {
        ArgumentNullException.ThrowIfNull(form);

        _form = form;
    }

    /// <summary>
    /// A request of <paramref name="request"/> bound from what <paramref name="options"/> gives, its
    /// route's template having matched its path: its message, or a <see cref="JsonFormException"/>
    /// saying why it is refused.
    /// </summary>
    public IMessage Bind(MessageDescriptor request, BindingOptions options)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(options);

        var query = options.Query ?? "";
        var body = options.RouteBody;
        JsonNode root;
        List<KeyValuePair<string, JsonNode>>? sent = null;

        if (body == Whole && options.Body is { } whole)
        {
            root = JsonText.Read(whole.Span);

            // * not an object: the reading refuses it as the message's, with nothing bound beside it
            if (root.Kind != JsonNodeKind.Object)
            {
                try
                {
                    return _form.ReadNode(request, root);
                }
                catch (JsonFormException refused) when (refused.At is { } at)
                {
                    throw Placed(refused, new RequestPlace { Pointer = JsonPlaces.PointerOf(at) });
                }
            }
        }
        else if (body is not null and not Whole && options.Body is { } given)
        {
            // * a body null under a field is that field's JSON, null, which leaves it unset (5.2, item 2)
            var inner = JsonText.Read(given.Span);

            // ! the mask is of the members the body holds as its caller sent them, before a variable
            // joins it: none for a null
            if (inner.Kind is JsonNodeKind.Object or JsonNodeKind.Null)
            {
                sent = [.. inner.Kind == JsonNodeKind.Object ? inner.Members : []];
            }

            root = JsonNode.ObjectOf([new KeyValuePair<string, JsonNode>(body, inner)]);
        }
        else
        {
            root = JsonNode.ObjectOf([]);
        }

        var bound = new HashSet<string>(StringComparer.Ordinal);

        // the paths a variable or the query binds, by JSON names, where a refusal of their reading is placed
        var byVariable = new List<(List<FieldDescriptor> Fields, string Parameter)>();
        var byQuery = new List<List<FieldDescriptor>>();

        foreach (var (fieldPath, text) in options.Variables)
        {
            var fields = FieldsAlong(request, (fieldPath, false))
                ?? throw new ArgumentException($"{fieldPath} names no field of {request.FullName}", nameof(options));

            SetAlong(root, (fields, TextJson(fields[^1].FieldType, text), fieldPath));
            bound.Add(KeyOf(fields));
            byVariable.Add((fields, fieldPath));
        }

        var pairs = query.Length == 0 ? [] : QueryPairs(query);

        if (pairs.Count > 0 && body == Whole)
        {
            throw new JsonFormException("a query beside a body of the whole request");
        }

        var named = new HashSet<string>(StringComparer.Ordinal);
        var items = new Dictionary<string, (List<FieldDescriptor> Fields, List<JsonNode> Values)>(StringComparer.Ordinal);
        var order = new List<string>();

        foreach (var (name, text) in pairs)
        {
            var fields = FieldsAlong(request, (name, true))
                ?? throw Refused("a parameter no field path names", JsonPlaces.CutOf(name));
            var leaf = fields[^1];
            var key = KeyOf(fields);
            var parameter = JsonNamesOf(fields);

            if (bound.Contains(key) || (body is not null && fields[0].Name == body))
            {
                throw Refused("a parameter of a field the route binds otherwise", parameter);
            }

            if (leaf.IsMap || (leaf.IsRepeated && leaf.IsMessage()))
            {
                throw Refused("a parameter of a map or a repeated message", parameter);
            }

            if (leaf.IsMessage() && !leaf.MessageType.IsWrapper() && !StringForms.Contains(leaf.MessageType.FullName))
            {
                throw Refused("a parameter of a message", parameter);
            }

            byQuery.Add(fields);

            if (leaf.IsRepeated)
            {
                if (!items.TryGetValue(key, out var held))
                {
                    held = (fields, []);
                    items[key] = held;
                    order.Add(key);
                }

                held.Values.Add(TextJson(leaf.FieldType, text));

                continue;
            }

            if (!named.Add(key))
            {
                throw Refused("a field the query names twice", parameter);
            }

            var value = !leaf.IsMessage()
                ? TextJson(leaf.FieldType, text)
                : leaf.MessageType.IsWrapper() ? TextJson(leaf.MessageType.FindFieldByNumber(1).FieldType, text) : JsonNode.StringOf(text);

            SetAlong(root, (fields, value, parameter));
        }

        foreach (var key in order)
        {
            SetAlong(root, (items[key].Fields, JsonNode.ArrayOf(items[key].Values), JsonNamesOf(items[key].Fields)));
        }

        // the route's body as a reading's place names it: `*`, or its field's JSON name
        var placedBody = body is null or Whole ? body : request.FindFieldByName(body)?.JsonName ?? body;
        IMessage message;

        try
        {
            message = _form.ReadNode(request, root);
        }
        catch (JsonFormException refused) when (refused.At is { } at)
        {
            throw Placed(refused, PlaceOf((at, false), (byVariable, byQuery, placedBody)));
        }

        // * a PATCH whose caller left its update_mask unset: the members its body's object holds
        // (AIP-134), set on the message by proto names, never read back through 5.4's form
        if (options.IsPatch
            && body is not null and not Whole
            && request.FindFieldByName(UpdateMask) is { } mask
            && mask is { IsRepeated: false, FieldType: FieldType.Message }
            && mask.MessageType.FullName == FieldMask.Descriptor.FullName
            && !named.Contains(UpdateMask)
            && request.FindFieldByName(body) is { } bodyField
            && bodyField.IsMessage()
            && sent is not null)
        {
            var paths = new FieldMask();

            paths.Paths.AddRange(MaskOf(sent, (bodyField.MessageType, "")));
            mask.Accessor.SetValue(message, paths);
        }

        // * 5.2's step 4, once the mask is set: a required update_mask the mask derived binds
        try
        {
            JsonForm.Judge(message);
        }
        catch (JsonFormException refused) when (refused.At is { } at)
        {
            throw Placed(refused, PlaceOf((at, true), (byVariable, byQuery, placedBody)));
        }

        return message;
    }

    // a field path's fields, through non-repeated message fields that are not well-known types, by
    // their proto names, or by either name where by JSON; none where it names none
    private static List<FieldDescriptor>? FieldsAlong(MessageDescriptor descriptor, (string Path, bool ByJson) named)
    {
        var parts = named.Path.Split('.');
        var fields = new List<FieldDescriptor>(parts.Length);
        var current = descriptor;

        for (var index = 0; index < parts.Length; index += 1)
        {
            var field = named.ByJson ? JsonForm.FieldNamed(current, parts[index]) : current.FindFieldByName(parts[index]);

            if (field is null)
            {
                return null;
            }

            fields.Add(field);

            if (index < parts.Length - 1)
            {
                if (field.IsRepeated || !field.IsMessage() || JsonForm.IsWellKnown(field.MessageType) || field.MessageType.IsWrapper())
                {
                    return null;
                }

                current = field.MessageType;
            }
        }

        return fields;
    }

    private static string KeyOf(List<FieldDescriptor> fields)
    {
        return string.Join('.', fields.Select((field) =>
        {
            return field.Name;
        }));
    }

    // a path of fields by their JSON names, as a query's parameter is placed (7.4, item 1)
    private static string JsonNamesOf(List<FieldDescriptor> fields)
    {
        return string.Join('.', fields.Select((field) =>
        {
            return field.JsonName;
        }));
    }

    // a refusal of the binding's own, placed at the parameter that brings it
    private static JsonFormException Refused(string reason, string parameter)
    {
        return new JsonFormException(reason, new JsonFormExceptionOptions { Place = new RequestPlace { Parameter = parameter } });
    }

    // a refusal of the reading, placed where the request carried it
    private static JsonFormException Placed(JsonFormException refused, RequestPlace place)
    {
        return new JsonFormException(refused.Message, new JsonFormExceptionOptions
        {
            Place = place,
            IsUnset = refused.IsUnset,
            InnerException = refused.InnerException,
        });
    }

    // whether a place's tokens begin with a path of fields, by their JSON names
    private static bool IsWithin(IReadOnlyList<JsonToken> tokens, List<FieldDescriptor> fields)
    {
        return fields.Count <= tokens.Count && fields.Select((field, index) =>
        {
            return !tokens[index].IsGiven && tokens[index].Text == field.JsonName;
        }).All((isSame) =>
        {
            return isSame;
        });
    }

    // where the request carried the value its reading refused at `at` (7.4): a variable's field path
    // as its template writes it, or a query's by JSON names, an item's index left out; or a pointer
    // into its body, the field a body names, by its JSON name, its root. A field left unset (5.2, step 4) is placed as
    // a violation's field is: a parameter by JSON names where the route's query would bind it, its
    // route of no body or of a body naming another field, else the member the body's object lacks
    private static RequestPlace PlaceOf((IReadOnlyList<JsonToken> Tokens, bool IsUnset) at, (List<(List<FieldDescriptor> Fields, string Parameter)> ByVariable, List<List<FieldDescriptor>> ByQuery, string? Body) sources)
    {
        var (tokens, isUnset) = at;
        var (byVariable, byQuery, body) = sources;

        foreach (var (fields, parameter) in byVariable)
        {
            if (IsWithin(tokens, fields))
            {
                return new RequestPlace { Parameter = parameter };
            }
        }

        foreach (var fields in byQuery)
        {
            if (IsWithin(tokens, fields))
            {
                return new RequestPlace { Parameter = JsonNamesOf(fields) };
            }
        }

        var isInBody = body == Whole || (body is not null && tokens.Count > 0 && !tokens[0].IsGiven && tokens[0].Text == body);

        if (isUnset && !isInBody)
        {
            return new RequestPlace
            {
                Parameter = string.Join('.', tokens.Select((token) =>
                {
                    return token.Text;
                })),
            };
        }

        return new RequestPlace { Pointer = JsonPlaces.PointerOf(body == Whole ? tokens : tokens.Skip(1)) };
    }

    // a variable's or a parameter's value made the field's JSON (4.2)
    private static JsonNode TextJson(FieldType type, string text)
    {
        switch (type)
        {
            case FieldType.Bool:
                return text switch
                {
                    "true" => JsonNode.True,
                    "false" => JsonNode.False,
                    _ => JsonNode.StringOf(text),
                };
            case FieldType.Enum:
                return IsDecimal(text) ? JsonNode.NumberOf(text) : JsonNode.StringOf(text);
            default:
                return JsonNode.StringOf(text);
        }
    }

    private static bool IsDecimal(string text)
    {
        var digits = text.StartsWith('-') ? text[1..] : text;

        return digits.Length > 0 && digits.All(char.IsAsciiDigit) && (digits.Length == 1 || digits[0] != '0');
    }

    // a member of `members` that names `field`, by its proto name or its JSON name
    private static int IndexOf(List<KeyValuePair<string, JsonNode>> members, FieldDescriptor field)
    {
        return members.FindIndex((member) =>
        {
            return member.Key == field.Name || member.Key == field.JsonName;
        });
    }

    // sets a field path's leaf in a JSON object, its messages made where none is; a leaf the object
    // sets already, but to null, which sets nothing, is a field set twice (4.1), refused at the
    // parameter that sets it
    private static void SetAlong(JsonNode root, (List<FieldDescriptor> Fields, JsonNode Value, string Parameter) set)
    {
        var (fields, value, parameter) = set;
        var members = root.Members;

        foreach (var field in fields.Take(fields.Count - 1))
        {
            var at = IndexOf(members, field);

            if (at < 0 || members[at].Value.Kind == JsonNodeKind.Null)
            {
                var child = JsonNode.ObjectOf([]);
                var made = new KeyValuePair<string, JsonNode>(field.Name, child);

                if (at < 0)
                {
                    members.Add(made);
                }
                else
                {
                    members[at] = made;
                }

                members = child.Members;
            }
            else if (members[at].Value.Kind == JsonNodeKind.Object)
            {
                members = members[at].Value.Members;
            }
            else
            {
                throw Refused("a field that two of the request set", parameter);
            }
        }

        var leaf = IndexOf(members, fields[^1]);

        if (leaf >= 0 && members[leaf].Value.Kind != JsonNodeKind.Null)
        {
            throw Refused("a field that two of the request set", parameter);
        }

        if (leaf >= 0)
        {
            members.RemoveAt(leaf);
        }

        members.Add(new KeyValuePair<string, JsonNode>(fields[^1].Name, value));
    }

    // the paths of the members a body's object holds (4.5)
    private static List<string> MaskOf(List<KeyValuePair<string, JsonNode>> members, (MessageDescriptor Descriptor, string Prefix) of)
    {
        var paths = new List<string>();

        foreach (var (key, member) in members)
        {
            if (JsonForm.FieldNamed(of.Descriptor, key) is not { } field)
            {
                continue;
            }

            var path = of.Prefix + field.Name;

            if (member is { Kind: JsonNodeKind.Object, Members.Count: > 0 }
                && !field.IsRepeated
                && field.IsMessage()
                && !JsonForm.IsWellKnown(field.MessageType)
                && !field.MessageType.IsWrapper())
            {
                paths.AddRange(MaskOf(member.Members, (field.MessageType, path + ".")));
            }
            else
            {
                paths.Add(path);
            }
        }

        return paths;
    }

    // a query read as the WHATWG URL Standard's application/x-www-form-urlencoded parser reads one:
    // its sequences by `&`, an empty one skipped, a name and its value at the first `=` (4.3)
    private static List<(string Name, string Value)> QueryPairs(string query)
    {
        var pairs = new List<(string Name, string Value)>();

        foreach (var sequence in query.Split('&'))
        {
            if (sequence.Length == 0)
            {
                continue;
            }

            var equals = sequence.IndexOf('=', StringComparison.Ordinal);
            var name = equals < 0 ? sequence : sequence[..equals];
            var value = equals < 0 ? "" : sequence[(equals + 1)..];

            pairs.Add((FormDecoded(name), FormDecoded(value)));
        }

        return pairs;
    }

    // a name or a value percent-decoded, `+` a space first; a `%` that two hexadecimal digits do not
    // follow stays as it is, and bytes that are not UTF-8 are refused
    private static string FormDecoded(string text)
    {
        var spaced = text.Replace('+', ' ');
        var bytes = new List<byte>(spaced.Length);

        for (var at = 0; at < spaced.Length;)
        {
            if (spaced[at] == '%' && at + 2 < spaced.Length && Uri.IsHexDigit(spaced[at + 1]) && Uri.IsHexDigit(spaced[at + 2]))
            {
                bytes.Add(Convert.ToByte(spaced.Substring(at + 1, 2), 16));
                at += 3;

                continue;
            }

            var length = char.IsHighSurrogate(spaced[at]) && at + 1 < spaced.Length ? 2 : 1;

            bytes.AddRange(Encoding.UTF8.GetBytes(spaced.Substring(at, length)));
            at += length;
        }

        try
        {
            return Strict.GetString([.. bytes]);
        }
        catch (DecoderFallbackException reason)
        {
            throw new JsonFormException("a query whose bytes are not UTF-8", reason);
        }
    }
}
