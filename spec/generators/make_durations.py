"""Writes spec/durations.json: what every place that takes a duration an application gives a side makes
of every input, and why it refuses one (spec 1.4, decision 0014).

Each outcome is spec 1.4 over the input's value as written. Beside it, the generator plays each
platform's own conversion — JavaScript's arithmetic on a double, .NET's TimeSpan, truncated to its
ticks, and Rust's Duration, rounded to the nanosecond — and fails on any outcome one reaches
otherwise, unless that outcome, or its input, crosses a row of docs/support.md for that language;
and on any input in seconds within a platform's error of a half: a tick, or half a nanosecond."""
import json
import math
import os
from decimal import Decimal
from fractions import Fraction

from bounds import DEFAULTS
from spec_version import spec_version

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')

# the ceiling, 2³¹ − 1 ms, as every platform's timers hold one alike
CEILING = 2 ** 31 - 1

# .NET counts a TimeSpan in ticks of 100 ns; its never, Timeout.InfiniteTimeSpan, is -1 ms
TICKS_PER_MILLISECOND = 10_000
TICKS_PER_SECOND = 10_000_000
INFINITE_TICKS = -TICKS_PER_MILLISECOND

# a tick, in milliseconds: no input in seconds comes within it of a half
TICK = Fraction(1, TICKS_PER_MILLISECOND)

# Rust counts a Duration in nanoseconds, Duration::from_secs_f64 rounding the double to the nearest:
# its error is half a nanosecond, in milliseconds
NANOSECONDS_PER_MILLISECOND = 1_000_000
HALF_A_NANOSECOND = Fraction(1, 2 * NANOSECONDS_PER_MILLISECOND)

# the rows of docs/support.md the inputs and the ways cross
FINER_THAN_A_TICK = 'A duration finer than a tick'
MINUS_ONE = 'A duration of -1 ms'
NOT_A_NUMBER = 'A duration that is not a number'
UNDER_ZERO = 'A duration under zero'
WEB_WORKER = 'The Web Worker transport'
DELAY_AS_A_NUMBER = "A reconnection's delay given as a number"

# what a value is beside a number of milliseconds
NEVER = 'never'
NO_NUMBER = 'no number'
UNPLAYABLE = 'unplayable'

# ── The inputs ────────────────────────────────────────────────────────────────────────────────────

# name, form, value, and the row each language's outcomes may cross: where a platform reaches
# another outcome than 1.4 gives, the outcome names that row, and where it cannot be given the input
# at all, the input does
inputs = [
    ('0', 'milliseconds', 0, {}),
    ('0.00001 ms, under a tick', 'milliseconds', 0.00001, {'C#': FINER_THAN_A_TICK}),
    ('half a millisecond', 'milliseconds', 0.5, {}),
    ('a millisecond', 'milliseconds', 1, {}),
    ('1.4 ms', 'milliseconds', 1.4, {}),
    ('1.5 ms', 'milliseconds', 1.5, {}),
    ('2.5 ms', 'milliseconds', 2.5, {}),
    ('0.41 s, as written', 'seconds', 0.41, {}),
    ('2.01 s, as written', 'seconds', 2.01, {}),
    ('the ceiling', 'milliseconds', CEILING, {}),
    ('0.00001 ms past the ceiling', 'milliseconds', 2147483647.00001, {'C#': FINER_THAN_A_TICK}),
    ('0.4 ms past the ceiling', 'milliseconds', 2147483647.4, {}),
    ('half a millisecond past the ceiling', 'milliseconds', 2147483647.5, {}),
    ('never', 'never', True, {}),
    ('-2 ms', 'milliseconds', -2, {'Rust': UNDER_ZERO}),
    ('-1 ms', 'milliseconds', -1, {'C#': MINUS_ONE, 'Rust': UNDER_ZERO}),
    ('NaN', 'nan', True, {'C#': NOT_A_NUMBER, 'Rust': NOT_A_NUMBER}),
    ('"1000"', 'json', '1000', {'C#': NOT_A_NUMBER, 'Rust': NOT_A_NUMBER}),
    ('true', 'json', True, {'C#': NOT_A_NUMBER, 'Rust': NOT_A_NUMBER}),
]


