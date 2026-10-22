using System.Text;
using System.Text.Json;
using Google.Protobuf;
using static Bead.Transcoding.Tests.TranscodingFile;

namespace Bead.Transcoding.Tests;

/// <summary>
/// <c>spec/transcoding.json</c>, played whole: its templates through <see cref="HttpTemplate"/>, its
/// readings and writings through <see cref="JsonForm"/>, its bindings through
/// <see cref="HttpBinding"/>, its failures through <see cref="HttpProblems"/>, its events through
/// <see cref="HttpEvents"/>, and its exchanges through a gateway of the Transcoding service in
/// process, over a real socket. The twin of the TypeScript side's <c>transcoding.test.ts</c>.
/// </summary>
public sealed class TranscodingTests
{
    [Fact]
    public async Task Plays_transcoding_json()
    {
        var parted = new List<string>();

        Assert.Equal("0.1.0", Root.GetProperty("transcodingVersion").GetString());

        PlayTemplates(parted);
        PlayReadings(parted);
        PlayWritings(parted);
        PlayBindings(parted);
        PlayFailures(parted);
        await PlayEvents(parted);
        await Exchanges.Play(parted);

        Assert.True(parted.Count == 0, string.Join('\n', parted));
    }

    private static void PlayTemplates(List<string> parted)
    {
        foreach (var entry in Root.GetProperty("templates").EnumerateArray())
        {
            var name = entry.GetProperty("name").GetString()!;
            var texts = entry.GetProperty("templates").EnumerateArray().Select((text) =>
            {
                return text.GetString()!;
            }).ToList();

            if (StringOf(entry, "refused") is { } refusal)
            {
                var parsed = RefusalOf<FormatException>(() =>
                {
                    HttpTemplate.Parse(texts[0]);
                });

                if (parsed != refusal)
                {
                    parted.Add($"templates: {name}: {parsed ?? "parsed"}");
                }

                continue;
            }

            var templates = texts.Select(HttpTemplate.Parse).ToList();

            if (entry.TryGetProperty("tie", out var tie))
            {
                if (templates[0].Ties(templates[1]) != tie.GetBoolean())
                {
                    parted.Add($"templates: {name}: tie {!tie.GetBoolean()}");
                }

                continue;
            }

            foreach (var path in entry.GetProperty("paths").EnumerateArray())
            {
                var raw = path.GetProperty("path").GetString()!;
                var split = HttpPath.Of(raw);
                var route = split is null ? null : HttpTemplate.Answering(templates, split);
                int? expected = path.GetProperty("route").ValueKind == JsonValueKind.Null ? null : path.GetProperty("route").GetInt32();

                if (route != expected)
                {
                    parted.Add($"templates: {name}: {raw} took {route?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "none"}");

                    continue;
                }

                if (route is not { } index)
                {
                    continue;
                }

                if (StringOf(path, "refused") is { } refused)
                {
                    var decoded = RefusalOf<JsonFormException>(() =>
                    {
                        templates[index].ValuesOf(split!);
                    });

                    if (decoded != refused)
                    {
                        parted.Add($"templates: {name}: {raw} {decoded ?? "decoded"}");
                    }

                    continue;
                }

                var values = templates[index].ValuesOf(split!);
                var variables = path.GetProperty("variables").EnumerateObject().ToDictionary((variable) =>
                {
                    return variable.Name;
                }, (variable) =>
                {
                    return variable.Value.GetString()!;
                });

                if (!values.OrderBy((value) =>
                {
                    return value.Key;
                }, StringComparer.Ordinal).SequenceEqual(variables.OrderBy((value) =>
                {
                    return value.Key;
                }, StringComparer.Ordinal)))
                {
                    parted.Add($"templates: {name}: {raw} gave {JsonSerializer.Serialize(values)}");
                }

                if (split!.Verb != StringOf(path, "verb"))
                {
                    parted.Add($"templates: {name}: {raw} split the verb {split.Verb}");
                }
            }
        }
    }

    private static void PlayReadings(List<string> parted)
    {
        foreach (var entry in Root.GetProperty("readings").EnumerateArray())
        {
            var name = entry.GetProperty("name").GetString()!;
            var descriptor = MessageOf(entry.GetProperty("message").GetString()!);
            var body = StringOf(entry, "body") is { } text ? Encoding.UTF8.GetBytes(text) : Hex(entry.GetProperty("bodyBytes").GetString()!);

            if (StringOf(entry, "refused") is { } reason)
            {
                var refusal = Refused(() =>
                {
                    Form.Read(descriptor, body);
                });

                if (refusal?.Message != reason)
                {
                    parted.Add($"readings: {name}: {refusal?.Message ?? "taken"}, where it is refused, {reason}");
                }

                // * where its reading met it, the body the request whole (7.4)
                if (refusal?.Pointer != StringOf(entry, "pointer"))
                {
                    parted.Add($"readings: {name}: met at {refusal?.Pointer ?? "no place"}");
                }

                continue;
            }

            var expected = Parsed(descriptor, Hex(entry.GetProperty("payload").GetString()!));

            try
            {
                var read = Form.Read(descriptor, body);

                if (!read.Equals(expected))
                {
                    parted.Add($"readings: {name}: read {Convert.ToHexString(read.ToByteArray())}");
                }
            }
            catch (JsonFormException refused)
            {
                parted.Add($"readings: {name}: refused, {refused.Message}");
            }
        }
    }

