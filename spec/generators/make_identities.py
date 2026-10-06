"""Writes spec/identities.json: what a router does as a procedure is declared to it (spec section 16,
decisions 0017 and 0018), taken or refused by the first reason of 16.10 that applies, and which two
names are one (16.6).

Each outcome is section 16 read here by hand, character by character as 16.5 reads a name, never by a
regular expression, whose $ may let a line terminator by, nor by a case mapping, which reads the Kelvin
sign as a k; a procedure's call is held against what each way takes, as 16.11 states it.
make_metrics.py takes its fold from here."""
import json
import os

from spec_version import spec_version

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')

# ── Section 16 ──────────────────────────────────────────────────────────────────────────────────

# 16.4's ABNF: lower, upper and DIGIT, each a range of ASCII
LOWER = frozenset('abcdefghijklmnopqrstuvwxyz')
UPPER = frozenset('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
DIGITS = frozenset('0123456789')

# 16.4: 1 to 63 characters
LONGEST = 63

# 16.2: each id's range, and a revision's
SERVICE_IDS = (1, 65_535)
PROCEDURE_IDS = (1, 65_535)
REVISIONS = (1, 2 ** 31 - 1)

# 16.10: the reasons, in their order
OUT_OF_ITS_RANGE, OFF_ITS_FORM, AGAINST_ITS_CALL = 'out of its range', 'off its form', 'against its call'

# the six ways a side declares, each by an id its harness keys its table by: a resolver on a server's
# router is one way where it notifies nothing and another where it notifies, since 16.11 tells them apart
WAYS = ['client-resolver', 'server-resolver', 'server-notification-resolver', 'client-requester', 'server-requester',
        'client-notification']

# 16.11: a procedure's calls, and the calls each way takes
REQUEST, NOTIFIES, COMMAND = 'request', 'notifies', 'command'
TAKES = {
    'client-resolver': {COMMAND},
    'server-resolver': {REQUEST},
    'server-notification-resolver': {NOTIFIES},
    'client-requester': {REQUEST, NOTIFIES},
    'server-requester': {COMMAND},
    'client-notification': {NOTIFIES},
}

# the row of docs/support.md an input crosses that no C# type holds: a ushort an id, an int a revision
NO_CSHARP_TYPE = 'An id or a revision no C# type holds'
USHORT = (0, 65_535)
INT = (-2 ** 31, 2 ** 31 - 1)

# where a name is declared, and the name an id or a revision is declared under
SERVICE_ID, PROCEDURE_ID, REVISION, NAME = 1, 1, 1, 'echo'


def is_procedure_name(name):
    """Whether name is a procedure-name (16.4), read character by character (16.5)."""
    return 1 <= len(name) <= LONGEST and name[0] in LOWER and all(c in LOWER | UPPER | DIGITS for c in name[1:])


def folded(name):
    """name with each ASCII upper-case letter read as its lower-case one (16.6), and nothing else."""
    return ''.join(chr(ord(c) + 32) if c in UPPER else c for c in name)


def is_whole(value, low, high):
    """Whether value is a whole number from low to high: no bool, no fraction, no string, no null."""
    return type(value) is int and low <= value <= high


def refusal(service_id, procedure_id, revision, name, call=None, way=None):
    """The first reason of 16.10 that applies to a declaration made `way`, or None where it is taken: a
    procedure that names no call is taken every way."""
    if not (is_whole(service_id, *SERVICE_IDS) and is_whole(procedure_id, *PROCEDURE_IDS)
            and is_whole(revision, *REVISIONS)):
        return OUT_OF_ITS_RANGE

    if not is_procedure_name(name):
        return OFF_ITS_FORM

    if call is not None and call not in TAKES[way]:
        return AGAINST_ITS_CALL

    return None


def held_in_csharp(service_id, procedure_id, revision):
    """Whether the C# side can be given the declaration at all: a ushort each id, an int its revision."""
    return is_whole(service_id, *USHORT) and is_whole(procedure_id, *USHORT) and is_whole(revision, *INT)


# ── The names ───────────────────────────────────────────────────────────────────────────────────

# the units: a name's form (16.4), a name read whole (16.5), and the reason it is refused for (16.10)
FORM, WHOLE, RANGES, SERVICE_ZERO, REVISION_ZERO, FOLD = '16.4', '16.5', '16.2', '16.3', '16.9', '16.6'
ORDER, OUT_OF_RANGE_ROW, OFF_FORM_ROW, AGAINST_CALL_ROW = '16.10', '16.10.1', '16.10.2', '16.10.3'
CALL, SUBSCRIPTION = '16.11', '11.2'
SERVICE_ROW, PROCEDURE_ROW, REVISION_ROW = '16.2.1', '16.2.2', '16.2.3'

LINE_FEED, CARRIAGE_RETURN, NUL = chr(10), chr(13), chr(0)
BYTE_ORDER_MARK = chr(0xFEFF)
KELVIN = chr(0x212A)
LONG_S = chr(0x17F)
CAPITAL_I_WITH_DOT = chr(0x130)
FULL_WIDTH_E = chr(0xFF45)
E_ACUTE, CAPITAL_E_ACUTE = chr(0xE9), chr(0xC9)
GRINNING_FACE = chr(0x1F600)

# each entry's name, the procedure's name declared, and the unit that says what holds of it
NAMES = [
    ('a', 'a', FORM),
    ('x9', 'x9', FORM),
    ('echo', 'echo', FORM),
    ('endSessionsOf', 'endSessionsOf', FORM),
    ('getHTTPStatus2', 'getHTTPStatus2', FORM),
    ('63 characters', 'a' * LONGEST, FORM),
    ('64 characters', 'a' * (LONGEST + 1), FORM),
    ('the empty name', '', FORM),
    ('Echo', 'Echo', FORM),
    ('9lives', '9lives', FORM),
    ('_OTHER', '_OTHER', WHOLE),
    ('get_thing', 'get_thing', FORM),
    ('get-thing', 'get-thing', FORM),
    ('a.b', 'a.b', FORM),
    ('a b', 'a b', FORM),
    ('*', '*', FORM),
    ('-echo', '-echo', FORM),
    ('d(rx)', 'd(rx)', FORM),
    ('say"hi"', 'say"hi"', FORM),
    ('echo and a line feed', 'echo' + LINE_FEED, WHOLE),
    ('a line feed and echo', LINE_FEED + 'echo', WHOLE),
    ('echo and a carriage return', 'echo' + CARRIAGE_RETURN, WHOLE),
    ('echo and a NUL', 'echo' + NUL, WHOLE),
    ('a byte order mark and echo', BYTE_ORDER_MARK + 'echo', WHOLE),
    ('the Kelvin sign', KELVIN + 'elvin', WHOLE),
    ('the Kelvin sign within a name', 'ma' + KELVIN + 'e', WHOLE),
    ('the long s', LONG_S + 'tatus', WHOLE),
    ('a capital I with a dot above', CAPITAL_I_WITH_DOT + 'd', WHOLE),
    ('a full-width e', FULL_WIDTH_E + 'cho', WHOLE),
    ('caf' + E_ACUTE, 'caf' + E_ACUTE, FORM),
    ('an emoji', 'echo' + GRINNING_FACE, FORM),
]


def name_entry(name, procedure_name, unit):
    refused = refusal(SERVICE_ID, PROCEDURE_ID, REVISION, procedure_name)

    return {'name': name, 'clauses': [unit, *([OFF_FORM_ROW] if refused else [])], 'procedureName': procedure_name,
            **({'refused': refused} if refused else {})}


# ── The ids and the revisions ───────────────────────────────────────────────────────────────────

# each input every id and revision is given: whole, in its range and past it, and none that is whole
INPUTS = {
    'service': [0, 1, 65_535, 65_536, -1, 1.5, '1', True, None],
    'procedure': [0, 1, 65_535, 65_536, -1, 1.5, '1', True, None],
    'revision': [0, -1, 1, 2 ** 31 - 1, 2 ** 31, 1.5, '1', True, None],
}
ROWS = {'service': SERVICE_ROW, 'procedure': PROCEDURE_ROW, 'revision': REVISION_ROW}


def id_entry(name, service_id, procedure_id, revision, units, procedure_name=None):
    refused = refusal(service_id, procedure_id, revision, procedure_name or NAME)
    differs = [] if held_in_csharp(service_id, procedure_id, revision) else [{'row': NO_CSHARP_TYPE, 'language': 'C#'}]

    return {'name': name, 'clauses': [*units, *([OUT_OF_RANGE_ROW] if refused == OUT_OF_ITS_RANGE else [])],
            'serviceId': service_id, 'procedureId': procedure_id, 'serviceRevision': revision,
            **({'procedureName': procedure_name} if procedure_name else {}),
            **({'refused': refused} if refused else {}), **({'differs': differs} if differs else {})}


def ids():
    entries = []

    for kind, values in INPUTS.items():
        for value in values:
            given = {'service': SERVICE_ID, 'procedure': PROCEDURE_ID, 'revision': REVISION, kind: value}
            # a value that is no whole number fails 16.2 itself, beside its row
            units = [*([] if type(value) is int else [RANGES]), ROWS[kind],
                     *([SERVICE_ZERO] if (kind, value) == ('service', 0) else []),
                     *([REVISION_ZERO] if (kind, value) == ('revision', 0) else [])]
            entries.append(id_entry(f'{kind} {json.dumps(value)}', given['service'], given['procedure'],
                                    given['revision'], units))

    # 16.10's order: a declaration out of its range and off its form is refused out of its range
    entries.append(id_entry('service 0 under the name Echo', 0, PROCEDURE_ID, REVISION, [SERVICE_ZERO, ORDER], 'Echo'))

    return entries


# ── The folds ───────────────────────────────────────────────────────────────────────────────────

FOLDS = [
    ('getHTTPStatus and getHttpStatus', 'getHTTPStatus', 'getHttpStatus'),
    ('echo and ECHO', 'echo', 'ECHO'),
    ('echo and echa', 'echo', 'echa'),
    ('key and the Kelvin sign', 'key', KELVIN + 'ey'),
    ('caf' + E_ACUTE + ' and caf' + CAPITAL_E_ACUTE, 'caf' + E_ACUTE, 'caf' + CAPITAL_E_ACUTE),
    ('id and a capital I with a dot above', 'id', CAPITAL_I_WITH_DOT + 'd'),
    ('an at sign and a grave accent, 32 apart', 'a@', 'a`'),
    ('the empty strings', '', ''),
]


def fold_entry(name, first, second):
    return {'name': name, 'clauses': [FOLD], 'names': [first, second], 'one': folded(first) == folded(second)}


# ── The calls ───────────────────────────────────────────────────────────────────────────────────

# each entry's name, the call its procedure names, none for no call, the units that say what holds of
# it, and where it is declared other than at service 1, procedure 1, revision 1, under the name echo
CALLS = [
    ('no call', None, [CALL], {}),
    ('request', REQUEST, [CALL], {}),
    ('notifies', NOTIFIES, [SUBSCRIPTION, CALL], {}),
    ('command', COMMAND, [CALL], {}),
    # 16.10's order: a declaration out of its range, or off its form, that is against its call too is
    # refused for the first
    ('command at service 0', COMMAND, [SERVICE_ZERO, ORDER], {'serviceId': 0}),
    ('command under the name Echo', COMMAND, [ORDER], {'procedureName': 'Echo'}),
]

# the row of 16.10's table each reason is
REASON_ROWS = {OUT_OF_ITS_RANGE: OUT_OF_RANGE_ROW, OFF_ITS_FORM: OFF_FORM_ROW, AGAINST_ITS_CALL: AGAINST_CALL_ROW}


def call_entry(name, call, units, given):
    """A declaration of a procedure naming `call`, made each way: the one reason it is refused for, and
    the ways that refuse it where some take it."""
    reasons = {way: refusal(given.get('serviceId', SERVICE_ID), PROCEDURE_ID, REVISION,
                            given.get('procedureName', NAME), call, way) for way in WAYS}
    refusing = [way for way in WAYS if reasons[way] is not None]
    refused = {reasons[way] for way in refusing}
    assert len(refused) <= 1, (name, reasons)
    reason = next(iter(refused), None)

    return {'name': name, 'clauses': [*units, *([REASON_ROWS[reason]] if reason else [])],
            **({'call': call} if call else {}), **given, **({'refused': reason} if reason else {}),
            **({'refusedAt': refusing} if reason and len(refusing) < len(WAYS) else {})}


names = [name_entry(*entry) for entry in NAMES]
identities = ids()
folds = [fold_entry(*entry) for entry in FOLDS]
calls = [call_entry(*entry) for entry in CALLS]

# what the record states of them, held here against a slip in the rules above
assert [entry['name'] for entry in names if 'refused' not in entry] == ['a', 'x9', 'echo', 'endSessionsOf',
                                                                         'getHTTPStatus2', '63 characters']
outcomes = {entry['name']: entry.get('refused') for entry in identities}

for name, outcome in {'service 0': OUT_OF_ITS_RANGE, 'service 1': None, 'service 65535': None, 'procedure 65535': None,
                      'service 65536': OUT_OF_ITS_RANGE, 'revision 0': OUT_OF_ITS_RANGE, 'revision -1': OUT_OF_ITS_RANGE,
                      'revision 2147483647': None, 'revision "1"': OUT_OF_ITS_RANGE,
                      'service 0 under the name Echo': OUT_OF_ITS_RANGE}.items():
    assert outcomes[name] == outcome, (name, outcomes[name])

assert [name for name, outcome in outcomes.items() if outcome is None] == [
    'service 1', 'service 65535', 'procedure 1', 'procedure 65535', 'revision 1', 'revision 2147483647']
assert [entry['name'] for entry in identities if 'differs' in entry] == [
    f'{kind} {value}' for kind, values in (('service', ('65536', '-1', '1.5', '"1"', 'true', 'null')),
                                           ('procedure', ('65536', '-1', '1.5', '"1"', 'true', 'null')),
                                           ('revision', ('2147483648', '1.5', '"1"', 'true', 'null')))
    for value in values]
assert [entry['one'] for entry in folds] == [True, True, False, False, False, False, False, True]

# 0018's table of what each way takes: the ways that refuse each call, the others taking it; none
# refused where no call is named; and identity first
assert {entry['name']: (entry.get('refused'), entry.get('refusedAt')) for entry in calls} == {
    'no call': (None, None),
    'request': (AGAINST_ITS_CALL, ['client-resolver', 'server-notification-resolver', 'server-requester',
                                   'client-notification']),
    'notifies': (AGAINST_ITS_CALL, ['client-resolver', 'server-resolver', 'server-requester']),
    'command': (AGAINST_ITS_CALL, ['server-resolver', 'server-notification-resolver', 'client-requester',
                                   'client-notification']),
    'command at service 0': (OUT_OF_ITS_RANGE, None),
    'command under the name Echo': (OFF_ITS_FORM, None),
}

document = {
    '$schema': 'schemas/identities.schema.json',
    '$comment': [
        "Bead's identities: what a router does as a procedure is declared to it (spec section 16, decisions 0017 and 0018), taken, or refused by the first reason of 16.10 that applies, out of its range before off its form, off its form before against its call, as it is declared and never on a call; a declaration refused declares nothing. And which two names are one (16.6).",
        "ways are the six ways a side declares, each by an id its harness keys its table by: a resolver registered on a client's router; one registered on a server's that notifies nothing, and one there that notifies; a requester made on each router; and a notification registered on a client's. A harness plays each entry of names, ids and calls each way, each on a router of its own, given no metrics registry.",
        'names: a procedure\'s name, procedureName, declared at service 1, procedure 1, revision 1. ids: a service id, a procedure id and a service revision, each any JSON value, as a value read from JSON may be, declared under the name echo, or under procedureName where the entry gives one.',
        'calls: a procedure naming its call, request, notifies or command, or none where the entry gives no call, declared at service 1, procedure 1, revision 1, under the name echo, or at the serviceId or under the procedureName the entry gives.',
        'refused, where given, is the reason the declaration is refused, at every way, or at the ways an entry of calls lists in refusedAt, every other way taking it; absent, it is taken. The reason is derived, and held by the regeneration alone: the words of a refusal are each side\'s, and a side that reports a refusal by a code checks the reason against that code.',
        'folds: two names, and one, whether they are one name by 16.6, each ASCII upper-case letter read as its lower-case one and nothing else changed; a harness plays them through the one helper every comparison of names on its side goes through.',
        'differs names the row of docs/support.md an entry crosses, which names this file and the entry, and the language it excuses: an input that language cannot be given. A harness plays every entry but those a differs excuses its language from.',
        'clauses are the units of spec.md an entry checks: a clause, 16.4; a row of its table, counted from 1, 16.2.1.',
    ],
    'specVersion': spec_version(),
    'ways': WAYS,
    'names': names,
    'ids': identities,
    'folds': folds,
    'calls': calls,
}

# written when run, and not when make_metrics.py takes its fold from here
if __name__ == '__main__':
    with open(ROOT + 'identities.json', 'w', encoding='utf-8', newline='\n') as file:
        json.dump(document, file, ensure_ascii=False, indent=2)
        file.write('\n')

    print(len(names), 'names,', len(identities), 'ids and revisions,', len(folds), 'folds and', len(calls),
          'calls, each name, id and call declared', len(WAYS), 'ways')
