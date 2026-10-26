"""Checks the conformance files beside the spec and its companion, past what regenerating them proves,
and reports which of them each implementation's tests read.

  python spec/check.py

Every spec/*.json has its schema in spec/schemas/, and every schema its file; each file follows its
schema, which follows JSON Schema 2020-12, and holds no key twice (RFC 7493); each repeats the
version of the document it belongs to, spec/spec.md's as its specVersion, spec/debugging.md's, the
companion's, as its debuggingVersion, or spec/transcoding.md's, the transcoding's, as its
transcodingVersion; no group holds two entries of one name, which a reader looking one up by name
would never reach; each group of vectors.json is named by a section of the spec, which names no
other, and each of a companion's files by a line of its own; every unit an entry cites is one of its
document's — a clause, an item of its numbered list, a row of its table — and spec/units.txt,
spec/debugging-units.txt and spec/transcoding-units.txt list every unit of each, its front matter and each
section's lead among them, cited or the reason none cites it, each reason held by its rule, with the
sha256 of its text, which moves only where --write-units names the unit; an advance follows a timer
armed, and in the transports' cases ends on its due at the latest; a debug filter keeps fixtures the
file has; an exit counts after a step its server takes;
each exposition the metrics pin reads as 0.0.4, its families in the order of their names under the
companion's help and type, its buckets rising under the companion's bounds, each le OpenMetrics'
canonical number for its bound, each _count the sum of its handled counts, none started below
handled; each implementation's tests read every group, the conversations, the transports' cases,
a case of which may name the row of docs/support.md it crosses, the clock cases, the debug filters, the
metrics, the codecs' payloads and values, the identities' names, ids, folds and procedure kinds, the
validations' verdicts and details, and the transcoding's groups,
an entry of either naming, where it crosses a row of docs/support.md, a row that names the file and
the entry; the encodings section 17 states are the codecs' schema's, each played, and spec.md or
transcoding.md names each .proto of spec/, and no other; the durations name each place by one id and each input by one
name, give every place an outcome for every input in their order, cite at each place only what it
observes, and name, where they cross a row of docs/support.md, a row that names the file and them;
each implementation plays them in one harness, which names every place, through one helper, which
alone reads the file; and no file git lists outside spec/, the tests and the interop service names a
published test key; each blueprint of spec/ is in its form, RFC 8785's member order and string escapes,
integers alone, laid out two spaces with a final newline; and interop-service.json states the
interop blueprint's procedures, by name and in their order, what each admits where its admission is not
none and what it notifies where it notifies, and each code it names a failure of the blueprint's
catalogue that its procedure lists; and every count the tables of files of docs/support.md and the
README state is what the files it counts hold, protobuf's conformance suite's tests the floor of its
runner, and no other number stands in a row of either, a unit cited and a code span aside.
Exit 1 on any of them.

  python spec/check.py --write-units [unit…]

writes spec/units.txt, spec/debugging-units.txt and spec/transcoding-units.txt: a unit the document
gained, with the status ?, which its author replaces; a unit renumbered, under its new key; no unit
the document lost; and the hash of each unit it names, 15.7 for spec.md's, debugging:4.2 for the
companion's, transcoding:5.2 for the transcoding's, and of no other,
printing what plays each. A unit whose text moved and that it does not name still fails.

  python spec/check.py --write-blueprints

writes each blueprint of spec/ in its form from its value, and nothing else.

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
from generators.transcoding_version import transcoding_version

SPEC = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SPEC)
SCHEMAS = os.path.join(SPEC, 'schemas')

# the schemas the others take their definitions from, which describe no file of their own: what the
# conformance files share, and the builder's blueprint, which the interop's takes whole (0022)
SHARED = {'common', 'bead-blueprint'}

# the blueprints of spec/, each held to its form (0022)
BLUEPRINTS = ('interop-blueprint',)
WRITE_BLUEPRINTS = '--write-blueprints' in sys.argv[1:]

# what vectors.json holds beside its groups
META = {'$schema', '$comment', 'specVersion'}

# each document's ledger: every unit in its order, cited or why no entry cites it, and the sha256 of its
# text, which moves only as --write-units names the unit: the suspect link of requirements traceability
# (DO-178C §5.5 and §6.5, ISO 26262-8 clauses 6 and 8), a unit's text moved leaving every entry or test
# that plays it to be looked at again (0004)
LEDGERS = {
    'spec': (os.path.join(SPEC, 'units.txt'), 'spec/spec.md', ''),
    'debugging': (os.path.join(SPEC, 'debugging-units.txt'), 'spec/debugging.md', 'debugging:'),
    'transcoding': (os.path.join(SPEC, 'transcoding-units.txt'), 'spec/transcoding.md', 'transcoding:'),
}


def ledger_header(document):
    path, named, prefix = LEDGERS[document]
    return (f'# The units of {named}, in their order: each cited, or why no entry cites it, and the sha256 of\n'
            '# its text after its number, white space folded. spec/check.py fails when a unit\'s text or\n'
            f'# citation moved; --write-units {prefix}<unit>… acknowledges the units it names, and no other.\n'
            '# The reasons: lead, defines, twins, builder, open and owed, each held as spec/check.py says;\n'
            '# a new unit\'s ? until its author gives it one.\n')


# the units --write-units acknowledges, by their document: 15.7 is spec.md's, debugging:4.2 the
# companion's, transcoding:5.2 the transcoding's; None when it is not given, an empty set when it
# names none
WRITE_UNITS = None

if '--write-units' in sys.argv[1:]:
    WRITE_UNITS = {document: set() for document in LEDGERS}

    for argument in sys.argv[sys.argv.index('--write-units') + 1:]:
        if argument.startswith('--'):
            break

        document, _, unit = argument.rpartition(':')
        WRITE_UNITS.setdefault(document or 'spec', set()).add(unit)

# why no entry cites a unit, each held by a rule below: it leads its items or rows; it defines what the
# others use; each side's twin tests name it; beadc's tests name it; it is an open point; or nothing
# holds it yet, which the summary prints
REASONS = ('lead', 'defines', 'twins', 'builder', 'open', 'owed')

# the key words of BCP 14 (RFC 2119, RFC 8174), which bind only in capitals: a unit led or defining
# carries none, since it would state a requirement no entry plays
KEY_WORDS = re.compile(r'\b(?:MUST|SHALL|SHOULD|MAY|REQUIRED|RECOMMENDED|OPTIONAL)\b')

# how a test names a unit it holds, by its own number: spec 15.10, debugging 4.2 for the companion's,
# or transcoding 5.2 for the transcoding's; "spec 12.2, 12.6" names both. Never by its clause's
# number, and never by §, which the matrix keeps for an RFC's sections
UNIT_NUMBER = r'\d+(?:\.\d+)+(?!\.?\d)'
NAMING = re.compile(rf'\b(spec|debugging|transcoding) ({UNIT_NUMBER}(?:(?:,| and) {UNIT_NUMBER})*)')

# where a test names a unit: the line that declares it or its group — a call of test, it or describe
# on the TypeScript side and beadc's, a [Fact], a [Theory] or a public class, Task or void on the C#
# side — the title a call opened on the line before, or a comment just above, its attributes between
DECLARATION = re.compile(r'\b(?:test|it|describe)(?:\.\w+)*\(|^\s*\[(?:Fact|Theory)\b|^\s*public\b.*\b(?:class|Task|void)\b')
OPENED = re.compile(r'\b(?:test|it|describe)(?:\.\w+)*\(\s*$')
COMMENT = re.compile(r'\s*(?://|/\*|\*)')
ATTRIBUTE = re.compile(r'\s*\[')

# beadc's tests, which hold what of the spec the builder alone does
BUILDER_TESTS = ('builder/src', '.test.ts')

# the transcoding's groups (0037), each by its file's name before it, since vectors.json holds a group
# of failures of its own
TRANSCODING_GROUPS = tuple(f'transcoding/{group}' for group in ('templates', 'readings', 'writings', 'bindings',
                                                                 'failures', 'events', 'exchanges'))

# the files of entries each side's tests read whole, beside the groups of vectors, and their groups
WHOLE = {
    'conversations': ('conversations',),
    'transports': ('transports',),
    'clocks': ('clocks',),
    'debug-filters': ('filters', 'sources'),
    'metrics': ('expositions', 'exits'),
    'codecs': ('payloads', 'values'),
    'identities': ('names', 'ids', 'folds', 'procedureKinds'),
    'validations': ('verdicts', 'details'),
    'transcoding': TRANSCODING_GROUPS,
}

# the companion's files, which repeat its version and cite its units, each named by a line of it, and
# the groups that cite them (0013)
COMPANION = {'debug-filters': 'Debug filters', 'metrics': 'Metrics'}
COMPANION_GROUPS = ('filters', 'sources', 'expositions', 'exits')

# the transcoding's file, which repeats its version and cites its units, named by a line of it (0037)
TRANSCODING = {'transcoding': 'Transcoding'}

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

for name in sorted(schema_names - files - SHARED):
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
transcoding = transcoding_version()

# each file repeats the version of the document it belongs to, and each companion's files its own
for name, document in documents.items():
    key, stated, by = (('debuggingVersion', companion_version, 'debugging.md') if name in COMPANION
                       else ('transcodingVersion', transcoding, 'transcoding.md') if name in TRANSCODING
                       else ('specVersion', version, 'spec.md'))

    if key not in document:
        problems.append(f'{name}.json: no {key}, the version of {by}, which it belongs to')
    elif document[key] != stated:
        problems.append(f'{name}.json: {key} {document[key]}, where {by} states {stated}')


def fraction(number):
    raise ValueError(f'the number {number} has a fraction or an exponent, which a blueprint never writes')


def surrogates(value, place=''):
    # every place of a value whose string, a member's name or its value, holds a surrogate alone
    if isinstance(value, dict):
        for key, member in value.items():
            yield from surrogates(key, place)
            yield from surrogates(member, f'{place}/{key}' if place else key)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from surrogates(item, f'{place}/{index}' if place else str(index))
    elif isinstance(value, str) and any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        yield place or '(root)'


def arrays(blueprint):
    # each array the form sorts, by its place, with the key that sorts it: files by path, messages by
    # full name, services by id, procedures by id, failures by code, a procedure's failures in their
    # codes' order, ranges ascending, names in their code points' order
    names = lambda name: name
    ranges = lambda span: (span['first'], span['last'])
    yield 'requires', blueprint['requires'], names
    if 'proto' in blueprint:
        yield 'proto/files', blueprint['proto']['files'], lambda file: file['path']
        yield 'proto/messages', blueprint['proto']['messages'], lambda message: message['fullName']
    yield 'reservedServices/ids', blueprint['reservedServices']['ids'], ranges
    yield 'reservedServices/names', blueprint['reservedServices']['names'], names
    yield 'services', blueprint['services'], lambda service: service['serviceId']
    for index, service in enumerate(blueprint['services']):
        codes = {failure['failureName']: failure['code'] for failure in service['failures']}
        place = f'services/{index}'
        yield f'{place}/failures', service['failures'], lambda failure: failure['code']
        yield f'{place}/reserved/procedureIds', service['reserved']['procedureIds'], ranges
        yield f'{place}/reserved/procedureNames', service['reserved']['procedureNames'], names
        yield f'{place}/reserved/failureCodes', service['reserved']['failureCodes'], ranges
        yield f'{place}/procedures', service['procedures'], lambda procedure: procedure['procedureId']
        for at, procedure in enumerate(service['procedures']):
            # a name its catalogue lacks is beadc check's; here it sorts last, by its name
            yield (f'{place}/procedures/{at}/failures', procedure['failures'],
                   lambda name, codes=codes: (codes.get(name, 65536), name))


def sort(blueprint):
    for _, array, key in arrays(blueprint):
        array.sort(key=key)


# a blueprint is written in its form, which writing its value again gives: RFC 8785's member order and
# string escapes, integers alone, its arrays in their order, two spaces, a final newline. Its names are
# ASCII, where Python's order of code points is UTF-16's
for name in BLUEPRINTS:
    path = os.path.join(SPEC, f'{name}.json')

    with open(path, encoding='utf-8', newline='') as file:
        written = file.read()

    try:
        json.loads(written, parse_float=fraction)
    except ValueError as error:
        problems.append(f'{name}.json: {error}')
        continue

    # ! I-JSON (RFC 7493 §2.1), which RFC 8785 takes as its input, admits no surrogate alone, and UTF-8
    # cannot write one: the form is never written for such a file
    alone = list(surrogates(documents[name]))

    for place in alone:
        problems.append(f'{name}.json at {place}: a surrogate alone, which I-JSON forbids (RFC 7493 §2.1)')

    if alone:
        continue

    unsorted = [place for place, array, key in arrays(documents[name]) if array != sorted(array, key=key)]

    if not WRITE_BLUEPRINTS:
        for place in unsorted:
            problems.append(f'{name}.json at {place}: out of its order; --write-blueprints sorts it')

    # the form from a sorted copy: what follows reads the value as the file holds it
    value = json.loads(json.dumps(documents[name]))
    sort(value)
    form = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n'

    if WRITE_BLUEPRINTS and written != form:
        # ! encoded whole first, then written beside the file and moved over it: a failure never
        # shortens the author's file
        data = form.encode('utf-8')
        temporary = f'{path}.tmp'
        with open(temporary, 'wb') as file:
            file.write(data)
        os.replace(temporary, path)
        documents[name] = value
    elif written != form and not unsorted:
        lines = zip(written.split('\n'), form.split('\n'))
        line = next((number for number, (one, other) in enumerate(lines, 1) if one != other), None)
        where = 'its last line ends with no newline' if line is None else f'line {line} is off its form'
        problems.append(f'{name}.json: {where}; --write-blueprints writes it in its form')

# the interop service's prose is its blueprint's procedures, by name and in their order: what each
# admits where its admission is not none, and what it notifies where its kind is notifies
api = documents['interop-blueprint']['services'][0]['procedures']
prose = documents['interop-service']['procedures']

if [entry['procedureName'] for entry in prose] != [entry['procedureName'] for entry in api]:
    problems.append('interop-service.json: its procedures are not interop-blueprint.json\'s, by name and in '
                    'their order')

for entry, declared in zip(prose, api):
    if ('admits' in entry) != (declared['admission'] != 'none'):
        problems.append(f'interop-service.json: {entry["procedureName"]!r} states what it admits where its '
                        f'admission is none, or does not where it is not')

    if ('notifies' in entry) != (declared['procedureKind'] == 'notifies'):
        problems.append(f'interop-service.json: {entry["procedureName"]!r} states what it notifies where '
                        f'its kind is not notifies, or does not where it is')

# each code the interop service's prose names is a failure of its blueprint's catalogue, which the
# conversations' generator takes by its name: one its procedure lists, where a procedure names it
catalogue = {failure['code']: failure['failureName'] for failure in documents['interop-blueprint']['services'][0]['failures']}


def prose_of(value):
    """Every string of a value, its members' and its items' among them."""
    if isinstance(value, dict):
        return [text for member in value.values() for text in prose_of(member)]

    if isinstance(value, list):
        return [text for item in value for text in prose_of(item)]

    return [value] if isinstance(value, str) else []


for entry, declared in zip(prose, api):
    for code in re.findall(r'\bcode (\d+)', ' '.join(prose_of(entry))):
        if catalogue.get(int(code)) not in declared['failures']:
            problems.append(f'interop-service.json: {entry["procedureName"]!r} names code {code}, which is no failure '
                            f'of interop-blueprint.json\'s catalogue that {entry["procedureName"]} lists')

for code in re.findall(r'\bcode (\d+)', ' '.join(prose_of({key: value for key, value in documents['interop-service'].items()
                                                         if key not in ('procedures', '$comment')}))):
    if int(code) not in catalogue:
        problems.append(f'interop-service.json names code {code}, which is no failure of interop-blueprint.json\'s '
                        'catalogue')

# the rejection both sides' tests read of the ELSEWHERE verifier is the error its words settle with
elsewhere = documents['interop-service']['credentials'].get('elsewhere', {})
rejection = documents['interop-service']['verifiers']['elsewhere']['rejection']

if f'its error "{rejection}"' not in elsewhere.get('settles', ''):
    problems.append(f'interop-service.json: verifiers.elsewhere rejects with {rejection!r}, which is not the error '
                    'credentials.elsewhere.settles states')

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
# the codecs' payloads and values, reads being a group of vectors.json already; the identities' groups
named['payloads'] = documents['codecs']['payloads']
named['values'] = documents['codecs']['values']
named['names'] = documents['identities']['names']
named['ids'] = documents['identities']['ids']
named['folds'] = documents['identities']['folds']
named['procedureKinds'] = documents['identities']['procedureKinds']
# the validations' verdicts and details (0035)
named['verdicts'] = documents['validations']['verdicts']
named['details'] = documents['validations']['details']
# the transcoding's groups (0037)
for group in TRANSCODING_GROUPS:
    named[group] = documents['transcoding'][group.split('/')[1]]

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

# the codecs' and the identities' entries name their file beside themselves, as the durations' inputs do
for whole in ('codecs', 'identities'):
    for group in WHOLE[whole]:
        for entry in named[group]:
            check_crossing(f'{whole}: {group}, {entry["name"]!r},', entry.get('differs', []), f'spec/{whole}.json',
                           entry['name'])

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

for line in re.findall(r'^_(?:Conversations|Transports|Durations|Identities|Codecs|Validations):.*$', text, re.MULTILINE):
    found = re.fullmatch(r'_(?:Conversations|Transports|Durations|Identities|Codecs|Validations): `spec/(\S+)\.json`\._', line)

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

# the transcoding names its file by a line of its own, as the companion names each of its own
with open(os.path.join(SPEC, 'transcoding.md'), encoding='utf-8') as file:
    transcoding_text = file.read()

transcoding_named = set()

for line in re.findall(r'^_Transcoding:.*$', transcoding_text, re.MULTILINE):
    found = re.fullmatch(r'_(Transcoding): `spec/(\S+)\.json`\._', line)

    if found is None or TRANSCODING.get(found.group(2)) != found.group(1):
        problems.append(f'transcoding.md: {line!r} names no file of the transcoding' + "'" + 's in spec/')
    else:
        transcoding_named.add(found.group(2))

for name in sorted(set(TRANSCODING) - transcoding_named):
    problems.append(f'{name}.json is named by no "_{TRANSCODING[name]}:" line of transcoding.md')

# a .proto of spec/ holds the messages a file of entries reads, which the spec or the transcoding names,
# between backticks, as each names its files; and neither names one that spec/ does not hold
protos = {name for name in os.listdir(SPEC) if name.endswith('.proto')}
protos_named = {name for document_text in (text, transcoding_text)
                for name in re.findall(r'`spec/([\w-]+\.proto)`', document_text)}

for name in sorted(protos - protos_named):
    problems.append(f'spec/{name} is named by no line of spec.md or transcoding.md')

for name in sorted(protos_named - protos):
    problems.append(f'spec.md or transcoding.md names spec/{name}, which spec/ does not hold')

# the encodings section 17 states, each a clause of its own, "17.n. `name`:", are those the codecs'
# schema holds, and the codecs' entries play each of them
stated = re.findall(r'^17\.\d+\. `(\w+)`:', text, re.MULTILINE)
schema_encodings = schemas['codecs']['$defs']['encoding']['enum']
played = {entry['encoding'] for group in WHOLE['codecs'] for entry in named[group]}

if sorted(stated) != sorted(schema_encodings):
    problems.append(f'spec.md section 17 states the encodings {", ".join(stated)}, where the codecs\' schema holds '
                    f'{", ".join(schema_encodings)}')

for encoding in sorted(set(schema_encodings) - played):
    problems.append(f'codecs: no entry plays the encoding {encoding}')

# ── The units of each document, what plays each, and its ledger ──────────────────────────────────


def units_of(document):
    """The units of a document in their order, each with its text: unit 0, its front matter, every
    line before its first section; N.0, a section's lead, its heading and its lines outside every
    clause, the line naming its file among them, which a clause numbered N.0 takes into its own; each
    clause, N.M; each item of a clause's numbered list, N.M.K, and each row of its table, counted from
    1. A clause holds its paragraphs, its table's header and its blocks of code, an item its line and
    the lines indented under it, a row its line. A unit's text is its lines after its own number, a
    table's rule left out, since its width follows its widest cell, with white space folded."""
    units = {}
    clause = item = None
    items = rows = 0
    under_header = in_code = False

    def unit(key, kind):
        units[key] = {'kind': kind, 'lines': [], 'children': [], 'follows': False}
        return key

    lead = code_owner = unit('0', 'front')

    def clause_line(line):
        # a line of a clause's own text after its items or rows began is a sentence that follows them
        if units[clause]['children'] and line.strip():
            units[clause]['follows'] = True

        units[clause]['lines'].append(line)

    for line in document.splitlines():
        if line.startswith('```'):
            if not in_code:
                item = None
                code_owner = clause or lead

                if clause is not None and units[clause]['children']:
                    units[clause]['follows'] = True

            units[code_owner]['lines'].append(line)
            in_code = not in_code
        elif in_code:
            units[code_owner]['lines'].append(line)
        elif found := re.match(r'## (\d+)\. ', line):
            lead = unit(f'{found.group(1)}.0', 'lead')
            clause = item = None
            units[lead]['lines'].append('## ' + line[found.end():])
        elif line.startswith('#'):
            # the title, or a heading within a section, which its lead holds
            clause = item = None
            units[lead]['lines'].append(line)
        elif found := re.match(r'(\d+)\.(\d+)\. ', line):
            clause = f'{found.group(1)}.{found.group(2)}'

            if clause == lead:
                units[clause]['kind'] = 'clause'
            else:
                unit(clause, 'clause')

            item = None
            items = rows = 0
            under_header = False
            units[clause]['lines'].append(line[found.end():])
        elif clause is None:
            units[lead]['lines'].append(line)
        elif found := re.match(r'(\d+)\. ', line):
            items += 1
            item = unit(f'{clause}.{items}', 'item')
            units[clause]['children'].append(item)
            units[item]['lines'].append(line[found.end():])
        elif re.match(r'\|[\s|:-]+\|\s*$', line):
            under_header = True
            item = None
        elif line.startswith('|') and under_header:
            rows += 1
            row = unit(f'{clause}.{rows}', 'row')
            units[clause]['children'].append(row)
            units[row]['lines'].append(line)
            item = None
        elif item is not None and (line.startswith(' ') or not line.strip()):
            units[item]['lines'].append(line)
        else:
            item = None
            clause_line(line)

    for each in units.values():
        each['text'] = ' '.join(' '.join(each['lines']).split())

    return units