    private static void PlayWritings(List<string> parted)
    {
        foreach (var entry in Root.GetProperty("writings").EnumerateArray())
        {
            var name = entry.GetProperty("name").GetString()!;
            var descriptor = MessageOf(entry.GetProperty("message").GetString()!);
            var message = Parsed(descriptor, Hex(entry.GetProperty("payload").GetString()!));

            if (StringOf(entry, "refused") is { } reason)
            {
                var refusal = RefusalOf<JsonFormException>(() =>
                {
                    Form.Write(message);
                });

                if (refusal != reason)
                {
                    parted.Add($"writings: {name}: {refusal ?? "written"}, where it is refused, {reason}");
                }

                continue;
            }

            try
            {
                var written = Text(Form.Write(message));

                if (written != entry.GetProperty("body").GetString())
                {
                    parted.Add($"writings: {name}: wrote {written}");
                }
            }
            catch (JsonFormException refused)
            {
                parted.Add($"writings: {name}: refused, {refused.Message}");
            }
        }
    }

    private static void PlayBindings(List<string> parted)
    {
        var binding = new HttpBinding(Form);

        foreach (var entry in Root.GetProperty("bindings").EnumerateArray())
        {
            var name = entry.GetProperty("name").GetString()!;
            var procedure = RouteOf(entry.GetProperty("procedure").GetString()!);
            var given = entry.GetProperty("route");
            var rule = new HttpRouteTemplate
            {
                Method = given.GetProperty("method").GetString()!,
                Template = given.GetProperty("template").GetString()!,
                Body = StringOf(given, "body"),
            };
            var request = procedure.Request.Descriptor!;
            var target = entry.GetProperty("target").GetString()!;
            var question = target.IndexOf('?', StringComparison.Ordinal);
            var path = HttpPath.Of(question < 0 ? target : target[..question]);
            var template = HttpTemplate.Parse(rule.Template);

            if (path is null || !template.Matches(path))
            {
                parted.Add($"bindings: {name}: {target} is not of {rule.Template}");

                continue;
            }

            // * as its gateway binds it: its variables decoded first, a value that does not decode refused at its own
            IMessage Bind()
            {
                return binding.Bind(request, new BindingOptions
                {
                    Variables = template.ValuesOf(path),
                    Query = question < 0 ? null : target[(question + 1)..],
                    Body = StringOf(entry, "body") is { } body ? new ReadOnlyMemory<byte>(Encoding.UTF8.GetBytes(body)) : null,
                    RouteBody = rule.Body,
                    IsPatch = rule.Method == "PATCH",
                });
            }

            if (StringOf(entry, "refused") is { } reason)
            {
                var refusal = Refused(() =>
                {
                    Bind();
                });

                if (refusal?.Message != reason)
                {
                    parted.Add($"bindings: {name}: {refusal?.Message ?? "bound"}, where it is refused, {reason}");
                }

                // * where the request carried it (7.4)
                if (refusal?.Place != PlaceOf(entry))
                {
                    parted.Add($"bindings: {name}: placed at {refusal?.Place?.ToString() ?? "no place"}");
                }

                continue;
            }

            try
            {
                var bound = Bind();
                var expected = Parsed(request, Hex(entry.GetProperty("payload").GetString()!));

                if (!bound.Equals(expected))
                {
                    parted.Add($"bindings: {name}: bound {Convert.ToHexString(bound.ToByteArray())}");
                }
            }
            catch (JsonFormException refused)
            {
                parted.Add($"bindings: {name}: refused, {refused.Message}");
            }
        }
    }

