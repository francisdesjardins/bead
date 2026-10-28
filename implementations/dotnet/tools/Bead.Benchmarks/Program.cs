using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using Bead.Interop;
using Bead.Tests;
using Bead.Transcoding.V1;
using Bead.Transport.Http;
using Bead.Transport.WebSockets;
using Google.Protobuf;

namespace Bead.Benchmarks;

/// <summary>Loopback measurements in bead-bench/1, as the TypeScript bench and the root README define them.</summary>
internal static class Program
{
    private const int Concurrency = 32;
    private const int MemoryCalls = 2_000;
    private const int TransferSize = 20 * 1_048_576;
    private static readonly string[] NetworkTransports = ["http", "websocket"];
    private static readonly int[] Sizes = [0, 1_024, 65_536];
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };

    private sealed record Options
    {
        public int Runs { get; init; } = 3;
        public int Seconds { get; init; } = 3;
        public bool Json { get; init; }
        public bool TranscodingOnly { get; init; }
        public string? Filter { get; init; }
    }

    private sealed record Dimensions
    {
        public string Scenario { get; init; } = "local";
        public string Transport { get; init; } = "none";
        public int SizeBytes { get; init; }
        public string Unit { get; init; } = "us";
    }

    private sealed record Measure
    {
        public required string Id { get; init; }
        public required string Name { get; init; }
        public required string Scenario { get; init; }
        public required string Transport { get; init; }
        public int SizeBytes { get; init; }
        public required string Unit { get; init; }
        public required string Direction { get; init; }
        public required double[] Samples { get; init; }
        public double Median { get; init; }
        public double Min { get; init; }
        public double Max { get; init; }
    }

    private sealed class Measurements(string? filter)
    {
        private readonly Dictionary<(string Name, Dimensions Dimensions), List<double>> _values = [];

        public bool Wants(string name, Dimensions? dimensions = null)
        {
            var row = dimensions ?? new Dimensions();
            return filter is null || filter == name || filter == $"{row.Scenario}.{row.Transport}.{row.SizeBytes}.{name}";
        }

        public bool WantsAny(string[] names, Dimensions? dimensions = null)
        {
            return names.Any((name) => { return Wants(name, dimensions); });
        }

        public bool WantsCalls(Dimensions dimensions, string measure = "call")
        {
            return Sizes.Any((size) =>
            {
                return WantsAny([$"{measure}.p50", $"{measure}.p95", $"{measure}.p99", $"{measure}.memory", $"{measure}.throughput"], dimensions with { SizeBytes = size });
            });
        }

        public bool WantsNotifications(string transport)
        {
            return WantsAny(["notification.p50", "notification.p95", "notification.p99", "notification.throughput"], new Dimensions { Transport = transport });
        }

        public bool WantsTransfer(string transport)
        {
            return WantsAny(["transfer.echo", "transfer.throughput"], new Dimensions { Transport = transport, SizeBytes = TransferSize });
        }

        public void Record(string name, double value, Dimensions? dimensions = null)
        {
            if (!Wants(name, dimensions))
            {
                return;
            }

            if (!double.IsFinite(value) || value < 0)
            {
                throw new InvalidOperationException($"non-finite or negative measurement: {name}");
            }

            var key = (name, dimensions ?? new Dimensions());
            if (!_values.TryGetValue(key, out var samples))
            {
                samples = [];
                _values.Add(key, samples);
            }

            samples.Add(value);
        }

        public Measure[] Summarize()
        {
            return _values.Select((pair) =>
            {
                var (name, row) = pair.Key;
                var sorted = pair.Value.Order().ToArray();
                var middle = sorted.Length / 2;
                var median = sorted.Length % 2 == 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
                return new Measure
                {
                    Id = $"{row.Scenario}.{row.Transport}.{row.SizeBytes}.{name}",
                    Name = name,
                    Scenario = row.Scenario,
                    Transport = row.Transport,
                    SizeBytes = row.SizeBytes,
                    Unit = row.Unit,
                    Direction = row.Unit.EndsWith("/s", StringComparison.Ordinal) ? "higher" : "lower",
                    Samples = [.. pair.Value],
                    Median = median,
                    Min = sorted[0],
                    Max = sorted[^1],
                };
            }).ToArray();
        }
    }

    private static Options Parse(string[] args)
    {
        var options = new Options();
        for (var at = 0; at < args.Length; at++)
        {
            var flag = args[at];
            if (flag == "--transcoding")
            {
                options = options with { TranscodingOnly = true };
            }
            else if (flag == "--json")
            {
                options = options with { Json = true };
            }
            else if (flag == "--filter")
            {
                if (++at >= args.Length || string.IsNullOrEmpty(args[at]) || args[at].StartsWith("--", StringComparison.Ordinal) || options.Filter is not null)
                {
                    throw new ArgumentException("--filter requires one id or name");
                }

                options = options with { Filter = args[at] };
            }
            else if (flag is "--runs" or "--seconds")
            {
                if (++at >= args.Length || !int.TryParse(args[at], CultureInfo.InvariantCulture, out var value) || value < 1)
                {
                    throw new ArgumentException($"{flag} requires a positive integer");
                }

                options = flag == "--runs" ? options with { Runs = value } : options with { Seconds = value };
            }
            else
            {
                throw new ArgumentException($"unknown argument: {flag}");
            }
        }

        return options;
    }

    private static double Percentile(List<double> sorted, double share)
    {
        return sorted[Math.Min(sorted.Count - 1, (int)(sorted.Count * share))];
    }

    private static double Codec(Action once, (int Batch, int Seconds) options)
    {
        for (var index = 0; index < 5_000; index++)
        {
            once();
        }

        var rounds = 0L;
        var clock = Stopwatch.StartNew();
        while (clock.Elapsed.TotalSeconds < options.Seconds)
        {
            for (var index = 0; index < options.Batch; index++)
            {
                once();
            }

            rounds += options.Batch;
        }

        return clock.Elapsed.TotalMilliseconds * 1_000_000 / rounds;
    }

    // Bead's mapping of protobuf's JSON against the stock library's, JsonParser and JsonFormatter, on
    // transcoding.json's message of every kind of field, as a gateway reads a request and writes a
    // result: a body read to its message's bytes, and bytes written to a body (decision 0037)
    private static void Transcoding(Measurements results, int seconds)
    {
        using var file = JsonDocument.Parse(File.ReadAllText(Path.Combine(Root(), "spec", "transcoding.json")));
        var every = file.RootElement.GetProperty("writings").EnumerateArray().First((entry) =>
        {
            return entry.GetProperty("message").GetString() == "bead.transcoding.v1.Everything" && entry.TryGetProperty("body", out _);
        });
        var payload = Convert.FromHexString(every.GetProperty("payload").GetString()!.Replace(" ", "", StringComparison.Ordinal));
        var form = new Transcoding.JsonForm([Everything.Descriptor]);
        var body = form.Write(Everything.Parser.ParseFrom(payload));
        var row = new Dimensions { SizeBytes = body.Length, Unit = "ns" };

        if (results.Wants("transcoding.read.bead", row))
        {
            results.Record("transcoding.read.bead", Codec(() =>
            {
                _ = form.Read(Everything.Descriptor, body).ToByteArray();
            }, (100, seconds)), row);
        }
        if (results.Wants("transcoding.read.stock", row))
        {
            results.Record("transcoding.read.stock", Codec(() =>
            {
                _ = JsonParser.Default.Parse<Everything>(System.Text.Encoding.UTF8.GetString(body)).ToByteArray();
            }, (100, seconds)), row);
        }
        if (results.Wants("transcoding.write.bead", row))
        {
            results.Record("transcoding.write.bead", Codec(() =>
            {
                _ = form.Write(Everything.Parser.ParseFrom(payload));
            }, (100, seconds)), row);
        }
        if (results.Wants("transcoding.write.stock", row))
        {
            results.Record("transcoding.write.stock", Codec(() =>
            {
                _ = System.Text.Encoding.UTF8.GetBytes(JsonFormatter.Default.Format(Everything.Parser.ParseFrom(payload)));
            }, (100, seconds)), row);
        }

    }

    private static void Codecs(Measurements results, int seconds)
    {
        foreach (var size in Sizes)
        {
            var envelope = new Envelope
            {
                Header = new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 1, DestinationId = 1 },
                Payload = new byte[size],
            };
            var limits = new EnvelopeReadOptions { Side = RouterSide.Server, MaximumEnvelopeBytes = LimitDefaults.MaximumEnvelopeBytes };
            var row = new Dimensions { SizeBytes = size, Unit = "ns" };
            if (results.Wants("codec.roundTrip", row))
            {
                results.Record("codec.roundTrip", Codec(() =>
                {
                    _ = EnvelopeCodec.ReadEnvelope(EnvelopeCodec.WriteEnvelope(envelope), limits);
                }, (1_000, seconds)), row);
            }
            var body = JsonSerializer.SerializeToElement(new string('x', size));
            if (results.Wants("json.roundTrip", row))
            {
                results.Record("json.roundTrip", Codec(() =>
                {
                    _ = PayloadCodecs.Json.Decode(PayloadCodecs.Json.Encode(body));
                }, (100, seconds)), row);
            }
        }
    }

    private sealed class Connection(IClient client, IBeadServer<string>? server) : IAsyncDisposable
    {
        public IClient Client { get; } = client;
        public IBeadServer<string>? Server { get; } = server;
        public InteropClient Interop { get; } = new(client);

        public async ValueTask DisposeAsync()
        {
            try
            {
                await Client.DisposeAsync();
            }
            finally
            {
                if (Server is not null)
                {
                    await Server.DisposeAsync();
                }
            }
        }
    }

    private sealed record ConnectOptions(int? Port = null, bool Large = false);

    // A client over the in-memory transport: its router and services on a transport client of its own.
    private sealed class MemoryClient : IClient
    {
        public MemoryClient()
        {
            Transport = new MemoryTransportClient();
            Router = new RouterClient(Transport);
            Services = new ServiceManager(Router);
        }

        public MemoryTransportClient Transport { get; }

        public RouterClient Router { get; }

        public ServiceManager Services { get; }

        public Task Connect(MemoryTransportServer server)
        {
            return Transport.Connect(new MemoryConnectOptions { Server = server, Address = "127.0.0.1", Port = 50_000 });
        }

        public Task Disconnect(TransportDisconnectOptions? options = null)
        {
            return Transport.CloseConnection(options);
        }

        public Task Reconnect(TransportReconnectOptions? options = null)
        {
            return Transport.Reconnect(options);
        }

        public async ValueTask DisposeAsync()
        {
            Router.Dispose();
            await Transport.DisposeAsync();
        }
    }

    // A server of the interop service over the in-memory transport, started.
    private static async Task<(Server<string> Server, MemoryTransportServer Transport)> MemoryServer()
    {
        var transport = new MemoryTransportServer();
        var server = new Server<string>(transport);
        InteropHandlers.Offer(server);
        await transport.Start();
        return (server, transport);
    }

    private static async Task<Connection> Connect(string transport, ConnectOptions? options = null)
    {
        var settings = options ?? new ConnectOptions();
        var limits = settings.Large ? new RouterLimits
        {
            MaximumPayloadBytes = 32 * 1_048_576,
            MaximumEnvelopeBytes = transport == "http" ? 32 * 1_048_576 : LimitDefaults.MaximumEnvelopeBytes,
        } : null;
        IBeadServer<string>? server = null;
        IClient? client = null;
        try
        {
            if (transport == "memory")
            {
                var (memory, listening) = await MemoryServer();
                server = memory;
                var inMemory = new MemoryClient();
                client = inMemory;
                await inMemory.Connect(listening);
                return new Connection(client, server);
            }

            var port = settings.Port;
            if (port is null)
            {
                if (transport == "http")
                {
                    var http = new HttpServer<string>(new HttpServerOptions { Server = new ServerOptions { Limits = limits } });
                    server = http;
                    InteropHandlers.Offer(server);
                    port = (await http.Transport.Start(new HttpTransportStartOptions { Address = "127.0.0.1", FindOpenPort = true })).Port;
                }
                else
                {
                    var ws = new WebSocketServer<string>(new WebSocketServerOptions { Server = new ServerOptions { Limits = limits } });
                    server = ws;
                    InteropHandlers.Offer(server);
                    port = (await ws.Transport.Start(new WebSocketTransportStartOptions { Address = "127.0.0.1", FindOpenPort = true })).Port;
                }
            }

            if (transport == "http")
            {
                var http = new BeadHttpClient(new BeadHttpClientOptions { Limits = limits });
                client = http;
                await http.Connect(new HttpConnectOptions { Host = "127.0.0.1", Port = port.Value });
            }
            else
            {
                var ws = new WebSocketClient(new WebSocketClientOptions { Limits = limits });
                client = ws;
                await ws.Connect(new WebSocketConnectOptions { Host = "127.0.0.1", Port = port.Value });
            }

            return new Connection(client, server);
        }
        catch
        {
            if (client is not null)
            {
                await client.DisposeAsync();
            }

            if (server is not null)
            {
                await server.DisposeAsync();
            }

            throw;
        }
    }

    private static async Task Calls(Connection connection, (Measurements Results, Dimensions Row, int Seconds) options)
    {
        foreach (var size in Sizes)
        {
            var body = JsonSerializer.SerializeToElement(new string('x', size));
            var row = options.Row with { SizeBytes = size };
            if (!options.Results.WantsAny(["call.p50", "call.p95", "call.p99", "call.memory", "call.throughput"], row))
            {
                continue;
            }

            Task<JsonElement> Call()
            {
                return connection.Interop.Echo(body)();
            }

            for (var index = 0; index < 500; index++)
            {
                _ = await Call();
            }

            await Console.Error.WriteLineAsync($"calls {row.Scenario}/{row.Transport}/{size}");
            if (options.Results.WantsAny(["call.p50", "call.p95", "call.p99"], row))
            {
                var durations = new List<double>();
                var clock = Stopwatch.StartNew();
                while (clock.Elapsed.TotalSeconds < options.Seconds)
                {
                    var before = Stopwatch.GetTimestamp();
                    _ = await Call();
                    durations.Add(Stopwatch.GetElapsedTime(before).TotalMicroseconds);
                }

                durations.Sort();
                foreach (var share in new[] { 0.5, 0.95, 0.99 })
                {
                    options.Results.Record($"call.p{share * 100}", Percentile(durations, share), row);
                }
            }

            if (options.Results.Wants("call.memory", row))
            {
                // Process-wide managed allocations include both endpoints only in the local scenario.
                var allocatedBefore = GC.GetTotalAllocatedBytes(true);
                for (var index = 0; index < MemoryCalls; index++)
                {
                    _ = await Call();
                }

                var allocated = (GC.GetTotalAllocatedBytes(true) - allocatedBefore) / (double)MemoryCalls;
                options.Results.Record("call.memory", allocated, row with { Unit = "B/call" });
            }

            if (options.Results.Wants("call.throughput", row))
            {
                var done = 0L;
                var clock = Stopwatch.StartNew();
                while (clock.Elapsed.TotalSeconds < options.Seconds)
                {
                    await Task.WhenAll(Enumerable.Range(0, Concurrency).Select((_) => { return Call(); }));
                    done += Concurrency;
                }

                options.Results.Record("call.throughput", done / clock.Elapsed.TotalSeconds, row with { Unit = "calls/s" });
            }
        }
    }

    // * What a gateway pays per HTTP exchange (decision 0036): a client drawn, connected, called once
    // and closed over the in-memory transport, against calls on one connection kept, which Calls
    // measures over the same transport.
    private static async Task Exchanges((Measurements Results, int Seconds) options)
    {
        var (server, transport) = await MemoryServer();
        await using var serving = server;
        foreach (var size in Sizes)
        {
            var body = JsonSerializer.SerializeToElement(new string('x', size));
            var row = new Dimensions { Transport = "memory", SizeBytes = size };
            if (!options.Results.WantsAny(["exchange.p50", "exchange.p95", "exchange.p99", "exchange.memory", "exchange.throughput"], row))
            {
                continue;
            }

            async Task Exchange()
            {
                await using var client = new MemoryClient();
                await client.Connect(transport);
                _ = await new InteropClient(client).Echo(body)();
                await client.Disconnect();
            }

            for (var index = 0; index < 500; index++)
            {
                await Exchange();
            }

            await Console.Error.WriteLineAsync($"exchanges local/memory/{size}");
            if (options.Results.WantsAny(["exchange.p50", "exchange.p95", "exchange.p99"], row))
            {
                var durations = new List<double>();
                var clock = Stopwatch.StartNew();
                while (clock.Elapsed.TotalSeconds < options.Seconds)
                {
                    var before = Stopwatch.GetTimestamp();
                    await Exchange();
                    durations.Add(Stopwatch.GetElapsedTime(before).TotalMicroseconds);
                }

                durations.Sort();
                foreach (var share in new[] { 0.5, 0.95, 0.99 })
                {
                    options.Results.Record($"exchange.p{share * 100}", Percentile(durations, share), row);
                }
            }

            if (options.Results.Wants("exchange.memory", row))
            {
                var allocatedBefore = GC.GetTotalAllocatedBytes(true);
                for (var index = 0; index < MemoryCalls; index++)
                {
                    await Exchange();
                }

                var allocated = (GC.GetTotalAllocatedBytes(true) - allocatedBefore) / (double)MemoryCalls;
                options.Results.Record("exchange.memory", allocated, row with { Unit = "B/exchange" });
            }

            if (options.Results.Wants("exchange.throughput", row))
            {
                var done = 0L;
                var clock = Stopwatch.StartNew();
                while (clock.Elapsed.TotalSeconds < options.Seconds)
                {
                    await Task.WhenAll(Enumerable.Range(0, Concurrency).Select((_) => { return Exchange(); }));
                    done += Concurrency;
                }

                options.Results.Record("exchange.throughput", done / clock.Elapsed.TotalSeconds, row with { Unit = "exchanges/s" });
            }
        }
    }

    private static async Task Notifications(Connection connection, (Measurements Results, string Transport, int Seconds) options)
    {
        var procedure = new Procedure { ServiceId = 2, ServiceRevision = 1, ProcedureId = 1, ProcedureName = "cadence" };
        var serializer = new JsonPayloads();
        var resolver = connection.Server!.Services.GetNotificationResolver(procedure,
            new NotificationResolverDependencies<JsonElement, JsonElement, JsonElement> { Serializer = serializer })((_request, response) =>
        {
            return response.Answer(JsonSerializer.SerializeToElement<object?>(null));
        });
        var durations = new List<double>();
        var notification = connection.Client.Services.GetNotification(procedure,
            new NotificationDependencies<JsonElement, JsonElement, JsonElement> { Serializer = serializer, Window = Concurrency });
        var sent = 0;
        var sending = true;
        var gate = new Lock();
        using var room = new SemaphoreSlim(Concurrency, Concurrency);
        using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(options.Seconds + 30.0));
        var drained = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var registration = await notification.Register(JsonSerializer.SerializeToElement<object?>(null), (timestamp) =>
        {
            var elapsed = Stopwatch.GetElapsedTime(timestamp.GetInt64()).TotalMicroseconds;
            lock (gate)
            {
                durations.Add(elapsed);
                if (!sending && durations.Count == sent)
                {
                    drained.TrySetResult();
                }
            }

            room.Release();
            return Task.CompletedTask;
        })();
        var clock = Stopwatch.StartNew();
        var due = 0.0;
        var end = options.Seconds * 1_000.0;
        // * A late wake-up catches up to every due value; at most 32 await their handlers.
        while (due < end)
        {
            while (due < end && due <= clock.Elapsed.TotalMilliseconds)
            {
                await room.WaitAsync(patience.Token);
                lock (gate)
                {
                    sent++;
                }

                await resolver.Notify(JsonSerializer.SerializeToElement(Stopwatch.GetTimestamp()));
                due += 1;
            }

            var pause = due - clock.Elapsed.TotalMilliseconds;
            if (due < end && pause > 0)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Ceiling(pause)), patience.Token);
            }
        }

        lock (gate)
        {
            sending = false;
            if (durations.Count == sent)
            {
                drained.TrySetResult();
            }
        }

        await drained.Task.WaitAsync(patience.Token);
        var elapsedSeconds = clock.Elapsed.TotalSeconds;
        durations.Sort();
        var row = new Dimensions { Transport = options.Transport };
        foreach (var share in new[] { 0.5, 0.95, 0.99 })
        {
            options.Results.Record($"notification.p{share * 100}", Percentile(durations, share), row);
        }

        options.Results.Record("notification.throughput", durations.Count / elapsedSeconds, row with { Unit = "notifications/s" });
    }

    private static async Task Transfer(Connection connection, (Measurements Results, string Transport, int Seconds) options)
    {
        var body = JsonSerializer.SerializeToElement(new string('x', TransferSize));
        Task<JsonElement> Call()
        {
            return connection.Interop.Echo(body)(new RequestOptions { Timeout = TimeSpan.FromSeconds(30) });
        }

        if ((await Call()).GetString() != body.GetString())
        {
            throw new InvalidOperationException("large echo differs from its payload");
        }

        var clock = Stopwatch.StartNew();
        var done = 0;
        do
        {
            _ = await Call();
            done++;
        }
        while (clock.Elapsed.TotalSeconds < options.Seconds);

        var milliseconds = clock.Elapsed.TotalMilliseconds / done;
        var row = new Dimensions { Transport = options.Transport, SizeBytes = TransferSize };
        options.Results.Record("transfer.echo", milliseconds, row with { Unit = "ms" });
        options.Results.Record("transfer.throughput", 40 * 1_000 / milliseconds, row with { Unit = "MiB/s" });
    }

    private static string Root()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "spec", "spec.md")))
            {
                return directory.FullName;
            }
        }

        throw new DirectoryNotFoundException("no spec/spec.md above this bench");
    }

    private sealed record ProcessOptions(string Directory);

    private static Process Start(string executable, string[] args, ProcessOptions? options = null)
    {
        var start = new ProcessStartInfo(executable)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = options?.Directory ?? Root(),
        };
        foreach (var arg in args)
        {
            start.ArgumentList.Add(arg);
        }

        return Process.Start(start) ?? throw new InvalidOperationException($"{executable} does not start");
    }

    private static async Task<string> Output(string executable, string[] args)
    {
        using var process = Start(executable, args);
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"{executable} exits {process.ExitCode}: {await error}");
        }

        return (await output).Trim();
    }

    private sealed class InteropProcess(Process process, (int Port, int HttpPort) ports) : IAsyncDisposable
    {
        public (int Port, int HttpPort) Ports { get; } = ports;

        public async ValueTask DisposeAsync()
        {
            process.StandardInput.Close();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
            finally
            {
                process.Dispose();
            }
        }

        public static async Task<InteropProcess> Create()
        {
            var process = Start("node", ["interop/serve.ts"], new ProcessOptions(Path.Combine(Root(), "implementations", "typescript")));
            process.ErrorDataReceived += (_, line) =>
            {
                if (line.Data is not null)
                {
                    Console.Error.WriteLine(line.Data);
                }
            };
            process.BeginErrorReadLine();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(180));
            try
            {
                while (await process.StandardOutput.ReadLineAsync(timeout.Token) is { } line)
                {
                    try
                    {
                        using var document = JsonDocument.Parse(line);
                        if (document.RootElement.TryGetProperty("port", out var port) && document.RootElement.TryGetProperty("httpPort", out var httpPort))
                        {
                            return new InteropProcess(process, (port.GetInt32(), httpPort.GetInt32()));
                        }
                    }
                    catch (JsonException)
                    {
                        // A launcher's build output comes before its ports.
                    }
                }

                throw new InvalidOperationException("the TypeScript interop server ends before it reports its ports");
            }
            catch
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }

                await process.WaitForExitAsync();
                process.Dispose();
                throw;
            }
        }
    }

    private static async Task Main(string[] args)
    {
        var options = Parse(args);
        var results = new Measurements(options.Filter);
        var needsInterop = !options.TranscodingOnly && NetworkTransports.Any((transport) =>
        {
            return results.WantsCalls(new Dimensions { Scenario = "interop", Transport = transport });
        });
        await using var remote = needsInterop ? await InteropProcess.Create() : null;
        for (var run = 0; run < options.Runs; run++)
        {
            await Console.Error.WriteLineAsync($"run {run + 1}/{options.Runs}");
            Transcoding(results, options.Seconds);

            if (options.TranscodingOnly)
            {
                continue;
            }

            Codecs(results, options.Seconds);
            foreach (var transport in new[] { "websocket", "http" })
            {
                foreach (var scenario in new[] { "local", "interop" })
                {
                    if (!results.WantsCalls(new Dimensions { Scenario = scenario, Transport = transport }) && !(scenario == "local" && results.WantsNotifications(transport)))
                    {
                        continue;
                    }

                    var port = scenario == "interop" ? (int?)(transport == "http" ? remote!.Ports.HttpPort : remote!.Ports.Port) : null;
                    await using var connection = await Connect(transport, new ConnectOptions(Port: port));
                    await Calls(connection, (results, new Dimensions { Scenario = scenario, Transport = transport }, options.Seconds));
                    if (scenario == "local" && results.WantsNotifications(transport))
                    {
                        await Notifications(connection, (results, transport, options.Seconds));
                    }
                }

                if (results.WantsTransfer(transport))
                {
                    await using var large = await Connect(transport, new ConnectOptions(Large: true));
                    await Transfer(large, (results, transport, options.Seconds));
                }
            }

            if (results.WantsCalls(new Dimensions { Transport = "memory" }))
            {
                await using var memory = await Connect("memory");
                await Calls(memory, (results, new Dimensions { Transport = "memory" }, options.Seconds));
            }

            if (results.WantsCalls(new Dimensions { Transport = "memory" }, "exchange"))
            {
                await Exchanges((results, options.Seconds));
            }
        }

        var node = JsonSerializer.Deserialize<JsonElement>(await Output("node", ["-p", "JSON.stringify({node:process.versions.node,v8:process.versions.v8,cpu:require('node:os').cpus()[0].model.trim(),count:require('node:os').cpus().length,platform:require('node:os').platform(),release:require('node:os').release(),architecture:require('node:os').arch()})"]));
        var measures = results.Summarize();
        if (measures.Length == 0)
        {
            throw new ArgumentException($"filter matches no measurement: {options.Filter}");
        }
        var report = new
        {
            Schema = "bead-bench/1",
            Side = "csharp",
            Environment = new
            {
                Cpu = new { Model = node.GetProperty("cpu").GetString(), Count = node.GetProperty("count").GetInt32() },
                Os = new { Platform = node.GetProperty("platform").GetString(), Release = node.GetProperty("release").GetString(), Architecture = node.GetProperty("architecture").GetString() },
                Runtimes = new { Node = node.GetProperty("node").GetString(), V8 = node.GetProperty("v8").GetString(), Dotnet = await Output("dotnet", ["--list-runtimes"]), DotnetSdk = await Output("dotnet", ["--version"]), Clr = RuntimeInformation.FrameworkDescription },
                Commit = await Output("git", ["rev-parse", "HEAD"]),
            },
            Method = new
            {
                options.Runs,
                options.Filter,
                options.Seconds,
                Concurrency,
                NotificationIntervalMs = 1,
                NotificationWindow = Concurrency,
                MemoryCalls,
                Memory = new
                {
                    Method = "gc-total-allocated-bytes",
                    Scope = "local: client and server; interop: client process only",
                    Limitations = "Process-wide managed heap bytes allocated per call, including transient allocations and background work. Excludes native allocations and the remote server.",
                },
                Transfer = "20 MiB JSON echo; websocket: chunks; http: whole envelope, 32 MiB limit; MiB/s counts both directions",
                Interop = "calls only; normal interop server launcher, Release configuration",
                MemoryTransport = "local only: calls on one in-memory connection kept, and exchanges, each a client and its connection drawn, called once and closed",
            },
            Measures = measures,
        };
        if (options.Json)
        {
            Console.WriteLine(JsonSerializer.Serialize(report, JsonOptions));
        }
        else
        {
            Console.WriteLine(JsonSerializer.Serialize(new { report.Schema, report.Side, report.Environment, report.Method }, JsonOptions));
            Console.WriteLine("\n| measure | unit | median | min | max |\n| --- | --- | --- | --- | --- |");
            foreach (var row in measures)
            {
                Console.WriteLine(string.Create(CultureInfo.InvariantCulture, $"| {row.Id} | {row.Unit} | {row.Median:F3} | {row.Min:F3} | {row.Max:F3} |"));
            }
        }
    }
}
