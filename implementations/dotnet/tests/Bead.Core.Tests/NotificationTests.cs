using System.Collections.Concurrent;
using System.Text.Json;
using Bead.Interop;
using Microsoft.Extensions.Time.Testing;

namespace Bead.Tests;

/// <summary>
/// A client's notifications — <see cref="ServiceManager.GetNotification{TRequest, TResponse, TNotification}"/>
/// and the client router's half — against a server of the interop service, linked in memory, both
/// on one scheduler a test waits on.
/// </summary>
public sealed class NotificationTests : IDisposable
{
    // constants

    private const string Handle = "type=WS;ip=127.0.0.1;port=50001;ordinal=1";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static readonly Func<JsonElement, Task> Unheard = (_) =>
    {
        return Task.CompletedTask;
    };

    private readonly SerialScheduler _scheduler = new();
    // the client's clock moves only as a test moves it: a call id it reserves stays reserved
    private readonly ClientEnd _clientEnd = new() { Clock = new FakeTimeProvider() };
    private readonly ServerEnd _serverEnd = new();
    private readonly RouterClient _client;
    private readonly Server<string> _server;
    private readonly ServiceManager _services;
    // written on the router's scheduler, read on the test's thread
    private readonly ConcurrentQueue<IEnvelopeHeader> _sent = new();
    private readonly ConcurrentQueue<Exception> _errors = new();

    public NotificationTests()
    {
        _clientEnd.Peer = _serverEnd;
        _serverEnd.Peer = _clientEnd;
        _client = new RouterClient(_clientEnd, new RouterClientOptions { ResolverScheduler = _scheduler, Scheduler = _scheduler });
        _server = new Server<string>(
            _serverEnd,
            new ServerOptions { Pacing = new PacingLimits { MaximumQueuedNotifications = 2 }, ResolverScheduler = _scheduler, Scheduler = _scheduler });
        _services = new ServiceManager(_client);
        InteropHandlers.Offer(_server);
        _serverEnd.Open();
        _client.Debug += (direction, envelope) =>
        {
            if (direction == DebugDirection.Tx)
            {
                _sent.Enqueue(envelope.Header);
            }
        };
        _client.Error += _errors.Enqueue;
    }

    // helpers

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static JsonElement JsonOf(string text)
    {
        using var document = JsonDocument.Parse(text);

        return document.RootElement.Clone();
    }

    private INotification<JsonElement, JsonElement> TicksOf(int? window = null, Func<uint, JsonElement, Task>? unsubscribe = null)
    {
        return _services.GetNotification(
            InteropProcedures.Ticks.Procedure,
            new NotificationDependencies<JsonElement, JsonElement, JsonElement>
            {
                Serializer = new JsonNotifications(),
                Unsubscribe = unsubscribe,
                Window = window,
            });
    }

    // a manager gives one notification per procedure, whatever its window: each window asks a
    // manager of its own
    private INotification<JsonElement, JsonElement> TicksOfOwnManager(int? window)
    {
        return new ServiceManager(_client).GetNotification(
            InteropProcedures.Ticks.Procedure,
            new NotificationDependencies<JsonElement, JsonElement, JsonElement> { Serializer = new JsonNotifications(), Window = window });
    }

    // the call id of the one request that subscribed
    private uint SubscribedCallId
    {
        get
        {
            return ((RequestHeader)_sent.Single((header) =>
            {
                return header is RequestHeader { OpensSubscription: true };
            })).CallId;
        }
    }

    private static Func<JsonElement, Task> HeardBy(List<string> heard, string name)
    {
        return (value) =>
        {
            heard.Add($"{name} {value.GetInt32()}");

            return Task.CompletedTask;
        };
    }

    private async Task Tick(int value)
    {
        await _services.GetRequest(
            InteropProcedures.Tick.Procedure,
            new RequestDependencies<JsonElement, JsonElement> { Serializer = new JsonPayloads() })(JsonOf($"{{\"value\":{value}}}"))()
            .WaitAsync(Patience, Cancelled);
        await Settle();
    }

    private async Task Settle()
    {
        for (var round = 0; round < 3; round += 1)
        {
            await _scheduler.WhenIdle();
        }
    }

    // what goes on off the scheduler — a registration's request, from the thread pool — settles when
    // it does: waited for, as long as a test is patient
    private async Task SettleUntil(Func<bool> isDone)
    {
        var deadline = DateTime.UtcNow + Patience;

        while (!isDone())
        {
            if (DateTime.UtcNow > deadline)
            {
                throw new TimeoutException("what the test waited for never came");
            }

            await Task.Delay(5, Cancelled);
            await Settle();
        }
    }

    // definition

    public void Dispose()
    {
        _serverEnd.Closed();
        _clientEnd.CloseConnection();
        _server.DisposeAsync().AsTask().GetAwaiter().GetResult();
        _client.Dispose();
    }