    private static void PlayFailures(List<string> parted)
    {
        foreach (var entry in Root.GetProperty("failures").EnumerateArray())
        {
            var name = entry.GetProperty("name").GetString()!;
            var given = entry.GetProperty("failure");
            HttpProblem problem;

            if (StringOf(given, "own") is { } own)
            {
                problem = HttpProblems.Own(Enum.Parse<OwnFailure>(own, true), (StringOf(given, "detail")!, StringOf(given, "challenge") ?? Root.GetProperty("defaults").GetProperty("challenge").GetString()!));
            }
            else
            {
                var procedure = StringOf(entry, "procedure") is { } named ? RouteOf(named) : null;
                var route = entry.TryGetProperty("route", out var rule)
                    ? new HttpRouteTemplate { Method = rule.GetProperty("method").GetString()!, Template = rule.GetProperty("template").GetString()!, Body = StringOf(rule, "body") }
                    : null;
                var code = (ushort)given.GetProperty("code").GetInt32();
                var detail = StringOf(given, "detail") ?? "";
                var failure = StringOf(given, "scope") == "application"
                    ? Failure.OfApplication(code, detail)
                    : Failure.OfProtocol((ProtocolCode)code, detail);
                var context = new ProblemContext
                {
                    Arose = Enum.Parse<FailureArising>(given.GetProperty("arose").GetString()!, true),
                    Encoding = StringOf(given, "encoding") is { } encoding ? Enum.Parse<HttpEncoding>(encoding, true) : HttpEncoding.Proto,
                    Credential = given.TryGetProperty("credential", out _),
                    Challenge = StringOf(given, "challenge") ?? Root.GetProperty("defaults").GetProperty("challenge").GetString()!,
                    ProblemTypes = entry.TryGetProperty("problemTypes", out var types) ? types.GetString() : Root.GetProperty("defaults").GetProperty("problemTypes").GetString(),
                    Failures = RouteOf("fail").Failures,
                    Request = procedure?.Request.Descriptor,
                    Rule = route,
                    Place = PlaceOf(given),
                };

                problem = HttpProblems.Of(failure, context);
            }

            var fields = entry.GetProperty("fields").EnumerateObject().ToDictionary((field) =>
            {
                return field.Name;
            }, (field) =>
            {
                return field.Value.GetString()!;
            });

            if (problem.Status != entry.GetProperty("status").GetInt32())
            {
                parted.Add($"failures: {name}: status {problem.Status}");
            }

            if (!problem.Fields.OrderBy((field) =>
            {
                return field.Key;
            }, StringComparer.Ordinal).SequenceEqual(fields.OrderBy((field) =>
            {
                return field.Key;
            }, StringComparer.Ordinal)))
            {
                parted.Add($"failures: {name}: fields {JsonSerializer.Serialize(problem.Fields)}");
            }

            if (Text(problem.Body) != entry.GetProperty("problem").GetString())
            {
                parted.Add($"failures: {name}: problem {Text(problem.Body)}");
            }
        }
    }

    private static async Task PlayEvents(List<string> parted)
    {
        foreach (var entry in Root.GetProperty("events").EnumerateArray())
        {
            var name = entry.GetProperty("name").GetString()!;
            var written = new List<byte>();
            var events = new HttpEvents((bytes) =>
            {
                written.AddRange(bytes.ToArray());

                return Task.CompletedTask;
            });
            var (status, contentType, body) = (200, "text/event-stream", "");

            foreach (var step in entry.GetProperty("steps").EnumerateArray())
            {
                var (kind, value) = step.EnumerateObject().Select((member) =>
                {
                    return (member.Name, member.Value);
                }).Single();

                switch (kind)
                {
                    case "result":
                        await events.Result(DataOf(value));
                        break;
                    case "notification":
                        // ! held before its result: its task settles once written, so it is not awaited
                        _ = events.Notification(DataOf(value));
                        break;
                    case "heartbeat":
                        await events.Heartbeat();
                        break;
                    default:
                        var problem = Encoding.UTF8.GetBytes(value.GetProperty("problem").GetString()!);

                        if (events.Failure(problem, out var ending))
                        {
                            await ending;
                        }
                        else
                        {
                            (status, contentType, body) = (value.GetProperty("status").GetInt32(), HttpProblems.MediaType, Text(problem));
                        }

                        break;
                }
            }

            if (status == 200)
            {
                body = Text(written.ToArray());
            }

            if ((status, contentType, body) != (entry.GetProperty("status").GetInt32(), entry.GetProperty("contentType").GetString(), entry.GetProperty("body").GetString()))
            {
                parted.Add($"events: {name}: {status} {contentType} {body}");
            }
        }
    }

    // an event's data as the file gives it: a JSON text as it is, a text, or bytes in hexadecimal
    private static ReadOnlyMemory<byte> DataOf(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            return HttpEvents.DataOf(HttpPayload.Json, (Encoding.UTF8.GetBytes(value.GetString()!), Form));
        }

        if (value.TryGetProperty("text", out var text))
        {
            return HttpEvents.DataOf(HttpPayload.Text, (Encoding.UTF8.GetBytes(text.GetString()!), Form));
        }

        return HttpEvents.DataOf(HttpPayload.Raw, (Hex(value.GetProperty("raw").GetString()!), Form));
    }

    // the words `act` is refused in, as its refusal's message; none where it is taken
    private static string? RefusalOf<TException>(Action act)
        where TException : Exception
    {
        try
        {
            act();

            return null;
        }
        catch (TException refused)
        {
            return refused.Message;
        }
    }

    // the refusal `act` throws; none where it is taken
    private static JsonFormException? Refused(Action act)
    {
        try
        {
            act();

            return null;
        }
        catch (JsonFormException refused)
        {
            return refused;
        }
    }

    // where a request carried what its reading refused, as an entry writes it (7.4)
    private static RequestPlace? PlaceOf(JsonElement entry)
    {
        var parameter = StringOf(entry, "parameter");
        var pointer = StringOf(entry, "pointer");

        return parameter is null && pointer is null ? null : new RequestPlace { Parameter = parameter, Pointer = pointer };
    }
}