# each document's units, which the files that belong to it cite: a clause, an item or a row, never a
# front matter or a lead
units = {'spec': units_of(text), 'debugging': units_of(companion), 'transcoding': units_of(transcoding_text)}
citeable = {document: {key for key, each in found.items() if each['kind'] in ('clause', 'item', 'row')}
            for document, found in units.items()}
# what cites each unit, by its group and its name, or a place of durations by its id
citing = {document: {} for document in LEDGERS}

# the clock cases cite none: they hold the test clocks to one meaning of advance, which the spec does
# not state; each companion's groups cite its units, and every other group the spec's; a transcoding
# entry cites the spec's behind spec:, the core's step a gateway's client plays (0037)
for group, entries in named.items():
    own = ('debugging' if group in COMPANION_GROUPS else 'transcoding' if group in TRANSCODING_GROUPS
           else 'spec')

    for entry in entries if group != 'clocks' else ():
        for cited_unit in entry['clauses']:
            document, _, unit = cited_unit.rpartition(':')
            document = document or own

            if unit not in citeable.get(document, ()):
                problems.append(f'{group}: {entry["name"]!r} cites {cited_unit}, which {document}.md does not have')

            citing.setdefault(document, {}).setdefault(unit, []).append(f'{group} {entry["name"]!r}')

