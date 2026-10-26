using System.Globalization;

namespace Bead;

/// <summary>What an end of a broker connection is told of it: its client's or its server's transport.</summary>
internal interface IBrokerConnectionOwner
{
    /// <summary>Whether it opened the connection: a client's, which takes no credential from its server (spec 15.22).</summary>
    bool IsOpener { get; }

    /// <summary>The acceptor's third leg came: the connection is proven, and its router told of it (spec 15.18).</summary>
    void Opened(BrokerConnection connection);

    /// <summary>An envelope came whole, with the credential its DATA carried.</summary>
    void Delivered(BrokerConnection connection, TransportMessage message);

    /// <summary>
    /// The connection ended: clean or not, what it is reported for of its own, none when nothing,
    /// and whether it was dropped without a close; a half-open one ends telling nothing.
    /// </summary>
    void Ended(BrokerConnection connection, (bool IsClean, Exception? Reported, bool IsQuick) end);
}

/// <summary>Where a broker connection stands.</summary>
internal enum BrokerConnectionState
{
    /// <summary>Accepted, its third leg awaited: it holds its place and tells nothing (spec 15.18).</summary>
    HalfOpen,

    /// <summary>Open: its parcels go both ways.</summary>
    Open,

    /// <summary>Ended: what comes of its pair is dropped.</summary>
    Closed,
}

/// <summary>What a broker connection is, as it is made.</summary>
internal sealed record BrokerConnectionSetup
{
    public required IBrokerConnectionOwner Owner { get; init; }

    public required ulong Opener { get; init; }

    public required ulong Acceptor { get; init; }

    /// <summary>The peer participant's id, proven at its third leg.</summary>
    public required string PeerId { get; init; }

    /// <summary>The peer participant's incarnation, which its connection is bound to (spec 15.21).</summary>
    public required UInt128 PeerIncarnation { get; init; }

    /// <summary>The largest parcel the peer's inbox takes whole.</summary>
    public required long PeerBound { get; init; }

    /// <summary>Whether the peer's own leg is secure, as its OPEN or its ACCEPT said.</summary>
    public required bool IsPeerSecure { get; init; }

    /// <summary>The last sequence this end sent: a client's OPEN, 1; none yet, 0, for a server's, whose ACCEPT it publishes.</summary>
    public required ulong Sent { get; init; }

    /// <summary>The next sequence this end awaits.</summary>
    public required ulong Awaited { get; init; }

    /// <summary>What may wait for its broker on it.</summary>
    public required long MaximumUnsentBytes { get; init; }

    /// <summary>Whether it is half-open, its third leg awaited; open otherwise.</summary>
    public required bool IsHalfOpen { get; init; }
}

/// <summary>
/// One end of a connection over a broker (spec 15.17 to 15.23): its pair, the halves both its ends
/// drew; what it sent, numbered from its first; what it awaits, by its sequence, a copy dropped and
/// a gap a loss; its envelope in parts each way; what waits for its broker; its heartbeat; its end.
/// Touched on its participant's scheduler alone.
/// </summary>
internal sealed class BrokerConnection
{
    private readonly BrokerParticipant _participant;
    private readonly BrokerConnectionSetup _setup;
    private readonly BrokerSequence _sequence;
    private readonly BrokerParts _parts;
    private Heartbeat? _heartbeat;
    private ulong _sent;
    private long _unsent;

    public BrokerConnection(BrokerParticipant participant, BrokerConnectionSetup setup)
    {
        _participant = participant;
        _setup = setup;
        _sent = setup.Sent;
        _sequence = new BrokerSequence(setup.Awaited);
        _parts = new BrokerParts(participant.PartsBounds, PartsLate);
        State = setup.IsHalfOpen ? BrokerConnectionState.HalfOpen : BrokerConnectionState.Open;
    }

    public (ulong Opener, ulong Acceptor) Pair
    {
        get
        {
            return (_setup.Opener, _setup.Acceptor);
        }
    }

    public string PeerId
    {
        get
        {
            return _setup.PeerId;
        }
    }

    public UInt128 PeerIncarnation
    {
        get
        {
            return _setup.PeerIncarnation;
        }
    }

