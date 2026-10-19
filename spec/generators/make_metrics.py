"""Writes spec/metrics.json: what a registry writes, byte for byte, for what it is given to count, and
what each exit of a call or a notification the interop service's server reaches counts, step by step
(spec/debugging.md, sections 7 to 12; decision 0013). The registry is written here a third time,
beside the two sides, by the companion's rules."""
import json
import os

import make_conversations as talk
from debugging_version import debugging_version
from make_identities import folded

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')

# ── The companion's tables ──────────────────────────────────────────────────────────────────────

# section 8 of spec.md: its codes, by number
CODES = {
    1: 'ENVELOPE_MALFORMED', 2: 'LAYOUT_UNSUPPORTED', 3: 'KIND_UNSUPPORTED', 4: 'ENVELOPE_TOO_LARGE',
    16: 'DESTINATION_UNKNOWN', 17: 'DESTINATION_UNREACHABLE', 18: 'SERVICE_UNKNOWN', 19: 'PROCEDURE_UNKNOWN',
    20: 'CALL_UNKNOWN', 21: 'SUBSCRIPTION_UNKNOWN', 22: 'SUBSCRIPTION_UNSUPPORTED',
    32: 'SESSION_REQUIRED', 33: 'ACCESS_DENIED', 34: 'PAYLOAD_TOO_LARGE', 35: 'CAPACITY_EXCEEDED',
    36: 'CREDENTIAL_UNSUPPORTED', 48: 'CHUNK_INVALID', 49: 'CREDIT_EXCEEDED', 50: 'PAYLOAD_UNDECODABLE',
    51: 'TRANSFER_STALLED', 64: 'PROCEDURE_FAILED', 65: 'DESTINATION_LOST',
}
APPLICATION, OTHER = 'application', '_OTHER'

# a code's place among a family's series: none first, then by number, application and _OTHER last
CODE_ORDER = {None: -1, **{name: number for number, name in CODES.items()}, APPLICATION: 1 << 16, OTHER: (1 << 16) + 1}

# 7.6: the codes a family's exits can end with
EVERY_CODE = [*CODES.values(), APPLICATION, OTHER]
SERVER_CODES = ['SESSION_REQUIRED', 'ACCESS_DENIED', 'PAYLOAD_TOO_LARGE', 'CAPACITY_EXCEEDED', 'CREDENTIAL_UNSUPPORTED',
                'SUBSCRIPTION_UNSUPPORTED', 'CHUNK_INVALID', 'CREDIT_EXCEEDED', 'PAYLOAD_UNDECODABLE', 'TRANSFER_STALLED',
                'PROCEDURE_FAILED', APPLICATION]
assert len(EVERY_CODE) == 24 and len(SERVER_CODES) == 12

# 11.3: A66's bounds, in microseconds, each with its le, OpenMetrics' canonical number for it
BOUNDS = [
    (0, '0.0'), (10, '1e-05'), (50, '5e-05'), (100, '0.0001'), (300, '0.0003'), (600, '0.0006'), (800, '0.0008'),
    (1_000, '0.001'), (2_000, '0.002'), (3_000, '0.003'), (4_000, '0.004'), (5_000, '0.005'), (6_000, '0.006'),
    (8_000, '0.008'), (10_000, '0.01'), (13_000, '0.013'), (16_000, '0.016'), (20_000, '0.02'), (25_000, '0.025'),
    (30_000, '0.03'), (40_000, '0.04'), (50_000, '0.05'), (65_000, '0.065'), (80_000, '0.08'), (100_000, '0.1'),
    (130_000, '0.13'), (160_000, '0.16'), (200_000, '0.2'), (250_000, '0.25'), (300_000, '0.3'), (400_000, '0.4'),
    (500_000, '0.5'), (650_000, '0.65'), (800_000, '0.8'), (1_000_000, '1.0'), (2_000_000, '2.0'),
    (5_000_000, '5.0'), (10_000_000, '10.0'), (20_000_000, '20.0'), (50_000_000, '50.0'), (100_000_000, '100.0'),
]
INFINITY = '+Inf'
assert len(BOUNDS) == 41

# 8.4 and 12.3: each role's outcomes, in their order
OUTCOMES = {
    'server': ['result', 'failure', 'cancelled', 'closed', 'error'],
    'client': ['result', 'failure', 'timeout', 'cancelled', 'closed', 'error'],
}
OUTCOME_ORDER = {name: index for index, name in enumerate(['result', 'failure', 'timeout', 'cancelled', 'closed',
                                                           'error', 'sent', 'failed'])}

# 8.1: the families, by name, each with its type and its help
FAMILIES = {
    'bead_client_call_duration_seconds': ('histogram', 'How long each call this side made took, from its start to its end, in seconds.'),
    'bead_client_call_handled_total': ('counter', 'Each call this side made, as it ended, by its outcome.'),
    'bead_client_call_started_total': ('counter', 'Each call this side made, as its router took it.'),
    'bead_notifications_heard_total': ('counter', 'Each notification heard under a subscription this side holds.'),
    'bead_notifications_sent_total': ('counter', 'Each notification for one subscription, handed to its transport or not.'),
    'bead_server_call_duration_seconds': ('histogram', 'How long each call this side answered took, from its arrival to its end, in seconds.'),
    'bead_server_call_handled_total': ('counter', 'Each call this side answered, as it ended, by its outcome.'),
    'bead_server_call_started_total': ('counter', 'Each call this side answered, as its request opened it.'),
    'bead_subscriptions_dropped_total': ('counter', 'Each subscription ended other than by its client\'s cancel, at this end.'),
}

MEDIA_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

# 8.2: the type of a call, by its role and its router's side
TYPES = {('server', 'server'): 'request', ('client', 'client'): 'request',
         ('server', 'client'): 'command', ('client', 'server'): 'command'}

# ── The registry ────────────────────────────────────────────────────────────────────────────────


class Refused(Exception):
    pass


def escaped(value):
    """A label's value as 0.0.4 writes it (12.4): a backslash, a quote and a line feed escaped, a lone
    surrogate written U+FFFD."""
    value = ''.join('\ufffd' if 0xD800 <= ord(character) <= 0xDFFF else character for character in value)
    return value.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n')


def seconds(microseconds):
    """A _sum as 12.5 writes it: whole seconds, and the microseconds under one, their trailing zeros
    dropped, never an exponent."""
    whole, under = divmod(microseconds, 1_000_000)
    return f'{whole}.{under:06d}'.rstrip('0') if under else f'{whole}'


