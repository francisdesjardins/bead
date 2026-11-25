namespace Bead.Tests;

/// <summary>The default security and procedure capabilities of custom transports.</summary>
public sealed class TransportDefaultsTests
{
    [Fact]
    public void A_transport_offers_no_security_or_carried_credential_unless_it_says_so()
    {
        IRouterClientTransport client = new Client();
        IRouterServerTransport server = new Server();

        Assert.False(client.IsSecure);
        Assert.False(client.Carries("Bearer secret"));
        Assert.False(server.IsSecure("one"));
        Assert.False(server.CarriesCredential("one"));
        Assert.True(server.IsTwoWay("one"));
        Assert.False(server.NamesProcedures());
        foreach (var address in new[]
        {
            new ProcedureAddress(1, 1),
            new ProcedureAddress(ushort.MaxValue, ushort.MaxValue),
        })
        {
            Assert.True(server.TakesProcedure("one", address));
        }
    }

    private sealed class Client : IRouterClientTransport
    {
        public TimeProvider Clock
        {
            get { return TimeProvider.System; }
        }

        public event Action<TransportMessage>? Message
        {
            add { }
            remove { }
        }

        public event Action<bool, bool>? Close
        {
            add { }
            remove { }
        }

        public Task Send(TransportMessage message)
        {
            return Task.CompletedTask;
        }

        public void Pause() { }
        public void Resume() { }
    }

    private sealed class Server : IRouterServerTransport
    {
        public TimeProvider Clock
        {
            get { return TimeProvider.System; }
        }

        public event Action<string>? Connection
        {
            add { }
            remove { }
        }

        public event Action<TransportMessage, string>? Message
        {
            add { }
            remove { }
        }

        public event Action<bool, string>? Close
        {
            add { }
            remove { }
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            return Task.CompletedTask;
        }

        public void Pause(string connectionHandle) { }
        public void Resume(string connectionHandle) { }
    }
}
