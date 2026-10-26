using System.Collections.Concurrent;
using System.Collections.Frozen;

namespace Bead;

/// <summary>
/// One server transport over several (spec 15.14), so one server — its router, its admission, its
/// sessions, its services, each offered once — takes its connections from each: an in-memory
/// transport beside a WebSocket one, say, as the TypeScript side's <c>joinTransports</c>. Each
/// handle is the one its transport drew, and the join refuses, as it is built, two transports of
/// one type, whose handles might be one; each connection's flags, its sending and its closing are
/// asked of the transport that drew it, known by its handle's type. Each transport's events are
/// told on, with its handle, in the order that transport told them, each listener within the
/// join's guard; its stop stops every one, and settles once all have; its gauges are their sum. It
/// starts nothing: an application starts each transport it joined, at its own address, and the
/// join serves no port of its own, one port for two coming from a proxy in front of them.
/// </summary>
public sealed class JoinedServerTransport : IServerTransport, IAsyncDisposable
{
    // constants

    // what every handle begins with, its type then a semicolon (spec 15.1)
    private const string TypePrefix = "type=";

    private readonly IReadOnlyList<IServerTransport> _transports;
    // each transport by the type its handles begin with
    private readonly FrozenDictionary<string, IServerTransport> _byType;
    // how its events are told: what a listener throws is reported through Error, with its connection
    private readonly ListenerGuard _listeners;
    // each transport's connections as its events told them, what it is counted by when it counts
    // nothing itself
    private readonly IReadOnlyList<ConcurrentDictionary<string, bool>> _told;

    /// <summary>
    /// A join of <paramref name="transports"/>, each told on from now. None, one that names no type
    /// — a join among them — two of one type, and two on different clocks are each an
    /// <see cref="ArgumentException"/>.
    /// </summary>
    public JoinedServerTransport(IReadOnlyList<IServerTransport> transports)
    {
        ArgumentNullException.ThrowIfNull(transports);

        if (transports.Count == 0)
        {
            throw new ArgumentException("a join takes one transport at least", nameof(transports));
        }

        var byType = new Dictionary<string, IServerTransport>(StringComparer.Ordinal);

        foreach (var transport in transports)
        {
            ArgumentNullException.ThrowIfNull(transport, nameof(transports));

            if (transport.Type is not { } type)
            {
                throw new ArgumentException("a join takes transports that name the type of their handles, never a join", nameof(transports));
            }

            // ! a handle tells two types apart, never two transports of one type, whose ranks each
            // count from 1 (decision 0025)
            if (!byType.TryAdd(type, transport))
            {
                throw new ArgumentException($"a join takes one transport of each type: two are {type}, whose handles might be one", nameof(transports));
            }

            if (!ReferenceEquals(transport.Clock, transports[0].Clock))
            {
                throw new ArgumentException("a join's transports run on one clock", nameof(transports));
            }
        }

        _transports = [.. transports];
        _byType = byType.ToFrozenDictionary(StringComparer.Ordinal);
        _listeners = new ListenerGuard((reason, connectionHandle) =>
        {
            Error?.Invoke(reason, connectionHandle ?? "");
        });

        _told = [.. _transports.Select((_) =>
        {
            return new ConcurrentDictionary<string, bool>(StringComparer.Ordinal);
        })];

        foreach (var (transport, told) in _transports.Zip(_told))
        {
            // counted before the join's listeners hear of it, so a gauge they read holds it
            transport.Connection += (connectionHandle) =>
            {
                told.TryAdd(connectionHandle, true);
            };
            transport.Close += (_, connectionHandle) =>
            {
                told.TryRemove(connectionHandle, out _);
            };
            transport.Connection += (connectionHandle) =>
            {
                _listeners.Tell(Connection, connectionHandle);
            };
            transport.Message += (message, connectionHandle) =>
            {
                _listeners.Tell(Message, (message, connectionHandle));
            };
            transport.Close += (isClean, connectionHandle) =>
            {
                _listeners.Tell(Close, (isClean, connectionHandle));
            };
            transport.Listen += (isHeld, connectionHandle) =>
            {
                _listeners.Tell(Listen, (isHeld, connectionHandle));
            };
            transport.Refusal += (refusal) =>
            {
                _listeners.Tell(Refusal, refusal);
            };

            // ! told on as it came, outside the guard: a listener of Error that throws would be
            // reported to itself
            transport.Error += (reason, connectionHandle) =>
            {
                Error?.Invoke(reason, connectionHandle);
            };
        }
    }

    /// <inheritdoc/>
    public event Action<string>? Connection;

    /// <inheritdoc/>
    public event Action<TransportMessage, string>? Message;

    /// <inheritdoc/>
    public event Action<bool, string>? Close;

    /// <summary>Each listen its transports tell, held or ended, with its handle (spec 13.7).</summary>
    public event Action<bool, string>? Listen;