def written(value):
    """A number as written: its decimal, exactly, as its literal reads."""
    return Fraction(Decimal(repr(value)))


def as_given(form, value):
    """The input's value as written, in milliseconds: what spec 1.4 holds."""
    if form == 'milliseconds':
        return written(value)

    if form == 'seconds':
        return written(value) * 1000

    return NEVER if form == 'never' else NO_NUMBER


def in_javascript(form, value):
    """The input as the TypeScript side is given it: a double, seconds * 1000 for seconds, Infinity
    for never, NaN, or the JSON value itself, which is no number."""
    if form == 'milliseconds':
        return Fraction(float(value))

    if form == 'seconds':
        return Fraction(float(value) * 1000.0)

    return NEVER if form == 'never' else NO_NUMBER


def in_dotnet(form, value):
    """The input as the C# side is given it: TimeSpan.FromMilliseconds and TimeSpan.FromSeconds
    multiply the double into ticks and truncate them; Timeout.InfiniteTimeSpan for never, -1 ms
    itself; and no TimeSpan for NaN, which .NET refuses, nor for what is no number."""
    if form == 'never':
        return NEVER

    if form not in ('milliseconds', 'seconds'):
        return UNPLAYABLE

    ticks = math.trunc(float(value) * float(TICKS_PER_MILLISECOND if form == 'milliseconds' else TICKS_PER_SECOND))

    # TotalMilliseconds, the double a side rounds
    return NEVER if ticks == INFINITE_TICKS else Fraction(ticks / TICKS_PER_MILLISECOND)


def in_rust(form, value):
    """The input as the Rust side is given it: Duration::from_secs_f64 of a double, ms / 1000.0 for
    milliseconds and the seconds themselves for seconds, its exact value rounded to the nearest
    nanosecond; Duration::MAX for never; and no Duration for a value under zero, NaN or what is no
    number, which the type cannot hold."""
    if form == 'never':
        return NEVER

    if form not in ('milliseconds', 'seconds') or value < 0:
        return UNPLAYABLE

    seconds = Fraction(float(value) / 1000.0 if form == 'milliseconds' else float(value))
    nanoseconds = math.floor(seconds * 1_000_000_000 + Fraction(1, 2))

    return Fraction(nanoseconds, NANOSECONDS_PER_MILLISECOND)


# each side by its language, its platform, how it is given an input, and its error near a half, in
# milliseconds
PLATFORMS = (('TypeScript', 'JavaScript', in_javascript, TICK), ('C#', '.NET', in_dotnet, TICK),
             ('Rust', 'Rust', in_rust, HALF_A_NANOSECOND))
GIVEN = {language: given for language, _, given, _ in PLATFORMS}


def nearest(milliseconds):
    """The nearest whole millisecond, a half away from zero (IEEE 754's roundTiesToAway), as
    Math.round and MidpointRounding.AwayFromZero hold a positive value: never Python's round, which
    takes a half to the even."""
    whole = math.floor(milliseconds)

    return whole if milliseconds - whole < Fraction(1, 2) else whole + 1


for name, form, value, _ in inputs:
    if form != 'seconds':
        continue

    # ! a value within a platform's error of a half rounds one way or the other with that error: a
    # tick as written and on the platforms that count one, half a nanosecond on Rust's
    for platform, milliseconds, error in (('as written', as_given(form, value), TICK),
                                          *((label, given(form, value), near)
                                            for _, label, given, near in PLATFORMS)):
        if abs(milliseconds - math.floor(milliseconds) - Fraction(1, 2)) < error:
            raise SystemExit(f'{name}: {platform}, {float(milliseconds)!r} ms lies within its error of a half')

# ── The places ────────────────────────────────────────────────────────────────────────────────────


def way(key, name, *, required=False, differs=()):
    """A way the surface takes a place's duration, by an id stable in its place; required, its
    duration cannot be left out; differs, each language that lacks it and the row that says so."""
    return {'id': key, 'name': name, **({'required': True} if required else {}),
            **({'differs': [{'row': row, 'language': language} for language, row in differs]} if differs else {})}


def default(clause, *, milliseconds=None, ways, state=None):
    """A default a clause states, its milliseconds or never, read by building each of `ways` with
    nothing given, in `state` where it holds only so."""
    return {**({'milliseconds': milliseconds} if milliseconds is not None else {'never': True}),
            'clause': clause, 'ways': ways, **({'state': state} if state else {})}