    [Fact]
    public async Task A_callback_registered_hears_each_notification_and_two_share_one_request()
    {
        var ticks = TicksOf();
        var heard = new List<int>();
        var also = new List<int>();

        await using var first = await ticks.Register(JsonOf("null"), (value) =>
        {
            heard.Add(value.GetInt32());

            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);
        await using var second = await ticks.Register(JsonOf("null"), (value) =>
        {
            also.Add(value.GetInt32());

            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);

        await Tick(1);
        await Tick(2);

        Assert.Equal([1, 2], heard);
        Assert.Equal([1, 2], also);
        Assert.Single(_sent, (header) =>
        {
            return header is RequestHeader { OpensSubscription: true };
        });
    }

    [Fact]
    public async Task A_paced_subscription_credits_the_next_once_the_callback_settled()
    {
        var ticks = TicksOf(window: 1);
        var heard = new List<int>();
        var holding = new TaskCompletionSource();

        await using var registration = await ticks.Register(JsonOf("null"), (value) =>
        {
            heard.Add(value.GetInt32());

            return heard.Count == 1 ? holding.Task : Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);

        Assert.Single(_sent, (header) =>
        {
            return header is RequestHeader { OpensSubscription: true, Paced: true };
        });
        await Tick(1);
        await Tick(2);

        // the first callback holds: the second notification waits at the server, uncredited
        Assert.Equal([1], heard);
        Assert.DoesNotContain(_sent, (header) =>
        {
            return header is CreditHeader;
        });
        holding.SetResult();
        await Settle();
        Assert.Equal([1, 2], heard);
        Assert.Contains(_sent, (header) =>
        {
            return header is CreditHeader { CreditEnd: 2, Paced: true };
        });
    }

    [Fact]
    public async Task The_last_registration_taken_away_cancels_the_subscription_and_a_late_notification_is_dropped_in_silence()
    {
        var ticks = TicksOf();
        var heard = new List<int>();
        var registration = await ticks.Register(JsonOf("null"), (value) =>
        {
            heard.Add(value.GetInt32());

            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);
        var callId = ((RequestHeader)_sent.Single((header) =>
        {
            return header is RequestHeader { OpensSubscription: true };
        })).CallId;

        await registration.Unregister().WaitAsync(Patience, Cancelled);
        await Settle();
        Assert.Contains(_sent, (header) =>
        {
            return header is CancelHeader cancel && cancel.CallId == callId;
        });

        // on a call id reserved, what was on its way is dropped in silence
        _clientEnd.Deliver(EnvelopeCodec.WriteEnvelope(new Envelope { Header = new NotificationHeader { CallId = callId }, Payload = "9"u8.ToArray() }));
        await Tick(1);
        Assert.Empty(heard);
        Assert.Empty(_errors);
    }

    [Fact]
    public async Task A_subscription_the_server_ends_is_dropped_and_told_with_its_failure()
    {
        var ticks = TicksOf(window: 1);
        var dropped = new List<Failure?>();
        var holding = new TaskCompletionSource();

        _services.Dropped += (_, failure) =>
        {
            dropped.Add(failure);
        };

        await using var registration = await ticks.Register(JsonOf("null"), (_) =>
        {
            return holding.Task;
        })().WaitAsync(Patience, Cancelled);

        // one sent and held, two queued, the fourth past the server's bound of two
        for (var value = 1; value <= 4; value += 1)
        {
            await Tick(value);
        }

        Assert.Equal((ushort)ProtocolCode.CapacityExceeded, Assert.Single(dropped)?.Code);
        Assert.False(_client.HasNotification(ticks));
        holding.SetResult();
        await Settle();
        Assert.Empty(_errors);

        // dropped, it asks anew: the next registration subscribes again
        await using var again = await ticks.Register(JsonOf("null"), (_) =>
        {
            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);

        Assert.Equal(2, _sent.Count((header) =>
        {
            return header is RequestHeader { OpensSubscription: true };
        }));
        Assert.True(_client.HasNotification(ticks));
    }

    [Fact]
    public async Task A_connection_that_closes_drops_its_notifications()
    {
        var ticks = TicksOf();
        var dropped = new List<Failure?>();

        _services.Dropped += (_, failure) =>
        {
            dropped.Add(failure);
        };

        await using var registration = await ticks.Register(JsonOf("null"), (_) =>
        {
            return Task.CompletedTask;
        })().WaitAsync(Patience, Cancelled);

        _clientEnd.CloseConnection();
        await Settle();

        Assert.Equal([null], dropped);
        Assert.False(_client.HasNotification(ticks));
    }

    [Fact]
    public async Task Is_held_by_the_router_before_its_one_request_goes_out_however_many_register_at_once()
    {
        var ticks = TicksOf();
        var heard = new List<string>();

        await Task.WhenAll(ticks.Register(JsonOf("null"), HeardBy(heard, "a"))(), ticks.Register(JsonOf("null"), HeardBy(heard, "b"))())
            .WaitAsync(Patience, Cancelled);
        await Tick(1);

        Assert.True(_client.HasNotification(ticks));
        Assert.Single(_sent, (header) =>
        {
            return header is RequestHeader { OpensSubscription: true };
        });
        Assert.Equal(["a 1", "b 1"], heard);
    }

    [Fact]
    public async Task The_last_callback_out_unsubscribes_then_unregisters_the_notification_with_no_cancel_once_acknowledged()
    {
        var unsubscribed = new List<(uint CallId, string Response)>();
        var ticks = TicksOf(unsubscribe: (callId, response) =>
        {
            unsubscribed.Add((callId, response.GetRawText()));

            return Task.CompletedTask;
        });
        var first = await ticks.Register(JsonOf("null"), Unheard)().WaitAsync(Patience, Cancelled);
        var second = await ticks.Register(JsonOf("null"), Unheard)().WaitAsync(Patience, Cancelled);

        await first.Unregister().WaitAsync(Patience, Cancelled);

        Assert.True(_client.HasNotification(ticks));

        await second.Unregister().WaitAsync(Patience, Cancelled);
        await second.Unregister().WaitAsync(Patience, Cancelled);
        await Settle();

        Assert.Equal([(SubscribedCallId, "null")], unsubscribed);
        Assert.DoesNotContain(_sent, (header) =>
        {
            return header is CancelHeader;
        });
        Assert.False(_client.HasNotification(ticks));
    }

    // a registration of a notification held completes at once here, so the registration under way
    // is the one whose request is in flight: the server subscribes, then holds its answer
    [Fact]
    public async Task A_drop_silences_the_callbacks_tells_the_manager_and_fails_a_registration_under_way()
    {
        var ticks = TicksOf();
        var heard = new List<string>();
        var dropped = new ConcurrentQueue<Failure?>();

        _services.Dropped += (_, failure) =>
        {
            dropped.Enqueue(failure);
        };

        var registering = ticks.Register(JsonOf("{\"hold\":1}"), HeardBy(heard, "held"))();

        await SettleUntil(() =>
        {
            return _sent.Any((header) =>
            {
                return header is RequestHeader { OpensSubscription: true };
            });
        });

        var callId = SubscribedCallId;

        _clientEnd.CloseConnection();
        await Assert.ThrowsAsync<DisconnectException>(() =>
        {
            return registering.WaitAsync(Patience, Cancelled);
        });

        // on its call id, what comes finds no subscription, and no callback
        _clientEnd.Deliver(EnvelopeCodec.WriteEnvelope(new Envelope { Header = new NotificationHeader { CallId = callId }, Payload = "1"u8.ToArray() }));
        // ! the manager is told of the drop on the connection's close, and the client of the
        // notification no subscription holds, each of which may come after the registration's
        // failure: wait for both, not for the settling alone
        await SettleUntil(() =>
        {
            return !dropped.IsEmpty && !_errors.IsEmpty;
        });

        Assert.Equal([null], dropped);
        Assert.Empty(heard);
        Assert.False(_client.HasNotification(ticks));
        Assert.Equal((ushort)ProtocolCode.SubscriptionUnknown, Assert.IsType<FailureException>(Assert.Single(_errors)).Code);
    }

    // this side gives back the faults alone, the TypeScript side every callback's settlement
    [Fact]
    public async Task A_trigger_settles_as_every_callback_did_the_tasks_they_returned_too()
    {
        var ticks = TicksOf();
        var fetched = new TaskCompletionSource();
        var failure = new IOException("fetch failed");

        await using var synchronous = await ticks.Register(JsonOf("null"), Unheard)().WaitAsync(Patience, Cancelled);
        await using var fetching = await ticks.Register(JsonOf("null"), (_) =>
        {
            return fetched.Task;
        })().WaitAsync(Patience, Cancelled);
        await using var failing = await ticks.Register(JsonOf("null"), (_) =>
        {
            return Task.FromException(failure);
        })().WaitAsync(Patience, Cancelled);

        var settling = ticks.Trigger("1"u8.ToArray());

        Assert.False(settling.IsCompleted);

        fetched.SetResult();

        Assert.Same(failure, Assert.Single(await settling.WaitAsync(Patience, Cancelled)));
    }

    [Fact]
    public void Carries_its_window_and_refuses_one_that_is_not_a_whole_number_above_0()
    {
        int[] refused = [0, -1];

        Assert.Equal(3, TicksOfOwnManager(3).Window);
        Assert.Null(TicksOfOwnManager(null).Window);

        foreach (var window in refused)
        {
            var exception = Assert.Throws<ArgumentException>(() =>
            {
                return TicksOfOwnManager(window);
            });

            Assert.StartsWith($"a window is a whole number above 0, not {window}", exception.Message, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task The_same_callback_registered_twice_is_heard_twice_and_its_registrations_taken_away_one_by_one()
    {
        var ticks = TicksOf();
        var heard = new List<string>();
        var callback = HeardBy(heard, "heard");
        var first = await ticks.Register(JsonOf("null"), callback)().WaitAsync(Patience, Cancelled);

        await using var second = await ticks.Register(JsonOf("null"), callback)().WaitAsync(Patience, Cancelled);

        await Tick(1);
        await first.Unregister().WaitAsync(Patience, Cancelled);
        await first.Unregister().WaitAsync(Patience, Cancelled);
        await Tick(2);

        Assert.Equal(["heard 1", "heard 1", "heard 2"], heard);
    }

    // the TypeScript side traces the failure; here the router reports it
    // spec 17.2.3
    [Fact]
    public async Task A_trigger_never_registered_is_an_invalid_operation_a_payload_that_does_not_decode_a_failure_reported()
    {
        var ticks = TicksOf();
        var heard = new List<string>();

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
        {
            return ticks.Trigger("1"u8.ToArray()).WaitAsync(Patience, Cancelled);
        });

        await using var registration = await ticks.Register(JsonOf("null"), HeardBy(heard, "heard"))().WaitAsync(Patience, Cancelled);

        _clientEnd.Deliver(EnvelopeCodec.WriteEnvelope(new Envelope
        {
            Header = new NotificationHeader { CallId = SubscribedCallId },
            Payload = "{not json"u8.ToArray(),
        }));
        await Settle();

        var failure = Assert.IsType<FailureException>(Assert.Single(_errors));

        Assert.Equal((ushort)ProtocolCode.PayloadUndecodable, failure.Code);
        Assert.Equal(FailureOrigin.Local, failure.Origin);
        Assert.Equal(RouterSide.Client, failure.Side);
        Assert.Equal(InteropProcedures.Ticks.Procedure.Address, failure.ProcedureAddress);
        Assert.Null(failure.Header);
        Assert.NotNull(failure.InnerException);
        Assert.Empty(heard);
    }

    // JSON, in UTF-8, for a subscribing request, its answer and its notifications
    private sealed class JsonNotifications : INotificationSerializerClient<JsonElement, JsonElement, JsonElement>
    {
        public ReadOnlyMemory<byte> Encode(JsonElement request)
        {
            return new JsonPayloads().Encode(request);
        }

        public JsonElement Decode(ReadOnlyMemory<byte> response)
        {
            return new JsonPayloads().Decode(response);
        }

        public JsonElement DecodeNotification(ReadOnlyMemory<byte> notification)
        {
            return new JsonPayloads().Decode(notification);
        }
    }

    private sealed class ClientEnd : IRouterClientTransport
    {
        public TimeProvider Clock { get; init; } = TimeProvider.System;

        public event Action<TransportMessage>? Message;

        public event Action<bool, bool>? Close;

        public ServerEnd? Peer { get; set; }

        public void Deliver(ReadOnlyMemory<byte> bytes)
        {
            Message?.Invoke(new TransportMessage(bytes.ToArray(), false));
        }

        public void CloseConnection()
        {
            Close?.Invoke(false, false);
        }

        public Task Send(TransportMessage message)
        {
            var bytes = message.Bytes;

            Peer!.Deliver(bytes);

            return Task.CompletedTask;
        }
    }

    private sealed class ServerEnd : IServerTransport
    {
        public string? Type
        {
            get
            {
                return TransportTypes.WebSocket;
            }
        }

        public TimeProvider Clock { get; init; } = TimeProvider.System;

        public event Action<string>? Connection;

        public event Action<TransportMessage, string>? Message;

        public event Action<bool, string>? Close;

        public ClientEnd? Peer { get; set; }

        public void Open()
        {
            Connection?.Invoke(Handle);
        }

        public void Deliver(ReadOnlyMemory<byte> bytes)
        {
            Message?.Invoke(new TransportMessage(bytes.ToArray(), false), Handle);
        }

        public void Closed()
        {
            Close?.Invoke(false, Handle);
        }

        public Task<bool> CloseConnection(string connectionHandle)
        {
            return Task.FromResult(false);
        }

        public Task Shutdown()
        {
            return Task.CompletedTask;
        }

        public Task Send(TransportMessage message, string connectionHandle)
        {
            var bytes = message.Bytes;

            Peer!.Deliver(bytes);

            return Task.CompletedTask;
        }
    }
}
