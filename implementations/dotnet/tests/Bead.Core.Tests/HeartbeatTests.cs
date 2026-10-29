using System.Collections.Concurrent;
using System.Diagnostics;

namespace Bead.Tests;

/// <summary>
/// A broker connection's heartbeat (spec 15.21), the twin of the TypeScript side's: on the
/// platform's timer, in real time, whatever clock the side is given (0011).
/// </summary>
public sealed class HeartbeatTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private static CancellationToken Cancelled
    {
        get
        {
            return TestContext.Current.CancellationToken;
        }
    }

    private static async Task Until(Func<bool> holds)
    {
        var watch = Stopwatch.StartNew();

        while (!holds() && watch.Elapsed < Patience)
        {
            await Task.Delay(5, Cancelled);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Drops_an_unanswered_ping_after_a_delayed_beat_without_arming_a_timer_for_less_than_nothing(bool crossesDeadline)
    {
        var clock = new DelayedClock();
        var heard = new List<string>();
        var heartbeat = new Heartbeat(TimeSpan.FromMilliseconds(100), new HeartbeatHooks
        {
            Ping = () =>
            {
                heard.Add("ping");
            },
            Drop = () =>
            {
                heard.Add("drop");
            },
        }, new HeartbeatOptions { Clock = clock });

        try
        {
            clock.Fire([100, 100]);
            Assert.Equal(["ping"], heard);
            Assert.Equal([100, 100], clock.Dues);

            if (crossesDeadline)
            {
                // * silence reads 199, then the ping's age reads 199; a second age read sees 201
                clock.Fire([199, 199, 201]);
                Assert.Equal(["ping"], heard);
                Assert.Equal([100, 100, 1], clock.Dues);
            }

            // * the timer due at 200 runs at 201: the unanswered ping is dropped at once
            clock.Fire([201, 201]);
            Assert.Equal(["ping", "drop"], heard);
            Assert.Equal(crossesDeadline ? new double[] { 100, 100, 1 } : [100, 100], clock.Dues);
            Assert.False(clock.IsArmed);
        }
        finally
        {
            heartbeat.Stop();
        }
    }

    [Fact]
    public async Task Pings_a_connection_silent_for_its_heartbeat_on_the_platform_s_timer_and_drops_one_that_answered_nothing_by_the_next()
    {
        var beat = TimeSpan.FromMilliseconds(200);
        var (pings, drops) = (0, 0);
        var watch = Stopwatch.StartNew();
        var heartbeat = new Heartbeat(beat, new HeartbeatHooks
        {
            Ping = () =>
            {
                Interlocked.Increment(ref pings);
            },
            Drop = () =>
            {
                Interlocked.Increment(ref drops);
            },
        });

        // silent for a heartbeat: pinged, no sooner
        await Until(() =>
        {
            return Volatile.Read(ref pings) == 1;
        });
        Assert.Equal(1, Volatile.Read(ref pings));
        Assert.True(watch.Elapsed >= beat - TimeSpan.FromMilliseconds(20), $"pinged at {watch.Elapsed}");

        // answered nothing by the next: dropped, and beats no more
        await Until(() =>
        {
            return Volatile.Read(ref drops) == 1;
        });
        await Task.Delay(beat * 3, Cancelled);
        Assert.Equal((1, 1), (pings, drops));

        // a connection heard from every tenth of its heartbeat is never pinged: a margin a loaded run
        // keeps, as the WebSocket's heartbeat tests wait theirs within a patience
        var heard = 0;
        var talking = new Heartbeat(beat * 10, new HeartbeatHooks
        {
            Ping = () =>
            {
                Interlocked.Increment(ref heard);
            },
            Drop = () =>
            {
                Interlocked.Increment(ref heard);
            },
        });

        for (var index = 0; index < 10; index += 1)
        {
            await Task.Delay(beat, Cancelled);
            talking.Heard();
        }

        talking.Stop();
        Assert.Equal(0, heard);

        // anything heard answers the ping, and none beats once stopped
        var (answeredPings, answeredDrops) = (0, 0);
        var answered = new Heartbeat(TimeSpan.FromSeconds(1), new HeartbeatHooks
        {
            Ping = () =>
            {
                Interlocked.Increment(ref answeredPings);
            },
            Drop = () =>
            {
                Interlocked.Increment(ref answeredDrops);
            },
        });

        try
        {
            await Until(() =>
            {
                return Volatile.Read(ref answeredPings) == 1;
            });
            Assert.Equal((1, 0), (Volatile.Read(ref answeredPings), Volatile.Read(ref answeredDrops)));
            answered.Heard();
            await Task.Delay(100, Cancelled);
            Assert.Equal((1, 0), (Volatile.Read(ref answeredPings), Volatile.Read(ref answeredDrops)));
            answered.Stop();
            await Task.Delay(300, Cancelled);
            Assert.Equal((1, 0), (Volatile.Read(ref answeredPings), Volatile.Read(ref answeredDrops)));
        }
        finally
        {
            answered.Stop();
        }

        // without end, it arms nothing
        var never = new Heartbeat(Timeout.InfiniteTimeSpan, new HeartbeatHooks
        {
            Ping = () =>
            {
                Interlocked.Increment(ref heard);
            },
            Drop = () =>
            {
                Interlocked.Increment(ref heard);
            },
        });

        await Task.Delay(beat * 2, Cancelled);
        never.Stop();
        Assert.Equal(0, heard);
    }

    [Fact]
    public async Task Starts_a_fresh_silence_after_anything_heard_answers_its_ping_then_drops_a_ping_left_unanswered()
    {
        var heard = new ConcurrentQueue<string>();
        var heartbeat = new Heartbeat(TimeSpan.FromMilliseconds(100), new HeartbeatHooks
        {
            Ping = () =>
            {
                heard.Enqueue("ping");
            },
            Drop = () =>
            {
                heard.Enqueue("drop");
            },
        });

        try
        {
            await Until(() =>
            {
                return !heard.IsEmpty;
            });
            Assert.Equal(["ping"], heard.ToArray());
            heartbeat.Heard();
            await Until(() =>
            {
                return heard.Count >= 3;
            });
            Assert.Equal(["ping", "ping", "drop"], heard.ToArray());
        }
        finally
        {
            heartbeat.Stop();
        }
    }

    [Fact]
    public async Task Beats_no_more_once_its_own_ping_stopped_it()
    {
        var (pings, drops) = (0, 0);
        Heartbeat? heartbeat = null;

        // * a ping that ends its connection, as one past what may wait for its broker does
        heartbeat = new Heartbeat(TimeSpan.FromMilliseconds(100), new HeartbeatHooks
        {
            Ping = () =>
            {
                Interlocked.Increment(ref pings);
                heartbeat?.Stop();
            },
            Drop = () =>
            {
                Interlocked.Increment(ref drops);
            },
        });

        await Until(() =>
        {
            return Volatile.Read(ref pings) == 1;
        });
        await Task.Delay(TimeSpan.FromMilliseconds(300), Cancelled);
        Assert.Equal((1, 0), (pings, drops));
    }

    // * a timer fired by hand: its readings can pass a deadline within one callback
    private sealed class DelayedClock : TimeProvider
    {
        private Queue<long> _readings = new();
        private long _now;
        private Action? _fire;

        public List<double> Dues { get; } = [];

        public bool IsArmed { get; set; }

        public override long TimestampFrequency
        {
            get
            {
                return 1000;
            }
        }

        public override long GetTimestamp()
        {
            if (_readings.TryDequeue(out var next))
            {
                _now = next;
            }

            return _now;
        }

        public void Fire(long[] readings)
        {
            Assert.True(IsArmed);
            IsArmed = false;
            _readings = new Queue<long>(readings);
            _fire!();
        }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            _fire = () =>
            {
                callback(state);
            };
            var timer = new DelayedTimer(this);
            timer.Change(dueTime, period);
            return timer;
        }

        private sealed class DelayedTimer(DelayedClock clock) : ITimer
        {
            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                Assert.Equal(Timeout.InfiniteTimeSpan, period);
                clock.IsArmed = dueTime != Timeout.InfiniteTimeSpan;

                if (clock.IsArmed)
                {
                    Assert.InRange(dueTime, TimeSpan.FromMilliseconds(1), Clocks.LongestTimer);
                    clock.Dues.Add(dueTime.TotalMilliseconds);
                }

                return true;
            }

            public void Dispose()
            {
                clock.IsArmed = false;
            }

            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }
        }
    }
}