# a gateway's options, which take the bounds of 15.12 by their names (transcoding 10.2)
GATEWAY = way('gateway', "a gateway's options, as it is built")

places = [
    {
        'id': 'call.timeout',
        'name': "a call's timeout, given to a call a service manager makes or to its router's request",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '9.9',
        'ways': [
            way('serviceManager', "a call's own options, as its service manager applies its defaults"),
            way('router', "the options its router's request is given, resolved", required=True),
        ],
        'default': default('9.9', milliseconds=5_000, ways=['serviceManager'],
                           state='a service manager given no default timeout of its own'),
        'observed': 'held',
    },
    {
        'id': 'serviceManager.defaultTimeout',
        'name': "a service manager's default timeout for its calls",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '9.9',
        'ways': [way('options', "the manager's options, as it is built")],
        'default': default('9.9', milliseconds=5_000, ways=['options']),
        'observed': 'held',
    },
    {
        'id': 'router.reservation',
        'name': "a call id's reservation, a reserve's or a cancel's",
        'kind': 'timeout',
        'never': 'default',
        'neverClause': '10.3',
        'ways': [
            way('reserve', "a call id its router reserves"),
            way('cancel', "a call id its router cancels"),
        ],
        'default': default('10.3', milliseconds=5_000, ways=['reserve', 'cancel'],
                           state="a reserve, or a cancel of a call id no call waits on: a cancel of a call that "
                                 "waits, given none, reserves for that call's own timeout"),
        'observed': 'held',
    },
    {
        'id': 'router.transferInactivityTimeout',
        'name': "a transfer's inactivity, a router's limit",
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '12.2',
        'ways': [way('limits', "the router's limits, as it is built")],
        'default': default('12.2.8', milliseconds=30_000, ways=['limits']),
        'observed': 'held',
    },
    {
        'id': 'relay.timeout',
        'name': "a relay's timeout, its own or a destination's at register",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '14.4',
        'ways': [
            way('relay', "the relay's options, as it is built"),
            way('register', "a destination's, as it is registered"),
        ],
        'default': default('14.4', ways=['relay', 'register'],
                           state="a destination registered with none, under a relay given none"),
        'observed': 'held',
    },
    {
        'id': 'sessionManager.connectionInactivityTimeout',
        'name': "a session manager's default connection timeout",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '13.7',
        'ways': [way('options', "the manager's options, as it is built")],
        'default': default('13.7', ways=['options']),
        'observed': 'held',
    },
    {
        'id': 'sessionManager.sessionInactivityTimeout',
        'name': "a session manager's default session timeout",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '13.7',
        'ways': [way('options', "the manager's options, as it is built")],
        'default': default('13.7', ways=['options']),
        'observed': 'held',
    },
    {
        'id': 'session.inactivityTimeouts',
        'name': "a session's two timeouts, as it is set or updated",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '13.7',
        'ways': [
            way('setConnection', 'its connection timeout, as its manager sets the session'),
            way('setSession', 'its session timeout, as its manager sets the session'),
            way('updateConnection', 'its connection timeout, as its manager updates it'),
            way('updateSession', 'its session timeout, as its manager updates it'),
        ],
        'default': default('13.7', ways=['setConnection', 'setSession', 'updateConnection', 'updateSession'],
                           state="a session under a manager given none of its defaults, each left out taking the "
                                 "manager's"),
        'observed': 'held',
    },
    {
        'id': 'sessionManager.resetConnectionInactivityTimeout',
        'name': "a reset of a connection's timeout",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '13.7',
        'ways': [way('reset', "the reset's argument", required=True)],
        'observed': 'held',
    },
    {
        'id': 'sessionManager.resetSessionInactivityTimeout',
        'name': "a reset of a session's timeout",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '13.7',
        'ways': [way('reset', "the reset's argument", required=True)],
        'observed': 'held',
    },
    {
        'id': 'server.connectionInactivityTimeout',
        'name': "a server's own connection timeout, its server layer's option",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '13.7',
        'ways': [way('options', "the server layer's options, as it is built")],
        'default': default('13.7', ways=['options'],
                           state='the server layer over a transport that gives it none: an HTTP server gives its '
                                 "own, 30 s (15.12.10), which spec/transports.json's defaults state"),
        'observed': 'held',
    },
    {
        'id': 'httpTransportServer.exchangeTimeout',
        'name': "an HTTP server's exchange timeout",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '15.12',
        'ways': [way('options', "the transport server's options, as it is built")],
        'default': default('15.12.8', milliseconds=DEFAULTS['exchangeTimeout'], ways=['options']),
        'observed': 'held',
    },
    {
        'id': 'httpTransportServer.maximumWait',
        'name': 'the longest an HTTP server holds a listen',
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '15.12',
        'ways': [way('options', "the transport server's options, as it is built")],
        'default': default('15.12.7', milliseconds=DEFAULTS['maximumWait'], ways=['options']),
        'observed': 'held',
    },
    {
        'id': 'httpTransportServer.sendGracePeriod',
        'name': "the least time an HTTP server, or a gateway, gives an answer's bytes to be taken by its socket",
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '15.12',
        'ways': [way('options', "the transport server's options, as it is built"), GATEWAY],
        'observed': 'refusal',
    },
    {
        'id': 'httpTransportServer.headersTimeout',
        'name': "how long an HTTP server, or a gateway, lets a request's head take to come whole",
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '15.12',
        'ways': [way('options', "the transport server's options, as it is built"), GATEWAY],
        'observed': 'refusal',
    },
    {
        'id': 'httpTransportServer.bodyGracePeriod',
        'name': "how long an HTTP server, or a gateway, lets a body come before its rate is held",
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '15.12',
        'ways': [way('options', "the transport server's options, as it is built"), GATEWAY],
        'default': default('15.12.16', milliseconds=DEFAULTS['bodyGracePeriod'], ways=['options', 'gateway']),
        'observed': 'held',
    },
    {
        'id': 'httpTransport.inactivityTimeout',
        'name': "an HTTP connection's inactivity timeout, its client's or its server's",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '15.12',
        'ways': [
            way('client', "the transport client's options, as it is built"),
            way('server', "the transport server's options, as it is built"),
        ],
        'default': default('15.12.9', milliseconds=DEFAULTS['inactivityTimeout'], ways=['client', 'server']),
        'observed': 'held',
    },
    {
        'id': 'httpTransportClient.wait',
        'name': "the wait an HTTP client's listens ask",
        'kind': 'delay',
        'never': 'refused',
        'ways': [way('options', "the transport client's options, as it is built")],
        'observed': 'held',
    },
    {
        'id': 'httpTransportClient.pause',
        'name': "an HTTP client's pause between listens",
        'kind': 'delay',
        'never': 'refused',
        'ways': [way('options', "the transport client's options, as it is built")],
        'observed': 'held',
    },
    {
        'id': 'webSocketTransport.heartbeat',
        'name': "a WebSocket's heartbeat, its client's or its server's",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '15.3',
        'ways': [
            way('client', "the transport client's options, as it is built"),
            way('server', "the transport server's options, as it is built"),
        ],
        'observed': 'refusal',
    },
    {
        'id': 'webSocketTransport.closeTimeout',
        'name': "a WebSocket's close timeout, its client's or its server's",
        'kind': 'timeout',
        'never': 'taken',
        'ways': [
            way('client', "the transport client's options, as it is built"),
            way('server', "the transport server's options, as it is built"),
        ],
        'observed': 'refusal',
    },
    {
        'id': 'transportClient.connectTimeout',
        'name': "a connect's timeout, on every transport",
        'kind': 'timeout',
        'never': 'taken',
        'ways': [
            way('http', "an HTTP client's connect"),
            way('webSocket', "a WebSocket client's connect"),
            way('memory', "an in-memory client's connect"),
            way('worker', "a Web Worker client's connect", differs=(('C#', WEB_WORKER), ('Rust', WEB_WORKER))),
            way('broker', "a broker client's connect"),
        ],
        'observed': 'held',
    },
    # a broker's (spec 15.21, 15.23): its heartbeat on the platform's timer, as a WebSocket's, observed
    # by its refusal alone; a half-open connection's wait and the grace of an envelope's parts on the
    # clock given (decision 0011). A participant's link reconnects as a transport client does, its delay
    # transportClient.reconnectionDelay's
    {
        'id': 'brokerParticipant.heartbeat',
        'name': "a broker participant's heartbeat on a silent connection",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': '15.21',
        'ways': [way('options', "the participant's options, as it is built")],
        'observed': 'refusal',
    },
    {
        'id': 'brokerTransportServer.acceptTimeout',
        'name': "how long a broker server's half-open connection waits for its client's first parcel",
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '15.23',
        'ways': [way('options', "the transport server's options, as it is built")],
        'default': default('15.23.2', milliseconds=DEFAULTS['acceptTimeout'], ways=['options']),
        'observed': 'held',
    },
    {
        'id': 'brokerParticipant.bodyGracePeriod',
        'name': "how long an envelope's parts come over a broker before their rate is held",
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '15.12',
        'ways': [way('options', "the participant's options, as it is built")],
        'default': default('15.12.16', milliseconds=DEFAULTS['bodyGracePeriod'], ways=['options']),
        'observed': 'held',
    },
    # MQTT 5's adapter (spec 15.26, 15.30): its Keep Alive and the wait for its CONNACK, each on its
    # library's timer, so observed by its refusal alone; a Keep Alive is held in whole seconds, 65,535
    # at most, a ceiling of its own below 1.4's
    {
        'id': 'mqttBrokerAdapter.keepAlive',
        'name': "an MQTT 5 adapter's Keep Alive, which its broker counts its link lost by",
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '15.30',
        'ways': [way('options', "the adapter's options, as it is built")],
        'ceiling': {'milliseconds': 65_535_000, 'clause': '15.30'},
        'observed': 'refusal',
    },
    {
        'id': 'mqttBrokerAdapter.connectTimeout',
        'name': "how long an MQTT 5 adapter's start waits for its CONNACK",
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '15.30',
        'ways': [way('options', "the adapter's options, as it is built")],
        'observed': 'refusal',
    },
    # AMQP 1.0's adapter (spec 15.33, 15.37): its OPEN's idle-time-out and the wait for its broker's
    # OPEN, its sessions and its inbox, each on its library's timer, so observed by its refusal alone;
    # an idle-time-out is held to 1,073,741,823 ms, a ceiling of its own below 1.4's, since its library
    # counts its link lost by twice it, which 2³¹ − 1 then still holds
    {
        'id': 'amqpBrokerAdapter.idleTimeout',
        'name': "an AMQP 1.0 adapter's idle-time-out, which it counts its link lost by twice over",
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '15.37',
        'ways': [way('options', "the adapter's options, as it is built")],
        'ceiling': {'milliseconds': 1_073_741_823, 'clause': '15.37'},
        'observed': 'refusal',
    },
    {
        'id': 'amqpBrokerAdapter.connectTimeout',
        'name': "how long an AMQP 1.0 adapter waits on its broker: its start, for its OPEN, its sessions and its inbox; its inbox's deletion; a name let go; and its stop",
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '15.37',
        'ways': [way('options', "the adapter's options, as it is built")],
        'observed': 'refusal',
    },
    {
        'id': 'transportClient.reconnectionDelay',
        'name': "a reconnection's delay",
        'kind': 'delay',
        'never': 'refused',
        'ways': [
            way('function', 'a function of the previous delay and the attempt, its answer'),
            way('number', 'a number', differs=(('C#', DELAY_AS_A_NUMBER),)),
        ],
        'observed': 'held',
    },
    {
        'id': 'webSocketTransportServer.sendGracePeriod',
        'name': "the least time a WebSocket server gives an envelope's bytes to be taken by its socket",
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '15.12',
        'ways': [way('options', "the transport server's options, as it is built")],
        'observed': 'refusal',
    },
    {
        'id': 'webSocketTransportServer.headersTimeout',
        'name': "how long a WebSocket server lets an upgrade's head take to come whole",
        'kind': 'timeout',
        'never': 'refused',
        'neverClause': '15.12',
        'ways': [way('options', "the transport server's options, as it is built")],
        'observed': 'refusal',
    },
    {
        'id': 'gateway.timeout',
        'name': "a gateway's call timeout",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': 'transcoding:9.2',
        'ways': [way('options', "the gateway's options, as it is built")],
        'default': default('transcoding:9.2', milliseconds=5_000, ways=['options']),
        'observed': 'held',
    },
    {
        'id': 'gateway.heartbeat',
        'name': "a gateway's heartbeat on a stream nothing else goes on",
        'kind': 'timeout',
        'never': 'taken',
        'neverClause': 'transcoding:8.7',
        'ways': [way('options', "the gateway's options, as it is built")],
        'observed': 'refusal',
    },
]

