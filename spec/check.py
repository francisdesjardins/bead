"""Checks the conformance files beside the spec, past what regenerating them proves, and reports
which of them each implementation's tests read.

  python spec/check.py

Every spec/*.json has its schema in spec/schemas/, and every schema its file; each file follows its
schema, which follows JSON Schema 2020-12, and holds no key twice (RFC 7493); each repeats the
version spec/spec.md states as its specVersion; no group holds two vectors or conversations of one
name, which a reader looking one up by name would never reach; each group of vectors.json is named
by a section of the spec, which names no other; every unit an entry cites is one of spec.md's — a
clause, an item of its numbered list, a row of its table — and spec/uncited.txt lists exactly the
units no entry cites; and each implementation's tests read every group, and the conversations. Exit
1 on any of them.

  python spec/check.py --write-uncited

writes spec/uncited.txt from the files as they stand, for a change that cites or leaves a unit.

It needs jsonschema, locked in spec/requirements.txt.
"""
import json
import os
import re
import sys

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from generators.spec_version import spec_version

SPEC = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SPEC)
SCHEMAS = os.path.join(SPEC, 'schemas')

# the schema the others take their definitions from, which describes no file of its own
COMMON = 'common'

# what vectors.json holds beside its groups
META = {'$schema', '$comment', 'specVersion'}

# the units of spec.md no entry cites, which only a change to the files or the spec moves
UNCITED = os.path.join(SPEC, 'uncited.txt')
UNCITED_HEADER = ('# The units of spec/spec.md that no vector, conversation or case cites, in their order.\n'
                  '# spec/check.py fails when this list and the files disagree; --write-uncited writes it.\n')
WRITE_UNCITED = '--write-uncited' in sys.argv[1:]

# where each implementation's tests are, the files among them, and how they name a group of vectors
# and the conversations: a language that joins adds its row
SIDES = {
    'TypeScript': ('implementations/typescript/src', '.test.ts',
                   r'\bVECTORS\.(\w+)', r"'[^']*\bconversations\.json'"),
    'C#': ('implementations/dotnet/tests', '.cs',
           r'\bVectors\.(?:NamesOf|Of)\("(\w+)"', r'"conversations\.json"'),
}

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

for name, document in documents.items():
    if document['specVersion'] != version:
        problems.append(f'{name}.json: specVersion {document["specVersion"]}, where spec.md states {version}')

vectors = documents['vectors']
groups = [group for group in vectors if group not in META]
named = {group: vectors[group] for group in groups}
named['conversations'] = documents['conversations']['conversations']

for group, entries in named.items():
    seen = set()

    for entry in entries:
        if entry['name'] in seen:
            problems.append(f'{group}: two entries named {entry["name"]!r}')
        seen.add(entry['name'])

# a conversation that opens its connections names one, opened already, on every other step; one that
# opens none plays the one connection opened before its first step, and names none
for conversation in named['conversations']:
    steps = conversation['steps']
    opened = set()

    for number, step in enumerate(steps, 1):
        if 'open' in step:
            opened.add(step['open'])
        elif any('open' in other for other in steps) and step.get('on') not in opened:
            problems.append(f'conversations: {conversation["name"]!r}, step {number}, names no connection opened '
                            f'before it: {step.get("on")!r}')
        elif not any('open' in other for other in steps) and 'on' in step:
            problems.append(f'conversations: {conversation["name"]!r}, step {number}, names a connection, '
                            'where the conversation opens none')

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

for line in re.findall(r'^_Conversations:.*$', text, re.MULTILINE):
    found = re.fullmatch(r'_Conversations: `spec/(\S+)\.json`\._', line)

    if found is None or found.group(1) not in documents:
        problems.append(f'spec.md: {line!r} names no conversation file of spec/')

for group in sorted(cited - set(groups)):
    problems.append(f'spec.md names the group {group}, which vectors.json does not hold')

for group in sorted(set(groups) - cited):
    problems.append(f'vectors.json holds the group {group}, which no section of spec.md names')

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


units = units_of(text)
known = set(units)
citing = set()

for group, entries in named.items():
    for entry in entries:
        for unit in entry['clauses']:
            if unit not in known:
                problems.append(f'{group}: {entry["name"]!r} cites {unit}, which spec.md does not have')

            citing.add(unit)

uncited = [unit for unit in units if unit not in citing]

if WRITE_UNCITED:
    with open(UNCITED, 'w', encoding='utf-8', newline='\n') as file:
        file.write(UNCITED_HEADER + ''.join(f'{unit}\n' for unit in uncited))
elif not os.path.exists(UNCITED):
    problems.append('uncited.txt is missing: python spec/check.py --write-uncited writes it')
else:
    with open(UNCITED, encoding='utf-8') as file:
        listed = [line.strip() for line in file if line.strip() and not line.startswith('#')]

    for unit in sorted(set(uncited) - set(listed), key=units.index):
        problems.append(f'{unit}: no entry cites it, and uncited.txt does not list it')

    for unit in sorted(set(listed) - set(uncited)):
        problems.append(f'uncited.txt lists {unit}, which ' +
                        ('an entry cites' if unit in known else 'spec.md does not have'))

# ── What each implementation's tests read ───────────────────────────────────────────────────────

read = {}

for side, (folder, suffix, group_pattern, conversations_pattern) in SIDES.items():
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

    if re.search(conversations_pattern, sources):
        read[side].add('conversations')

    for group in sorted(read[side] - set(named)):
        problems.append(f'{side}: its tests read a group, {group}, which vectors.json does not hold')

    for group in sorted(set(named) - read[side]):
        problems.append(f'{side}: its tests read no {group}')

if problems:
    report_and_exit()

print(f'spec: {version}; {len(documents)} files, each under its schema; '
      f'{sum(len(vectors[group]) for group in groups)} vectors in {len(groups)} groups, each named by '
      f'the spec; {len(named["conversations"])} conversations; {len(units) - len(uncited)} of the '
      f'spec\'s {len(units)} units cited, the others listed in uncited.txt.')

width = max(len(f'{group} ({len(entries)})') for group, entries in named.items())

for group, entries in named.items():
    print(f'  {f"{group} ({len(entries)})":<{width}}  read by {", ".join(SIDES)}')
