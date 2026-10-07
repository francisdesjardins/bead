"""Writes spec/codecs.json: what each encoding of spec section 17 reads of bytes, and what it writes back
of them or why it refuses them; and what a writer writes of a value, or why it refuses it (decisions
0016 and 0018).

Each outcome is section 17 played here a third time, beside the two sides, never written by hand: a
reader that refuses as 17.5 says, in the order the TypeScript reader checks, the depth counted over the
text before it is parsed; and a writer of RFC 8785's canonical form, ECMAScript's Number::toString from
repr's shortest digits, its strings as JSON.stringify writes a well-formed one, its names sorted by their
UTF-16 code units. A proto payload is read by a reader of Probe, spec/codecs.proto, written from
protobuf's Encoding guide and 17.9.2 to 17.9.4, and a proto value written one field at a time; where
protobuf states no rule, the reader stops, and no row may hold it. A row that would be refused for two
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

# 17.9.3: a proto message nested more than this below the top one is refused
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

# Probe's fields by number, as spec/codecs.proto declares them: its name, its type, and its wire type
FIELDS = {1: ('text', 'string', LEN), 2: ('number', 'uint32', VARINT), 3: ('child', 'Probe', LEN)}

# the 64 bits a varint holds, and the 32 of them a uint32 keeps, truncated as protobuf reads one
UINT32 = 0xFFFF_FFFF
UINT64 = 0xFFFF_FFFF_FFFF_FFFF


class NotItsMessage(Exception):
    """Bytes that are no encoding of Probe (17.9.1)."""


class NestedPast(Exception):
    """A message nested more than 100 deep below the top one (17.9.3)."""


class NoRule(Exception):
    """What protobuf states no rule of: no row holds it, and the support matrix says what each library
    does."""


def declared_fields():
    """Probe's fields as spec/codecs.proto declares them, each by its number: its name and its type."""
    with open(ROOT + 'codecs.proto', encoding='utf-8') as file:
        found = re.search(r'^message Probe \{\n(.*?)^\}', file.read(), re.MULTILINE | re.DOTALL)

    return {int(number): (name, kind) for kind, name, number in re.findall(r'^ +(\w+) (\w+) = (\d+);$',
                                                                           found.group(1), re.MULTILINE)}


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


def proto_skip(data, at, number, wire):
    """Where an unknown field of `number` and `wire` ends, its value skipped (Encoding, "Message
    Structure"), a group to the end group of its number."""
    if wire == VARINT:
        return proto_varint(data, at)[1]

    if wire == SGROUP:
        while True:
            tag, at = proto_varint(data, at)

            if tag >> 3 == 0:
                raise NotItsMessage('field number 0')

            if tag & 7 == EGROUP:
                if tag >> 3 != number:
                    raise NotItsMessage('an end group of another group')

                return at

            at = proto_skip(data, at, tag >> 3, tag & 7)

    if wire == LEN:
        length, at = proto_varint(data, at)
    elif wire in (I64, I32):
        length = 8 if wire == I64 else 4
    else:
        # 6 and 7, which are no wire type: an end group is met by its group, or refused where it opens none
        raise NotItsMessage(f'the wire type {wire} where a field starts')

    if at + length > len(data):
        raise NotItsMessage('a length past the bytes')

    return at + length


def probe_of():
    """A Probe with no field set: proto3's defaults, and its child not set."""
    return {'text': '', 'number': 0, 'child': None}


def proto_read_into(probe, data, depth):
    """Reads `data` into `probe`, `depth` messages below the top one: a scalar given twice its last, a
    message given twice merged, as protobuf parses it (Encoding, "Last One Wins")."""
    at = 0

    while at < len(data):
        tag, at = proto_varint(data, at)
        number, wire = tag >> 3, tag & 7

        if number == 0:
            raise NotItsMessage('field number 0')

        # an end group here closes no group, whatever its number, and 6 and 7 are no wire type
        if wire in (EGROUP, 6, 7):
            raise NotItsMessage(f'the wire type {wire} where a field starts')

        if number not in FIELDS:
            at = proto_skip(data, at, number, wire)
            continue

        name, _, its_wire = FIELDS[number]

        # ! a known field at a wire type not its own is no rule of protobuf's: a platform row
        if wire != its_wire:
            raise NoRule(f'{name} at the wire type {wire}')

        if wire == VARINT:
            value, at = proto_varint(data, at)
            probe[name] = value & UINT32
            continue

        length, at = proto_varint(data, at)

        if at + length > len(data):
            raise NotItsMessage('a length past the bytes')

        field, at = data[at:at + length], at + length

        if name == 'text':
            try:
                # * strict, and a leading U+FEFF kept as a character (17.9.4), as 'utf-8' keeps it
                probe['text'] = field.decode('utf-8')
            except UnicodeDecodeError as error:
                raise NotItsMessage('a string that is not UTF-8') from error
        elif depth + 1 > PROTO_DEPTH:
            raise NestedPast()
        else:
            probe['child'] = probe['child'] or probe_of()
            proto_read_into(probe['child'], field, depth + 1)