    public bool IsPeerSecure
    {
        get
        {
            return _setup.IsPeerSecure;
        }
    }

    public BrokerConnectionState State { get; private set; }

    /// <summary>Its handle, once its router was told of it: a server's alone.</summary>
    public string? ConnectionHandle { get; set; }

    /// <summary>The rank its server drew it at, from 1; none for a client's.</summary>
    public long Arrival { get; set; }

    /// <summary>When it last delivered an envelope, on its participant's clock.</summary>
    public DateTimeOffset? LastActivity { get; private set; }

    /// <summary>What waits for its broker on it.</summary>
    public long UnsentBytes
    {
        get
        {
            return _unsent;
        }
    }

    /// <summary>What it holds in parts.</summary>
    public long PartsBytes
    {
        get
        {
            return _parts.HeldBytes;
        }
    }

    /// <summary>The largest parcel toward its peer: the smaller of its peer's bound and what its adapter publishes to its peer's inbox (spec 15.20).</summary>
    public long Room
    {
        get
        {
            return Math.Min(_setup.PeerBound, _participant.MaximumPayloadBytes(PeerInbox));
        }
    }

    private IReadOnlyList<string> PeerInbox
    {
        get
        {
            return _participant.InboxOf(_setup.PeerId);
        }
    }

    /// <summary>Opens it: its heartbeat started, its peer's departure subscribed (spec 15.21).</summary>
    public void Open()
    {
        State = BrokerConnectionState.Open;
        _participant.Depart((_setup.PeerId, 1));
        _heartbeat = new Heartbeat(_participant.HeartbeatPeriod, new HeartbeatHooks
        {
            Ping = () =>
            {
                _participant.Scheduler.Post(() =>
                {
                    if (State == BrokerConnectionState.Open)
                    {
                        Publish(new BrokerParcel { Kind = BrokerParcelKinds.Ping });
                    }
                });
            },
            Drop = () =>
            {
                _participant.Scheduler.Post(() =>
                {
                    if (State == BrokerConnectionState.Open)
                    {
                        End((4001, false, null));
                    }
                });
            },
        });
    }

    /// <summary>Sends a PING, the next of its sequence: the client's third leg (spec 15.18).</summary>
    public void Ping()
    {
        Publish(new BrokerParcel { Kind = BrokerParcelKinds.Ping });
    }

    /// <summary>
    /// A parcel naming its pair, that reads: a RESET ends it at once, and one of a layout to come
    /// closes it with 1002; any other is taken in its sequence, a copy dropped, a gap a loss, and the
    /// next handed on by its kind, an advisory one skipped, and an OPEN, an ACCEPT, a REFUSE, a GONE,
    /// or anything but a DATA between an envelope's parts, closing it with 1002.
    /// </summary>
    public void Take(BrokerParcel parcel)
    {
        if (State == BrokerConnectionState.Closed)
        {
            return;
        }

        _heartbeat?.Heard();

        if (parcel.Kind == BrokerParcelKinds.Reset)
        {
            Ended((false, null, true));

            return;
        }

        if (parcel.Layout != BrokerParcels.Layout)
        {
            Lose((1002, $"a parcel of a layout to come, {BrokerParcels.HexOf(parcel.Layout)}"));

            return;
        }

        if (!IsNext(parcel.Sequence))
        {
            return;
        }

        // * the third leg: the opener's first parcel naming both halves proves it reads its inbox
        if (State == BrokerConnectionState.HalfOpen)
        {
            _setup.Owner.Opened(this);

            if (State != BrokerConnectionState.Open)
            {
                return;
            }
        }

        if (BrokerParcelKinds.IsAdvisory(parcel.Kind))
        {
            return;
        }

        if (_parts.HeldBytes > 0 && parcel.Kind != BrokerParcelKinds.Data)
        {
            Lose((1002, $"{BrokerParcels.KindNamed(parcel.Kind)} between an envelope's parts"));

            return;
        }

        switch (parcel.Kind)
        {
            case BrokerParcelKinds.Data:
                TakeData(parcel);

                break;

            case BrokerParcelKinds.Ping:
                Publish(new BrokerParcel { Kind = BrokerParcelKinds.Pong, Answers = parcel.Sequence });

                break;

            case BrokerParcelKinds.Pong:
                // a PONG answers what it heard
                break;

            case BrokerParcelKinds.Close:
                Ended((parcel.Code == 1000, null, false));

                break;

            default:
                Lose((1002, $"{BrokerParcels.KindNamed(parcel.Kind)} on a connection open"));

                break;
        }
    }

