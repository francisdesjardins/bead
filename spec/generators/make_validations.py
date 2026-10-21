"""Writes spec/validations.proto and spec/validations.json: the messages a procedure's rules judge, and
what each judging gives of a payload, its violations in their order, and what a detail's writer writes
of violations and its reader reads of a detail (spec section 18, decision 0035).

The proto and the verdicts come from one table of messages, so the rules the file states and those the
verdicts play never part. Each verdict is section 18 played here a third time, beside the two sides:
the generator encodes the payload from its value, as protobuf's Encoding guide writes one, and judges
the same value by protovalidate's rules as validate.proto v1.2.2 states them, in 18.5's order, its
words as 18.8.6 writes them. A pattern is matched by RE2 itself, google-re2, which spec/requirements.txt
pins; a pattern of a Unicode class is matched once that class is written as the ranges Unicode 17.0.0's
own files give it, UnicodeData.txt and Scripts.txt, each read where spec/generators/ucd.json pins it by
its sha256, so that no platform's tables and no older ones of RE2's decide it. A detail is written by
18.6's writer and read by 18.7's reader, both here, over RFC 8785's canonical form. A backslash is
chr(92), so that no escape this file builds is read before it is built."""
import base64
import hashlib
import json
import math
import os
import re
import struct
import tempfile
import urllib.request

import re2

from details import KEPT, canonical, detail_of, es, judged, utf8, violation
from spec_version import spec_version

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')
HERE = os.path.dirname(os.path.abspath(__file__))

B = chr(92)

# ── Unicode 17.0.0's classes, for 18.8.5 ────────────────────────────────────────────────────────

with open(os.path.join(HERE, 'ucd.json'), encoding='utf-8') as file:
    UCD = json.load(file)


def ucd_text(name):
    """A file of the UCD, as ucd.json pins it: read from the cache it was fetched to, or fetched once
    and held there, its sha256 checked before a line of it is read."""
    pinned = next(entry for entry in UCD['files'] if entry['name'] == name)
    cache = os.path.join(tempfile.gettempdir(), 'bead-ucd', UCD['version'])
    path = os.path.join(cache, name)

    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)

        with urllib.request.urlopen(pinned['url'], timeout=60) as response:
            data = response.read()

        if hashlib.sha256(data).hexdigest() != pinned['sha256']:
            raise SystemExit(f'{pinned["url"]}: its sha256 is not the one spec/generators/ucd.json pins')

        with open(path + '.part', 'wb') as file:
            file.write(data)

        os.replace(path + '.part', path)

    with open(path, 'rb') as file:
        data = file.read()

    if hashlib.sha256(data).hexdigest() != pinned['sha256']:
        raise SystemExit(f'{path}: its sha256 is not the one spec/generators/ucd.json pins; delete it to fetch it again')

    return data.decode('utf-8')


def merged(points):
    """Code points as sorted, merged ranges."""
    ranges = []

    for point in sorted(points):
        if ranges and ranges[-1][1] + 1 == point:
            ranges[-1][1] = point
        else:
            ranges.append([point, point])

    return ranges


def unicode_classes():
    """Each general category, by its one and its two letters, and each script, as the ranges of code
    points Unicode 17.0.0 gives it."""
    categories, scripts = {}, {}
    first = None

    for line in ucd_text('UnicodeData.txt').splitlines():
        fields = line.split(';')
        point, name, category = int(fields[0], 16), fields[1], fields[2]

        if name.endswith(', First>'):
            first = point
            continue

        span = range(first, point + 1) if name.endswith(', Last>') else (point,)
        first = None

        for each in span:
            categories.setdefault(category, set()).add(each)
            categories.setdefault(category[0], set()).add(each)

    for line in ucd_text('Scripts.txt').splitlines():
        found = re.match(r'([0-9A-F]+)(?:\.\.([0-9A-F]+))?\s*;\s*(\w+)', line)

        if found:
            low, high = int(found.group(1), 16), int(found.group(2) or found.group(1), 16)
            scripts.setdefault(found.group(3), set()).update(range(low, high + 1))

    return {name: merged(points) for name, points in {**categories, **scripts}.items()}


CLASSES = None
EVERY = [[0, 0xD7FF], [0xE000, 0x10FFFF]]


def complement(ranges):
    points, left = [], 0

    for low, high in ranges:
        if low > left:
            points.append([left, low - 1])
        left = high + 1

    if left <= 0x10FFFF:
        points.append([left, 0x10FFFF])

    return [span for low, high in points for span in
            ([[low, min(high, 0xD7FF)]] if low <= 0xD7FF else []) + ([[max(low, 0xE000), high]] if high >= 0xE000 else [])
            if span[0] <= span[1]]


def written_out(pattern):
    """A pattern whose Unicode classes, \\pL, \\p{Greek}, \\PL, are written as the ranges Unicode
    17.0.0 gives them, inside a class or alone, so that RE2's own tables decide nothing of it."""
    global CLASSES
    out, at, in_class = '', 0, False

    while at < len(pattern):
        character = pattern[at]

        if character == B and pattern[at + 1] in 'pP':
            negated = pattern[at + 1] == 'P'

            if pattern[at + 2] == '{':
                end = pattern.index('}', at)
                name, at = pattern[at + 3:end], end + 1
            else:
                name, at = pattern[at + 2], at + 3

            if CLASSES is None:
                CLASSES = unicode_classes()

            ranges = complement(CLASSES[name]) if negated else CLASSES[name]
            body = ''.join(B + f'x{{{low:X}}}' + ('' if low == high else '-' + B + f'x{{{high:X}}}') for low, high in ranges)
            out += body if in_class else '[' + body + ']'
            continue

        if character == B:
            out += pattern[at:at + 2]
            at += 2
            continue

        if character == '[' and not in_class:
            in_class = True
        elif character == ']' and in_class and not out.endswith('['):
            in_class = False

        out += character
        at += 1

    return out


COMPILED = {}


def matches(pattern, text):
    """RE2's unanchored search, protovalidate's matches (18.8.5), its DFA given the memory a class
    written out as its ranges asks."""
    if pattern not in COMPILED:
        options = re2.Options()
        options.max_mem = 1 << 28
        options.log_errors = False
        COMPILED[pattern] = re2.compile(written_out(pattern), options)

    return COMPILED[pattern].search(text) is not None


# ── The messages ────────────────────────────────────────────────────────────────────────────────

INTEGERS = ('int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64')
WIDE = {'int64', 'uint64', 'sint64', 'fixed64', 'sfixed64'}
FLOATS = ('float', 'double')
SCALARS = (*INTEGERS, *FLOATS, 'bool', 'string', 'bytes')

# the wrappers of google/protobuf/wrappers.proto, by the scalar each holds at 1
WRAPPERS = {'double': 'DoubleValue', 'float': 'FloatValue', 'int64': 'Int64Value', 'uint64': 'UInt64Value',
            'int32': 'Int32Value', 'uint32': 'UInt32Value', 'bool': 'BoolValue', 'string': 'StringValue',
            'bytes': 'BytesValue'}

# the rules messages of validate.proto: each member by its number, the order 18.5 judges them in. A
# range sits at its lower member's number, a bound alone at its own
NUMBER_RULES = {'const': 1, 'lt': 2, 'lte': 3, 'gt': 4, 'gte': 5, 'in': 6, 'not_in': 7, 'finite': 8, 'example': 9}
STRING_RULES = {'const': 1, 'min_len': 2, 'max_len': 3, 'min_bytes': 4, 'max_bytes': 5, 'pattern': 6, 'prefix': 7,
                'suffix': 8, 'contains': 9, 'in': 10, 'not_in': 11, 'len': 19, 'len_bytes': 20, 'not_contains': 23,
                'example': 34}
BYTES_RULES = {'const': 1, 'min_len': 2, 'max_len': 3, 'prefix': 5, 'suffix': 6, 'contains': 7, 'len': 13, 'example': 14}
ENUM_RULES = {'const': 1, 'defined_only': 2, 'in': 3, 'not_in': 4, 'example': 5}
BOOL_RULES = {'const': 1, 'example': 2}
REPEATED_RULES = {'min_items': 1, 'max_items': 2, 'unique': 3, 'items': 4}
MAP_RULES = {'min_pairs': 1, 'max_pairs': 2, 'keys': 4, 'values': 5}

# the members of a rules message that are 64-bit integers, which protobuf's JSON mapping writes as
# strings: a string's and a bytes' lengths, a repeated field's and a map's counts
COUNTS = {'len', 'min_len', 'max_len', 'len_bytes', 'min_bytes', 'max_bytes', 'min_items', 'max_items', 'min_pairs',
          'max_pairs'}


class Field:
    def __init__(self, name, number, kind, rules=None, *, label=None, key=None, implicit=False, oneof=None, note=None):
        self.name, self.number, self.kind, self.rules = name, number, kind, rules or {}
        self.label, self.key, self.implicit, self.oneof, self.note = label, key, implicit, oneof, note

    @property
    def explicit(self):
        """Whether the field has explicit presence: a message, a wrapper, a oneof's member, or a scalar
        under edition 2023's default; never a repeated field or a map (18.8.1)."""
        return self.label is None and not self.implicit


class Message:
    def __init__(self, name, note, fields, *, oneofs=(), rules=None, procedure=None):
        self.name, self.note, self.fields = name, note, fields
        self.oneofs, self.rules, self.procedure = list(oneofs), rules or {}, procedure


def f32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


INNER = Message('Inner', 'A message the others hold: its name, one character at least.', [
    Field('name', 1, 'string', {'string': {'min_len': 1}}, implicit=True),
])

PAIR = Message('Pair', 'A message whose own rule allows one of two fields, judged after its fields.', [
    Field('label', 1, 'string', {'string': {'min_len': 1}}, implicit=True),
    Field('left', 2, 'string'),
    Field('right', 3, 'string'),
], rules={'oneof': [{'fields': ['left', 'right']}]})

COLOUR = ('Colour', 'A colour, by its number, the enum the rules on an enum judge.',
          [('COLOUR_UNSPECIFIED', 0), ('COLOUR_RED', 1), ('COLOUR_GREEN', 2)])
COLOURS = {number for _, number in COLOUR[2]}

INF, NAN = math.inf, math.nan