def code_units(text):
    """A string's UTF-16 code units in hexadecimal, four capital digits each, a space between."""
    data = text.encode('utf-16-be', 'surrogatepass')
    return ' '.join(f'{data[index]:02X}{data[index + 1]:02X}' for index in range(0, len(data), 2))


def text_of(units):
    """The string of UTF-16 code units as code_units writes them."""
    return bytes.fromhex(units.replace(' ', '')).decode('utf-16-be', 'surrogatepass')


def nested_below(probe):
    """How many messages nest below `probe` through child."""
    count = 0

    while probe['child'] is not None:
        count, probe = count + 1, probe['child']

    return count


def proto_read(data):
    """The one reason 17.9 refuses the bytes for, or what was read of them: the top Probe's text, as
    UTF-16 code units, its number, and how many messages nest below it."""
    probe = probe_of()

    try:
        proto_read_into(probe, data, 0)
    except NotItsMessage:
        return [NOT_ITS_MESSAGE], None
    except NestedPast:
        return [PROTO_NESTED_PAST], None

    return [], {'text': code_units(probe['text']), 'number': probe['number'], 'nested': nested_below(probe)}


def proto_length(data):
    """A length-delimited value's varint length and the value."""
    return proto_varint_of(len(data)) + data


def proto_varint_of(value):
    """A varint of `value` (Encoding, "Base 128 Varints")."""
    written = bytearray()

    while value >= 0x80:
        written.append(value & 0x7F | 0x80)
        value >>= 7

    return bytes(written + bytes([value]))


def proto_write(probe):
    """A Probe's bytes, its fields in their numbers' order: a scalar at its default not written, its
    presence implicit in proto3, and child written where it is set, an empty message included."""
    written = b''

    if probe['text']:
        written += proto_varint_of(1 << 3 | LEN) + proto_length(probe['text'].encode('utf-8'))

    if probe['number']:
        written += proto_varint_of(2 << 3 | VARINT) + proto_varint_of(probe['number'])

    if probe['child'] is not None:
        written += proto_varint_of(3 << 3 | LEN) + proto_length(proto_write(probe['child']))

    return written


def chain(below):
    """A Probe with that many messages nested below it through child, each with no field set."""
    probe = probe_of()

    for _ in range(below):
        probe = {**probe_of(), 'child': probe}

    return probe


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
    ('an end group no group opened', 'proto', ['17.9.1'], bytes.fromhex('24')),
    ('an unknown group, closed', 'proto', ['17.9'], bytes.fromhex('23 24')),
    ('an unknown group never closed', 'proto', ['17.9.1'], bytes.fromhex('23')),
    ('99 messages below the top', 'proto', ['17.9.3'], proto_write(chain(PROTO_DEPTH - 1))),
    ('100 messages below the top', 'proto', ['17.9.3'], proto_write(chain(PROTO_DEPTH))),
    ('101 messages below the top', 'proto', ['17.9.3'], proto_write(chain(PROTO_DEPTH + 1))),
]

# the payloads a stock library reads otherwise than 17.9 says, each by the row it crosses and its language
PROTO_DIFFERS = {"a string's leading U+FEFF": (LEADING_FEFF, 'TypeScript')}


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
    differs = PROTO_DIFFERS.get(name) if encoding == 'proto' else None

    return {'name': name, 'encoding': encoding, 'clauses': clauses, 'bytes': hexadecimal(data),
            **payload_outcome(encoding, data),
            **({'differs': [{'row': differs[0], 'language': differs[1]}]} if differs else {})}


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
                **({'child': probe_of()} if 'child' in given_probe else {})}

    return value['text'] if 'text' in value else bytes.fromhex(value['bytes'])


def value_outcome(encoding, value):
    """The bytes written of a value, or the one reason it is refused for: a proto value, one field or
    none, is never refused."""
    if encoding == 'raw':
        return {'written': hexadecimal(value)}

    if encoding == 'text':
        return {'refused': A_SURROGATE_ALONE} if has_surrogate(value) else {'written': hexadecimal(utf8(value))}

    if encoding == 'proto':
        written = proto_write(value)

        # what is written reads back to the value given: its text, its number, and its child's presence
        reasons, read = proto_read(written)
        assert not reasons and read == {'text': code_units(value['text']), 'number': value['number'],
                                        'nested': nested_below(value)}, written

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
    return {'name': name, 'encoding': encoding, 'clauses': clauses, 'value': value,
            **value_outcome(encoding, given(value)),
            **({'differs': [{'row': NOT_HELD, 'language': excused}]} if excused else {})}


# what the record states, held here against a slip in the rules above: Appendix B's numbers, and the tie
for bits, name, written in APPENDIX_B:
    assert (es(double(bits)) if written is not None else None) == written or not math.isfinite(double(bits)), name

assert bits_of(float(tie())) == TIE_LOW and bits_of(float(past_the_tie())) == TIE_HIGH
assert len(utf8(tie())) == 774

