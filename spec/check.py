"""Checks the conformance files beside the spec and its companion, past what regenerating them proves,
and reports which of them each implementation's tests read.

  python spec/check.py

Every spec/*.json has its schema in spec/schemas/, and every schema its file; each file follows its
schema, which follows JSON Schema 2020-12, and holds no key twice (RFC 7493); each repeats the
version of the document it belongs to, spec/spec.md's as its specVersion, or spec/debugging.md's,
the companion's, as its debuggingVersion; no group holds two entries of one name, which a reader
looking one up by name would never reach; each group of vectors.json is named by a section of the
spec, which names no other, and each of the companion's files by a line of its own; every unit an
entry cites is one of its document's — a clause, an item of its numbered list, a row of its table —
and spec/uncited.txt and spec/debugging-uncited.txt list exactly the units of each that no entry
cites; an advance follows a timer armed, and in the transports' cases ends on its due at the
latest; a debug filter keeps fixtures the file has; an exit counts after a step its server takes;
each exposition the metrics pin reads as 0.0.4, its families in the order of their names under the
companion's help and type, its buckets rising under the companion's bounds, each le OpenMetrics'
canonical number for its bound, each _count the sum of its handled counts, none started below
handled; each implementation's tests read every group, the conversations, the transports' cases,
any of which may name the row of docs/support.md it crosses, the clock cases, the debug filters and
the metrics; the durations name each place by one id and each input by one name, give every place
an outcome for every input in their order, cite at each place only what it observes, and name,
where they cross a row of docs/support.md, a row that names the file and them; each implementation
plays them in one harness, which names every place, through one helper, which alone reads the file;
and no file git lists outside spec/, the tests and the interop service names a published test key.
Exit 1 on any of them.

  python spec/check.py --write-uncited

writes spec/uncited.txt and spec/debugging-uncited.txt from the files as they stand, for a change
that cites or leaves a unit.

It needs jsonschema, locked in spec/requirements.txt.
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
from decimal import Decimal

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from generators.debugging_version import debugging_version
from generators.spec_version import spec_version

SPEC = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SPEC)
SCHEMAS = os.path.join(SPEC, 'schemas')

# the schema the others take their definitions from, which describes no file of its own
COMMON = 'common'

# what vectors.json holds beside its groups
META = {'$schema', '$comment', 'specVersion'}

# the units of each document no entry cites, which only a change to the files or the document moves
UNCITED = {
    'spec': (os.path.join(SPEC, 'uncited.txt'),
             '# The units of spec/spec.md that no vector, conversation, case or place cites, in their order.\n'
             '# spec/check.py fails when this list and the files disagree; --write-uncited writes it.\n'),
    'debugging': (os.path.join(SPEC, 'debugging-uncited.txt'),
                  '# The units of spec/debugging.md that no debug filter, source, exposition or exit cites, in their order.\n'
                  '# spec/check.py fails when this list and the files disagree; --write-uncited writes it.\n'),
}
WRITE_UNCITED = '--write-uncited' in sys.argv[1:]

# the files of entries each side's tests read whole, beside the groups of vectors, and their groups
WHOLE = {
    'conversations': ('conversations',),
    'transports': ('transports',),
    'clocks': ('clocks',),
    'debug-filters': ('filters', 'sources'),
    'metrics': ('expositions', 'exits'),
}

# the companion's files, which repeat its version and cite its units, each named by a line of it, and
# the groups that cite them (0013)
COMPANION = {'debug-filters': 'Debug filters', 'metrics': 'Metrics'}
COMPANION_GROUPS = ('filters', 'sources', 'expositions', 'exits')

# where each implementation's tests are, the files among them, how they name a group of vectors, and
# how they name a file they read whole: a language that joins adds its row
SIDES = {
    'TypeScript': ('implementations/typescript/src', '.test.ts', r'\bVECTORS\.(\w+)', r"'[^']*\b{}\.json'"),
    'C#': ('implementations/dotnet/tests', '.cs', r'\bVectors\.(?:NamesOf|Of)\("(\w+)"', r'"{}\.json"'),
}

# the harness each side plays spec/durations.json in, and the helper beside it that alone reads the
# file, for the harness and for the twins of its assertion: the harness names every place it plays, so
# that one gone, or one that plays fewer, fails here (0014)
DURATIONS_HARNESSES = {
    'TypeScript': ('implementations/typescript/src/server/__tests__/durations.test.ts',
                   'implementations/typescript/src/transport/shared/__tests__/durations.ts'),
    'C#': ('implementations/dotnet/tests/Bead.Transport.Http.Tests/DurationsTests.cs',
           'implementations/dotnet/tests/Shared/Durations.cs'),
}

# the matrix whose rows a case that crosses a platform's difference names
SUPPORT = os.path.join(ROOT, 'docs', 'support.md')

# the published test keys the JWT verdicts use, whose private halves anyone can read: a configuration
# that names one trusts every token its reader signs (0010). Each is found by the members that hold
# its material, as a JWK writes them, and by its RFC 7638 thumbprint
TEST_KEYS = {
    "RFC 7515's A.1, an HMAC key": {'kty': 'oct', 'k': 'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow'},
    "RFC 7515's A.3, a P-256 key": {'kty': 'EC', 'crv': 'P-256', 'x': 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
                                    'y': 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
                                    'd': 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI'},
    "RFC 7517's A.2, a P-256 encryption key": {'kty': 'EC', 'crv': 'P-256', 'x': 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
                                               'y': '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM',
                                               'd': '870MB6gfuTJ4HtUnUvYMyJpr5eUZNP4Bk43bVdj3eAE'},
    "RFC 7520's 3.5, an HMAC key": {'kty': 'oct', 'k': 'hJtXIZ2uSN5kbQfbtTNWbpdmhkV8FJG-Onbc6mxCcYg'},
}

# the files that may name a test key, by their path from the root: the conformance files, each side's
# tests, and the interop service, whose credentials hold them
TESTS = re.compile(r'spec/|(.*/)?__tests__/|implementations/[^/]+/(tests|interop)/')

# the files that use every test key listed, so that a gate that matches nothing fails: the verdicts'
# keys, and the interop service's credentials, its key set's among them
KEYS_USED = ('spec/vectors.json', 'spec/interop-service.json')

problems = []


def unique(pairs):
    keys = [key for key, _ in pairs]
    twice = sorted({key for key in keys if keys.count(key) > 1})

    if twice:
        raise ValueError(f'the key(s) {", ".join(twice)} more than once')

    return dict(pairs)


def load(path):
    with open(path, encoding='utf-8') as file:
        return json.load(file, object_pairs_hook=unique)


def report_and_exit():
    print(f'spec: {len(problems)} problem(s):', file=sys.stderr)

    for problem in problems:
        print(f'  {problem}', file=sys.stderr)

    sys.exit(1)


# ── Each file and its schema ────────────────────────────────────────────────────────────────────

files = {name[:-len('.json')] for name in os.listdir(SPEC) if name.endswith('.json')}
schema_names = {name[:-len('.schema.json')] for name in os.listdir(SCHEMAS) if name.endswith('.schema.json')}

for name in sorted(files - schema_names):
    problems.append(f'{name}.json has no schema in spec/schemas/')

for name in sorted(schema_names - files - {COMMON}):
    problems.append(f'schemas/{name}.schema.json describes no file of spec/')

schemas = {}
documents = {}

for name in sorted(schema_names):
    try:
        schemas[name] = load(os.path.join(SCHEMAS, f'{name}.schema.json'))
        Draft202012Validator.check_schema(schemas[name])
    except Exception as error:
        problems.append(f'schemas/{name}.schema.json: {str(error).splitlines()[0][:300]}')

for name in sorted(files):
    try:
        documents[name] = load(os.path.join(SPEC, f'{name}.json'))
    except ValueError as error:
        problems.append(f'{name}.json: {error}')

if problems:
    report_and_exit()

# each schema found by the name the others give it in their $ref
registry = Registry().with_resources(
    (f'{name}.schema.json', Resource.from_contents(schema)) for name, schema in schemas.items())

for name, document in documents.items():
    validator = Draft202012Validator(schemas[name], registry=registry)

    for error in sorted(validator.iter_errors(document), key=lambda error: list(error.absolute_path)):
        place = '/'.join(str(part) for part in error.absolute_path) or '(root)'
        problems.append(f'{name}.json at {place}: {error.message[:300]}')

# what follows reads the files as their schemas describe them
if problems:
    report_and_exit()

# ── One version, one name ───────────────────────────────────────────────────────────────────────

version = spec_version()
companion_version = debugging_version()

# each file repeats the version of the document it belongs to, and the companion's files the companion's
for name, document in documents.items():
    key, stated, by = (('debuggingVersion', companion_version, 'debugging.md') if name in COMPANION
                       else ('specVersion', version, 'spec.md'))

    if key not in document:
        problems.append(f'{name}.json: no {key}, the version of {by}, which it belongs to')
    elif document[key] != stated:
        problems.append(f'{name}.json: {key} {document[key]}, where {by} states {stated}')

vectors = documents['vectors']
groups = [group for group in vectors if group not in META]
named = {group: vectors[group] for group in groups}
named['conversations'] = documents['conversations']['conversations']
named['transports'] = documents['transports']['cases']
named['clocks'] = documents['clocks']['cases']
named['filters'] = documents['debug-filters']['filters']
named['sources'] = documents['debug-filters']['sources']
named['expositions'] = documents['metrics']['expositions']
named['exits'] = documents['metrics']['exits']

for group, entries in named.items():
    seen = set()

    for entry in entries:
        if entry['name'] in seen:
            problems.append(f'{group}: two entries named {entry["name"]!r}')
        seen.add(entry['name'])

responses = set()

for response in documents['transports']['responses']:
    if response['name'] in responses:
        problems.append(f'transports: two responses named {response["name"]!r}')
    responses.add(response['name'])

# an entry that crosses a row of the matrix is named by that row, between backticks, as a word of its
# own: a name found inside another word, or inside the row's title, names nothing
with open(SUPPORT, encoding='utf-8') as file:
    rows = [line for line in file.read().splitlines() if line.startswith('| ')]


# each row and name told once, however many entries cross it so
told = set()


def check_crossing(entry, crossings, *names):
    for crossed in crossings:
        row = next((line for line in rows if line.split('|')[1].strip() == crossed['row']), None)

        if row is None and crossed['row'] not in told:
            told.add(crossed['row'])
            problems.append(f'{entry} crosses the row {crossed["row"]!r}, which docs/support.md does not have')

        for name in names if row is not None else ():
            if f'`{name}`' not in row and (crossed['row'], name) not in told:
                told.add((crossed['row'], name))
                problems.append(f'{entry} crosses the row {crossed["row"]!r}, which does not name `{name}`')


for case in named['transports']:
    check_crossing(f'transports: {case["name"]!r}', case.get('differs', []), case['name'])

# ── The durations ───────────────────────────────────────────────────────────────────────────────

durations = documents['durations']
inputs = [entry['name'] for entry in durations['inputs']]
places = durations['places']

for twice in sorted({name for name in inputs if inputs.count(name) > 1}):
    problems.append(f'durations: two inputs named {twice!r}')

# a place is keyed by its id, which both harnesses' tables name
ids = [place['id'] for place in places]

for twice in sorted({each for each in ids if ids.count(each) > 1}):
    problems.append(f'durations: two places of the id {twice}')

for entry in durations['inputs']:
    check_crossing(f'durations: the input {entry["name"]!r}', entry.get('differs', []), 'spec/durations.json',
                   entry['name'])

for place in places:
    ways = [way['id'] for way in place['ways']]

    for twice in sorted({way for way in ways if ways.count(way) > 1}):
        problems.append(f'durations: {place["id"]} has two ways of the id {twice}')

    for way in place['ways']:
        check_crossing(f'durations: {place["id"]}, its way {way["id"]},', way.get('differs', []),
                       'spec/durations.json', place['id'], way['id'])

    if [outcome['input'] for outcome in place['outcomes']] != inputs:
        problems.append(f'durations: {place["id"]} has not one outcome for each input, in the inputs\' order')

    for outcome in place['outcomes']:
        check_crossing(f'durations: {place["id"]}, at {outcome["input"]!r},', outcome.get('differs', []),
                       'spec/durations.json', outcome['input'])

    # a place cites a unit only for what it observes of it: 1.4, which holds and refuses its durations,
    # the clause that says whether it may be without end, and the clause that states its default
    default = place.get('default')
    observed = {'1.4', place.get('neverClause', '1.4'), default['clause'] if default else '1.4'}

    if set(place['clauses']) != observed:
        problems.append(f'durations: {place["id"]} cites {", ".join(place["clauses"])}, where it observes '
                        f'{", ".join(sorted(observed))}: 1.4, its neverClause and its default\'s clause')

    # a default is read by building a way with nothing given, which a way that cannot leave its
    # duration out never is
    for way in default['ways'] if default else ():
        if way not in ways:
            problems.append(f'durations: {place["id"]} reads its default by the way {way}, which it does not have')
        elif any(other['id'] == way and other.get('required') for other in place['ways']):
            problems.append(f'durations: {place["id"]} reads its default by the way {way}, which cannot leave its '
                            'duration out')

# an advance follows a timer armed on the side's clock, since the last send, expect or advance, so the
# timer it steps to is armed before the clock moves (0011)
# ! over a socket, an advance goes no further than the due its until named: what a timer fired leads
# to, on the platform's threads, reads the clock, which must not have run past it
for group in ('conversations', 'transports', 'exits'):
    for entry in named[group]:
        armed = None

        for number, step in enumerate(entry['steps'], 1):
            if 'advance' in step and armed is None:
                problems.append(f'{group}: {entry["name"]!r}, step {number}, advances with no timer armed since its '
                                'last send, expect or advance: an until timer comes first')
            elif 'advance' in step and group == 'transports' and step['advance'] > armed:
                problems.append(f'{group}: {entry["name"]!r}, step {number}, advances {step["advance"]} ms, past the '
                                f'timer its until named, due in {armed}: an advance ends on that due at the latest')

            if 'until' in step and 'timer' in step['until']:
                armed = step['until']['timer']
            elif {'send', 'expect', 'advance'} & set(step):
                armed = None

# a conversation that opens its connections names one, opened already, on every other step but those
# that move the server's clock, which are no connection's; one that opens none plays the one connection
# opened before its first step, and names none. An exit's are a conversation's, and what it counted,
# the server's whole registry, is no connection's either
for group in ('conversations', 'exits'):
    for conversation in named[group]:
        steps = conversation['steps']
        opened = set()

        for number, step in enumerate(steps, 1):
            if 'open' in step:
                opened.add(step['open'])
            elif {'until', 'advance', 'wall', 'counted'} & set(step):
                if 'on' in step:
                    problems.append(f'{group}: {conversation["name"]!r}, step {number}, names a connection, '
                                    'where it moves the server\'s clock')
            elif any('open' in other for other in steps) and step.get('on') not in opened:
                problems.append(f'{group}: {conversation["name"]!r}, step {number}, names no connection opened '
                                f'before it: {step.get("on")!r}')
            elif not any('open' in other for other in steps) and 'on' in step:
                problems.append(f'{group}: {conversation["name"]!r}, step {number}, names a connection, '
                                'where the conversation opens none')

# an exit counts once the server took a step, which settles before its player reads the exposition:
# an expect, a report, an advance or a close, never a send alone, which the server may not have read
for entry in named['exits']:
    steps = entry['steps']

    for number, step in enumerate(steps, 1):
        if 'counted' in step and (number == 1 or not {'expect', 'report', 'advance', 'close'} & set(steps[number - 2])):
            problems.append(f'exits: {entry["name"]!r}, step {number}, counts after no step the server takes: '
                            'an expect, a report, an advance or a close comes first')

    if not any('counted' in step for step in steps):
        problems.append(f'exits: {entry["name"]!r} counts nothing')

# a debug filter keeps, and a source's event names, fixtures the file has
fixtures = {'call': len(documents['debug-filters']['calls']), 'envelope': len(documents['debug-filters']['envelopes'])}

for entry in named['filters']:
    for listener, kept in entry.get('keeps', {}).items():
        if any(index >= fixtures[listener[:-1]] for index in kept):
            problems.append(f'filters: {entry["name"]!r} keeps a fixture of its {listener} the file does not have')

for entry in named['sources']:
    if any(step['event'] >= fixtures[entry['listener']] for step in entry['steps'] if 'event' in step):
        problems.append(f'sources: {entry["name"]!r} names a fixture of its {entry["listener"]}s the file does not have')

# ── The spec's sections and the groups of vectors name each other ───────────────────────────────

with open(os.path.join(SPEC, 'spec.md'), encoding='utf-8') as file:
    text = file.read()

cited = set()

for line in re.findall(r'^_Vectors:.*$', text, re.MULTILINE):
    found = re.fullmatch(r'_Vectors: (.*)\._', line)

    if found is None:
        problems.append(f'spec.md: {line!r} is no citation of groups: "_Vectors: `a`, `b`._" on one line')
        continue

    for part in found.group(1).split(', '):
        group = re.fullmatch(r'`(\w+)`', part)

        # "every refusal" gathers the refusal groups, each of which a section names in full
        if group is not None:
            cited.add(group.group(1))
        elif part != 'every refusal':
            problems.append(f'spec.md: "{line}" names {part!r}, no group')

for line in re.findall(r'^_(?:Conversations|Transports|Durations):.*$', text, re.MULTILINE):
    found = re.fullmatch(r'_(?:Conversations|Transports|Durations): `spec/(\S+)\.json`\._', line)

    if found is None or found.group(1) not in documents:
        problems.append(f'spec.md: {line!r} names no file of spec/')

for group in sorted(cited - set(groups)):
    problems.append(f'spec.md names the group {group}, which vectors.json does not hold')

for group in sorted(set(groups) - cited):
    problems.append(f'vectors.json holds the group {group}, which no section of spec.md names')

# the companion names each of its files by a line of its own, as spec.md names its conversations
with open(os.path.join(SPEC, 'debugging.md'), encoding='utf-8') as file:
    companion = file.read()

companion_named = set()

for line in re.findall(r'^_(?:Debug filters|Metrics):.*$', companion, re.MULTILINE):
    found = re.fullmatch(r'_(Debug filters|Metrics): `spec/(\S+)\.json`\._', line)

    if found is None or COMPANION.get(found.group(2)) != found.group(1):
        problems.append(f'debugging.md: {line!r} names no file of the companion\'s in spec/')
    else:
        companion_named.add(found.group(2))

for name in sorted(set(COMPANION) - companion_named):
    problems.append(f'{name}.json is named by no "_{COMPANION[name]}:" line of debugging.md')

# ── The units each entry cites, and those none cites ────────────────────────────────────────────


def units_of(spec):
    """The units of spec.md in their order: each clause, each item of its numbered list, and each row
    of its table, counted from 1; a heading ends a clause, and a block of code holds none."""
    units = []
    clause = None
    items = rows = 0
    under_header = False
    in_code = False

    for line in spec.splitlines():
        if line.startswith('```'):
            in_code = not in_code
        elif in_code:
            continue
        elif line.startswith('#'):
            clause = None
        elif found := re.match(r'(\d+)\.(\d+)\. ', line):
            clause = f'{found.group(1)}.{found.group(2)}'
            units.append(clause)
            items = rows = 0
            under_header = False
        elif clause is None:
            continue
        elif re.match(r'\d+\. ', line):
            items += 1
            units.append(f'{clause}.{items}')
        elif re.match(r'\|[\s|:-]+\|\s*$', line):
            under_header = True
        elif line.startswith('|') and under_header:
            rows += 1
            units.append(f'{clause}.{rows}')

    return units


# each document's units, which the files that belong to it cite
units = {'spec': units_of(text), 'debugging': units_of(companion)}
citing = {'spec': set(), 'debugging': set()}

# the clock cases cite none: they hold the test clocks to one meaning of advance, which the spec does
# not state; the companion's groups cite its units, and every other group the spec's
for group, entries in named.items():
    document = 'debugging' if group in COMPANION_GROUPS else 'spec'

    for entry in entries if group != 'clocks' else ():
        for unit in entry['clauses']:
            if unit not in units[document]:
                problems.append(f'{group}: {entry["name"]!r} cites {unit}, which {document}.md does not have')

            citing[document].add(unit)

for place in places:
    for unit in place['clauses']:
        if unit not in units['spec']:
            problems.append(f'durations: {place["id"]} cites {unit}, which spec.md does not have')

        citing['spec'].add(unit)

uncited = {document: [unit for unit in units[document] if unit not in citing[document]] for document in units}

for document, (path, header) in UNCITED.items():
    listing = os.path.basename(path)

    if WRITE_UNCITED:
        with open(path, 'w', encoding='utf-8', newline='\n') as file:
            file.write(header + ''.join(f'{unit}\n' for unit in uncited[document]))
    elif not os.path.exists(path):
        problems.append(f'{listing} is missing: python spec/check.py --write-uncited writes it')
    else:
        with open(path, encoding='utf-8') as file:
            listed = [line.strip() for line in file if line.strip() and not line.startswith('#')]

        for unit in sorted(set(uncited[document]) - set(listed), key=units[document].index):
            problems.append(f'{document}.md {unit}: no entry cites it, and {listing} does not list it')

        for unit in sorted(set(listed) - set(uncited[document])):
            problems.append(f'{listing} lists {unit}, which ' +
                            ('an entry cites' if unit in units[document] else f'{document}.md does not have'))

# ── The expositions read as 0.0.4, under the companion's families and bounds ────────────────────


def table_of(document, clause):
    """The rows of the first table under a clause of a document, each a list of its cells."""
    lines = document.splitlines()
    start = next(index for index, line in enumerate(lines) if line.startswith(f'{clause}. '))
    rows, seen_rule = [], False

    for line in lines[start + 1:]:
        if re.match(r'\d+\.\d+\. |#', line):
            break
        if re.match(r'\|[\s|:-]+\|\s*$', line):
            seen_rule = True
        elif line.startswith('|') and seen_rule:
            rows.append([cell.strip() for cell in line.strip()[1:-1].split(' | ')])
        elif seen_rule and not line.startswith('|'):
            break

    return rows


def canonical(microseconds):
    """OpenMetrics' canonical number for a bound in microseconds, as seconds: Go's %g of the float's
    shortest digits, with an exponent below 1e-4 or from 1e6, then .0 where it holds no point and no
    exponent."""
    if microseconds == 0:
        return '0.0'

    shortest = Decimal(repr(microseconds / 1_000_000)).normalize()
    _, digits, power = shortest.as_tuple()
    exponent = len(digits) + power - 1
    mantissa = ''.join(map(str, digits))

    if exponent < -4 or exponent >= 6:
        written = mantissa[0] + ('.' + mantissa[1:] if len(mantissa) > 1 else '') + \
            f'e{"-" if exponent < 0 else "+"}{abs(exponent):02d}'
    else:
        written = format(shortest, 'f')

    return written if '.' in written or 'e' in written else written + '.0'


# 11.3's table: each bound in microseconds and its le, three to a row, +Inf last
bounds = []

for row in table_of(companion, '11.3'):
    for bound, le in zip(row[::2], row[1::2]):
        bounds.append((int(bound.replace(',', '')) if bound else None, le.strip('`')))

for bound, le in bounds:
    if bound is not None and le != canonical(bound):
        problems.append(f'debugging.md 11.3: the bound of {bound} µs is written {le}, where OpenMetrics\' canonical '
                        f'number for it is {canonical(bound)}')

rising = [bound for bound, _ in bounds[:-1]]

if len(bounds) != 42 or bounds[-1] != (None, '+Inf') or None in rising or rising != sorted(set(rising)):
    problems.append('debugging.md 11.3: its bounds are not 41 rising, then +Inf')

LE = [le for _, le in bounds]

# 8.1's table: each family, its type, its unit, its labels and its help
families = {row[0].strip('`'): (row[1], [label.strip('`') for label in row[3].split(', ')], row[4])
            for row in table_of(companion, '8.1')}
LABEL_ORDER = ['service', 'procedure', 'type', 'outcome', 'code', 'le']
SAMPLE = re.compile(r'([a-z_]+)\{((?:[a-z]+="(?:[^"\\\n]|\\[\\"n])*",?)*)\} (\S+)')
PAIR = re.compile(r'([a-z]+)="((?:[^"\\\n]|\\[\\"n])*)"')
COUNT = re.compile(r'0|[1-9][0-9]*')
SUM = re.compile(r'(0|[1-9][0-9]*)(\.[0-9]{0,5}[1-9])?')


def sample_of(line, where):
    """A sample's family, its name, its labels, in their order, and its value, or None once told."""
    found = SAMPLE.fullmatch(line)

    if found is None:
        problems.append(f'{where}: {line!r} is no sample of 0.0.4, name{{labels}} value')
        return None

    name, labels, value = found.groups()
    pairs = PAIR.findall(labels)
    family = next((family for family in families if name == family or (families[family][0] == 'histogram' and name in (
        f'{family}_bucket', f'{family}_sum', f'{family}_count'))), None)

    if family is None:
        problems.append(f'{where}: {line!r} is of no family of debugging.md 8.1')
        return None

    keys = [key for key, _ in pairs]
    allowed = families[family][1] + (['le'] if name.endswith('_bucket') else [])

    if keys != [key for key in LABEL_ORDER if key in keys] or not set(keys) <= set(allowed) \
            or not {'service', 'procedure'} <= set(keys) or (name.endswith('_bucket') and 'le' not in keys):
        problems.append(f'{where}: {line!r} holds its labels out of 12.4\'s order, or labels its family has not')
    elif name.endswith('_bucket') and dict(pairs)['le'] not in LE:
        problems.append(f'{where}: {line!r} has a le none of debugging.md 11.3\'s constants')
    elif not (SUM if name.endswith('_sum') else COUNT).fullmatch(value):
        problems.append(f'{where}: {line!r} writes its value as 12.5 does not')

    return family, name, dict(pairs), value