MESSAGES = [
    Message('Numbers', 'The ten integer types and bool: each bound alone, each range, a range given reversed, const, in and not_in.', [
        Field('at_most_ten', 1, 'int32', {'int32': {'lte': 10}}),
        Field('below_ten', 2, 'int32', {'int32': {'lt': 10}}),
        Field('above_zero', 3, 'int32', {'int32': {'gt': 0}}),
        Field('at_least_one', 4, 'int32', {'int32': {'gte': 1}}),
        Field('between', 5, 'int32', {'int32': {'gt': 0, 'lt': 10}}),
        Field('outside', 6, 'int32', {'int32': {'gt': 10, 'lt': 5}}),
        Field('within', 7, 'int32', {'int32': {'gte': 0, 'lte': 10}}),
        Field('exactly', 8, 'int32', {'int32': {'const': 3}}),
        Field('listed', 9, 'int32', {'int32': {'in': [1, 2, 3]}}),
        Field('unlisted', 10, 'int32', {'int32': {'not_in': [0, 13]}}),
        Field('wide', 11, 'int64', {'int64': {'lt': -9007199254740993}}),
        Field('unsigned_wide', 12, 'uint64', {'uint64': {'in': [1, 2, 18446744073709551615]}}),
        Field('unsigned', 13, 'uint32', {'uint32': {'gte': 1, 'lt': 4294967295}}),
        Field('zigzag', 14, 'sint32', {'sint32': {'gt': -1}}),
        Field('zigzag_wide', 15, 'sint64', {'sint64': {'gte': -5, 'lte': 5}}),
        Field('fixed', 16, 'fixed32', {'fixed32': {'lte': 100}}),
        Field('fixed_wide', 17, 'fixed64', {'fixed64': {'gt': 9007199254740992}}),
        Field('signed_fixed', 18, 'sfixed32', {'sfixed32': {'gte': 10, 'lt': 0}}),
        Field('signed_fixed_wide', 19, 'sfixed64', {'sfixed64': {'gt': 10, 'lte': 0}}),
        Field('above_to', 20, 'int64', {'int64': {'gt': 0, 'lte': 100}}),
        Field('outside_wide', 21, 'uint64', {'uint64': {'gte': 10, 'lte': 5}}),
        Field('truth', 22, 'bool', {'bool': {'const': True}}),
        Field('sampled', 23, 'int32', {'int32': {'gt': 0, 'example': [5]}}),
        Field('ranged_listed', 24, 'int32', {'int32': {'gt': 0, 'in': [5, 7]}}),
    ], procedure=1),
    Message('Floats', 'A float and a double: a float at its bound, NaN and the infinities, -0.0, bounds not finite, a range given reversed.', [
        Field('above_tenth', 1, 'float', {'float': {'gt': 0.1}}),
        Field('unit', 2, 'double', {'double': {'gte': 0, 'lte': 1}}),
        Field('real', 3, 'double', {'double': {'finite': True}}),
        Field('listed', 4, 'double', {'double': {'in': [-INF, 1]}}),
        Field('beyond', 5, 'float', {'float': {'gt': INF}}),
        Field('exactly', 6, 'double', {'double': {'const': 0.30000000000000004}}),
        Field('outside', 7, 'double', {'double': {'gt': 1, 'lt': -1}}),
        Field('unlisted', 8, 'float', {'float': {'not_in': [0]}}),
        Field('below_large', 9, 'double', {'double': {'lt': 1e21}}),
        Field('real_float', 10, 'float', {'float': {'finite': True, 'gte': 0}}),
    ], procedure=2),
    Message('Strings', 'Each rule on a string, lengths in code points and in UTF-8 bytes, and the orders where readings part.', [
        Field('exactly', 1, 'string', {'string': {'const': 'a"b'}}),
        Field('three', 2, 'string', {'string': {'len': 3}}),
        Field('short', 3, 'string', {'string': {'min_len': 1, 'max_len': 3}}),
        Field('four_bytes', 4, 'string', {'string': {'len_bytes': 4}}),
        Field('few_bytes', 5, 'string', {'string': {'min_bytes': 2, 'max_bytes': 3}}),
        Field('lower', 6, 'string', {'string': {'pattern': '^[a-z]+$'}}),
        Field('prefixed', 7, 'string', {'string': {'prefix': 'bead:'}}),
        Field('suffixed', 8, 'string', {'string': {'suffix': '.v1'}}),
        Field('containing', 9, 'string', {'string': {'contains': '@'}}),
        Field('excluding', 10, 'string', {'string': {'not_contains': '--'}}),
        Field('listed', 11, 'string', {'string': {'in': ['a', 'b']}}),
        Field('unlisted', 12, 'string', {'string': {'not_in': ['root']}}),
        Field('lengths', 13, 'string', {'string': {'pattern': '^[a-z]+$', 'len': 4}}),
        Field('byte_lengths', 14, 'string', {'string': {'prefix': 'x', 'len_bytes': 4}}),
        Field('excluded_listed', 15, 'string', {'string': {'in': ['a--', 'b'], 'not_contains': '--'}}),
    ], procedure=3),
    Message('Bytes', 'Each rule on bytes, its words in hexadecimal, its bounds in base64.', [
        Field('exactly', 1, 'bytes', {'bytes': {'const': b'\x00\xff'}}),
        Field('four', 2, 'bytes', {'bytes': {'len': 4}}),
        Field('few', 3, 'bytes', {'bytes': {'min_len': 2, 'max_len': 3}}),
        Field('png', 4, 'bytes', {'bytes': {'prefix': b'\x89PNG'}}),
        Field('terminated', 5, 'bytes', {'bytes': {'suffix': b'\x00'}}),
        Field('marked', 6, 'bytes', {'bytes': {'contains': b'\xfe'}}),
        Field('lengths', 7, 'bytes', {'bytes': {'prefix': b'PK', 'len': 8}}),
    ], procedure=4),
    Message('Enums', 'Each rule on an enum, a number its enum does not declare among them.', [
        Field('defined', 1, 'enum:Colour', {'enum': {'defined_only': True}}),
        Field('exactly', 2, 'enum:Colour', {'enum': {'const': 2}}),
        Field('listed', 3, 'enum:Colour', {'enum': {'in': [1]}}),
        Field('unlisted', 4, 'enum:Colour', {'enum': {'not_in': [0]}}),
        Field('checked', 5, 'enum:Colour', {'enum': {'defined_only': True, 'in': [1, 2]}}),
    ], procedure=5),
    Message('Repeated', 'A repeated field\'s counts, its unique items, the rules of its items, and the messages it holds.', [
        Field('names', 1, 'string', {'repeated': {'min_items': 1, 'max_items': 3, 'items': {'string': {'min_len': 1}}}},
              label='repeated'),
        Field('distinct', 2, 'int32', {'repeated': {'unique': True}}, label='repeated'),
        Field('reals', 3, 'double', {'repeated': {'unique': True}}, label='repeated'),
        Field('words', 4, 'string', {'repeated': {'unique': True}}, label='repeated'),
        Field('inners', 5, 'message:Inner', label='repeated'),
        Field('many', 6, 'string', {'repeated': {'items': {'string': {'min_len': 1}}}}, label='repeated'),
        Field('colours', 7, 'enum:Colour', {'repeated': {'unique': True, 'items': {'enum': {'defined_only': True}}}},
              label='repeated'),
    ], procedure=6),
    Message('Maps', 'A map\'s counts, its keys\' and its values\' rules, entries judged by key, and keys of every type.', [
        Field('labels', 1, 'int32', {'map': {'min_pairs': 1, 'max_pairs': 2, 'keys': {'string': {'min_len': 2}},
                                             'values': {'int32': {'gte': 0}}}}, label='map', key='string'),
        Field('by_id', 2, 'message:Inner', label='map', key='int32'),
        Field('flags', 3, 'string', {'map': {'values': {'string': {'min_len': 1}}}}, label='map', key='bool'),
        Field('by_text', 4, 'string', {'map': {'values': {'string': {'min_len': 1}}}}, label='map', key='string'),
        Field('by_int64', 5, 'string', {'map': {'values': {'string': {'min_len': 1}}}}, label='map', key='int64'),
        Field('by_uint32', 6, 'string', {'map': {'values': {'string': {'min_len': 1}}}}, label='map', key='uint32'),
        Field('by_uint64', 7, 'string', {'map': {'values': {'string': {'min_len': 1}}}}, label='map', key='uint64'),
        Field('by_sint32', 8, 'string', {'map': {'values': {'string': {'min_len': 1}}}}, label='map', key='sint32'),
        Field('by_sint64', 9, 'string', {'map': {'values': {'string': {'min_len': 1}}}}, label='map', key='sint64'),
        Field('by_fixed32', 10, 'string', {'map': {'values': {'string': {'min_len': 1}}}}, label='map', key='fixed32'),
        Field('by_fixed64', 11, 'string', {'map': {'values': {'string': {'min_len': 1}}}}, label='map', key='fixed64'),
        Field('by_sfixed32', 12, 'string', {'map': {'values': {'string': {'min_len': 1}}}}, label='map', key='sfixed32'),
        Field('by_sfixed64', 13, 'string', {'map': {'values': {'string': {'min_len': 1}}}}, label='map', key='sfixed64'),
        Field('keyed', 14, 'int32', {'map': {'keys': {'string': {'max_len': 1}}}}, label='map', key='string'),
    ], procedure=7),
    Message('Presence', 'Explicit and implicit presence, required each way, and each ignore.', [
        Field('explicit', 1, 'string', {'string': {'min_len': 1}}),
        Field('implicit', 2, 'string', {'string': {'min_len': 1}}, implicit=True),
        Field('needed', 3, 'string', {'required': True}),
        Field('needed_implicit', 4, 'int32', {'required': True}, implicit=True),
        Field('needed_items', 5, 'string', {'required': True}, label='repeated'),
        Field('skipped_zero', 6, 'int32', {'ignore': 'IGNORE_IF_ZERO_VALUE', 'int32': {'gt': 5}}, implicit=True),
        Field('inner', 9, 'message:Inner', {'required': True}),
        Field('ignored_inner', 10, 'message:Inner', {'ignore': 'IGNORE_ALWAYS'}),
        Field('needed_pairs', 11, 'string', {'required': True}, label='map', key='string'),
        Field('some_items', 12, 'string', {'ignore': 'IGNORE_IF_ZERO_VALUE', 'repeated': {'min_items': 2}}, label='repeated'),
        Field('some_pairs', 13, 'string', {'ignore': 'IGNORE_IF_ZERO_VALUE', 'map': {'min_pairs': 2}}, label='map', key='string'),
    ], procedure=8),
    Message('Wrappers', 'Each wrapper, its scalar\'s rules judged on its value once set, required while unset.', [
        Field('count', 1, 'wrapper:int32', {'int32': {'gt': 0}}),
        Field('title', 2, 'wrapper:string', {'required': True, 'string': {'min_len': 1}}),
        Field('ratio', 3, 'wrapper:double', {'double': {'finite': True}}),
        Field('size', 4, 'wrapper:uint64', {'uint64': {'lte': 10}}),
        Field('flag', 5, 'wrapper:bool', {'bool': {'const': True}}),
        Field('blob', 6, 'wrapper:bytes', {'bytes': {'min_len': 1}}),
        Field('weight', 7, 'wrapper:float', {'float': {'gt': 0}}),
        Field('offset', 8, 'wrapper:int64', {'int64': {'gte': -9007199254740993}}),
        Field('port', 9, 'wrapper:uint32', {'uint32': {'lte': 65535}}),
    ], procedure=9),
    Message('Oneofs', 'A oneof required, a member\'s own rule, and the message\'s own oneof rules.', [
        Field('name', 1, 'string', {'string': {'min_len': 1}}, oneof='choice'),
        Field('id', 2, 'int32', {'int32': {'gt': 0}}, oneof='choice'),
        Field('x', 3, 'string', {'string': {'min_len': 3}}, implicit=True),
        Field('y', 4, 'string', implicit=True),
        Field('p', 5, 'string'),
        Field('q', 6, 'string'),
    ], oneofs=[('choice', True)], rules={'oneof': [{'fields': ['x', 'y']}, {'fields': ['p', 'q'], 'required': True}]},
        procedure=10),
    Message('Nested', 'Messages held: one, a repeated one, a map of them, and a message with its own rule, its fields before it.', [
        Field('inner', 1, 'message:Inner'),
        Field('pair', 2, 'message:Pair'),
        Field('pairs', 3, 'message:Pair', label='repeated'),
        Field('deep', 4, 'message:Nested'),
    ], procedure=11),
    Message('Order', 'Fields declared out of their numbers: judged by their numbers, the message\'s own rules after them.', [
        Field('late', 9, 'string', {'string': {'min_len': 1}}),
        Field('early', 2, 'int32', {'int32': {'gt': 5}}),
        Field('inner', 1, 'message:Inner'),
        Field('x', 3, 'string', oneof='choice'),
        Field('y', 4, 'string', oneof='choice'),
        Field('p', 5, 'string'),
        Field('q', 6, 'string'),
    ], oneofs=[('choice', True)], rules={'oneof': [{'fields': ['p', 'q'], 'required': True}]}, procedure=12),
    Message('Patterns', 'Patterns in RE2\'s syntax: what each character class takes, the anchors, case folding, the classes of Unicode 17.0.0, and inputs a backtracking engine never ends.', [
        Field('any', 1, 'string', {'string': {'pattern': '^.$'}}),
        Field('space', 2, 'string', {'string': {'pattern': '^' + B + 's$'}}),
        Field('digit', 3, 'string', {'string': {'pattern': '^' + B + 'd$'}}),
        Field('kelvin', 4, 'string', {'string': {'pattern': '(?i)^k$'}}),
        Field('ends', 5, 'string', {'string': {'pattern': '^a$'}}),
        Field('word_end', 6, 'string', {'string': {'pattern': 'a' + B + 'b'}}),
        Field('anywhere', 7, 'string', {'string': {'pattern': 'b'}}),
        Field('not_a', 8, 'string', {'string': {'pattern': '^[^a]$'}}),
        Field('nested', 9, 'string', {'string': {'pattern': '^(a+)+$'}}),
        Field('counted', 10, 'string', {'string': {'pattern': '[a-z]{1,1000}[0-9]'}}),
        Field('letter', 11, 'string', {'string': {'pattern': '^' + B + 'pL$'}}),
        Field('greek', 12, 'string', {'string': {'pattern': '^' + B + 'p{Greek}+$'}}),
        Field('person', 13, 'string', {'string': {'pattern': '^' + B + 'p{L}[' + B + 'p{L}' + B + "p{M} '-]{0,63}$"}}),
        Field('lines', 14, 'string', {'string': {'pattern': '(?m)^ok$'}}),
        Field('word', 15, 'string', {'string': {'pattern': '^' + B + 'w+$'}}),
        Field('long', 16, 'string', {'string': {'pattern': '^(?:' + '|'.join(f'code-{index:03d}' for index in range(60)) + ')$'}}),
    ], procedure=13),
]