class Registry:
    """A registry as spec/debugging.md states it: its declarations, its series made at 0, its counts,
    and its exposition."""

    def __init__(self, maximum=1000):
        self.maximum = maximum
        self.names = {}
        # the addresses each group of families names, for its ceiling (7.4)
        self.declared = {'client': set(), 'server': set(), 'notification': set()}
        # (role, address, type) -> {'started', 'handled': {(outcome, code): n}, 'buckets', 'sum', 'count'}
        self.calls = {}
        self.sent, self.heard, self.dropped = {}, {}, {}

    def call_series(self, role, address, kind, codes):
        series = self.calls.setdefault((role, address, kind), {
            'started': 0, 'handled': {}, 'buckets': [0] * (len(BOUNDS) + 1), 'sum': 0, 'count': 0})

        for outcome in OUTCOMES[role]:
            for code in codes if outcome == 'failure' else [None]:
                series['handled'].setdefault((outcome, code), 0)

    def give(self, router):
        """The registry given to a router of that side: its _OTHER series, in its call families (7.5)."""
        for role in ('client', 'server'):
            self.call_series(role, None, TYPES[(role, router)], EVERY_CODE)

    def declare(self, router, way, address, name, notifies=False):
        """A procedure declared on a router of that side (7.2), or Refused with its reason (7.3): its name
        at its address compared exactly, at another address of its service as spec 16.6 makes two names
        one. Its service's revision keys no series, so one declared at another revision takes the same."""
        if address in self.names and self.names[address] != name:
            raise Refused('another name at its address')

        if any(folded(held) == folded(name) and other[0] == address[0] and other != address
               for other, held in self.names.items()):
            raise Refused('its name at another address')

        groups = {'resolver': ['server'] + (['notification'] if notifies else []),
                  'requester': ['client'], 'notification': ['notification']}[way]

        if any(address not in self.declared[group] and len(self.declared[group]) >= self.maximum for group in groups):
            raise Refused('past the ceiling')

        self.names[address] = name

        for group in groups:
            self.declared[group].add(address)

        if way == 'resolver':
            self.call_series('server', address, TYPES[('server', router)], SERVER_CODES)
        if way == 'requester':
            self.call_series('client', address, TYPES[('client', router)], EVERY_CODE)
        if way == 'resolver' and notifies:
            self.sent.setdefault(address, {'sent': 0, 'failed': 0})
            self.dropped_series(address, EVERY_CODE)
        if way == 'notification':
            self.heard.setdefault(address, 0)
            self.dropped_series(address, EVERY_CODE)

    def dropped_series(self, address, codes):
        dropped = self.dropped.setdefault(address, {})

        for code in [None, *codes]:
            dropped.setdefault(code, 0)

    def started(self, router, role, address):
        self.calls[(role, address, TYPES[(role, router)])]['started'] += 1

    def ended(self, router, role, address, outcome, code, microseconds):
        series = self.calls[(role, address, TYPES[(role, router)])]
        # a count never makes a series (7.5)
        assert (outcome, code) in series['handled'], (role, address, outcome, code)
        series['handled'][(outcome, code)] += 1
        series['count'] += 1
        series['sum'] += microseconds

        for index, (bound, _) in enumerate(BOUNDS):
            if microseconds <= bound:
                series['buckets'][index] += 1

        series['buckets'][-1] += 1

    def notified(self, address, outcome):
        self.sent[address][outcome] += 1

    def notification_heard(self, address):
        self.heard[address] += 1

    def subscription_dropped(self, address, code):
        assert code in self.dropped[address], (address, code)
        self.dropped[address][code] += 1

    # the exposition

    def labels(self, address, **more):
        service, procedure = (OTHER, OTHER) if address is None else (str(address[0]), self.names[address])
        pairs = [('service', service), ('procedure', procedure), *((key, value) for key, value in more.items()
                                                                    if value is not None)]
        return '{' + ','.join(f'{key}="{escaped(value)}"' for key, value in pairs) + '}'

    @staticmethod
    def address_order(address):
        return (1, 0, 0) if address is None else (0, *address)

    def families(self):
        """Each family's series, in their order (12.3), as (name, value) pairs."""
        calls = sorted(self.calls.items(), key=lambda item: (item[0][0], self.address_order(item[0][1]),
                                                             item[0][2] != 'request'))
        families = {name: [] for name in FAMILIES}

        for (role, address, kind), series in calls:
            histogram = families[f'bead_{role}_call_duration_seconds']

            for (_, le), value in zip([*BOUNDS, (None, INFINITY)], series['buckets']):
                histogram.append((f'bead_{role}_call_duration_seconds_bucket' + self.labels(address, type=kind, le=le), value))

            histogram.append((f'bead_{role}_call_duration_seconds_sum' + self.labels(address, type=kind), series['sum']))
            histogram.append((f'bead_{role}_call_duration_seconds_count' + self.labels(address, type=kind), series['count']))

            for (outcome, code), value in sorted(series['handled'].items(),
                                                 key=lambda item: (OUTCOME_ORDER[item[0][0]], CODE_ORDER[item[0][1]])):
                families[f'bead_{role}_call_handled_total'].append(
                    (f'bead_{role}_call_handled_total' + self.labels(address, type=kind, outcome=outcome, code=code), value))

            families[f'bead_{role}_call_started_total'].append(
                (f'bead_{role}_call_started_total' + self.labels(address, type=kind), series['started']))

        for address in sorted(self.heard, key=self.address_order):
            families['bead_notifications_heard_total'].append(
                ('bead_notifications_heard_total' + self.labels(address), self.heard[address]))

        for address in sorted(self.sent, key=self.address_order):
            for outcome in ('sent', 'failed'):
                families['bead_notifications_sent_total'].append(
                    ('bead_notifications_sent_total' + self.labels(address, outcome=outcome), self.sent[address][outcome]))

        for address in sorted(self.dropped, key=self.address_order):
            for code in sorted(self.dropped[address], key=CODE_ORDER.get):
                families['bead_subscriptions_dropped_total'].append(
                    ('bead_subscriptions_dropped_total' + self.labels(address, code=code), self.dropped[address][code]))

        return families

    def samples(self):
        """Each series' line, keyed by the series, in the exposition's order."""
        return {series: f'{series} {seconds(value) if "_sum{" in series else value}'
                for name in sorted(FAMILIES) for series, value in self.families()[name]}

    def exposition(self):
        """The text's lines, each to be ended by a line feed (12.2 to 12.6)."""
        lines = []

        for name, series in sorted(self.families().items()):
            if series:
                kind, text = FAMILIES[name]
                lines += [f'# HELP {name} {text.replace(chr(92), chr(92) * 2).replace(chr(10), chr(92) + "n")}',
                          f'# TYPE {name} {kind}']
                lines += [f'{key} {seconds(value) if "_sum{" in key else value}' for key, value in series]

        return lines


def series_count(registry):
    return sum(len(series) for series in registry.families().values())


# the record's counts (7.7): 61, 74, 27, 26, and _OTHER's 73 and 74
for way, router, notifies, expected in (('resolver', 'server', False, 61), ('requester', 'client', False, 74),
                                        ('resolver', 'server', True, 61 + 27), ('notification', 'client', False, 26)):
    counted = Registry()
    counted.declare(router, way, (1, 1), 'p', notifies)
    assert series_count(counted) == expected, (way, series_count(counted))

counted = Registry()
counted.give('server')
assert len(counted.families()['bead_server_call_duration_seconds']) + len(counted.families()['bead_server_call_handled_total']) \
    + len(counted.families()['bead_server_call_started_total']) == 73
assert series_count(counted) == 73 + 74

# ── The expositions ─────────────────────────────────────────────────────────────────────────────

# the units of spec/debugging.md each entry checks
REGISTRY, DECLARED, DECLARED_REFUSED, CEILING, MADE_AHEAD, CODES_OF, SERIES_COUNTS = (
    '7.1', '7.2', '7.3', '7.4', '7.5', '7.6', '7.7')