def check_exposition(lines, where):
    """An exposition read as 0.0.4: its families in the order of their names, each one group under the
    companion's help and type, and holding a series; each histogram's buckets rising to +Inf under the
    companion's bounds, then its _sum and its _count, the sum of its handled counts; no started count
    below handled."""
    written, index = [], 0
    histograms, handled, started = {}, {}, {}

    while index < len(lines):
        found = re.fullmatch(r'# HELP (\S+) (.*)', lines[index])

        if found is None or index + 1 >= len(lines) or lines[index + 1] != f'# TYPE {found.group(1)} ' \
                f'{families.get(found.group(1), ("?",))[0]}' or found.group(1) not in families:
            problems.append(f'{where}: line {index + 1} opens no family of debugging.md 8.1 with its # HELP and its # TYPE')
            return

        family = found.group(1)
        written.append(family)

        if found.group(2) != families[family][2]:
            problems.append(f'{where}: {family}\'s help is not debugging.md 8.1\'s')

        index += 2

        # a family that holds no series is not written (12.2)
        if index >= len(lines) or lines[index].startswith('#'):
            problems.append(f'{where}: {family} is written with no series')

        while index < len(lines) and not lines[index].startswith('#'):
            sample = sample_of(lines[index], where)
            index += 1

            if sample is None or sample[0] != family:
                if sample is not None:
                    problems.append(f'{where}: {lines[index - 1]!r} is not of {family}, the family it is written in')
                continue

            _, name, labels, value = sample
            series = (family.split('_call_')[0], labels['service'], labels['procedure'], labels.get('type'))

            if name.endswith('_bucket'):
                histograms.setdefault(series, {'le': [], 'buckets': []})
                histograms[series]['le'].append(labels['le'])
                histograms[series]['buckets'].append(int(value))
            elif name.endswith('_count'):
                histograms.setdefault(series, {'le': [], 'buckets': []})['count'] = int(value)
            elif family.endswith('_call_handled_total'):
                handled[series] = handled.get(series, 0) + int(value)
            elif family.endswith('_call_started_total'):
                started[series] = int(value)

    if written != sorted(set(written)):
        problems.append(f'{where}: its families are not each one group, in the order of their names')

    for series, histogram in histograms.items():
        if histogram['le'] != LE or histogram['buckets'] != sorted(histogram['buckets']) \
                or histogram.get('count') != histogram['buckets'][-1]:
            problems.append(f'{where}: {series[0]}\'s {series[1:]} has not its 42 buckets rising to +Inf, its _count '
                            'their last')
        elif histogram['count'] != handled.get(series):
            problems.append(f'{where}: {series[0]}\'s {series[1:]} counts {histogram["count"]} in its _count, and '
                            f'{handled.get(series)} handled')

    for series, count in started.items():
        if count < handled.get(series, 0):
            problems.append(f'{where}: {series[0]}\'s {series[1:]} started {count}, below the {handled[series]} it handled')