BY_NAME = {message.name: message for message in [INNER, PAIR, *MESSAGES]}

# ── validations.proto ───────────────────────────────────────────────────────────────────────────


def text_string(value):
    """A string or bytes as protobuf's text format writes one: printable ASCII as it is, a quote and
    a backslash escaped, every other byte of its UTF-8 in octal."""
    data = value.encode('utf-8') if isinstance(value, str) else value
    out = ''

    for byte in data:
        if byte in (0x22, 0x5C):
            out += B + chr(byte)
        elif 0x20 <= byte < 0x7F:
            out += chr(byte)
        else:
            out += B + f'{byte:03o}'

    return '"' + out + '"'


def text_value(value, kind):
    if isinstance(value, bool):
        return 'true' if value else 'false'

    if isinstance(value, (str, bytes)) and kind == 'enum-name':
        return value

    if isinstance(value, (str, bytes)):
        return text_string(value)

    if isinstance(value, float):
        if math.isnan(value):
            return 'nan'
        if math.isinf(value):
            return 'inf' if value > 0 else '-inf'
        return repr(value)

    return str(value)


def text_rules(rules):
    """A rules message in protobuf's text format, its members in the order given."""
    parts = []

    for name, value in rules.items():
        if isinstance(value, dict):
            parts.append(f'{name}: {{{text_rules(value)}}}')
        elif isinstance(value, list) and value and isinstance(value[0], dict):
            parts.append(f'{name}: [{", ".join("{" + text_rules(each) + "}" for each in value)}]')
        elif isinstance(value, list):
            parts.append(f'{name}: [{", ".join(text_value(each, None) for each in value)}]')
        elif name == 'ignore':
            parts.append(f'{name}: {value}')
        else:
            parts.append(f'{name}: {text_value(value, None)}')

    return ' '.join(parts)


def proto_type(field):
    if field.kind.startswith('enum:') or field.kind.startswith('message:'):
        return field.kind.split(':')[1]

    if field.kind.startswith('wrapper:'):
        return 'google.protobuf.' + WRAPPERS[field.kind.split(':')[1]]

    return field.kind


def declaration(field, indent):
    if field.label == 'map':
        head = f'map<{field.key}, {proto_type(field)}> {field.name} = {field.number}'
    else:
        head = f'{"repeated " if field.label == "repeated" else ""}{proto_type(field)} {field.name} = {field.number}'

    options = []

    if field.implicit:
        options.append('features.field_presence = IMPLICIT')

    if field.rules:
        options.append(f'(buf.validate.field) = {{{text_rules(field.rules)}}}')

    return indent + head + (f' [{", ".join(options)}]' if options else '') + ';'


def message_text(message):
    lines = [f'// {message.note}', f'message {message.name} {{']

    if message.rules:
        lines.append(f'  option (buf.validate.message) = {{{text_rules(message.rules)}}};')

    written = set()

    for field in message.fields:
        if field.oneof is None:
            lines.append(declaration(field, '  '))
        elif field.oneof not in written:
            written.add(field.oneof)
            required = dict(message.oneofs)[field.oneof]
            lines.append(f'  oneof {field.oneof} {{')

            if required:
                lines.append('    option (buf.validate.oneof).required = true;')

            for member in message.fields:
                if member.oneof == field.oneof:
                    lines.append(declaration(member, '    '))

            lines.append('  }')

    lines.append('}')
    return '\n'.join(lines)


def proto_file():
    service = [f'  // Judges a {message.name}, and answers nothing more.\n'
               f'  rpc Judge{message.name}({message.name}) returns (Taken) {{\n'
               f'    option (bead.procedure) = {{id: {message.procedure}}};\n'
               '  }' for message in MESSAGES]
    name, note, values = COLOUR

    return '\n'.join([
        '// The messages spec/validations.json judges, their rules protovalidate\'s, written with the verdicts',
        '// by spec/generators/make_validations.py: regenerate, never edit (spec section 18, decision 0035).',
        'edition = "2023";',
        '',
        'package bead.validations.v1;',
        '',
        'import "bead/options.proto";',
        'import "buf/validate/validate.proto";',
        'import "google/protobuf/wrappers.proto";',
        '',
        'option (bead.file) = {',
        '  admission: {',
        '    none: {}',
        '  }',
        '};',
        '',
        '// Each message bound as a request, so that beadc generates each side\'s validators for it.',
        'service ValidationsService {',
        '  option (bead.service) = {',
        '    id: 1',
        '    revision: 1',
        '  };',
        '',
        '\n\n'.join(service),
        '}',
        '',
        '// What a procedure answers a request its rules take: nothing.',
        'message Taken {}',
        '',
        f'// {note}',
        f'enum {name} {{',
        *[f'  {value} = {number};' for value, number in values],
        '}',
        '',
        '\n\n'.join(message_text(message) for message in [INNER, PAIR, *MESSAGES]),
        '',
    ])


# ── The encoder, protobuf's Encoding guide ──────────────────────────────────────────────────────

VARINT, I64, LEN, I32 = 0, 1, 2, 5


def varint(value):
    value &= (1 << 64) - 1
    out = bytearray()

    while True:
        byte = value & 0x7F
        value >>= 7

        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def tag(number, wire):
    return varint(number << 3 | wire)


def scalar_bytes(kind, value):
    """A scalar's record's body, and its wire type."""
    if kind in ('int32', 'int64', 'uint32', 'uint64') or kind.startswith('enum:'):
        return varint(value), VARINT
    if kind == 'bool':
        return varint(int(value)), VARINT
    if kind == 'sint32':
        return varint((value << 1) ^ (value >> 31)), VARINT
    if kind == 'sint64':
        return varint((value << 1) ^ (value >> 63)), VARINT
    if kind == 'fixed32':
        return struct.pack('<I', value), I32
    if kind == 'sfixed32':
        return struct.pack('<i', value), I32
    if kind == 'float':
        return struct.pack('<f', value), I32
    if kind == 'fixed64':
        return struct.pack('<Q', value), I64
    if kind == 'sfixed64':
        return struct.pack('<q', value), I64
    if kind == 'double':
        return struct.pack('<d', value), I64
    if kind == 'string':
        data = value.encode('utf-8')
        return varint(len(data)) + data, LEN
    if kind == 'bytes':
        return varint(len(value)) + value, LEN
    raise ValueError(kind)


def length_delimited(data):
    return varint(len(data)) + data


def value_bytes(kind, value):
    """A single value's record body and wire type: a scalar, a message, or a wrapper."""
    if kind.startswith('message:'):
        return length_delimited(encode(BY_NAME[kind.split(':')[1]], value)), LEN

    if kind.startswith('wrapper:'):
        scalar = kind.split(':')[1]
        body = b'' if is_zero(scalar, value) else record(1, scalar, value)
        return length_delimited(body), LEN

    return scalar_bytes(kind, value)


def record(number, kind, value):
    body, wire = value_bytes(kind, value)
    return tag(number, wire) + body


def encode(message, value):
    """A message's bytes from its value, its fields by their numbers: a field absent is left out, an
    implicit one at its zero too, a repeated scalar packed as edition 2023 packs it, a map's entries
    in the order the value gives them."""
    out = b''

    for field in sorted(message.fields, key=lambda each: each.number):
        if field.name not in value:
            continue

        given = value[field.name]

        if field.label == 'repeated':
            if not given:
                continue

            if field.kind in (*INTEGERS, *FLOATS, 'bool') or field.kind.startswith('enum:'):
                out += tag(field.number, LEN) + length_delimited(b''.join(scalar_bytes(field.kind, each)[0] for each in given))
            else:
                out += b''.join(record(field.number, field.kind, each) for each in given)
        elif field.label == 'map':
            for key, item in given:
                out += tag(field.number, LEN) + length_delimited(record(1, field.key, key) + record(2, field.kind, item))
        elif field.implicit and is_zero(field.kind, given):
            continue
        else:
            out += record(field.number, field.kind, given)

    return out


# ── The judge, section 18 ───────────────────────────────────────────────────────────────────────


def is_zero(kind, value):
    if kind.startswith('message:') or kind.startswith('wrapper:'):
        return value is None

    # ! -0.0 is no zero to a presence: its sign bit is on the wire
    if isinstance(value, float) and value == 0 and math.copysign(1, value) < 0:
        return False

    return value == zero_of(kind)


def is_set(field, value):
    """Whether a field is set, as protovalidate reads it: an explicit one given, an implicit one other
    than its zero, a repeated field or a map not empty."""
    if field.name not in value:
        return False

    if field.label is not None:
        return len(value[field.name]) > 0

    return field.explicit or not is_zero(field.kind, value[field.name])


def bound_json(kind, value):
    """A rule's member as protobuf's JSON mapping writes its type (18.3)."""
    if isinstance(value, list):
        return [bound_json(kind, each) for each in value]

    if isinstance(value, bool):
        return value

    if isinstance(value, bytes):
        return base64.b64encode(value).decode('ascii')

    if isinstance(value, str):
        return value

    if kind in FLOATS:
        widened = f32(value) if kind == 'float' else float(value)
        if math.isnan(widened):
            return 'NaN'
        if math.isinf(widened):
            return 'Infinity' if widened > 0 else '-Infinity'
        return widened

    if kind in WIDE or kind == 'count':
        return str(value)

    return value


def words_of(kind, value):
    """A value as protovalidate's %s writes it (18.8.6)."""
    if isinstance(value, list):
        return '[' + ', '.join(words_of(kind, each) for each in value) + ']'

    if isinstance(value, bool):
        return 'true' if value else 'false'

    if isinstance(value, str):
        return value

    if kind in FLOATS:
        widened = f32(value) if kind == 'float' else float(value)
        if math.isnan(widened):
            return 'NaN'
        if math.isinf(widened):
            return 'Infinity' if widened > 0 else '-Infinity'
        return es(widened)

    return str(value)


def same(one, other):
    return one == other


def number_rules(kind, rules, value):
    """The violations of a number's rules, by their members' numbers (18.5), as validate.proto's
    expressions judge them (18.8.3, 18.8.4)."""
    if kind == 'float':
        value = f32(value)
        rules = {name: ([f32(each) for each in member] if isinstance(member, list) else
                        f32(member) if isinstance(member, (int, float)) and not isinstance(member, bool) else member)
                 for name, member in rules.items()}

    nan = isinstance(value, float) and math.isnan(value)
    found = []
    lower = next((name for name in ('gt', 'gte') if name in rules), None)
    upper = next((name for name in ('lt', 'lte') if name in rules), None)

    def json_of(*names):
        return {name: bound_json(kind, rules[name]) for name in names}

    if 'const' in rules and not same(value, rules['const']):
        found.append((1, f'{kind}.const', json_of('const'), f'must equal {words_of(kind, rules["const"])}'))

    above = {'gt': lambda bound: value > bound, 'gte': lambda bound: value >= bound}
    below = {'lt': lambda bound: value < bound, 'lte': lambda bound: value <= bound}
    phrase = {'gt': 'greater than', 'gte': 'greater than or equal to', 'lt': 'less than', 'lte': 'less than or equal to'}

    if upper and not lower and (nan or not below[upper](rules[upper])):
        found.append((NUMBER_RULES[upper], f'{kind}.{upper}', json_of(upper),
                      f'must be {phrase[upper]} {words_of(kind, rules[upper])}'))

    if lower and not upper and (nan or not above[lower](rules[lower])):
        found.append((NUMBER_RULES[lower], f'{kind}.{lower}', json_of(lower),
                      f'must be {phrase[lower]} {words_of(kind, rules[lower])}'))

    if lower and upper:
        low, high = rules[lower], rules[upper]
        # ! a range whose upper member is below its lower takes what is outside it (18.8.3)
        exclusive = high < low

        if not exclusive:
            broken = nan or not (above[lower](low) and below[upper](high))
            joined, rule_id = 'and', f'{kind}.{lower}_{upper}'
        else:
            broken = nan or (not above[lower](low) and not below[upper](high))
            joined, rule_id = 'or', f'{kind}.{lower}_{upper}_exclusive'

        if broken:
            found.append((NUMBER_RULES[lower], rule_id, json_of(lower, upper),
                          f'must be {phrase[lower]} {words_of(kind, low)} {joined} {phrase[upper]} {words_of(kind, high)}'))

    if 'in' in rules and not any(same(value, each) for each in rules['in']):
        found.append((6, f'{kind}.in', json_of('in'), f'must be in list {words_of(kind, rules["in"])}'))

    if 'not_in' in rules and any(same(value, each) for each in rules['not_in']):
        found.append((7, f'{kind}.not_in', json_of('not_in'), f'must not be in list {words_of(kind, rules["not_in"])}'))

    if rules.get('finite') and (math.isnan(value) or math.isinf(value)):
        found.append((8, f'{kind}.finite', None, 'must be finite'))

    return found


