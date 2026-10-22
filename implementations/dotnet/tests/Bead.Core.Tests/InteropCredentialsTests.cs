using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Bead.Interop;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="InteropCredentials"/>: the ELSEWHERE verifier of <c>credentials.elsewhere</c>, by its
/// grammar, on the clock its server is given, by the verdicts of <c>verifiers.elsewhere</c>, which
/// the TypeScript side's verifier answers alike; and the key set of <c>credentials.jwt</c>, each
/// issuer it names answered as its words say.
/// </summary>
public sealed class InteropCredentialsTests
{
    // constants

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // what both sides' interop tests hold the interop service's own readers to
    private static readonly JsonElement Verifiers = Load().GetProperty("verifiers");

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static JsonElement Load()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "interop-service.json")));

        return document.RootElement.Clone();
    }

    // each verdict, written as OutcomeOf writes what a verification settled with, after the
    // milliseconds it waits when it waits
    private static TheoryData<string, string> RowsOf(JsonElement elsewhere)
    {
        var rejection = elsewhere.GetProperty("rejection").GetString();

        return new TheoryData<string, string>(elsewhere.GetProperty("verdicts").EnumerateArray().Select((verdict) =>
        {
            var settled = verdict.GetProperty("verdict").GetString() switch
            {
                "holds" => $"holds {verdict.GetProperty("sub").GetString()} as {verdict.GetProperty("sub").GetString()}"
                    + (verdict.TryGetProperty("end", out var end) ? $" until {end.GetInt64()}" : ""),
                "rejects" => $"rejects: {rejection}",
                "none" => "none",
                var other => throw new InvalidOperationException($"no verdict of this side is {other}"),
            };

            return (
                verdict.GetProperty("carried").GetString()!,
                verdict.TryGetProperty("after", out var after) ? $"{after.GetInt64()} ms on: {settled}" : settled);
        }));
    }

    // what a settled verification says: the sub it holds and its end, none, or that it rejected
    private static async Task<string> OutcomeOf(ValueTask<ElsewhereSession?> verifying)
    {
        try
        {
            return await verifying is { } session
                ? $"holds {((JsonElement)session.Data!).GetProperty("sub").GetString()} as {session.Id}{(session.End is { } end ? $" until {end:R}" : "")}"
                : "none";
        }
        catch (InvalidOperationException reason)
        {
            return $"rejects: {reason.Message}";
        }
    }

    // definition

    /// <summary>
    /// Each value a transport carried, and what the verifier settles with, as <c>verifiers.elsewhere</c>
    /// of <c>spec/interop-service.json</c> says: at once, or that many milliseconds on, on its clock.
    /// </summary>
    public static TheoryData<string, string> Rows { get; } = RowsOf(Verifiers.GetProperty("elsewhere"));

    [Theory]
    [MemberData(nameof(Rows))]
    public async Task The_interop_service_s_ELSEWHERE_verifier_holds_refuses_and_fails_each_value_as_its_words_say_at_its_time_on_its_server_s_clock(string carried, string settled)
    {
        var delayed = Regex.Match(settled, "^([0-9]+) ms on: (.*)$");
        var (after, outcome) = delayed.Success
            ? (long.Parse(delayed.Groups[1].Value, CultureInfo.InvariantCulture), delayed.Groups[2].Value)
            : (0L, settled);
        var clock = new FakeTimeProvider();
        var verify = InteropCredentials.Of(clock).Verify!;

        using var ended = new CancellationTokenSource();

        await ended.CancelAsync();

        var verifying = OutcomeOf(verify(carried, ended.Token));

        if (after > 0)
        {
            clock.Advance(TimeSpan.FromMilliseconds(after - 1));
            Assert.False(verifying.IsCompleted);
            clock.Advance(TimeSpan.FromMilliseconds(1));
        }

        Assert.Equal(outcome, await verifying.WaitAsync(Patience, Cancelled));
    }

    [Fact]
    public async Task The_interop_service_s_key_set_answers_each_issuer_it_names_as_its_words_say_on_its_server_s_clock_whatever_its_signal_and_fails_at_once_for_any_other()
    {
        const string KeysIssuer = "https://keys.interop.bead.example";
        const string RotatedIssuer = "https://rotated.interop.bead.example";
        const string StalledIssuer = "https://stalled.interop.bead.example";
        const string KidlessIssuer = "https://kidless.interop.bead.example";

        var second = TimeSpan.FromMilliseconds(1_000);
        var clock = new SteppingClock(DateTimeOffset.UnixEpoch);
        var keySet = InteropCredentials.Of(clock).KeySet!;

        using var ended = new CancellationTokenSource();

        await ended.CancelAsync();
        Assert.Equal([KeysIssuer, RotatedIssuer, StalledIssuer, KidlessIssuer], keySet.Issuers);
        Assert.Equal(Load().GetProperty("credentials").GetProperty("jwt").GetProperty("keySet").GetProperty("maximumWaitingCalls").GetInt32(), keySet.MaximumWaitingCalls);
        Assert.Equal(2, keySet.MaximumWaitingCalls);

        // the rotated issuer's keys at its first ask alone; the stalled one's never, no timer
        // armed; the kid-less one's at every ask, as the keys issuer's
        var asked = new[]
        {
            keySet.Ask(KeysIssuer, ended.Token).AsTask(),
            keySet.Ask(RotatedIssuer, ended.Token).AsTask(),
            keySet.Ask(RotatedIssuer, ended.Token).AsTask(),
            keySet.Ask(KidlessIssuer, ended.Token).AsTask(),
            keySet.Ask(KidlessIssuer, ended.Token).AsTask(),
        };
        var stalling = keySet.Ask(StalledIssuer, ended.Token).AsTask();

        Assert.Equal([second, second, second, second, second], clock.Dues());
        await clock.Advance(second - TimeSpan.FromMilliseconds(1));
        Assert.DoesNotContain(asked, (asking) =>
        {
            return asking.IsCompleted;
        });
        await clock.Advance(TimeSpan.FromMilliseconds(1));

        var answered = await Task.WhenAll(asked).WaitAsync(Patience, Cancelled);

        Assert.Equal([1, 1, 0, 1, 1], answered.Select((keys) =>
        {
            return keys.Count;
        }));
        Assert.All(answered.Take(2), (keys) =>
        {
            Assert.Equal("018c0ae5-4d9b-471b-bfd6-eef314bc7037", keys[0].Jwk.GetProperty("kid").GetString());
        });
        Assert.NotEqual(answered[0][0].Jwk.GetProperty("k").GetString(), answered[1][0].Jwk.GetProperty("k").GetString());

        // the keys issuer's key, without its kid
        Assert.All(answered.Skip(3), (keys) =>
        {
            Assert.False(keys[0].Jwk.TryGetProperty("kid", out _));
            Assert.Equal(answered[0][0].Jwk.GetProperty("k").GetString(), keys[0].Jwk.GetProperty("k").GetString());
        });
        Assert.False(stalling.IsCompleted);
        Assert.Empty(clock.Dues());

        // its asks counted per key set built: another server's answers its first anew
        var another = InteropCredentials.Of(clock).KeySet!.Ask(RotatedIssuer, ended.Token).AsTask();

        await clock.Advance(second);
        Assert.Single(await another.WaitAsync(Patience, Cancelled));

        // asked for an issuer it does not name, it fails at once, its clock unmoved and no timer armed
        var unnamed = keySet.Ask("https://unnamed.interop.bead.example", ended.Token).AsTask();

        Assert.True(unnamed.IsFaulted);
        Assert.Empty(clock.Dues());
        Assert.Equal("the interop key set names no issuer https://unnamed.interop.bead.example", unnamed.Exception!.InnerException!.Message);
    }
}