# ── The outcomes ──────────────────────────────────────────────────────────────────────────────────


def outcome_of(value, place):
    """What spec 1.4 makes of `value` at `place`: held, at once, never, its default, or refused and
    why. A place observed by its refusal alone reads every outcome but a refusal as taken."""
    if value == NO_NUMBER:
        met = {'outcome': 'refused', 'reason': 'not a number'}
    elif value == NEVER and place['never'] == 'taken':
        met = {'outcome': 'never'}
    elif value == NEVER and place['never'] == 'default':
        met = {'outcome': 'default', 'held': place['default']['milliseconds']}
    elif value == NEVER:
        met = {'outcome': 'refused', 'reason': 'never refused'}
    elif value == 0 and place['kind'] == 'delay':
        met = {'outcome': 'at once'}
    elif value == 0:
        met = {'outcome': 'refused', 'reason': '0 refused'}
    elif value < 1:
        met = {'outcome': 'refused', 'reason': 'under the floor'}
    elif value > place.get('ceiling', {}).get('milliseconds', CEILING):
        met = {'outcome': 'refused', 'reason': 'past the ceiling'}
    else:
        met = {'outcome': 'held', 'held': nearest(value)}

    if place['observed'] == 'refusal' and met['outcome'] != 'refused':
        return {'outcome': 'taken'}

    return met