def string_rules(rules, value):
    found = []
    points, size = len(value), utf8(value)

    def count(name):
        return {name: str(rules[name])}

    checks = [
        ('const', lambda: value != rules['const'], None, lambda: f'must equal `{rules["const"]}`', {'const': rules.get('const')}),
        ('len', lambda: points != rules['len'], None, lambda: f'must be {rules["len"]} characters', None),
        ('min_len', lambda: points < rules['min_len'], None, lambda: f'must be at least {rules["min_len"]} characters', None),
        ('max_len', lambda: points > rules['max_len'], None, lambda: f'must be at most {rules["max_len"]} characters', None),
        ('len_bytes', lambda: size != rules['len_bytes'], None, lambda: f'must be {rules["len_bytes"]} bytes', None),
        ('min_bytes', lambda: size < rules['min_bytes'], None, lambda: f'must be at least {rules["min_bytes"]} bytes', None),
        ('max_bytes', lambda: size > rules['max_bytes'], None, lambda: f'must be at most {rules["max_bytes"]} bytes', None),
        ('pattern', lambda: not matches(rules['pattern'], value), None,
         lambda: f'does not match regex pattern `{rules["pattern"]}`', {'pattern': rules.get('pattern')}),
        ('prefix', lambda: not value.startswith(rules['prefix']), None, lambda: f'does not have prefix `{rules["prefix"]}`',
         {'prefix': rules.get('prefix')}),
        ('suffix', lambda: not value.endswith(rules['suffix']), None, lambda: f'does not have suffix `{rules["suffix"]}`',
         {'suffix': rules.get('suffix')}),
        ('contains', lambda: rules['contains'] not in value, None,
         lambda: f'does not contain substring `{rules["contains"]}`', {'contains': rules.get('contains')}),
        ('not_contains', lambda: rules['not_contains'] in value, None,
         lambda: f'contains substring `{rules["not_contains"]}`', {'not_contains': rules.get('not_contains')}),
        ('in', lambda: value not in rules['in'], None, lambda: f'must be in list {words_of("string", rules["in"])}',
         {'in': rules.get('in')}),
        ('not_in', lambda: value in rules['not_in'], None, lambda: f'must not be in list {words_of("string", rules["not_in"])}',
         {'not_in': rules.get('not_in')}),
    ]

    for name, broken, _, words, bounds in checks:
        if name in rules and broken():
            found.append((STRING_RULES[name], f'string.{name}', bounds if bounds is not None else count(name), words()))

    return found


def bytes_rules(rules, value):
    found = []

    def hexadecimal(data):
        return data.hex()

    def b64(name):
        return {name: base64.b64encode(rules[name]).decode('ascii')}

    checks = [
        ('const', lambda: value != rules['const'], lambda: f'must be {hexadecimal(rules["const"])}', lambda: b64('const')),
        ('len', lambda: len(value) != rules['len'], lambda: f'must be {rules["len"]} bytes', lambda: {'len': str(rules['len'])}),
        ('min_len', lambda: len(value) < rules['min_len'], lambda: f'must be at least {rules["min_len"]} bytes',
         lambda: {'min_len': str(rules['min_len'])}),
        ('max_len', lambda: len(value) > rules['max_len'], lambda: f'must be at most {rules["max_len"]} bytes',
         lambda: {'max_len': str(rules['max_len'])}),
        ('prefix', lambda: not value.startswith(rules['prefix']), lambda: f'does not have prefix {hexadecimal(rules["prefix"])}',
         lambda: b64('prefix')),
        ('suffix', lambda: not value.endswith(rules['suffix']), lambda: f'does not have suffix {hexadecimal(rules["suffix"])}',
         lambda: b64('suffix')),
        ('contains', lambda: rules['contains'] not in value, lambda: f'does not contain {hexadecimal(rules["contains"])}',
         lambda: b64('contains')),
    ]

    for name, broken, words, bounds in checks:
        if name in rules and broken():
            found.append((BYTES_RULES[name], f'bytes.{name}', bounds(), words()))

    return found


def enum_rules(rules, value):
    found = []

    if 'const' in rules and value != rules['const']:
        found.append((1, 'enum.const', {'const': rules['const']}, f'must equal {rules["const"]}'))

    if rules.get('defined_only') and value not in COLOURS:
        found.append((2, 'enum.defined_only', None, 'value must be one of the defined enum values'))

    if 'in' in rules and value not in rules['in']:
        found.append((3, 'enum.in', {'in': rules['in']}, f'must be in list {words_of("int32", rules["in"])}'))

    if 'not_in' in rules and value in rules['not_in']:
        found.append((4, 'enum.not_in', {'not_in': rules['not_in']}, f'must not be in list {words_of("int32", rules["not_in"])}'))

    return found


def bool_rules(rules, value):
    if 'const' in rules and value != rules['const']:
        return [(1, 'bool.const', {'const': rules['const']}, f'must equal {words_of("bool", rules["const"])}')]

    return []


def type_of(kind):
    if kind.startswith('enum:'):
        return 'enum'
    if kind.startswith('wrapper:'):
        return kind.split(':')[1]
    return kind


def value_rules(kind, rules, value):
    """The violations of a single value's rules, its type's members in their numbers' order."""
    scalar = type_of(kind)
    of_type = rules.get(scalar, {})

    if scalar in (*INTEGERS, *FLOATS):
        found = number_rules(scalar, of_type, value)
    elif scalar == 'string':
        found = string_rules(of_type, value)
    elif scalar == 'bytes':
        found = bytes_rules(of_type, value)
    elif scalar == 'enum':
        found = enum_rules(of_type, value)
    elif scalar == 'bool':
        found = bool_rules(of_type, value)
    else:
        found = []

    return [(rule_id, bounds, words) for _, rule_id, bounds, words in sorted(found, key=lambda each: each[0])]


# ── Paths, 18.4 ─────────────────────────────────────────────────────────────────────────────────

KEY_BYTES = 64


def subscript(kind, key):
    if kind == 'bool':
        return 'true' if key else 'false'

    if kind != 'string':
        return str(key)

    data = key.encode('utf-8')

    if len(data) <= KEY_BYTES:
        return canonical(key)

    # ! the cut falls back to the start of the character it fell in, as 7.3 cuts a detail
    cut = KEY_BYTES

    while data[cut] & 0xC0 == 0x80:
        cut -= 1

    return canonical(data[:cut].decode('utf-8')) + '...'


def rendered(elements):
    return '.'.join(name + (f'[{index}]' if index is not None else '') for name, index in elements)


def key_order(kind, key):
    if kind == 'string':
        return [ord(character) for character in key]
    return int(key)


# ── Judging a message, 18.5 ─────────────────────────────────────────────────────────────────────


def named_by_message_oneof(message, field):
    return any(field.name in rule['fields'] for rule in message.rules.get('oneof', []))


def judge(message, value, path=()):
    """Every violation of a message's value, in 18.5's order."""
    for field in sorted(message.fields, key=lambda each: each.number):
        yield from judge_field(message, field, value, path)

    for rule in message.rules.get('oneof', []):
        members = [field for field in message.fields if field.name in rule['fields']]
        given = [field for field in members if is_set(field, value)]
        bounds = {'fields': rule['fields'], **({'required': True} if rule.get('required') else {})}

        if len(given) > 1:
            yield violation(rendered(path), 'message.oneof', bounds, f'only one of {", ".join(rule["fields"])} can be set')

        if rule.get('required') and not given:
            yield violation(rendered(path), 'message.oneof', bounds, f'one of {", ".join(rule["fields"])} must be set')

    for name, required in message.oneofs:
        members = [field for field in message.fields if field.oneof == name]

        if required and not any(field.name in value for field in members):
            yield violation(rendered((*path, (name, None))), 'required', None, 'exactly one field is required in oneof')


def judge_field(message, field, value, path):
    rules = field.rules
    ignore = rules.get('ignore', 'IGNORE_IF_ZERO_VALUE' if named_by_message_oneof(message, field) else 'IGNORE_UNSPECIFIED')
    here = (*path, (field.name, None))

    if ignore == 'IGNORE_ALWAYS':
        return

    if rules.get('required') and not is_set(field, value):
        yield violation(rendered(here), 'required', None, 'value is required')
        return

    if field.explicit and field.name not in value:
        return

    given = value.get(field.name, [] if field.label else None if field.kind.startswith(('message:', 'wrapper:'))
                      else zero_of(field.kind))

    # ! IGNORE_IF_ZERO_VALUE is the default's on a field of explicit presence, set at its zero or not
    if ignore == 'IGNORE_IF_ZERO_VALUE' and not field.explicit and (not given if field.label else is_zero(field.kind, given)):
        return

    if field.label == 'repeated':
        yield from judge_repeated(field, given, path)
    elif field.label == 'map':
        yield from judge_map(field, given, path)
    else:
        for rule_id, bounds, words in value_rules(field.kind, rules, given) if not field.kind.startswith('message:') else ():
            yield violation(rendered(here), rule_id, bounds, words)

        if field.kind.startswith('message:'):
            yield from judge(BY_NAME[field.kind.split(':')[1]], given, here)


def zero_of(kind):
    scalar = type_of(kind)
    return {'string': '', 'bytes': b'', 'bool': False, 'float': 0.0, 'double': 0.0}.get(scalar, 0)


def judge_repeated(field, items, path):
    rules = field.rules.get('repeated', {})
    here = (*path, (field.name, None))

    if 'min_items' in rules and len(items) < rules['min_items']:
        yield violation(rendered(here), 'repeated.min_items', {'min_items': str(rules['min_items'])},
                        f'must contain at least {rules["min_items"]} item(s)')

    if 'max_items' in rules and len(items) > rules['max_items']:
        yield violation(rendered(here), 'repeated.max_items', {'max_items': str(rules['max_items'])},
                        f'must contain no more than {rules["max_items"]} item(s)')

    if rules.get('unique') and any(same(items[i], items[j]) for i in range(len(items)) for j in range(i + 1, len(items))):
        yield violation(rendered(here), 'repeated.unique', None, 'repeated value must contain unique items')

    item_rules = rules.get('items', {})

    for index, item in enumerate(items):
        at = (*path, (field.name, index))

        if field.kind.startswith('message:'):
            yield from judge(BY_NAME[field.kind.split(':')[1]], item, at)
        else:
            for rule_id, bounds, words in value_rules(field.kind, item_rules, item):
                yield violation(rendered(at), rule_id, bounds, words)


def judge_map(field, entries, path):
    rules = field.rules.get('map', {})
    here = (*path, (field.name, None))

    if 'min_pairs' in rules and len(entries) < rules['min_pairs']:
        yield violation(rendered(here), 'map.min_pairs', {'min_pairs': str(rules['min_pairs'])},
                        f'map must be at least {rules["min_pairs"]} entries')

    if 'max_pairs' in rules and len(entries) > rules['max_pairs']:
        yield violation(rendered(here), 'map.max_pairs', {'max_pairs': str(rules['max_pairs'])},
                        f'map must be at most {rules["max_pairs"]} entries')

    for key, item in sorted(entries, key=lambda entry: key_order(field.key, entry[0])):
        at = (*path, (field.name, subscript(field.key, key)))

        for rule_id, bounds, words in value_rules(field.key, rules.get('keys', {}), key):
            yield violation(rendered(at), rule_id, bounds, words, for_key=True)

        if field.kind.startswith('message:'):
            yield from judge(BY_NAME[field.kind.split(':')[1]], item, at)
        else:
            for rule_id, bounds, words in value_rules(field.kind, rules.get('values', {}), item):
                yield violation(rendered(at), rule_id, bounds, words)