    /// <summary>
    /// A parcel naming its pair that does not read: a kind to come taken in its order, a copy dropped
    /// and a gap a loss (spec 15.17); then the connection closed with 1002, reported naming it.
    /// </summary>
    public void TakeUnread((BrokerParcel Prefix, string Why) unread)
    {
        if (State == BrokerConnectionState.Closed)
        {
            return;
        }

        _heartbeat?.Heard();

        var sequence = unread.Prefix.Sequence;

        // * a kind to come is taken in its order, a copy dropped and a gap a loss; any other closes at once
        if (BrokerParcelKinds.IsToCome(unread.Prefix.Kind) && sequence <= BrokerParcels.LargestSequence && !IsNext(sequence))
        {
            return;
        }

        Lose((1002, $"a parcel that does not read: {unread.Why}"));
    }

    /// <summary>
    /// Sends an envelope in DATA parcels: whole where it fits the smaller of its peer's bound and
    /// what its adapter publishes to its peer's inbox, in parts otherwise, each as large as that bound
    /// lets it but the last, the credential on the first (spec 15.20); each held to what may wait for
    /// its broker.
    /// </summary>
    public void Send(TransportMessage message)
    {
        if (State != BrokerConnectionState.Open)
        {
            return;
        }

        var credential = string.IsNullOrEmpty(message.Credential) ? null : message.Credential;
        var limit = Room;
        var parts = BrokerParts.Cut(message.Bytes, (limit, credential));

        // ! none where its sender sends what no parcel fits: refused before it came, as Fits says
        if (parts.Count == 0)
        {
            return;
        }

        foreach (var part in parts)
        {
            Publish(part);
        }
    }