def unit_order(unit):
    """A unit's place: the spec's first, then a companion's, behind its name and a colon."""
    document, _, number = unit.rpartition(':')
    return document, tuple(int(part) for part in number.split('.'))


def clauses_of(place):
    """The units a place cites: what it observes of each, and nothing else — 1.4, which holds and
    refuses its durations; the clause that says whether it may be without end, where 1.4 does not
    alone, since 1.4 lets a timeout or a bound be without end and never a delay; the clause that
    states a ceiling of its own below 1.4's, where it has one; and the clause that states its
    default."""
    if place['never'] != ('refused' if place['kind'] == 'delay' else 'taken') and 'neverClause' not in place:
        raise SystemExit(f'{place["id"]}: never {place["never"]}, which no clause states')

    if place['never'] == 'default' and 'milliseconds' not in place.get('default', {}):
        raise SystemExit(f'{place["id"]}: never taken as its default, which states no milliseconds')

    if place['observed'] == 'refusal' and 'default' in place:
        raise SystemExit(f'{place["id"]}: a default, which a place observed by its refusal never reads')

    cited = {'1.4', place.get('neverClause', '1.4'), place.get('ceiling', {}).get('clause', '1.4'),
             place.get('default', {}).get('clause', '1.4')}

    return sorted(cited, key=unit_order)


