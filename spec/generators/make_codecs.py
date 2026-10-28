"""Writes spec/codecs.json: what each encoding of spec section 17 reads of bytes, and what it writes back
of them or why it refuses them; and what a writer writes of a value, or why it refuses it (decisions
0016 and 0031).

Each outcome is section 17 played here a third time, beside the two sides, never written by hand: a
reader that refuses as 17.5 says, in the order the TypeScript reader checks, the depth counted over the
text before it is parsed; and a writer of RFC 8785's canonical form, ECMAScript's Number::toString from
repr's shortest digits, its strings as JSON.stringify writes a well-formed one, its names sorted by their
UTF-16 code units. A proto payload is read by a reader of Probe, spec/codecs.proto, written from
protobuf's Encoding guide and 17.9.2 to 17.9.8, its packed records, its map's entries and its group
among them, its required fields judged once the whole is read and a closed enum's undeclared number
setting nothing, and a proto value written one field at a time, refused where it leaves a required
field unset. A row that would be refused for two
reasons fails here, as does a written form that does not read back to itself. A backslash is chr(92),
so that no escape this file builds is read before it is built."""
import json
import math
import os
import re
import struct
from decimal import Decimal, getcontext

from spec_version import spec_version

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')

# a backslash, which opens a JSON escape
B = chr(92)
QUOTE = '"'

# 17.5.7: an array or an object nested deeper than this is refused, the outermost at depth 1
DEPTH = 64

BYTE_ORDER_MARK = bytes([0xEF, 0xBB, 0xBF])

# the reasons, derived, which no harness reads: a refusal answers PAYLOAD_UNDECODABLE whatever its reason
NOT_UTF8, A_BYTE_ORDER_MARK, NOT_JSON, A_NAME_TWICE = 'not UTF-8', 'a byte order mark', 'not JSON', 'a name twice'
A_SURROGATE_ALONE, PAST_A_DOUBLE, NESTED_PAST = 'a surrogate alone', 'a number past a double', 'nested past 64'
NOT_FINITE, NO_JSON_VALUE = 'not a finite number', 'no JSON value'
NOT_ITS_MESSAGE, PROTO_NESTED_PAST = 'not its message', 'nested past 100'
REQUIRED_UNSET = 'a required field unset'

# 17.9.3: a proto message nested more than this below the top one is refused, a group and a map's
# entry each counting as a message
PROTO_DEPTH = 100

# the row of docs/support.md a value crosses that a side's type cannot hold
NOT_HELD = "A value a side's type cannot hold"

# the row of docs/support.md a proto string's leading U+FEFF crosses, which a stock library strips
LEADING_FEFF = "A string's leading U+FEFF in a proto payload"


class Members(list):
    """An object's members as the bytes name them, in their order, a name given twice kept twice."""


class Undefined:
    """What a language holds that JSON has no value for: JavaScript's undefined, a C# JsonElement of kind
    Undefined."""


UNDEFINED = Undefined()


class NotJSON(Exception):
    pass


# ── The writer, 17.7 ────────────────────────────────────────────────────────────────────────────


def es(value):
    """ECMAScript's Number::toString of a finite double (ECMA-262, Number::toString), from repr's
    shortest digits: what RFC 8785 3.2.2.3 writes a number as."""
    if value == 0:
        return '0'

    if value < 0:
        return '-' + es(-value)

    _, digits, exponent = Decimal(repr(value)).as_tuple()
    digits = ''.join(map(str, digits)).lstrip('0')
    stripped = digits.rstrip('0')
    exponent += len(digits) - len(stripped)
    digits = stripped
    k, n = len(digits), exponent + len(digits)

    if k <= n <= 21:
        return digits + '0' * (n - k)

    if 0 < n <= 21:
        return digits[:n] + '.' + digits[n:]

    if -6 < n <= 0:
        return '0.' + '0' * -n + digits

    return (digits if k == 1 else digits[0] + '.' + digits[1:]) + 'e' + ('+' if n - 1 >= 0 else '-') + str(abs(n - 1))


def has_surrogate(text):
    """Whether a string holds a surrogate alone: Python holds a pair as its one character."""
    return any(0xD800 <= ord(character) <= 0xDFFF for character in text)


def utf16(name):
    """A name's UTF-16 code units, which RFC 8785 3.2.3 sorts names by."""
    return name.encode('utf-16-be', 'surrogatepass')


def members_of(value):
    return list(value) if isinstance(value, Members) else list(value.items())


def write_reasons(value, depth=0):
    """Every reason 17.7 refuses a value for, each once, in the order they are met."""
    reasons = []

    def met(reason):
        if reason not in reasons:
            reasons.append(reason)

    if value is UNDEFINED:
        met(NO_JSON_VALUE)
    elif isinstance(value, bool) or value is None:
        pass
    elif isinstance(value, (int, float)):
        if not math.isfinite(value):
            met(NOT_FINITE)
    elif isinstance(value, str):
        if has_surrogate(value):
            met(A_SURROGATE_ALONE)
    elif depth == DEPTH:
        met(NESTED_PAST)
    elif isinstance(value, list) and not isinstance(value, Members):
        for item in value:
            for reason in write_reasons(item, depth + 1):
                met(reason)
    else:
        members = sorted(members_of(value), key=lambda member: utf16(member[0]))

        for index, (name, item) in enumerate(members):
            if has_surrogate(name):
                met(A_SURROGATE_ALONE)

            # two equal names lie side by side once sorted
            if index > 0 and members[index - 1][0] == name:
                met(A_NAME_TWICE)

            for reason in write_reasons(item, depth + 1):
                met(reason)

    return reasons


def canonical(value):
    """A value's canonical form (17.7, RFC 8785 3.2), of a value write_reasons refuses nothing of."""
    if value is None:
        return 'null'

    if value is True:
        return 'true'

    if value is False:
        return 'false'

    if isinstance(value, (int, float)):
        return es(float(value))

    if isinstance(value, str):
        # Python's dumps writes each character as JSON.stringify writes a well-formed string: " and the
        # backslash, five control characters short, the others in lower-case hexadecimal
        return json.dumps(value, ensure_ascii=False)

    if isinstance(value, list) and not isinstance(value, Members):
        return '[' + ','.join(canonical(item) for item in value) + ']'

    members = sorted(members_of(value), key=lambda member: utf16(member[0]))
    return '{' + ','.join(json.dumps(name, ensure_ascii=False) + ':' + canonical(item) for name, item in members) + '}'


# ── The reader, 17.5 and 17.6 ───────────────────────────────────────────────────────────────────


def depth_of(text):
    """How deep the text nests, its strings skipped, counted before it is parsed: a string never closed
    ends the count, and the parse then refuses it."""
    deepest = depth = index = 0

    while index < len(text):
        character = text[index]

        if character == QUOTE:
            index += 1

            while index < len(text) and text[index] != QUOTE:
                index += 2 if text[index] == B else 1
        elif character in '[{':
            depth += 1
            deepest = max(deepest, depth)
        elif character in ']}':
            depth -= 1

        index += 1

    return deepest


def refuse_constant(_):
    raise NotJSON()


def read_walk(value, reasons):
    """The reasons a value parsed holds: a surrogate alone and a number past a double as one walk meets
    them, then a name twice, as the TypeScript reader scans for it after its walk."""
    pending = [value]
    twice = False

    while pending:
        item = pending.pop()

        if isinstance(item, str):
            if has_surrogate(item) and A_SURROGATE_ALONE not in reasons:
                reasons.append(A_SURROGATE_ALONE)
        elif isinstance(item, float):
            if not math.isfinite(item) and PAST_A_DOUBLE not in reasons:
                reasons.append(PAST_A_DOUBLE)
        elif isinstance(item, Members):
            names = [name for name, _ in item]
            twice = twice or len(set(names)) != len(names)
            pending.extend(names)
            pending.extend(member for _, member in item)
        elif isinstance(item, list):
            pending.extend(item)

    if twice:
        reasons.append(A_NAME_TWICE)


def plain(value):
    """A value read, its objects as dicts once no name is given twice."""
    if isinstance(value, Members):
        return {name: plain(item) for name, item in value}

    if isinstance(value, list):
        return [plain(item) for item in value]

    return value


def json_read(data):
    """Every reason 17.5 refuses the bytes for, in the order the TypeScript reader checks them, each
    check on what the ones before it leave; and the value read, a number a double, where none applies."""
    reasons = []

    if data.startswith(BYTE_ORDER_MARK):
        reasons.append(A_BYTE_ORDER_MARK)
        data = data[len(BYTE_ORDER_MARK):]

    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return [*reasons, NOT_UTF8], None

    if depth_of(text) > DEPTH:
        reasons.append(NESTED_PAST)

    try:
        # ! an integer is a double too (17.6), and NaN and Infinity, which Python's reader takes, are no JSON
        value = json.loads(text, object_pairs_hook=Members, parse_float=float, parse_int=float,
                           parse_constant=refuse_constant)
    except (ValueError, RecursionError, NotJSON):
        return [*reasons, NOT_JSON], None

    read_walk(value, reasons)
    return reasons, None if reasons else plain(value)


