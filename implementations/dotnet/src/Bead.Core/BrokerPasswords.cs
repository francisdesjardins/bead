using System.Diagnostics.CodeAnalysis;
using System.Globalization;

namespace Bead;

/// <summary>
/// A broker adapter's password (spec 15.26, 15.33): UTF-8 text, never empty and holding no NUL, as
/// SASL PLAIN carries one (RFC 4616 §2), over MQTT 5 as over AMQP 1.0; given, or asked of its
/// provider at each link's start within its connectTimeout, under its start's token and its stop,
/// as a WebSocket's credential provider is asked (decision 0032). No word of it names the secret.
/// </summary>
internal static class BrokerPasswords
{
    /// <summary>The refusal of what is no password, which never names it.</summary>
    public const string NotAPassword = "a password is a non-empty string holding no NUL";

    /// <summary>Whether <paramref name="password"/> is one: never empty, and holding no NUL.</summary>
    public static bool IsPassword([NotNullWhen(true)] string? password)
    {
        return !string.IsNullOrEmpty(password) && !password.Contains('\0', StringComparison.Ordinal);
    }

    /// <summary>
    /// Why a link given a password, or its provider, beside a client certificate or not, cannot
    /// authenticate, held as its adapter is built in one order on every side: both, then either
    /// beside a certificate, then a password that is none; nothing where it can. Whether a link may
    /// have neither is its binding's to say.
    /// </summary>
    public static string? RefusalOf((string? Password, bool HasProvider) given, bool hasCertificate)
    {
        var (password, hasProvider) = given;

        if (password is not null && hasProvider)
        {
            return "a link takes a password or a password provider, not both";
        }

        if ((password is not null || hasProvider) && hasCertificate)
        {
            return "a link authenticates by its client certificate or by a password, not both";
        }

        return password is not null && !IsPassword(password) ? NotAPassword : null;
    }

    /// <summary>
    /// The password <paramref name="provider"/> answers, raced against its start's token, its stop
    /// and its connectTimeout, whichever ends the wait first: a later answer serves nothing. Its
    /// start's cancellation is an <see cref="OperationCanceledException"/>; its stop an
    /// <see cref="IOException"/>, its start ended; its connectTimeout a
    /// <see cref="TimeoutException"/>; what it throws an <see cref="IOException"/>, its cause; an
    /// answer that is no password an <see cref="ArgumentException"/>.
    /// </summary>
    public static async Task<string> Asked(Func<CancellationToken, ValueTask<string>> provider, BrokerPasswordAsk ask)
    {
        string? answer;

        try
        {
            // * a start given up already, or stopped, asks nothing
            ask.Provider.ThrowIfCancellationRequested();
            answer = await Called((provider, ask.Provider)).WaitAsync(ask.Provider);
        }
        catch (Exception reason) when (ask.Start.IsCancellationRequested)
        {
            throw new OperationCanceledException($"the start of {ask.Id} was given up as it asked its password", reason, ask.Start);
        }
        catch (Exception reason) when (ask.Stop.IsCancellationRequested)
        {
            throw new IOException($"the link of {ask.Id} stopped as it started", reason);
        }
        catch (Exception reason) when (ask.Timeout.IsCancellationRequested)
        {
            throw new TimeoutException(string.Create(CultureInfo.InvariantCulture, $"the link of {ask.Id} had no password within {ask.ConnectTimeout.TotalMilliseconds} ms, its connectTimeout"), reason);
        }
        // ! its own cancellation, while its start's token stays live, is its failure as any other throw
        catch (Exception reason)
        {
            throw new IOException("the password provider failed", reason);
        }

        // ! an answer that is none is never taken for no password: here, none downgrades its link
        if (!IsPassword(answer))
        {
            throw new ArgumentException(NotAPassword, nameof(provider));
        }

        return answer;
    }

    /// <summary>
    /// Cancels the token a provider was handed once its start ended, linked or not, its callbacks
    /// apart from that start's end, and lets go of it; nothing where none was asked.
    /// </summary>
    public static void Release(CancellationTokenSource? asking)
    {
        if (asking is null)
        {
            return;
        }

        _ = asking.CancelAsync().ContinueWith(
            (cancelled) =>
            {
                _ = cancelled.Exception;
                asking.Dispose();
            },
            CancellationToken.None,
            TaskContinuationOptions.None,
            TaskScheduler.Default);
    }

    // what a provider's call gives, a throw as it is called among its failures; a late failure observed
    private static Task<string> Called((Func<CancellationToken, ValueTask<string>> Provider, CancellationToken Token) call)
    {
        Task<string> called;

        try
        {
            called = call.Provider(call.Token).AsTask();
        }
        catch (Exception reason)
        {
            called = Task.FromException<string>(reason);
        }

        _ = called.ContinueWith(
            (ended) =>
            {
                _ = ended.Exception;
            },
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

        return called;
    }
}

/// <summary>What a password's ask is bounded by: its start's token, its stop, its connectTimeout, and the token its provider is handed.</summary>
internal sealed record BrokerPasswordAsk
{
    /// <summary>Its adapter's id, which its words name.</summary>
    public required string Id { get; init; }

    /// <summary>Its connectTimeout, which its words name.</summary>
    public required TimeSpan ConnectTimeout { get; init; }

    /// <summary>Its start's own token.</summary>
    public required CancellationToken Start { get; init; }

    /// <summary>Its link's life, cancelled as it is stopped.</summary>
    public required CancellationToken Stop { get; init; }

    /// <summary>Its connectTimeout's, cancelled as it passes.</summary>
    public required CancellationToken Timeout { get; init; }

    /// <summary>
    /// What its provider is handed: the three linked, and cancelled by its adapter once its start
    /// ends, linked or not.
    /// </summary>
    public required CancellationToken Provider { get; init; }
}
