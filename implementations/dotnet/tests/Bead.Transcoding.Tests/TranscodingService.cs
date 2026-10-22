using Bead.Transcoding.V1;
using Google.Protobuf.WellKnownTypes;

namespace Bead.Transcoding.Tests;

/// <summary>
/// The Transcoding service of <c>spec/transcoding.proto</c>, in process, as <c>transcoding.json</c>'s
/// <c>service</c> states each procedure: one server over a joined transport of an in-memory transport,
/// its verifier of <c>ELSEWHERE</c> taking <c>Bearer good</c> as the session <c>ada</c>, and no JWT
/// verifier; its counts the exchanges wait on.
/// </summary>
internal sealed class TranscodingService : IAsyncDisposable
{
    private readonly Lock _gate = new();
    private readonly List<string> _refused = [];
    private int _hanging;
    private int _cancelled;

    private TranscodingService(MemoryTransportServer memory, Server<string> server)
    {
        Memory = memory;
        Server = server;
    }

    /// <summary>The in-memory transport its gateway connects to, joined.</summary>
    public MemoryTransportServer Memory { get; }

    /// <summary>The server, its one router.</summary>
    public Server<string> Server { get; }

    /// <summary>The calls of hang its resolver took.</summary>
    public int Hanging
    {
        get
        {
            lock (_gate)
            {
                return _hanging;
            }
        }
    }

    /// <summary>The calls of hang that ended cancelled.</summary>
    public int Cancelled
    {
        get
        {
            lock (_gate)
            {
                return _cancelled;
            }
        }
    }

    /// <summary>The detail of each command of ask that failed, in their order.</summary>
    public IReadOnlyList<string> Refused
    {
        get
        {
            lock (_gate)
            {
                return [.. _refused];
            }
        }
    }

    /// <summary>The service offered on a server of its own, its in-memory transport started.</summary>
    public static async Task<TranscodingService> Start()
    {
        var memory = new MemoryTransportServer();
        var server = new Server<string>(new JoinedServerTransport([memory]), new ServerOptions
        {
            Credentials = new Credentials
            {
                Verify = (carried, _) =>
                {
                    return ValueTask.FromResult(carried == "Bearer good" ? new ElsewhereSession { Id = "ada" } : null);
                },
            },
        });
        var service = new TranscodingService(memory, server);

        service.Offer();
        await memory.Start();

        return service;
    }

    public async ValueTask DisposeAsync()
    {
        await Server.DisposeAsync();
        await Memory.DisposeAsync();
    }