def text_read(data):
    """17.4: UTF-8, read strictly, a leading U+FEFF kept as a character."""
    try:
        return [], data.decode('utf-8')
    except UnicodeDecodeError:
        return [NOT_UTF8], None


# ── The proto reader and writer, 17.9 ───────────────────────────────────────────────────────────

# the wire types of protobuf's Encoding guide, "Message Structure"
VARINT, I64, LEN, SGROUP, EGROUP, I32 = 0, 1, 2, 3, 4, 5

# Probe's fields by number, as spec/codecs.proto declares them: its name, its type, and the wire types
# its records take, a repeated scalar of a numeric type its own and the length-delimited, packed or not
# (17.9.5), and a delimited message the start group's
FIELDS = {
    1: ('text', 'string', (LEN,)),
    2: ('number', 'uint32', (VARINT,)),
    3: ('child', 'Probe', (LEN,)),
    7: ('needs', 'Needs', (LEN,)),
    8: ('needs_items', 'repeated Needs', (LEN,)),
    10: ('counts', 'repeated uint32', (VARINT, LEN)),
    11: ('stamps', 'repeated fixed32', (I32, LEN)),
    12: ('children', 'map<string, Probe>', (LEN,)),
    13: ('delimited', 'Probe', (SGROUP,)),
    14: ('shade', 'Shade', (VARINT,)),
}

# Needs' fields by number, each of LEGACY_REQUIRED presence (17.9.7), and the numbers Shade, a closed
# enum, declares (17.9.8)
NEEDS = {1: ('must', 'uint32', (VARINT,)), 2: ('shade', 'Shade', (VARINT,))}
SHADES = {0: 'SHADE_DARK', 1: 'SHADE_LIGHT'}

# a map's entry, as it is on the wire: a message of its key at 1 and its value at 2 (Encoding, "Maps")
ENTRY = {1: ('key', 'string', (LEN,)), 2: ('value', 'Probe', (LEN,))}

# the 64 bits a varint holds, and the 32 of them a uint32 keeps, truncated as protobuf reads one
UINT32 = 0xFFFF_FFFF
UINT64 = 0xFFFF_FFFF_FFFF_FFFF


class NotItsMessage(Exception):
    """Bytes that are no encoding of Probe (17.9.1), or that 17.9.5 or 17.9.6 refuses."""


class NestedPast(Exception):
    """A message nested more than 100 deep below the top one, a group and a map's entry each counting
    as a message (17.9.3)."""


def declared(kind, name):
    """The body of a message or an enum spec/codecs.proto declares."""
    with open(ROOT + 'codecs.proto', encoding='utf-8') as file:
        return re.search(rf'^{kind} {name} \{{\n(.*?)^\}}', file.read(), re.MULTILINE | re.DOTALL).group(1)


def declared_fields(name='Probe'):
    """A message's fields as spec/codecs.proto declares them, each by its number: its name, its type,
    whether it is delimited, a group on the wire, and whether it is of LEGACY_REQUIRED presence."""
    return {int(number): (field, kind, 'DELIMITED' in options, 'LEGACY_REQUIRED' in options)
            for kind, field, number, options in re.findall(
                r'^ +((?:repeated )?(?:map<\w+, \w+>|\w+)) (\w+) = (\d+)((?: \[[^\]]*\])?);$',
                declared('message', name), re.MULTILINE)}


def declared_values(name):
    """An enum's values as spec/codecs.proto declares them, by number, and whether it is closed."""
    body = declared('enum', name)
    return ({int(number): value for value, number in re.findall(r'^ +(\w+) = (\d+);$', body, re.MULTILINE)},
            'option features.enum_type = CLOSED;' in body)


def proto_varint(data, at):
    """The varint at `at` and where it ends: ten bytes at most, its bits past 64 dropped (Encoding, "Base
    128 Varints")."""
    value = 0

    for index in range(10):
        if at + index >= len(data):
            raise NotItsMessage('a varint cut short')

        value |= (data[at + index] & 0x7F) << (7 * index)

        if data[at + index] < 0x80:
            return value & UINT64, at + index + 1

    raise NotItsMessage('a varint of more than ten bytes')


def proto_tag(data, at):
    """The tag at `at` and where it ends: a varint of five bytes at most and 32 bits at most, as the
    Encoding guide's reference card has it, "encoded as uint32 varint", and as protobuf's conformance
    suite refuses one in its REQUIRED BadTag_ tests."""
    tag, end = proto_varint(data, at)

    if end - at > 5:
        raise NotItsMessage('a tag of more than five bytes')

    if tag > UINT32:
        raise NotItsMessage('a tag past 32 bits')

    return tag, end


def proto_length(data, at):
    """A length-delimited record's bytes, after its length, and where it ends, within the bytes."""
    length, at = proto_varint(data, at)

    if at + length > len(data):
        raise NotItsMessage('a length past the bytes')

    return data[at:at + length], at + length


def proto_fields(data, at, group):
    """The fields of the message whose records start at `at`, each its number, its wire type and where
    its value starts, to the end of `data`, or for a group of the number `group` to its end group; then
    None and where the message ended. Each send gives where the field's value ended."""
    while at < len(data):
        tag, at = proto_tag(data, at)
        number, wire = tag >> 3, tag & 7

        if number == 0:
            raise NotItsMessage('field number 0')

        if wire == EGROUP and number == group:
            yield None, None, at
            return

        # an end group closes no group but its own, and 6 and 7 are no wire type
        if wire in (EGROUP, 6, 7):
            raise NotItsMessage(f'the wire type {wire} where a field starts')

        at = yield number, wire, at

    if group is not None:
        raise NotItsMessage('a group never closed')

    yield None, None, at


def proto_skip(data, at, number, wire, depth):
    """Where an unknown field of `number` and `wire` ends, `depth` messages below the top, its value
    skipped (Encoding, "Message Structure"): a length-delimited record whole, a group as a message to
    its own end group."""
    if wire == VARINT:
        return proto_varint(data, at)[1]

    if wire == LEN:
        return proto_length(data, at)[1]

    if wire == SGROUP:
        if depth + 1 > PROTO_DEPTH:
            raise NestedPast()

        fields = proto_fields(data, at, number)
        number, wire, at = next(fields)

        while number is not None:
            number, wire, at = fields.send(proto_skip(data, at, number, wire, depth + 1))

        return at

    width = 8 if wire == I64 else 4

    if at + width > len(data):
        raise NotItsMessage('a fixed value past the bytes')

    return at + width


def probe_of():
    """A Probe with no field set: its defaults, its fields of messages not set, and its shade unset, its
    presence explicit."""
    return {'text': '', 'number': 0, 'child': None, 'needs': None, 'needs_items': [], 'counts': [], 'stamps': [],
            'children': {}, 'delimited': None, 'shade': None}


def needs_of():
    """A Needs with no field set: each of its fields, of LEGACY_REQUIRED presence, unset."""
    return {'must': None, 'shade': None}


def closed_enum(value):
    """A closed enum's record, its varint read as an int32, as protobuf reads an enum: the number, where
    Shade declares it, or None where it does not, a record that sets nothing (17.9.8)."""
    number = value & UINT32
    number = number - (1 << 32) if number >= 1 << 31 else number
    return number if number in SHADES else None


def needs_at(needs, data, at, depth):
    """Reads the length-delimited Needs at `at` into `needs`, `depth` messages below the top, and where its
    record ends: a field given twice its last, an unknown field skipped, and a closed enum's undeclared
    number setting nothing, its field keeping what it held (17.9.8)."""
    field, at = proto_length(data, at)

    if depth > PROTO_DEPTH:
        raise NestedPast()

    fields = proto_fields(field, 0, None)
    number, wire, within = next(fields)

    while number is not None:
        if number not in NEEDS:
            number, wire, within = fields.send(proto_skip(field, within, number, wire, depth))
            continue

        name, _, wires = NEEDS[number]

        if wire not in wires:
            raise NotItsMessage('a field at a wire type its type does not take')

        value, within = proto_varint(field, within)

        if name == 'must':
            needs['must'] = value & UINT32
        elif closed_enum(value) is not None:
            needs['shade'] = closed_enum(value)

        number, wire, within = fields.send(within)

    return at


def text_at(data, at):
    """A string's record and where it ends, read strictly, a leading U+FEFF kept as a character (17.9.4),
    as 'utf-8' keeps it."""
    field, at = proto_length(data, at)

    try:
        return field.decode('utf-8'), at
    except UnicodeDecodeError as error:
        raise NotItsMessage('a string that is not UTF-8') from error