# 18.8.6's words of a standard rule from its id and its bounds, where they give them alone
RENDERED = {
    'const': lambda kind, bounds: (f'must equal `{bounds["const"]}`' if kind == 'string' else
                                   f'must be {base64.b64decode(bounds["const"]).hex()}' if kind == 'bytes' else
                                   f'must equal {words_of_json(kind, bounds["const"])}'),
    'in': lambda kind, bounds: f'must be in list {words_of_json(kind, bounds["in"])}',
    'not_in': lambda kind, bounds: f'must not be in list {words_of_json(kind, bounds["not_in"])}',
    'len': lambda kind, bounds: f'must be {bounds["len"]} ' + ('characters' if kind == 'string' else 'bytes'),
    'min_len': lambda kind, bounds: f'must be at least {bounds["min_len"]} ' + ('characters' if kind == 'string' else 'bytes'),
    'max_len': lambda kind, bounds: f'must be at most {bounds["max_len"]} ' + ('characters' if kind == 'string' else 'bytes'),
    'len_bytes': lambda kind, bounds: f'must be {bounds["len_bytes"]} bytes',
    'min_bytes': lambda kind, bounds: f'must be at least {bounds["min_bytes"]} bytes',
    'max_bytes': lambda kind, bounds: f'must be at most {bounds["max_bytes"]} bytes',
    'pattern': lambda kind, bounds: f'does not match regex pattern `{bounds["pattern"]}`',
    'prefix': lambda kind, bounds: (f'does not have prefix `{bounds["prefix"]}`' if kind == 'string' else
                                    f'does not have prefix {base64.b64decode(bounds["prefix"]).hex()}'),
    'suffix': lambda kind, bounds: (f'does not have suffix `{bounds["suffix"]}`' if kind == 'string' else
                                    f'does not have suffix {base64.b64decode(bounds["suffix"]).hex()}'),
    'contains': lambda kind, bounds: (f'does not contain substring `{bounds["contains"]}`' if kind == 'string' else
                                      f'does not contain {base64.b64decode(bounds["contains"]).hex()}'),
    'not_contains': lambda kind, bounds: f'contains substring `{bounds["not_contains"]}`',
    'min_items': lambda kind, bounds: f'must contain at least {bounds["min_items"]} item(s)',
    'max_items': lambda kind, bounds: f'must contain no more than {bounds["max_items"]} item(s)',
    'min_pairs': lambda kind, bounds: f'map must be at least {bounds["min_pairs"]} entries',
    'max_pairs': lambda kind, bounds: f'map must be at most {bounds["max_pairs"]} entries',
}
FLAGS = {'enum.defined_only': 'value must be one of the defined enum values',
         'repeated.unique': 'repeated value must contain unique items', 'float.finite': 'must be finite',
         'double.finite': 'must be finite'}
PHRASES = {'gt': 'greater than', 'gte': 'greater than or equal to', 'lt': 'less than', 'lte': 'less than or equal to'}


def words_of_json(kind, value):
    """A bound's words from its JSON, as %s writes the value it is."""
    if isinstance(value, list):
        return '[' + ', '.join(words_of_json(kind, each) for each in value) + ']'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, str):
        return value
    if isinstance(value, float) or kind in FLOATS:
        return es(float(value))
    return str(value)


def words_from(rule_id, bounds):
    """18.8.6's words of a violation from its rule's id and its bounds, or None where they do not give
    them alone (18.7)."""
    if rule_id in FLAGS:
        return FLAGS[rule_id]

    kind, _, member = rule_id.partition('.')

    if bounds is None or not member:
        return None

    if kind in (*INTEGERS, *FLOATS, 'enum', 'bool') and member in ('gt', 'gte', 'lt', 'lte'):
        return f'must be {PHRASES[member]} {words_of_json(kind, bounds[member])}'

    found = re.fullmatch(r'(gte?)_(lte?)(_exclusive)?', member)

    if found and kind in (*INTEGERS, *FLOATS):
        lower, upper = found.group(1), found.group(2)
        joined = 'or' if found.group(3) else 'and'
        return (f'must be {PHRASES[lower]} {words_of_json(kind, bounds[lower])} {joined} '
                f'{PHRASES[upper]} {words_of_json(kind, bounds[upper])}')

    if member in RENDERED and kind in ('string', 'bytes', 'enum', 'bool', 'repeated', 'map', *INTEGERS, *FLOATS):
        return RENDERED[member](kind, bounds)

    return None


VIOLATION_MEMBERS = {'bounds', 'fieldPath', 'forKey', 'message', 'ruleId'}


def strict_json(text):
    """A line read as 17.5 reads a json payload: one JSON text, no name twice, or None."""
    def pairs(items):
        names = [name for name, _ in items]
        if len(names) != len(set(names)):
            raise ValueError('a name twice')
        return dict(items)

    def constant(name):
        raise ValueError(name)

    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=constant)
    except ValueError:
        return None


def as_violation(value):
    if not isinstance(value, dict) or not value.keys() <= VIOLATION_MEMBERS or not isinstance(value.get('ruleId'), str):
        return None
    if 'fieldPath' in value and not isinstance(value['fieldPath'], str):
        return None
    if 'message' in value and not isinstance(value['message'], str):
        return None
    if 'forKey' in value and value['forKey'] is not True:
        return None
    if 'bounds' in value and not isinstance(value['bounds'], dict):
        return None
    return value


def read_detail(detail):
    """What 18.7's reader reads of a detail: its violations, each given its words where it went without
    them and its rule's id and bounds give them, and its count, or that its side stopped."""
    read = {'violations': []}

    for line in detail.split('\n') if detail else []:
        value = strict_json(line)
        found = as_violation(value)

        if found is not None:
            if 'message' not in found and words_from(found['ruleId'], found.get('bounds')) is not None:
                found = dict(sorted({**found, 'message': words_from(found['ruleId'], found.get('bounds'))}.items()))
            read['violations'].append(found)
            continue

        if isinstance(value, dict) and value.keys() == {'more'} and isinstance(value['more'], int) \
                and not isinstance(value['more'], bool) and value['more'] >= 0:
            read['more'] = value['more']
        elif value == {'stopped': True}:
            read['stopped'] = True

        break

    return read


# ── The verdicts ────────────────────────────────────────────────────────────────────────────────

# the units each verdict cites, beside its own: 18.2, every rule judged; 18.3, a violation's members
JUDGED = '18.2'
MEMBERS = ['18.3.1', '18.3.2', '18.3.3', '18.3.4']
FOR_KEY = '18.3.5'
PATH, ORDER, FAIL_FAST = '18.4', '18.5', '18.5'
PRESENCE, LENGTHS, NUMBERS, EQUALITY, PATTERN, WORDS = '18.8.1', '18.8.2', '18.8.3', '18.8.4', '18.8.5', '18.8.6'
DETAIL, READER = '18.6', '18.7'


def hexadecimal(data):
    return ' '.join(f'{byte:02X}' for byte in data)


def verdict(name, clauses, message, value, *, maximum=None, fail_fast=False, runs=None):
    """A payload judged: its bytes, and what its validator gives, under a bound where one is given."""
    schema = BY_NAME[message]
    every = list(judge(schema, value))
    result = judged(every, maximum=maximum, fail_fast=fail_fast)
    units = ['18.1', JUDGED, *clauses]

    if result['violations']:
        units += [unit for unit in MEMBERS if unit not in units]
        units += [WORDS] if WORDS not in units else []

    if any(found.get('forKey') for found in result['violations']):
        units.append(FOR_KEY)

    entry = {'name': name, 'clauses': list(dict.fromkeys(units)), 'message': f'bead.validations.v1.{message}'}

    if runs is None:
        entry['payload'] = hexadecimal(encode(schema, value))
    else:
        entry['runs'] = [{'bytes': hexadecimal(data), 'times': times} for data, times in runs]
        assert b''.join(data * times for data, times in runs) == encode(schema, value), name

    if maximum is not None:
        entry['maximumBytes'] = maximum

    if fail_fast:
        entry['failFast'] = True

    entry['violations'] = result['violations']

    if result['more']:
        entry['more'] = result['more']

    if result['stopped']:
        entry['stopped'] = True

    return entry


SMILE = chr(0x1F600)
E_ACUTE = chr(0xE9)
PRIVATE = chr(0xE000)
KELVIN = chr(0x212A)
LINE_SEPARATOR = chr(0x2028)
NO_BREAK_SPACE = chr(0xA0)
ARABIC_THREE = chr(0x663)
SIDETIC = chr(0x10940)
LONG_KEY = 'k' * 1999 + E_ACUTE
MANY = 100_000
NESTED_A = 100_000
COUNTED_A = 65_536


def string_record(number, text):
    data = text.encode('utf-8')
    return tag(number, LEN) + varint(len(data))