    /// <summary>Each refusal its transports judge of their own (spec 15.1), as each told it.</summary>
    public event Action<TransportServerRefusal>? Refusal;

    /// <summary>
    /// What went wrong on a connection of any of its transports, as each told it, and what a
    /// listener of the join's own events threw, the join going on as if it returned (spec 15.1).
    /// </summary>
    public event Action<Exception, string>? Error;

    /// <summary>None: its handles are of several types, its transports'.</summary>
    public string? Type
    {
        get
        {
            return null;
        }
    }

    /// <summary>What the stack built on it runs on: the one clock of its transports.</summary>
    public TimeProvider Clock
    {
        get
        {
            return _transports[0].Clock;
        }
    }

    /// <summary>The transports it joins, in the order it was given them.</summary>
    public IReadOnlyList<IServerTransport> Transports
    {
        get
        {
            return _transports;
        }
    }

    /// <inheritdoc/>
    public Task Send(TransportMessage message, string connectionHandle)
    {
        return OwnerOf(connectionHandle)?.Send(message, connectionHandle) ?? Task.CompletedTask;
    }

    /// <summary>Whether a connection carries both ways, as the transport that drew it says; none for a handle none of them drew.</summary>
    public bool IsTwoWay(string connectionHandle)
    {
        return OwnerOf(connectionHandle)?.IsTwoWay(connectionHandle) ?? false;
    }

    /// <summary>
    /// Whether a connection carries a credential toward its client, as the transport that drew it
    /// says; none for a handle none of them drew.
    /// </summary>
    public bool CarriesCredential(string connectionHandle)
    {
        return OwnerOf(connectionHandle)?.CarriesCredential(connectionHandle) ?? false;
    }

    /// <summary>Whether a connection is secure, as the transport that drew it says; none for a handle none of them drew.</summary>
    public bool IsSecure(string connectionHandle)
    {
        return OwnerOf(connectionHandle)?.IsSecure(connectionHandle) ?? false;
    }

    /// <summary>Closes a connection through the transport that drew it; false when none holds it.</summary>
    public Task<bool> CloseConnection(string connectionHandle)
    {
        return OwnerOf(connectionHandle)?.CloseConnection(connectionHandle) ?? Task.FromResult(false);
    }

    /// <summary>Stops every transport it joined, and settles once all have, with what each threw.</summary>
    public Task Shutdown()
    {
        return Task.WhenAll(_transports.Select((transport) =>
        {
            return transport.Shutdown();
        }));
    }

    /// <summary>
    /// What its transports hold, summed: each count and each ceiling added by its name, the
    /// connections any of them keeps anything for, and all they found that should never be; one
    /// that counts nothing counted by its connections, as its events told them.
    /// </summary>
    public Gauges Gauges()
    {
        var parts = _transports.Zip(_told).Select((pair) =>
        {
            var (transport, told) = pair;
            var handles = told.Keys;

            return transport.Gauges() ?? Bead.Gauges.Of(new Dictionary<string, long> { ["connections"] = handles.Count }, handles);
        }).ToList();

        var counts = new Dictionary<string, long>(StringComparer.Ordinal);
        var ceilings = new Dictionary<string, long>(StringComparer.Ordinal);

        foreach (var part in parts)
        {
            foreach (var (name, count) in part.Counts)
            {
                counts[name] = counts.GetValueOrDefault(name) + count;
            }

            foreach (var (name, ceiling) in part.Ceilings)
            {
                ceilings[name] = ceilings.GetValueOrDefault(name) + ceiling;
            }
        }

        return new Gauges
        {
            Anomalies = [.. parts.SelectMany((part) =>
            {
                return part.Anomalies;
            })],
            Ceilings = ceilings.ToFrozenDictionary(StringComparer.Ordinal),
            ConnectionHandles = parts.SelectMany((part) =>
            {
                return part.ConnectionHandles;
            }).ToFrozenSet(StringComparer.Ordinal),
            Counts = counts.ToFrozenDictionary(StringComparer.Ordinal),
        };
    }

    /// <summary>As <see cref="Shutdown"/>.</summary>
    public async ValueTask DisposeAsync()
    {
        await Shutdown();
    }

    // the transport that drew a handle, by the type it begins with; none for one of another type
    private IServerTransport? OwnerOf(string connectionHandle)
    {
        ArgumentNullException.ThrowIfNull(connectionHandle);

        if (!connectionHandle.StartsWith(TypePrefix, StringComparison.Ordinal))
        {
            return null;
        }

        var end = connectionHandle.IndexOf(';', TypePrefix.Length);
        var type = end < 0 ? connectionHandle[TypePrefix.Length..] : connectionHandle[TypePrefix.Length..end];

        return _byType.GetValueOrDefault(type);
    }
}