# a place cites the spec's units, and a gateway's the transcoding's behind transcoding: (0037)
for place in places:
    for cited_unit in place['clauses']:
        document, _, unit = cited_unit.rpartition(':')
        document = document or 'spec'

        if unit not in citeable.get(document, ()):
            problems.append(f'durations: {place["id"]} cites {cited_unit}, which {document}.md does not have')

        citing.setdefault(document, {}).setdefault(unit, []).append(f'durations {place["id"]}')


def digest(key, text):
    """The sha256 of a unit's text: the front matter's with its version's number folded out, which
    tools/check-versions.mjs holds and every release moves."""
    if key == '0':
        text = re.sub(r'\*\*Version: [^*]+\*\*', '**Version: x.y.z**', text)

    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def key_words(key, text):
    """The BCP 14 key words a unit's text carries; the front matter's own sentence that names them is
    exempt by its place."""
    if key == '0':
        text = re.sub(r'The key words .*?\.(?= |$)', '', text, count=1)

    return sorted(set(KEY_WORDS.findall(text)))


def beside_a_declaration(lines, index):
    """Whether a line is a test's declaration, its title, or a comment beside one: on the line that
    declares a test or a group of them, on the title a call opened on the line before, or on the
    comments just above a declaration, its attributes between them."""
    if DECLARATION.search(lines[index]):
        return True

    if index > 0 and OPENED.search(lines[index - 1]):
        return True

    if not COMMENT.match(lines[index]):
        return False

    below = index + 1

    while below < len(lines) and (COMMENT.match(lines[below]) or ATTRIBUTE.match(lines[below])):
        below += 1

    return below < len(lines) and DECLARATION.search(lines[below]) is not None