VERDICTS = [
    # the integers
    ('an int32 at its lte is taken', [NUMBERS], 'Numbers', {'at_most_ten': 10}),
    ('an int32 past its lte breaks int32.lte', [NUMBERS], 'Numbers', {'at_most_ten': 11}),
    ('an int32 at its lt breaks int32.lt', [NUMBERS], 'Numbers', {'below_ten': 10}),
    ('an int32 at its gt breaks int32.gt', [NUMBERS], 'Numbers', {'above_zero': 0}),
    ('an int32 below its gte breaks int32.gte, and one at it is taken', [NUMBERS], 'Numbers', {'at_least_one': 0, 'above_zero': 1}),
    ('an int32 within its range is taken', [NUMBERS], 'Numbers', {'between': 5}),
    ('an int32 at its range\'s lt breaks int32.gt_lt', [NUMBERS], 'Numbers', {'between': 10}),
    ('an int32 past its range\'s gte_lte breaks int32.gte_lte', [NUMBERS], 'Numbers', {'within': -1}),
    ('an int32 within a range given reversed breaks int32.gt_lt_exclusive: the range takes what is outside it', [NUMBERS], 'Numbers', {'outside': 7}),
    ('an int32 past a range given reversed is taken, above it or below it', [NUMBERS], 'Numbers', {'outside': 11, 'between': 1, 'within': 0}),
    ('an int32 below a range given reversed is taken', [NUMBERS], 'Numbers', {'outside': 4}),
    ('an int32 at a range given reversed\'s gt breaks it', [NUMBERS], 'Numbers', {'outside': 10}),
    ('an int32 not its const breaks int32.const', [NUMBERS, EQUALITY], 'Numbers', {'exactly': 4}),
    ('an int32 its const is taken', [NUMBERS, EQUALITY], 'Numbers', {'exactly': 3}),
    ('an int32 out of its in breaks int32.in', [NUMBERS, EQUALITY], 'Numbers', {'listed': 4}),
    ('an int32 in its not_in breaks int32.not_in', [NUMBERS, EQUALITY], 'Numbers', {'unlisted': 13}),
    ('an int64 at -2^53 breaks lt -2^53 - 1, compared whole', [NUMBERS], 'Numbers', {'wide': -9007199254740992}),
    ('an int64 at -2^53 - 2 is taken under lt -2^53 - 1', [NUMBERS], 'Numbers', {'wide': -9007199254740994}),
    ('a uint64 at 2^64 - 1 is in its in, and one below it is not', [NUMBERS, EQUALITY], 'Numbers', {'unsigned_wide': 18446744073709551614}),
    ('a uint64 at 2^64 - 1 is taken by its in', [NUMBERS, EQUALITY], 'Numbers', {'unsigned_wide': 18446744073709551615}),
    ('a uint32 at 2^32 - 1 breaks uint32.gte_lt', [NUMBERS], 'Numbers', {'unsigned': 4294967295}),
    ('a uint32 at its gte is taken', [NUMBERS], 'Numbers', {'unsigned': 1}),
    ('a sint32 at -1 breaks sint32.gt', [NUMBERS], 'Numbers', {'zigzag': -1}),
    ('a sint64 below its range breaks sint64.gte_lte', [NUMBERS], 'Numbers', {'zigzag_wide': -6}),
    ('a fixed32 past its lte breaks fixed32.lte', [NUMBERS], 'Numbers', {'fixed': 101}),
    ('a fixed64 at 2^53 breaks gt 2^53, and one past it is taken', [NUMBERS], 'Numbers', {'fixed_wide': 9007199254740992}),
    ('a fixed64 at 2^53 + 1 is taken by gt 2^53, compared whole', [NUMBERS], 'Numbers', {'fixed_wide': 9007199254740993}),
    ('a sfixed32 within a range given reversed breaks sfixed32.gte_lt_exclusive', [NUMBERS], 'Numbers', {'signed_fixed': 5}),
    ('a sfixed32 outside a range given reversed is taken', [NUMBERS], 'Numbers', {'signed_fixed': -1}),
    ('a sfixed64 within a range given reversed breaks sfixed64.gt_lte_exclusive', [NUMBERS], 'Numbers', {'signed_fixed_wide': 3}),
    ('an int64 at its range\'s gt breaks int64.gt_lte', [NUMBERS], 'Numbers', {'above_to': 0}),
    ('a uint64 within a range given reversed breaks uint64.gte_lte_exclusive', [NUMBERS], 'Numbers', {'outside_wide': 7}),
    ('a bool not its const breaks bool.const', [EQUALITY], 'Numbers', {'truth': False}),
    ('a bool its const is taken', [EQUALITY], 'Numbers', {'truth': True}),
    ('an example is never judged: a value other than it is taken', [NUMBERS], 'Numbers', {'sampled': 1}),
    ('every field unset breaks nothing', [PRESENCE], 'Numbers', {}),
    ('a range before in, by their members\' numbers', [NUMBERS, ORDER], 'Numbers', {'ranged_listed': -1}),
    ('every integer rule broken at once, in the fields\' order', [NUMBERS, ORDER], 'Numbers',
     {'at_most_ten': 11, 'below_ten': 10, 'above_zero': 0, 'wide': -9007199254740992, 'zigzag': -1, 'truth': False}),
    # the floats
    ('a float at its gt of 0.1 breaks it, compared as a float, its bound the double the float is', [NUMBERS], 'Floats', {'above_tenth': f32(0.1)}),
    ('a float past its gt is taken', [NUMBERS], 'Floats', {'above_tenth': f32(0.2)}),
    ('a double past its range breaks double.gte_lte', [NUMBERS], 'Floats', {'unit': 1.5}),
    ('a double NaN breaks every bound', [NUMBERS], 'Floats', {'unit': NAN}),
    ('a double NaN breaks finite', [NUMBERS], 'Floats', {'real': NAN}),
    ('a double infinite breaks finite', [NUMBERS], 'Floats', {'real': -INF}),
    ('a double finite is taken by finite', [NUMBERS], 'Floats', {'real': 1.0}),
    ('a double out of a list holding -Infinity breaks double.in, its bounds the JSON mapping\'s strings', [NUMBERS, EQUALITY], 'Floats', {'listed': 2.0}),
    ('a double -Infinity is taken by a list holding it', [NUMBERS, EQUALITY], 'Floats', {'listed': -INF}),
    ('a float under gt Infinity breaks it, its words Infinity', [NUMBERS], 'Floats', {'beyond': f32(1.0)}),
    ('a double 0.3 is not its const 0.30000000000000004', [NUMBERS, EQUALITY], 'Floats', {'exactly': 0.3}),
    ('a double 0.1 + 0.2 is its const 0.30000000000000004', [NUMBERS, EQUALITY], 'Floats', {'exactly': 0.1 + 0.2}),
    ('a double within a range given reversed breaks double.gt_lt_exclusive', [NUMBERS], 'Floats', {'outside': 0.0}),
    ('a double NaN breaks a range given reversed', [NUMBERS], 'Floats', {'outside': NAN}),
    ('a double outside a range given reversed is taken', [NUMBERS], 'Floats', {'outside': 2.0}),
    ('a float -0.0 is 0 in its not_in', [EQUALITY], 'Floats', {'unlisted': -0.0}),
    ('a double at 1e21 breaks lt 1e21, its words as ECMAScript writes the double', [NUMBERS], 'Floats', {'below_large': 1e21}),
    ('a float NaN breaks its gte, then finite, by their members\' numbers', [NUMBERS, ORDER], 'Floats', {'real_float': NAN}),
    ('a float infinite breaks finite alone', [NUMBERS], 'Floats', {'real_float': f32(INF)}),
    # the strings
    ('a string not its const breaks string.const, its words between backticks', [EQUALITY], 'Strings', {'exactly': 'x'}),
    ('a string its const is taken', [EQUALITY], 'Strings', {'exactly': 'a"b'}),
    ('a string of three code points, one astral, holds len 3', [LENGTHS], 'Strings', {'three': SMILE + 'ab'}),
    ('a string of two characters breaks len 3', [LENGTHS], 'Strings', {'three': 'ab'}),
    ('an empty string breaks min_len', [LENGTHS], 'Strings', {'short': ''}),
    ('a string past its max_len breaks it', [LENGTHS], 'Strings', {'short': 'abcd'}),
    ('three astral characters hold max_len 3, six UTF-16 units though they are', [LENGTHS], 'Strings', {'short': SMILE * 3}),
    ('two characters of four UTF-8 bytes hold len_bytes 4', [LENGTHS], 'Strings', {'four_bytes': E_ACUTE * 2}),
    ('three ASCII characters break len_bytes 4', [LENGTHS], 'Strings', {'four_bytes': 'abc'}),
    ('one character of two UTF-8 bytes holds min_bytes 2', [LENGTHS], 'Strings', {'few_bytes': E_ACUTE}),
    ('one ASCII character breaks min_bytes 2', [LENGTHS], 'Strings', {'few_bytes': 'a'}),
    ('two characters of four UTF-8 bytes break max_bytes 3', [LENGTHS], 'Strings', {'few_bytes': E_ACUTE * 2}),
    ('a string its pattern takes is taken', [PATTERN], 'Strings', {'lower': 'abc'}),
    ('a string its pattern does not match breaks string.pattern', [PATTERN], 'Strings', {'lower': 'ab1'}),
    ('a string without its prefix breaks string.prefix', [], 'Strings', {'prefixed': 'bead'}),
    ('a string with its prefix is taken', [], 'Strings', {'prefixed': 'bead:x'}),
    ('a string without its suffix breaks string.suffix', [], 'Strings', {'suffixed': 'a.v2'}),
    ('a string without what it contains breaks string.contains', [], 'Strings', {'containing': 'nobody'}),
    ('a string holding what it must not breaks string.not_contains', [], 'Strings', {'excluding': 'a--b'}),
    ('a string out of its in breaks string.in, its list as words', [EQUALITY], 'Strings', {'listed': 'c'}),
    ('a string in its not_in breaks string.not_in', [EQUALITY], 'Strings', {'unlisted': 'root'}),
    ('pattern before len, by their members\' numbers', [LENGTHS, ORDER, PATTERN], 'Strings', {'lengths': 'ab1'}),
    ('prefix before len_bytes, by their members\' numbers', [LENGTHS, ORDER], 'Strings', {'byte_lengths': 'abc'}),
    ('in before not_contains, by their members\' numbers', [ORDER], 'Strings', {'excluded_listed': 'c--'}),
    ('an empty string is judged where it is set, and breaks each rule it does not hold, in the fields\' order', [ORDER, PRESENCE], 'Strings',
     {'three': '', 'short': '', 'prefixed': '', 'lower': ''}),
    # the bytes
    ('bytes not their const break bytes.const, its words in hexadecimal, its bounds in base64', [EQUALITY], 'Bytes', {'exactly': b'\x01'}),
    ('bytes their const are taken', [EQUALITY], 'Bytes', {'exactly': b'\x00\xff'}),
    ('three bytes break bytes.len 4', [LENGTHS], 'Bytes', {'four': b'abc'}),
    ('one byte breaks bytes.min_len, four break bytes.max_len', [LENGTHS], 'Bytes', {'few': b'a'}),
    ('four bytes break bytes.max_len 3', [LENGTHS], 'Bytes', {'few': b'abcd'}),
    ('bytes without their prefix break bytes.prefix', [], 'Bytes', {'png': b'GIF8'}),
    ('bytes without their suffix break bytes.suffix', [], 'Bytes', {'terminated': b'ab'}),
    ('bytes without what they contain break bytes.contains', [], 'Bytes', {'marked': b'\x00\x01'}),
    ('bytes.prefix before bytes.len, by their members\' numbers', [LENGTHS, ORDER], 'Bytes', {'lengths': b'abc'}),
    # the enums
    ('an enum number its enum does not declare breaks defined_only', [], 'Enums', {'defined': 7}),
    ('an enum number its enum declares is taken by defined_only', [], 'Enums', {'defined': 1}),
    ('an enum not its const breaks enum.const, by its number', [EQUALITY], 'Enums', {'exactly': 1}),
    ('an enum out of its in breaks enum.in', [EQUALITY], 'Enums', {'listed': 2}),
    ('an enum in its not_in breaks enum.not_in', [EQUALITY], 'Enums', {'unlisted': 0}),
    ('enum.defined_only before enum.in, by their members\' numbers', [ORDER], 'Enums', {'checked': 7}),
    # the repeated fields
    ('an empty repeated field breaks min_items', [PRESENCE], 'Repeated', {'names': []}),
    ('a repeated field past max_items breaks it, then each item breaks its rules, by index', [ORDER, PATH], 'Repeated', {'names': ['a', '', 'b', '']}),
    ('a repeated field within its counts and its items\' rules is taken', [], 'Repeated', {'names': ['a', 'b']}),
    ('an item given twice breaks unique', [EQUALITY], 'Repeated', {'distinct': [1, 2, 1]}),
    ('items each given once are taken by unique', [EQUALITY], 'Repeated', {'distinct': [1, 2, 3]}),
    ('0.0 and -0.0 are one item under unique', [EQUALITY], 'Repeated', {'reals': [0.0, -0.0]}),
    ('two NaN are two items under unique', [EQUALITY], 'Repeated', {'reals': [NAN, NAN]}),
    ('a string given twice breaks unique', [EQUALITY], 'Repeated', {'words': ['a', 'b', 'a']}),
    ('a repeated message\'s items are judged by index, each by its message\'s rules', [PATH, ORDER], 'Repeated',
     {'inners': [{'name': ''}, {'name': 'ok'}, {'name': ''}]}),
    ('an enum given twice breaks unique, then an item not declared breaks defined_only', [ORDER], 'Repeated', {'colours': [1, 7, 1]}),
    ('a request of 100,000 breaking items holds the violations its detail carries, and counts the rest exactly', [DETAIL], 'Repeated',
     {'names': ['a'], 'many': [''] * MANY}, {'maximum': 1024, 'runs': [(record(1, 'string', 'a'), 1), (tag(6, LEN) + varint(0), MANY)]}),
    ('a request of 100,000 breaking items under failFast gives its first and stops', [FAIL_FAST], 'Repeated',
     {'names': ['a'], 'many': [''] * MANY}, {'fail_fast': True, 'runs': [(record(1, 'string', 'a'), 1), (tag(6, LEN) + varint(0), MANY)]}),
    # the maps
    ('a map past max_pairs breaks it, then its entries by key: a key\'s rule, then a value\'s', [ORDER, PATH], 'Maps',
     {'labels': [('zz', -1), ('a', 0), ('mm', 1)]}),
    ('an empty map breaks min_pairs', [], 'Maps', {'labels': []}),
    ('a map within its rules is taken', [], 'Maps', {'labels': [('ab', 0), ('cd', 1)]}),
    ('a map of messages judges each by key, integers ascending', [ORDER, PATH], 'Maps',
     {'by_id': [(3, {'name': ''}), (10, {'name': ''}), (-1, {'name': ''})]}),
    ('a map keyed by bool judges false before true', [ORDER, PATH], 'Maps', {'flags': [(True, ''), (False, '')]}),
    ('a map keyed by string judges its keys by code points, U+E000 before U+1F600', [ORDER, PATH], 'Maps',
     {'by_text': [(SMILE, ''), (PRIVATE, ''), ('b', ''), ('a' + E_ACUTE, ''), ('a', '')]}),
    ('a map keyed by int64 judges its keys ascending, negatives first', [ORDER, PATH], 'Maps',
     {'by_int64': [(9007199254740993, ''), (-9007199254740993, ''), (0, '')]}),
    ('a map keyed by uint32 judges its keys ascending', [ORDER, PATH], 'Maps', {'by_uint32': [(4294967295, ''), (1, '')]}),
    ('a map keyed by uint64 judges its keys ascending, past 2^63', [ORDER, PATH], 'Maps',
     {'by_uint64': [(18446744073709551615, ''), (9223372036854775808, ''), (1, '')]}),
    ('a map keyed by sint32 judges its keys ascending', [ORDER, PATH], 'Maps', {'by_sint32': [(1, ''), (-1, '')]}),
    ('a map keyed by sint64 judges its keys ascending', [ORDER, PATH], 'Maps', {'by_sint64': [(5, ''), (-5, '')]}),
    ('a map keyed by fixed32 judges its keys ascending', [ORDER, PATH], 'Maps', {'by_fixed32': [(2, ''), (1, '')]}),
    ('a map keyed by fixed64 judges its keys ascending', [ORDER, PATH], 'Maps', {'by_fixed64': [(18446744073709551615, ''), (0, '')]}),
    ('a map keyed by sfixed32 judges its keys ascending', [ORDER, PATH], 'Maps', {'by_sfixed32': [(0, ''), (-2147483648, '')]}),
    ('a map keyed by sfixed64 judges its keys ascending', [ORDER, PATH], 'Maps',
     {'by_sfixed64': [(9223372036854775807, ''), (-9223372036854775808, '')]}),
    ('a key holding a tab, a quote and U+0001 is written as section 17.7 writes a string', [PATH], 'Maps',
     {'keyed': [('a' + chr(9) + 'b"' + chr(1), 0)]}),
    ('a key past 64 bytes is cut at 64, back to its character\'s start, then marked ...', [PATH], 'Maps',
     {'keyed': [(LONG_KEY, 0)]}),
    ('a key of 63 ASCII characters and one of two bytes is cut before that one', [PATH], 'Maps',
     {'keyed': [('k' * 63 + E_ACUTE, 0)]}),
    ('a key of 64 bytes is written whole', [PATH], 'Maps', {'keyed': [('k' * 62 + E_ACUTE, 0)]}),
    # presence
    ('an explicit field unset is judged by nothing but required', [PRESENCE], 'Presence', {'needed': 'x', 'needed_implicit': 1,
                                                                                            'needed_items': ['x'], 'inner': {'name': 'x'},
                                                                                            'needed_pairs': [('k', 'v')]}),
    ('an explicit field set to its zero is judged', [PRESENCE], 'Presence', {'explicit': '', 'needed': 'x', 'needed_implicit': 1,
                                                                             'needed_items': ['x'], 'inner': {'name': 'x'},
                                                                             'needed_pairs': [('k', 'v')]}),
    ('an implicit field absent is judged at its zero', [PRESENCE], 'Presence', {'needed': 'x', 'needed_implicit': 1, 'needed_items': ['x'],
                                                                               'inner': {'name': 'x'}, 'implicit': '',
                                                                               'needed_pairs': [('k', 'v')]}),
    ('required refuses an explicit field unset, an implicit one at its zero, an empty repeated field and an empty map, a message unset', [PRESENCE],
     'Presence', {'implicit': 'x'}),
    ('required takes an explicit field set to its zero', [PRESENCE], 'Presence', {'implicit': 'x', 'needed': '', 'needed_implicit': 1,
                                                                                 'needed_items': [''], 'inner': {'name': 'x'},
                                                                                 'needed_pairs': [('', '')]}),
    ('IGNORE_IF_ZERO_VALUE judges nothing of an implicit field at its zero', [PRESENCE], 'Presence',
     {'implicit': 'x', 'needed': 'x', 'needed_implicit': 1, 'needed_items': ['x'], 'inner': {'name': 'x'}, 'needed_pairs': [('k', 'v')]}),
    ('IGNORE_IF_ZERO_VALUE judges a field past its zero', [PRESENCE], 'Presence',
     {'implicit': 'x', 'needed': 'x', 'needed_implicit': 1, 'needed_items': ['x'], 'inner': {'name': 'x'}, 'skipped_zero': 3,
      'needed_pairs': [('k', 'v')]}),
    ('IGNORE_IF_ZERO_VALUE judges nothing of a repeated field or a map empty, and judges one that is not', [PRESENCE], 'Presence',
     {'implicit': 'x', 'needed': 'x', 'needed_implicit': 1, 'needed_items': ['x'], 'inner': {'name': 'x'}, 'needed_pairs': [('k', 'v')],
      'some_items': ['a'], 'some_pairs': []}),
    ('IGNORE_ALWAYS judges nothing of the message a field holds', [PRESENCE], 'Presence',
     {'implicit': 'x', 'needed': 'x', 'needed_implicit': 1, 'needed_items': ['x'], 'inner': {'name': 'x'}, 'ignored_inner': {'name': ''},
      'needed_pairs': [('k', 'v')]}),
    ('a message set is judged by its own rules, its path through it', [PRESENCE, PATH], 'Presence',
     {'implicit': 'x', 'needed': 'x', 'needed_implicit': 1, 'needed_items': ['x'], 'inner': {}, 'needed_pairs': [('k', 'v')]}),
    # the wrappers
    ('every wrapper unset breaks nothing but required', [PRESENCE], 'Wrappers', {}),
    ('a wrapper set is judged on its value, its path the field alone', [PRESENCE, PATH], 'Wrappers',
     {'count': 0, 'title': '', 'ratio': NAN, 'size': 11, 'flag': False, 'blob': b'', 'weight': 0.0, 'offset': -9007199254740994,
      'port': 65536 - 1}),
    ('a wrapper set to values its rules take is taken', [PRESENCE], 'Wrappers',
     {'count': 1, 'title': 'a', 'ratio': 0.5, 'size': 10, 'flag': True, 'blob': b'x', 'weight': f32(0.5), 'offset': -9007199254740993,
      'port': 443}),
    # the oneofs
    ('a oneof required with no member set breaks required, at the oneof\'s name', [PATH], 'Oneofs', {'p': 'a'}),
    ('a oneof\'s member set is judged by its own rules', [PRESENCE], 'Oneofs', {'id': 0, 'p': 'a'}),
    ('a oneof\'s member set to its zero is set', [PRESENCE], 'Oneofs', {'name': '', 'p': 'a'}),
    ('a message\'s oneof breaks where two of its fields are set, and a required one where none is', [], 'Oneofs',
     {'name': 'a', 'x': 'abc', 'y': 'b'}),
    ('a field of implicit presence a message\'s oneof names judges nothing at its zero, and counts as unset', [PRESENCE], 'Oneofs',
     {'name': 'a', 'x': '', 'y': 'b', 'q': 'b'}),
    ('a field a message\'s oneof names is judged past its zero', [PRESENCE], 'Oneofs', {'name': 'a', 'x': 'ab', 'p': 'b'}),
    ('a message with every rule held is taken', [], 'Oneofs', {'id': 1, 'x': 'abc', 'q': 'b'}),
    # the messages held
    ('a message held is judged, its path through it', [PATH], 'Nested', {'inner': {'name': ''}}),
    ('a message held is judged by its fields, then by its own rule, its path the field that holds it', [ORDER, PATH], 'Nested',
     {'pair': {'label': '', 'left': 'a', 'right': 'b'}}),
    ('a repeated message\'s own rules are judged item by item', [ORDER, PATH], 'Nested',
     {'pairs': [{'label': 'a', 'left': 'a', 'right': 'b'}, {'label': ''}]}),
    ('a message held to a depth of three is judged at each depth, its path through each', [ORDER, PATH], 'Nested',
     {'inner': {'name': ''}, 'deep': {'inner': {'name': ''}, 'deep': {'pair': {'label': ''}}}}),
    # the order
    ('fields declared out of their numbers are judged by their numbers, the message\'s own rules after them', [ORDER, PATH], 'Order',
     {'late': '', 'early': 1, 'inner': {'name': ''}}),
    ('failFast gives the first violation of the order alone, and says it stopped', [FAIL_FAST], 'Order',
     {'late': '', 'early': 1, 'inner': {'name': ''}}, {'fail_fast': True}),
    ('failFast on a request that breaks nothing gives nothing, and did not stop', [FAIL_FAST], 'Order',
     {'late': 'a', 'early': 6, 'inner': {'name': 'a'}, 'x': 'x', 'p': 'p'}, {'fail_fast': True}),
    # the patterns
    ('. takes U+000D', [PATTERN], 'Patterns', {'any': chr(13)}),
    ('. takes U+2028', [PATTERN], 'Patterns', {'any': LINE_SEPARATOR}),
    ('. takes no U+000A', [PATTERN], 'Patterns', {'any': chr(10)}),
    ('. takes one astral character', [PATTERN], 'Patterns', {'any': SMILE}),
    ('\\s takes a tab', [PATTERN], 'Patterns', {'space': chr(9)}),
    ('\\s takes no U+00A0', [PATTERN], 'Patterns', {'space': NO_BREAK_SPACE}),
    ('\\s takes no vertical tab', [PATTERN], 'Patterns', {'space': chr(11)}),
    ('\\d takes no U+0663, an Arabic-Indic digit', [PATTERN], 'Patterns', {'digit': ARABIC_THREE}),
    ('\\w takes no letter outside ASCII', [PATTERN], 'Patterns', {'word': 'caf' + E_ACUTE}),
    ('(?i) folds U+212A, the Kelvin sign, to k', [PATTERN], 'Patterns', {'kelvin': KELVIN}),
    ('$ is the string\'s end alone: a final U+000A breaks ^a$', [PATTERN], 'Patterns', {'ends': 'a' + chr(10)}),
    ('^a$ takes a', [PATTERN], 'Patterns', {'ends': 'a'}),
    ('\\b holds at the string\'s end', [PATTERN], 'Patterns', {'word_end': 'a'}),
    ('a pattern unanchored matches anywhere in the string', [PATTERN], 'Patterns', {'anywhere': 'abc'}),
    ('a negated class takes one astral character', [PATTERN], 'Patterns', {'not_a': SMILE}),
    ('(?m) takes a line within the string', [PATTERN], 'Patterns', {'lines': 'no' + chr(10) + 'ok' + chr(10) + 'no'}),
    ('^(a+)+$ refuses 100,000 a and a !, in time linear in the string', [PATTERN], 'Patterns', {'nested': 'a' * NESTED_A + '!'},
     {'runs': [(string_record(9, 'a' * NESTED_A + '!'), 1), (b'a', NESTED_A), (b'!', 1)]}),
    ('[a-z]{1,1000}[0-9] refuses 65,536 a, in time linear in the string', [PATTERN], 'Patterns', {'counted': 'a' * COUNTED_A},
     {'runs': [(string_record(10, 'a' * COUNTED_A), 1), (b'a', COUNTED_A)]}),
    ('\\pL takes U+10940, a letter of Unicode 17.0.0', [PATTERN], 'Patterns', {'letter': SIDETIC}),
    ('\\pL takes no digit', [PATTERN], 'Patterns', {'letter': '1'}),
    ('\\p{Greek} takes Greek letters, and no Latin one', [PATTERN], 'Patterns', {'greek': chr(0x3B1) + chr(0x3B2) + 'c'}),
    ('a name of letters and marks is taken, one that opens on a hyphen is not', [PATTERN], 'Patterns', {'person': '-Jos' + E_ACUTE}),
    ('a name of letters and marks is taken', [PATTERN], 'Patterns', {'person': 'Jos' + 'e' + chr(0x301) + " O'Neil-Smith"}),
    ('a long pattern takes what it names', [PATTERN], 'Patterns', {'long': 'code-040'}),
    ('a long pattern\'s words and bounds carry it whole', [PATTERN], 'Patterns', {'long': 'code-999'}),
]


