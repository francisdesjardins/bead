using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using Bead.Interop;
using Bead.Tests;
using Bead.Transport.WebSockets;

namespace Bead.Benchmarks;

/// <summary>
/// A measurement of the C# side, in the units of the TypeScript side's <c>tools/bench.mjs</c>: the
/// envelope codec, a request written and read back, and the json payload codec, a string of the
/// payload's size encoded and decoded, at payloads of 0 B, 1 KiB and 64 KiB, in nanoseconds a round
/// trip; a call, the interop service's <c>echo</c> over a WebSocket on the loopback, its latency
/// one call at a time (p50, p95, p99, in microseconds), its throughput 32 calls at a time and the
/// bytes it allocates; and a transfer, the same echo of 20 MiB. The echo carries a JSON string of
/// the payload's size through the json codec, as the TypeScript side's does. Run with
/// <c>dotnet run -c Release -- [--seconds 3]</c>.
/// </summary>
internal static class Program
{
    // constants

    private const int Concurrency = 32;
    private static readonly int[] Sizes = [0, 1_024, 65_536];

    // helpers

    private static double Percentile(List<double> sorted, double share)
    {
        return sorted[Math.Min(sorted.Count - 1, (int)(sorted.Count * share))];
    }

    private static double CodecNanoseconds(int size, int seconds)
    {
        var envelope = new Envelope
        {
            Header = new RequestHeader { CallId = 1, ServiceId = 1, ProcedureId = 2, DestinationId = 1 },
            Payload = new byte[size],
        };
        var options = new EnvelopeReadOptions { Side = RouterSide.Server, MaximumEnvelopeBytes = LimitDefaults.MaximumEnvelopeBytes };

        for (var index = 0; index < 5_000; index++)
        {
            _ = EnvelopeCodec.ReadEnvelope(EnvelopeCodec.WriteEnvelope(envelope), options);
        }

        var rounds = 0L;
        var clock = Stopwatch.StartNew();

        while (clock.Elapsed.TotalSeconds < seconds)
        {
            for (var index = 0; index < 1_000; index++)
            {
                _ = EnvelopeCodec.ReadEnvelope(EnvelopeCodec.WriteEnvelope(envelope), options);
            }

            rounds += 1_000;
        }

        return clock.Elapsed.TotalMilliseconds * 1_000_000 / rounds;
    }

    private static double JsonNanoseconds(int size, int seconds)
    {
        using var document = JsonDocument.Parse($"\"{new string('x', size)}\"");
        var value = document.RootElement.Clone();

        for (var index = 0; index < 5_000; index++)
        {
            _ = PayloadCodecs.Json.Decode(PayloadCodecs.Json.Encode(value));
        }

        var rounds = 0L;
        var clock = Stopwatch.StartNew();

        while (clock.Elapsed.TotalSeconds < seconds)
        {
            for (var index = 0; index < 100; index++)
            {
                _ = PayloadCodecs.Json.Decode(PayloadCodecs.Json.Encode(value));
            }

            rounds += 100;
        }

        return clock.Elapsed.TotalMilliseconds * 1_000_000 / rounds;
    }