def tests_naming(folder, suffix):
    """Where each unit is named by the tests under a folder, spec 15.10 or debugging 4.2, by its
    document and its number, in a test's title or a comment beside its declaration: each place a file
    and a line."""
    found = {}

    for directory, children, names in os.walk(os.path.join(ROOT, folder)):
        children[:] = [child for child in children if child not in ('bin', 'obj', 'node_modules')]

        for name in sorted(names):
            if not name.endswith(suffix):
                continue

            path = os.path.relpath(os.path.join(directory, name), ROOT).replace(os.sep, '/')

            with open(os.path.join(directory, name), encoding='utf-8') as file:
                lines = file.read().splitlines()

            for index, line in enumerate(lines):
                for match in NAMING.finditer(line):
                    if not beside_a_declaration(lines, index):
                        continue

                    for unit in re.findall(UNIT_NUMBER, match.group(2)):
                        found.setdefault((match.group(1), unit), []).append(f'{path}:{index + 1}')

    return found


# the tests of each side, and beadc's, by the units they name
naming = {side: tests_naming(folder, suffix) for side, (folder, suffix, *_) in SIDES.items()}
naming['beadc'] = tests_naming(*BUILDER_TESTS)


def plays(document, key, status):
    """What plays a unit, which a change of its text leaves to be looked at again."""
    if status == 'cited':
        return 'cited by ' + ', '.join(citing[document].get(key, []))

    if status == 'lead':
        children = units[document][key]['children']
        return (f'leading {", ".join(children)}, cited by ' +
                ', '.join(dict.fromkeys(label for child in children for label in citing[document].get(child, []))))

    if status == 'defines' and key == '0':
        return 'defining what every entry plays'

    if status == 'defines':
        section = key.split('.')[0]
        return (f'defining what section {section} states, cited by ' +
                ', '.join(dict.fromkeys(label for unit, labels in citing[document].items()
                                        if unit.split('.')[0] == section for label in labels)))

    if status in ('twins', 'builder'):
        sides = SIDES if status == 'twins' else ('beadc',)
        return 'named by ' + ', '.join(place for side in sides for place in naming[side].get((document, key), []))

    return f'nothing plays it: it is {status}'