def verdicts():
    entries = []

    for name, clauses, message, value, *options in VERDICTS:
        extra = options[0] if options else {}
        entries.append(verdict(name, clauses, message, value, maximum=extra.get('maximum'), fail_fast=extra.get('fail_fast', False),
                               runs=extra.get('runs')))

    return entries


# ── The details ─────────────────────────────────────────────────────────────────────────────────


FROM = violation('from', 'int32.lte', {'lte': 10}, 'must be less than or equal to 10')
NAMES = [violation(f'names[{index}]', 'string.min_len', {'min_len': '1'}, 'must be at least 1 characters') for index in range(5)]
KEY = violation('labels["a"]', 'string.min_len', {'min_len': '2'}, 'must be at least 2 characters', for_key=True)
WIDE_BOUND = violation('wide', 'int64.lt', {'lt': '-9007199254740993'}, 'must be less than -9007199254740993')
INFINITE = violation('beyond', 'float.gt', {'gt': 'Infinity'}, 'must be greater than Infinity')
LONG_PATTERN = '^(?:' + '|'.join(f'code-{index:03d}' for index in range(60)) + ')$'
assert len(LONG_PATTERN) > 500
PATTERNED = violation('code', 'string.pattern', {'pattern': LONG_PATTERN}, f'does not match regex pattern `{LONG_PATTERN}`')
LONGER_PATTERN = LONG_PATTERN + '|' + LONG_PATTERN[2:]
PATTERNED_TWICE = violation('code', 'string.pattern', {'pattern': LONGER_PATTERN}, f'does not match regex pattern `{LONGER_PATTERN}`')
CUT_KEY = violation('keyed[' + subscript('string', LONG_KEY) + ']', 'string.max_len', {'max_len': '1'}, 'must be at most 1 characters',
                    for_key=True)