ANOTHER_NAME, ANOTHER_ADDRESS, PAST_CEILING = '7.3.1', '7.3.2', '7.3.3'
NOTIFIER_DROPS = '10.3.5'
FAMILY_TABLE, ROLES, LABELED, OUTCOME, UNDER_WAY = '8.1', '8.2', '8.3', '8.4', '8.5'
DURATION, OBSERVED, BUCKETS = '11.1', '11.2', '11.3'
# the rows of a table an exposition writes whole: 7.2's items, a declaration's families by its role; 7.6's,
# the codes of a procedure's families; 8.1's, the nine families, their help and their type; 11.3's, the
# buckets' bounds, each its le
AS_RESOLVER, AS_REQUESTER, AS_HEARER = '7.2.1', '7.2.2', '7.2.3'
CODES_SERVER, CODES_CLIENT, CODES_NOTIFIER, CODES_HEARER = '7.6.1', '7.6.2', '7.6.3', '7.6.4'
FAMILY_ROWS = [f'{FAMILY_TABLE}.{row}' for row in range(1, 10)]
BUCKET_ROWS = [f'{BUCKETS}.{row}' for row in range(1, 15)]
EXPOSED, GROUPED, ORDERED, LABELS, NUMBERS, LINES = '12.1', '12.2', '12.3', '12.4', '12.5', '12.6'


def revised(revision):
    """A declaration's revision, written where it is not 1, which a declaration that gives none is at."""
    return {} if revision == 1 else {'serviceRevision': revision}


def resolver(router, service, procedure, name, notifies=False, refused=None, revision=1):
    return {'router': router, 'as': 'resolver', 'serviceId': service, 'procedureId': procedure, 'procedureName': name,
            **revised(revision), **({'notifies': True} if notifies else {}), **({'refused': refused} if refused else {})}


def requester(router, service, procedure, name, refused=None, revision=1):
    return {'router': router, 'as': 'requester', 'serviceId': service, 'procedureId': procedure, 'procedureName': name,
            **revised(revision), **({'refused': refused} if refused else {})}


def notification(router, service, procedure, name, refused=None, revision=1):
    return {'router': router, 'as': 'notification', 'serviceId': service, 'procedureId': procedure,
            'procedureName': name, **revised(revision), **({'refused': refused} if refused else {})}


def address_of(service=None, procedure=None):
    return {} if service is None else {'serviceId': service, 'procedureId': procedure}


def answered(router, outcome=None, code=None, microseconds=0, service=None, procedure=None):
    """A call a router answered, whole, or opened and under way when it has no outcome."""
    return {'router': router, 'call': 'answered', **address_of(service, procedure),
            **({'outcome': outcome, **({'code': code} if code else {}), 'microseconds': microseconds} if outcome else {})}


def made(router, outcome=None, code=None, microseconds=0, service=None, procedure=None):
    """A call a router made, whole, or started and under way when it has no outcome."""
    return {'router': router, 'call': 'made', **address_of(service, procedure),
            **({'outcome': outcome, **({'code': code} if code else {}), 'microseconds': microseconds} if outcome else {})}


def notified(router, outcome, service, procedure):
    return {'router': router, 'notification': outcome, 'serviceId': service, 'procedureId': procedure}


def dropped(router, end, service, procedure, code=None):
    return {'router': router, 'dropped': end, 'serviceId': service, 'procedureId': procedure,
            **({'code': code} if code else {})}


def play(routers, declarations, counts, maximum=None):
    registry = Registry(maximum or 1000)

    for router in routers:
        registry.give(router)

    for declaration in declarations:
        try:
            registry.declare(routers[declaration['router']], declaration['as'],
                             (declaration['serviceId'], declaration['procedureId']), declaration['procedureName'],
                             declaration.get('notifies', False))
        except Refused as refused:
            assert declaration.get('refused') == str(refused), (declaration, refused)
        else:
            assert 'refused' not in declaration, declaration

    for count in counts:
        router = routers[count['router']]
        address = (count['serviceId'], count['procedureId']) if 'serviceId' in count else None

        if 'call' in count:
            role = 'server' if count['call'] == 'answered' else 'client'
            registry.started(router, role, address)

            if 'outcome' in count:
                registry.ended(router, role, address, count['outcome'], count.get('code'), count['microseconds'])
        elif 'notification' in count and count['notification'] == 'heard':
            registry.notification_heard(address)
        elif 'notification' in count:
            registry.notified(address, count['notification'])
        else:
            registry.subscription_dropped(address, count.get('code'))

    return registry


SERVER, CLIENT = 0, 1

