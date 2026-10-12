namespace Bead.Tests;

/// <summary>
/// <see cref="ListenerGuard"/>: how every transport tells its events, each listener within its own
/// guard, as the TypeScript side's transports tell theirs.
/// </summary>
public sealed class ListenerGuardTests
{
    // constants

    private const string Handle = "type=WS;ip=127.0.0.1;port=1";

    // definition

    [Fact]
    public void Calls_each_listener_though_one_throws_reporting_the_throw_with_its_connection()
    {
        var reported = new List<(Exception Reason, string? ConnectionHandle)>();
        var guard = new ListenerGuard((reason, connectionHandle) =>
        {
            reported.Add((reason, connectionHandle));
        });
        var thrown = new InvalidOperationException("a listener that throws");
        var told = new List<string>();
        Action<string>? connection = null;
        Action<bool, string>? close = null;
        Action<bool, bool>? closed = null;

        connection += (_) =>
        {
            throw thrown;
        };
        connection += (connectionHandle) =>
        {
            told.Add($"connection {connectionHandle}");
        };
        close += (_, _) =>
        {
            throw thrown;
        };
        close += (wasClean, connectionHandle) =>
        {
            told.Add($"close {wasClean} {connectionHandle}");
        };

        // a client's event carries no connection: its throw is reported with none
        closed += (_, _) =>
        {
            throw thrown;
        };
        closed += (wasClean, wasQuick) =>
        {
            told.Add($"closed {wasClean} {wasQuick}");
        };

        guard.Tell(connection, Handle);
        guard.Tell(close, (false, Handle));
        guard.Tell(closed, (true, false));

        // nobody listening: nothing told, nothing reported
        guard.Tell<string>(null, Handle);

        Assert.Equal([$"connection {Handle}", $"close False {Handle}", "closed True False"], told);
        Assert.Equal([(thrown, Handle), (thrown, Handle), (thrown, null)], reported);
    }
}