ESCAPED_KEY = violation('keyed[' + subscript('string', 'a' + chr(9) + 'b' + chr(1)) + ']', 'string.max_len', {'max_len': '1'},
                        'must be at most 1 characters', for_key=True)
ACCENTED = violation('by_text["' + E_ACUTE * 20 + '"]', 'string.min_len', {'min_len': '1'}, 'must be at least 1 characters')
REQUIRED = violation('choice', 'required', None, 'exactly one field is required in oneof')
ONEOF = violation(None, 'message.oneof', {'fields': ['x', 'y']}, 'only one of x, y can be set')


def write(name, clauses, violations, maximum, *, more=0, stopped=False):
    result = {'violations': violations, 'more': more, 'stopped': stopped}
    entry = {'name': name, 'clauses': [DETAIL, *clauses], 'write': {**{key: member for key, member in result.items()
                                                                       if member or key == 'violations'}, 'maximumBytes': maximum}}
    entry['detail'] = detail_of(result, maximum)
    assert utf8(entry['detail']) <= maximum, name
    return entry


def read(name, clauses, detail):
    return {'name': name, 'clauses': [READER, *clauses], 'detail': detail, 'read': read_detail(detail)}


def lines(*values):
    return '\n'.join(canonical(value) for value in values)


SIZE_OF_THREE = utf8(lines(*NAMES[:3])) + KEPT
DETAILS = [
    write('one violation, whole, then a closing line of no more', ['18.3.1', '18.3.2', '18.3.3', '18.3.4'], [FROM], 1024),
    write('three violations, each a line in their order', [ORDER], NAMES[:3], 1024),
    write('a bound that holds three lines of five writes them, and counts the two it leaves out', [], NAMES, SIZE_OF_THREE),
    write('a bound a byte short of three lines writes two, and counts three', [], NAMES, SIZE_OF_THREE - 1),
    write('violations the validator counted already are added to the closing line\'s count', [], NAMES[:2], 1024, more=98),
    write('a bound that holds the closing line alone writes it', [], NAMES, 12),
    write('a bound that holds no closing line writes an empty detail', [], NAMES, 9),
    write('a bound of 0 writes an empty detail', [], [FROM], 0),
    write('a judging that stopped at its first violation closes on stopped, never on a count', [FAIL_FAST], [FROM], 1024, stopped=True),
    write('a judging that stopped, in a bound that holds no line of its violation, says it stopped alone', [FAIL_FAST], [FROM], 30, stopped=True),
    write('a map key\'s violation says forKey', ['18.3.5'], [KEY], 1024),
    write('a 64-bit bound is a string', ['18.3.3'], [WIDE_BOUND], 1024),
    write('a bound not finite is the JSON mapping\'s string', ['18.3.3'], [INFINITE], 1024),
    write('a violation that does not hold whole goes without its message', [], [PATTERNED], 1024),
    write('a violation that does not hold without its message goes without its bounds too', [], [PATTERNED_TWICE], 1024),
    write('a violation whose path and rule do not hold ends the lines, and is counted', [], [FROM, CUT_KEY], 100),
    write('a short violation after one that holds in no form is counted, never written', [], [PATTERNED_TWICE, FROM], 60),
    write('a key cut at 64 bytes is written with its mark', ['18.4'], [CUT_KEY], 1024),
    write('a key\'s tab and U+0001 are written as section 17.7 writes them', ['18.4'], [ESCAPED_KEY], 1024),
    write('a bound counts UTF-8 bytes, never characters', [], [ACCENTED, ACCENTED], utf8(lines(ACCENTED)) + KEPT + 2),
    write('a oneof\'s required names the oneof', ['18.4'], [REQUIRED], 1024),
    write('a rule of the message itself has no fieldPath', ['18.3.1'], [ONEOF], 1024),
    read('a detail of the form gives its violations and its count', [],
         lines(FROM, NAMES[0], {'more': 3})),
    read('a closing line of stopped says its side stopped', [FAIL_FAST], lines(FROM, {'stopped': True})),
    read('a closing line alone gives no violation and its count', [], lines({'more': 4})),
    read('a detail cut inside its second line gives the first violation, and no count', [],
         lines(FROM, NAMES[0], {'more': 0})[:len(canonical(FROM)) + 20]),
    read('a detail cut after a whole line gives it, and no count', [], canonical(FROM)),
    read('a line without its message takes the words its rule and bounds give', ['18.8.6'],
         lines({key: member for key, member in FROM.items() if key != 'message'},
               {key: member for key, member in PATTERNED.items() if key != 'message'},
               {key: member for key, member in NAMES[1].items() if key != 'message'},
               {'fieldPath': 'distinct', 'ruleId': 'repeated.unique'},
               {'bounds': {'gt': 0.10000000149011612}, 'fieldPath': 'above_tenth', 'ruleId': 'float.gt'},
               {'bounds': {'const': 'AP8='}, 'fieldPath': 'exactly', 'ruleId': 'bytes.const'},
               {'more': 0})),
    read('a line without its bounds keeps no words where its rule needs them, nor required and message.oneof', [],
         lines({'fieldPath': 'from', 'ruleId': 'int32.lte'}, {'fieldPath': 'needed', 'ruleId': 'required'},
               {'bounds': {'fields': ['x', 'y']}, 'ruleId': 'message.oneof'}, {'more': 0})),
    read('an empty detail gives none, and no count', [], ''),
    read('a detail of another text gives none', [], 'the request is invalid'),
    read('a first line that is JSON but no violation gives none', [], lines({'error': 'invalid'}, FROM, {'more': 0})),
    read('a line that is no violation ends the violations, and what follows is unread', [],
         lines(FROM, {'ruleId': 7}, NAMES[0], {'more': 0})),
    read('a line JSON reads in another layout is read as its value', [],
         '{ "ruleId" : "int32.lte", "message" : "must be less than or equal to 10", "fieldPath" : "from", "bounds" : { "lte" : 10 } }'
         '\n{ "more" : 0 }'),
    read('a line that names a member twice is no violation', [],
         '{"fieldPath":"from","ruleId":"int32.lte","ruleId":"int32.gt"}\n{"more":0}'),
    read('a closing line whose count is below 0 counts nothing', [], lines(FROM, {'more': -1})),
]


# ── The file ────────────────────────────────────────────────────────────────────────────────────

verdict_entries = verdicts()

# * the cases where the readings part are in their order, Bead's, never one library's
by_name = {entry['name']: entry for entry in verdict_entries}
for case, order in [('pattern before len', ['string.pattern', 'string.len']),
                    ('prefix before len_bytes', ['string.prefix', 'string.len_bytes']),
                    ('in before not_contains', ['string.in', 'string.not_contains']),
                    ('bytes.prefix before bytes.len', ['bytes.prefix', 'bytes.len']),
                    ('a range before in', ['int32.gt', 'int32.in'])]:
    assert [found['ruleId'] for found in by_name[f'{case}, by their members\' numbers']['violations']] == order, case
assert [(found.get('fieldPath'), found['ruleId']) for found in by_name[
        'fields declared out of their numbers are judged by their numbers, the message\'s own rules after them']['violations']] == [
    ('inner.name', 'string.min_len'), ('early', 'int32.gt'), ('late', 'string.min_len'), (None, 'message.oneof'), ('choice', 'required')]
assert by_name['\\pL takes U+10940, a letter of Unicode 17.0.0']['violations'] == []
# ! a tripwire: google-re2's own tables predate Unicode 17.0.0, which this case shows; a pin of it that
# takes U+10940 fails here, and its case then needs a letter newer than its tables
assert re2.search('^' + B + 'pL$', SIDETIC) is None, 'google-re2 takes U+10940 as a letter: the case no longer shows its tables'
assert by_name['a request of 100,000 breaking items holds the violations its detail carries, and counts the rest exactly']['more'] == \
    MANY - len(by_name['a request of 100,000 breaking items holds the violations its detail carries, and counts the rest exactly'][
        'violations'])

for entry in DETAILS:
    if 'detail' in entry and 'write' in entry:
        # what the writer writes, the reader reads back, its words and its count
        back = read_detail(entry['detail'])
        written = entry['write']
        assert len(back['violations']) <= len(written['violations']), entry['name']

document = {
    '$schema': 'schemas/validations.schema.json',
    '$comment': [
        "Bead's payload rules: what a procedure's rules judge of its request's payload, and what PAYLOAD_INVALID's detail carries of it (spec section 18, decision 0035), which every implementation's harness plays through its side's validators and its detail's writer and reader.",
        'verdicts are payloads judged: message, the message of spec/validations.proto the payload is read as, its full name; payload, its bytes in hexadecimal, or runs, bytes repeated times each, end to end, for a payload too long to write out. Each side reads it through its stock library and judges it through the validator beadc generates for that message, as a server judges a request (18.2).',
        'maximumBytes, where given, is the bound the validator is given, the detail\'s it would write (18.6); where none is, it is given 2147483647. failFast, where true, has it stop at its first violation (18.5).',
        'violations are what it gives, in their order (18.5): each with its fieldPath (18.4), its ruleId, its bounds as protobuf\'s JSON mapping writes them, its message, and forKey where true (18.3); more, where given, the violations it judged past its bound and holds no more of, 0 where none is given; stopped, where true, that it stopped at its first. A harness checks all three, member for member.',
        'details are what a detail\'s writer writes and its reader reads (18.6, 18.7). An entry of write is what a validator gave, its violations, more and stopped, 0 and false where none is given, and the bound it is written under, maximumBytes: detail is the text the writer writes. An entry of read is a detail, the text a reader got: read is what it reads of it, its violations, each with the words it takes where it went without them, more where a closing line counts, stopped where one says so; neither where it has no closing line.',
        'Each verdict is judged by the generator, which reads the value it wrote the payload from by validate.proto v1.2.2\'s rules in 18.5\'s order, its patterns by RE2 itself, its classes of Unicode 17.0.0 by the files spec/generators/ucd.json pins; protovalidate-es judges every verdict alike but for its order, its paths\' rendering and its classes\' Unicode version.',
        'clauses are the units of spec.md an entry checks: a clause, 18.2; an item of its numbered list, 18.8.3; a row of its table, 18.3.1.',
    ],
    'specVersion': spec_version(),
    'verdicts': verdict_entries,
    'details': DETAILS,
}

with open(ROOT + 'validations.proto', 'w', encoding='utf-8', newline='\n') as file:
    file.write(proto_file())

with open(ROOT + 'validations.json', 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=False, indent=2)
    file.write('\n')

print(len(verdict_entries), 'verdicts and', len(DETAILS), 'details,', sum('write' in entry for entry in DETAILS), 'of them written and',
      sum('read' in entry for entry in DETAILS), 'read')