EXPOSITIONS = [
    ('a registry given to no router, and declared nothing, writes nothing', [REGISTRY, GROUPED], None, [], [], []),
    ('a registry given to a server\'s router makes its _OTHER series at 0: command among its client families, request among its server families',
     [MADE_AHEAD, CODES_OF, SERIES_COUNTS, ROLES, LABELED, BUCKETS, EXPOSED, GROUPED, ORDERED, LABELS, NUMBERS, LINES],
     None, ['server'], [], []),
    ('a registry given to a client\'s router makes its _OTHER series at 0: request among its client families, command among its server families',
     [MADE_AHEAD, ROLES, LABELED, ORDERED], None, ['client'], [], []),
    ('a resolver declared makes its 61 series at 0, and one whose procedure notifies 27 more, as the side that notifies',
     [DECLARED, AS_RESOLVER, MADE_AHEAD, CODES_OF, CODES_SERVER, CODES_NOTIFIER, SERIES_COUNTS, GROUPED, ORDERED], None,
     ['server'], [resolver(SERVER, 1, 1, 'echo'), resolver(SERVER, 1, 10, 'ticks', notifies=True)], []),
    ('a requester declared makes its 74 series at 0, and a notification registered 26, as the side that hears',
     [DECLARED, AS_REQUESTER, AS_HEARER, MADE_AHEAD, CODES_OF, CODES_CLIENT, CODES_HEARER, SERIES_COUNTS, ORDERED], None,
     ['client'], [requester(SERVER, 1, 1, 'echo'), notification(SERVER, 1, 10, 'ticks')], []),
    ('a resolver declared on a client\'s router counts its commands, and a requester on a server\'s router the commands it makes',
     [DECLARED, ROLES], None, ['client', 'server'],
     [resolver(0, 1, 9, 'clock'), requester(1, 1, 9, 'clock')],
     [answered(0, 'result', service=1, procedure=9), made(1, 'result', service=1, procedure=9)]),
    ('series come by service id, then procedure id, as numbers, _OTHER last, and a procedure named _OTHER keeps series of its own',
     [LABELED, ORDERED], None, ['server'],
     [resolver(SERVER, 10, 2, 'later'), resolver(SERVER, 2, 10, 'tenth'), resolver(SERVER, 2, 9, '_OTHER')],
     [answered(SERVER, 'result', service=2, procedure=9), answered(SERVER, 'result')]),
    ('a label\'s value escapes a backslash, a quote and a line feed, and a name outside ASCII is written as it is',
     [LABELS], None, ['client'],
     [notification(SERVER, 1, 1, 'a\\b'), notification(SERVER, 1, 2, 'say "hi"'), notification(SERVER, 1, 3, 'two\nlines'),
      notification(SERVER, 1, 4, 'caf\u00e9')],
     [notified(SERVER, 'heard', 1, 1), notified(SERVER, 'heard', 1, 3), dropped(SERVER, 'hears', 1, 4, 'application')]),
    ('a call answered counts by its outcome and its code, written in their order whatever the order counted, and one under way started alone',
     [OUTCOME, OBSERVED, UNDER_WAY, ORDERED, NUMBERS], None, ['server'], [resolver(SERVER, 1, 1, 'echo')],
     [answered(SERVER, 'error', service=1, procedure=1), answered(SERVER, 'failure', 'application', service=1, procedure=1),
      answered(SERVER, 'closed', service=1, procedure=1), answered(SERVER, 'failure', 'SESSION_REQUIRED', service=1, procedure=1),
      answered(SERVER, 'cancelled', service=1, procedure=1), answered(SERVER, 'result', service=1, procedure=1),
      answered(SERVER, 'failure', 'PROCEDURE_FAILED', service=1, procedure=1), answered(SERVER, 'result', service=1, procedure=1),
      answered(SERVER, 'failure', 'SERVICE_UNKNOWN'), answered(SERVER, 'failure', 'ENVELOPE_MALFORMED'),
      answered(SERVER, service=1, procedure=1), answered(SERVER)]),
    ('a call made counts by its outcome and its code: timeout a call made\'s alone, a code section 8 names none of _OTHER',
     [OUTCOME, CODES_OF, ORDERED], None, ['client'], [requester(SERVER, 1, 1, 'echo')],
     [made(SERVER, 'timeout', service=1, procedure=1), made(SERVER, 'failure', OTHER, service=1, procedure=1),
      made(SERVER, 'failure', 'DESTINATION_LOST', service=1, procedure=1), made(SERVER, 'failure', 'ENVELOPE_MALFORMED', service=1, procedure=1),
      made(SERVER, 'failure', APPLICATION, service=1, procedure=1), made(SERVER, 'result', service=1, procedure=1),
      made(SERVER, 'failure', OTHER)]),
    ('a duration falls in every bucket whose bound is it or more: 0 in every one, and each edge in its own',
     [DURATION, OBSERVED, BUCKETS, *BUCKET_ROWS], None, ['server'], [resolver(SERVER, 1, 1, 'echo')],
     [answered(SERVER, 'result', microseconds=microseconds, service=1, procedure=1)
      for microseconds in (0, 1, 10, 11, 999_999, 1_000_000, 1_000_001, 100_000_000, 100_000_001)]),
    ('a _sum is whole seconds and the microseconds under one, their trailing zeros dropped, never an exponent, held exactly past 2^53',
     [NUMBERS], None, ['server'],
     [resolver(SERVER, 1, 1, 'tens'), resolver(SERVER, 1, 2, 'halves'), requester(SERVER, 1, 3, 'threes'),
      resolver(SERVER, 1, 4, 'ages')],
     [answered(SERVER, 'result', microseconds=10, service=1, procedure=1),
      answered(SERVER, 'result', microseconds=1_250_000, service=1, procedure=2),
      answered(SERVER, 'result', microseconds=1_250_000, service=1, procedure=2),
      made(SERVER, 'result', microseconds=3_000_000, service=1, procedure=3),
      *[answered(SERVER, 'result', microseconds=(1 << 52) + 1, service=1, procedure=4)] * 3]),
    ('notifications count by role: sent and failed at the side that notifies, heard at the side that hears, dropped at each end by its code',
     [DECLARED, MADE_AHEAD, CODES_OF, FAMILY_TABLE, *FAMILY_ROWS, ORDERED], None, ['client', 'server'],
     [resolver(1, 1, 10, 'ticks', notifies=True), notification(0, 1, 10, 'ticks')],
     [notified(1, 'sent', 1, 10), notified(1, 'sent', 1, 10), notified(1, 'failed', 1, 10), notified(0, 'heard', 1, 10),
      dropped(1, 'notifies', 1, 10, 'CAPACITY_EXCEEDED'), dropped(0, 'hears', 1, 10, 'CAPACITY_EXCEEDED'),
      dropped(0, 'hears', 1, 10)]),
    ('a subscription the side that notifies drops counts under the code of the failure that ends it: a protocol code by its name, a procedure\'s own application, a code section 8 names none of _OTHER',
     [MADE_AHEAD, CODES_OF, OUTCOME, NOTIFIER_DROPS], None, ['server'],
     [resolver(SERVER, 1, 10, 'ticks', notifies=True)],
     [dropped(SERVER, 'notifies', 1, 10, 'ACCESS_DENIED'), dropped(SERVER, 'notifies', 1, 10, APPLICATION),
      dropped(SERVER, 'notifies', 1, 10, OTHER), dropped(SERVER, 'notifies', 1, 10)]),
    ('one registry given to two routers sums them, a declaration of an address it holds under its name taking the same series',
     [REGISTRY, DECLARED_REFUSED], None, ['server', 'server'],
     [resolver(0, 1, 1, 'echo'), resolver(1, 1, 1, 'echo')],
     [answered(0, 'result', service=1, procedure=1), answered(1, 'result', microseconds=20, service=1, procedure=1),
      answered(0, 'failure', 'SERVICE_UNKNOWN'), answered(1, 'failure', 'SERVICE_UNKNOWN')]),
    ('a declaration of an address the registry holds under another name is refused, and declares nothing',
     [DECLARED_REFUSED, ANOTHER_NAME], None, ['server'],
     [resolver(SERVER, 1, 1, 'echo'), requester(SERVER, 1, 1, 'other', refused='another name at its address')], []),
    ('a declaration of an address the registry holds under another spelling of its name is refused: an address keeps its name as written',
     [DECLARED_REFUSED, ANOTHER_NAME], None, ['server'],
     [resolver(SERVER, 1, 1, 'getHTTPStatus'), requester(SERVER, 1, 1, 'getHttpStatus', refused='another name at its address')], []),
    ('a declaration of a name its service holds at another address is refused; another service may hold it',
     [DECLARED_REFUSED, ANOTHER_ADDRESS], None, ['server'],
     [resolver(SERVER, 1, 1, 'echo'), resolver(SERVER, 1, 2, 'echo', refused='its name at another address'),
      resolver(SERVER, 2, 1, 'echo')], []),
    ('a declaration of a name its service holds at another address in another case is refused: an ASCII letter is one in either case',
     [DECLARED_REFUSED, ANOTHER_ADDRESS], None, ['server'],
     [resolver(SERVER, 1, 1, 'getHTTPStatus'), requester(SERVER, 1, 2, 'getHttpStatus', refused='its name at another address'),
      resolver(SERVER, 1, 3, 'gethttpstatus', refused='its name at another address'), resolver(SERVER, 2, 1, 'getHttpStatus')],
     []),
    ('names apart outside ASCII are two names, each at an address of its own',
     [DECLARED_REFUSED, ANOTHER_ADDRESS], None, ['client'],
     [notification(SERVER, 1, 1, 'caf' + chr(0xE9)), notification(SERVER, 1, 2, 'caf' + chr(0xC9))], []),
    ('a service declared at a second revision counts into its series: an address the registry holds takes the same series, whatever its router, and another address series of its own',
     [REGISTRY, DECLARED_REFUSED], None, ['client', 'server', 'server'],
     [resolver(1, 1, 1, 'echo'), resolver(2, 1, 1, 'echo', revision=2), resolver(2, 1, 2, 'fail', revision=2),
      requester(0, 1, 2, 'fail', revision=3)],
     [answered(1, 'result', service=1, procedure=1), answered(2, 'result', microseconds=20, service=1, procedure=1),
      answered(2, 'failure', APPLICATION, service=1, procedure=2), made(0, 'result', service=1, procedure=2)]),
    ('a declaration past its families\' ceiling is refused; one of a procedure they name already, or of other families, is not',
     [DECLARED_REFUSED, PAST_CEILING, CEILING], 2, ['server'],
     [resolver(SERVER, 1, 1, 'echo'), resolver(SERVER, 1, 2, 'fail'), resolver(SERVER, 1, 3, 'slow', refused='past the ceiling'),
      resolver(SERVER, 1, 1, 'echo'), requester(SERVER, 1, 3, 'slow')],
     [answered(SERVER, 'failure', 'PROCEDURE_UNKNOWN')]),
    ('a declaration that several reasons refuse is refused for the first that applies, in the order of their table',
     [DECLARED_REFUSED, ANOTHER_NAME, ANOTHER_ADDRESS, PAST_CEILING], 2, ['server'],
     [resolver(SERVER, 1, 1, 'echo'), resolver(SERVER, 1, 2, 'fail'),
      resolver(SERVER, 1, 1, 'other', refused='another name at its address', revision=2),
      resolver(SERVER, 1, 3, 'ECHO', refused='its name at another address', revision=2),
      resolver(SERVER, 1, 3, 'slow', refused='past the ceiling', revision=2)], []),
    ('a resolver whose procedure notifies counts against the notification families\' ceiling too',
     [PAST_CEILING, CEILING], 1, ['client', 'server'],
     [notification(0, 1, 10, 'ticks'), resolver(1, 1, 11, 'tick', notifies=True, refused='past the ceiling'),
      resolver(1, 1, 12, 'login')], []),
]


