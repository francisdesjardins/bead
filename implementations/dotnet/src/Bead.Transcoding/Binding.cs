using System.Text;
using Google.Protobuf;
using Google.Protobuf.Reflection;
using Google.Protobuf.WellKnownTypes;

namespace Bead.Transcoding;

/// <summary>A route a request is bound by: its request's message, its rule and its template, parsed once.</summary>
public sealed record BindingRoute
{
    /// <summary>The message its request is.</summary>
    public required MessageDescriptor Request { get; init; }

    /// <summary>The route: its method, its template's text and its body.</summary>
    public required HttpRouteTemplate Rule { get; init; }

    /// <summary>Its template, parsed.</summary>
    public required HttpTemplate Template { get; init; }
}

/// <summary>What a request brings to its binding: its target, raw, and its body, where it has one.</summary>
public sealed record BindingRequest
{
    /// <summary>Its target as it came: its path, raw, then its query after the first <c>?</c>.</summary>
    public required string Target { get; init; }

    /// <summary>Its body's bytes; none for a route that takes none.</summary>
    public ReadOnlyMemory<byte> Body { get; init; }
}

/// <summary>
/// A <c>proto</c> request bound from its route's variables, its query and its body into one JSON
/// value of its message, then read by Bead's mapping, so that one reader judges every field wherever
/// it came from (transcoding 4, <c>http.proto</c>'s rules); a <c>PATCH</c>'s <c>update_mask</c>
/// filled with the members its body holds (4.5). A refusal is a <see cref="JsonFormException"/>,
/// which a gateway answers 400 <c>PAYLOAD_UNDECODABLE</c>.
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
    /// The request <paramref name="request"/> brings, bound by <paramref name="route"/>, whose template
    /// matches its path: its message, or a <see cref="JsonFormException"/> saying why it is refused.
    /// </summary>
    public IMessage Bind(BindingRoute route, BindingRequest request)
    {
        ArgumentNullException.ThrowIfNull(route);
        ArgumentNullException.ThrowIfNull(request);

        var question = request.Target.IndexOf('?', StringComparison.Ordinal);
        var path = question < 0 ? request.Target : request.Target[..question];
        var query = question < 0 ? "" : request.Target[(question + 1)..];
        var split = HttpPath.Of(path);

        if (split is null || !route.Template.Matches(split))
        {
            throw new ArgumentException($"{request.Target} is not of {route.Rule.Template}", nameof(request));
        }

        var variables = route.Template.ValuesOf(split);
        var body = route.Rule.Body;
        JsonNode root;
        List<KeyValuePair<string, JsonNode>>? sent = null;

        if (body == Whole)
        {
            root = JsonText.Read(request.Body.Span);

            // * not an object: the reading refuses it as the message's, with nothing bound beside it
            if (root.Kind != JsonNodeKind.Object)
            {
                return _form.ReadNode(route.Request, root);
            }
        }
        else if (body is not null)
        {
            var inner = JsonText.Read(request.Body.Span);

            if (inner.Kind == JsonNodeKind.Null)
            {
                throw new JsonFormException("a body that is null");
            }

            // ! the mask is of the members the body holds as its caller sent them, before a variable joins it
            if (inner.Kind == JsonNodeKind.Object)
            {
                sent = [.. inner.Members];
            }

            root = JsonNode.ObjectOf([new KeyValuePair<string, JsonNode>(body, inner)]);
        }
        else
        {
            root = JsonNode.ObjectOf([]);
        }

        var bound = new HashSet<string>(StringComparer.Ordinal);

        foreach (var (fieldPath, text) in variables)
        {
            var fields = FieldsAlong(route.Request, (fieldPath, false))
                ?? throw new ArgumentException($"{route.Rule.Template} binds {fieldPath}, which names no field", nameof(route));

            SetAlong(root, (fields, TextJson(fields[^1].FieldType, text)));
            bound.Add(KeyOf(fields));
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
            var fields = FieldsAlong(route.Request, (name, true)) ?? throw new JsonFormException("a parameter no field path names");
            var leaf = fields[^1];
            var key = KeyOf(fields);

            if (bound.Contains(key) || (body is not null && fields[0].Name == body))
            {
                throw new JsonFormException("a parameter of a field the route binds otherwise");
            }

            if (leaf.IsMap || (leaf.IsRepeated && leaf.FieldType == FieldType.Message))
            {
                throw new JsonFormException("a parameter of a map or a repeated message");
            }

            if (leaf.FieldType == FieldType.Message && !leaf.MessageType.IsWrapper() && !StringForms.Contains(leaf.MessageType.FullName))
            {
                throw new JsonFormException("a parameter of a message");
            }

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
                throw new JsonFormException("a field the query names twice");
            }

            var value = leaf.FieldType != FieldType.Message
                ? TextJson(leaf.FieldType, text)
                : leaf.MessageType.IsWrapper() ? TextJson(leaf.MessageType.FindFieldByNumber(1).FieldType, text) : JsonNode.StringOf(text);

            SetAlong(root, (fields, value));
        }

        foreach (var key in order)
        {
            SetAlong(root, (items[key].Fields, JsonNode.ArrayOf(items[key].Values)));
        }

        var message = _form.ReadNode(route.Request, root);

        // * a PATCH whose caller left its update_mask unset: the members its body's object holds (AIP-134)
        if (string.Equals(route.Rule.Method, "PATCH", StringComparison.Ordinal)
            && body is not null and not Whole
            && route.Request.FindFieldByName(UpdateMask) is { } mask
            && mask is { IsRepeated: false, FieldType: FieldType.Message }
            && mask.MessageType.FullName == FieldMask.Descriptor.FullName
            && !named.Contains(UpdateMask)
            && route.Request.FindFieldByName(body) is { FieldType: FieldType.Message } bodyField
            && sent is not null)
        {
            var paths = new FieldMask();

            paths.Paths.AddRange(MaskOf(sent, (bodyField.MessageType, "")));
            mask.Accessor.SetValue(message, paths);
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
                if (field.IsRepeated || field.FieldType != FieldType.Message || JsonForm.IsWellKnown(field.MessageType) || field.MessageType.IsWrapper())
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
    // sets already is a field set twice (4.1)
    private static void SetAlong(JsonNode root, (List<FieldDescriptor> Fields, JsonNode Value) set)
    {
        var (fields, value) = set;
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
                throw new JsonFormException("a field that two of the request set");
            }
        }

        var leaf = IndexOf(members, fields[^1]);

        if (leaf >= 0 && members[leaf].Value.Kind != JsonNodeKind.Null)
        {
            throw new JsonFormException("a field that two of the request set");
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
                && field.FieldType == FieldType.Message
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