def packed(data, at, width):
    """A packed record's values and where it ends: its fixed width dividing its length, or each varint
    ending within it, the last at its end (Encoding, "Packed Repeated Fields")."""
    field, at = proto_length(data, at)

    if width is not None and len(field) % width:
        raise NotItsMessage('a packed record whose length its values do not divide')

    if width is not None:
        return [int.from_bytes(field[index:index + width], 'little') for index in range(0, len(field), width)], at

    values, within = [], 0

    while within < len(field):
        # * a varint cut short at the record's end is one that runs past it
        value, within = proto_varint(field, within)
        values.append(value & UINT32)

    return values, at


def message_at(probe, data, at, depth):
    """Reads the length-delimited message at `at` into `probe`, `depth` messages below the top, and
    where its record ends."""
    field, at = proto_length(data, at)

    if depth > PROTO_DEPTH:
        raise NestedPast()

    proto_read_into(probe, field, 0, depth, None)
    return at


def entry_at(data, at, depth):
    """A map's entry, read as the message it is on the wire, `depth` messages below the top, its key, its
    value and where its record ends: each at a wire type its type takes (17.9.5), and no other field
    (17.9.6); a key or a value not given its default, a value given twice merged."""
    field, at = proto_length(data, at)

    if depth > PROTO_DEPTH:
        raise NestedPast()

    key, value = '', None
    fields = proto_fields(field, 0, None)
    number, wire, within = next(fields)

    while number is not None:
        if number not in ENTRY:
            raise NotItsMessage("a field a map's entry does not declare")

        if wire not in ENTRY[number][2]:
            raise NotItsMessage('a field at a wire type its type does not take')

        if number == 1:
            key, within = text_at(field, within)
        else:
            value = value or probe_of()
            within = message_at(value, field, within, depth + 1)

        number, wire, within = fields.send(within)

    return key, value or probe_of(), at


def proto_read_into(probe, data, at, depth, group):
    """Reads the records from `at` into `probe`, `depth` messages below the top, to the end of `data`, or
    for a group of the number `group` to its end group, and where they ended: a scalar given twice its
    last, a message given twice merged, a repeated field's values appended, packed or not, and a map's
    key given twice its last value, as protobuf parses them (Encoding, "Last One Wins")."""
    fields = proto_fields(data, at, group)
    number, wire, at = next(fields)

    while number is not None:
        if number not in FIELDS:
            number, wire, at = fields.send(proto_skip(data, at, number, wire, depth))
            continue

        name, _, wires = FIELDS[number]

        # * 17.9.5: a field at a wire type its type does not take, which protobuf's reference parsers
        # keep as an unknown field and one stock library reads as its declared type
        if wire not in wires:
            raise NotItsMessage('a field at a wire type its type does not take')

        if name == 'text':
            probe['text'], at = text_at(data, at)
        elif name == 'number':
            value, at = proto_varint(data, at)
            probe['number'] = value & UINT32
        elif name == 'counts' and wire == VARINT:
            value, at = proto_varint(data, at)
            probe['counts'].append(value & UINT32)
        elif name == 'stamps' and wire == I32:
            if at + 4 > len(data):
                raise NotItsMessage('a fixed value past the bytes')

            probe['stamps'].append(int.from_bytes(data[at:at + 4], 'little'))
            at += 4
        elif name in ('counts', 'stamps'):
            values, at = packed(data, at, 4 if name == 'stamps' else None)
            probe[name].extend(values)
        elif name == 'children':
            key, value, at = entry_at(data, at, depth + 1)
            probe['children'][key] = value
        elif name == 'needs':
            probe['needs'] = probe['needs'] or needs_of()
            at = needs_at(probe['needs'], data, at, depth + 1)
        elif name == 'needs_items':
            probe['needs_items'].append(needs_of())
            at = needs_at(probe['needs_items'][-1], data, at, depth + 1)
        elif name == 'shade':
            # * 17.9.8: a closed enum's undeclared number sets nothing, the field keeping its last declared
            value, at = proto_varint(data, at)
            probe['shade'] = closed_enum(value) if closed_enum(value) is not None else probe['shade']
        elif name == 'child':
            probe['child'] = probe['child'] or probe_of()
            at = message_at(probe['child'], data, at, depth + 1)
        else:
            if depth + 1 > PROTO_DEPTH:
                raise NestedPast()

            probe['delimited'] = probe['delimited'] or probe_of()
            at = proto_read_into(probe['delimited'], data, at, depth + 1, number)

        number, wire, at = fields.send(at)

    return at


def code_units(text):
    """A string's UTF-16 code units in hexadecimal, four capital digits each, a space between."""
    data = text.encode('utf-16-be', 'surrogatepass')
    return ' '.join(f'{data[index]:02X}{data[index + 1]:02X}' for index in range(0, len(data), 2))


def text_of(units):
    """The string of UTF-16 code units as code_units writes them."""
    return bytes.fromhex(units.replace(' ', '')).decode('utf-16-be', 'surrogatepass')


def nested_below(probe):
    """How deep messages nest below `probe`, at the deepest: through child and delimited, and through each
    map's entry and its value, an entry counting as a message (17.9.3)."""
    deepest = 0

    for below in (probe['child'], probe['delimited']):
        if below is not None:
            deepest = max(deepest, 1 + nested_below(below))

    for value in probe['children'].values():
        deepest = max(deepest, 2 + nested_below(value))

    return deepest


def unset(needs):
    """Whether a Needs leaves a field it requires unset (17.9.7): one no record set, or a closed enum's
    number Shade does not declare, which only a value given a writer holds."""
    return needs['must'] is None or needs['shade'] not in SHADES


def leaves_unset(probe):
    """Whether a Probe holds, at any depth, a message that leaves a required field unset (17.9.7): its
    needs, each of its needs_items, then what child, each map's value and delimited hold, in turn."""
    if probe['needs'] is not None and unset(probe['needs']):
        return True

    if any(unset(item) for item in probe['needs_items']):
        return True

    below = [probe['child'], *(probe['children'][key] for key in sorted(probe['children'])), probe['delimited']]
    return any(each is not None and leaves_unset(each) for each in below)


def held(probe):
    """What was read of a Probe: its text, as UTF-16 code units, its number, and how deep messages nest
    below it."""
    return {'text': code_units(probe['text']), 'number': probe['number'], 'nested': nested_below(probe)}


def proto_read(data):
    """The one reason 17.9 refuses the bytes for, or what was read of them: the top Probe's text, its
    number and how deep messages nest below it; counts and stamps, where it holds any; children, where
    it holds any, each key's code units to what was read of its value; what was read of delimited,
    where it is set; and shade, where a record set it. Its required fields are judged once the whole is
    read, since a message given twice may set them in either of its records (17.9.7)."""
    probe = probe_of()

    try:
        proto_read_into(probe, data, 0, 0, None)
    except NotItsMessage:
        return [NOT_ITS_MESSAGE], None
    except NestedPast:
        return [PROTO_NESTED_PAST], None

    if leaves_unset(probe):
        return [REQUIRED_UNSET], None

    read = held(probe)

    for name in ('counts', 'stamps'):
        if probe[name]:
            read[name] = probe[name]

    if probe['children']:
        read['children'] = {code_units(key): held(probe['children'][key]) for key in sorted(probe['children'])}

    if probe['delimited'] is not None:
        read['delimited'] = held(probe['delimited'])

    if probe['shade'] is not None:
        read['shade'] = probe['shade']

    return [], read


def proto_varint_of(value):
    """A varint of `value` (Encoding, "Base 128 Varints")."""
    written = bytearray()

    while value >= 0x80:
        written.append(value & 0x7F | 0x80)
        value >>= 7

    return bytes(written + bytes([value]))


def proto_record(number, wire, value):
    """A record: its tag, then its value, a length-delimited one after its length."""
    return proto_varint_of(number << 3 | wire) + (proto_varint_of(len(value)) + value if wire == LEN else value)


def needs_write(needs):
    """The bytes of a Needs, each field written where it is set, at its default too, its presence
    explicit."""
    written = b''

    if needs['must'] is not None:
        written += proto_record(1, VARINT, proto_varint_of(needs['must']))

    if needs['shade'] is not None:
        written += proto_record(2, VARINT, proto_varint_of(needs['shade']))

    return written


def proto_write(probe):
    """The bytes of a Probe given one field or none, its fields in their numbers' order: a scalar at its
    default not written, its presence implicit, and child and needs written where they are set, an
    empty message included."""
    written = b''

    if probe['text']:
        written += proto_record(1, LEN, probe['text'].encode('utf-8'))

    if probe['number']:
        written += proto_record(2, VARINT, proto_varint_of(probe['number']))

    if probe['child'] is not None:
        written += proto_record(3, LEN, proto_write(probe['child']))

    if probe['needs'] is not None:
        written += proto_record(7, LEN, needs_write(probe['needs']))

    return written