def exposition_entry(name, clauses, maximum, routers, declarations, counts):
    registry = play(routers, declarations, counts, maximum)
    return {'name': name, 'clauses': clauses, **({'maximumProcedures': maximum} if maximum else {}),
            'routers': routers, 'declarations': declarations, 'counts': counts, 'exposition': registry.exposition()}


# ── The exits ───────────────────────────────────────────────────────────────────────────────────

SERVICE = talk.SERVICE_ID
PROCEDURES = talk.PROCEDURES
CONVERSATIONS = {conversation['name']: conversation for conversation in talk.document['conversations']}


def interop_registry():
    """A registry given to the interop service's server, as its router is built (7.1): each procedure
    the server offers declared as a resolver, ticks as one that notifies, and clock, the command it
    calls, as a requester."""
    registry = Registry()
    registry.give('server')

    for procedure in talk.API['procedures']:
        address = (SERVICE, procedure['procedureId'])

        if procedure['procedureKind'] == 'command':
            registry.declare('server', 'requester', address, procedure['procedureName'])
        else:
            registry.declare('server', 'resolver', address, procedure['procedureName'],
                             procedure['procedureKind'] == 'notifies')

    return registry


def at(name):
    return None if name is None else (SERVICE, PROCEDURES[name])


def opened(name=None):
    """A call the server answers opened, as its request opens it (9.1, its first gate)."""
    return lambda registry: registry.started('server', 'server', at(name))


def ended(name, outcome, code=None, microseconds=0):
    """A call the server answers ended, at its second gate, that long after its request's arrival."""
    return lambda registry: registry.ended('server', 'server', at(name), outcome, code, microseconds)


def answered_whole(name, outcome, code=None, microseconds=0):
    return [opened(name), ended(name, outcome, code, microseconds)]


def commanded(name=None):
    """A call the server makes, as its router's request takes it (9.1, its third gate)."""
    return lambda registry: registry.started('server', 'client', at(name))


def settled(name, outcome, code=None, microseconds=0):
    """A call the server makes settled, at its fourth gate."""
    return lambda registry: registry.ended('server', 'client', at(name), outcome, code, microseconds)


def sent(name):
    return lambda registry: registry.notified(at(name), 'sent')


def subscription_dropped(name, code=None):
    return lambda registry: registry.subscription_dropped(at(name), code)


def flat(events):
    """The events a counted step follows, given as one or as a list of them."""
    return events if isinstance(events, list) else [events]


SECOND = 1_000_000

# the units of spec/debugging.md the exits check: the gates, then the rows of the tables of exits
SERVER_STARTS, SERVER_ENDS, CLIENT_STARTS, CLIENT_ENDS, GOES, HEARD, DROPPED = (
    '9.1.1', '9.1.2', '9.1.3', '9.1.4', '9.1.5', '9.1.6', '9.1.7')
ROUTE, CREDENTIAL, ADMISSION, SUBSCRIPTION, TOO_LARGE, OPENING_REFUSED, OPENING_PAST, REQUEST_TRANSFER, \
    UNREADABLE, UNDECODABLE, RESOLVER_FAILS, OWN_FAILURE, QUEUE_PAST, RESULT_STALLED, RELAYED, CANCELLED, CLOSED = (
        '9.4.2', '9.4.3', '9.4.4', '9.4.5', '9.4.6', '9.4.7', '9.4.8', '9.4.9', '9.4.10', '9.4.11', '9.4.12', '9.4.13',
        '9.4.14', '9.4.15', '9.4.16', '9.4.17', '9.4.18')
ANSWERED_RESULT = '9.4.1'
MADE_RESULT, MADE_FAILURE, MADE_ENDED, MADE_TIMEOUT, MADE_CANCELLED, MADE_CLOSED = (
    '9.6.5', '9.6.6', '9.6.7', '9.6.8', '9.6.9', '9.6.10')
LAST_CHUNK, WIRE = '9.5', '9.8'
NOTIFICATION_SENT, QUEUE_DROPPED, SESSION_DROPPED, CLOSE_DROPPED, CANCEL_DROPS_NOTHING = (
    '10.1', '10.3.1', '10.3.2', '10.3.4', '10.4')


def steps_of(name, last=None):
    return CONVERSATIONS[name]['steps'][:last]


def exit_entry(name, clauses, conversation, counted, extra=(), last=None):
    """An exit: the steps of a conversation, its first `last` alone when given, then `extra`, with a
    counted step after each step number `counted` names, listing the lines of the series that moved
    since the last, by the companion's registry."""
    source = CONVERSATIONS[conversation]
    steps = [*steps_of(conversation, last), *extra]
    registry = interop_registry()
    before = registry.samples()
    played = []

    assert set(counted) <= set(range(1, len(steps) + 1)), name

    for number, step in enumerate(steps, 1):
        played.append(step)

        if number in counted:
            # a counted step follows a step the server takes, never a send alone (check.py holds it)
            assert {'expect', 'report', 'advance', 'close'} & set(step), (name, number)

            for event in flat(counted[number]):
                event(registry)

            after = registry.samples()
            # every series is made before it counts: a count moves the series it finds, and makes none
            assert after.keys() == before.keys(), name
            played.append({'counted': [line for series, line in after.items() if before[series] != line]})
            before = after

    return {'name': name, 'clauses': clauses,
            **{key: source[key] for key in ('limits', 'pacing', 'relay') if key in source},
            'steps': played}


def close():
    return {'close': True}


def echo_again(call_id, value):
    return [talk.json_request(call_id, 'echo', value), talk.result(call_id, value)]


ECHO_ANSWERS = 'echo answers with its request\'s payload'

