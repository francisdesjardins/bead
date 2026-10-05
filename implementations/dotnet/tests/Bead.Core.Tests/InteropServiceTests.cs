using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Bead.Interop;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="InteropService"/>'s credentials: the ELSEWHERE verifier of
/// <c>credentials.elsewhere</c>, by its grammar, on the clock its server is given, by the rows the
/// TypeScript side's verifier answers alike; the key set of <c>credentials.jwt</c>, each issuer it
/// names answered as its words say; and what <c>endSessionsOf</c> takes.
/// </summary>
public sealed class InteropServiceTests
{
    // constants

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
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
    /// Each value a transport carried, and what the verifier settles with: at once, or that many
    /// milliseconds on, on its clock.
    /// </summary>
    public static TheoryData<string, string> Rows { get; } = new()
    {
        { "Interop sub=ada", "holds ada as ada" },
        { "interop sub=ada", "holds ada as ada" },
        { "INTEROP sub=ada", "holds ada as ada" },
        { "Interop sub=a", "holds a as a" },
        { $"Interop sub={new string('a', 32)}", $"holds {new string('a', 32)} as {new string('a', 32)}" },
        { $"Interop sub={new string('a', 33)}", "none" },
        { "Interop sub=Ada", "none" },
        { "Interop  sub=ada", "none" },
        { "Interop sub=ada,after=1", "none" },
        { "Interop sub=ada, after=0", "none" },
        { "Interop sub=ada, after=2147483647", "2147483647 ms on: holds ada as ada" },
        { "Interop sub=ada, after=2147483648", "none" },
        { "Interop sub=ada, end=9007199254740991", "holds ada as ada until 9007199254740991" },
        { "Interop sub=ada, end=9007199254740992", "none" },
        { "Interop sub=ada, end=1, after=1", "none" },
        { "Interop sub=ada, SUB=x", "none" },
        { "Interop fail=true", "rejects: this verifier fails, on purpose" },
        { "Interop fail=true, after=5", "5 ms on: rejects: this verifier fails, on purpose" },
        { "Interop fail=TRUE", "none" },
        { "Interop sub=ada, fail=true", "none" },
        { "Interop", "none" },
        { "Interop ", "none" },
        { "Bearer mF_9.B5f-4.1JqM", "none" },
        { "Basic YWRh", "none" },
    };

    [Theory]
    [MemberData(nameof(Rows))]
    public async Task The_interop_service_s_ELSEWHERE_verifier_holds_refuses_and_fails_each_value_as_its_words_say_at_its_time_on_its_server_s_clock(string carried, string settled)
    {
        var delayed = Regex.Match(settled, "^([0-9]+) ms on: (.*)$");
        var (after, outcome) = delayed.Success
            ? (long.Parse(delayed.Groups[1].Value, CultureInfo.InvariantCulture), delayed.Groups[2].Value)
            : (0L, settled);
        var clock = new FakeTimeProvider();
        var verify = InteropService.CredentialsOf(clock).Verify!;

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
        var keySet = InteropService.CredentialsOf(clock).KeySet!;

        using var ended = new CancellationTokenSource();

        await ended.CancelAsync();
        Assert.Equal([KeysIssuer, RotatedIssuer, StalledIssuer, KidlessIssuer], keySet.Issuers);
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
        var another = InteropService.CredentialsOf(clock).KeySet!.Ask(RotatedIssuer, ended.Token).AsTask();

        await clock.Advance(second);
        Assert.Single(await another.WaitAsync(Patience, Cancelled));

        // asked for an issuer it does not name, it fails at once
        Assert.True(keySet.Ask("https://unnamed.interop.bead.example", ended.Token).AsTask().IsFaulted);
    }

    [Fact]
    public void The_interop_service_s_endSessionsOf_takes_an_issuer_alone_a_string_and_throws_for_anything_else()
    {
        const string Issuer = "https://hs256.interop.bead.example";

        Assert.Equal(Issuer, InteropService.IssuerOf(JsonSerializer.SerializeToElement(new { issuer = Issuer })));
        Assert.Equal("", InteropService.IssuerOf(JsonSerializer.SerializeToElement(new { issuer = "" })));

        foreach (var request in new[]
        {
            "[]",
            "null",
            "7",
            "\"https://hs256.interop.bead.example\"",
            "{}",
            "{\"issuer\":7}",
            "{\"issuer\":null}",
            "{\"issuer\":\"https://hs256.interop.bead.example\",\"sub\":\"grace\"}",
            "{\"iss\":\"https://hs256.interop.bead.example\"}",
        })
        {
            Assert.Throws<ArgumentException>(() =>
            {
                return InteropService.IssuerOf(JsonSerializer.Deserialize<JsonElement>(request));
            });
        }
    }
}