def chain(below):
    """A Probe with that many messages nested below it through child, each with no field set."""
    probe = probe_of()

    for _ in range(below):
        probe = {**probe_of(), 'child': probe}

    return probe


def map_chain(entries):
    """The bytes of a Probe with that many maps' entries nested below it, each holding the next Probe as
    its value under the key '', the last with no field set: twice as many messages below the top, each
    entry counting as one."""
    written = b''

    for _ in range(entries):
        written = proto_record(12, LEN, proto_record(2, LEN, written))

    return written


# ── The payloads ────────────────────────────────────────────────────────────────────────────────

getcontext().prec = 1200

# the two doubles whose exact midpoint rows 20 and 21 read, by their 64 bits
TIE_LOW, TIE_HIGH = '000793e270fc0ae4', '000793e270fc0ae5'


def double(bits):
    return struct.unpack('>d', bytes.fromhex(bits))[0]


def bits_of(value):
    return struct.pack('>d', value).hex()


def tie():
    """The exact midpoint of the two doubles, written out whole, each of its 768 significant digits."""
    return format((Decimal(double(TIE_LOW)) + Decimal(double(TIE_HIGH))) / 2, 'e')


def past_the_tie():
    """The midpoint and a digit past it, which reads to the neighbour above."""
    mantissa, exponent = tie().split('e')
    return mantissa + '0001e' + exponent


def escaped(*codes):
    """A JSON text's escape of each UTF-16 code unit given, in hexadecimal as written."""
    return ''.join(B + 'u' + code for code in codes)


def utf8(text):
    return text.encode('utf-8')