crossed = set()

for place in places:
    place['clauses'] = clauses_of(place)
    place['outcomes'] = []

    for name, form, value, rows in inputs:
        met = outcome_of(as_given(form, value), place)
        differs = []

        for language, _, given, _ in PLATFORMS:
            reached = given(form, value)

            if reached == UNPLAYABLE or outcome_of(reached, place) == met:
                continue

            if language not in rows:
                raise SystemExit(f'{place["id"]}, {name}: the {language} side reaches {outcome_of(reached, place)}, '
                                 f'where spec 1.4 gives {met}, and the input names no row it crosses')

            differs.append({'row': rows[language], 'language': language})
            crossed.add((name, language))

        place['outcomes'].append({'input': name, **met, **({'differs': differs} if differs else {})})

for name, form, value, rows in inputs:
    for language in rows:
        if (name, language) not in crossed and GIVEN[language](form, value) != UNPLAYABLE:
            raise SystemExit(f'{name}: names the row {rows[language]!r} for the {language} side, which reaches '
                             "1.4's outcome at every place")


def entry_of(name, form, value, rows):
    """An input as the file writes it: its form, and the rows of the languages that cannot be given
    it at all."""
    unplayable = [{'row': rows[language], 'language': language} for language, _, given, _ in PLATFORMS
                  if given(form, value) == UNPLAYABLE]

    return {'name': name, form: value, **({'differs': unplayable} if unplayable else {})}