def ledger_of(path, listing):
    """A ledger's units, each with its status and its hash."""
    kept = {}

    if not os.path.exists(path):
        return kept

    with open(path, encoding='utf-8') as file:
        for number, line in enumerate(file, 1):
            if not line.strip() or line.startswith('#'):
                continue

            parts = line.split()

            if len(parts) != 3 or not re.fullmatch(r'[0-9a-f]{64}', parts[2]):
                problems.append(f'{listing}, line {number}: {line.strip()!r} is no unit, its status and its hash')
            elif parts[0] in kept:
                problems.append(f'{listing} lists {parts[0]} twice')
            else:
                kept[parts[0]] = (parts[1], parts[2])

    return kept


owed = {document: [] for document in LEDGERS}
reasoned = {document: {} for document in LEDGERS}

for document in sorted(set(WRITE_UNITS or ()) - set(LEDGERS)):
    problems.append(f'--write-units names {", ".join(sorted(WRITE_UNITS[document]))} of {document}, which is no '
                    'document: debugging:4.2 is the companion\'s, 15.7 the spec\'s')

for document, (path, _, prefix) in LEDGERS.items():
    listing = os.path.basename(path)
    found = units[document]
    hashes = {key: digest(key, each['text']) for key, each in found.items()}
    kept = ledger_of(path, listing)

    # a unit renumbered: its text kept under a key whose own text it no longer is, which the ledger
    # follows to the new key alone, the number never being hashed
    stale = {}

    for key, (_, hashed) in kept.items():
        if hashes.get(key) != hashed:
            stale.setdefault(hashed, []).append(key)

    moved = [key for key in found if kept.get(key, (None, None))[1] != hashes[key]]
    # ! a text two units hold alike names neither: one key is followed only to one other
    renumbered = {key: stale[hashes[key]][0] for key in moved if len(stale.get(hashes[key], [])) == 1
                  and sum(hashes[other] == hashes[key] for other in moved) == 1}
    followed = set(renumbered.values())

    if WRITE_UNITS is not None:
        acknowledged = WRITE_UNITS.get(document, set())

        for key in sorted(acknowledged - set(found)):
            problems.append(f'--write-units names {prefix}{key}, which {document}.md does not have')

        written = {}

        for key in found:
            if key in kept and kept[key][1] == hashes[key]:
                written[key] = kept[key]
            elif key in renumbered:
                written[key] = (kept[renumbered[key]][0], hashes[key])
                print(f'{document}.md {renumbered[key]} is now {key}')
            elif key in kept and key not in followed:
                status = kept[key][0]
                written[key] = (status, hashes[key] if key in acknowledged else kept[key][1])

                if key in acknowledged:
                    print(f'{document}.md {key}: its text acknowledged, {plays(document, key, status)}')
            else:
                written[key] = ('?', hashes[key])
                print(f'{document}.md {key}: a unit {listing} did not list, ? until its author gives its status')

        for key in kept:
            if key not in found and key not in followed:
                print(f'{document}.md {key}: gone, and dropped from {listing}')

        with open(path, 'w', encoding='utf-8', newline='\n') as file:
            file.write(ledger_header(document) + ''.join(f'{key} {status} {hashed}\n'
                                                         for key, (status, hashed) in written.items()))

        kept, renumbered, followed = written, {}, set()

    if not kept:
        problems.append(f'{listing} is missing: python spec/check.py --write-units writes it')
        continue

    for key, each in found.items():
        if key in renumbered and key not in kept:
            problems.append(f'{document}.md {key}: {listing} keeps its text under {renumbered[key]}; --write-units '
                            'follows it to its new number')
            continue

        if key not in kept:
            problems.append(f'{document}.md {key}: {listing} does not list it; --write-units writes it, ? for its '
                            'status')
            continue

        status, hashed = kept[key]
        cited = key in citing[document]

        if status == '?':
            problems.append(f'{document}.md {key}: a new unit, ? in {listing}: cited, or a reason of '
                            f'{", ".join(REASONS)}')
        elif status == 'cited' and not cited:
            problems.append(f'{document}.md {key}: {listing} says an entry cites it, and none does: give the reason '
                            'none does')
        elif status != 'cited' and status not in REASONS:
            problems.append(f'{listing}: {key} is {status}, which is no status: cited, or a reason of '
                            f'{", ".join(REASONS)}')
        elif status != 'cited' and cited:
            problems.append(f'{document}.md {key}: an entry cites it, and {listing} gives it the reason {status}: '
                            'its status is cited')
        elif status != 'cited':
            reasoned[document][key] = status
            words = key_words(key, each['text'])

            if status == 'owed':
                owed[document].append(key)

            if status in ('lead', 'defines') and words:
                problems.append(f'{document}.md {key}: {status}, and it carries {", ".join(words)}, which a unit '
                                'that states no requirement of its own never does: cited, twins or owed')

            if status == 'lead' and not each['children']:
                problems.append(f'{document}.md {key}: lead, and it has no item or row to lead')

            if status == 'lead' and each['follows']:
                problems.append(f'{document}.md {key}: lead, and a sentence follows its last item or row, which none '
                                'of them holds: cited, twins or owed')

            for child in each['children'] if status == 'lead' else ():
                if child not in citing[document] and kept.get(child, ('?',))[0] not in REASONS[:-1]:
                    problems.append(f'{document}.md {key}: lead, and its {child} is neither cited nor held by a '
                                    'reason other than owed')

            sides = SIDES if status == 'twins' else ('beadc',) if status == 'builder' else ()

            for side in sides:
                if (document, key) not in naming[side]:
                    folder = SIDES[side][0] if side in SIDES else BUILDER_TESTS[0]
                    problems.append(f'{document}.md {key}: {status}, and no test of {side} names it: '
                                    f'"{document} {key}" in a test\'s title, or in a comment just above its '
                                    f'declaration, under {folder}')

            if status == 'open':
                state = re.search(r'\*\*Status: (.*?)\*\*', found['0']['text'])

                if state is None or not re.search(rf'(?<![\d.]){re.escape(key)}(?!\.?\d)', state.group(1)):
                    problems.append(f'{document}.md {key}: open, and the status line of {document}.md does not name '
                                    'it')

        if hashed != hashes[key] and key in renumbered:
            problems.append(f'{document}.md {key}: its text is the one {listing} keeps under {renumbered[key]}; '
                            '--write-units follows it to its new number')
        elif hashed != hashes[key] and key in followed:
            problems.append(f'{document}.md {key}: a unit {listing} does not list, the text it keeps under {key} '
                            'having moved to another number; --write-units follows that one, and writes this one ?')
        elif hashed != hashes[key]:
            problems.append(f'{document}.md {key}: its text moved since {listing} was written; '
                            f'{plays(document, key, status)}; --write-units {prefix}{key} acknowledges it')

    for key in kept:
        if key not in found and key not in followed:
            problems.append(f'{listing} lists {key}, which {document}.md does not have; --write-units drops it')

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