# the reader's fields are the ones spec/codecs.proto declares
assert declared_fields() == {number: (name, kind) for number, (name, kind, _) in FIELDS.items()}, declared_fields()

payloads = [payload_entry(*entry) for entry in PAYLOADS]
values = [value_entry(*entry) for entry in VALUES]

assert len(payloads) == 99 and len(values) == 44

# the proto rows as 0018 states them, each taken with its text, its number and how many nest below the
# top, or refused for its reason; and the deep rows' bytes as protobuf's writers write them
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
    'a varint of 11 bytes': NOT_ITS_MESSAGE, 'an end group no group opened': NOT_ITS_MESSAGE,
    'an unknown group, closed': ('', 0, 0), 'an unknown group never closed': NOT_ITS_MESSAGE,
    '99 messages below the top': ('', 0, 99), '100 messages below the top': ('', 0, 100),
    '101 messages below the top': PROTO_NESTED_PAST,
}
outcomes = {entry['name']: entry.get('refused') or tuple(entry['read'].values())
            for entry in payloads if entry['encoding'] == 'proto'}

assert outcomes == PROTO_RECORD, {name: outcome for name, outcome in outcomes.items() if PROTO_RECORD.get(name) != outcome}
assert [entry['bytes'][:8] for entry in payloads if entry['name'].endswith('below the top')] == [
    '1A E6 01', '1A E9 01', '1A EC 01']
assert {entry['name']: entry['written'] for entry in values if entry['encoding'] == 'proto'} == {
    'text set to a': '0A 01 61', 'number set to 7': '10 07', 'number set to 0, its default': '', 'no field set': '',
    'child set to the empty message': '1A 00', 'text set to a leading U+FEFF and a': '0A 04 EF BB BF 61'}

document = {
    '$schema': 'schemas/codecs.schema.json',
    '$comment': [
        "Bead's codecs: what each encoding of spec section 17 reads and writes, raw, text and json (decision 0016) and proto (decision 0018), which every implementation's harness plays through its side's codecs.",
        'payloads are bytes read, in an encoding: written is the bytes its writer writes back of the value its reader read, the same bytes where they are canonical already; read, of a proto payload, what its reader read of them; refused, the reason its reader refuses them for. A harness checks the refusal, or that the bytes written are those given and that the value read equals the value its reader reads of them, or that what it read is read.',
        "proto: a Probe, the message of spec/codecs.proto, read and written through the code each side's stock generator writes for it over its stock library, the bound of 17.9.3 set in the call as generated code sets it. read is what was read of the top Probe: text, its string as UTF-16 code units in hexadecimal, four capital digits each and a space between; number; and nested, how many messages nest below it through child. A harness checks those three and nothing else, since protobuf fixes no message's bytes whole.",
        'values are a value given to a writer, in an encoding: written is the bytes it writes; refused, the reason it refuses the value for. A value is given in one of eight forms.',
        'json: a JSON value, as the file holds it: on the TypeScript side JSON.parse of the file, so that a member named __proto__ is a member; on the C# side a JsonElement of the file.',
        'double: a double by its 64 bits, in hexadecimal: on the TypeScript side read through a DataView; on the C# side a JsonElement of JsonSerializer.SerializeToElement(BitConverter.Int64BitsToDouble(bits)), which holds no NaN and no infinity.',
        'number: a JSON number\'s text, parsed as JSON: a double on the TypeScript side, its digits as they are written on the C# side, which its writer reads to the double nearest them.',
        'text: a string, given to a text writer. bytes: bytes in hexadecimal, given to a raw writer.',
        'form: a value no JSON text holds. loneSurrogate is the string a, U+D800, b, which the C# side gives a json writer as a JsonElement of the bytes of its escape, and a text writer as a string; loneSurrogateName, an object whose one member is named so, its value 1; nameTwice, an object of two members both named a, 1 then 2, which the C# side parses with JsonElement.Parse\'s defaults and the TypeScript side cannot hold; undefined, JavaScript\'s undefined on the TypeScript side, default(JsonElement), of kind Undefined, on the C# side.',
        'nested: that many arrays, one in another, the innermost empty, which the C# side parses into a JsonElement with a MaxDepth as deep, since 64, its default, refuses a 65th.',
        'probe: a Probe given to a proto writer, one field set or none, so that protobuf fixes the bytes it writes: text, its string as UTF-16 code units, as read gives one; number; or child, set to the empty message, {}.',
        'A reason is derived, and held by the regeneration alone: not UTF-8, a byte order mark, not JSON, a name twice, a surrogate alone, a number past a double and nested past 64 of a reader; not its message and nested past 100 of a proto reader; a surrogate alone, a name twice, nested past 64, not a finite number and no JSON value of a writer. No harness reads it: a refusal answers PAYLOAD_UNDECODABLE whatever its reason, and its words are each side\'s.',
        "differs names the row of docs/support.md an entry crosses, which names this file and the entry, and the language it excuses: a value that language's type cannot hold, or a payload its stock protobuf library reads otherwise than 17.9 says. A harness plays every entry but those a differs excuses its language from.",
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
