namespace Bead.Tests;

/// <summary>
/// What a client transport's send of one byte gives, as the TypeScript side's <c>sendRefusalOf</c>
/// reads it: <c>sent</c>, or the refusal's type, the state it names when it is the ready state's,
/// and its message (debugging 9.7).
/// </summary>
internal static class SendRefusals
{
    /// <summary>What a send on <paramref name="client"/> gives.</summary>
    public static async Task<string> Of(IRouterClientTransport client)
    {
        try
        {
            await client.Send(new TransportMessage(new byte[] { 1 }, false)).WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);

            return "sent";
        }
        catch (ReadyStateException refused)
        {
            return $"{nameof(ReadyStateException)} {refused.Got}: {refused.Message}";
        }
        catch (DisconnectException refused)
        {
            return $"{nameof(DisconnectException)}: {refused.Message}";
        }
    }
}
