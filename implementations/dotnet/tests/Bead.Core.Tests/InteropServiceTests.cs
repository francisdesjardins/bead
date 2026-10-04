using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Bead.Interop;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// <see cref="InteropService"/>'s credentials: the ELSEWHERE verifier of
/// <c>credentials.elsewhere</c>, by its grammar, on the clock its server is given, by the rows the
/// TypeScript side's verifier answers alike.
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
}