for entry in named['expositions']:
    check_exposition(entry['exposition'], f'expositions: {entry["name"]!r}')

for entry in named['exits']:
    for number, step in enumerate(entry['steps'], 1):
        for line in step.get('counted', ()):
            sample_of(line, f'exits: {entry["name"]!r}, step {number}')

# ── The published test keys stay in spec/ and the tests ─────────────────────────────────────────


def thumbprint(jwk):
    """A JWK's thumbprint (RFC 7638): SHA-256 over its required members, in their order, no space."""
    required = ('crv', 'kty', 'x', 'y') if jwk['kty'] == 'EC' else ('k', 'kty')
    canonical = json.dumps({name: jwk[name] for name in required}, separators=(',', ':')).encode('ascii')
    return base64.urlsafe_b64encode(hashlib.sha256(canonical).digest()).rstrip(b'=').decode('ascii')


needles = {name: {**{member: jwk[member] for member in ('k', 'd', 'x', 'y') if member in jwk}, 'thumbprint': thumbprint(jwk)}
           for name, jwk in TEST_KEYS.items()}
tracked = [path for path in subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True,
                                           check=True).stdout.decode('utf-8').split('\0') if path]
used = set()

for path in tracked:
    if not os.path.isfile(os.path.join(ROOT, path)):
        continue

    with open(os.path.join(ROOT, path), 'rb') as file:
        content = file.read()

    for name, members in needles.items():
        for member, value in members.items():
            if value.encode('ascii') not in content:
                continue

            if path in KEYS_USED:
                used.add(name)
            elif not TESTS.match(path):
                problems.append(f'{path}: names {name}, a published test key, by its {member}: only spec/, the tests and the '
                                'interop service name one')