# each payload: its name, its encoding, its units, and the bytes read
PAYLOADS = [
    ('a string outside ASCII, written as it is', 'json', ['17.7.3', '17.7.7'], utf8('"Jos' + chr(0xE9) + ' a+b <x>"')),
    ('escapes read, written as the canonical form writes them', 'json', ['17.7.3'],
     utf8(QUOTE + escaped('00e9') + B + '/' + QUOTE)),
    ('control characters: five as short escapes, the others in lower-case hexadecimal', 'json', ['17.7.3'],
     utf8(QUOTE + escaped('0008', '0009', '000A', '000C', '000D', '000B', '001F') + B + QUOTE + B + B + QUOTE)),
    ('U+007F, U+2028, U+2029 and U+FEFF within a string, written as they are', 'json', ['17.7.3'],
     utf8(QUOTE + escaped('007F', '2028', '2029', 'FEFF') + QUOTE)),
    ('a pair of surrogates escaped, written as its character', 'json', ['17.7.3', '17.7.7'],
     utf8(QUOTE + escaped('D83D', 'DE00') + QUOTE)),
    ('a noncharacter escaped, taken', 'json', ['17.6'], utf8(QUOTE + escaped('FFFF') + QUOTE)),
    ('a noncharacter in UTF-8, taken', 'json', ['17.6'], utf8(QUOTE + chr(0xFFFF) + QUOTE)),
    ('1.0 is 1', 'json', ['17.6', '17.7.4'], b'1.0'),
    ('1E2 is 100', 'json', ['17.7.4'], b'1E2'),
    ('-0 is 0', 'json', ['17.7.4'], b'-0'),
    ('1e21 in exponent form', 'json', ['17.7.4'], b'1e21'),
    ('1e20 in full', 'json', ['17.7.4'], b'100000000000000000000'),
    ('1e-7 in exponent form', 'json', ['17.7.4'], b'0.0000001'),
    ('0.000001 in full', 'json', ['17.7.4'], b'1e-6'),
    ('an integer past 2^53 rounded to its double', 'json', ['17.6'], b'12345678901234567890'),
    ('2^53 + 1 rounded to 2^53', 'json', ['17.6'], b'9007199254740993'),
    ('a number under the smallest double reads as 0', 'json', ['17.6'], b'1e-400'),
    ('a negative number under the smallest double reads as 0', 'json', ['17.6', '17.7.4'], b'-1e-400'),
    # 2⁻¹⁰⁷⁵, half the smallest positive double, lies between these two: at it, the tie goes to the even, 0
    ('a number just under half the smallest double reads as 0', 'json', ['17.6'], b'2.4703282292062327e-324'),
    ('a number just over half the smallest double reads as the smallest', 'json', ['17.6'], b'2.4703282292062328e-324'),
    ('more digits than a double holds, rounded', 'json', ['17.6'], b'3.141592653589793238462643383279'),
    ('a tie between two doubles, read to the even', 'json', ['17.6'], utf8(tie())),
    ('a digit past a tie, read to the neighbour above', 'json', ['17.6'], utf8(past_the_tie())),
    ('members sorted', 'json', ['17.7.6'], b'{"b":1,"a":2}'),
    ("members sorted by their UTF-16 code units, RFC 8785's example", 'json', ['17.7.6'],
     utf8('{"' + escaped('20ac') + '":0,"' + B + 'r":1,"' + escaped('fb33') + '":2,"1":3,"' + escaped('d83d', 'de00')
          + '":4,"' + escaped('0080') + '":5,"' + escaped('00f6') + '":6}')),
    ('names an ECMAScript object holds first, sorted as any other', 'json', ['17.7.6'], b'{"b":1,"10":2,"9":3}'),
    ('a member named __proto__, written as any other', 'json', ['17.7.6'], b'{"__proto__":{"a":1},"b":2}'),
    ('members sorted within an array, its elements in their order', 'json', ['17.7.5', '17.7.6'],
     b'[{"b":1,"a":2},[3,1]]'),
    ('white space between tokens dropped', 'json', ['17.7.1'], b'[ 1 , 2 ]'),
    ('white space of each kind dropped', 'json', ['17.7.1'],
     utf8(' [ 1 ,' + chr(9) + '2 ,' + chr(13) + chr(10) + '3 ] ')),
    ('literals', 'json', ['17.7.2'], b'[true,false,null]'),
    ('empty containers', 'json', ['17.7.5', '17.7.6'], b'[{},[]]'),
    ('a string alone', 'json', ['17.5'], b'"x"'),
    ('64 arrays nested', 'json', ['17.5.7'], b'[' * DEPTH + b']' * DEPTH),
    ('64 objects nested', 'json', ['17.5.7'], b'{"a":' * (DEPTH - 1) + b'{}' + b'}' * (DEPTH - 1)),
    ('a canonical payload, written back to its bytes', 'json', ['17.8'], utf8('{"a":1,"b":"Jos' + chr(0xE9) + '"}')),
    ("section 17.8's example", 'json', ['17.8'], utf8('{ "b" : "Jos' + escaped('00e9') + '", "a" : 1.0 }')),
    ('empty', 'json', ['17.5.3'], b''),
    ('a byte that is no JSON', 'json', ['17.5.1'], bytes([0xFF])),
    ('a byte not UTF-8 within a string', 'json', ['17.5.1'], b'"' + bytes([0xFF]) + b'"'),
    ("a surrogate's code point in UTF-8", 'json', ['17.5.1'], b'"' + bytes([0xED, 0xA0, 0x80]) + b'"'),
    ('an overlong form', 'json', ['17.5.1'], b'"' + bytes([0xC0, 0x80]) + b'"'),
    ('a byte order mark', 'json', ['17.5.2'], BYTE_ORDER_MARK + b'1'),
    ('a name twice', 'json', ['17.5.4'], b'{"a":1,"a":2}'),
    ('a name twice, one of them escaped', 'json', ['17.5.4'], utf8('{"a":1,"' + escaped('0061') + '":2}')),
    ('a name twice, nested', 'json', ['17.5.4'], b'[{"a":1},{"b":{"c":1,"c":1}}]'),
    ('a surrogate alone, escaped', 'json', ['17.5.5'], utf8(QUOTE + escaped('D800') + QUOTE)),
    ('a surrogate alone, escaped in a name', 'json', ['17.5.5'], utf8('{"' + escaped('DC00') + '":1}')),
    ('two surrogates in the wrong order', 'json', ['17.5.5'], utf8(QUOTE + escaped('DC00', 'D800') + QUOTE)),
    ('a number past the largest double', 'json', ['17.5.6'], b'1E400'),
    ('a negative number past the largest double', 'json', ['17.5.6'], b'-1E400'),
    ('65 arrays nested', 'json', ['17.5.7'], b'[' * (DEPTH + 1) + b']' * (DEPTH + 1)),
    ('65 objects nested', 'json', ['17.5.7'], b'{"a":' * DEPTH + b'{}' + b'}' * DEPTH),
    ('a trailing comma', 'json', ['17.5.3'], b'[1,]'),
    ('a comment', 'json', ['17.5.3'], b'[1/*x*/]'),
    ('the word NaN', 'json', ['17.5.3'], b'NaN'),
    ('a leading zero', 'json', ['17.5.3'], b'01'),
    ('two values', 'json', ['17.5.3'], b'1 2'),
    ('a no-break space', 'json', ['17.5.3'], bytes([0xC2, 0xA0]) + b'1'),
    ('cut short', 'json', ['17.5.3'], b'[1'),
    ('a string outside ASCII', 'text', ['17.4'], utf8('Jos' + chr(0xE9))),
    ('an empty string', 'text', ['17.4'], b''),
    ('a leading U+FEFF, kept', 'text', ['17.4.2'], BYTE_ORDER_MARK + b'1'),
    ('a noncharacter', 'text', ['17.4'], utf8(chr(0xFFFF))),
    ('a byte not UTF-8', 'text', ['17.4.1'], bytes([0xFF])),
    ("a surrogate's code point", 'text', ['17.4.1'], bytes([0xED, 0xA0, 0x80])),
    ('an overlong form, in a text', 'text', ['17.4.1'], bytes([0xC0, 0x80])),
    ('a sequence cut short', 'text', ['17.4.1'], bytes([0xC3])),
    ('bytes no text holds', 'raw', ['17.3'], bytes([0xFF, 0x00])),
    ('no bytes', 'raw', ['17.3'], b''),
    ('a byte order mark, a byte like any other', 'raw', ['17.3'], BYTE_ORDER_MARK),
    ('an empty payload', 'proto', ['17.9.2'], b''),
    ('a string and a number', 'proto', ['17.9'], bytes.fromhex('0A 01 61 10 07')),
    ('a length past the bytes', 'proto', ['17.9.1'], bytes.fromhex('0A 05 61 62')),
    ('a varint cut short', 'proto', ['17.9.1'], bytes.fromhex('10 80')),
    ('a tag alone', 'proto', ['17.9.1'], bytes.fromhex('0A')),
    ('a string that is not UTF-8', 'proto', ['17.9.1'], bytes.fromhex('0A 01 FF')),
    ('an overlong form in a string', 'proto', ['17.9.1'], bytes.fromhex('0A 02 C0 AF')),
    ('a surrogate in UTF-8', 'proto', ['17.9.1'], bytes.fromhex('0A 03 ED A0 80')),
    ("a string's leading U+FEFF", 'proto', ['17.9.4'], bytes.fromhex('0A 04 EF BB BF 61')),
    ("U+FEFF after a string's first character", 'proto', ['17.9'], bytes.fromhex('0A 04 61 EF BB BF')),
    ('a noncharacter, U+FFFF', 'proto', ['17.9'], bytes.fromhex('0A 03 EF BF BF')),
    ('U+0000', 'proto', ['17.9'], bytes.fromhex('0A 01 00')),
    ('an unknown field after the known', 'proto', ['17.9'], bytes.fromhex('0A 01 61 78 07')),
    ('an unknown field before the known', 'proto', ['17.9'], bytes.fromhex('78 07 0A 01 61')),
    ('an unknown field of each wire type', 'proto', ['17.9'],
     bytes.fromhex('21 01 02 03 04 05 06 07 08 2A 01 7A 35 01 02 03 04')),
    ('a number given at its default', 'proto', ['17.9'], bytes.fromhex('10 00')),
    ('a scalar given twice', 'proto', ['17.9'], bytes.fromhex('10 01 10 02')),
    # * the first child holds one of its own and the second does not: merged, two nest below the top
    ('a message given twice', 'proto', ['17.9'], bytes.fromhex('1A 02 1A 00 1A 02 10 01')),
    ('a message field set to the empty message', 'proto', ['17.9'], bytes.fromhex('1A 00')),
    ('field number 0', 'proto', ['17.9.1'], bytes.fromhex('00 01')),
    ('a varint of 10 bytes', 'proto', ['17.9'], bytes.fromhex('10' + ' FF' * 9 + ' 01')),
    ('a varint of 11 bytes', 'proto', ['17.9.1'], bytes.fromhex('10' + ' 80' * 10 + ' 01')),
    ('an unknown varint of 10 bytes', 'proto', ['17.9'], bytes.fromhex('48' + ' 80' * 9 + ' 00')),
    ('an unknown varint of 11 bytes', 'proto', ['17.9.1'], bytes.fromhex('48' + ' 80' * 10 + ' 00')),
    # * a message's records end where its length ends: one that runs on reads its parent's bytes
    ('an unknown record past the end of its message', 'proto', ['17.9.1'],
     bytes.fromhex('0A 01 61 1A 02 25 00 0A 01 62')),
    ('a string past the end of its message', 'proto', ['17.9.1'], bytes.fromhex('1A 02 0A 03 61 62 63')),
    # a tag is a uint32 varint: protobuf's BadTag_ tests, each on field 2, Probe's varint, so that none
    # crosses the row of a field at a wire type not its own as well
    ('a tag of 5 bytes within 32 bits', 'proto', ['17.9'], bytes.fromhex('C8 80 80 80 00 01 0A 01 62')),
    ('a tag of 6 bytes', 'proto', ['17.9.1'], bytes.fromhex('90 80 80 80 80 00 07')),
    # BadTag_OverlongVarint
    ('a tag of 9 bytes', 'proto', ['17.9.1'], bytes.fromhex('90 80 80 80 80 80 80 80 00 07')),
    # BadTag_FieldNumberSlightlyTooHigh
    ('a tag of 5 bytes past 32 bits', 'proto', ['17.9.1'], bytes.fromhex('90 80 80 80 40 07')),
    # BadTag_FieldNumberTooHigh
    ('a tag of 7 bytes past 32 bits', 'proto', ['17.9.1'], bytes.fromhex('90 80 80 80 80 80 0F 07')),
    ('a tag past 32 bits, of an unknown field', 'proto', ['17.9.1'], bytes.fromhex('F8 FF FF FF 7F 01')),
    # BadTag_VarintMoreThanTenBytes
    ('a tag of more than 10 bytes', 'proto', ['17.9.1'], bytes.fromhex('90' + ' 80' * 11 + ' 00 07')),
    # a length is an int32 varint: protobuf's BadLength_Varint32BitOverflow
    ('a length past 32 bits', 'proto', ['17.9.1'], bytes.fromhex('0A 80 80 80 80 10')),
    ('a length past 32 bits, a field after', 'proto', ['17.9.1'], bytes.fromhex('0A 80 80 80 80 10 10 07')),
    # a field Probe declares, at a wire type its type does not take: refused, its map's entries' included
    ('a string at the varint wire type', 'proto', ['17.9.5'], bytes.fromhex('08 61')),
    ('a uint32 at the length-delimited wire type', 'proto', ['17.9.5'], bytes.fromhex('12 00')),
    ('a uint32 at the fixed32 wire type', 'proto', ['17.9.5'], bytes.fromhex('15 01 02 03 04')),
    # * one stock library reads 03 as the child's length, and the text after as the child's, past it
    ('a message at the varint wire type, a string after', 'proto', ['17.9.5'],
     bytes.fromhex('18 03 0A 05 61 62 63 64 65')),
    ('stamps at the varint wire type', 'proto', ['17.9.5'], bytes.fromhex('58 01')),
    ('delimited at the length-delimited wire type', 'proto', ['17.9.5'], bytes.fromhex('6A 03 0A 01 61')),
    # * one stock library reads 02 as the key's length, and the value's record as the key
    ("a map's key at the varint wire type", 'proto', ['17.9.5'], bytes.fromhex('62 04 08 02 12 00')),
    # * one stock library reads the undeclared field's bytes as the entry's key and value: z to abcd, where
    # protobuf's reference parsers skip it and read '' to an empty Probe
    ("a map's entry with a field it does not declare", 'proto', ['17.9.6'],
     bytes.fromhex('62 0C 1A 0A 01 7A 12 06 0A 04 61 62 63 64')),
    ('an end group no group opened', 'proto', ['17.9.1'], bytes.fromhex('24')),
    ('an unknown group, closed', 'proto', ['17.9'], bytes.fromhex('23 24')),
    ('an unknown group never closed', 'proto', ['17.9.1'], bytes.fromhex('23')),
    # a repeated scalar of a numeric type, packed or not, and a packed record's values ending at its end
    ('counts packed', 'proto', ['17.9'], bytes.fromhex('52 03 01 02 03')),
    ('counts unpacked and packed, in one message', 'proto', ['17.9'], bytes.fromhex('50 01 52 02 02 03')),
    ('stamps unpacked', 'proto', ['17.9'], bytes.fromhex('5D 01 00 00 00')),
    ('stamps packed', 'proto', ['17.9'], bytes.fromhex('5A 08 01 00 00 00 02 00 00 00')),
    ('a packed fixed32 whose length is no multiple of 4', 'proto', ['17.9.1'],
     bytes.fromhex('5A 05 01 00 00 00 02')),
    # * one stock library reads 81 01 as a value, past the record, then 10 07 as the number 7
    ('a packed uint32 whose last varint runs past its record, a field after', 'proto', ['17.9.1'],
     bytes.fromhex('52 02 05 81 01 10 07')),
    # a map's entry, a message on the wire, whatever the order of its fields
    ("a map's entry, its value before its key", 'proto', ['17.9'], bytes.fromhex('62 07 12 03 0A 01 78 0A 00')),
    # a group: delimited, closed by an end group of its own number
    ('a group closed by its own end group', 'proto', ['17.9'], bytes.fromhex('6B 0A 01 61 6C')),
    ("a group closed by another number's end group", 'proto', ['17.9.1'], bytes.fromhex('6B 0A 01 61 44')),
    ('a group never closed', 'proto', ['17.9.1'], bytes.fromhex('6B 0A 01 61')),
    ('99 messages below the top', 'proto', ['17.9.3'], proto_write(chain(PROTO_DEPTH - 1))),
    ('100 messages below the top', 'proto', ['17.9.3'], proto_write(chain(PROTO_DEPTH))),
    ('101 messages below the top', 'proto', ['17.9.3'], proto_write(chain(PROTO_DEPTH + 1))),
    # * each entry counts as a message, so 50 deep is 100 below the top and 51 is 102, which one stock
    # library, counting a map's value alone, reads
    ('50 maps deep, 100 messages below the top, each entry counted', 'proto', ['17.9.3'],
     map_chain(PROTO_DEPTH // 2)),
    ('51 maps deep, 102 messages below the top, each entry counted', 'proto', ['17.9.3'],
     map_chain(PROTO_DEPTH // 2 + 1)),
    # a message that leaves a required field unset, at any depth, judged once the whole is read (17.9.7)
    ('a required field unset, one below the top', 'proto', ['17.9.7'], bytes.fromhex('3A 02 10 00')),
    ('required fields set at their defaults', 'proto', ['17.9.7'], bytes.fromhex('3A 04 08 00 10 00')),
    ('required fields none of which is given', 'proto', ['17.9.7'], bytes.fromhex('3A 00')),
    ('a message given twice, its required fields in its first record', 'proto', ['17.9.7'],
     bytes.fromhex('3A 04 08 01 10 00 3A 00')),
    ('a message given twice, its required fields in its second record', 'proto', ['17.9.7'],
     bytes.fromhex('3A 00 3A 04 08 01 10 00')),
    ('a message given twice, its required fields split between its records', 'proto', ['17.9.7'],
     bytes.fromhex('3A 02 08 01 3A 02 10 00')),
    ('an item that leaves a required field unset', 'proto', ['17.9.7'], bytes.fromhex('42 04 08 00 10 00 42 02 08 00')),
    ("a map's value whose message leaves a required field unset", 'proto', ['17.9.7'], bytes.fromhex('62 04 12 02 3A 00')),
    ("a map's key given twice, its last value whole", 'proto', ['17.9.7'],
     bytes.fromhex('62 04 12 02 3A 00 62 08 12 06 3A 04 08 00 10 00')),
    ("a map's key given twice, its first value whole", 'proto', ['17.9.7'],
     bytes.fromhex('62 08 12 06 3A 04 08 00 10 00 62 04 12 02 3A 00')),
    ('a group that leaves a required field unset', 'proto', ['17.9.7'], bytes.fromhex('6B 3A 00 6C')),
    ('a child that leaves a required field unset', 'proto', ['17.9.7'], bytes.fromhex('1A 02 3A 00')),
    ("a required closed enum's number its enum does not declare", 'proto', ['17.9.7'],
     bytes.fromhex('3A 04 08 00 10 05')),
    ('a required closed enum given a declared number, then one it does not declare', 'proto', ['17.9.7'],
     bytes.fromhex('3A 06 08 00 10 01 10 05')),
    # a closed enum's undeclared number sets nothing on a singular field (17.9.8)
    ("a closed enum's number its enum does not declare, which sets nothing", 'proto', ['17.9.8'], bytes.fromhex('70 05')),
    ("a closed enum's declared number, then one it does not declare", 'proto', ['17.9.8'], bytes.fromhex('70 01 70 05')),
]

# the payloads a stock library reads otherwise than 17.9 says, each by the rows it crosses and the
# languages they excuse
PROTO_DIFFERS = {
    "a string's leading U+FEFF": [(LEADING_FEFF, 'TypeScript')],
}


def hexadecimal(data):
    return ' '.join(f'{byte:02X}' for byte in data)


def payload_outcome(encoding, data):
    """The bytes written back of what was read, or for proto what was read, or the one reason it is
    refused for."""
    if encoding == 'raw':
        return {'written': hexadecimal(data)}

    if encoding == 'proto':
        reasons, read = proto_read(data)
        return {'refused': reasons[0]} if reasons else {'read': read}

    reasons, value = (json_read if encoding == 'json' else text_read)(data)
    assert len(reasons) <= 1, (data, reasons)

    if reasons:
        return {'refused': reasons[0]}

    written = utf8(canonical(value)) if encoding == 'json' else utf8(value)

    # what is written reads back to itself
    again, value_again = (json_read if encoding == 'json' else text_read)(written)
    assert not again and (utf8(canonical(value_again)) if encoding == 'json' else utf8(value_again)) == written, data

    return {'written': hexadecimal(written)}


def payload_entry(name, encoding, clauses, data):
    differs = PROTO_DIFFERS.get(name, []) if encoding == 'proto' else []

    return {'name': name, 'encoding': encoding, 'clauses': clauses, 'bytes': hexadecimal(data),
            **payload_outcome(encoding, data),
            **({'differs': [{'row': row, 'language': language} for row, language in differs]} if differs else {})}


# ── The values ──────────────────────────────────────────────────────────────────────────────────

# RFC 8785's Appendix B: each double by its 64 bits, its name here, and the JSON it writes, or none for
# its two that are not finite
APPENDIX_B = [
    ('0000000000000000', 'zero', '0'),
    ('8000000000000000', 'minus zero', '0'),
    ('0000000000000001', 'the smallest positive double', '5e-324'),
    ('8000000000000001', 'the negative double nearest 0', '-5e-324'),
    ('7fefffffffffffff', 'the largest double', '1.7976931348623157e+308'),
    ('ffefffffffffffff', 'the most negative double', '-1.7976931348623157e+308'),
    ('4340000000000000', '2^53', '9007199254740992'),
    ('c340000000000000', '-2^53', '-9007199254740992'),
    ('4430000000000000', 'about 2^68', '295147905179352830000'),
    ('7fffffffffffffff', 'NaN', None),
    ('7ff0000000000000', 'Infinity', None),
    ('44b52d02c7e14af5', 'the double below 1e+23', '9.999999999999997e+22'),
    ('44b52d02c7e14af6', '1e+23', '1e+23'),
    ('44b52d02c7e14af7', 'the double above 1e+23', '1.0000000000000001e+23'),
    ('444b1ae4d6e2ef4e', 'two doubles below 1e+21', '999999999999999700000'),
    ('444b1ae4d6e2ef4f', 'the double below 1e+21', '999999999999999900000'),
    ('444b1ae4d6e2ef50', '1e+21', '1e+21'),
    ('3eb0c6f7a0b5ed8c', 'the double below 0.000001', '9.999999999999997e-7'),
    ('3eb0c6f7a0b5ed8d', '0.000001', '0.000001'),
    ('41b3de4355555553', '333333333.3333332', '333333333.3333332'),
    ('41b3de4355555554', '333333333.33333325', '333333333.33333325'),
    ('41b3de4355555555', '333333333.3333333', '333333333.3333333'),
    ('41b3de4355555556', '333333333.3333334', '333333333.3333334'),
    ('41b3de4355555557', '333333333.33333343', '333333333.33333343'),
    ('becbf647612f3696', '-0.0000033333333333333333', '-0.0000033333333333333333'),
    ('43143ff3c1cb0959', '1424953923781206.2, a tie written to the even', '1424953923781206.2'),
]

LONE = 'a' + chr(0xD800) + 'b'

# the forms no JSON text holds, each as the writer here is given it
FORMS = {
    'loneSurrogate': LONE,
    'loneSurrogateName': {LONE: 1},
    'nameTwice': Members([('a', 1), ('a', 2)]),
    'undefined': UNDEFINED,
}


def nested(depth):
    value = []

    for _ in range(depth - 1):
        value = [value]

    return value


# each value: its name, its encoding, its units, the value as the file gives it, and the language that
# cannot be given it
VALUES = [
    *[(name, 'json', ['17.7.4'], {'double': bits}, None) if written is not None
      else (name, 'json', ['17.7'], {'double': bits}, 'C#') for bits, name, written in APPENDIX_B],
    ('a surrogate alone', 'json', ['17.7'], {'form': 'loneSurrogate'}, None),
    ('a surrogate alone in a name', 'json', ['17.7'], {'form': 'loneSurrogateName'}, None),
    ('an object naming a member twice', 'json', ['17.7'], {'form': 'nameTwice'}, 'TypeScript'),
    ('64 arrays nested', 'json', ['17.7'], {'nested': DEPTH}, None),
    ('65 arrays nested', 'json', ['17.7'], {'nested': DEPTH + 1}, None),
    ('undefined', 'json', ['17.7'], {'form': 'undefined'}, None),
    ('names an ECMAScript object holds first, sorted as any other', 'json', ['17.7.6'],
     {'json': {'b': 1, '10': 2, '9': 3}}, None),
    ('a member named __proto__, written as any other', 'json', ['17.7.6'],
     {'json': {'__proto__': {'a': 1}, 'b': 2}}, None),
    ('a tie given as its digits, written as the even neighbour', 'json', ['17.6', '17.7.4'], {'number': tie()}, None),
    ('a string outside ASCII', 'text', ['17.4'], {'text': 'Jos' + chr(0xE9)}, None),
    ('a surrogate alone in a text', 'text', ['17.4.3'], {'form': 'loneSurrogate'}, None),
    ('bytes no text holds', 'raw', ['17.3'], {'bytes': hexadecimal(bytes([0xFF, 0x00]))}, None),
    ('text set to a', 'proto', ['17.9'], {'probe': {'text': code_units('a')}}, None),
    ('number set to 7', 'proto', ['17.9'], {'probe': {'number': 7}}, None),
    ('number set to 0, its default', 'proto', ['17.9'], {'probe': {'number': 0}}, None),
    ('no field set', 'proto', ['17.9.2'], {'probe': {}}, None),
    ('child set to the empty message', 'proto', ['17.9'], {'probe': {'child': {}}}, None),
    ('text set to a leading U+FEFF and a', 'proto', ['17.9.4'], {'probe': {'text': code_units(chr(0xFEFF) + 'a')}},
     None),
    ('needs set to no field', 'proto', ['17.9.7'], {'probe': {'needs': {}}}, None),
    ('needs set at its defaults', 'proto', ['17.9.7'], {'probe': {'needs': {'must': 0, 'shade': 0}}}, None),
    ('needs with a shade its enum does not declare', 'proto', ['17.9.7'], {'probe': {'needs': {'must': 0, 'shade': 5}}},
     None),
]


def given(value):
    """The value a writer is given, built from the form the file gives it in."""
    if 'json' in value:
        return value['json']

    if 'double' in value:
        return double(value['double'])

    if 'number' in value:
        return float(value['number'])

    if 'nested' in value:
        return nested(value['nested'])

    if 'form' in value:
        return FORMS[value['form']]

    if 'probe' in value:
        given_probe = value['probe']
        assert len(given_probe) <= 1, given_probe
        return {**probe_of(), **({'text': text_of(given_probe['text'])} if 'text' in given_probe else {}),
                **({'number': given_probe['number']} if 'number' in given_probe else {}),
                **({'child': probe_of()} if 'child' in given_probe else {}),
                **({'needs': {**needs_of(), **given_probe['needs']}} if 'needs' in given_probe else {})}

    return value['text'] if 'text' in value else bytes.fromhex(value['bytes'])


def value_outcome(encoding, value):
    """The bytes written of a value, or the one reason it is refused for: a proto value, one field or
    none, refused where it leaves a required field unset (17.9.7), as a reader refuses its bytes."""
    if encoding == 'raw':
        return {'written': hexadecimal(value)}

    if encoding == 'text':
        return {'refused': A_SURROGATE_ALONE} if has_surrogate(value) else {'written': hexadecimal(utf8(value))}

    if encoding == 'proto':
        if leaves_unset(value):
            return {'refused': REQUIRED_UNSET}

        written = proto_write(value)

        # what is written reads back to the value given: its text, its number, and its child's presence
        reasons, read = proto_read(written)
        assert not reasons and read == held(value), written

        return {'written': hexadecimal(written)}

    reasons = write_reasons(value)
    assert len(reasons) <= 1, (value, reasons)

    if reasons:
        return {'refused': reasons[0]}

    written = utf8(canonical(value))

    # what is written reads back to itself
    again, value_again = json_read(written)
    assert not again and utf8(canonical(value_again)) == written, written

    return {'written': hexadecimal(written)}


def value_entry(name, encoding, clauses, value, excused):
    outcome = value_outcome(encoding, given(value))
    # a value refused plays 17.2 besides its own clause: a writer never writes what a reader refuses
    cited = ['17.2', *clauses] if 'refused' in outcome else clauses
    return {'name': name, 'encoding': encoding, 'clauses': cited, 'value': value, **outcome,
            **({'differs': [{'row': NOT_HELD, 'language': excused}]} if excused else {})}


# what the record states, held here against a slip in the rules above: Appendix B's numbers, and the tie
for bits, name, written in APPENDIX_B:
    assert (es(double(bits)) if written is not None else None) == written or not math.isfinite(double(bits)), name

assert bits_of(float(tie())) == TIE_LOW and bits_of(float(past_the_tie())) == TIE_HIGH
assert len(utf8(tie())) == 774

# the reader's fields are the ones spec/codecs.proto declares, its delimited one alone a group on the wire,
# Needs' all of LEGACY_REQUIRED presence and none of Probe's, and Shade's values a closed enum's
assert declared_fields() == {number: (name, kind, wires == (SGROUP,), False)
                             for number, (name, kind, wires) in FIELDS.items()}, declared_fields()
assert declared_fields('Needs') == {number: (name, kind, False, True) for number, (name, kind, _) in NEEDS.items()}, \
    declared_fields('Needs')
assert declared_values('Shade') == (SHADES, True), declared_values('Shade')

payloads = [payload_entry(*entry) for entry in PAYLOADS]
values = [value_entry(*entry) for entry in VALUES]

assert len(payloads) == 148 and len(values) == 47



def taken(text, number, nested, **more):
    """A proto row taken: what was read of the top Probe, its text, its number, how deep messages nest
    below it, and what else it holds."""
    return {'text': text, 'number': number, 'nested': nested, **more}


# the proto rows as 0031 and 0028 state them, each taken with what was read, or refused for its reason;
# and the deep rows' bytes as protobuf's writers write them
FEFF_A, A_FEFF = code_units(chr(0xFEFF) + 'a'), code_units('a' + chr(0xFEFF))
PROTO_RECORD = {
    'an empty payload': ('', 0, 0), 'a string and a number': ('0061', 7, 0),
    'a length past the bytes': NOT_ITS_MESSAGE, 'a varint cut short': NOT_ITS_MESSAGE, 'a tag alone': NOT_ITS_MESSAGE,
    'a string that is not UTF-8': NOT_ITS_MESSAGE, 'an overlong form in a string': NOT_ITS_MESSAGE,
    'a surrogate in UTF-8': NOT_ITS_MESSAGE, "a string's leading U+FEFF": (FEFF_A, 0, 0),
    "U+FEFF after a string's first character": (A_FEFF, 0, 0), 'a noncharacter, U+FFFF': ('FFFF', 0, 0),
    'U+0000': ('0000', 0, 0), 'an unknown field after the known': ('0061', 0, 0),
    'an unknown field before the known': ('0061', 0, 0), 'an unknown field of each wire type': ('', 0, 0),
    'a number given at its default': ('', 0, 0), 'a scalar given twice': ('', 2, 0),
    'a message given twice': ('', 0, 2), 'a message field set to the empty message': ('', 0, 1),
    'field number 0': NOT_ITS_MESSAGE, 'a varint of 10 bytes': ('', 4_294_967_295, 0),
    'a varint of 11 bytes': NOT_ITS_MESSAGE, 'an unknown varint of 10 bytes': ('', 0, 0),
    'an unknown varint of 11 bytes': NOT_ITS_MESSAGE, 'an unknown record past the end of its message': NOT_ITS_MESSAGE,
    'a string past the end of its message': NOT_ITS_MESSAGE, 'a tag of 5 bytes within 32 bits': ('0062', 0, 0),
    'a tag of 6 bytes': NOT_ITS_MESSAGE, 'a tag of 9 bytes': NOT_ITS_MESSAGE,
    'a tag of 5 bytes past 32 bits': NOT_ITS_MESSAGE, 'a tag of 7 bytes past 32 bits': NOT_ITS_MESSAGE,
    'a tag past 32 bits, of an unknown field': NOT_ITS_MESSAGE, 'a tag of more than 10 bytes': NOT_ITS_MESSAGE,
    'a length past 32 bits': NOT_ITS_MESSAGE, 'a length past 32 bits, a field after': NOT_ITS_MESSAGE,
    'an end group no group opened': NOT_ITS_MESSAGE,
    'an unknown group, closed': ('', 0, 0), 'an unknown group never closed': NOT_ITS_MESSAGE,
    '99 messages below the top': ('', 0, 99), '100 messages below the top': ('', 0, 100),
    '101 messages below the top': PROTO_NESTED_PAST,
    'a string at the varint wire type': NOT_ITS_MESSAGE, 'a uint32 at the length-delimited wire type': NOT_ITS_MESSAGE,
    'a uint32 at the fixed32 wire type': NOT_ITS_MESSAGE,
    'a message at the varint wire type, a string after': NOT_ITS_MESSAGE,
    'stamps at the varint wire type': NOT_ITS_MESSAGE, 'delimited at the length-delimited wire type': NOT_ITS_MESSAGE,
    "a map's key at the varint wire type": NOT_ITS_MESSAGE,
    "a map's entry with a field it does not declare": NOT_ITS_MESSAGE,
    'counts packed': taken('', 0, 0, counts=[1, 2, 3]),
    'counts unpacked and packed, in one message': taken('', 0, 0, counts=[1, 2, 3]),
    'stamps unpacked': taken('', 0, 0, stamps=[1]), 'stamps packed': taken('', 0, 0, stamps=[1, 2]),
    'a packed fixed32 whose length is no multiple of 4': NOT_ITS_MESSAGE,
    'a packed uint32 whose last varint runs past its record, a field after': NOT_ITS_MESSAGE,
    "a map's entry, its value before its key": taken('', 0, 2, children={'': taken('0078', 0, 0)}),
    'a group closed by its own end group': taken('', 0, 1, delimited=taken('0061', 0, 0)),
    "a group closed by another number's end group": NOT_ITS_MESSAGE, 'a group never closed': NOT_ITS_MESSAGE,
    '50 maps deep, 100 messages below the top, each entry counted': taken('', 0, 100, children={'': taken('', 0, 98)}),
    '51 maps deep, 102 messages below the top, each entry counted': PROTO_NESTED_PAST,
    'a required field unset, one below the top': REQUIRED_UNSET, 'required fields set at their defaults': ('', 0, 0),
    'required fields none of which is given': REQUIRED_UNSET,
    'a message given twice, its required fields in its first record': ('', 0, 0),
    'a message given twice, its required fields in its second record': ('', 0, 0),
    'a message given twice, its required fields split between its records': ('', 0, 0),
    'an item that leaves a required field unset': REQUIRED_UNSET,
    "a map's value whose message leaves a required field unset": REQUIRED_UNSET,
    "a map's key given twice, its last value whole": taken('', 0, 2, children={'': taken('', 0, 0)}),
    "a map's key given twice, its first value whole": REQUIRED_UNSET,
    'a group that leaves a required field unset': REQUIRED_UNSET, 'a child that leaves a required field unset': REQUIRED_UNSET,
    "a required closed enum's number its enum does not declare": REQUIRED_UNSET,
    'a required closed enum given a declared number, then one it does not declare': ('', 0, 0),
    "a closed enum's number its enum does not declare, which sets nothing": ('', 0, 0),
    "a closed enum's declared number, then one it does not declare": taken('', 0, 0, shade=1),
}
PROTO_RECORD = {name: taken(*outcome) if isinstance(outcome, tuple) else outcome for name, outcome in PROTO_RECORD.items()}
outcomes = {entry['name']: entry.get('refused') or entry['read'] for entry in payloads if entry['encoding'] == 'proto'}

assert outcomes == PROTO_RECORD, {name: outcome for name, outcome in outcomes.items() if PROTO_RECORD.get(name) != outcome}
assert [entry['bytes'][:8] for entry in payloads if entry['name'].endswith('messages below the top')] == [
    '1A E6 01', '1A E9 01', '1A EC 01']
assert {entry['name']: entry['written'] for entry in values if entry['encoding'] == 'proto' and 'written' in entry} == {
    'text set to a': '0A 01 61', 'number set to 7': '10 07', 'number set to 0, its default': '', 'no field set': '',
    'child set to the empty message': '1A 00', 'text set to a leading U+FEFF and a': '0A 04 EF BB BF 61',
    'needs set at its defaults': '3A 04 08 00 10 00'}
assert {entry['name']: entry['refused'] for entry in values if entry['encoding'] == 'proto' and 'refused' in entry} == {
    'needs set to no field': REQUIRED_UNSET, 'needs with a shade its enum does not declare': REQUIRED_UNSET}

document = {
    '$schema': 'schemas/codecs.schema.json',
    '$comment': [
        "Bead's codecs: what each encoding of spec section 17 reads and writes, raw, text and json (decision 0016) and proto (decision 0031), which every implementation's harness plays through its side's codecs.",
        'payloads are bytes read, in an encoding: written is the bytes its writer writes back of the value its reader read, the same bytes where they are canonical already; read, of a proto payload, what its reader read of them; refused, the reason its reader refuses them for. A harness checks the refusal, or that the bytes written are those given and that the value read equals the value its reader reads of them, or that what it read is read.',
        "proto: a Probe, the message of spec/codecs.proto, read and written through the code each side's stock generator writes for it over its stock library, as generated code reads one: its records checked against Probe's descriptor before the library reads them (decision 0028), the bound of 17.9.3 set in the call, a closed enum's record of a number it does not declare set aside before the library reads it where the library would take it (17.9.8), and each message it holds judged by its required fields once it is read (17.9.7, decision 0042), as the runtime's codec reads one. read is what was read of the top Probe: text, its string as UTF-16 code units in hexadecimal, four capital digits each and a space between; number; nested, how deep messages nest below it, through child, delimited and children, a map's entry counting as a message and its value as another; counts and stamps, where it holds any, their values in their order; children, where it holds any, each key, its code units as text gives them, to what was read of its value, its text, number and nested; delimited, where it is set, what was read of it, its text, number and nested; and shade, where a record set it, its number. A harness checks these and nothing else, since protobuf fixes no message's bytes whole: needs and needs_items, of Needs, whose fields protobuf requires, are judged and not read back.",
        'values are a value given to a writer, in an encoding: written is the bytes it writes; refused, the reason it refuses the value for. A value is given in one of eight forms.',
        'json: a JSON value, as the file holds it: on the TypeScript side JSON.parse of the file, so that a member named __proto__ is a member; on the C# side a JsonElement of the file.',
        'double: a double by its 64 bits, in hexadecimal: on the TypeScript side read through a DataView; on the C# side a JsonElement of JsonSerializer.SerializeToElement(BitConverter.Int64BitsToDouble(bits)), which holds no NaN and no infinity.',
        'number: a JSON number\'s text, parsed as JSON: a double on the TypeScript side, its digits as they are written on the C# side, which its writer reads to the double nearest them.',
        'text: a string, given to a text writer. bytes: bytes in hexadecimal, given to a raw writer.',
        'form: a value no JSON text holds. loneSurrogate is the string a, U+D800, b, which the C# side gives a json writer as a JsonElement of the bytes of its escape, and a text writer as a string; loneSurrogateName, an object whose one member is named so, its value 1; nameTwice, an object of two members both named a, 1 then 2, which the C# side parses with JsonElement.Parse\'s defaults and the TypeScript side cannot hold; undefined, JavaScript\'s undefined on the TypeScript side, default(JsonElement), of kind Undefined, on the C# side.',
        'nested: that many arrays, one in another, the innermost empty, which the C# side parses into a JsonElement with a MaxDepth as deep, since 64, its default, refuses a 65th.',
        'probe: a Probe given to a proto writer, one field set or none, so that protobuf fixes the bytes it writes: text, its string as UTF-16 code units, as read gives one; number; child, set to the empty message, {}; or needs, set to a Needs of the fields it gives, must and shade, each a number, none of them set where it gives none.',
        'A reason is derived, and held by the regeneration alone: not UTF-8, a byte order mark, not JSON, a name twice, a surrogate alone, a number past a double and nested past 64 of a reader; not its message, nested past 100 and a required field unset of a proto reader; a surrogate alone, a name twice, nested past 64, not a finite number and no JSON value of a writer, and a required field unset of a proto writer. No harness reads it: a refusal answers PAYLOAD_UNDECODABLE whatever its reason, and its words are each side\'s.',
        "Each item of differs names a row of docs/support.md an entry crosses, which names this file and the entry, and the language it excuses: a value that language's type cannot hold, or a payload its stock protobuf library reads otherwise than 17.9 says. A harness plays every entry but those a differs excuses its language from.",
        'clauses are the units of spec.md an entry checks: a clause, 17.6; an item of its numbered list, 17.5.7.',
    ],
    'specVersion': spec_version(),
    'payloads': payloads,
    'values': values,
}

with open(ROOT + 'codecs.json', 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=False, indent=2)
    file.write('\n')

print(len(payloads), 'payloads,', sum(entry['encoding'] == 'json' for entry in payloads), 'of them json and',
      sum(entry['encoding'] == 'proto' for entry in payloads), 'proto, and', len(values), 'values,',
      sum(entry['encoding'] == 'proto' for entry in values), 'of them proto')