EXITS = [
    # a result, and each refusal of a call the server answers
    ('a result handed to its transport ends its call, its duration in every bucket', [SERVER_STARTS, SERVER_ENDS, ANSWERED_RESULT, BUCKETS],
     ECHO_ANSWERS, {2: answered_whole('echo', 'result')}),
    ('a procedure\'s own failure counts application', [OWN_FAILURE, OUTCOME],
     'fail answers with its own failure, of the application', {2: answered_whole('fail', 'failure', APPLICATION)}),
    ('a service unknown counts under _OTHER', [LABELED, ROUTE],
     'a service unknown is answered SERVICE_UNKNOWN', {2: answered_whole(None, 'failure', 'SERVICE_UNKNOWN')}),
    ('a procedure unknown counts under _OTHER', [LABELED, ROUTE],
     'a procedure unknown, in a service known, is answered PROCEDURE_UNKNOWN', {2: answered_whole(None, 'failure', 'PROCEDURE_UNKNOWN')}),
    ('a request that names a destination, to a server that relays nothing, counts under _OTHER', [LABELED, ROUTE],
     'a request with a destination, to a server that relays nothing, is answered DESTINATION_UNKNOWN',
     {2: answered_whole(None, 'failure', 'DESTINATION_UNKNOWN')}),
    ('a credential scheme to come counts its procedure\'s CREDENTIAL_UNSUPPORTED, and a procedure unknown _OTHER\'s', [CREDENTIAL, ROUTE],
     'a credential scheme to come is answered CREDENTIAL_UNSUPPORTED, its detail naming the schemes the server takes, before its admission',
     {2: answered_whole('echo', 'failure', 'CREDENTIAL_UNSUPPORTED'), 4: answered_whole('whoami', 'failure', 'CREDENTIAL_UNSUPPORTED'),
      6: answered_whole(None, 'failure', 'PROCEDURE_UNKNOWN')}),
    ('a credential that does not resolve counts SESSION_REQUIRED', [CREDENTIAL],
     'a JWT that does not verify is refused SESSION_REQUIRED, whatever its procedure requires, its detail saying one came and did not hold',
     {2: answered_whole('echo', 'failure', 'SESSION_REQUIRED')}),
    ('a verifier that fails counts PROCEDURE_FAILED', [CREDENTIAL],
     'an ELSEWHERE whose verifier fails is answered PROCEDURE_FAILED, and reported, never SESSION_REQUIRED',
     {3: answered_whole('whoami', 'failure', 'PROCEDURE_FAILED')}),
    ('calls past those let wait for an issuer count CAPACITY_EXCEEDED, each timed from its arrival through its credential\'s wait',
     [SERVER_STARTS, CREDENTIAL, CANCELLED, BUCKETS],
     'a key set lets maximumWaitingCalls calls wait for an issuer\'s deadline at once, a call that waits on its ask never counted: however many wait on an ask, none is refused; one more for the deadline is refused CAPACITY_EXCEEDED at once, and one an answer moves onto a deadline that holds them as it moves, neither reported, while a call whose key serves and a call that comes once one left are not',
     {13: [*answered_whole('whoami', 'result', microseconds=SECOND)] * 3,
      18: [opened('echo'), opened('echo'), *answered_whole('echo', 'failure', 'CAPACITY_EXCEEDED')],
      20: answered_whole('whoami', 'result'),
      35: [ended('echo', 'cancelled'), opened('echo'), opened('echo'), opened('echo'), opened('echo'),
           ended('echo', 'failure', 'SESSION_REQUIRED', 60 * SECOND), ended('echo', 'failure', 'SESSION_REQUIRED', 60 * SECOND),
           ended('echo', 'failure', 'CAPACITY_EXCEEDED', SECOND), *answered_whole('echo', 'failure', 'CAPACITY_EXCEEDED')],
      41: [ended('echo', 'failure', 'SESSION_REQUIRED', 61 * SECOND), ended('echo', 'failure', 'SESSION_REQUIRED', 61 * SECOND)]}),
    ('an admission that refuses counts its refusal', [ADMISSION],
     'an admission that refuses is answered with its refusal', {2: answered_whole('denied', 'failure', 'ACCESS_DENIED')}),
    ('an admission that refuses a call in no session counts SESSION_REQUIRED', [ADMISSION],
     'a procedure that requires a session refuses a call in none with SESSION_REQUIRED', {2: answered_whole('whoami', 'failure', 'SESSION_REQUIRED')}),
    ('a transfer its side takes none of counts PAYLOAD_TOO_LARGE', [TOO_LARGE],
     'a request that opens a transfer, to a server that takes none, is answered PAYLOAD_TOO_LARGE',
     {2: answered_whole('echo', 'failure', 'PAYLOAD_TOO_LARGE')}),
    ('a transfer\'s opening that holds its whole total counts CHUNK_INVALID', [OPENING_REFUSED],
     'an opening that holds its whole total is answered CHUNK_INVALID', {2: answered_whole('echo', 'failure', 'CHUNK_INVALID')}),
    ('a transfer\'s opening past those its connection receives counts CAPACITY_EXCEEDED, and the transfer under way stays started',
     [OPENING_PAST, UNDER_WAY], 'a transfer past those a connection receives at once is answered CAPACITY_EXCEEDED',
     {4: [opened('echo'), *answered_whole('echo', 'failure', 'CAPACITY_EXCEEDED')]}),
    ('a chunk refused ends its request\'s transfer, CHUNK_INVALID', [REQUEST_TRANSFER],
     'a chunk before the last that is not full is answered CHUNK_INVALID', {4: answered_whole('echo', 'failure', 'CHUNK_INVALID')}),
    ('a chunk past its credit ends its request\'s transfer, CREDIT_EXCEEDED, and a late one counts nothing', [REQUEST_TRANSFER],
     'a chunk past its credit is answered CREDIT_EXCEEDED, and a late one under it is dropped in silence',
     {4: answered_whole('echo', 'failure', 'CREDIT_EXCEEDED'), 7: []}),
    ('a request\'s transfer gone silent counts TRANSFER_STALLED, timed from its arrival', [SERVER_STARTS, REQUEST_TRANSFER, BUCKETS],
     'a request whose transfer goes silent is answered TRANSFER_STALLED, each chunk placed setting it going again, its call then held abandoned as long',
     {2: opened('echo'), 9: answered_whole('echo', 'result'), 12: ended('echo', 'failure', 'TRANSFER_STALLED', 50 * SECOND), 17: []}),
    ('a request whose header does not read, of a layout to come, is answered and counts under _OTHER', [UNREADABLE, LABELED],
     'a request of a layout to come is answered LAYOUT_UNSUPPORTED, on its call id', {2: answered_whole(None, 'failure', 'LAYOUT_UNSUPPORTED')}),
    ('a malformed request is answered and counts under _OTHER', [UNREADABLE, LABELED],
     'a malformed request is answered ENVELOPE_MALFORMED, on its call id', {2: answered_whole(None, 'failure', 'ENVELOPE_MALFORMED')}),
    ('a request past the envelope\'s bound is answered and counts under _OTHER', [UNREADABLE, LABELED],
     'a request past the envelope\'s bound is answered ENVELOPE_TOO_LARGE, on its call id', {2: answered_whole(None, 'failure', 'ENVELOPE_TOO_LARGE')}),
    ('a request on the server\'s own parity opens no call, and counts nothing', [SERVER_STARTS],
     'a request on the server\'s own parity is reported, never answered', {2: []}),
    ('a request on a call id a subscription holds opens no call, and counts nothing', [SERVER_STARTS, NOTIFICATION_SENT],
     'a call id a subscription holds is in use: a request on it is reported, never answered',
     {2: answered_whole('ticks', 'result'), 4: [], 7: [*answered_whole('tick', 'result'), sent('ticks')]}),
    ('a payload its procedure cannot read counts PAYLOAD_UNDECODABLE', [UNDECODABLE],
     'a payload that is not JSON is answered PAYLOAD_UNDECODABLE', {2: answered_whole('echo', 'failure', 'PAYLOAD_UNDECODABLE')}),
    ('a resolver that fails before it answers counts PROCEDURE_FAILED', [RESOLVER_FAILS],
     'a resolver that throws before it answers is answered PROCEDURE_FAILED, and reported',
     {3: answered_whole('broken', 'failure', 'PROCEDURE_FAILED')}),
    ('a result its side cannot send counts PROCEDURE_FAILED', [RESOLVER_FAILS],
     'an answer too large for one envelope, from a server that sends no transfer, is answered PROCEDURE_FAILED, and reported PAYLOAD_TOO_LARGE',
     {3: answered_whole('bytes', 'failure', 'PROCEDURE_FAILED')}),
    ('a subscription refused in its own answer is its call\'s failure, and drops no subscription', [QUEUE_PAST, LAST_CHUNK, UNDER_WAY, NOTIFICATION_SENT],
     'a queue past its bounds while its call is unanswered is that call\'s answer',
     {4: [opened('ticks'), sent('ticks'), *answered_whole('tick', 'result')],
      11: [ended('ticks', 'failure', 'CAPACITY_EXCEEDED'), *answered_whole('tick', 'result'), *answered_whole('tick', 'result'),
           *answered_whole('tick', 'result')]}),
    # a transfer's answers
    ('a result sent as a transfer ends its call at its last chunk', [SERVER_ENDS, ANSWERED_RESULT, LAST_CHUNK],
     'a request that comes as a transfer is credited to its total, then answered by a transfer its client credits',
     {2: opened('echo'), 5: [], 8: ended('echo', 'result')}),
    ('a result\'s transfer stalled before its last chunk counts TRANSFER_STALLED, timed to its failure', [RESULT_STALLED, LAST_CHUNK, BUCKETS],
     'a result that gets no credit is ended TRANSFER_STALLED, a credit that grants setting it going again, one that grants nothing not',
     {2: opened('echo'), 6: [], 12: ended('echo', 'failure', 'TRANSFER_STALLED', 20 * SECOND)}),
    ('a result\'s transfer cancelled before its last chunk counts cancelled', [CANCELLED, LAST_CHUNK],
     'a cancel ends the transfer of a result, and a credit after it is dropped in silence',
     {2: opened('echo'), 6: [ended('echo', 'cancelled'), *answered_whole('echo', 'result')]}, echo_again(3, '"y"')),
    ('a result\'s transfer closed before its last chunk counts closed', [CLOSED, LAST_CHUNK],
     'a cancel ends the transfer of a result, and a credit after it is dropped in silence',
     {2: opened('echo'), 3: ended('echo', 'closed')}, [close()], 2),
    # a cancel and a close
    ('a call its requester cancels counts cancelled', [CANCELLED],
     'a cancel ends its call, and the answer its resolver gives after goes nowhere',
     {4: [*answered_whole('slow', 'cancelled'), *answered_whole('cancellations', 'result')]}),
    ('a call whose connection closes counts closed', [CLOSED],
     'a connection that closes ends its calls, and their answers go nowhere', {2: answered_whole('slow', 'closed')}),
    ('a call awaiting its command as their connection closes counts closed, and the command closed, each once', [CLOSED, MADE_CLOSED],
     'the server asks its client a command, and answers with what the client answered',
     {2: [opened('ask'), commanded('clock')], 3: [ended('ask', 'closed'), settled('clock', 'closed')]}, [close()], 2),
    # the commands the server makes
    ('a command answered counts among the client families, type command, beside the call that made it', [CLIENT_STARTS, CLIENT_ENDS, MADE_RESULT, ROLES],
     'the server asks its client a command, and answers with what the client answered',
     {2: [opened('ask'), commanded('clock')], 4: [settled('clock', 'result'), ended('ask', 'result')]}),
    ('a command its client fails counts the failure\'s code', [MADE_FAILURE],
     'a command the client fails fails the call that asked it, which is reported',
     {2: [opened('ask'), commanded('clock')], 5: [settled('clock', 'failure', APPLICATION), ended('ask', 'failure', 'PROCEDURE_FAILED')]}),
    ('a command whose answer does not read counts the failure that refused it', [MADE_ENDED],
     'an answer to a command that does not read ends the command and cancels it, and a late one is dropped in silence',
     {6: [opened('ask'), commanded('clock'), settled('clock', 'failure', 'ENVELOPE_MALFORMED'), ended('ask', 'failure', 'PROCEDURE_FAILED')]}),
    ('a command past its time counts timeout, timed to it', [MADE_TIMEOUT, BUCKETS],
     'a command past its time is cancelled and its call id reserved as long: an answer within is dropped in silence, one after is reported CALL_UNKNOWN',
     {2: [opened('ask'), commanded('clock')],
      7: [settled('clock', 'timeout', microseconds=10 * SECOND), ended('ask', 'failure', 'PROCEDURE_FAILED', 10 * SECOND)], 12: []}),
    ('a command whose result\'s transfer goes silent counts timeout', [MADE_TIMEOUT, BUCKETS],
     'a command whose result comes as a transfer waits on the transfer\'s inactivity, not its own time; gone silent it ends as timed out, its call id reserved as long',
     {4: [opened('ask'), commanded('clock')],
      12: [settled('clock', 'timeout', microseconds=30 * SECOND), ended('ask', 'failure', 'PROCEDURE_FAILED', 30 * SECOND)], 18: []}),
    # a relayed call, at both of the relay's gates
    ('a relayed call counts under _OTHER in the server families, and its leg B under _OTHER in the client families, type command',
     [LABELED, RELAYED, MADE_RESULT],
     'a destination registered on the wire takes a request relayed, and its result crosses back',
     {4: answered_whole('login', 'result'), 6: answered_whole('register', 'result'), 8: [opened(), commanded()],
      10: [settled(None, 'result'), ended(None, 'result')]}),
    ('a destination\'s failure counts as answered at both of the relay\'s gates', [RELAYED, MADE_FAILURE],
     'a failure of the destination\'s crosses one relay more',
     {4: answered_whole('login', 'result'), 6: answered_whole('register', 'result'),
      10: [opened(), commanded(), settled(None, 'failure', APPLICATION), ended(None, 'failure', APPLICATION)]}),
    ('a relay\'s own failure counts under _OTHER, and no leg B', [RELAYED],
     'a server\'s relay admits by default a credential it forwards alone: a call presenting none or OPAQUE is refused ACCESS_DENIED, its detail naming the default, in leg A\'s connection\'s session or in none, before its destination is looked up, and its own failure crosses no relay',
     {4: answered_whole('register', 'result'), 6: answered_whole(None, 'failure', 'ACCESS_DENIED'),
      8: answered_whole('login', 'result'), 10: answered_whole(None, 'failure', 'ACCESS_DENIED'),
      12: answered_whole(None, 'failure', 'ACCESS_DENIED'), 14: answered_whole(None, 'failure', 'ACCESS_DENIED')}),
    ('a subscription through a relay counts the relay\'s SUBSCRIPTION_UNSUPPORTED under _OTHER', [RELAYED, LABELED],
     'a request that opens a subscription through a relay is answered SUBSCRIPTION_UNSUPPORTED',
     {4: answered_whole('login', 'result'), 6: answered_whole('register', 'result'),
      8: answered_whole(None, 'failure', 'SUBSCRIPTION_UNSUPPORTED')}),
    ('a leg B past its destination\'s timeout counts timeout, and its leg A the relay\'s DESTINATION_LOST', [RELAYED, MADE_TIMEOUT],
     'leg B past its destination\'s timeout is cancelled, and leg A answered DESTINATION_LOST',
     {8: [*answered_whole('login', 'result'), *answered_whole('register', 'result'), opened(), commanded()],
      13: [settled(None, 'timeout', microseconds=2 * SECOND), ended(None, 'failure', 'DESTINATION_LOST', 2 * SECOND)]}),
    ('a leg B whose connection goes counts closed, and its leg A the relay\'s DESTINATION_LOST', [RELAYED, MADE_CLOSED],
     'leg B\'s connection gone once it had the request is answered DESTINATION_LOST, and reported with leg A\'s connection',
     {8: [*answered_whole('login', 'result'), *answered_whole('register', 'result'), opened(), commanded()],
      11: [settled(None, 'closed'), ended(None, 'failure', 'DESTINATION_LOST')]}),
    ('a cancel on leg A counts cancelled at both of the relay\'s gates', [RELAYED, CANCELLED, MADE_CANCELLED],
     'a cancel on leg A cancels leg B, and leg A is answered nothing',
     {8: [*answered_whole('login', 'result'), *answered_whole('register', 'result'), opened(), commanded()],
      10: [ended(None, 'cancelled'), settled(None, 'cancelled')]}),
    # the notifications the server sends, and its subscriptions dropped
    ('a notification handed to its transport counts sent, under the procedure its subscription went to', [GOES, NOTIFICATION_SENT, WIRE],
     'a request that opens a subscription to ticks is answered, and each tick notifies it on its call id',
     {2: answered_whole('ticks', 'result'), 5: [*answered_whole('tick', 'result'), sent('ticks')]}),
    ('a notification a credit lets go from its queue counts sent as it goes, and one queued counts nothing', [GOES, NOTIFICATION_SENT],
     'a paced subscription is sent a notification per credit, the first credited by its request',
     {2: answered_whole('ticks', 'result'), 5: [*answered_whole('tick', 'result'), sent('ticks')],
      7: answered_whole('tick', 'result'), 9: sent('ticks')}),
    ('a client\'s cancel drops no subscription', [CANCEL_DROPS_NOTHING],
     'a cancel ends a subscription, and nothing more goes on its call id',
     {2: answered_whole('ticks', 'result'), 5: answered_whole('tick', 'result')}),
    ('a queue past its bounds once answered drops its subscription, CAPACITY_EXCEEDED, its notifications queued neither sent nor failed',
     [DROPPED, QUEUE_DROPPED, CANCEL_DROPS_NOTHING],
     'a queue past its bounds ends an answered subscription with a failure on its call id',
     {2: answered_whole('ticks', 'result'), 5: [*answered_whole('tick', 'result'), sent('ticks')],
      12: [*answered_whole('tick', 'result'), *answered_whole('tick', 'result'), subscription_dropped('ticks', 'CAPACITY_EXCEEDED'),
           *answered_whole('tick', 'result')],
      14: answered_whole('tick', 'result')}),
    ('a session that ends drops its subscriptions, SESSION_REQUIRED', [DROPPED, SESSION_DROPPED],
     'a session that ends ends its connection\'s subscriptions, the first answer to go out announcing it',
     {2: answered_whole('login', 'result'), 4: answered_whole('ticks', 'result'),
      7: [subscription_dropped('ticks', 'SESSION_REQUIRED'), *answered_whole('logout', 'result')], 9: answered_whole('tick', 'result')}),
    ('a connection that closes drops its subscriptions, with no code', [DROPPED, CLOSE_DROPPED],
     'a request that opens a subscription to ticks is answered, and each tick notifies it on its call id',
     {2: answered_whole('ticks', 'result'), 3: subscription_dropped('ticks')}, [close()], 2),
]