for name in sorted(set(TEST_KEYS) - used):
    problems.append(f'neither {" nor ".join(KEYS_USED)} uses {name}: the test keys\' gate would match nothing of it')

# ── What each implementation's tests read ───────────────────────────────────────────────────────

read = {}

for side, (folder, suffix, group_pattern, file_pattern) in SIDES.items():
    sources = ''

    for directory, children, names in os.walk(os.path.join(ROOT, folder)):
        children[:] = [child for child in children if child not in ('bin', 'obj', 'node_modules')]

        for name in sorted(names):
            if name.endswith(suffix):
                with open(os.path.join(directory, name), encoding='utf-8') as file:
                    sources += file.read() + '\n'

    if not sources:
        problems.append(f'{side}: no test file ending in {suffix} under {folder}')

    read[side] = set(re.findall(group_pattern, sources))

    # a file read whole reads each of its groups
    for whole, its_groups in WHOLE.items():
        if re.search(file_pattern.format(whole), sources):
            read[side] |= set(its_groups)

    for group in sorted(read[side] - set(named)):
        problems.append(f'{side}: its tests read a group, {group}, which vectors.json does not hold')

    unread = set(named) - read[side]

    for whole, its_groups in WHOLE.items():
        if set(its_groups) <= unread:
            problems.append(f'{side}: its tests read no {whole}')
            unread -= set(its_groups)

    for group in sorted(unread):
        problems.append(f'{side}: its tests read no {group}')

    # the durations, read by one helper alone and played by one harness, which names every place
    harness, helper = DURATIONS_HARNESSES[side]
    pattern = file_pattern.format('durations')
    # the language's own files: '.test.ts' is a TypeScript file, '.cs' a C# one, never a project's
    language = '.' + suffix.rsplit('.', 1)[-1]

    for directory, children, names in os.walk(os.path.join(ROOT, folder)):
        children[:] = [child for child in children if child not in ('bin', 'obj', 'node_modules')]

        for name in sorted(names):
            path = os.path.relpath(os.path.join(directory, name), ROOT).replace(os.sep, '/')

            if name.endswith(language) and path != helper:
                with open(os.path.join(directory, name), encoding='utf-8') as file:
                    if re.search(pattern, file.read()):
                        problems.append(f'{side}: {path} reads durations.json, which its helper, {helper}, alone '
                                        'reads')

    if not os.path.isfile(os.path.join(ROOT, helper)):
        problems.append(f'{side}: its tests read no durations: {helper}, the helper that reads them, is missing')
    else:
        with open(os.path.join(ROOT, helper), encoding='utf-8') as file:
            if not re.search(pattern, file.read()):
                problems.append(f'{side}: {helper} does not read durations.json')

    if not os.path.isfile(os.path.join(ROOT, harness)):
        problems.append(f'{side}: its tests play no durations: {harness}, the harness, is missing')
    else:
        with open(os.path.join(ROOT, harness), encoding='utf-8') as file:
            played = file.read()

        for place in places:
            if f"'{place['id']}'" not in played and f'"{place["id"]}"' not in played:
                problems.append(f'{side}: its harness, {harness}, plays no {place["id"]}')