# ── The counts the tables of files state ────────────────────────────────────────────────────────

# a count written by hand is held to the files it counts: docs/support.md's table of files and the
# README's, where a change that adds entries moves its totals (0004), each row by what it states
README = os.path.join(ROOT, 'README.md')
TABLES = (('docs/support.md', SUPPORT, '### The conformance files'),
          ('README.md', README, '## The specification and its conformance files'))
COLUMNS = ('File', 'What it holds', *SIDES)

# protobuf's conformance suite counts its own tests: its row is held to the floor of its runner, which
# tools/protobuf-conformance.mjs holds each side to, and states the suite's other counts as its own
SUITE = "protobuf's conformance suite"
RUNNER = os.path.join(ROOT, 'tools', 'protobuf-conformance', 'runner.json')

# a count is written in digits, a thousand set apart by a comma, or in a word
NUMBER_WORDS = ('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
                'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty')
NUMBER = rf'\b(\d{{1,3}}(?:,\d{{3}})+|\d+|{"|".join(NUMBER_WORDS)})\b'

# what a row cites, which counts nothing: a code span, a link's target, a unit of the spec or the companion
CITED = re.compile(r'`[^`]*`|\]\([^)]*\)|§\s*[\d.]+(?:[–-][\d.]+)?|\b(?:spec|debugging) \d+(?:\.\d+)+')

# the transports a case is played over, each by the name a row gives it
TRANSPORT_NAMES = {'http': 'HTTP', 'websocket': 'WebSocket'}


def number_of(written):
    return NUMBER_WORDS.index(written) + 1 if written in NUMBER_WORDS else int(written.replace(',', ''))


def written_as(count, written):
    """A count written as the row writes the one it replaces: a word for a word, a comma for a comma."""
    if written in NUMBER_WORDS and 0 < count <= len(NUMBER_WORDS):
        return NUMBER_WORDS[count - 1]

    return f'{count:,}' if ',' in written else str(count)


def table_of_files(path, heading):
    """The rows of the first table under a heading, each by the file its first cell names, and its cells."""
    with open(path, encoding='utf-8') as file:
        lines = file.read().splitlines()

    if heading not in lines:
        problems.append(f'{os.path.relpath(path, ROOT)} has no heading {heading!r}, above its table of files')
        return {}

    table = {}

    for line in lines[lines.index(heading) + 1:]:
        if line.startswith('#') or (table and not line.startswith('|')):
            break

        if not line.startswith('| ') or set(line) <= set('|- '):
            continue

        cells = [cell.strip() for cell in line.split('|')[1:-1]]
        target = re.search(r'\]\((spec/[^)]+)\)', cells[0])
        table[target.group(1) if target else cells[0].strip('`')] = cells

    table.pop('File', None)
    return table


counted = 0