exits = [exit_entry(name, clauses, conversation, counted, *rest) for name, clauses, conversation, counted, *rest in EXITS]

document = {
    '$schema': 'schemas/metrics.schema.json',
    '$comment': [
        "Bead's metrics: what a registry writes, byte for byte, for what it is given to count, and what each exit of a call or a notification the interop service's server reaches counts, step by step (spec/debugging.md, sections 7 to 12; decision 0013).",
        'mediaType is the media type an exposition is given with (12.1).',
        'An exposition is a registry played on its own. maximumProcedures, where given, is its ceiling (7.4), else its default. routers are the routers it is given, each by its side, client or server, in their order; a declaration or a count names its router by its index among them.',
        'declarations are made in their order (7.2): as is how the procedure is declared, resolver, its resolver registered, notifies true when its procedure notifies; requester, a requester made; notification, a notification registered, on the side that hears. refused, where given, is the reason the declaration is refused (7.3), which declares nothing. serviceRevision, where given, is its service\'s revision; left out, it is 1.',
        'counts are counted in their order, each on its router. A call, answered or made, is counted whole, from its start to its end, by its outcome, its code when it has one, and its microseconds; one with no outcome started, and is under way. A notification sent or failed counts at the side that notifies, heard at the side that hears; dropped is a subscription dropped at that end, by its code when it has one. A count with no serviceId and procedureId is _OTHER\'s.',
        'exposition is the text the registry writes then: these lines, each ended by a line feed.',
        'An exit is a conversation of the interop service\'s server (conversations.json), played as it is, its steps, its limits, its pacing and its relay those of conversations.json, its server given a registry of its own, with its default ceiling, through the option its router takes, metricsRegistry, MetricsRegistry. The server declares to it as it is built: each procedure it offers as a resolver, ticks as one that notifies, and clock, the command it calls, as a requester.',
        'counted is the series that moved since the case began, or since the last counted: each by the line the exposition writes for it, with its value, in the exposition\'s order; every other series is unmoved, and none is made or gone. It follows a step the server takes, an expect, a report, an advance or a close, and a player reads the exposition on its core\'s scheduler once the step before it settled. As the case begins, once the server is built, every series is at 0.',
        'A duration is timed on the clock the server is given, which only an advance moves: a call that starts and ends between two advances takes 0 microseconds.',
        'clauses are the units of spec/debugging.md an entry checks: a clause, 7.3; a row of its table, counted from 1, 9.4.2.',
    ],
    'debuggingVersion': debugging_version(),
    'mediaType': MEDIA_TYPE,
    'wallClock': talk.WALL_CLOCK,
    'expositions': [exposition_entry(*each) for each in EXPOSITIONS],
    'exits': exits,
}

with open(ROOT + 'metrics.json', 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=False, indent=2)
    file.write('\n')

print(len(EXPOSITIONS), 'expositions and', len(exits), 'exits')