if problems:
    report_and_exit()

print(f'spec: {version}, its companion {companion_version}; {len(documents)} files, each under its schema; '
      f'{sum(len(vectors[group]) for group in groups)} vectors in {len(groups)} groups, each named by '
      f'the spec; {len(named["conversations"])} conversations; {len(named["transports"])} transports\' '
      f'cases; {len(named["clocks"])} clock cases; {len(places)} places of durations, by '
      f'{sum(len(place["ways"]) for place in places)} ways, each with an outcome for each of {len(inputs)} inputs; '
      f'{len(named["filters"])} debug filters and {len(named["sources"])} given as functions; '
      f'{len(named["expositions"])} expositions and {len(named["exits"])} exits, each read as 0.0.4; '
      f'{len(units["spec"]) - len(uncited["spec"])} of the spec\'s {len(units["spec"])} units cited, the others '
      f'listed in uncited.txt; {len(units["debugging"]) - len(uncited["debugging"])} of the companion\'s '
      f'{len(units["debugging"])}, the others in debugging-uncited.txt; {len(TEST_KEYS)} published test keys, '
      f'which none of the {len(tracked)} files git lists names outside spec/, the tests and the interop service.')

width = max(len(f'{group} ({len(entries)})') for group, entries in named.items())

for group, entries in named.items():
    print(f'  {f"{group} ({len(entries)})":<{width}}  read by {", ".join(SIDES)}')

print(f'  {f"durations ({len(places)})":<{width}}  played by {", ".join(SIDES)}, each in its harness')