document = {
    '$schema': 'schemas/durations.schema.json',
    '$comment': [
        "Bead's durations: what every place that takes a duration an application gives a side makes of every input (spec 1.4, decision 0014), which every implementation's harness plays at every place, by every way its surface takes that duration.",
        'inputs is one table, each input named, in one of five forms: milliseconds, a JSON number, given as it is on the TypeScript side, through TimeSpan.FromMilliseconds on the C# side and through Duration::from_secs_f64 of ms / 1000.0 on the Rust side; seconds, a JSON number as a user writes seconds, seconds * 1000, TimeSpan.FromSeconds and Duration::from_secs_f64, each platform\'s arithmetic; never, Infinity, Timeout.InfiniteTimeSpan and Duration::MAX, which JSON has no number for; nan, IEEE 754\'s NaN, which JSON has none for either; json, a value that is no number, a string or a boolean, as a limit read from JSON may be. A Duration holds no value under zero, no NaN and nothing that is no number, so the Rust side is given none of them.',
        'A place is keyed by its id, its owner and its duration, which nothing but a decision changes. name says what it is, for a reader. kind is delay, a wait before an act, which takes 0 as at once, or timeout, any other, which is never 0. never is taken, held without end, arming nothing; refused; or default, held as the place\'s default; neverClause is the clause that says so, where 1.4 does not alone.',
        'clauses are the units of spec.md a place checks, each for what the place observes of it, and nothing else: 1.4, which holds and refuses its durations; its neverClause; and its default\'s clause. A unit is a clause, 9.2; an item of its numbered list, 9.2.5; or a row of its table, counted from 1, 15.12.8. A gateway\'s place cites the units of transcoding.md behind transcoding:, transcoding:9.2.',
        'ways are each way the surface takes that duration, by an id stable in its place: each harness keeps a table from each place and way to a function that builds the place on its side\'s test clock, given one input or none, and fails when that table and this file differ by one. required marks a way whose duration cannot be left out.',
        'default is where a clause states one: its milliseconds, or never, with that clause, one of the place\'s own; ways, those a harness builds with nothing given to read it; state, where it holds only so. A default no clause states is left out.',
        'observed is held, where what the place holds is read: an option read back, the due of the timer it arms on the side\'s test clock, or the wait a listen asks; at once, no timer armed and the act done; never, no timer armed. Or refusal, for a place on the real clock (decision 0011), whose harness reads whether it refuses alone.',
        'outcomes holds one outcome an input, in the inputs\' order: held, with the whole milliseconds held, a fraction rounded to the nearest, a half away from zero; at once; never; default, with the milliseconds of the default it is held as; taken, at a place observed by its refusal, for an input not refused; or refused, with its reason.',
        'reason is derived from the input, the place\'s kind and its never — under the floor, past the ceiling, 0 refused, never refused, or not a number — and held by the regeneration alone: the words of a refusal are each side\'s, which its harness builds, and a side that reports a refusal by a code checks the reason against that code.',
        'differs, on an input, a way or an outcome, names a row of docs/support.md, which names this file and what crosses it, and the language that row excuses from it: an input that language cannot be given, a way it lacks, or an outcome it reaches otherwise. A harness plays every input at every place and way but those a differs excuses its language from.',
    ],
    'specVersion': spec_version(),
    'inputs': [entry_of(*entry) for entry in inputs],
    'places': [{key: place[key] for key in ('id', 'name', 'clauses', 'kind', 'never', 'neverClause', 'ways', 'default',
                                            'observed', 'outcomes') if key in place} for place in places],
}

with open(ROOT + 'durations.json', 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=False, indent=2)
    file.write('\n')

print(len(places), 'places,', sum(len(place['ways']) for place in places), 'ways,', len(inputs), 'inputs,',
      sum(len(place['outcomes']) for place in places), 'outcomes')