    /// <summary>
    /// Publishes a parcel of its pair to its peer's inbox, the one way each of its parcels goes: the
    /// next of its sequence, a RESET unnumbered, what waits for its broker counted until it is taken.
    /// A parcel but a CLOSE that would take that past <c>maximumUnsentBytes</c> loses the connection
    /// instead, a CLOSE of 4000, reported naming the bound (spec 15.23); once it ended, none goes.
    /// </summary>
    public void Publish(BrokerParcel parcel)
    {
        if (State == BrokerConnectionState.Closed)
        {
            return;
        }

        var isReset = parcel.Kind == BrokerParcelKinds.Reset;
        var bytes = BrokerParcels.Write(parcel with { Opener = _setup.Opener, Acceptor = _setup.Acceptor, Sequence = isReset ? 0 : _sent + 1 });

        // ! held before its sequence is taken: the CLOSE that loses the connection is the next, with
        // no gap before it
        if (parcel.Kind != BrokerParcelKinds.Close && _unsent + bytes.Length > _setup.MaximumUnsentBytes)
        {
            Lose((4000, string.Create(CultureInfo.InvariantCulture, $"what waits for its broker would pass maximumUnsentBytes, {_setup.MaximumUnsentBytes} bytes")));

            return;
        }

        if (!isReset)
        {
            _sent += 1;
        }

        _unsent += bytes.Length;

        var published = _participant.Publish(new BrokerPublication { Topic = PeerInbox, Payload = bytes });

        _ = published.ContinueWith(
            (done) =>
            {
                _participant.Scheduler.Post(() =>
                {
                    _unsent -= bytes.Length;

                    // a parcel its broker refused, or no subscriber took: its peer's inbox is gone,
                    // as a dropped socket
                    if ((!done.IsCompletedSuccessfully || done.Result == BrokerPublished.NoSubscriber) && State != BrokerConnectionState.Closed)
                    {
                        Drop();
                    }
                });
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    /// <summary>
    /// Closes it of this end's own: a CLOSE of <paramref name="close"/>'s code sent, its other end
    /// told, a half-open one's among them, which its client holds open; this end's owner told as it
    /// says.
    /// </summary>
    public void Close((int Code, bool IsClean) close)
    {
        if (State == BrokerConnectionState.Closed)
        {
            return;
        }

        Publish(new BrokerParcel { Kind = BrokerParcelKinds.Close, Code = close.Code });
        Ended((close.IsClean, null, false));
    }

    /// <summary>Lets go of it at once, sending nothing, unclean: its link lost, its peer gone, or a half-open one forgotten.</summary>
    public void Drop()
    {
        Ended((false, null, true));
    }

    /// <summary>Sends a RESET of its pair to its peer, unsequenced, and lets go of it, unclean.</summary>
    public void Reset()
    {
        if (State == BrokerConnectionState.Closed)
        {
            return;
        }

        Publish(new BrokerParcel { Kind = BrokerParcelKinds.Reset });
        Ended((false, null, true));
    }

    // its parts' timer, on the clock's thread: judged in its participant's turn, lost when late
    private void PartsLate()
    {
        _participant.Scheduler.Post(() =>
        {
            if (State == BrokerConnectionState.Closed || _parts.HeldBytes == 0)
            {
                return;
            }

            if (_parts.IsLate())
            {
                Lose((4000, _parts.LateOf()));
            }
            else
            {
                _parts.Rearm();
            }
        });
    }

    // whether a sequence is the next awaited; a copy dropped, a gap a loss
    private bool IsNext(ulong sequence)
    {
        switch (_sequence.Take(sequence))
        {
            case BrokerTaking.Copy:
                return false;

            case BrokerTaking.Gap:
                Lose((4000, _sequence.GapOf(sequence)));

                return false;

            default:
                return true;
        }
    }

    private void TakeData(BrokerParcel parcel)
    {
        // ! nothing is carried toward an opener (spec 15.22)
        if (_setup.Owner.IsOpener && parcel.Credential is not null)
        {
            Lose((1002, "a DATA toward its client carries a credential, which no server's does"));

            return;
        }

        var taken = _parts.Take((parcel.Carried, parcel.Has(BrokerParcelFlags.More), parcel.Credential));

        if (taken.Lost is { } lost)
        {
            Lose(lost);

            return;
        }

        if (taken.Envelope is { } envelope)
        {
            LastActivity = _participant.Clock.GetUtcNow();
            _setup.Owner.Delivered(this, new TransportMessage(envelope, false)
            {
                Credential = taken.Credential,
                Address = _setup.Owner.IsOpener ? null : _setup.PeerId,
            });
        }
    }

    // lost of its own: a CLOSE of its code, its end unclean, reported naming why (spec 15.1)
    private void Lose((int Code, string Why) lost)
    {
        if (State == BrokerConnectionState.Closed)
        {
            return;
        }

        Publish(new BrokerParcel { Kind = BrokerParcelKinds.Close, Code = lost.Code });

        var subject = ConnectionHandle ?? (_setup.Owner.IsOpener ? $"the connection to {_setup.PeerId}" : $"a half-open connection of {_setup.PeerId}");

        Ended((false, new IOException(string.Create(CultureInfo.InvariantCulture, $"{subject} is closed with {lost.Code}: {lost.Why}")), false));
    }

    // a CLOSE of a code sent, unclean, unreported: the heartbeat's own drop
    private void End((int Code, bool IsClean, Exception? Reported) end)
    {
        Publish(new BrokerParcel { Kind = BrokerParcelKinds.Close, Code = end.Code });
        Ended((end.IsClean, end.Reported, false));
    }

    // its end, once: its heartbeat and its parts let go of, its participant and its owner told
    private void Ended((bool IsClean, Exception? Reported, bool IsQuick) end)
    {
        if (State == BrokerConnectionState.Closed)
        {
            return;
        }

        var wasOpen = State == BrokerConnectionState.Open;

        State = BrokerConnectionState.Closed;
        _heartbeat?.Stop();
        _parts.Stop();
        _participant.Forget(this);

        if (wasOpen)
        {
            _participant.Depart((_setup.PeerId, -1));
        }

        _setup.Owner.Ended(this, end);
    }
}