def hold(place, cells, holds):
    """Holds each count a row states to the count of its files, and gives back its cells with those counts
    blanked out, for what is left to name no other."""
    global counted
    left = [list(cell) for cell in cells]

    for column, pattern, count, what in holds:
        where = place + (f', its column {COLUMNS[column]}' if column > 1 else '')
        found = re.search(pattern.replace('{n}', NUMBER), cells[column])

        if found is None:
            problems.append(f'{where}: states no count of {what}, which its files hold at {count}')
            continue

        counted += 1
        start, end = found.span(1)
        left[column][start:end] = ' ' * (end - start)

        if number_of(found.group(1)) != count:
            phrase = found.group(0)
            fixed = (phrase[:start - found.start()] + written_as(count, found.group(1))
                     + phrase[end - found.start():])
            problems.append(f'{where}: "{phrase}" should read "{fixed}", the count of {what}')

    return [''.join(cell) for cell in left]


transport_counts = {}

for case in named['transports']:
    transport_counts[case['transport']] = transport_counts.get(case['transport'], 0) + 1

for transport in sorted(set(transport_counts) - set(TRANSPORT_NAMES)):
    problems.append(f'transports: cases over {transport}, which TRANSPORT_NAMES does not name, so no row counts them')

# the entries of codecs.json a side does not play, each excused by a row of docs/support.md
unplayed = {side: sum(any(crossed['language'] == side for crossed in entry.get('differs', []))
                      for group in WHOLE['codecs'] for entry in named[group])
            for side in SIDES}

vectors_total = sum(len(vectors[group]) for group in groups)
ways_total = sum(len(place['ways']) for place in places)


# the transcoding's groups, each counted by its name where a row states it (0037)
TRANSCODING_COUNTS = [(1, rf'(?:^|\b){{n}} {group.split("/")[1]}\b', len(named[group]), f'the transcoding\'s {group.split("/")[1]}')
                      for group in TRANSCODING_GROUPS]


def played_by_each(count):
    """The cells that say each side plays every entry of a file, by its count."""
    return [(column, r'^all {n}\b', count, f'entries the {side} side plays') for column, side in enumerate(SIDES, 2)]


COUNTS = {
    'docs/support.md': {
        'spec/vectors.json': [
            (1, r'^{n} vectors in', vectors_total, 'vectors'),
            (1, r'\bin {n} groups', len(groups), 'groups of vectors'),
            # each group by its name, its words apart and in any case: jwtVerdicts, JWT verdicts
            *[(1, rf'(?i:\b{re.escape(re.sub(r"(?<=[a-z])(?=[A-Z])", " ", group))}) {{n}}(?:,|$)',
               len(vectors[group]), f'the vectors of {group}') for group in groups],
        ],
        'spec/conversations.json': [
            (1, r'^{n} conversations', len(named['conversations']), 'conversations'),
            *played_by_each(len(named['conversations'])),
        ],
        'spec/transports.json': [
            (1, r'^{n} cases', len(named['transports']), "transports' cases"),
            *[(1, rf'\b{{n}} over {name}\b', transport_counts.get(transport, 0), f'cases over {name}')
              for transport, name in TRANSPORT_NAMES.items()],
            (1, r'\b{n} of them on the real clock', sum(bool(case.get('realTime')) for case in named['transports']),
             'cases marked realTime'),
            (1, r'\b{n} on the clock the server is given, advanced',
             sum(any('advance' in step for step in case['steps']) for case in named['transports']),
             'cases that advance the clock the server is given'),
            (1, r'\b{n} responses cut across reads', len(responses), 'responses cut across reads'),
            *played_by_each(len(named['transports'])),
        ],
        'spec/clocks.json': [
            (1, r'^{n} clock cases', len(named['clocks']), 'clock cases'),
            *played_by_each(len(named['clocks'])),
        ],
        'spec/durations.json': [
            (1, r'^{n} places', len(places), 'places of durations'),
            (1, r'\bby {n} ways', ways_total, "the places' ways"),
            (1, r'\beach of {n} inputs', len(inputs), "the durations' inputs"),
            *played_by_each(len(places)),
        ],
        'spec/identities.json': [
            (1, r'^{n} procedure names', len(named['names']), 'names'),
            (1, r'\b{n} ids and revisions', len(named['ids']), 'ids and revisions'),
            (1, r'\b{n} procedure kinds', len(named['procedureKinds']), 'procedure kinds'),
            (1, r'\bdeclared {n} ways', len(documents['identities']['ways']), 'the ways a procedure is declared'),
            (1, r'\b{n} folds', len(named['folds']), 'folds'),
        ],
        'spec/codecs.json': [
            (1, r'^{n} payloads read', len(named['payloads']), 'payloads'),
            (1, r'\b{n} values written', len(named['values']), 'values'),
            *[(column, r'^all but {n}\b', unplayed[side], f'entries the {side} side does not play, each by its row')
              for column, side in enumerate(SIDES, 2)],
        ],
        'spec/debug-filters.json': [
            (1, r'^{n} debug filters', len(named['filters']), 'debug filters'),
            (1, r'\bof {n} calls', fixtures['call'], "the filters' calls"),
            (1, r'\b{n} envelopes it keeps', fixtures['envelope'], "the filters' envelopes"),
            (1, r'\b{n} filters given as functions', len(named['sources']), 'filters given as functions'),
            *played_by_each(len(named['filters']) + len(named['sources'])),
        ],
        'spec/metrics.json': [
            (1, r'^{n} expositions', len(named['expositions']), 'expositions'),
            (1, r'\b{n} exits', len(named['exits']), 'exits'),
            *played_by_each(len(named['expositions']) + len(named['exits'])),
        ],
        'spec/validations.json': [
            (1, r'^{n} verdicts', len(named['verdicts']), 'verdicts'),
            (1, r'\b{n} details', len(named['details']), 'details'),
            *played_by_each(len(named['verdicts']) + len(named['details'])),
        ],
        'spec/transcoding.json': [
            *TRANSCODING_COUNTS,
            *played_by_each(sum(len(named[group]) for group in TRANSCODING_GROUPS)),
        ],
    },
    'README.md': {
        'spec/vectors.json': [
            (1, r'^{n} named vectors', vectors_total, 'vectors'),
            (1, r'\bin {n} groups', len(groups), 'groups of vectors'),
        ],
        'spec/transports.json': [(1, r'^{n} cases', len(named['transports']), "transports' cases")],
        'spec/clocks.json': [(1, r'^{n} clock cases', len(named['clocks']), 'clock cases')],
        'spec/durations.json': [
            (1, r'^{n} places', len(places), 'places of durations'),
            (1, r'\bby {n} ways', ways_total, "the places' ways"),
            (1, r'\beach of {n} inputs', len(inputs), "the durations' inputs"),
        ],
        'spec/identities.json': [
            (1, r'^{n} procedure names', len(named['names']), 'names'),
            (1, r'\b{n} ids and revisions', len(named['ids']), 'ids and revisions'),
            (1, r'\b{n} procedure kinds', len(named['procedureKinds']), 'procedure kinds'),
            (1, r'\bdeclared the {n} ways', len(documents['identities']['ways']), 'the ways a procedure is declared'),
            (1, r'\b{n} pairs of names', len(named['folds']), 'folds'),
        ],
        'spec/debug-filters.json': [
            (1, r'^{n} debug filters', len(named['filters']), 'debug filters'),
            (1, r'\b{n} filters given as functions', len(named['sources']), 'filters given as functions'),
        ],
        'spec/metrics.json': [
            (1, r'^{n} expositions', len(named['expositions']), 'expositions'),
            (1, r'\b{n} exits', len(named['exits']), 'exits'),
        ],
        'spec/validations.json': [
            (1, r'^{n} verdicts', len(named['verdicts']), 'verdicts'),
            (1, r'\b{n} details', len(named['details']), 'details'),
        ],
        'spec/transcoding.json': TRANSCODING_COUNTS,
        'spec/interop-blueprint.json': [
            (1, r'\bits {n} service\b', len(documents['interop-blueprint']['services']), "the blueprint's services"),
            (1, r'\bits {n} procedures', len(api), "the blueprint's procedures"),
        ],
    },
}