    private void Offer()
    {
        var transcoding = new TranscodingServer<string>();
        var sent = new Dictionary<string, int>(StringComparer.Ordinal);

        // * the notifications the server sent, by connection, which ticks waits on before it ends
        // its subscription, so none is dropped behind its failure
        Server.Router.Debug += (direction, envelope) =>
        {
            if (direction == DebugDirection.Tx && envelope.Header is NotificationHeader)
            {
                lock (sent)
                {
                    sent[envelope.ConnectionHandle] = sent.GetValueOrDefault(envelope.ConnectionHandle) + 1;
                    Monitor.PulseAll(sent);
                }
            }
        };

        transcoding.On(TranscodingProcedures.Echo, (request, response) =>
        {
            return response.Answer(request.Payload);
        });
        transcoding.On(TranscodingProcedures.EchoEdges, (request, response) =>
        {
            return response.Answer(request.Payload);
        });
        transcoding.On(TranscodingProcedures.GetBook, (request, response) =>
        {
            return response.Answer(new Book { Name = request.Payload.Name, Title = "A tale", Pages = request.Payload.Revision });
        });
        transcoding.On(TranscodingProcedures.ListBooks, (request, response) =>
        {
            var parent = request.Payload.Parent;

            return response.Answer(new ListBooksResponse
            {
                Books =
                {
                    new Book { Name = $"{parent}/books/a", Title = "A" },
                    new Book { Name = $"{parent}/books/b", Title = "B" },
                },
            });
        });
        transcoding.On(TranscodingProcedures.UpdateBook, (request, response) =>
        {
            return response.Answer(request.Payload);
        });
        transcoding.On(TranscodingProcedures.ArchiveBook, (_, response) =>
        {
            return response.Answer(new Empty());
        });
        transcoding.On(TranscodingProcedures.ListOperations, (request, response) =>
        {
            return response.Answer(new ListOperationsResponse { Operations = { new Operation { Name = request.Payload.Name + "/a" } } });
        });
        transcoding.On(TranscodingProcedures.GetOperation, (request, response) =>
        {
            return response.Answer(new Operation { Name = request.Payload.Name, Done = true });
        });
        transcoding.On(TranscodingProcedures.Judge, (_, response) =>
        {
            return response.Answer(new Empty());
        });
        transcoding.On(TranscodingProcedures.Ticks, async (request, response) =>
        {
            var from = request.Payload.From;
            var connectionHandle = request.ConnectionHandle;
            int before;

            lock (sent)
            {
                before = sent.GetValueOrDefault(connectionHandle);
            }

            await response.Answer(new TicksResponse { Ticks = from });

            for (var remaining = from - 1; remaining >= 0; remaining -= 1)
            {
                await transcoding.Notify.Ticks(new Tick { Remaining = remaining }, new NotifyOptions
                {
                    Filter = (subscriber) =>
                    {
                        return subscriber.ConnectionHandle == connectionHandle;
                    },
                });
            }

            await Task.Run(() =>
            {
                lock (sent)
                {
                    while (sent.GetValueOrDefault(connectionHandle) - before < from)
                    {
                        Monitor.Wait(sent, TimeSpan.FromSeconds(1));
                    }
                }
            });
            await Server.Router.DropSubscriptions(connectionHandle, Failure.OfApplication(2));
        });
        transcoding.On(TranscodingProcedures.Watch, (_, response) =>
        {
            return response.Answer(new Empty());
        });
        transcoding.On(TranscodingProcedures.Raw, (request, response) =>
        {
            return response.Answer(request.Payload);
        });
        transcoding.On(TranscodingProcedures.Text, (request, response) =>
        {
            return response.Answer(request.Payload);
        });
        transcoding.On(TranscodingProcedures.Json, (request, response) =>
        {
            return response.Answer(request.Payload);
        });
        transcoding.On(TranscodingProcedures.Fail, (request, response) =>
        {
            return response.Fail(TranscodingFailures.Fail.Refused, request.Payload.Detail);
        });
        transcoding.On(TranscodingProcedures.WhoAmI, (request, response) =>
        {
            return response.Answer(new WhoAmIResponse { Session = request.Session?.Identifier?.Id ?? "" });
        });
        transcoding.On(TranscodingProcedures.Ask, async (request, response) =>
        {
            var code = 0;

            try
            {
                await transcoding.Command.Answer(new Empty())(new RequestOptions { ConnectionHandle = request.ConnectionHandle });
            }
            catch (FailureException failed)
            {
                code = failed.Code;

                lock (_gate)
                {
                    _refused.Add(failed.Detail);
                }
            }

            await response.Answer(new AskResponse { Code = code });
        });
        transcoding.On(TranscodingProcedures.Hang, async (request, _) =>
        {
            lock (_gate)
            {
                _hanging += 1;
            }

            try
            {
                await Task.Delay(System.Threading.Timeout.InfiniteTimeSpan, TimeProvider.System, request.Signal);
            }
            catch (OperationCanceledException)
            {
                lock (_gate)
                {
                    _cancelled += 1;
                }
            }
        });
        transcoding.On(TranscodingProcedures.Cancels, async (request, response) =>
        {
            var until = TimeProvider.System.GetTimestamp();

            while (TimeProvider.System.GetElapsedTime(until) < TimeSpan.FromSeconds(1))
            {
                lock (_gate)
                {
                    if (_cancelled >= request.Payload.AtLeast)
                    {
                        break;
                    }
                }

                await Task.Delay(TimeSpan.FromMilliseconds(10), TimeProvider.System);
            }

            int count;

            lock (_gate)
            {
                count = _cancelled;
            }

            await response.Answer(new CancelsResponse { Count = count });
        });

        transcoding.Offer(Server);
    }
}
