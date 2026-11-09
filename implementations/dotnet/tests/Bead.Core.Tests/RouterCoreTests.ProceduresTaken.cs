using System.Globalization;
using System.Text;
using Bead.Interop;

namespace Bead.Tests;

/// <summary>
/// <see cref="RouterCore"/>'s ask of its transport (spec 9.2, step 5, and 9.11): of each request
/// that names no destination, whether its connection's transport takes its procedure, when that
/// transport names procedures, and never otherwise. The other sides' twins hold the same sentences.
/// </summary>
public sealed partial class RouterCoreTests
{
    // a request of the interop service's, its call id and its procedure, its payload JSON's null
    private static Envelope RequestOf((uint CallId, ProcedureAddress Procedure) call)
    {
        return new Envelope
        {
            Header = new RequestHeader { CallId = call.CallId, ServiceId = call.Procedure.ServiceId, ProcedureId = call.Procedure.ProcedureId },
            Payload = Encoding.UTF8.GetBytes("null"),
        };
    }

    // spec 9.2.5, 9.11: the twin of "a router asks its transport of each request that names no
    // destination, and of none that names one"
    [Fact]
    public async Task A_router_asks_its_transport_of_each_request_that_names_no_destination_and_of_none_that_names_one()
    {
        await using var asking = await Asking.Of(true);

        // * a procedure it takes is answered by its resolver, asked once
        await asking.Deliver(RequestOf((1, InteropProcedures.Echo.Procedure.Address)));

        Assert.Equal(["1/1 on its connection"], asking.TakeAsked());
        Assert.Equal(["1 result"], asking.TakeSent());

        // one it does not take is none: its service known by echo, which it takes
        await asking.Deliver(RequestOf((3, InteropProcedures.Fail.Procedure.Address)));

        Assert.Equal(["1/2 on its connection", "1/1 on its connection"], asking.TakeAsked());
        Assert.Equal(["3 PROCEDURE_UNKNOWN no procedure 2 in service 1"], asking.TakeSent());

        // one that names a destination is its relay's, asked of no transport
        await asking.Deliver(new Envelope
        {
            Header = new RequestHeader { CallId = 5, ServiceId = 1, ProcedureId = 2, DestinationId = 4 },
            Payload = Encoding.UTF8.GetBytes("null"),
        });

        Assert.Empty(asking.TakeAsked());
        Assert.Equal(["5 DESTINATION_UNKNOWN this peer relays nothing, to 4 or elsewhere"], asking.TakeSent());
    }

    // spec 9.11: the twin of "a router whose transport names no procedures never asks"
    [Fact]
    public async Task A_router_whose_transport_names_no_procedures_never_asks()
    {
        await using var asking = await Asking.Of(false);

        // * a list it would answer from goes unasked: every procedure taken
        await asking.Deliver(RequestOf((1, InteropProcedures.Echo.Procedure.Address)));
        await asking.Deliver(RequestOf((3, InteropProcedures.Fail.Procedure.Address)));
        await asking.Deliver(RequestOf((5, new ProcedureAddress(1, 99))));

        Assert.Empty(asking.TakeAsked());
        Assert.Equal(
            ["1 result", "3 failure 7 this procedure fails, on purpose", "5 PROCEDURE_UNKNOWN no procedure 99 in service 1"],
            asking.TakeSent());
    }

    // a server of the interop service over a transport that takes echo alone, naming its procedures
    // or not, its one connection open: each ask of it recorded, and each answer it sent
    private sealed class Asking : IServerTransport, IAsyncDisposable
    {
        private const string Connected = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";

        private readonly SerialScheduler _scheduler = new();
        private readonly List<string> _asked = [];
        private readonly List<string> _sent = [];
        private Server<string>? _server;

        private Asking(bool isNaming)
        {
            IsNaming = isNaming;
        }

        public event Action<string>? Connection;

        public event Action<TransportMessage, string>? Message;

        public event Action<bool, string>? Close;

        public TimeProvider Clock { get; } = TimeProvider.System;

        public string? Type
        {
            get
            {
                return TransportTypes.WebSocket;
            }
        }

        public bool IsNaming { get; }

        public static async Task<Asking> Of(bool isNaming)
        {
            var asking = new Asking(isNaming);

            asking._server = new Server<string>(asking, new ServerOptions { ResolverScheduler = asking._scheduler, Scheduler = asking._scheduler });
            InteropHandlers.Offer(asking._server);
            asking.Connection?.Invoke(Connected);
            await asking._scheduler.WhenIdle();

            return asking;
        }

        public bool NamesProcedures()
        {
            return IsNaming;
        }

        public bool TakesProcedure(string connectionHandle, ProcedureAddress address)
        {
            lock (_asked)
            {
                _asked.Add(string.Create(CultureInfo.InvariantCulture, $"{address.ServiceId}/{address.ProcedureId} on {(connectionHandle == Connected ? "its connection" : connectionHandle)}"));
            }

            return address == InteropProcedures.Echo.Procedure.Address;
        }

        // hands the server an envelope on its connection, and lets it settle
        public async Task Deliver(Envelope envelope)
        {
            Message?.Invoke(new TransportMessage(EnvelopeCodec.WriteEnvelope(envelope), false), Connected);

            for (var round = 0; round < 3; round += 1)
            {
                await _scheduler.WhenIdle();
            }
        }

        // what was asked since the last time asked
        public List<string> TakeAsked()
        {
            lock (_asked)
            {
                var asked = _asked.ToList();

                _asked.Clear();

                return asked;
            }
        }

        // each answer sent since the last time asked: its call id, and its kind, or its failure's
        // code by name, or its number for an application's, and its detail
        public List<string> TakeSent()
        {
            lock (_sent)
            {
                var sent = _sent.ToList();

                _sent.Clear();

                return sent;
            }
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            var envelope = EnvelopeCodec.ReadEnvelope(message.Bytes.Span, new EnvelopeReadOptions { Side = RouterSide.Client, MaximumEnvelopeBytes = int.MaxValue })!;
            var callId = envelope.Header.CallId;

            lock (_sent)
            {
                _sent.Add(envelope.Failure is { } failure
                    ? string.Create(CultureInfo.InvariantCulture, $"{callId} {(failure.Scope == FailureScope.Protocol ? ProtocolNameOf(failure.Code) : $"failure {failure.Code}")} {failure.Detail}")
                    : string.Create(CultureInfo.InvariantCulture, $"{callId} {envelope.Kind.ToString().ToLowerInvariant()}"));
            }

            return Task.CompletedTask;
        }

        // its server's router paused and resumed it, which hands what it hands all the same: no
        // test of this one's reaches a bound
        public void Pause(string connectionHandle)
        {
        }

        public void Resume(string connectionHandle)
        {
        }

        public Task<bool> CloseConnection(string connectionHandle)
        {
            return Task.FromResult(false);
        }

        public Task Shutdown()
        {
            return Task.CompletedTask;
        }

        public async ValueTask DisposeAsync()
        {
            Close?.Invoke(false, Connected);

            if (_server is not null)
            {
                await _server.DisposeAsync();
            }
        }

        // a protocol code by its name in the spec's spelling: PROCEDURE_UNKNOWN for ProcedureUnknown
        private static string ProtocolNameOf(ushort code)
        {
            return string.Concat(((ProtocolCode)code).ToString().Select((character, index) =>
            {
                return index > 0 && char.IsUpper(character) ? $"_{character}" : $"{char.ToUpperInvariant(character)}";
            }));
        }
    }
}