    private static async Task<List<string>> Calls(int seconds)
    {
        var rows = new List<string>();
        var transport = new WebSocketTransportServer();
        await using var server = new Server<string>(transport);

        InteropHandlers.Offer(server);

        var port = (await transport.Start(new WebSocketTransportStartOptions { Address = "127.0.0.1", FindOpenPort = true })).Port;

        await using var client = new WebSocketClient();

        await client.Connect(new WebSocketConnectOptions { Host = "127.0.0.1", Port = port });

        var echo = client.Services.GetRequest(
            InteropProcedures.Echo.Procedure,
            new RequestDependencies<JsonElement, JsonElement> { Serializer = new JsonPayloads() });

        foreach (var size in Sizes)
        {
            using var document = JsonDocument.Parse($"\"{new string('x', size)}\"");
            var body = document.RootElement.Clone();

            for (var index = 0; index < 500; index++)
            {
                _ = await echo(body)();
            }

            var durations = new List<double>();
            var clock = Stopwatch.StartNew();

            while (clock.Elapsed.TotalSeconds < seconds)
            {
                var started = Stopwatch.GetTimestamp();

                _ = await echo(body)();
                durations.Add(Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            }

            durations.Sort();

            // client and server together, both in this process
            var before = GC.GetTotalAllocatedBytes(true);

            for (var index = 0; index < 2_000; index++)
            {
                _ = await echo(body)();
            }

            var allocated = (GC.GetTotalAllocatedBytes(true) - before) / 2_000;

            var done = 0;

            clock.Restart();

            while (clock.Elapsed.TotalSeconds < seconds)
            {
                await Task.WhenAll(Enumerable.Range(0, Concurrency).Select((_) =>
                {
                    return echo(body)();
                }));
                done += Concurrency;
            }

            rows.Add(string.Create(
                CultureInfo.InvariantCulture,
                $"| {size} B | {Percentile(durations, 0.5) * 1_000:F0} | {Percentile(durations, 0.95) * 1_000:F0} | {Percentile(durations, 0.99) * 1_000:F0} | {done * 1_000 / clock.Elapsed.TotalMilliseconds:F0} | {allocated} |"));
        }

        return rows;
    }

    private static async Task<string> Transfer()
    {
        const int Mebibyte = 1_048_576;
        const int Echoes = 5;
        var limits = new RouterLimits { MaximumPayloadBytes = 32 * Mebibyte };
        var transport = new WebSocketTransportServer();
        await using var server = new Server<string>(transport, new ServerOptions { Limits = limits });

        InteropHandlers.Offer(server);

        var port = (await transport.Start(new WebSocketTransportStartOptions { Address = "127.0.0.1", FindOpenPort = true })).Port;

        await using var client = new WebSocketClient(new WebSocketClientOptions { Limits = limits });

        await client.Connect(new WebSocketConnectOptions { Host = "127.0.0.1", Port = port });

        var echo = client.Services.GetRequest(
            InteropProcedures.Echo.Procedure,
            new RequestDependencies<JsonElement, JsonElement> { Serializer = new JsonPayloads() });
        using var document = JsonDocument.Parse($"\"{new string('x', 20 * Mebibyte)}\"");
        var body = document.RootElement.Clone();

        _ = await echo(body)();

        var clock = Stopwatch.StartNew();

        for (var index = 0; index < Echoes; index++)
        {
            _ = await echo(body)();
        }

        var milliseconds = clock.Elapsed.TotalMilliseconds / Echoes;

        return string.Create(CultureInfo.InvariantCulture, $"| 20 MiB | {milliseconds:F0} | {40 * 1_000 / milliseconds:F0} |");
    }

    // definition

    private static async Task Main(string[] args)
    {
        var at = Array.IndexOf(args, "--seconds");
        var seconds = at >= 0 ? int.Parse(args[at + 1], CultureInfo.InvariantCulture) : 3;

        Console.WriteLine($"csharp: {Environment.ProcessorCount} logical processors, {RuntimeInformation.OSDescription}; {RuntimeInformation.FrameworkDescription}");
        Console.WriteLine();
        Console.WriteLine("codec, a request written and read back");
        Console.WriteLine();
        Console.WriteLine("| payload | ns per round trip |");
        Console.WriteLine("| --- | --- |");

        foreach (var size in Sizes)
        {
            Console.WriteLine(string.Create(CultureInfo.InvariantCulture, $"| {size} B | {CodecNanoseconds(size, seconds):F0} |"));
        }

        Console.WriteLine();
        Console.WriteLine("json payload codec, a string encoded and decoded");
        Console.WriteLine();
        Console.WriteLine("| payload | ns per round trip |");
        Console.WriteLine("| --- | --- |");

        foreach (var size in Sizes)
        {
            Console.WriteLine(string.Create(CultureInfo.InvariantCulture, $"| {size} B | {JsonNanoseconds(size, seconds):F0} |"));
        }

        Console.WriteLine();
        Console.WriteLine("call, an echo over a WebSocket on the loopback");
        Console.WriteLine();
        Console.WriteLine($"| payload | p50 us | p95 us | p99 us | calls/s at {Concurrency} | B allocated per call |");
        Console.WriteLine("| --- | --- | --- | --- | --- | --- |");

        foreach (var row in await Calls(seconds))
        {
            Console.WriteLine(row);
        }

        Console.WriteLine();
        Console.WriteLine("transfer, an echo of a payload past one envelope, as chunks both ways (MiB/s counts both)");
        Console.WriteLine();
        Console.WriteLine("| payload | ms per echo | MiB/s |");
        Console.WriteLine("| --- | --- | --- |");
        Console.WriteLine(await Transfer());
    }
}
