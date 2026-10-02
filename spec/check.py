"""Checks the conformance files beside the spec, past what regenerating them proves, and reports
which of them each implementation's tests read.

  python spec/check.py

Every spec/*.json has its schema in spec/schemas/, and every schema its file; each file follows its
schema, which follows JSON Schema 2020-12, and holds no key twice (RFC 7493); each repeats the
version spec/spec.md states as its specVersion; no group holds two vectors or conversations of one
name, which a reader looking one up by name would never reach; each group of vectors.json is named
by a section of the spec, which names no other; and each implementation's tests read every group,
and the conversations. Exit 1 on any of them.

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
      f'the spec; {len(named["conversations"])} conversations.')

width = max(len(f'{group} ({len(entries)})') for group, entries in named.items())

for group, entries in named.items():
    print(f'  {f"{group} ({len(entries)})":<{width}}  read by {", ".join(SIDES)}')