floor = next((suite['tests'] for suite in load(RUNNER)['floor'] if suite['suite'] == 'binary and JSON'), None)

if floor is None:
    problems.append("tools/protobuf-conformance/runner.json: its floor has no suite 'binary and JSON', which "
                    "docs/support.md's row of the suite counts")

for document, path, heading in TABLES:
    table = table_of_files(path, heading)

    # ! a row gone from a table fails, so that no count goes unheld for want of its row, or of its table
    for row in sorted(set(COUNTS[document]) - set(table)):
        problems.append(f'{document}: its table of files has no row {row}, whose counts spec/check.py holds')

    for row, cells in table.items():
        if len(cells) < 2:
            problems.append(f'{document}, the row {row}: no cell of what it holds')
        elif row.startswith(SUITE):
            tests = (1, r'^{n} tests, binary', floor, "the suite's tests, runner.json's floor")
            hold(f'{document}, the row {row}', cells, [tests] if floor is not None else [])
        else:
            # a number a row states that no count holds is one a change would leave behind
            for column, cell in enumerate(hold(f'{document}, the row {row}', cells, COUNTS[document].get(row, []))):
                where = f'{document}, the row {row}' + (f', its column {COLUMNS[column]}' if column > 1 else '')

                for number in re.findall(r'\d[\d,]*\d|\d', CITED.sub(' ', cell)) if column else ():
                    problems.append(f'{where}: states {number}, which no count of spec/check.py holds: hold it, or '
                                    'write no count')

    if document == 'docs/support.md' and not any(row.startswith(SUITE) for row in table):
        problems.append(f"docs/support.md: its table of files has no row of {SUITE}, which runner.json's floor holds")

if problems:
    report_and_exit()


def reasons_of(document):
    """How many units of a document each reason holds, in the reasons' order."""
    return ', '.join(f'{sum(status == reason for status in reasoned[document].values())} {reason}'
                     for reason in REASONS)


print(f'spec: {version}, its companion {companion_version}, its transcoding {transcoding}; {len(documents)} files, '
      'each under its schema; '
      f'{sum(len(vectors[group]) for group in groups)} vectors in {len(groups)} groups, each named by '
      f'the spec; {len(named["conversations"])} conversations; {len(named["transports"])} transports\' '
      f'cases; {len(named["clocks"])} clock cases; {len(places)} places of durations, by '
      f'{sum(len(place["ways"]) for place in places)} ways, each with an outcome for each of {len(inputs)} inputs; '
      f'{len(named["filters"])} debug filters and {len(named["sources"])} given as functions; '
      f'{len(named["expositions"])} expositions and {len(named["exits"])} exits, each read as 0.0.4; '
      f'{len(named["payloads"])} payloads read and {len(named["values"])} values written, in '
      f'{len(stated)} encodings; {len(named["names"])} names, {len(named["ids"])} ids and revisions and '
      f'{len(named["procedureKinds"])} procedure kinds, each declared '
      f'{len(documents["identities"]["ways"])} ways, and '
      f'{len(named["folds"])} folds; {len(named["verdicts"])} verdicts and {len(named["details"])} details; '
      f'{len(units["spec"])} units of the spec, {len(citing["spec"])} cited and {reasons_of("spec")}, in '
      f'units.txt; {len(units["debugging"])} of the companion, {len(citing["debugging"])} cited and '
      f'{reasons_of("debugging")}, in debugging-units.txt; {len(units["transcoding"])} of the transcoding, '
      f'{len(citing["transcoding"])} cited and {reasons_of("transcoding")}, in transcoding-units.txt; '
      f'{", ".join(f"{len(named[group])} {group.split(chr(47))[1]}" for group in TRANSCODING_GROUPS)} of the '
      f'transcoding; {counted} counts of the tables of files of '
      f'docs/support.md and the README, each as its files hold it; {len(TEST_KEYS)} published test keys, which none of '
      f'the {len(tracked)} files git lists names outside spec/, the tests and the interop service.')

width = max(len(f'{group} ({len(entries)})') for group, entries in named.items())

for group, entries in named.items():
    print(f'  {f"{group} ({len(entries)})":<{width}}  read by {", ".join(SIDES)}')

print(f'  {f"durations ({len(places)})":<{width}}  played by {", ".join(SIDES)}, each in its harness')

# a unit nothing holds yet, each on a line of its own, so a gap is never silent
for document, keys in owed.items():
    for key in keys:
        print(f'  owed: {document}.md {key}, which no entry cites and no test names')
