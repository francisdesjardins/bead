"""Writes spec/transcoding.proto and spec/transcoding.json: the messages and the service a gateway is
played against, and what a gateway answers of them (spec/transcoding.md, decision 0037).

The proto and the entries come from one table of messages and procedures, so what the file declares
and what the entries play never part. Each entry is transcoding.md played here a third time, beside
the two sides: the generator parses and matches its own templates by 3.5's precedence, binds a
request by section 4, reads each body by its own reading of protobuf's JSON mapping, sections 5.2 to
5.4, and encodes the message it builds as protobuf's Encoding guide writes one; it writes each
result in Bead's proto JSON form, 5.6, its tokens details.py's, each problem by section 7, and each
stream by section 8. protobuf's own Python library, upb, which spec/requirements.txt pins, reads
every body this reading takes or refuses, and reads back every body it writes: where upb parts from
it, the entry names the row of decision 0037's table that says why, and any other parting fails the
generator. A backslash is chr(92), so that no escape this file builds is read before it is built."""
import base64
import calendar
import hashlib
import json
import math
import os
import re
import struct
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal
from fractions import Fraction

from google.protobuf import any_pb2, descriptor_pb2, descriptor_pool, duration_pb2, empty_pb2  # noqa: F401
from google.protobuf import field_mask_pb2, json_format, message_factory, struct_pb2, timestamp_pb2  # noqa: F401
from google.protobuf import wrappers_pb2  # noqa: F401

from bounds import DEFAULTS
from details import canonical, es
from transcoding_version import transcoding_version

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')

B = chr(92)
PACKAGE = 'bead.transcoding.v1'
WKT = 'google.protobuf'

# a protocol code's problem type (transcoding 7.3), and the problem types the gateway under test is
# given for its application failures, as its definitions give them
TAG = 'tag:francisdesjardins.ca,2026:bead/'
PROBLEM_TYPES = 'https://example.com/problems/'

# ── The model ───────────────────────────────────────────────────────────────────────────────────

INTEGERS32 = {'int32': (-2 ** 31, 2 ** 31 - 1), 'sint32': (-2 ** 31, 2 ** 31 - 1), 'sfixed32': (-2 ** 31, 2 ** 31 - 1),
              'uint32': (0, 2 ** 32 - 1), 'fixed32': (0, 2 ** 32 - 1)}
INTEGERS64 = {'int64': (-2 ** 63, 2 ** 63 - 1), 'sint64': (-2 ** 63, 2 ** 63 - 1), 'sfixed64': (-2 ** 63, 2 ** 63 - 1),
              'uint64': (0, 2 ** 64 - 1), 'fixed64': (0, 2 ** 64 - 1)}
INTEGERS = {**INTEGERS32, **INTEGERS64}
FLOATS = ('float', 'double')
SCALARS = (*INTEGERS, *FLOATS, 'bool', 'string', 'bytes')


def json_name_of(name):
    """A field's JSON name as protoc gives it: each underscore dropped and the letter after it raised."""
    out, upper = '', False

    for character in name:
        if character == '_':
            upper = True
        elif upper:
            out, upper = out + character.upper(), False
        else:
            out += character

    return out


class Enum:
    def __init__(self, full_name, note, values, *, alias=False):
        self.full_name, self.note, self.values, self.alias = full_name, note, values, alias
        self.name = full_name.rsplit('.', 1)[1]

    def number_of(self, name):
        return next((number for value, number in self.values if value == name), None)

    def name_of(self, number):
        """The name of the value declared first for a number, as protobuf's C++ and Go libraries name one."""
        return next((value for value, each in self.values if each == number), None)


class Field:
    def __init__(self, name, number, kind, *, label=None, key=None, optional=False, oneof=None, json=None,
                 rules=None):
        self.name, self.number, self.kind, self.label, self.key = name, number, kind, label, key
        self.optional, self.oneof, self.rules = optional, oneof, rules
        self.json_name = json or json_name_of(name)
        self.custom_json = json is not None

    @property
    def is_message(self):
        return self.kind.startswith('message:')

    @property
    def type_name(self):
        return self.kind.split(':', 1)[1]

    @property
    def explicit(self):
        """Whether a singular field has presence of its own, as proto3 gives it: a message, a member of
        a oneof, or one marked optional."""
        return self.label is None and (self.is_message or self.oneof is not None or self.optional)


class Message:
    def __init__(self, full_name, note, fields, *, oneofs=()):
        self.full_name, self.note, self.fields, self.oneofs = full_name, note, fields, list(oneofs)
        self.name = full_name.rsplit('.', 1)[1]
        self.by_name = {field.name: field for field in fields}
        self.by_json = {field.json_name: field for field in fields}

    def field_named(self, key):
        """The field a JSON member names, by its JSON name or its proto name (5.2, item 2)."""
        return self.by_json.get(key) or self.by_name.get(key)


TYPES = {}


def declare(*types):
    for each in types:
        TYPES[each.full_name] = each

    return types[0] if len(types) == 1 else types


def message(name, note, fields, **options):
    return declare(Message(f'{PACKAGE}.{name}', note, fields, **options))


def ref(name):
    return f'message:{name if "." in name else PACKAGE + "." + name}'


def wkt(name):
    return f'message:{WKT}.{name}'


# the well-known types, as their .proto files declare them, which the generator reads and writes by
# their forms (5.4, 5.6)
NULL_VALUE = declare(Enum(f'{WKT}.NullValue', '', [('NULL_VALUE', 0)]))
WRAPPED = {'DoubleValue': 'double', 'FloatValue': 'float', 'Int64Value': 'int64', 'UInt64Value': 'uint64',
           'Int32Value': 'int32', 'UInt32Value': 'uint32', 'BoolValue': 'bool', 'StringValue': 'string',
           'BytesValue': 'bytes'}

declare(
    Message(f'{WKT}.Timestamp', '', [Field('seconds', 1, 'int64'), Field('nanos', 2, 'int32')]),
    Message(f'{WKT}.Duration', '', [Field('seconds', 1, 'int64'), Field('nanos', 2, 'int32')]),
    Message(f'{WKT}.FieldMask', '', [Field('paths', 1, 'string', label='repeated')]),
    Message(f'{WKT}.Struct', '', [Field('fields', 1, wkt('Value'), label='map', key='string')]),
    Message(f'{WKT}.Value', '', [
        Field('null_value', 1, f'enum:{WKT}.NullValue', oneof='kind'),
        Field('number_value', 2, 'double', oneof='kind'),
        Field('string_value', 3, 'string', oneof='kind'),
        Field('bool_value', 4, 'bool', oneof='kind'),
        Field('struct_value', 5, wkt('Struct'), oneof='kind'),
        Field('list_value', 6, wkt('ListValue'), oneof='kind'),
    ], oneofs=['kind']),
    Message(f'{WKT}.ListValue', '', [Field('values', 1, wkt('Value'), label='repeated')]),
    Message(f'{WKT}.Any', '', [Field('type_url', 1, 'string'), Field('value', 2, 'bytes')]),
    Message(f'{WKT}.Empty', '', []),
    *[Message(f'{WKT}.{name}', '', [Field('value', 1, scalar)]) for name, scalar in WRAPPED.items()],
)

# the well-known types whose JSON is a form of their own, which an Any holds under value (5.4, item 6)
OWN_FORMS = {f'{WKT}.{name}' for name in ('Timestamp', 'Duration', 'FieldMask', 'Struct', 'Value', 'ListValue', 'Any',
                                          *WRAPPED)}
# those whose form is a JSON string, which a query's parameter takes (4.3, item 2)
STRING_FORMS = {f'{WKT}.{name}' for name in ('Timestamp', 'Duration', 'FieldMask', *WRAPPED)}

COLOR = declare(Enum(f'{PACKAGE}.Color', 'A colour, by its number.',
                     [('COLOR_UNSPECIFIED', 0), ('COLOR_RED', 1), ('COLOR_GREEN', 2)]))
ALIASED = declare(Enum(f'{PACKAGE}.Aliased', 'An enum two of whose names number one value.',
                       [('ALIASED_UNSPECIFIED', 0), ('ALIASED_FIRST', 1), ('ALIASED_SECOND', 1)], alias=True))
FAILURE = declare(Enum(f'{PACKAGE}.TranscodingFailure', "What the service's procedures answer instead.",
                       [('TRANSCODING_FAILURE_UNSPECIFIED', 0), ('TRANSCODING_FAILURE_REFUSED', 1),
                        ('TRANSCODING_FAILURE_COUNTED', 2)]))

INNER = message('Inner', 'A message the others hold.', [Field('name', 1, 'string'), Field('count', 2, 'int32')])

EVERYTHING = message('Everything', "Every kind of field protobuf's JSON mapping has a form for, in its numbers' order.", [
    Field('a_double', 1, 'double'),
    Field('a_float', 2, 'float'),
    Field('an_int64', 3, 'int64'),
    Field('a_uint64', 4, 'uint64'),
    Field('an_int32', 5, 'int32'),
    Field('a_fixed64', 6, 'fixed64'),
    Field('a_bool', 7, 'bool'),
    Field('a_string', 8, 'string'),
    Field('some_bytes', 9, 'bytes'),
    Field('a_uint32', 10, 'uint32'),
    Field('a_sint64', 11, 'sint64'),
    Field('color', 12, f'enum:{PACKAGE}.Color'),
    Field('inner', 13, ref('Inner')),
    Field('int64s', 14, 'int64', label='repeated'),
    Field('inners', 15, ref('Inner'), label='repeated'),
    Field('labels', 16, 'int32', label='map', key='string'),
    Field('by_id', 17, 'string', label='map', key='int64'),
    Field('flags', 18, 'string', label='map', key='bool'),
    Field('maybe', 19, 'int32', optional=True),
    Field('choice_text', 20, 'string', oneof='choice'),
    Field('choice_inner', 21, ref('Inner'), oneof='choice'),
    Field('at', 22, wkt('Timestamp')),
    Field('took', 23, wkt('Duration')),
    Field('mask', 24, wkt('FieldMask')),
    Field('extra', 25, wkt('Struct')),
    Field('any_value', 26, wkt('Value')),
    Field('wrapped_int64', 27, wkt('Int64Value')),
    Field('wrapped_string', 28, wkt('StringValue')),
    Field('nothing', 29, wkt('Empty')),
    Field('custom_named', 30, 'string', json='renamed'),
    Field('list', 31, wkt('ListValue')),
    Field('wrapped_bool', 32, wkt('BoolValue')),
], oneofs=['choice'])

EDGES = message('Edges', 'The edges of the mapping two stock libraries part on.', [
    Field('at', 1, wkt('Timestamp')),
    Field('took', 2, wkt('Duration')),
    Field('mask', 3, wkt('FieldMask')),
    Field('extra', 4, wkt('Struct')),
    Field('value', 5, wkt('Value')),
    Field('any', 6, wkt('Any')),
    Field('wrapped_float', 7, wkt('FloatValue')),
    Field('wrapped_int64', 8, wkt('Int64Value')),
    Field('wrapped_uint64', 9, wkt('UInt64Value')),
    Field('aliased', 10, f'enum:{PACKAGE}.Aliased'),
    Field('by_int64', 11, 'string', label='map', key='int64'),
    Field('by_int32', 12, 'string', label='map', key='int32'),
    Field('by_uint32', 13, 'string', label='map', key='uint32'),
    Field('ints', 14, 'int32', label='repeated'),
    Field('labels', 15, 'int32', label='map', key='string'),
    Field('a_float', 16, 'float'),
    Field('a_double', 17, 'double'),
    Field('an_int32', 18, 'int32'),
    Field('a_uint32', 19, 'uint32'),
    Field('some_bytes', 20, 'bytes'),
    Field('nothing', 21, wkt('Empty')),
    Field('child', 22, ref('Edges')),
    Field('children', 23, ref('Edges'), label='repeated'),
    Field('maybe_double', 24, 'double', optional=True),
    Field('an_int64', 25, 'int64'),
    Field('stamps', 26, wkt('Timestamp'), label='repeated'),
    Field('null_member', 27, f'enum:{WKT}.NullValue', oneof='nullable'),
    Field('text_member', 28, 'string', oneof='nullable'),
    Field('an_sint32', 29, 'sint32'),
    Field('an_sfixed32', 30, 'sfixed32'),
    Field('a_fixed32', 31, 'fixed32'),
    Field('an_sfixed64', 32, 'sfixed64'),
], oneofs=['nullable'])

BOOK = message('Book', "A book of http.proto's own examples.", [
    Field('name', 1, 'string'),
    Field('title', 2, 'string'),
    Field('pages', 3, 'int64'),
    Field('author', 4, ref('Inner')),
])
GET_BOOK = message('GetBookRequest', 'Which book, by its resource name.', [
    Field('name', 1, 'string'),
    Field('revision', 2, 'int64'),
    Field('sub', 3, ref('Inner')),
    Field('tags', 4, 'string', label='repeated'),
    Field('at', 5, wkt('Timestamp')),
    Field('color', 6, f'enum:{PACKAGE}.Color'),
    Field('flag', 7, 'bool'),
    Field('inners', 8, ref('Inner'), label='repeated'),
    Field('labels', 9, 'int32', label='map', key='string'),
])
LIST_BOOKS = message('ListBooksRequest', "A shelf's books, a page at a time.",
                     [Field('parent', 1, 'string'), Field('page_size', 2, 'int32')])
BOOKS = message('ListBooksResponse', 'A page of books.',
                [Field('books', 1, ref('Book'), label='repeated'), Field('next_page_token', 2, 'string')])
UPDATE_BOOK = message('UpdateBookRequest', 'A book and the fields of it to update (AIP-134).',
                      [Field('book', 1, ref('Book')), Field('update_mask', 2, wkt('FieldMask'))])
OPERATION = message('Operation', 'An operation of google.longrunning, by its name.',
                    [Field('name', 1, 'string'), Field('done', 2, 'bool')])
GET_OPERATION = message('GetOperationRequest', 'Which operation.', [Field('name', 1, 'string')])
LIST_OPERATIONS = message('ListOperationsRequest', "Operations under a name.",
                          [Field('name', 1, 'string'), Field('filter', 2, 'string')])
OPERATIONS = message('ListOperationsResponse', 'Operations.', [Field('operations', 1, ref('Operation'), label='repeated')])
RULED = message('Ruled', "A request its rules judge: its from 10 at most, its title 3 characters at most.", [
    Field('from', 1, 'int32', rules='(buf.validate.field).int32.lte = 10'),
    Field('title', 2, 'string', rules='(buf.validate.field).string.max_len = 3'),
])
TICKS_REQUEST = message('TicksRequest', 'Where a count starts.', [Field('from', 1, 'int32')])
TICKS_RESPONSE = message('TicksResponse', 'The ticks a count will notify.', [Field('ticks', 1, 'int32')])
TICK = message('Tick', 'One step of a count.', [Field('remaining', 1, 'int32')])
FAIL_REQUEST = message('FailRequest', 'The detail a failure answers with.', [Field('detail', 1, 'string')])
WHO = message('WhoAmIResponse', "A call's session, by its identifier.", [Field('session', 1, 'string')])
ASK = message('AskResponse', 'The code a command failed with, 0 where it was answered.', [Field('code', 1, 'int32')])
CANCELS_REQUEST = message('CancelsRequest', 'How many cancels to wait for.', [Field('at_least', 1, 'int32')])
CANCELS = message('CancelsResponse', 'How many calls of hang ended cancelled.', [Field('count', 1, 'int32')])

# the native payload types of bead/options.proto, whose bytes are the payload (5.1)
NATIVE = {'bead.Raw': 'raw', 'bead.Text': 'text', 'bead.Json': 'json'}

# ── The service ─────────────────────────────────────────────────────────────────────────────────


class Rule:
    def __init__(self, method, template, *, body=None, response_body=None):
        self.method, self.template, self.body, self.response_body = method, template, body, response_body


class Procedure:
    def __init__(self, procedure_id, name, request, result, note, *, rules=(), reads=False, notifies=None,
                 command=False, admission=None, failures=()):
        self.id, self.name, self.request, self.result, self.note = procedure_id, name, request, result, note
        self.rules, self.reads, self.notifies, self.command = list(rules), reads, notifies, command
        self.admission, self.failures = admission, list(failures)

    @property
    def rpc(self):
        return self.name[0].upper() + self.name[1:]


EMPTY = f'{WKT}.Empty'

PROCEDURES = [
    Procedure(1, 'echo', EVERYTHING.full_name, EVERYTHING.full_name, 'Answers its request.'),
    Procedure(2, 'echoEdges', EDGES.full_name, EDGES.full_name, 'Answers its request.'),
    Procedure(3, 'getBook', GET_BOOK.full_name, BOOK.full_name,
              'Answers the book its name names: its title "A tale", its pages its revision.',
              rules=[Rule('get', '/v1/{name=shelves/*/books/*}'), Rule('get', '/v1/books/{name}')], reads=True),
    Procedure(4, 'listBooks', LIST_BOOKS.full_name, BOOKS.full_name,
              "Answers its shelf's two books, a and b, titled A and B, and no page after.",
              rules=[Rule('get', '/v1/{parent=shelves/*}/books', response_body='books')]),
    Procedure(5, 'updateBook', UPDATE_BOOK.full_name, UPDATE_BOOK.full_name, 'Answers its request.',
              rules=[Rule('patch', '/v1/{book.name=shelves/*/books/*}', body='book')]),
    Procedure(6, 'archiveBook', GET_BOOK.full_name, EMPTY, 'Archives a book, and answers nothing.',
              rules=[Rule('post', '/v1/{name=shelves/*/books/*}:archive', body='*')]),
    Procedure(7, 'listOperations', LIST_OPERATIONS.full_name, OPERATIONS.full_name,
              'Answers one operation, its name its request\'s and "/a" after it, not done.',
              rules=[Rule('get', '/v1/{name=operations}')]),
    Procedure(8, 'getOperation', GET_OPERATION.full_name, OPERATION.full_name,
              'Answers the operation its name names, done.', rules=[Rule('get', '/v1/{name=operations/**}')], reads=True),
    Procedure(9, 'judge', RULED.full_name, EMPTY, 'Answers nothing, once its rules took its request.',
              rules=[Rule('post', '/v1/ruled/{title}', body='*')]),
    Procedure(10, 'ticks', TICKS_REQUEST.full_name, TICKS_RESPONSE.full_name,
              'Answers its from as its ticks, notifies each count down to 0, then ends with COUNTED.', reads=True, notifies=TICK.full_name, failures=['TRANSCODING_FAILURE_COUNTED']),
    Procedure(11, 'watch', EMPTY, EMPTY, 'Answers nothing, then notifies nothing, and ends its subscription never.',
              notifies=TICK.full_name),
    Procedure(12, 'raw', 'bead.Raw', 'bead.Raw', 'Answers its request.'),
    Procedure(13, 'text', 'bead.Text', 'bead.Text', 'Answers its request.'),
    Procedure(14, 'json', 'bead.Json', 'bead.Json', 'Answers its request.'),
    Procedure(15, 'fail', FAIL_REQUEST.full_name, EMPTY, 'Fails with REFUSED, its detail its request\'s.',
              failures=['TRANSCODING_FAILURE_REFUSED']),
    Procedure(16, 'whoAmI', EMPTY, WHO.full_name, "Answers its call's session's identifier.", admission='session'),
    Procedure(17, 'ask', EMPTY, ASK.full_name,
              'Commands its caller, by answer, and answers the code the command failed with, or 0.'),
    Procedure(18, 'answer', EMPTY, EMPTY, 'A command its caller answers.', command=True),
    Procedure(19, 'hang', EMPTY, EMPTY, 'Answers never, and counts each of its calls that ends cancelled.'),
    Procedure(20, 'cancels', CANCELS_REQUEST.full_name, CANCELS.full_name,
              "Answers how many of hang's calls ended cancelled, once they are at least its atLeast, or 1 second "
              'passed.', reads=True),
]
BY_PROCEDURE = {procedure.name: procedure for procedure in PROCEDURES}
SERVICE = 'Transcoding'
CATALOGUE = {name.removeprefix('TRANSCODING_FAILURE_'): number for name, number in FAILURE.values if number}


def query_carries(name, seen=None):
    """Whether the query carries every field of a message (transcoding 3.2, 4.3): a scalar, an enum, a
    repeated one of either, a form of STRING_FORMS, or a message whose own fields it carries; never a
    map, a repeated message or another well-known type, at any depth. A message met again carries
    what it did."""
    seen = set() if seen is None else seen

    if name in seen or name not in TYPES:
        return True

    seen.add(name)

    for field in TYPES[name].fields:
        if field.label == 'map' or (field.is_message and field.label == 'repeated'):
            return False

        if not field.is_message or field.type_name in STRING_FORMS:
            continue

        if field.type_name.startswith(f'{WKT}.') or not query_carries(field.type_name, seen):
            return False

    return True


def default_routes(procedure, prefix='/api'):
    """A procedure's default routes (transcoding 3.2): POST, and GET where it reads and the query
    carries its request whole."""
    template = f'{prefix}/{SERVICE}/{procedure.name}'
    routes = [Rule('post', template, body='*')]

    if procedure.reads and procedure.request not in NATIVE and query_carries(procedure.request):
        routes.append(Rule('get', template))

    return routes


def routes_of(procedure):
    return [] if procedure.command else [*default_routes(procedure), *procedure.rules]


# ── transcoding.proto ───────────────────────────────────────────────────────────────────────────


def proto_type(field):
    if field.kind in SCALARS:
        return field.kind

    name = field.type_name
    return name.removeprefix(PACKAGE + '.')


def declaration(field, indent):
    if field.label == 'map':
        head = f'map<{field.key}, {proto_type(field)}> {field.name} = {field.number}'
    else:
        prefix = 'repeated ' if field.label == 'repeated' else 'optional ' if field.optional else ''
        head = f'{prefix}{proto_type(field)} {field.name} = {field.number}'

    options = [*([f'json_name = "{field.json_name}"'] if field.custom_json else []),
               *([field.rules] if field.rules else [])]

    return indent + head + (f' [{", ".join(options)}]' if options else '') + ';'


def message_text(each):
    lines = [f'// {each.note}', f'message {each.name} {{']
    written = set()

    for field in each.fields:
        if field.oneof is None:
            lines.append(declaration(field, '  '))
        elif field.oneof not in written:
            written.add(field.oneof)
            lines.append(f'  oneof {field.oneof} {{')
            lines.extend(declaration(member, '    ') for member in each.fields if member.oneof == field.oneof)
            lines.append('  }')

    lines.append('}')
    return '\n'.join(lines)


def enum_text(each):
    return '\n'.join([f'// {each.note}', f'enum {each.name} {{', *(['  option allow_alias = true;'] if each.alias else []),
                      *[f'  {value} = {number};' for value, number in each.values], '}'])


def type_text(name):
    return name.removeprefix(PACKAGE + '.')


def rpc_text(procedure):
    lines = [f'  // {procedure.note}', f'  rpc {procedure.rpc}({type_text(procedure.request)}) returns '
                                        f'({type_text(procedure.result)}) {{']

    if procedure.reads:
        lines.append('    option idempotency_level = NO_SIDE_EFFECTS;')

    options = [f'id: {procedure.id}']

    if procedure.notifies:
        options.append(f'notifies: {{message: "{procedure.notifies}"}}')

    if procedure.command:
        options.append('command: {}')

    if procedure.admission:
        options.append(f'admission: {{{procedure.admission}: {{}}}}')

    if procedure.failures:
        options.append(f'failures: [{", ".join(json.dumps(each) for each in procedure.failures)}]')

    lines.append('    option (bead.procedure) = {')
    lines.extend(f'      {option}' for option in options)
    lines.append('    };')

    if procedure.rules:
        first, *more = procedure.rules
        lines.append('    option (google.api.http) = {')
        lines.extend(f'      {line}' for line in rule_lines(first))

        for other in more:
            lines.append('      additional_bindings {')
            lines.extend(f'        {line}' for line in rule_lines(other))
            lines.append('      }')

        lines.append('    };')

    lines.append('  }')
    return '\n'.join(lines)


def rule_lines(rule):
    return [f'{rule.method}: "{rule.template}"', *([f'body: "{rule.body}"'] if rule.body else []),
            *([f'response_body: "{rule.response_body}"'] if rule.response_body else [])]


def proto_file():
    own = [each for name, each in TYPES.items() if name.startswith(PACKAGE + '.')]

    return '\n'.join([
        '// The messages and the service spec/transcoding.json plays a gateway against, written with its entries by',
        '// spec/generators/make_transcoding.py: regenerate, never edit (spec/transcoding.md, decision 0037).',
        'syntax = "proto3";',
        '',
        'package bead.transcoding.v1;',
        '',
        'import "bead/options.proto";',
        'import "buf/validate/validate.proto";',
        'import "google/api/annotations.proto";',
        'import "google/protobuf/any.proto";',
        'import "google/protobuf/duration.proto";',
        'import "google/protobuf/empty.proto";',
        'import "google/protobuf/field_mask.proto";',
        'import "google/protobuf/struct.proto";',
        'import "google/protobuf/timestamp.proto";',
        'import "google/protobuf/wrappers.proto";',
        '',
        'option (bead.file) = {',
        '  admission: {',
        '    none: {}',
        '  }',
        '};',
        '',
        "// What a gateway answers, each procedure by its default routes and its rules.",
        'service TranscodingService {',
        '  option (bead.service) = {',
        '    id: 1',
        '    revision: 1',
        '    failures: "TranscodingFailure"',
        '  };',
        '',
        '\n\n'.join(rpc_text(procedure) for procedure in PROCEDURES),
        '}',
        '',
        '\n\n'.join(enum_text(each) if isinstance(each, Enum) else message_text(each) for each in own),
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


def on_the_wire(kind, value):
    """Whether a field of implicit presence is written: protobuf writes one whose value is not its
    zero, its bits compared, so a -0.0 goes."""
    if kind in FLOATS:
        return value != 0 or math.copysign(1, value) < 0

    return value not in (0, False, '', b'')


def value_bytes(kind, value):
    if kind.startswith('message:'):
        return length_delimited(encode(TYPES[kind.split(':', 1)[1]], value)), LEN

    return scalar_bytes(kind, value)


def record(number, kind, value):
    body, wire = value_bytes(kind, value)
    return tag(number, wire) + body


def encode(each, value):
    """A message's bytes from its value, its fields by their numbers: an implicit field at its zero left
    out, a repeated scalar packed as proto3 packs it, a map's entries in the order the value gives
    them, key and value each written. An Any's value is its message encoded, or the bytes it holds."""
    if each.full_name == f'{WKT}.Any' and 'message' in value:
        inner = TYPES[value['type_url'].rsplit('/', 1)[1]]
        value = {'type_url': value['type_url'], 'value': encode(inner, value['message'])}

    out = b''

    for field in sorted(each.fields, key=lambda one: one.number):
        if field.name not in value:
            continue

        given = value[field.name]

        if field.label == 'repeated':
            if field.kind in (*INTEGERS, *FLOATS, 'bool') or field.kind.startswith('enum:'):
                if given:
                    out += tag(field.number, LEN) + length_delimited(b''.join(scalar_bytes(field.kind, item)[0]
                                                                              for item in given))
            else:
                out += b''.join(record(field.number, field.kind, item) for item in given)
        elif field.label == 'map':
            for key, item in given:
                out += tag(field.number, LEN) + length_delimited(record(1, field.key, key) + record(2, field.kind, item))
        elif field.explicit or on_the_wire(field.kind, given):
            out += record(field.number, field.kind, given)

    return out


def hexadecimal(data):
    return ' '.join(f'{byte:02X}' for byte in data)


# ── Reading a proto body, transcoding 5.2 to 5.4 ────────────────────────────────────────────────


class Refused(Exception):
    """A refusal, its reason and the step of 5.2 that refuses, which is derived and held by the
    regeneration alone, since a refusal answers PAYLOAD_UNDECODABLE whatever its reason; where the
    reading met it, at, the tokens of its value's place from the value read, each a field's JSON name,
    an item's index, or a name or a key the request carried, given, none for the text's own; and where
    the request carried it, place, a parameter or a pointer of 7.4, which a binding gives it."""

    def __init__(self, reason, step=None, at=None, place=None):
        super().__init__(reason)
        self.reason, self.step, self.at, self.place = reason, step, at, place


def field_at(at, field):
    """The place of a field's value below `at`, by its JSON name."""
    return (*at, (field.json_name, False))


def given_at(at, name):
    """The place of a member, a key or an item named by what the request carried below `at`."""
    return (*at, (name, True))


def index_at(at, index):
    return (*at, (str(index), False))


def located(at, read, *arguments):
    """What `read` gives of the value at `at`, a refusal of it placed there."""
    try:
        return read(*arguments)
    except Refused as refusal:
        if refusal.at is None:
            refusal.at = at

        raise


def cut(text):
    """A name or a key the request carried, cut as spec 18.4 cuts a key past 64 bytes of UTF-8: its
    first 64 bytes, back to the start of the character the cut fell in, then ..."""
    data = text.encode('utf-8')

    if len(data) <= 64:
        return text

    return data[:64].decode('utf-8', errors='ignore') + '...'


def pointer_text(at):
    """A place's pointer (7.4, item 2): each token, up to the value that holds a name or a key the
    request carried past 64 bytes of UTF-8, which a pointer never cuts."""
    tokens = []

    for token, given in at:
        if given and len(token.encode('utf-8')) > 64:
            break

        tokens.append(token)

    return fragment(tokens)


class Num:
    """A JSON number, its digits kept beside its double (5.2, item 1)."""

    __slots__ = ('text',)

    def __init__(self, text):
        self.text = text

    def __repr__(self):
        return f'Num({self.text})'


class Pairs(list):
    """A JSON object's members, in their order."""


JSON_NUMBER = re.compile(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?')
DECIMAL = re.compile(r'-?(?:0|[1-9][0-9]*)')
LIMIT = 100
NOT_AN_INTEGER = Fraction(1, 2)


def exact_of(text):
    """A JSON number's value read exactly from its digits, or one that is no integer where its
    magnitude could hold none of any type's range, so that no exponent builds a number of its own."""
    number = Decimal(text)

    if number == 0:
        return Fraction(0)

    if number.adjusted() > 40:
        return Fraction(2 ** 80)

    if number.adjusted() < -40:
        return NOT_AN_INTEGER

    return Fraction(number)


def surrogate_alone(value):
    if isinstance(value, str):
        return any(0xD800 <= ord(character) <= 0xDFFF for character in value)

    if isinstance(value, Pairs):
        return any(surrogate_alone(key) or surrogate_alone(member) for key, member in value)

    if isinstance(value, list):
        return any(surrogate_alone(item) for item in value)

    return False


def past_a_double(value):
    if isinstance(value, Num):
        return math.isinf(float(value.text))

    if isinstance(value, Pairs):
        return any(past_a_double(member) for _, member in value)

    if isinstance(value, list):
        return any(past_a_double(item) for item in value)

    return False


def read_text(data):
    """Step 1: one JSON text as 17.5 reads a json payload, its numbers' digits kept; its depth is the
    descriptor's, counted as its members are read."""
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        raise Refused('not UTF-8', 1)

    if text.startswith(chr(0xFEFF)):
        raise Refused('a byte order mark', 1)

    def pairs(items):
        names = [name for name, _ in items]

        if len(set(names)) != len(names):
            raise Refused('a member named twice', 1)

        return Pairs(items)

    def constant(name):
        raise Refused('not JSON', 1)

    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_float=Num, parse_int=Num, parse_constant=constant)
    except Refused:
        raise
    except (ValueError, RecursionError):
        raise Refused('not JSON', 1)

    if surrogate_alone(value):
        raise Refused('a surrogate alone', 1)

    if past_a_double(value):
        raise Refused('a number past a double', 1)

    return value


def f32(value):
    """The 32-bit float nearest a double, a tie to the even; OverflowError past the largest finite one."""
    return struct.unpack('<f', struct.pack('<f', value))[0]


ARTICLE_AN = re.compile(r'[aeioAEIO]|sint|sfixed')


def article(name):
    """The article a type's name takes, as it is read aloud: an int32, an sint32 (es-int), an Edges,
    an Empty; a uint32, a fixed32, a Timestamp."""
    return 'an' if ARTICLE_AN.match(name) else 'a'


def read_integer(kind, value):
    low, high = INTEGERS[kind]

    if kind in INTEGERS64 and isinstance(value, str):
        if not DECIMAL.fullmatch(value):
            raise Refused(f'{article(kind)} {kind} string off -?(0|[1-9][0-9]*)', 3)
        exact = Fraction(int(value))
    elif isinstance(value, Num):
        exact = exact_of(value.text)
    elif isinstance(value, str) and JSON_NUMBER.fullmatch(value):
        exact = exact_of(value)
    else:
        raise Refused(f'no {kind}', 3)

    if exact.denominator != 1:
        raise Refused(f'{article(kind)} {kind} that is no integer', 3)

    if not low <= exact <= high:
        raise Refused(f'{article(kind)} {kind} past its range', 3)

    return int(exact)


def read_float(kind, value):
    if isinstance(value, str) and value in ('NaN', 'Infinity', '-Infinity'):
        return float(value.replace('Infinity', 'inf').replace('NaN', 'nan'))

    if isinstance(value, Num):
        text = value.text
    elif isinstance(value, str) and JSON_NUMBER.fullmatch(value):
        text = value
    else:
        raise Refused(f'no {kind}', 3)

    double = float(text)

    if math.isinf(double):
        raise Refused('a number past a double', 3)

    if kind == 'double':
        return double

    try:
        return f32(double)
    except OverflowError:
        raise Refused('a float past its range', 3)


STANDARD = re.compile(r'[A-Za-z0-9+/]*')
URL_SAFE = re.compile(r'[A-Za-z0-9_-]*')


def read_bytes(value):
    """Base64 of one alphabet, padded correctly or not at all, its pad bits whatever they are (5.3, item 6)."""
    if not isinstance(value, str):
        raise Refused('no bytes', 3)

    body = value.rstrip('=')
    pads = len(value) - len(body)

    if not (STANDARD.fullmatch(body) or URL_SAFE.fullmatch(body)):
        raise Refused('bytes of no one alphabet of base64', 3)

    if len(body) % 4 == 1 or (pads and pads != (-len(body)) % 4):
        raise Refused('bytes padded wrongly', 3)

    return base64.b64decode(body.replace('-', '+').replace('_', '/') + '=' * ((-len(body)) % 4))


def read_scalar(kind, value):
    if kind in INTEGERS:
        return read_integer(kind, value)

    if kind in FLOATS:
        return read_float(kind, value)

    if kind == 'bool':
        if value is True or value is False:
            return value
        raise Refused('no bool', 3)

    if kind == 'string':
        if isinstance(value, str):
            return value
        raise Refused('no string', 3)

    return read_bytes(value)


def read_enum(each, value):
    if each.full_name == NULL_VALUE.full_name and value is None:
        return 0

    if isinstance(value, str):
        number = each.number_of(value)

        if number is None:
            raise Refused(f'no value of {each.name} of that name', 3)

        return number

    if isinstance(value, Num):
        exact = exact_of(value.text)

        if exact.denominator != 1:
            raise Refused('an enum number that is no integer', 3)

        if not -2 ** 31 <= exact < 2 ** 31:
            raise Refused('an enum number past its range', 3)

        return int(exact)

    raise Refused(f'no {each.name}', 3)


def read_key(kind, key):
    """A map's key, its key's form (5.3, item 8)."""
    if kind == 'string':
        return key

    if kind == 'bool':
        if key in ('true', 'false'):
            return key == 'true'
        raise Refused('a bool key that is neither true nor false', 3)

    if not DECIMAL.fullmatch(key):
        raise Refused(f'{article(kind)} {kind} key off -?(0|[1-9][0-9]*)', 3)

    low, high = INTEGERS[kind]
    number = int(key)

    if not low <= number <= high:
        raise Refused(f'{article(kind)} {kind} key past its range', 3)

    return number


TIMESTAMP = re.compile(r'([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?'
                       r'(Z|[+-][0-9]{2}:[0-9]{2})')
DURATION = re.compile(r'(-)?(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?s')
EARLIEST, LATEST = -62135596800, 253402300799
LONGEST = 315576000000


def days_from_civil(year, month, day):
    """Days since 1970-01-01 of a date of the proleptic Gregorian calendar (Hinnant's algorithm)."""
    year -= month <= 2
    era = year // 400
    of_era = year - era * 400
    of_year = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    of_era_days = of_era * 365 + of_era // 4 - of_era // 100 + of_year
    return era * 146097 + of_era_days - 719468


def days_in(year, month):
    if month == 2:
        return 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28

    return 30 if month in (4, 6, 9, 11) else 31


def read_timestamp(value):
    found = TIMESTAMP.fullmatch(value) if isinstance(value, str) else None

    if found is None:
        raise Refused('a Timestamp off RFC 3339', 4)

    year, month, day, hour, minute, second = (int(part) for part in found.groups()[:6])
    fraction, zone = found.group(7) or '', found.group(8)

    if not 1 <= month <= 12 or not 1 <= day <= days_in(year, month) or hour > 23 or minute > 59 or second > 59:
        raise Refused('a Timestamp of no instant', 4)

    offset = 0

    if zone != 'Z':
        hours, minutes = int(zone[1:3]), int(zone[4:6])

        if hours > 23 or minutes > 59:
            raise Refused('a Timestamp of no offset', 4)

        offset = (hours * 3600 + minutes * 60) * (1 if zone[0] == '+' else -1)

    seconds = days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offset

    if not EARLIEST <= seconds <= LATEST:
        raise Refused('a Timestamp past its range', 4)

    return {'seconds': seconds, 'nanos': int(fraction.ljust(9, '0'))}


def read_duration(value):
    found = DURATION.fullmatch(value) if isinstance(value, str) else None

    if found is None:
        raise Refused('a Duration off its form', 4)

    sign = -1 if found.group(1) else 1
    seconds, nanos = int(found.group(2)), int((found.group(3) or '').ljust(9, '0'))

    if seconds > LONGEST:
        raise Refused('a Duration past its range', 4)

    return {'seconds': sign * seconds, 'nanos': sign * nanos}


CAMEL_SEGMENT = re.compile(r'[a-z][A-Za-z0-9]*')


def snake_of(segment):
    return ''.join('_' + character.lower() if character.isupper() else character for character in segment)


def camel_of(path):
    """A path's lowerCamelCase: each underscore dropped, a lower-case letter after it raised."""
    out, upper = '', False

    for character in path:
        if character == '_':
            upper = True
        else:
            out, upper = out + (character.upper() if upper and character.islower() else character), False

    return out


def read_field_mask(value):
    if not isinstance(value, str):
        raise Refused('a FieldMask that is no string', 4)

    if value == '':
        return {}

    paths = []

    for path in value.split(','):
        if not path:
            raise Refused('a FieldMask of an empty path', 4)

        segments = path.split('.')

        if any(not CAMEL_SEGMENT.fullmatch(segment) for segment in segments):
            raise Refused('a FieldMask path off lowerCamelCase', 4)

        snake = '.'.join(snake_of(segment) for segment in segments)

        if camel_of(snake) != path:
            raise Refused('a FieldMask path that does not read back', 4)

        paths.append(snake)

    return {'paths': paths}


def read_message(each, value, depth, at=()):
    """A message nested `depth` below the request (steps 2 to 4), its value at `at`."""
    if depth > LIMIT:
        raise Refused('nested past 100', 1, at)

    if each.full_name.startswith(WKT + '.'):
        return read_form(each, value, depth, at)

    if not isinstance(value, Pairs):
        raise Refused(f'{article(each.name)} {each.name} that is no object', 2, at)

    out, named, oneofs = {}, set(), set()

    for key, member in value:
        field = each.field_named(key)

        if field is None:
            raise Refused('a key no field names', 2, given_at(at, key))

        here = field_at(at, field)

        if field.name in named:
            raise Refused('a field by its two names', 2, here)

        named.add(field.name)

        if member is None and not (field.label is None and field.kind in (wkt('Value'), f'enum:{NULL_VALUE.full_name}')):
            continue

        if field.oneof is not None:
            if field.oneof in oneofs:
                raise Refused('two members of one oneof', 2, here)
            oneofs.add(field.oneof)

        out[field.name] = read_field(field, member, depth, here)

    return out


def read_field(field, member, depth, at):
    if field.label == 'repeated':
        if not isinstance(member, list) or isinstance(member, Pairs):
            raise Refused('a repeated field that is no array', 3, at)

        items = []

        for index, item in enumerate(member):
            if item is None and field.kind != wkt('Value'):
                raise Refused('a null item', 2, index_at(at, index))

            items.append(read_single(field.kind, item, depth, index_at(at, index)))

        return items

    if field.label == 'map':
        if not isinstance(member, Pairs):
            raise Refused('a map that is no object', 3, at)

        # * each entry is a message below the one that holds the map (17.9.3), counted before any is read
        if member and depth + 1 > LIMIT:
            raise Refused('nested past 100', 1, at)

        entries, keys = [], set()

        for key, item in member:
            here = given_at(at, key)
            read = located(here, read_key, field.key, key)

            if read in keys:
                raise Refused('two keys of one value', 3, here)

            keys.add(read)

            if item is None and field.kind != wkt('Value'):
                raise Refused('a null value in a map', 2, here)

            entries.append((read, read_single(field.kind, item, depth + 1, here)))

        return entries

    return read_single(field.kind, member, depth, at)


def read_single(kind, value, depth, at):
    if kind.startswith('message:'):
        return read_message(TYPES[kind.split(':', 1)[1]], value, depth + 1, at)

    if kind.startswith('enum:'):
        return located(at, read_enum, TYPES[kind.split(':', 1)[1]], value)

    return located(at, read_scalar, kind, value)


def read_form(each, value, depth, at):
    """A well-known type's form (5.4), the message itself nested `depth` below the request, at `at`."""
    name = each.name

    if name == 'Timestamp':
        return located(at, read_timestamp, value)

    if name == 'Duration':
        return located(at, read_duration, value)

    if name == 'FieldMask':
        return located(at, read_field_mask, value)

    if name in WRAPPED:
        return {'value': located(at, read_scalar, WRAPPED[name], value)}

    if name == 'Empty':
        if not isinstance(value, Pairs):
            raise Refused('an Empty that is no object', 4, at)
        if value:
            raise Refused('a key no field names', 4, given_at(at, value[0][0]))
        return {}

    if name == 'Struct':
        if not isinstance(value, Pairs):
            raise Refused('a Struct that is no object', 4, at)
        if value and depth + 1 > LIMIT:
            raise Refused('nested past 100', 1, at)
        return {'fields': [(key, read_message(TYPES[f'{WKT}.Value'], member, depth + 2, given_at(at, key)))
                           for key, member in value]}

    if name == 'ListValue':
        if not isinstance(value, list) or isinstance(value, Pairs):
            raise Refused('a ListValue that is no array', 4, at)
        return {'values': [read_message(TYPES[f'{WKT}.Value'], item, depth + 1, index_at(at, index))
                           for index, item in enumerate(value)]}

    if name == 'Value':
        if value is None:
            return {'null_value': 0}
        if value is True or value is False:
            return {'bool_value': value}
        if isinstance(value, Num):
            return {'number_value': float(value.text)}
        if isinstance(value, str):
            return {'string_value': value}
        if isinstance(value, Pairs):
            return {'struct_value': read_message(TYPES[f'{WKT}.Struct'], value, depth + 1, at)}
        return {'list_value': read_message(TYPES[f'{WKT}.ListValue'], value, depth + 1, at)}

    # an Any (5.4, item 6)
    if not isinstance(value, Pairs):
        raise Refused('an Any that is no object', 4, at)

    if not value:
        return {}

    types = [member for key, member in value if key == '@type']
    others = Pairs((key, member) for key, member in value if key != '@type')

    if not types:
        raise Refused('an Any without its @type', 4, at)

    url = types[0]

    if not isinstance(url, str) or '/' not in url:
        raise Refused('an Any whose @type is no URL', 4, at)

    held = TYPES.get(url.rsplit('/', 1)[1])

    if not isinstance(held, Message):
        raise Refused('an Any of a type its definitions do not hold', 4, at)

    if held.full_name in OWN_FORMS:
        if [key for key, _ in others] != ['value']:
            raise Refused('an Any of a well-known type whose members are not its value alone', 4, at)
        inner = read_message(held, others[0][1], depth + 1, (*at, ('value', False)))
    else:
        inner = read_message(held, others, depth + 1, at)

    return {'type_url': url, 'message': inner}


def read_body(each, data):
    """A proto request's body, read as 5.2 reads one: the message's value."""
    return read_message(each, read_text(data), 0)


# ── Writing a proto result, Bead's proto JSON form, transcoding 5.6 and 5.7 ─────────────────────


def number_text(digits, exponent):
    """Number::toString of a positive number of these digits, its value int(digits) * 10 ** exponent."""
    digits = digits.lstrip('0')
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


def float_neighbours(value):
    """The 32-bit floats either side of a finite positive one, as exact fractions."""
    bits = struct.unpack('<I', struct.pack('<f', value))[0]
    below = struct.unpack('<f', struct.pack('<I', bits - 1))[0] if bits > 0 else 0.0
    above = struct.unpack('<f', struct.pack('<I', bits + 1))[0]

    # ! past the largest finite float its neighbour is 2^128, where rounding meets the infinity
    return Fraction(below), Fraction(2 ** 128) if math.isinf(above) else Fraction(above), bits % 2 == 0


def reads_back(candidate, value):
    """Whether a decimal reads back to a 32-bit float, the nearest one to it, a tie to the even."""
    exact = Fraction(value)
    below, above, even = float_neighbours(value)
    low, high = (below + exact) / 2, (exact + above) / 2

    if candidate == low or candidate == high:
        return even

    return low < candidate < high


def shortest_float(value):
    """A 32-bit float's shortest decimal that reads back to it, the nearest such where two do (5.6, item 6)."""
    if value == 0:
        return '0'

    if value < 0:
        return '-' + shortest_float(-value)

    exact = Decimal(value)

    for places in range(1, 10):
        quantum = Decimal(1).scaleb(exact.adjusted() - places + 1)
        found = []

        for rounding in (ROUND_FLOOR, ROUND_CEILING):
            candidate = exact.quantize(quantum, rounding=rounding)

            if reads_back(Fraction(candidate), value):
                found.append(candidate)

        if found:
            best = min(found, key=lambda each: (abs(Fraction(each) - Fraction(value)), each))
            _, digits, exponent = best.as_tuple()
            return number_text(''.join(map(str, digits)), exponent)

    raise ValueError(value)


class Unwritten(Exception):
    """A result section 5.7 refuses to write, and why."""


def string_json(text):
    return json.dumps(text, ensure_ascii=False)


def float_json(kind, value):
    if math.isnan(value):
        return '"NaN"'

    if math.isinf(value):
        return '"Infinity"' if value > 0 else '"-Infinity"'

    return shortest_float(value) if kind == 'float' else es(value)


def scalar_json(kind, value):
    if kind in INTEGERS64:
        return f'"{value}"'

    if kind in INTEGERS32:
        return str(value)

    if kind in FLOATS:
        return float_json(kind, value)

    if kind == 'bool':
        return 'true' if value else 'false'

    if kind == 'string':
        return string_json(value)

    return '"' + base64.b64encode(value).decode('ascii') + '"'


def enum_json(each, number):
    if each.full_name == NULL_VALUE.full_name:
        return 'null'

    name = each.name_of(number)
    return str(number) if name is None else string_json(name)


def at_default(field, value):
    """Whether a field with no presence of its own is left out: at its default, a -0 among them, and a
    repeated field or a map that holds nothing (5.6, item 3)."""
    if field.label is not None:
        return not value

    if field.explicit:
        return False

    return value in (0, False, '', b'')


def key_text(kind, key):
    if kind == 'bool':
        return 'true' if key else 'false'

    return str(key)


def sorted_members(members):
    return sorted(members, key=lambda member: member[0].encode('utf-16-be'))


def object_json(members):
    return '{' + ','.join(string_json(name) + ':' + text for name, text in members) + '}'


def single_json(kind, value, depth):
    if kind.startswith('message:'):
        return write_message(TYPES[kind.split(':', 1)[1]], value, depth + 1)

    if kind.startswith('enum:'):
        return enum_json(TYPES[kind.split(':', 1)[1]], value)

    return scalar_json(kind, value)


def field_json(field, value, depth):
    if field.label == 'repeated':
        return '[' + ','.join(single_json(field.kind, item, depth) for item in value) + ']'

    if field.label == 'map':
        return object_json(sorted_members((key_text(field.key, key), single_json(field.kind, item, depth + 1))
                                          for key, item in value))

    return single_json(field.kind, value, depth)


def write_message(each, value, depth=0):
    """A message's JSON in Bead's proto JSON form, the message nested `depth` below the result."""
    if depth > LIMIT:
        raise Unwritten('a message nested past 100')

    if each.full_name.startswith(WKT + '.'):
        return write_form(each, value, depth)

    members = []

    for field in sorted(each.fields, key=lambda one: one.number):
        if field.name not in value or at_default(field, value[field.name]):
            continue

        members.append((field.json_name, field_json(field, value[field.name], depth)))

    return object_json(members)


def fraction_text(nanos):
    """0, 3, 6 or 9 fraction digits, the fewest that hold a count of nanoseconds (5.6, item 7)."""
    if nanos == 0:
        return ''

    for places in (3, 6, 9):
        if nanos % 10 ** (9 - places) == 0:
            return '.' + str(nanos // 10 ** (9 - places)).rjust(places, '0')

    raise ValueError(nanos)


def civil_from_days(days):
    """A date of the proleptic Gregorian calendar from days since 1970-01-01 (Hinnant's algorithm)."""
    days += 719468
    era = days // 146097
    of_era = days - era * 146097
    year_of_era = (of_era - of_era // 1460 + of_era // 36524 - of_era // 146096) // 365
    year = year_of_era + era * 400
    of_year = of_era - (365 * year_of_era + year_of_era // 4 - year_of_era // 100)
    shifted = (5 * of_year + 2) // 153
    day = of_year - (153 * shifted + 2) // 5 + 1
    month = shifted + (3 if shifted < 10 else -9)
    return year + (month <= 2), month, day


def write_timestamp(value):
    seconds, nanos = value.get('seconds', 0), value.get('nanos', 0)

    if not EARLIEST <= seconds <= LATEST or not 0 <= nanos <= 999_999_999:
        raise Unwritten('a Timestamp outside its range')

    days, within = divmod(seconds, 86400)
    year, month, day = civil_from_days(days)
    hour, rest = divmod(within, 3600)
    minute, second = divmod(rest, 60)
    return (f'"{year:04d}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}:{second:02d}'
            f'{fraction_text(nanos)}Z"')


def write_duration(value):
    seconds, nanos = value.get('seconds', 0), value.get('nanos', 0)

    if abs(seconds) > LONGEST or abs(nanos) > 999_999_999 or (seconds > 0 > nanos) or (seconds < 0 < nanos):
        raise Unwritten('a Duration outside its range')

    sign = '-' if seconds < 0 or nanos < 0 else ''
    return f'"{sign}{abs(seconds)}{fraction_text(abs(nanos))}s"'


def write_field_mask(value):
    paths = []

    for path in value.get('paths', []):
        camel = camel_of(path)

        if '.'.join(snake_of(segment) for segment in camel.split('.')) != path:
            raise Unwritten('a FieldMask path whose lowerCamelCase does not read back')

        paths.append(camel)

    return string_json(','.join(paths))


def write_value(value, depth):
    if 'null_value' in value:
        return 'null'

    if 'number_value' in value:
        number = value['number_value']

        if math.isnan(number) or math.isinf(number):
            raise Unwritten('a Value whose number is not finite')

        return es(number)

    if 'string_value' in value:
        return string_json(value['string_value'])

    if 'bool_value' in value:
        return 'true' if value['bool_value'] else 'false'

    if 'struct_value' in value:
        return write_message(TYPES[f'{WKT}.Struct'], value['struct_value'], depth + 1)

    if 'list_value' in value:
        return write_message(TYPES[f'{WKT}.ListValue'], value['list_value'], depth + 1)

    raise Unwritten('a Value that holds no kind')


def write_form(each, value, depth):
    name = each.name

    if name == 'Timestamp':
        return write_timestamp(value)

    if name == 'Duration':
        return write_duration(value)

    if name == 'FieldMask':
        return write_field_mask(value)

    if name in WRAPPED:
        return scalar_json(WRAPPED[name], value.get('value', zero_of(WRAPPED[name])))

    if name == 'Empty':
        return '{}'

    if name == 'Struct':
        if value.get('fields') and depth + 1 > LIMIT:
            raise Unwritten('a message nested past 100')
        return object_json(sorted_members((key, write_message(TYPES[f'{WKT}.Value'], item, depth + 2))
                                          for key, item in value.get('fields', [])))

    if name == 'ListValue':
        return '[' + ','.join(write_message(TYPES[f'{WKT}.Value'], item, depth + 1) for item in value.get('values', [])) + ']'

    if name == 'Value':
        return write_value(value, depth)

    # an Any: @type first, then its message's members or its value (5.6, item 2)
    if not value:
        return '{}'

    url = value.get('type_url', '')
    held = TYPES.get(url.rsplit('/', 1)[1]) if '/' in url else None

    if not isinstance(held, Message):
        raise Unwritten('an Any whose type its definitions do not hold')

    if 'message' not in value:
        raise Unwritten('an Any whose bytes do not read as its type')

    inner = write_message(held, value['message'], depth + 1)
    members = [('@type', string_json(url))]

    if held.full_name in OWN_FORMS:
        members.append(('value', inner))
        return object_json(members)

    return '{' + string_json('@type') + ':' + string_json(url) + (',' + inner[1:] if inner != '{}' else '}')


def zero_of(kind):
    if kind in FLOATS:
        return 0.0

    return {'bool': False, 'string': '', 'bytes': b''}.get(kind, 0)


def write_result(each, value):
    """A proto result's body, in Bead's proto JSON form."""
    return write_message(each, value).encode('utf-8')


# ── Templates, transcoding 3.5 to 3.8 ───────────────────────────────────────────────────────────

TEMPLATE_LITERAL = re.compile(r'[A-Za-z0-9._~-]+')
FIELD_PATH = re.compile(r'[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*')
HEX = set('0123456789abcdefABCDEF')


class Template:
    """A template of http.proto's grammar: its segments, each a literal, * or **, its variables, each
    a field path over a span of them, and its verb."""

    def __init__(self, text):
        self.text, self.segments, self.variables, self.verb = text, [], [], None
        self.position = 0

        if not text.startswith('/'):
            raise Refused('a template that does not begin with /')

        self.position = 1
        self.parse_segments(inside=False)

        if self.position < len(text) and text[self.position] == ':':
            found = TEMPLATE_LITERAL.match(text, self.position + 1)

            if found is None or found.end() != len(text):
                raise Refused('a verb that is no literal')

            self.verb, self.position = found.group(0), found.end()

        if self.position != len(text):
            raise Refused('a literal that is no segment')

        if any(segment == ('**',) for segment in self.segments[:-1]):
            raise Refused('a ** that is not its last segment')

        del self.position

    def parse_segments(self, inside):
        while True:
            self.parse_segment(inside)

            if self.position < len(self.text) and self.text[self.position] == '/':
                self.position += 1
                continue

            return

    def parse_segment(self, inside):
        text, at = self.text, self.position

        if text.startswith('**', at):
            self.segments.append(('**',))
            self.position += 2
        elif text.startswith('*', at):
            self.segments.append(('*',))
            self.position += 1
        elif text.startswith('{', at):
            if inside:
                raise Refused('a variable within a variable')

            found = FIELD_PATH.match(text, at + 1)

            if found is None:
                raise Refused('a variable that names no field path')

            self.position, start = found.end(), len(self.segments)

            if text.startswith('=', self.position):
                self.position += 1
                self.parse_segments(inside=True)
            else:
                self.segments.append(('*',))

            if not text.startswith('}', self.position):
                raise Refused('a variable that does not close')

            self.position += 1
            self.variables.append((found.group(0), start, len(self.segments)))
        else:
            found = TEMPLATE_LITERAL.match(text, at)

            if found is None:
                raise Refused('a literal that is no segment')

            self.segments.append(('literal', found.group(0)))
            self.position = found.end()

    def shape(self):
        """The template up to its variables' names: two of one shape tie (3.9)."""
        return tuple(self.segments), self.verb


def percent_decoded(text, *, keep_slash):
    out, at = bytearray(), 0

    while at < len(text):
        if text[at] == '%':
            digits = text[at + 1:at + 3]

            if len(digits) < 2 or not set(digits) <= HEX:
                raise Refused('a % that two hexadecimal digits do not follow')

            if keep_slash and digits.upper() == '2F':
                out += text[at:at + 3].encode('ascii')
            else:
                out.append(int(digits, 16))

            at += 3
        else:
            out += text[at].encode('utf-8')
            at += 1

    try:
        return out.decode('utf-8')
    except UnicodeDecodeError:
        raise Refused('a value whose bytes are not UTF-8')


def dot_or_empty(segment):
    if segment in ('', '.', '..'):
        return True

    try:
        return percent_decoded(segment, keep_slash=False) in ('.', '..')
    except Refused:
        return False


def split_path(path):
    """A raw path's segments and its verb (3.6, 3.7), or None where it matches no route."""
    if not path.startswith('/'):
        return None

    segments = path[1:].split('/')
    verb = None

    if ':' in segments[-1]:
        at = segments[-1].rindex(':')
        segments[-1], verb = segments[-1][:at], segments[-1][at + 1:]

    if any(dot_or_empty(segment) for segment in segments):
        return None

    return segments, verb


END, LITERAL, STAR, STARS = -1, 0, 1, 2


def ranks(template, count):
    """A matching template's segments by 3.5's order, a template that ends where the path ends before
    a ** of none."""
    found = [LITERAL if segment[0] == 'literal' else STAR if segment == ('*',) else STARS for segment in template.segments]
    return found + ([END] if len(template.segments) == count else [])


def matches(template, segments, verb):
    patterns = template.segments

    if template.verb != verb:
        return False

    if patterns and patterns[-1] == ('**',):
        fixed = patterns[:-1]
        if len(segments) < len(fixed):
            return False
    else:
        fixed = patterns
        if len(segments) != len(fixed):
            return False

    return all(pattern[0] != 'literal' or pattern[1] == segment for pattern, segment in zip(fixed, segments))


def variables_of(template, segments):
    """Each variable's value, decoded as 3.8 decodes a single-segment one or a multi-segment one."""
    consumed = []

    for index, pattern in enumerate(template.segments):
        consumed.append(segments[index:] if pattern == ('**',) else [segments[index]])

    values = {}

    for path, start, end in template.variables:
        multi = end - start > 1 or any(template.segments[index] == ('**',) for index in range(start, end))
        raw = '/'.join(segment for index in range(start, end) for segment in consumed[index])
        try:
            values[path] = percent_decoded(raw, keep_slash=multi)
        except Refused as refusal:
            refusal.place = ('parameter', path)
            raise

    return values


def route_for(templates, path):
    """The index of the template that answers a path among those that match it (3.5), and the indices
    of every one that does; None where none does."""
    split = split_path(path)

    if split is None:
        return None, []

    segments, verb = split
    matching = [index for index, template in enumerate(templates) if matches(template, segments, verb)]

    if not matching:
        return None, []

    return min(matching, key=lambda index: ranks(templates[index], len(segments))), matching


def ties(one, other):
    return one.shape() == other.shape()


# ── Binding, transcoding 4 ──────────────────────────────────────────────────────────────────────


def form_decoded(text):
    """The WHATWG URL Standard's percent-decode of a name or a value of a query, + a space; a % that two
    hexadecimal digits do not follow stays as it is."""
    text = text.replace('+', ' ')
    out, at = bytearray(), 0

    while at < len(text):
        if text[at] == '%' and len(text) > at + 2 and set(text[at + 1:at + 3]) <= HEX:
            out.append(int(text[at + 1:at + 3], 16))
            at += 3
        else:
            out += text[at].encode('utf-8')
            at += 1

    try:
        return out.decode('utf-8')
    except UnicodeDecodeError:
        raise Refused('a query whose bytes are not UTF-8')


def query_pairs(query):
    pairs = []

    for sequence in query.split('&'):
        if sequence:
            name, _, value = sequence.partition('=')
            pairs.append((form_decoded(name), form_decoded(value)))

    return pairs


def text_json(kind, text):
    """A variable's or a parameter's value made the field's JSON (4.2)."""
    if kind == 'bool':
        return {'true': True, 'false': False}.get(text, text)

    if kind.startswith('enum:'):
        return Num(text) if DECIMAL.fullmatch(text) else text

    return text


def fields_along(each, path, *, by_json):
    """The fields a field path names from a message, through non-repeated message fields, by their
    proto names, or by either name where by_json; None where it names none."""
    fields, current = [], each

    for index, part in enumerate(path.split('.')):
        field = current.field_named(part) if by_json else current.by_name.get(part)

        if field is None:
            return None

        fields.append(field)

        if index < len(path.split('.')) - 1:
            if field.label is not None or not field.is_message or field.type_name.startswith(WKT + '.'):
                return None

            current = TYPES[field.type_name]

    return fields


def member_named(members, field):
    return next((index for index, (key, _) in enumerate(members) if key in (field.name, field.json_name)), None)


def set_along(root, fields, value, parameter):
    """Sets a field path's leaf in a JSON object, its messages made where none is; a leaf the object
    sets already, but to null, which is no value, is a field set twice (4.1), refused at the parameter
    that sets it."""
    members = root

    for field in fields[:-1]:
        at = member_named(members, field)

        if at is None or members[at][1] is None:
            child = Pairs()

            if at is None:
                members.append((field.name, child))
            else:
                members[at] = (field.name, child)

            members = child
        elif isinstance(members[at][1], Pairs):
            members = members[at][1]
        else:
            raise Refused('a field that two of the request set', place=('parameter', parameter))

    at = member_named(members, fields[-1])

    if at is not None and members[at][1] is not None:
        raise Refused('a field that two of the request set', place=('parameter', parameter))

    if at is not None:
        del members[at]

    members.append((fields[-1].name, value))


def mask_of(members, each, prefix=''):
    """The paths of the members a body's object holds (4.5)."""
    paths = []

    for key, member in members:
        field = each.field_named(key)

        if field is None:
            continue

        path = prefix + field.name

        if (isinstance(member, Pairs) and member and field.label is None and field.is_message
                and not field.type_name.startswith(WKT + '.')):
            paths.extend(mask_of(member, TYPES[field.type_name], path + '.'))
        else:
            paths.append(path)

    return paths


def json_path(fields):
    return tuple(field.json_name for field in fields)


def held_by_builder(procedure, rule, template):
    """Stops the generator at a rule a builder refuses (3.9), so no entry binds by a route no gateway
    is built of: a variable whose field path names no field, passes a repeated field, or ends at a
    repeated, a map or a message field; a body that names no top-level field or one a variable binds;
    a body on a get or a delete."""
    each = TYPES[procedure.request]

    for path, _, _ in template.variables:
        fields = fields_along(each, path, by_json=False)

        if fields is None or fields[-1].label is not None or fields[-1].is_message:
            raise SystemExit(f'bindings: {rule.template}: {path} is a variable 3.9 refuses')

    if rule.body not in (None, '*') and (rule.body not in each.by_name
                                         or any(path == rule.body for path, _, _ in template.variables)):
        raise SystemExit(f'bindings: {rule.template}: a body of {rule.body}, which 3.9 refuses')

    if rule.body is not None and rule.method in ('get', 'delete'):
        raise SystemExit(f'bindings: {rule.template}: a body on a {rule.method}, which 3.9 refuses')


def bind(procedure, rule, target, body):
    """The request a route binds from its variables, its query and its body (section 4): its value. A
    refusal tells where the request carried what it refuses, as 7.4 places it."""
    each = TYPES[procedure.request]
    path, _, query = target.partition('?')
    template = Template(rule.template)
    split = split_path(path)

    held_by_builder(procedure, rule, template)

    if split is None or not matches(template, *split):
        raise ValueError(f'{target} is not of {rule.template}')

    variables = variables_of(template, split[0])

    if rule.body == '*':
        root = read_text(body)

        # * not an object: the reading refuses it as the message's, with nothing bound beside it
        if not isinstance(root, Pairs):
            try:
                return read_message(each, root, 0)
            except Refused as refusal:
                refusal.place = ('pointer', pointer_text(refusal.at))
                raise
    elif rule.body:
        # * a body null under a field is that field's JSON, null, which leaves it unset (5.2, item 2)
        root = Pairs([(rule.body, read_text(body))])
    else:
        root = Pairs()

    # ! the mask is of the members the body holds as its caller sent them, before a variable joins it:
    # none for a body that is no object
    sent = None

    if rule.body not in (None, '*') and isinstance(root[0][1], Pairs):
        sent = list(root[0][1])
    elif rule.body not in (None, '*') and root[0][1] is None:
        sent = []
    bound, by_variable, by_query = set(), {}, set()

    for field_path, text in variables.items():
        fields = fields_along(each, field_path, by_json=False)
        set_along(root, fields, text_json(fields[-1].kind, text), field_path)
        bound.add(tuple(field.name for field in fields))
        by_variable[json_path(fields)] = field_path

    pairs = query_pairs(query) if query else []

    if pairs and rule.body == '*':
        raise Refused('a query beside a body of the whole request')

    named, items = set(), {}

    for name, text in pairs:
        fields = fields_along(each, name, by_json=True)

        if fields is None:
            raise Refused('a parameter no field path names', place=('parameter', cut(name)))

        leaf, key = fields[-1], tuple(field.name for field in fields)
        parameter = '.'.join(json_path(fields))

        if key in bound or (rule.body and key[0] == rule.body):
            raise Refused('a parameter of a field the route binds otherwise', place=('parameter', parameter))

        if leaf.label == 'map' or (leaf.label == 'repeated' and leaf.is_message):
            raise Refused('a parameter of a map or a repeated message', place=('parameter', parameter))

        if leaf.is_message and leaf.type_name not in STRING_FORMS:
            raise Refused('a parameter of a message', place=('parameter', parameter))

        by_query.add(json_path(fields))

        if leaf.label == 'repeated':
            items.setdefault(key, (fields, []))[1].append(text_json(leaf.kind, text))
            continue

        if key in named:
            raise Refused('a field the query names twice', place=('parameter', parameter))

        named.add(key)

        if leaf.is_message:
            inner = WRAPPED.get(leaf.type_name.rsplit('.', 1)[1])
            value = text_json(inner, text) if inner else text
        else:
            value = text_json(leaf.kind, text)

        set_along(root, fields, value, parameter)

    for fields, values in items.values():
        set_along(root, fields, values, '.'.join(json_path(fields)))

    try:
        value = read_message(each, root, 0)
    except Refused as refusal:
        refusal.place = place_of(refusal.at, rule=rule, sources=(by_variable, by_query))
        raise

    mask = each.by_name.get('update_mask')

    if (rule.method == 'patch' and rule.body not in (None, '*') and mask is not None and mask.kind == wkt('FieldMask')
            and ('update_mask',) not in named):
        body_field = each.by_name[rule.body]

        if body_field.is_message and sent is not None:
            value['update_mask'] = {'paths': mask_of(sent, TYPES[body_field.type_name])}

    return value


def place_of(at, *, rule, sources):
    """Where the request carried the value a reading refused at `at` (7.4): a variable's field path as
    its template writes it, or a query's by JSON names, an item's index left out; or a pointer into the
    body, the field a body names its root."""
    by_variable, by_query = sources
    tokens = tuple(token for token, _ in at)

    for path, field_path in by_variable.items():
        if tokens[:len(path)] == path:
            return 'parameter', field_path

    for path in by_query:
        if tokens[:len(path)] == path:
            return 'parameter', '.'.join(path)

    if rule.body == '*':
        return 'pointer', pointer_text(at)

    return 'pointer', pointer_text(at[1:])


# ── Problems, transcoding 7 ─────────────────────────────────────────────────────────────────────

PHRASES = {400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
           408: 'Request Timeout', 413: 'Content Too Large', 415: 'Unsupported Media Type',
           422: 'Unprocessable Content', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large',
           500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
           504: 'Gateway Timeout'}

CODES = {1: 'ENVELOPE_MALFORMED', 2: 'LAYOUT_UNSUPPORTED', 3: 'KIND_UNSUPPORTED', 4: 'ENVELOPE_TOO_LARGE',
         16: 'DESTINATION_UNKNOWN', 17: 'DESTINATION_UNREACHABLE', 18: 'SERVICE_UNKNOWN', 19: 'PROCEDURE_UNKNOWN',
         20: 'CALL_UNKNOWN', 21: 'SUBSCRIPTION_UNKNOWN', 22: 'SUBSCRIPTION_UNSUPPORTED', 32: 'SESSION_REQUIRED',
         33: 'ACCESS_DENIED', 34: 'PAYLOAD_TOO_LARGE', 35: 'CAPACITY_EXCEEDED', 36: 'CREDENTIAL_UNSUPPORTED',
         48: 'CHUNK_INVALID', 49: 'CREDIT_EXCEEDED', 50: 'PAYLOAD_UNDECODABLE', 51: 'TRANSFER_STALLED',
         52: 'PAYLOAD_INVALID', 64: 'PROCEDURE_FAILED', 65: 'DESTINATION_LOST'}
NUMBERS = {name: code for code, name in CODES.items()}

# where a failure arose (7.5): its server, of the request; its client, before the call went; its
# client, of a result or a notification; the gateway's own reading of the request
ARISINGS = ('server', 'client', 'answer', 'gateway')

# the rows of 7.6's table, in their order: the codes each holds, where they arose, and the status
ROWS = [
    (['ENVELOPE_MALFORMED'], ['server'], 500),
    (['LAYOUT_UNSUPPORTED', 'KIND_UNSUPPORTED'], ['server'], 502),
    (['ENVELOPE_TOO_LARGE', 'PAYLOAD_TOO_LARGE'], ['server', 'client'], 413),
    (['ENVELOPE_TOO_LARGE', 'PAYLOAD_TOO_LARGE'], ['answer'], 502),
    (['DESTINATION_UNKNOWN', 'CALL_UNKNOWN', 'SUBSCRIPTION_UNKNOWN', 'SUBSCRIPTION_UNSUPPORTED', 'CHUNK_INVALID',
      'CREDIT_EXCEEDED'], ['server', 'client', 'answer'], 500),
    (['DESTINATION_UNREACHABLE'], ['client'], 503),
    (['SERVICE_UNKNOWN', 'PROCEDURE_UNKNOWN'], ['server'], 501),
    (['SESSION_REQUIRED'], ['server'], 401),
    (['ACCESS_DENIED'], ['server'], 403),
    (['CAPACITY_EXCEEDED'], ['server', 'client'], 429),
    (['CREDENTIAL_UNSUPPORTED'], ['server'], 500),
    (['PAYLOAD_UNDECODABLE'], ['gateway'], 400),
    (['PAYLOAD_UNDECODABLE'], ['server:native'], 400),
    (['PAYLOAD_UNDECODABLE'], ['server:proto'], 502),
    (['PAYLOAD_UNDECODABLE'], ['answer'], 502),
    (['TRANSFER_STALLED'], ['server', 'client', 'answer'], 504),
    (['PAYLOAD_INVALID'], ['server', 'client'], 422),
    (['PROCEDURE_FAILED'], ['server'], 500),
    (['DESTINATION_LOST'], ['client'], 502),
]
# the rows past the protocol's codes: a code no name names, an application failure, then the gateway's own
UNNAMED_ROW, APPLICATION_ROW = len(ROWS) + 1, len(ROWS) + 2
OWN_ROWS = {'timeout': (len(ROWS) + 3, 504), 'closed': (len(ROWS) + 4, 502), 'unwritable': (len(ROWS) + 5, 500),
            'jwt': (len(ROWS) + 6, 431), 'scheme': (len(ROWS) + 7, 401), 'failed': (len(ROWS) + 8, 500)}


def row_of(code, arose, encoding):
    """The row of 7.6's table a protocol code takes where it arose, from 1, and its status."""
    name = CODES.get(code)

    if name is None:
        return UNNAMED_ROW, 500

    where = f'server:{"proto" if encoding == "proto" else "native"}' if name == 'PAYLOAD_UNDECODABLE' and arose == 'server' else arose

    for number, (names, arisings, status) in enumerate(ROWS, 1):
        if name in names and where in arisings:
            return number, status

    raise ValueError(f'{name} does not arise at {arose}')


FIELD_PATH_ELEMENT = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)(?:\[(-?[0-9]+|true|false|"(?:[^"' + B + B + r']|' + B + B
                                + r'.)*"(?:\.\.\.)?)\])?')
FRAGMENT = set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&\'()*+,;=:@/?')


def elements_of(field_path):
    """A violation's field path's elements (18.4): each name and its subscript, or none."""
    elements, at = [], 0

    while at < len(field_path):
        found = FIELD_PATH_ELEMENT.match(field_path, at)
        elements.append((found.group(1), found.group(2)))
        at = found.end() + (1 if found.end() < len(field_path) and field_path[found.end()] == '.' else 0)

    return elements


def fragment(tokens):
    """A JSON Pointer's URI fragment (RFC 6901 §6): each token escaped, then what a fragment does not
    take percent-encoded from its UTF-8."""
    pointer = ''.join('/' + token.replace('~', '~0').replace('/', '~1') for token in tokens)
    return '#' + ''.join(character if character in FRAGMENT else ''.join(f'%{byte:02X}' for byte in character.encode('utf-8'))
                         for character in pointer)


def pointer_of(each, elements):
    """The tokens of a field's pointer by JSON names, its map's where its key was cut short, and what
    holds a oneof (7.4, item 2)."""
    tokens, current = [], each

    for name, subscript in elements:
        field = current.by_name.get(name) if current else None

        if field is None:
            return tokens

        tokens.append(field.json_name)

        if subscript is None:
            current = TYPES.get(field.type_name) if field.is_message else None
            continue

        if subscript.endswith('...'):
            return tokens

        tokens.append(json.loads(subscript) if subscript.startswith('"') else subscript)
        current = TYPES.get(field.type_name) if field.is_message else None

    return tokens


DEFAULT_WORDS = {'int32.lte': lambda bounds: f'must be less than or equal to {bounds["lte"]}',
                 'string.max_len': lambda bounds: f'must be at most {bounds["max_len"]} characters'}


def errors_of(detail, procedure, rule):
    """PAYLOAD_INVALID's errors, more and stopped, from its detail's lines (7.4)."""
    each = TYPES[procedure.request]
    lines = detail.split('\n')
    closing = json.loads(lines[-1]) if lines and set(json.loads(lines[-1])) <= {'more', 'stopped'} else None
    violations = [json.loads(line) for line in (lines[:-1] if closing is not None else lines)]
    variables = {tuple(path.split('.')): path for path, _, _ in Template(rule.template).variables}
    errors = []

    for found in violations:
        error = {'ruleId': found['ruleId']}
        words = found.get('message') or (DEFAULT_WORDS[found['ruleId']](found.get('bounds', {}))
                                         if found['ruleId'] in DEFAULT_WORDS else None)

        if words:
            error['detail'] = words

        for member in ('fieldPath', 'bounds', 'forKey'):
            if member in found:
                error[member] = found[member]

        elements = elements_of(found.get('fieldPath', ''))
        names = tuple(name for name, _ in elements)

        if names and names in variables:
            error['parameter'] = variables[names]
        elif rule.body == '*':
            error['pointer'] = fragment(pointer_of(each, elements))
        elif rule.body and names and names[0] == rule.body:
            field = each.by_name[rule.body]
            error['pointer'] = fragment(pointer_of(TYPES[field.type_name], elements[1:]) if field.is_message else [])
        elif names and pointer_of(each, [(name, None) for name in names]):
            # * a path that names no field of the request is placed nowhere
            error['parameter'] = '.'.join(pointer_of(each, [(name, None) for name in names]))

        errors.append(error)

    extra = {}

    if closing and closing.get('more'):
        extra['more'] = closing['more']

    if closing and closing.get('stopped'):
        extra['stopped'] = True

    return errors, extra


def problem(status, *, code=None, scope=None, detail=None, title=None, type_=None, extra=None):
    """A problem's members (7.1), in the canonical form of 17.7 (7.2)."""
    members = {'status': status, 'title': title or PHRASES[status], 'type': type_ or 'about:blank'}

    if code is not None:
        members['code'], members['scope'] = code, scope

    if detail:
        members['detail'] = detail

    members.update(extra or {})
    return canonical(members)


def failure_problem(failure, *, procedure=None, rule=None, problem_types=PROBLEM_TYPES):
    """A call's failure as a gateway answers it: its row of 7.6, its status, the fields beside it, and
    its problem's text."""
    code, scope = failure['code'], failure.get('scope', 'protocol')
    detail = failure.get('detail', '')
    fields = {}

    if scope == 'application':
        row, status = APPLICATION_ROW, 400
        name = next((name for name, number in CATALOGUE.items() if number == code), str(code))
        type_ = problem_types + name if problem_types else 'about:blank'
        title = name if problem_types else PHRASES[400]
        return row, status, fields, problem(400, code=code, scope=scope, detail=detail, title=title, type_=type_)

    row, status = row_of(code, failure['arose'], failure.get('encoding', 'proto'))
    name = CODES.get(code, str(code))
    extra = None

    if name == 'PAYLOAD_INVALID':
        errors, extra = errors_of(detail, procedure, rule)
        extra = {'errors': errors, **extra}
        detail = ''

    # * the gateway's own error between it and its server: its code alone (spec 9.0)
    if name == 'DESTINATION_UNREACHABLE':
        detail = ''

    # * where the gateway's reading met what it refuses, as 7.4 places one
    if failure['arose'] == 'gateway':
        extra = {member: failure[member] for member in ('parameter', 'pointer') if member in failure}

    if status == 401:
        challenge = failure.get('challenge', 'Bearer')
        joiner = ', ' if ' ' in challenge else ' '
        fields['www-authenticate'] = challenge + (joiner + 'error="invalid_token"' if failure.get('credential') else '')

    if status in (429, 503):
        fields['retry-after'] = '1'

    return row, status, fields, problem(status, code=code, scope=scope, detail=detail, title=name, type_=TAG + name,
                                        extra=extra)


# ── Events, transcoding 8 ───────────────────────────────────────────────────────────────────────


def event_text(name, number, data):
    return (f'event: {name}\n' if name else '') + f'id: {number}\n' + f'data: {data}\n\n'


def data_of(value):
    """An event's data (8.4): a JSON text as it is, a text as a JSON string, bytes as a JSON string of
    their base64."""
    if isinstance(value, dict) and 'text' in value:
        return string_json(value['text'])

    if isinstance(value, dict) and 'raw' in value:
        return string_json(base64.b64encode(bytes.fromhex(value['raw'].replace(' ', ''))).decode('ascii'))

    return value


def stream_of(steps):
    """What a gateway writes of a stream's call (8.2 to 8.7): the response's status and its body."""
    held, out, count, answered = [], '', 0, False
    steps = [{key: data_of(value) if key in ('result', 'notification') else value for key, value in step.items()}
             for step in steps]

    for step in steps:
        if 'notification' in step and not answered:
            held.append(step['notification'])
        elif 'notification' in step:
            count += 1
            out += event_text(None, count, step['notification'])
        elif 'result' in step:
            answered = True
            count += 1
            out += event_text('result', count, step['result'])

            for data in held:
                count += 1
                out += event_text(None, count, data)

            held = []
        elif 'heartbeat' in step and answered:
            out += ':\n'
        elif 'failure' in step and not answered:
            return step['failure']['status'], step['failure']['problem'], 'application/problem+json'
        elif 'failure' in step:
            count += 1
            return 200, out + event_text('failure', count, step['failure']['problem']), 'text/event-stream'

    return 200, out, 'text/event-stream'


# ── The entries: templates ──────────────────────────────────────────────────────────────────────


def templates_entry(name, clauses, templates, paths):
    """Templates and raw paths: the template each path's route is by 3.5's precedence, its variables
    and its verb; none where none matches; refused where a variable's value does not decode. Two
    templates that tie stop the generator: a gateway refuses a table that holds them (3.5)."""
    parsed = [Template(text) for text in templates]
    found = []

    for index, one in enumerate(parsed):
        if any(ties(one, other) for other in parsed[index + 1:]):
            raise SystemExit(f'templates: {name}: {one.text} ties a template beside it')

    for path in paths:
        index, _ = route_for(parsed, path)
        entry = {'path': path, 'route': index}

        if index is not None:
            split = split_path(path)

            try:
                entry['variables'] = variables_of(parsed[index], split[0])
            except Refused as refusal:
                entry['refused'] = refusal.reason

            if split[1] is not None:
                entry['verb'] = split[1]

        found.append(entry)

    return {'name': name, 'clauses': clauses, 'templates': templates, 'paths': found}


def template_refused(name, clauses, template):
    try:
        Template(template)
    except Refused as refusal:
        return {'name': name, 'clauses': clauses, 'templates': [template], 'refused': refusal.reason}

    raise SystemExit(f'templates: {name}: {template} parses')


def template_tie(name, clauses, one, other, tie):
    if ties(Template(one), Template(other)) != tie:
        raise SystemExit(f'templates: {name}: {one} and {other} {"do not tie" if tie else "tie"}')

    return {'name': name, 'clauses': clauses, 'templates': [one, other], 'tie': tie}


TEMPLATES = [
    templates_entry('a literal before a star', ['3.5', '3.6', '3.8'],
                    ['/v1/books/{name}', '/v1/books/special'], ['/v1/books/special', '/v1/books/other']),
    templates_entry('a star before a double star', ['3.5', '3.6', '3.8'],
                    ['/v1/{name=things/**}', '/v1/things/{id}'], ['/v1/things/a', '/v1/things/a/b']),
    templates_entry("google.longrunning's operations, a route that ends before a double star of none",
                    ['3.5', '3.6', '3.8'], ['/v1/{name=operations}', '/v1/{name=operations/**}'],
                    ['/v1/operations', '/v1/operations/abc', '/v1/operations/a/b']),
    templates_entry('a route that ends before a double star of none, the double star given first',
                    ['3.5', '3.6', '3.8'], ['/v1/{name=operations/**}', '/v1/{name=operations}'], ['/v1/operations']),
    templates_entry('a default route, literal whole, before a rule of a double star', ['3.2', '3.5'],
                    ['/api/{name=**}', '/api/Transcoding/echo'], ['/api/Transcoding/echo', '/api/Transcoding/other']),
    templates_entry('the verb at the last colon its last segment holds unencoded', ['3.7', '3.8'],
                    ['/v1/{name=shelves/*/books/*}:archive', '/v1/{name=shelves/*/books/*}'],
                    ['/v1/shelves/1/books/2:archive', '/v1/shelves/1/books/2', '/v1/shelves/1/books/a:b:archive',
                     '/v1/shelves/1/books/2:frobnicate', '/v1/shelves/1/books/2%3Aarchive']),
    templates_entry('a single-segment variable decoded whole', ['3.6', '3.7', '3.8'], ['/v1/books/{name}'],
                    ['/v1/books/a%2Fb', '/v1/books/caf%C3%A9', '/v1/books/a%3Ab', '/v1/books/a:b', '/v1/books/a+b',
                     '/v1/books/a/b']),
    templates_entry('a multi-segment variable decoded but its %2F', ['3.8'], ['/v1/{name=shelves/*/books/*}'],
                    ['/v1/shelves/a%2Fb/books/c', '/v1/shelves/1/books/%2f', '/v1/shelves/%20/books/x',
                     '/v1/shelves/a%2f%41/books/c']),
    templates_entry('a literal matches its text, never an encoded spelling of it', ['3.6'],
                    ['/api/Transcoding/echo', '/v1/books/{name}'], ['/api/Transcoding/ech%6F', '/v1/bo%6Fks/a']),
    templates_entry('a double star of no segment binds an empty value', ['3.6', '3.8'], ['/v1/{name=**}'],
                    ['/v1', '/v1/a/b/c']),
    templates_entry('no path with an empty or a dot segment matches', ['3.6'], ['/v1/books/{name}', '/v1/{name=**}'],
                    ['/v1/books/..', '/v1/books/.', '/v1/books/%2E%2E', '/v1/books/%2e', '/v1/books/', '/v1//books/a',
                     '/v1/books/a/..']),
    templates_entry('the path / is one empty segment, which no double star takes', ['3.6'], ['/{name=**}'], ['/', '/a']),
    templates_entry('a segment of dots beside other characters is a segment, decoded once', ['3.6', '3.8'],
                    ['/v1/books/{name}'], ['/v1/books/...', '/v1/books/a..b', '/v1/books/.%2E', '/v1/books/%252E']),
    templates_entry('a value whose decoding fails', ['3.8'], ['/v1/books/{name}'],
                    ['/v1/books/%ZZ', '/v1/books/%4', '/v1/books/%FF', '/v1/books/%C3%28']),
    templates_entry('a path is matched case-sensitively', ['3.3', '3.6'], ['/api/Transcoding/echo'],
                    ['/api/transcoding/echo', '/api/Transcoding/Echo', '/api/Transcoding/echo']),
    template_refused('a template that does not begin with a slash', ['3.9'], 'v1/books'),
    template_refused('a double star that is not last', ['3.9'], '/v1/**/books'),
    template_refused('a variable within a variable', ['3.9'], '/v1/{a={b}}'),
    template_refused('a variable that does not close', ['3.9'], '/v1/{name=*'),
    template_refused('a literal that is no segment', ['3.9'], '/v1/bo%6Fks'),
    template_refused('an empty segment', ['3.9'], '/v1//books'),
    template_refused('a verb that is no literal', ['3.9'], '/v1/books:'),
    template_tie('two templates one up to their variables\' names tie', ['3.9'], '/v1/books/{name}', '/v1/books/{id}', True),
    template_tie('a variable of one star and a star tie', ['3.9'], '/v1/{shelf=*}/x', '/v1/{name}/x', True),
    template_tie('a star and a double star do not tie', ['3.9'], '/v1/{name=*}', '/v1/{name=**}', False),
    template_tie('two verbs do not tie', ['3.9'], '/v1/{name}:a', '/v1/{name}:b', False),
]

# ── The entries: readings ───────────────────────────────────────────────────────────────────────

# what upb, protobuf's Python library, reads otherwise than 5.2 to 5.4, by the entry, and the row of
# decision 0037's table that says why it parts
UPB_READS = {}


def nested(count, opening, closing, inner=''):
    return opening * count + inner + closing * count


def reading(name, clauses, body, *, message=EDGES, parts=None):
    """A body read as 5.2 reads one: the message's payload, or the reason it is refused for."""
    data = body if isinstance(body, bytes) else body.encode('utf-8')
    entry = {'name': name, 'clauses': clauses, 'message': message.full_name}

    try:
        entry['body'] = data.decode('utf-8')
    except UnicodeDecodeError:
        entry['bodyBytes'] = hexadecimal(data)

    try:
        entry['payload'] = hexadecimal(encode(message, read_body(message, data)))
    except Refused as refusal:
        entry['refused'] = refusal.reason

        # * where the reading met it, the body the request whole (7.4); none for the text's own
        if refusal.at is not None:
            entry['pointer'] = pointer_text(refusal.at)

    if parts:
        UPB_READS[name] = parts
        entry['upb'] = parts

    return entry


def chain(depth, inner):
    """An Edges whose child holds an Edges, `depth` messages deep, the deepest holding `inner`."""
    return '{"child":' * depth + inner + '}' * depth


TEXT = ['5.2', '5.2.1']
FIELDS = ['5.2', '5.2.2']
SCALAR = ['5.2', '5.2.3']
FORM = ['5.2', '5.2.3']

READINGS = [
    # the text (5.2, item 1)
    reading('a body that is not UTF-8', TEXT, b'\xff'),
    reading('a byte order mark', TEXT, b'\xef\xbb\xbf{}'),
    reading('an empty body', TEXT + ['4.4'], ''),
    reading('two values', TEXT, '{} {}'),
    reading('a trailing comma', TEXT, '{"anInt32":1,}'),
    reading('NaN not quoted', TEXT, '{"aDouble":NaN}'),
    reading('a member named twice', TEXT, '{"anInt32":1,"anInt32":2}'),
    reading('a member named twice once its escapes are read', TEXT, '{"anInt32":1,"an' + B + 'u0049nt32":2}'),
    reading('a surrogate alone', TEXT, '{"labels":{"' + B + 'ud800":1}}'),
    reading('a number past the largest double', TEXT, '{"aDouble":1.89769e308}'),
    reading('a Value nested 100 deep below the request is taken', TEXT, '{"value":' + nested(50, '[', ']') + '}', parts="its bound, 100, counts a text's nesting, not its messages"),
    reading('a Value nested past 100 is refused', TEXT, '{"value":' + nested(50, '[', ']', '1') + '}'),
    reading('a message nested 70 deep is taken, past the 64 of a json payload', TEXT, chain(70, '{}')),
    reading('a message nested 100 deep is taken', TEXT, chain(99, '{"child":{}}'), parts="its bound, 100, counts a text's nesting, not its messages"),
    reading('a message nested 101 deep is refused', TEXT, chain(100, '{"child":{}}')),
    reading("a map's entry 100 deep counts as a message", TEXT, chain(99, '{"labels":{"a":1}}')),
    reading("a map's entry 101 deep is refused", TEXT, chain(100, '{"labels":{"a":1}}')),
    reading("a repeated message's arrays count nothing", TEXT, nested(100, '{"children":[', ']}', '{}'), parts="its bound, 100, counts a text's nesting, not its messages"),
    reading('a Struct nested 25 deep is taken', TEXT, '{"extra":' + nested(25, '{"n":', '}', '{"value":1}') + '}'),
    reading('a Struct nested past 100 is refused', TEXT, '{"extra":' + nested(34, '{"n":', '}', '{"value":1}') + '}', parts="its bound, 100, counts a text's nesting, not its messages"),
    reading("an Any's message counts toward the depth", TEXT,
            chain(98, '{"any":{"@type":"type.googleapis.com/bead.transcoding.v1.Edges","child":{}}}')),
    # the fields (5.2, item 2)
    reading('a body that is null', FIELDS, 'null'),
    reading('a body that is an array', FIELDS, '[]', parts='it reads an array as an empty message'),
    reading('a field by its proto name', FIELDS, '{"an_int32":5}'),
    reading('a field by its JSON name and its proto name', FIELDS, '{"anInt32":1,"an_int32":2}', parts='D6: it takes the last of a field given by its two names'),
    reading('a key no field names', FIELDS, '{"aBool":true}'),
    reading('a key no field names past 64 bytes, its pointer the message that holds it', FIELDS + ['7.4', '7.4.2'],
            '{"child":{"' + 'k' * 65 + '":1}}'),
    reading("a map's value refused under a key past 64 bytes, its pointer the map that holds it",
            FIELDS + ['7.4', '7.4.2'], '{"labels":{"' + 'k' * 63 + chr(0xE9) + '":"x"}}'),
    reading('a key no field names of 64 bytes, its pointer whole', FIELDS + ['7.4', '7.4.2'],
            '{"child":{"' + 'k' * 62 + chr(0xE9) + '":1}}'),
    reading('a field of a JSON name of its own, by it', FIELDS, '{"renamed":"x"}', message=EVERYTHING),
    reading('a field of a JSON name of its own, by its proto name', FIELDS, '{"custom_named":"x"}', message=EVERYTHING),
    reading('a field of a JSON name of its own, by the name it would have', FIELDS, '{"customNamed":"x"}',
            message=EVERYTHING),
    reading('null leaves each field unset', FIELDS,
            '{"anInt32":null,"at":null,"ints":null,"labels":null,"child":null,"wrappedInt64":null,"any":null,'
            '"aliased":null,"maybeDouble":null}'),
    reading("null is a Value's null_value", FIELDS, '{"value":null}'),
    reading("null sets a oneof's NullValue", FIELDS, '{"nullMember":null}'),
    reading("NULL_VALUE sets a oneof's NullValue", FIELDS, '{"nullMember":"NULL_VALUE"}'),
    reading("a oneof's null member before its other", FIELDS, '{"choiceText":null,"choiceInner":{}}', message=EVERYTHING),
    reading("a oneof's null member after its other", FIELDS, '{"choiceInner":{},"choiceText":null}', message=EVERYTHING),
    reading('two members of one oneof', FIELDS, '{"choiceText":"a","choiceInner":{}}', message=EVERYTHING),
    reading("a NullValue's null and its oneof's other member", FIELDS, '{"nullMember":null,"textMember":"a"}', parts="it reads a NullValue's null beside its oneof's other member as no member"),
    reading('a null item', FIELDS, '{"ints":[1,null]}'),
    reading('a null Timestamp item', FIELDS, '{"stamps":[null]}'),
    reading('a null value in a map', FIELDS, '{"labels":{"a":null}}'),
    reading("a null member of a Struct is a Value's", FIELDS, '{"extra":{"a":null}}'),
    reading("a null item of a ListValue is a Value's", FIELDS, '{"value":[null]}'),
    reading('one value for a repeated field', FIELDS, '{"ints":1}'),
    # the scalars (5.3)
    reading('an int32 written 1e2', SCALAR + ['5.3', '5.3.1'], '{"anInt32":1e2}'),
    reading('an int32 written 5.0', SCALAR + ['5.3', '5.3.1'], '{"anInt32":5.0}'),
    reading('an int32 as a string of an exponent', SCALAR + ['5.3', '5.3.1', '5.5'], '{"anInt32":"1e2"}'),
    reading('an int32 as a string of a fraction of zero', SCALAR + ['5.3', '5.3.1'], '{"anInt32":"5.0"}'),
    reading('an int32 that is no integer', SCALAR + ['5.3', '5.3.1'], '{"anInt32":0.5}'),
    reading('an int32 as a string with a space', SCALAR + ['5.3', '5.3.1'], '{"anInt32":" 5"}'),
    reading('an int32 past its range', SCALAR + ['5.3', '5.3.1'], '{"anInt32":2147483648}'),
    reading('an int32 of -0', SCALAR + ['5.3', '5.3.1'], '{"anInt32":-0}'),
    reading('a uint32 of -1', SCALAR + ['5.3', '5.3.1'], '{"aUint32":-1}'),
    reading('an int32 in hexadecimal', SCALAR + ['5.3', '5.3.1'], '{"anInt32":"0x10"}'),
    reading('an int64 at its largest, as a string', SCALAR + ['5.3', '5.3.2'], '{"anInt64":"9223372036854775807"}'),
    reading('an int64 as a string of an exponent', SCALAR + ['5.3', '5.3.2', '5.5'], '{"anInt64":"1e3"}', parts='D8: it reads a 64-bit string of an exponent'),
    reading('an int64 of a leading zero', SCALAR + ['5.3', '5.3.2'], '{"anInt64":"01"}', parts='it reads a 64-bit string of a leading zero'),
    reading('an int64 past its range, as a string', SCALAR + ['5.3', '5.3.2'], '{"anInt64":"9223372036854775808"}'),
    reading('an int64 past 2^53 as a number, read exactly', SCALAR + ['5.3', '5.3.2'], '{"anInt64":9007199254740993}'),
    reading('an int64 at its largest as a number, read exactly', SCALAR + ['5.3', '5.3.2'],
            '{"anInt64":9223372036854775807}'),
    reading('an int64 written 1.0', SCALAR + ['5.3', '5.3.2'], '{"anInt64":1.0}'),
    reading('an int64 written 1e2', SCALAR + ['5.3', '5.3.2'], '{"anInt64":1e2}'),
    reading('an sint32 at its least', SCALAR + ['5.3', '5.3.1'], '{"anSint32":-2147483648}'),
    reading('an sint32 past its range', SCALAR + ['5.3', '5.3.1'], '{"anSint32":2147483648}'),
    reading('an sint32 as a string', SCALAR + ['5.3', '5.3.1'], '{"anSint32":"-5"}'),
    reading('an sfixed32 at its least, as a string', SCALAR + ['5.3', '5.3.1'], '{"anSfixed32":"-2147483648"}'),
    reading('an sfixed32 past its range', SCALAR + ['5.3', '5.3.1'], '{"anSfixed32":-2147483649}'),
    reading('a fixed32 at its largest', SCALAR + ['5.3', '5.3.1'], '{"aFixed32":4294967295}'),
    reading('a fixed32 of -1', SCALAR + ['5.3', '5.3.1'], '{"aFixed32":-1}'),
    reading('a fixed32 as a string of an exponent', SCALAR + ['5.3', '5.3.1'], '{"aFixed32":"1e3"}'),
    reading('an sfixed64 at its least, as a string', SCALAR + ['5.3', '5.3.2'], '{"anSfixed64":"-9223372036854775808"}'),
    reading('an sfixed64 past its range, as a string', SCALAR + ['5.3', '5.3.2'],
            '{"anSfixed64":"9223372036854775808"}'),
    reading('an sfixed64 past 2^53 as a number, read exactly', SCALAR + ['5.3', '5.3.2'],
            '{"anSfixed64":-9007199254740993}'),
    reading('an sfixed64 as a string of an exponent', SCALAR + ['5.3', '5.3.2', '5.5'], '{"anSfixed64":"1e3"}',
            parts='D8: it reads a 64-bit string of an exponent'),
    reading("an Int64Value as a string of an exponent", SCALAR + ['5.3', '5.3.2', '5.4', '5.4.4'],
            '{"wrappedInt64":"1e3"}', parts='D8: it reads a 64-bit string of an exponent'),
    reading('a UInt64Value at its largest as a number, read exactly', SCALAR + ['5.3', '5.3.2', '5.4', '5.4.4'],
            '{"wrappedUint64":18446744073709551615}'),
    reading('a float past its largest', SCALAR + ['5.3', '5.3.3'], '{"aFloat":3.4028236e38}'),
    reading('a float that rounds to its largest', SCALAR + ['5.3', '5.3.3'], '{"aFloat":3.40282356e38}', parts="it holds a float's double to the largest float before it rounds it"),
    reading('a float under its smallest, read as 0', SCALAR + ['5.3', '5.3.3'], '{"aFloat":1e-46}'),
    reading('a float as a string', SCALAR + ['5.3', '5.3.3'], '{"aFloat":"1"}'),
    reading('a float NaN', SCALAR + ['5.3', '5.3.3'], '{"aFloat":"NaN"}'),
    reading('a double -Infinity', SCALAR + ['5.3', '5.3.3'], '{"aDouble":"-Infinity"}'),
    reading('a double as the string inf', SCALAR + ['5.3', '5.3.3'], '{"aDouble":"inf"}', parts="it reads a double's string as Python's float() reads one"),
    reading('a double as a string of an exponent', SCALAR + ['5.3', '5.3.3'], '{"aDouble":"1e2"}'),
    reading('a double as a string with a space', SCALAR + ['5.3', '5.3.3'], '{"aDouble":" 1"}', parts="it reads a double's string as Python's float() reads one"),
    reading('a double as an empty string', SCALAR + ['5.3', '5.3.3'], '{"aDouble":""}'),
    reading('a bool as a string', SCALAR + ['5.3', '5.3.4'], '{"aBool":"true"}', message=EVERYTHING),
    reading('a bool as 1', SCALAR + ['5.3', '5.3.4'], '{"aBool":1}', message=EVERYTHING),
    reading('a string as a number', SCALAR + ['5.3', '5.3.5'], '{"aString":12345}', message=EVERYTHING),
    reading('bytes in standard base64', SCALAR + ['5.3', '5.3.6'], '{"someBytes":"AQI="}'),
    reading('bytes in URL-safe base64, their pad bits whatever they are', SCALAR + ['5.3', '5.3.6'],
            '{"someBytes":"-_"}'),
    reading('bytes unpadded', SCALAR + ['5.3', '5.3.6'], '{"someBytes":"AQ"}'),
    reading('bytes short of a padding', SCALAR + ['5.3', '5.3.6'], '{"someBytes":"AQ="}', parts='D19: it takes base64 padded wrongly'),
    reading('bytes past their padding', SCALAR + ['5.3', '5.3.6'], '{"someBytes":"AQ==="}', parts='D19: it takes base64 padded wrongly'),
    reading('bytes of two alphabets', SCALAR + ['5.3', '5.3.6'], '{"someBytes":"+_8="}', parts='D19: it takes base64 of two alphabets'),
    reading('bytes with a space', SCALAR + ['5.3', '5.3.6', '5.5'], '{"someBytes":"A Q=="}', parts='it takes base64 with white space in it'),
    reading('bytes with a line feed', SCALAR + ['5.3', '5.3.6', '5.5'], '{"someBytes":"AQ==' + B + 'n"}', parts='it takes base64 with white space in it'),
    reading('an enum by its second name', SCALAR + ['5.3', '5.3.7'], '{"aliased":"ALIASED_SECOND"}'),
    reading('an enum by its name in lower case', SCALAR + ['5.3', '5.3.7'], '{"aliased":"aliased_first"}'),
    reading('an open enum by a number no value numbers', SCALAR + ['5.3', '5.3.7'], '{"aliased":2}'),
    reading('an enum by a name no value has', SCALAR + ['5.3', '5.3.7'], '{"aliased":"UNKNOWN"}'),
    reading('an enum by a fraction', SCALAR + ['5.3', '5.3.7'], '{"aliased":1.5}', parts="it reads an enum's number with a fraction, the fraction dropped"),
    reading('an int32 key of a leading zero', SCALAR + ['5.3', '5.3.8'], '{"byInt32":{"01":"a"}}', parts="D18: it reads an integer key as Python's int() reads one"),
    reading('an int32 key of a plus sign', SCALAR + ['5.3', '5.3.8'], '{"byInt32":{"+1":"a"}}', parts="D18: it reads an integer key as Python's int() reads one"),
    reading('an int32 key of -0', SCALAR + ['5.3', '5.3.8'], '{"byInt32":{"-0":"a"}}'),
    reading('an int32 key written 1.0', SCALAR + ['5.3', '5.3.8', '5.5'], '{"byInt32":{"1.0":"a"}}', parts='it reads an integer key of a fraction of zero'),
    reading('an int32 key with a space', SCALAR + ['5.3', '5.3.8'], '{"byInt32":{" 1":"a"}}'),
    reading('a uint32 key of -1', SCALAR + ['5.3', '5.3.8'], '{"byUint32":{"-1":"a"}}'),
    reading('an int64 key of an exponent', SCALAR + ['5.3', '5.3.8'], '{"byInt64":{"1e3":"a"}}', parts='D8: it reads a 64-bit key of an exponent'),
    reading('two int32 keys of one value', SCALAR + ['5.3', '5.3.8', '5.5'], '{"byInt32":{"0":"a","-0":"b"}}', parts='it takes the last of two keys of one value'),
    reading('bool keys', SCALAR + ['5.3', '5.3.8'], '{"flags":{"true":"y","false":"n"}}', message=EVERYTHING),
    reading('a bool key of a capital', SCALAR + ['5.3', '5.3.8'], '{"flags":{"True":"y"}}', message=EVERYTHING),
    # the well-known types (5.4)
    reading('a Timestamp at its earliest', FORM + ['5.4', '5.4.1'], '{"at":"0001-01-01T00:00:00Z"}'),
    reading('a Timestamp at its latest', FORM + ['5.4', '5.4.1'], '{"at":"9999-12-31T23:59:59.999999999Z"}'),
    reading('a Timestamp before its earliest', FORM + ['5.4', '5.4.1'], '{"at":"0000-12-31T23:59:59Z"}'),
    reading('a Timestamp of 10 fraction digits', FORM + ['5.4', '5.4.1'], '{"at":"2026-10-21T12:00:00.1234567891Z"}'),
    reading('a Timestamp of an empty fraction', FORM + ['5.4', '5.4.1'], '{"at":"2026-10-21T12:00:00.Z"}', parts='it takes a Timestamp of an empty fraction'),
    reading('a Timestamp of a leap second', FORM + ['5.4', '5.4.1'], '{"at":"2016-12-31T23:59:60Z"}'),
    reading('a Timestamp of a lower-case t', FORM + ['5.4', '5.4.1'], '{"at":"2026-10-21t12:00:00Z"}'),
    reading('a Timestamp of a lower-case z', FORM + ['5.4', '5.4.1'], '{"at":"2026-10-21T12:00:00z"}'),
    reading('a Timestamp of a space for its T', FORM + ['5.4', '5.4.1'], '{"at":"2026-10-21 12:00:00Z"}'),
    reading('a Timestamp of the offset -00:00', FORM + ['5.4', '5.4.1'], '{"at":"2026-10-21T12:00:00-00:00"}'),
    reading('a Timestamp of the offset +23:59', FORM + ['5.4', '5.4.1'], '{"at":"2026-10-21T12:00:00+23:59"}'),
    reading('a Timestamp of the offset +24:00', FORM + ['5.4', '5.4.1'], '{"at":"2026-10-21T12:00:00+24:00"}', parts='it takes an offset of 24 hours'),
    reading('a Timestamp of an offset with no colon', FORM + ['5.4', '5.4.1'], '{"at":"1970-01-01T08:00:01+0800"}'),
    reading('a Timestamp of an offset, read in UTC', FORM + ['5.4', '5.4.1'], '{"at":"1970-01-01T08:00:01+08:00"}'),
    reading('a Timestamp of February 30', FORM + ['5.4', '5.4.1'], '{"at":"2026-02-30T00:00:00Z"}'),
    reading('a Timestamp of February 29 in a leap year', FORM + ['5.4', '5.4.1'], '{"at":"2024-02-29T00:00:00Z"}'),
    reading('a Timestamp of February 29 in another', FORM + ['5.4', '5.4.1'], '{"at":"2025-02-29T00:00:00Z"}'),
    reading('a Timestamp of February 29 in a year 400 divides', FORM + ['5.4', '5.4.1'], '{"at":"2000-02-29T00:00:00Z"}'),
    reading('a Timestamp of February 29 in a century 400 does not divide', FORM + ['5.4', '5.4.1'],
            '{"at":"1900-02-29T00:00:00Z"}'),
    reading('a Timestamp of the hour 24', FORM + ['5.4', '5.4.1'], '{"at":"2026-10-21T24:00:00Z"}'),
    reading('a Timestamp its offset takes past its latest', FORM + ['5.4', '5.4.1'], '{"at":"9999-12-31T23:59:59-01:00"}'),
    reading('a Timestamp its offset takes before its earliest', FORM + ['5.4', '5.4.1'],
            '{"at":"0001-01-01T00:00:00+01:00"}'),
    reading('a Duration of 10 fraction digits', FORM + ['5.4', '5.4.2'], '{"took":"1.0000000001s"}', parts='D14: it takes a Duration of more than 9 fraction digits'),
    reading('a Duration of a plus sign', FORM + ['5.4', '5.4.2'], '{"took":"+1s"}', parts="it reads a Duration as Python's float() reads its number"),
    reading('a Duration of a leading point', FORM + ['5.4', '5.4.2'], '{"took":".5s"}'),
    reading('a Duration of a trailing point', FORM + ['5.4', '5.4.2'], '{"took":"1.s"}', parts="it reads a Duration as Python's float() reads its number"),
    reading('a Duration of -0s', FORM + ['5.4', '5.4.2'], '{"took":"-0s"}'),
    reading('a Duration of a leading zero', FORM + ['5.4', '5.4.2', '5.5'], '{"took":"01s"}', parts='D13: it takes a Duration of a leading zero'),
    reading('a Duration of an exponent', FORM + ['5.4', '5.4.2'], '{"took":"1e3s"}'),
    reading('a Duration at its longest', FORM + ['5.4', '5.4.2'], '{"took":"315576000000.999999999s"}'),
    reading('a Duration past its longest', FORM + ['5.4', '5.4.2'], '{"took":"315576000001s"}'),
    reading('a Duration of a capital S', FORM + ['5.4', '5.4.2'], '{"took":"1S"}'),
    reading('a Duration of no s', FORM + ['5.4', '5.4.2'], '{"took":"1"}'),
    reading('a Duration of a negative fraction', FORM + ['5.4', '5.4.2'], '{"took":"-0.5s"}'),
    reading('a Duration as an object', FORM + ['5.4', '5.4.2'], '{"took":{"seconds":"1"}}'),
    reading('a FieldMask of two paths', FORM + ['5.4', '5.4.3'], '{"mask":"fooBar,baz"}'),
    reading('a FieldMask of a snake-case path', FORM + ['5.4', '5.4.3'], '{"mask":"foo_bar"}'),
    reading('a FieldMask path that opens upper-case', FORM + ['5.4', '5.4.3', '5.5'], '{"mask":"FooBar"}', parts='D15: it takes a path that opens upper-case'),
    reading('an empty FieldMask', FORM + ['5.4', '5.4.3'], '{"mask":""}'),
    reading('a FieldMask of an empty path', FORM + ['5.4', '5.4.3', '5.5'], '{"mask":"a,,b"}', parts='D16: it takes an empty path'),
    reading('a FieldMask path of a digit', FORM + ['5.4', '5.4.3'], '{"mask":"foo1Bar"}'),
    reading('a FieldMask path of upper-case letters in a row', FORM + ['5.4', '5.4.3', '5.5'], '{"mask":"fOO"}'),
    reading('a FieldMask path of a field within a field', FORM + ['5.4', '5.4.3'], '{"mask":"a.bC"}'),
    reading('a FieldMask as an object', FORM + ['5.4', '5.4.3'], '{"mask":{"paths":["a"]}}'),
    reading('a FloatValue', FORM + ['5.4', '5.4.4'], '{"wrappedFloat":0.1}'),
    reading('a wrapper as an object', FORM + ['5.4', '5.4.4'], '{"wrappedInt64":{"value":"1"}}'),
    reading('a Value of every kind', FORM + ['5.4', '5.4.5'], '{"value":{"a":[1,"x",true,null,{}]}}'),
    reading('a ListValue as a Value of lists', FORM + ['5.4', '5.4.5'], '{"value":[[],[[]]]}'),
    reading('an Any of a Duration', FORM + ['5.4', '5.4.6'],
            '{"any":{"@type":"type.googleapis.com/google.protobuf.Duration","value":"1s"}}'),
    reading('an Any whose @type comes last', FORM + ['5.4', '5.4.6'],
            '{"any":{"value":"1s","@type":"type.googleapis.com/google.protobuf.Duration"}}'),
    reading('an Any of a message of its definitions', FORM + ['5.4', '5.4.6'],
            '{"any":{"@type":"type.googleapis.com/bead.transcoding.v1.Inner","name":"a","count":2}}'),
    reading('an Any of an Empty', FORM + ['5.4', '5.4.6'], '{"any":{"@type":"type.googleapis.com/google.protobuf.Empty"}}'),
    reading('an Any of an Empty with a value', FORM + ['5.4', '5.4.6'],
            '{"any":{"@type":"type.googleapis.com/google.protobuf.Empty","value":{}}}'),
    reading('an Any of a Struct', FORM + ['5.4', '5.4.6'],
            '{"any":{"@type":"type.googleapis.com/google.protobuf.Struct","value":{"a":1}}}'),
    reading('an empty Any', FORM + ['5.4', '5.4.6'], '{"any":{}}'),
    reading('an Any with no @type', FORM + ['5.4', '5.4.6', '5.5'], '{"any":{"x":1}}'),
    reading('an Any of a type its definitions do not hold', FORM + ['5.4', '5.4.6'],
            '{"any":{"@type":"type.googleapis.com/nope.Nope","x":1}}'),
    reading('an Any whose @type is no URL', FORM + ['5.4', '5.4.6'], '{"any":{"@type":"not_a_url","value":""}}'),
    reading('an Any whose @type is empty', FORM + ['5.4', '5.4.6'], '{"any":{"@type":"","value":""}}'),
    reading('an Any of a Duration with no value', FORM + ['5.4', '5.4.6', '5.5'],
            '{"any":{"@type":"type.googleapis.com/google.protobuf.Duration"}}'),
    reading('an Empty', FORM + ['5.4', '5.4.7'], '{"nothing":{}}'),
    reading('an Empty with a member', FORM + ['5.4', '5.4.7'], '{"nothing":{"x":1}}'),
    reading('a body of every kind of field', ['5.2', '5.2.1', '5.2.2', '5.2.3', '5.2.4', '5.3', '5.4'], json.dumps({
        'aDouble': 1.5, 'aFloat': 0.1, 'anInt64': '-5', 'aUint64': '18446744073709551615', 'anInt32': -2,
        'aFixed64': '7', 'aBool': True, 'aString': 'caf' + chr(0xE9), 'someBytes': '3q2+7w==', 'aUint32': 4294967295,
        'aSint64': '-9223372036854775808', 'color': 'COLOR_GREEN', 'inner': {'name': 'n', 'count': 3},
        'int64s': ['1', 2, '-3'], 'inners': [{'name': 'a'}, {}], 'labels': {'b': 2, 'a': 1}, 'byId': {'10': 'x', '-1': 'y'},
        'flags': {'true': 't'}, 'maybe': 0, 'choiceText': '', 'at': '2026-10-21T12:00:00.5Z', 'took': '-1.5s',
        'mask': 'fooBar,baz', 'extra': {'k': [1, None]}, 'anyValue': 'v', 'wrappedInt64': '0', 'wrappedString': '',
        'nothing': {}, 'renamed': 'r', 'list': [True], 'wrappedBool': False,
    }, ensure_ascii=False, separators=(',', ':')), message=EVERYTHING),
]


# ── The entries: writings ───────────────────────────────────────────────────────────────────────

# what upb reads back of a body Bead writes otherwise than the message it was written from, by the
# entry, and the row of decision 0037's table that says why
UPB_WRITES = {}

ANY_URL = 'type.googleapis.com/'
FLOAT_MAX = struct.unpack('<f', struct.pack('<I', 0x7F7FFFFF))[0]
FLOAT_TRUE_MIN = struct.unpack('<f', struct.pack('<I', 1))[0]
FLOAT_MIN_NORMAL = struct.unpack('<f', struct.pack('<I', 0x00800000))[0]


def writing(name, clauses, value, *, message=EDGES, parts=None):
    """A result's payload, and the body 5.6 writes of it, or the reason 5.7 refuses it for."""
    entry = {'name': name, 'clauses': clauses, 'message': message.full_name,
             'payload': hexadecimal(encode(message, value))}

    try:
        entry['body'] = write_result(message, value).decode('utf-8')
    except Unwritten as refusal:
        entry['refused'] = str(refusal)

    if parts:
        UPB_WRITES[name] = parts
        entry['upb'] = parts

    return entry


EVERY = {
    'a_double': 1.5, 'a_float': f32(0.1), 'an_int64': -5, 'a_uint64': 2 ** 64 - 1, 'an_int32': -2, 'a_fixed64': 7,
    'a_bool': True, 'a_string': 'caf' + chr(0xE9), 'some_bytes': bytes.fromhex('DEADBEEF'), 'a_uint32': 2 ** 32 - 1,
    'a_sint64': -2 ** 63, 'color': 2, 'inner': {'name': 'n', 'count': 3}, 'int64s': [1, 2, -3],
    'inners': [{'name': 'a'}, {}], 'labels': [('b', 2), ('a', 1)], 'by_id': [(10, 'x'), (-1, 'y'), (2, 'z')],
    'flags': [(True, 't'), (False, 'f')], 'maybe': 0, 'choice_text': '',
    'at': {'seconds': 1792584000, 'nanos': 500_000_000}, 'took': {'seconds': -1, 'nanos': -500_000_000},
    'mask': {'paths': ['foo_bar', 'baz']},
    'extra': {'fields': [('k', {'list_value': {'values': [{'number_value': 1.0}, {'null_value': 0}]}}),
                         ('a', {'bool_value': True})]},
    'any_value': {'string_value': 'v'}, 'wrapped_int64': {}, 'wrapped_string': {'value': ''}, 'nothing': {},
    'custom_named': 'r', 'list': {'values': [{'bool_value': True}]}, 'wrapped_bool': {'value': False},
}


def child(depth, inner):
    return inner if depth == 0 else {'child': child(depth - 1, inner)}


FORM_6 = ['5.6', '5.6.6']
FORM_7 = ['5.6', '5.6.7']
REFUSED = ['5.7']

WRITINGS = [
    writing("every kind of field, in its numbers' order", ['5.6', '5.6.1', '5.6.2', '5.6.3', '5.6.4', '5.6.5', '5.6.6',
                                                           '5.6.7'], EVERY, message=EVERYTHING),
    writing('a message with nothing set', ['5.6', '5.6.3'], {}, message=EVERYTHING),
    writing("a map's entries sorted by their keys' code units", ['5.6', '5.6.4'],
            {'labels': [('b', 1), ('10', 2), ('a', 3), (chr(0xE9), 4), ('Z', 5), (chr(0x1F600), 6), (chr(0xFF61), 7)]}),
    writing("an integer map's keys sorted as strings", ['5.6', '5.6.4'], {'by_int64': [(10, 'x'), (2, 'y'), (-1, 'z')]}),
    writing("a Struct's members sorted", ['5.6', '5.6.4', '5.6.7'],
            {'extra': {'fields': [('b', {'number_value': 1.0}), ('10', {'number_value': 2.0}), ('a', {'number_value': 3.0})]}}),
    writing('a float at its shortest', FORM_6, {'a_float': f32(0.1)}),
    writing('a FloatValue at its shortest', FORM_6 + FORM_7, {'wrapped_float': {'value': f32(0.1)}}),
    writing('a float at its largest', FORM_6, {'a_float': FLOAT_MAX}, parts='it refuses its own largest float, holding its double to the largest float before it rounds it'),
    writing('a float at its least', FORM_6, {'a_float': FLOAT_TRUE_MIN}),
    writing('a float at its least normal', FORM_6, {'a_float': FLOAT_MIN_NORMAL}),
    writing('a float of 16777217 written as the float it is', FORM_6, {'a_float': f32(16777217.0)}),
    writing('a double of 1e20', ['5.6', '5.6.1'], {'a_double': 1e20}),
    writing('a double of 1e21', ['5.6', '5.6.1'], {'a_double': 1e21}),
    writing('a double of 1e-7', ['5.6', '5.6.1'], {'a_double': 1e-7}),
    writing('a double of 1e-6', ['5.6', '5.6.1'], {'a_double': 1e-6}),
    writing('a double at its least', ['5.6', '5.6.1'], {'a_double': 5e-324}),
    writing('a double of 123456789.123', ['5.6', '5.6.1'], {'a_double': 123456789.123}),
    writing('a -0 of no presence of its own, left out', ['5.6', '5.6.1', '5.6.3'], {'a_double': -0.0}, parts='D4: it writes -0 as -0.0'),
    writing('a float of -0, left out', ['5.6', '5.6.1', '5.6.3'], {'a_float': -0.0}, parts='D4: it writes -0 as -0.0'),
    writing('a -0 of its own presence, written 0', ['5.6', '5.6.1', '5.6.3'], {'maybe_double': -0.0}, parts='D4: it writes -0 as -0.0'),
    writing("a Value's -0, written 0", ['5.6', '5.6.1', '5.6.7'], {'value': {'number_value': -0.0}}, parts='D4: it writes -0 as -0.0'),
    writing('a double NaN', FORM_6, {'a_double': math.nan}),
    writing('a float Infinity', FORM_6, {'a_float': math.inf}),
    writing('a double -Infinity', FORM_6, {'a_double': -math.inf}),
    writing('an aliased enum by its first name', ['5.6', '5.6.5'], {'aliased': 1}),
    writing('an enum by a number no value numbers', ['5.6', '5.6.5'], {'aliased': 7}),
    writing("a oneof's NullValue as null", ['5.6', '5.6.5'], {'null_member': 0}),
    writing("an Any of a Duration, its @type first", ['5.6', '5.6.2', '5.6.7'],
            {'any': {'type_url': ANY_URL + 'google.protobuf.Duration', 'message': {'seconds': 1}}}),
    writing('an Any of a message of its definitions', ['5.6', '5.6.2'],
            {'any': {'type_url': ANY_URL + 'bead.transcoding.v1.Inner', 'message': {'name': 'a', 'count': 2}}}),
    writing('an Any of an Empty', ['5.6', '5.6.2'], {'any': {'type_url': ANY_URL + 'google.protobuf.Empty', 'message': {}}}),
    writing('an Any of a Struct', ['5.6', '5.6.2', '5.6.7'],
            {'any': {'type_url': ANY_URL + 'google.protobuf.Struct',
                     'message': {'fields': [('a', {'number_value': 1.0})]}}}),
    writing('an Any of an Any', ['5.6', '5.6.2', '5.6.7'],
            {'any': {'type_url': ANY_URL + 'google.protobuf.Any',
                     'message': {'type_url': ANY_URL + 'google.protobuf.Duration', 'message': {'seconds': 1}}}}),
    writing('an Any that holds nothing', ['5.6', '5.6.7'], {'any': {}}),
    writing('an Any of a type its definitions do not hold', REFUSED,
            {'any': {'type_url': ANY_URL + 'nope.Nope', 'value': b'\x08\x01'}}),
    writing('an Any whose bytes do not read as its type', REFUSED,
            {'any': {'type_url': ANY_URL + 'google.protobuf.Duration', 'value': b'\xff'}}),
    writing('an Any of bytes and no type', REFUSED, {'any': {'value': b'\x08\x01'}}),
    writing('a FieldMask in lowerCamelCase', FORM_7, {'mask': {'paths': ['foo_bar', 'a.b_c', 'f_o_o']}}),
    writing('an empty FieldMask', FORM_7, {'mask': {}}),
    writing('a FieldMask path that ends in an underscore', REFUSED, {'mask': {'paths': ['foo_']}}),
    writing('a FieldMask path kept in camel case', REFUSED, {'mask': {'paths': ['fooBar']}}),
    writing('a FieldMask path of an underscore before a digit', REFUSED, {'mask': {'paths': ['foo_3_bar']}}),
    writing('a FieldMask path of two underscores', REFUSED, {'mask': {'paths': ['foo__bar']}}),
    writing('a Value whose number is NaN', REFUSED, {'value': {'number_value': math.nan}}),
    writing("a Struct's member of Infinity", REFUSED, {'extra': {'fields': [('a', {'number_value': math.inf})]}}),
    writing('a Value of no kind', REFUSED, {'value': {}}, parts='it writes a Value of no kind as null'),
    writing('a Timestamp of microseconds', FORM_7, {'at': {'seconds': 0, 'nanos': 1000}}),
    writing('a Timestamp of ten nanoseconds', FORM_7, {'at': {'seconds': 0, 'nanos': 10}}),
    writing('a Timestamp at the epoch', FORM_7, {'at': {}}),
    writing('a Timestamp at its latest', FORM_7, {'at': {'seconds': LATEST, 'nanos': 999_999_999}}),
    writing('a Timestamp at its earliest', FORM_7, {'at': {'seconds': EARLIEST}}),
    writing('a Timestamp half a second before the epoch', FORM_7, {'at': {'seconds': -1, 'nanos': 500_000_000}}),
    writing('a Timestamp past its latest', REFUSED, {'at': {'seconds': LATEST + 1}}),
    writing('a Timestamp of negative nanoseconds', REFUSED, {'at': {'seconds': 5000, 'nanos': -1}}),
    writing('a Duration of 1.01 seconds', FORM_7, {'took': {'seconds': 1, 'nanos': 10_000_000}}),
    writing('a Duration of -1 nanosecond', FORM_7, {'took': {'nanos': -1}}),
    writing('a Duration of -1.5 seconds', FORM_7, {'took': {'seconds': -1, 'nanos': -500_000_000}}),
    writing('a Duration of -1.000000001 seconds', FORM_7, {'took': {'seconds': -1, 'nanos': -1}}),
    writing('a Duration whose signs part', REFUSED, {'took': {'seconds': 1, 'nanos': -1}}),
    writing('a Duration past its longest', REFUSED, {'took': {'seconds': LONGEST + 1}}),
    writing('a Duration of nanoseconds past a second', REFUSED, {'took': {'nanos': 1_000_000_000}}),
    writing('64-bit integers as strings', FORM_6, {'wrapped_uint64': {'value': 2 ** 64 - 1}, 'an_int64': -5}),
    writing('an sint32, an sfixed32 and a fixed32 as numbers, an sfixed64 as a string', ['5.6', '5.6.1', '5.6.6'],
            {'an_sint32': -2 ** 31, 'an_sfixed32': -5, 'a_fixed32': 2 ** 32 - 1, 'an_sfixed64': -2 ** 63}),
    writing('an sfixed64 at its largest, as a string', FORM_6, {'an_sfixed64': 2 ** 63 - 1}),
    writing('bytes in standard base64, padded', FORM_6, {'some_bytes': b'\xfb'}),
    writing("a string's escapes", ['5.6', '5.6.1'],
            {'a_string': chr(0x2028) + '<>&' + chr(0x7F) + chr(0x1F) + chr(9) + '"' + B + chr(0x1F600)}, message=EVERYTHING),
    writing("a oneof's member at its default", ['5.6', '5.6.3'], {'choice_text': ''}, message=EVERYTHING),
    writing('a field of its own presence at its default', ['5.6', '5.6.3'], {'maybe': 0}, message=EVERYTHING),
    writing('a message set and empty', ['5.6', '5.6.3'], {'inner': {}}, message=EVERYTHING),
    writing('a wrapper at its default', ['5.6', '5.6.3', '5.6.7'], {'wrapped_int64': {}}, message=EVERYTHING),
    writing('a repeated field and a map that hold nothing', ['5.6', '5.6.3'], {'ints': [], 'labels': []}),
    writing('a message nested 70 deep, past the 64 of a json payload', ['5.6', '5.7'], child(70, {})),
    writing('a ListValue of lists', FORM_7, {'value': {'list_value': {'values': [
        {'list_value': {}}, {'list_value': {'values': [{'number_value': 1.0}]}}]}}}),
    writing('an Empty', FORM_7, {'nothing': {}}),
]

# ── The entries: bindings ───────────────────────────────────────────────────────────────────────


def rule_entry(rule):
    return {'method': rule.method.upper(), 'template': rule.template, **({'body': rule.body} if rule.body else {})}


def binding(name, clauses, procedure, rule, target, body=None):
    """A request bound by section 4 from its route, its target and its body: its payload, or the
    reason it is refused for."""
    entry = {'name': name, 'clauses': clauses, 'procedure': procedure.name, 'route': rule_entry(rule), 'target': target}

    if body is not None:
        entry['body'] = body

    try:
        entry['payload'] = hexadecimal(encode(TYPES[procedure.request],
                                              bind(procedure, rule, target, body.encode('utf-8') if body is not None else b'')))
    except Refused as refusal:
        entry['refused'] = refusal.reason

        # * where the request carried it (7.4): a parameter or a pointer; none for its text or its query whole
        if refusal.place is not None:
            entry[refusal.place[0]] = refusal.place[1]

    return entry


GET_BOOK_PROCEDURE, LIST_BOOKS_PROCEDURE = BY_PROCEDURE['getBook'], BY_PROCEDURE['listBooks']
UPDATE, ARCHIVE, JUDGE, ECHO = BY_PROCEDURE['updateBook'], BY_PROCEDURE['archiveBook'], BY_PROCEDURE['judge'], BY_PROCEDURE['echo']
BOOK_RULE, BOOK_BINDING = GET_BOOK_PROCEDURE.rules
GET_OPERATION_PROCEDURE = BY_PROCEDURE['getOperation']
OPERATION_GET = default_routes(GET_OPERATION_PROCEDURE)[1]
ECHO_POST = default_routes(ECHO)[0]
EVERY = Rule('get', '/v1/every')
QUERY = ['4.1', '4.3']

BINDINGS = [
    binding('a variable of several segments', ['4.1', '4.2', '4.2.1', '3.8'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2'),
    binding('the query beside a variable', ['4.1', '4.2', '4.2.1', '4.3', '4.3.1'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?revision=3&tags=a&tags=b&sub.name=x&sub.count=2'),
    binding('a single-segment variable decoded whole', ['4.2', '4.2.1', '3.8'], GET_BOOK_PROCEDURE, BOOK_BINDING,
            '/v1/books/a%2Fb'),
    binding('a variable whose bytes are not UTF-8', ['3.8', '4.2', '7.4'], GET_BOOK_PROCEDURE, BOOK_BINDING,
            '/v1/books/%FF'),
    binding('variables of bytes, a bool, an enum by its name, a 64-bit integer and a field within a field',
            ['4.2', '4.2.2', '4.2.3', '4.2.4', '4.2.5'], ECHO,
            Rule('get', '/v1/every/{some_bytes}/{a_bool}/{color}/{an_int64}/{inner.count}'),
            '/v1/every/AQI%3D/true/COLOR_RED/-5/1e1'),
    binding('a variable of an enum by its number', ['4.2', '4.2.4'], ECHO, Rule('get', '/v1/every/{color}'),
            '/v1/every/2'),
    binding('a variable of a bool that is neither word', ['4.2', '4.2.3'], ECHO, Rule('get', '/v1/every/{a_bool}'),
            '/v1/every/yes'),
    binding('a parameter by its proto name', QUERY, LIST_BOOKS_PROCEDURE, LIST_BOOKS_PROCEDURE.rules[0],
            '/v1/shelves/s/books?page_size=5'),
    binding('a parameter by its JSON name', QUERY, LIST_BOOKS_PROCEDURE, LIST_BOOKS_PROCEDURE.rules[0],
            '/v1/shelves/s/books?pageSize=5'),
    binding('a field by its two names', QUERY + ['4.3.3'], LIST_BOOKS_PROCEDURE, LIST_BOOKS_PROCEDURE.rules[0],
            '/v1/shelves/s/books?pageSize=5&page_size=6'),
    binding('a field named twice', QUERY + ['4.3.3'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?revision=1&revision=2'),
    binding('a field within a field named twice', QUERY + ['4.3.3'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?sub.count=1&sub.count=2'),
    binding('a repeated field repeats', QUERY + ['4.3.1'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?tags=a&tags=b&tags=c'),
    binding('a parameter no field path names', QUERY + ['4.3.3'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?nope=1'),
    binding('a parameter of a message', QUERY + ['4.3.3'], GET_BOOK_PROCEDURE, BOOK_RULE, '/v1/shelves/1/books/2?sub=x'),
    binding('a parameter through a repeated field', QUERY + ['4.3.3'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?inners.name=x'),
    binding('a parameter of a map', QUERY + ['4.3.3'], GET_BOOK_PROCEDURE, BOOK_RULE, '/v1/shelves/1/books/2?labels=x'),
    binding('a parameter of the field a variable binds', QUERY + ['4.3.3'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?name=x'),
    binding('an int32 parameter of an exponent', QUERY + ['4.2.2', '5.3.1'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?sub.count=1e2'),
    binding('an int64 parameter of an exponent', QUERY + ['4.2.2', '5.3.2'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?revision=1e3'),
    binding('an enum parameter by its name', QUERY + ['4.2.4'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?color=COLOR_RED'),
    binding('an enum parameter by its number', QUERY + ['4.2.4'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?color=2'),
    binding('a bool parameter of true', QUERY + ['4.2.3'], GET_BOOK_PROCEDURE, BOOK_RULE, '/v1/shelves/1/books/2?flag=true'),
    binding('a bool parameter of 1', QUERY + ['4.2.3'], GET_BOOK_PROCEDURE, BOOK_RULE, '/v1/shelves/1/books/2?flag=1'),
    binding('a Timestamp parameter', QUERY + ['4.3.2'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?at=2026-10-21T12:00:00Z'),
    binding('wrappers and a Duration in the query', QUERY + ['4.3.2'], ECHO, EVERY,
            '/v1/every?wrappedInt64=7&wrappedBool=true&took=1.5s&wrappedString=x'),
    binding('a Value parameter', QUERY + ['4.3.3'], ECHO, EVERY, '/v1/every?anyValue=x'),
    binding("a query's empty sequences skipped, a name of no = an empty value, a value that holds = past its first",
            QUERY + ['4.3.1'], GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?&flag=false&&tags&tags=%F0%9F%98%80&sub.name=a=b&'),
    binding('a plus in the query is a space', QUERY, GET_BOOK_PROCEDURE, BOOK_RULE, '/v1/shelves/1/books/2?tags=a+b'),
    binding('an encoded plus is a plus', QUERY, GET_BOOK_PROCEDURE, BOOK_RULE, '/v1/shelves/1/books/2?tags=a%2Bb'),
    binding('a parameter of no value', QUERY, GET_BOOK_PROCEDURE, BOOK_RULE, '/v1/shelves/1/books/2?tags='),
    binding('a % that no digits follow stays', QUERY, GET_BOOK_PROCEDURE, BOOK_RULE, '/v1/shelves/1/books/2?tags=100%'),
    binding('a parameter whose bytes are not UTF-8', QUERY, GET_BOOK_PROCEDURE, BOOK_RULE,
            '/v1/shelves/1/books/2?tags=%FF'),
    binding("a default GET's query of every field", ['3.3', '4.3', '4.3.1'], GET_OPERATION_PROCEDURE, OPERATION_GET,
            '/api/Transcoding/getOperation?name=operations/a'),
    binding("a default POST's body, its request whole", ['3.3', '4.4'], ECHO, ECHO_POST, '/api/Transcoding/echo',
            '{"anInt32":1}'),
    binding('a query beside a body of the whole request', ['4.3'], ECHO, ECHO_POST, '/api/Transcoding/echo?anInt32=1',
            '{}'),
    binding('an empty body', ['4.4', '5.2.1'], ECHO, ECHO_POST, '/api/Transcoding/echo', ''),
    binding('a variable beside a body of the whole request', ['4.1', '4.4'], ARCHIVE, ARCHIVE.rules[0],
            '/v1/shelves/1/books/2:archive', '{"revision":"4"}'),
    binding('a field a variable and the body set', ['4.1', '4.4'], ARCHIVE, ARCHIVE.rules[0],
            '/v1/shelves/1/books/2:archive', '{"name":"x"}'),
    binding('a variable of a field its rules judge', ['4.2', '4.2.1', '4.4'], JUDGE, JUDGE.rules[0], '/v1/ruled/abc',
            '{"from":3}'),
    binding("a PATCH's update_mask, the keys its body holds", ['4.4', '4.5'], UPDATE, UPDATE.rules[0],
            '/v1/shelves/1/books/2', '{"title":"New","pages":"3"}'),
    binding("a PATCH's update_mask, into a message", ['4.5'], UPDATE, UPDATE.rules[0], '/v1/shelves/1/books/2',
            '{"author":{"name":"a","count":1},"title":"t"}'),
    binding("a PATCH's update_mask, an empty message by its own path", ['4.5'], UPDATE, UPDATE.rules[0],
            '/v1/shelves/1/books/2', '{"author":{}}'),
    binding("a PATCH's update_mask, a null by its own path", ['4.5'], UPDATE, UPDATE.rules[0], '/v1/shelves/1/books/2',
            '{"title":null}'),
    binding("a PATCH's update_mask, by its proto name", ['4.5'], UPDATE, UPDATE.rules[0], '/v1/shelves/1/books/2',
            '{"title":"x","author":{"count":2}}'),
    binding("a PATCH's update_mask the query gives", ['4.3', '4.5'], UPDATE, UPDATE.rules[0],
            '/v1/shelves/1/books/2?updateMask=title', '{"title":"x","pages":"1"}'),
    binding("a PATCH's body that sets the field its variable binds", ['4.1', '4.5'], UPDATE, UPDATE.rules[0],
            '/v1/shelves/1/books/2', '{"name":"other"}'),
    binding("a PATCH's empty body", ['4.5'], UPDATE, UPDATE.rules[0], '/v1/shelves/1/books/2', '{}'),
    binding("a body null under a field, which sets nothing beside its variable, its update_mask of no path",
            ['4.4', '4.5', '5.2.2'], UPDATE, UPDATE.rules[0], '/v1/shelves/1/books/2', 'null'),
    binding("a member null for the field a variable binds, which sets nothing", ['4.1', '4.4', '5.2.2'], ARCHIVE,
            ARCHIVE.rules[0], '/v1/shelves/1/books/2:archive', '{"name":null}'),
    binding("a body that is no object under a body of the request whole, at its root", ['4.4', '7.4', '7.4.2'],
            ARCHIVE, ARCHIVE.rules[0], '/v1/shelves/1/books/2:archive', '[]'),
    binding("a refusal in a body that names a field, its pointer from that field", ['4.4', '7.4', '7.4.2'], UPDATE,
            UPDATE.rules[0], '/v1/shelves/1/books/2', '{"pages":"x"}'),
    binding("a body under a field that is no object, beside a variable within that field", ['4.1', '4.4', '7.4'],
            UPDATE, UPDATE.rules[0], '/v1/shelves/1/books/2', '1'),
    binding("a member of a body under a field that names no field, its pointer from that field",
            ['4.4', '5.2.2', '7.4', '7.4.2'], UPDATE, UPDATE.rules[0], '/v1/shelves/1/books/2', '{"title":"t","nope":1}'),
    binding("a refusal of a member of the request whole, its pointer by JSON names", ['4.4', '7.4', '7.4.2'], ARCHIVE,
            ARCHIVE.rules[0], '/v1/shelves/1/books/2:archive', '{"sub":{"count":"x"}}'),
    binding("a refusal of a parameter within a message, its parameter by JSON names", ['4.3', '7.4', '7.4.1'],
            GET_BOOK_PROCEDURE, BOOK_RULE, '/v1/shelves/1/books/2?sub.count=x'),
    binding("a key the body holds no field of past 64 bytes, its pointer the value that holds it", ['5.2.2', '7.4', '7.4.2'], ECHO, ECHO_POST,
            '/api/Transcoding/echo', '{"' + 'k' * 63 + chr(0xE9) + chr(0xE9) + '":1}'),
]


# ── upb, protobuf's own Python library, beside the mapping ──────────────────────────────────────

SCALAR_TYPES = {
    'double': descriptor_pb2.FieldDescriptorProto.TYPE_DOUBLE, 'float': descriptor_pb2.FieldDescriptorProto.TYPE_FLOAT,
    'int64': descriptor_pb2.FieldDescriptorProto.TYPE_INT64, 'uint64': descriptor_pb2.FieldDescriptorProto.TYPE_UINT64,
    'int32': descriptor_pb2.FieldDescriptorProto.TYPE_INT32, 'fixed64': descriptor_pb2.FieldDescriptorProto.TYPE_FIXED64,
    'fixed32': descriptor_pb2.FieldDescriptorProto.TYPE_FIXED32, 'bool': descriptor_pb2.FieldDescriptorProto.TYPE_BOOL,
    'string': descriptor_pb2.FieldDescriptorProto.TYPE_STRING, 'bytes': descriptor_pb2.FieldDescriptorProto.TYPE_BYTES,
    'uint32': descriptor_pb2.FieldDescriptorProto.TYPE_UINT32, 'sfixed32': descriptor_pb2.FieldDescriptorProto.TYPE_SFIXED32,
    'sfixed64': descriptor_pb2.FieldDescriptorProto.TYPE_SFIXED64, 'sint32': descriptor_pb2.FieldDescriptorProto.TYPE_SINT32,
    'sint64': descriptor_pb2.FieldDescriptorProto.TYPE_SINT64,
}


def typed(proto, kind):
    if kind in SCALAR_TYPES:
        proto.type = SCALAR_TYPES[kind]
    elif kind.startswith('enum:'):
        proto.type, proto.type_name = descriptor_pb2.FieldDescriptorProto.TYPE_ENUM, '.' + kind.split(':', 1)[1]
    else:
        proto.type, proto.type_name = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE, '.' + kind.split(':', 1)[1]


def file_descriptor():
    """transcoding.proto's descriptor, as protoc would give it, its options aside."""
    proto = descriptor_pb2.FileDescriptorProto(name='bead/transcoding/v1/transcoding.proto', package=PACKAGE,
                                               syntax='proto3')
    proto.dependency.extend(f'google/protobuf/{name}.proto' for name in ('any', 'duration', 'empty', 'field_mask',
                                                                          'struct', 'timestamp', 'wrappers'))

    for name, each in TYPES.items():
        if not name.startswith(PACKAGE + '.'):
            continue

        if isinstance(each, Enum):
            declared = proto.enum_type.add(name=each.name)
            declared.options.allow_alias = each.alias
            declared.value.extend(descriptor_pb2.EnumValueDescriptorProto(name=value, number=number)
                                  for value, number in each.values)
            continue

        declared = proto.message_type.add(name=each.name)
        oneofs = list(each.oneofs)

        for oneof in oneofs:
            declared.oneof_decl.add(name=oneof)

        for field in each.fields:
            added = declared.field.add(name=field.name, number=field.number, json_name=field.json_name)
            added.label = (descriptor_pb2.FieldDescriptorProto.LABEL_REPEATED if field.label
                           else descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL)

            if field.label == 'map':
                entry = declared.nested_type.add(name=json_name_of('_' + field.name) + 'Entry')
                entry.options.map_entry = True
                key = entry.field.add(name='key', number=1, json_name='key',
                                      label=descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL)
                typed(key, field.key)
                value = entry.field.add(name='value', number=2, json_name='value',
                                        label=descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL)
                typed(value, field.kind)
                added.type = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
                added.type_name = f'.{each.full_name}.{entry.name}'
            else:
                typed(added, field.kind)

            if field.oneof is not None:
                added.oneof_index = oneofs.index(field.oneof)

        for field in each.fields:
            if field.optional:
                declared.oneof_decl.add(name='_' + field.name)
                found = next(added for added in declared.field if added.name == field.name)
                found.proto3_optional, found.oneof_index = True, len(declared.oneof_decl) - 1

    return proto


POOL = descriptor_pool.Default()
POOL.AddSerializedFile(file_descriptor().SerializeToString())


def upb_class(name):
    return message_factory.GetMessageClass(POOL.FindMessageTypeByName(name))


def same(one, other):
    return one.SerializeToString(deterministic=True) == other.SerializeToString(deterministic=True)


def upb_parts_reading(entry):
    """Whether upb reads a body otherwise than this file: takes what it refuses, refuses what it takes,
    or reads another message."""
    kind = upb_class(entry['message'])
    data = entry['body'].encode('utf-8') if 'body' in entry else bytes.fromhex(entry['bodyBytes'].replace(' ', ''))

    try:
        read = json_format.Parse(data, kind(), descriptor_pool=POOL)
    except Exception:
        return 'payload' in entry

    if 'payload' not in entry:
        return True

    return not same(read, kind.FromString(bytes.fromhex(entry['payload'].replace(' ', ''))))


def upb_parts_writing(entry):
    """Whether upb parts from a body this file writes: refuses what it writes, writes what it refuses,
    or reads the body back as another message than the payload's."""
    kind = upb_class(entry['message'])

    try:
        message_of = kind.FromString(bytes.fromhex(entry['payload'].replace(' ', '')))
    except Exception:
        return 'body' in entry

    try:
        json_format.MessageToJson(message_of, descriptor_pool=POOL)
        writes = True
    except Exception:
        writes = False

    if 'body' not in entry:
        return writes

    if not writes:
        return True

    try:
        return not same(json_format.Parse(entry['body'], kind(), descriptor_pool=POOL), message_of)
    except Exception:
        return True


def cross_check():
    """Every parting of upb's from this file is one an entry names, and every one an entry names, one."""
    found = []

    for group, entries, parts, table in (('readings', READINGS, upb_parts_reading, UPB_READS),
                                         ('writings', WRITINGS, upb_parts_writing, UPB_WRITES)):
        for entry in entries:
            parted = parts(entry)

            if parted and entry['name'] not in table:
                found.append(f'{group}: {entry["name"]!r}: upb parts from it, and it names no row it parts by')
            elif not parted and entry['name'] in table:
                found.append(f'{group}: {entry["name"]!r}: names {table[entry["name"]]}, and upb does not part from it')

    if found:
        raise SystemExit('\n'.join(found))


# ── The entries: failures ───────────────────────────────────────────────────────────────────────


# the rows of 7.1's table, by the member each states
MEMBER_ROWS = {member: f'7.1.{number}' for number, member in
               enumerate(('type', 'title', 'status', 'detail', 'code', 'scope', 'errors', 'more', 'stopped',
                          'parameter', 'pointer'), 1)}


def member_rows(text):
    return [MEMBER_ROWS[member] for member in json.loads(text)]


def failure(name, clauses, given, *, procedure=None, rule=None, problem_types=PROBLEM_TYPES):
    """A failure as a gateway answers it (section 7): its status, the fields beside it and its problem."""
    row, status, fields, text = failure_problem(given, procedure=procedure, rule=rule, problem_types=problem_types)
    units = list(dict.fromkeys([*clauses, '7.1', *member_rows(text), '7.2', '7.3', '7.6', f'7.6.{row}']))
    entry = {'name': name, 'clauses': units, 'failure': given}

    if procedure is not None:
        entry['procedure'], entry['route'] = procedure.name, rule_entry(rule)

    if problem_types != PROBLEM_TYPES:
        entry['problemTypes'] = problem_types

    return {**entry, 'status': status, 'fields': fields, 'problem': text}


def own(name, clauses, which, detail):
    """A failure of the gateway's own (7.6's last rows): about:blank, its status's phrase."""
    row, status = OWN_ROWS[which]
    fields = {'www-authenticate': 'Bearer error="invalid_request"'} if which == 'scheme' else {}
    text = problem(status, detail=detail)
    return {'name': name, 'clauses': [*clauses, '7.1', *member_rows(text), '7.2', '7.3', '7.6', f'7.6.{row}'],
            'failure': {'own': which, 'detail': detail}, 'status': status, 'fields': fields, 'problem': text}


def violations(*lines):
    return '\n'.join(canonical(line) for line in lines)


FROM_LINE = {'bounds': {'lte': 10}, 'fieldPath': 'from', 'message': 'must be less than or equal to 10', 'ruleId': 'int32.lte'}
TITLE_LINE = {'bounds': {'max_len': '3'}, 'fieldPath': 'title', 'ruleId': 'string.max_len'}
INVALID = ['5.1', '7.4']

FAILURES = [
    failure('a malformed envelope its server refused', [], {'code': 1, 'arose': 'server', 'detail': 'a header too short'}),
    failure('a layout its server does not read', ['7.5', '7.5.4'], {'code': 2, 'arose': 'server'}),
    failure('a kind its server does not read', [], {'code': 3, 'arose': 'server'}),
    failure('a payload past its server\'s limit', ['7.5', '7.5.1'], {'code': 34, 'arose': 'server'}),
    failure('an envelope past its client\'s limit before it went', ['7.5', '7.5.1'], {'code': 4, 'arose': 'client'}),
    failure('a result past its client\'s limit', ['7.5', '7.5.2'], {'code': 34, 'arose': 'answer'}),
    failure('a call its client does not know of', ['7.5', '7.5.4'], {'code': 20, 'arose': 'answer'}),
    failure('a subscription its server takes none of', [], {'code': 22, 'arose': 'server'}),
    failure('its server unreachable', ['7.5', '7.5.4'], {'code': 17, 'arose': 'client', 'detail': 'the connection is gone'}),
    failure('a service its server does not offer', [], {'code': 18, 'arose': 'server'}),
    failure('a procedure its server does not offer', [], {'code': 19, 'arose': 'server'}),
    failure('a session required where no credential came', [], {'code': 32, 'arose': 'server', 'detail': 'no credential came'}),
    failure('a session required where a credential came', [],
            {'code': 32, 'arose': 'server', 'credential': True, 'detail': 'the credential does not hold'}),
    failure('a session required under a challenge of parameters', [],
            {'code': 32, 'arose': 'server', 'credential': True, 'challenge': 'Bearer realm="bead"'}),
    failure('an access denied', [], {'code': 33, 'arose': 'server'}),
    failure('its server at its capacity', ['7.5', '7.5.1'], {'code': 35, 'arose': 'server'}),
    failure('its client at its capacity before the call went', ['7.5', '7.5.1'], {'code': 35, 'arose': 'client'}),
    failure("a scheme the gateway presents that its server takes none of", ['7.5', '7.5.3'],
            {'code': 36, 'arose': 'server', 'detail': 'OPAQUE, JWT'}),
    failure("a body the gateway's reading refuses, its pointer", ['7.4', '7.5', '7.5.1'],
            {'code': 50, 'arose': 'gateway', 'detail': 'a key no field names', 'pointer': '#/nope'}),
    failure("a query the gateway's reading refuses, its parameter", ['7.4', '7.5', '7.5.1'],
            {'code': 50, 'arose': 'gateway', 'detail': 'an int64 string off -?(0|[1-9][0-9]*)',
             'parameter': 'revision'}),
    failure("a text the gateway's reading refuses, placed nowhere", ['7.4', '7.5', '7.5.1'],
            {'code': 50, 'arose': 'gateway', 'detail': 'not JSON'}),
    failure("a json request its server's codec refuses", ['7.5', '7.5.1'],
            {'code': 50, 'arose': 'server', 'encoding': 'json'}),
    failure("a proto request its server does not read", ['7.5', '7.5.4'], {'code': 50, 'arose': 'server', 'encoding': 'proto'}),
    failure("a result the gateway's client does not read", ['7.5', '7.5.2'], {'code': 50, 'arose': 'answer'}),
    failure('a transfer that stalled', [], {'code': 51, 'arose': 'client'}),
    failure("a payload its server's rules refuse, a pointer and a parameter", INVALID,
            {'code': 52, 'arose': 'server', 'detail': violations(FROM_LINE, TITLE_LINE, {'more': 0})},
            procedure=JUDGE, rule=JUDGE.rules[0]),
    failure("a violation's pointer by JSON names, its keys and indices escaped", INVALID + ['7.4.2'],
            {'code': 52, 'arose': 'server', 'detail': violations(
                {'fieldPath': 'labels["a/b~c d"]', 'forKey': True, 'ruleId': 'string.min_len', 'message': 'short'},
                {'fieldPath': 'inners[1].name', 'ruleId': 'string.min_len', 'message': 'short'},
                {'fieldPath': 'by_id[-1]', 'ruleId': 'string.min_len', 'message': 'short'},
                {'fieldPath': 'flags[true]', 'ruleId': 'string.min_len', 'message': 'short'},
                {'fieldPath': 'labels["' + 'k' * 64 + '"...]', 'ruleId': 'int32.gt', 'message': 'cut'},
                {'fieldPath': 'choice', 'ruleId': 'required', 'message': 'exactly one field is required in oneof'},
                {'ruleId': 'message.oneof', 'message': 'one of a or b'},
                {'fieldPath': 'some_bytes', 'ruleId': 'bytes.min_len', 'message': 'é'})},
            procedure=ECHO, rule=ECHO_POST),
    failure("a violation in a body that names a field, and of the field its variable binds", INVALID + ['7.4.1', '7.4.2'],
            {'code': 52, 'arose': 'server', 'detail': violations(
                {'fieldPath': 'book.title', 'ruleId': 'string.min_len', 'message': 'short'},
                {'fieldPath': 'book.name', 'ruleId': 'string.pattern', 'message': 'no name'},
                {'fieldPath': 'update_mask', 'ruleId': 'required', 'message': 'value is required'})},
            procedure=UPDATE, rule=UPDATE.rules[0]),
    failure("a violation of a field the query binds", INVALID + ['7.4.1'],
            {'code': 52, 'arose': 'server', 'detail': violations(
                {'fieldPath': 'sub.count', 'ruleId': 'int32.gt', 'message': 'too few'},
                {'fieldPath': 'tags[1]', 'ruleId': 'string.min_len', 'message': 'short'})},
            procedure=GET_BOOK_PROCEDURE, rule=BOOK_RULE),
    failure("a violation of the field a variable binds, under a body of the request whole", INVALID + ['7.4.1'],
            {'code': 52, 'arose': 'server', 'detail': violations(
                {'fieldPath': 'name', 'ruleId': 'string.min_len', 'message': 'short'},
                {'fieldPath': 'revision', 'ruleId': 'int64.gt', 'message': 'too low'})},
            procedure=ARCHIVE, rule=ARCHIVE.rules[0]),
    failure("a rule of the message itself where the body is not the request whole", INVALID + ['7.4.3'],
            {'code': 52, 'arose': 'server', 'detail': violations(
                {'ruleId': 'message.oneof', 'message': 'one of a or b'})},
            procedure=UPDATE, rule=UPDATE.rules[0]),
    failure("a violation of a field the request does not hold, placed nowhere", INVALID + ['7.4.3'],
            {'code': 52, 'arose': 'server', 'detail': violations(
                {'fieldPath': 'a_string.inner', 'ruleId': 'string.min_len', 'message': 'short'})},
            procedure=UPDATE, rule=UPDATE.rules[0]),
    failure("a detail that left violations out", INVALID,
            {'code': 52, 'arose': 'server', 'detail': violations(FROM_LINE, {'more': 3})}, procedure=JUDGE, rule=JUDGE.rules[0]),
    failure("a detail that stopped at its first", INVALID,
            {'code': 52, 'arose': 'client', 'detail': violations(FROM_LINE, {'stopped': True})},
            procedure=JUDGE, rule=JUDGE.rules[0]),
    failure('a procedure that failed', [], {'code': 64, 'arose': 'server'}),
    failure('a destination lost', [], {'code': 65, 'arose': 'client'}),
    failure('a protocol code no name names', [], {'code': 99, 'arose': 'server', 'detail': 'later'}),
    failure("an application failure of its service's catalogue", [],
            {'code': 1, 'scope': 'application', 'arose': 'server', 'detail': 'no'}),
    failure('an application failure whose definitions give no problem types', [],
            {'code': 1, 'scope': 'application', 'arose': 'server'}, problem_types=None),
    failure("an application failure its catalogue names none of", [], {'code': 7, 'scope': 'application', 'arose': 'server'}),
    own("the gateway's call timeout", ['9.2'], 'timeout', 'no answer within 5000 ms'),
    own("the exchange's connection closed before its answer", [], 'closed', 'the connection closed'),
    own('a result Bead\'s proto JSON form holds none of', ['5.7'], 'unwritable', 'a Value whose number is not finite'),
    own('a JWT its block cannot hold', ['2.4', '2.4.2'], 'jwt', 'a token past 1004 bytes'),
    own('an authorization of another scheme under bearer-jwt', ['2.4', '2.4.2'], 'scheme', 'an auth-scheme but Bearer'),
    own('what no gate foresaw, with no detail', [], 'failed', ''),
]

# ── The entries: events ─────────────────────────────────────────────────────────────────────────


def code_problem(code, arose='server', **given):
    _, status, _, text = failure_problem({'code': code, 'arose': arose, **given})
    return {'status': status, 'problem': text}


COUNTED = {'status': 400, 'problem': failure_problem({'code': 2, 'scope': 'application', 'arose': 'server'})[3]}


def events(name, clauses, steps):
    """A stream's call as a gateway writes it (section 8): what it sends, in order, and its response."""
    status, body, kind = stream_of(steps)
    return {'name': name, 'clauses': clauses, 'steps': steps, 'status': status, 'contentType': kind, 'body': body}


def tick(remaining):
    return write_message(TICK, {'remaining': remaining})


EVENTS = [
    events('the result, then each notification as a message, then the failure that ends them',
           ['8.2', '8.3', '8.4', '8.5', '8.6'],
           [{'result': write_message(TICKS_RESPONSE, {'ticks': 2})}, {'notification': tick(1)}, {'notification': tick(0)},
            {'failure': COUNTED}]),
    events('a notification before its answer, held until its result', ['8.2', '8.3', '8.5'],
           [{'notification': tick(2)}, {'result': write_message(TICKS_RESPONSE, {'ticks': 3})}, {'notification': tick(1)}]),
    events('a failure before its answer, a problem, the notifications it held dropped', ['8.2', '7.1', '7.2'],
           [{'notification': tick(2)}, {'failure': code_problem(32)}]),
    events('a heartbeat while nothing else goes', ['8.5', '8.7'],
           [{'result': '{}'}, {'heartbeat': True}, {'notification': tick(0)}, {'heartbeat': True}]),
    events('a stream its queue ended', ['8.6'],
           [{'result': '{}'}, {'notification': tick(9)}, {'failure': code_problem(35)}]),
    events("a stream its exchange's connection ended", ['8.6'],
           [{'result': '{}'}, {'failure': {'status': 502, 'problem': problem(502, detail='the connection closed')}}]),
    events('a text result and notification, each a JSON string', ['8.4'],
           [{'result': {'text': 'r'}}, {'notification': {'text': 'h' + chr(0xE9) + chr(10) + chr(13) + chr(0x2028)}}]),
    events('a raw result and notification, each a JSON string of base64', ['8.4'],
           [{'result': {'raw': ''}}, {'notification': {'raw': '00 FF FE'}}]),
    events('a json notification, as it is', ['8.4'], [{'result': '{"a":[1,2]}'}, {'notification': '[{"b":null}]'}]),
    events('a stream still open', ['8.2', '8.3'], [{'result': '{}'}, {'notification': tick(4)}]),
]


# ── The entries: exchanges ──────────────────────────────────────────────────────────────────────

# what the document its builder wrote stands in for in a body the file expects
DOCUMENT = '{document}'
ORIGIN = 'https://app.example'
CALL_FIELDS = {'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'vary': 'Origin'}


def head(method, target, fields=(), *, body=b''):
    """A request's head as a test's socket sends it: its own exchange, closed once answered."""
    named = any(field.lower().startswith('host:') for field in fields)
    lines = [f'{method} {target} HTTP/1.1', *([] if named else ['host: {host}']), *fields]

    if body:
        lines.append(f'content-length: {len(body)}')

    return '\r\n'.join([*lines, 'connection: close', '', ''])


def send(method, target, fields=(), body=None, *, on='a'):
    data = body.encode('utf-8') if isinstance(body, str) else (body or b'')
    step = {'send': {'head': head(method, target, fields, body=data)}, 'on': on}

    if data:
        step['send']['body'] = hexadecimal(data)

    return step


def answered(text, *, content='application/json', status=200, fields=None, on='a'):
    """A call's answer: its status, the fields every call's response carries, and its body whole."""
    data = text.encode('utf-8') if isinstance(text, str) else text
    expected = {'status': status, 'fields': {**CALL_FIELDS, 'content-type': content, 'content-length': str(len(data)),
                                             'bead-refusal': None, **(fields or {})}}

    if isinstance(text, str):
        expected['body'] = text
    else:
        expected['bodyBytes'] = hexadecimal(data)

    return {'expect': expected, 'on': on}


# the rows of 7.7's table, by the refusal each words
REFUSAL_ROWS = {reason: f'7.7.{number}' for number, reason in enumerate(
    ('malformed', 'host-refused', 'origin-refused', 'path-unknown', 'method-refused', 'too-slow', 'too-large',
     'type-refused', 'busy'), 1)}


def refused_own(status, reason, words, *, fields=None, on='a'):
    """A refusal of the gateway's own (7.7): marked, its body a problem, about:blank, its detail the
    words 7.7's table gives it."""
    return {'expect': {'status': status, 'fields': {**CALL_FIELDS, 'content-type': 'application/problem+json',
                                                    'bead-refusal': reason, **(fields or {})},
                       'body': problem(status, detail=words)}, 'on': on}


def own_failed(status, words, *, fields=None, on='a'):
    """A failure of the gateway's own (7.6): unmarked, about:blank, its detail its words."""
    return {'expect': {'status': status, 'fields': {**CALL_FIELDS, 'content-type': 'application/problem+json',
                                                    'bead-refusal': None, **(fields or {})},
                       'body': problem(status, detail=words)}, 'on': on}


def call_failed(given, *, on='a', procedure=None, rule=None):
    _, status, fields, text = failure_problem(given, procedure=procedure, rule=rule)

    return {'expect': {'status': status, 'fields': {**CALL_FIELDS, 'content-type': 'application/problem+json',
                                                    'bead-refusal': None, **fields}, 'body': text}, 'on': on}


def exchange(name, clauses, steps, *, options=None, real_time=False):
    """An exchange, which cites the row of 7.7's table of each refusal it meets."""
    refusals = [REFUSAL_ROWS[step['expect']['fields']['bead-refusal']] for step in steps
                if step.get('expect', {}).get('fields', {}).get('bead-refusal')]
    entry = {'name': name, 'clauses': [*clauses, *(['7.7'] if refusals else []), *refusals]}

    if options:
        entry['options'] = options

    if real_time:
        entry['realTime'] = True

    return {**entry, 'steps': steps}


def json_post(path, body, fields=(), *, on='a'):
    return send('POST', path, ['content-type: application/json', *fields], body, on=on)


def result(message_name, value):
    return write_message(TYPES[f'{PACKAGE}.{message_name}'], value)


def read_write(each, text):
    return write_message(each, read_body(each, text.encode('utf-8')))


def stream_answer(steps, *, on='a'):
    status, body, kind = stream_of(steps)
    return {'expect': {'status': status, 'fields': {**CALL_FIELDS, 'content-type': kind, 'bead-refusal': None},
                       'body': body}, 'on': on}


def counted(start):
    """What ticks writes from a count: its result, a tick each, then COUNTED (the service's)."""
    return [{'result': result('TicksResponse', {'ticks': start})},
            *[{'notification': result('Tick', {'remaining': left})} for left in range(start - 1, -1, -1)],
            {'failure': COUNTED}]


EVENT_STREAM = 'accept: text/event-stream'
ORIGINLESS = 'a request from a page of another site that shows no origin'
METHOD_WORDS = 'a method no route of its path takes'
TYPE_WORDS = "this route's body is application/json, unencoded"
BOOK_2 = {'name': 'shelves/1/books/2', 'title': 'A tale', 'pages': 3}

EXCHANGES = [
    exchange('a default POST answers its result, 200, in Bead\'s proto JSON form', ['2.1', '2.2', '3.2', '5.1', '5.1.1',
                                                                                   '5.6', '6.1', '6.2', '10.1',
                                                                                   '10.1.11'],
             [json_post('/api/Transcoding/echo', '{"labels":{"b":2,"a":1},"anInt32":1}'),
              answered(read_write(EVERYTHING, '{"labels":{"b":2,"a":1},"anInt32":1}'))]),
    exchange('a result with no field set is {}, never 204', ['6.1'],
             [json_post('/api/Transcoding/echo', '{}'), answered('{}')]),
    exchange("a get rule binds its variable and its query", ['3.2', '3.4', '4.2', '4.3'],
             [send('GET', '/v1/shelves/1/books/2?revision=3'), answered(result('Book', BOOK_2))]),
    exchange('an additional binding is a route of its own', ['3.4'],
             [send('GET', '/v1/books/2'), answered(result('Book', {'name': '2', 'title': 'A tale'}))]),
    exchange('HEAD is answered as its GET, without its content', ['3.4'],
             [send('HEAD', '/v1/books/2'),
              {'expect': {'status': 200, 'fields': {**CALL_FIELDS, 'content-type': 'application/json',
                                                    'content-length': str(len(result('Book', {'name': '2', 'title': 'A tale'}))),
                                                    'bead-refusal': None},
                          'body': ''}, 'on': 'a'}]),
    exchange("a procedure marked NO_SIDE_EFFECTS answers GET at its default route", ['3.2'],
             [send('GET', '/api/Transcoding/getOperation?name=operations/x'),
              answered(result('Operation', {'name': 'operations/x', 'done': True}))]),
    exchange("a procedure marked NO_SIDE_EFFECTS whose request the query cannot carry answers no GET at its default route",
             ['3.2', '3.10'],
             [send('GET', '/api/Transcoding/getBook?name=x'),
              refused_own(405, 'method-refused', METHOD_WORDS, fields={'allow': 'POST'})]),
    exchange('a procedure not so marked answers no GET at its default route', ['3.2', '3.10', '10.1', '10.1.7'],
             [send('GET', '/api/Transcoding/echo'),
              refused_own(405, 'method-refused', METHOD_WORDS, fields={'allow': 'POST'})]),
    exchange("a response_body is its field's JSON", ['5.8'],
             [send('GET', '/v1/shelves/s/books'),
              answered('[' + ','.join(result('Book', {'name': f'shelves/s/books/{name}', 'title': name.upper()})
                                      for name in 'ab') + ']')]),
    exchange("a PATCH fills its update_mask with the keys its body holds", ['4.4', '4.5'],
             [send('PATCH', '/v1/shelves/1/books/2', ['content-type: application/json'], '{"title":"New"}'),
              answered(result('UpdateBookRequest', {'book': {'name': 'shelves/1/books/2', 'title': 'New'},
                                                    'update_mask': {'paths': ['title']}}))]),
    exchange("a rule's verb", ['3.7'],
             [json_post('/v1/shelves/1/books/2:archive', '{}'), answered('{}')]),
    exchange("google.longrunning's two templates, each path its route", ['3.5'],
             [send('GET', '/v1/operations', on='a'), answered(result('ListOperationsResponse', {
                 'operations': [{'name': 'operations/a'}]}), on='a'),
              send('GET', '/v1/operations/x/y', on='b'),
              answered(result('Operation', {'name': 'operations/x/y', 'done': True}), on='b')]),
    exchange('a request its rules refuse, 422, a pointer and a parameter', ['7.4', '7.4.1', '7.4.2', '7.6', '7.6.17'],
             [json_post('/v1/ruled/long', '{"from":11}'),
              call_failed({'code': 52, 'arose': 'server', 'detail': violations(
                  FROM_LINE, {**TITLE_LINE, 'message': 'must be at most 3 characters'}, {'more': 0})},
                  procedure=JUDGE, rule=JUDGE.rules[0])]),
    exchange('a body of another type, 415', ['5.1', '7.7', '10.1', '10.1.8'],
             [send('POST', '/api/Transcoding/echo', ['content-type: text/plain'], '{}'),
              refused_own(415, 'type-refused', TYPE_WORDS)]),
    exchange('a charset but utf-8, 415', ['5.1', '10.1.8'],
             [send('POST', '/api/Transcoding/echo', ['content-type: application/json; charset=latin1'], '{}'),
              refused_own(415, 'type-refused', TYPE_WORDS)]),
    exchange('a charset of utf-8 in any case is taken', ['5.1'],
             [send('POST', '/api/Transcoding/echo', ['content-type: Application/JSON; charset=UTF-8'], '{}'), answered('{}')]),
    exchange('a charset quoted, beside an identity content-encoding, is taken', ['5.1'],
             [send('POST', '/api/Transcoding/echo', ['content-type: application/json; charset="UTF-8"',
                                                     'content-encoding: identity'], '{}'), answered('{}')]),
    exchange('a content-type in two fields, 415', ['5.1', '10.1.8'],
             [send('POST', '/api/Transcoding/echo', ['content-type: application/json', 'content-type: application/json'],
                   '{}'),
              refused_own(415, 'type-refused', TYPE_WORDS)]),
    exchange('a body of no content-type, 415', ['5.1', '10.1.8'],
             [send('POST', '/api/Transcoding/echo', [], '{}'),
              refused_own(415, 'type-refused', TYPE_WORDS)]),
    exchange('no body and no content-type to a route that takes a body, 415', ['5.1', '10.1.8'],
             [send('POST', '/api/Transcoding/echo'),
              refused_own(415, 'type-refused', TYPE_WORDS)]),
    exchange('an encoded body, 415', ['5.1', '10.1.8'],
             [send('POST', '/api/Transcoding/echo', ['content-type: application/json', 'content-encoding: gzip'], '{}'),
              refused_own(415, 'type-refused', TYPE_WORDS)]),
    exchange('a body the mapping refuses, 400 PAYLOAD_UNDECODABLE, unmarked', ['5.2', '5.2.2', '7.6.12', '7.7'],
             [json_post('/api/Transcoding/echo', '{"nope":1}'),
              call_failed({'code': 50, 'arose': 'gateway', 'detail': 'a key no field names', 'pointer': '#/nope'})]),
    exchange('a query beside a body of the whole request', ['4.3', '7.4'],
             [json_post('/api/Transcoding/echo?anInt32=1', '{}'),
              call_failed({'code': 50, 'arose': 'gateway', 'detail': 'a query beside a body of the whole request'})]),
    exchange("a variable that does not decode, 400 PAYLOAD_UNDECODABLE, its parameter", ['3.8', '7.4', '7.6.12'],
             [send('GET', '/v1/books/%FF'),
              call_failed({'code': 50, 'arose': 'gateway', 'detail': 'a value whose bytes are not UTF-8',
                           'parameter': 'name'})]),
    exchange("a parameter that names no field, its name cut as spec 18.4 cuts a key", ['4.3', '4.3.3', '7.4'],
             [send('GET', '/v1/books/2?' + 'k' * 70 + '=1'),
              call_failed({'code': 50, 'arose': 'gateway', 'detail': 'a parameter no field path names',
                           'parameter': 'k' * 64 + '...'})]),
    exchange('a body to a route that takes none, 400 malformed', ['4.4', '10.1.8'],
             [send('GET', '/v1/books/2', ['content-type: application/json'], '{}'),
              refused_own(400, 'malformed', 'content to a route that takes none')]),
    exchange('a raw request and its result, as their bytes', ['5.1', '5.1.4', '6.1'],
             [send('POST', '/api/Transcoding/raw', ['content-type: application/octet-stream'], b'\x00\xff'),
              answered(b'\x00\xff', content='application/octet-stream')]),
    exchange("a raw route's query of empty sequences alone carries no parameter", ['4.3', '5.1'],
             [send('POST', '/api/Transcoding/raw?&', ['content-type: application/octet-stream'], b'\x00\xff'),
              answered(b'\x00\xff', content='application/octet-stream')]),
    exchange('a text request and its result, in UTF-8', ['5.1', '5.1.3', '6.1'],
             [send('POST', '/api/Transcoding/text', ['content-type: text/plain;charset=UTF-8'], 'h' + chr(0xE9)),
              answered('h' + chr(0xE9), content='text/plain;charset=utf-8')]),
    exchange("a json request read by its server, and its result in its canonical form", ['5.1', '5.1.2', '6.1'],
             [json_post('/api/Transcoding/json', '{"b":1,"a":[true]}'), answered('{"a":[true],"b":1}')]),
    exchange("an application failure, 400, under its problem types", ['7.3', '7.6', '7.6.21'],
             [json_post('/api/Transcoding/fail', '{"detail":"no"}'),
              call_failed({'code': 1, 'scope': 'application', 'arose': 'server', 'detail': 'no'})]),
    exchange("a procedure that needs a session, no credential: 401 and its challenge", ['2.5', '7.6.8'],
             [json_post('/api/Transcoding/whoAmI', '{}'), call_failed({'code': 32, 'arose': 'server'})]),
    exchange("ELSEWHERE presents the authorization field whole", ['2.4', '2.4.1'],
             [json_post('/api/Transcoding/whoAmI', '{}', ['authorization:   Bearer good  ']),
              answered(result('WhoAmIResponse', {'session': 'ada'}))]),
    exchange("a credential that does not hold: 401, invalid_token", ['2.4', '7.6.8'],
             [json_post('/api/Transcoding/whoAmI', '{}', ['authorization: Bearer bad']),
              call_failed({'code': 32, 'arose': 'server', 'credential': True, 'detail': 'the credential does not hold'})]),
    exchange("under bearer-jwt, a Bearer token is presented as a JWT, which a server without a verifier refuses",
             ['2.4', '2.4.2', '7.5.3', '7.6.11'],
             [json_post('/api/Transcoding/whoAmI', '{}', ['authorization: bearer a.b.c']),
              call_failed({'code': 36, 'arose': 'server', 'detail': 'OPAQUE, ELSEWHERE'})],
             options={'authorization': 'bearer-jwt'}),
    exchange("under bearer-jwt, another auth-scheme: 401, invalid_request", ['2.4.2', '7.6.26'],
             [json_post('/api/Transcoding/whoAmI', '{}', ['authorization: Basic YTpi']),
              {'expect': {'status': 401, 'fields': {**CALL_FIELDS, 'content-type': 'application/problem+json',
                                                    'bead-refusal': None,
                                                    'www-authenticate': 'Bearer error="invalid_request"'},
                          'body': problem(401, detail='an auth-scheme but Bearer')}, 'on': 'a'}],
             options={'authorization': 'bearer-jwt'}),
    exchange("two authorization fields, 400 malformed", ['2.4', '10.1.9'],
             [json_post('/api/Transcoding/whoAmI', '{}', ['authorization: Bearer good', 'authorization: Bearer good']),
              refused_own(400, 'malformed', 'two authorization fields')]),
    exchange("a command to an exchange's connection is answered SERVICE_UNKNOWN", ['2.6', 'spec:9.2.5'],
             [json_post('/api/Transcoding/ask', '{}'), answered(result('AskResponse', {'code': 18}))]),
    exchange("the gateway's call timeout, 504, its call cancelled", ['9.2', '7.6.22'],
             [json_post('/api/Transcoding/hang', '{}'),
              {'expect': {'status': 504, 'fields': {**CALL_FIELDS, 'content-type': 'application/problem+json',
                                                    'bead-refusal': None},
                          'body': problem(504, detail='no answer within 200 ms')},
               'on': 'a'},
              send('GET', '/api/Transcoding/cancels?atLeast=1', on='b'),
              answered(result('CancelsResponse', {'count': 1}), on='b')],
             options={'timeout': 200}, real_time=True),
    exchange("a request aborted cancels its call", ['9.1', '2.1'],
             [json_post('/api/Transcoding/hang', '{}'), {'until': {'hanging': 1}}, {'close': 'a'},
              send('GET', '/api/Transcoding/cancels?atLeast=1', on='b'),
              answered(result('CancelsResponse', {'count': 1}), on='b')], real_time=True),
    exchange("a stream: its result, each notification as a message, then the failure that ends it",
             ['8.1', '8.2', '8.3', '8.4', '8.5', '8.6', '8.8'],
             [json_post('/api/Transcoding/ticks', '{"from":2}', [EVENT_STREAM]), stream_answer(counted(2))]),
    exchange("a request whose accept names no event stream is a call", ['8.1'],
             [json_post('/api/Transcoding/ticks', '{"from":2}', ['accept: */*']),
              answered(result('TicksResponse', {'ticks': 2}))]),
    exchange("an event stream of a weight of 0 is no stream", ['8.1'],
             [json_post('/api/Transcoding/ticks', '{"from":2}', ['accept: text/event-stream;q=0, application/json']),
              answered(result('TicksResponse', {'ticks': 2}))]),
    exchange("an event stream weighed below application/json is no stream", ['8.1'],
             [json_post('/api/Transcoding/ticks', '{"from":2}', ['accept: text/event-stream;q=0.5, application/json']),
              answered(result('TicksResponse', {'ticks': 2}))]),
    exchange("an event stream's weight off the qvalue grammar is as none given, a stream", ['8.1'],
             [json_post('/api/Transcoding/ticks', '{"from":2}', ['accept: text/event-stream;q=x;level, application/json']),
              stream_answer(counted(2))]),
    exchange("an event stream's Q in any case, a weight it cannot read beside it left aside", ['8.1'],
             [json_post('/api/Transcoding/ticks', '{"from":2}',
                        ['accept: text/event-stream;Q=0.5;q=NaN, application/json;q=0.4']),
              stream_answer(counted(2))]),
    exchange("an event stream at q=1, past a weight of 1.5 left aside, weighs application/json's 1.000", ['8.1'],
             [json_post('/api/Transcoding/ticks', '{"from":2}',
                        ['accept: text/event-stream;q=1.5;q=1, application/json;q=1.000']),
              stream_answer(counted(2))]),
    exchange("application/json at a weight of 1x, as none given, outweighs an event stream at 0.5", ['8.1'],
             [json_post('/api/Transcoding/ticks', '{"from":2}', ['accept: text/event-stream;q=0.5, application/json;q=1x']),
              answered(result('TicksResponse', {'ticks': 2}))]),
    exchange("of two ranges of the event stream, the first stands", ['8.1'],
             [json_post('/api/Transcoding/ticks', '{"from":2}',
                        ['accept: text/event-stream;q=0, text/event-stream, application/json']),
              answered(result('TicksResponse', {'ticks': 2}))]),
    exchange("a stream's request that carries Last-Event-ID is answered 204, and no call", ['8.3', '10.1.9'],
             [json_post('/api/Transcoding/ticks', '{"from":2}', [EVENT_STREAM, 'last-event-id: 3']),
              {'expect': {'status': 204, 'fields': {**CALL_FIELDS, 'bead-refusal': None}, 'body': ''}, 'on': 'a'}]),
    exchange("an EventSource's GET of a procedure marked NO_SIDE_EFFECTS", ['3.2', '8.1'],
             [send('GET', '/api/Transcoding/ticks?from=1', [EVENT_STREAM]), stream_answer(counted(1))]),
    exchange("a host it does not take, 403", ['10.1', '10.1.2', '7.7'],
             [send('GET', '/v1/books/2', ['host: evil.example']),
              refused_own(403, 'host-refused', 'a host it does not take')]),
    exchange("an origin neither its own nor listed, 403", ['10.1', '10.1.4'],
             [send('GET', '/v1/books/2', ['origin: https://other.example']),
              refused_own(403, 'origin-refused', 'an origin neither its own nor listed')]),
    exchange("an origin listed is answered CORS", ['6.2', '10.1.4'],
             [json_post('/api/Transcoding/echo', '{}', [f'origin: {ORIGIN}']),
              answered('{}', fields={'access-control-allow-origin': ORIGIN, 'access-control-expose-headers': '*'})]),
    exchange("a preflight answered with the methods its URL's routes take", ['10.1', '10.1.6'],
             [send('OPTIONS', '/v1/shelves/1/books/2', [f'origin: {ORIGIN}', 'access-control-request-method: PATCH',
                                                       'access-control-request-headers: content-type']),
              {'expect': {'status': 204, 'fields': {**CALL_FIELDS, 'access-control-allow-origin': ORIGIN,
                                                    'access-control-expose-headers': '*',
                                                    'access-control-allow-methods': 'GET, HEAD, PATCH',
                                                    'access-control-allow-headers': 'authorization, content-type, *',
                                                    'access-control-max-age': '7200', 'bead-refusal': None},
                          'body': ''}, 'on': 'a'}]),
    exchange("a navigation from another site to a GET of a procedure marked NO_SIDE_EFFECTS is taken", ['10.1.5'],
             [send('GET', '/api/Transcoding/getOperation?name=operations/a',
                   ['sec-fetch-site: cross-site', 'sec-fetch-mode: navigate']),
              answered(result('Operation', {'name': 'operations/a', 'done': True}))]),
    exchange("a subresource from another site with no origin is refused", ['10.1.5'],
             [send('GET', '/api/Transcoding/getOperation?name=operations/a',
                   ['sec-fetch-site: cross-site', 'sec-fetch-mode: no-cors']),
              refused_own(403, 'origin-refused', ORIGINLESS)]),
    exchange("a navigation from another site to a get rule on an unmarked method is refused", ['3.4', '10.1.5'],
             [send('GET', '/v1/shelves/s/books', ['sec-fetch-site: same-site', 'sec-fetch-mode: navigate']),
              refused_own(403, 'origin-refused', ORIGINLESS)]),
    exchange("a navigation from another site to the document is taken", ['10.1.5', '11.1'],
             [send('GET', '/openapi.json', ['sec-fetch-site: cross-site', 'sec-fetch-mode: navigate']),
              {'expect': {'status': 200, 'fields': {'content-type': 'application/json', 'cache-control': 'no-cache',
                                                    'etag': {'shape': 'etag'}, 'x-content-type-options': 'nosniff',
                                                    'vary': 'Origin'}, 'body': DOCUMENT}, 'on': 'a'}]),
    exchange("a request of no sec-fetch-site is taken", ['10.1.5'],
             [send('GET', '/v1/shelves/s/books'),
              answered('[' + ','.join(result('Book', {'name': f'shelves/s/books/{name}', 'title': name.upper()})
                                      for name in 'ab') + ']')]),
    exchange("a request of its own origin with no origin is taken", ['10.1.5'],
             [send('GET', '/v1/books/2', ['sec-fetch-site: same-origin', 'sec-fetch-mode: no-cors']),
              answered(result('Book', {'name': '2', 'title': 'A tale'}))]),
    exchange("a path no route matches, 404", ['3.10', '10.1.3'],
             [send('GET', '/nope'), refused_own(404, 'path-unknown', 'a path no route matches')]),
    exchange("a command has no route", ['3.1', '3.10'],
             [json_post('/api/Transcoding/answer', '{}'), refused_own(404, 'path-unknown', 'a path no route matches')]),
    exchange("a body HTTP cannot frame, refused as HTTP refuses it, unmarked, its body empty", ['10.1', '10.1.1'],
             [{'send': {'head': 'POST /api/Transcoding/echo HTTP/1.1' + chr(13) + chr(10) + 'host: {host}' + chr(13) + chr(10)
                        + 'content-type: application/json' + chr(13) + chr(10) + 'transfer-encoding: chunked'
                        + chr(13) + chr(10) + 'connection: close' + chr(13) + chr(10) + chr(13) + chr(10),
                        'body': hexadecimal(b'zz\r\n{}\r\n0\r\n\r\n')}, 'on': 'a'},
              {'expect': {'status': 400, 'fields': {'bead-refusal': None, 'content-type': None}, 'body': ''},
               'on': 'a'}]),
    exchange("what HTTP refuses of its own, unmarked, its body empty", ['7.7', '10.1', '10.1.1'],
             [send('GET', '/v1/books/2', ['host: {host}', 'host: {host}']),
              {'expect': {'status': 400, 'fields': {'bead-refusal': None, 'content-type': None}, 'body': ''},
               'on': 'a'}]),
    # * a head's characters are its octets, so a character past U+007F is one octet past US-ASCII: é as
    # the two octets of its UTF-8, in the path and in the query; each control character the octet
    # itself, judged before the path is matched, so a path no route matches is 400 and not 404
    exchange("a target holding an octet other than visible ASCII, or a path whose percent-decoding holds NUL, "
             "refused as HTTP refuses it, unmarked, its body empty, before its path is matched; one percent-encoded "
             "is taken, and a # is a character of its path",
             ['3.6', '10.1', '10.1.1', 'spec:15.12'],
             [*[step for on, target in (('a', '/v1/books/' + chr(0xC3) + chr(0xA9)),
                                        ('b', '/v1/books/2?tags=' + chr(0xC3) + chr(0xA9)),
                                        ('c', '/v1/books/a' + chr(1) + 'b'), ('d', '/v1/books/a' + chr(9) + 'b'),
                                        ('e', '/v1/books/a' + chr(0x7F) + 'b'),
                                        ('f', '/v1/books/2?revision=' + chr(1)), ('g', '/nowhere' + chr(1)),
                                        ('h', '/v1/books/a%00b'))
                for step in (send('GET', target, on=on),
                             {'expect': {'status': 400, 'fields': {'bead-refusal': None, 'content-type': None},
                                         'body': ''}, 'on': on})],
              send('GET', '/v1/books/a%01b', on='i'),
              answered(result('Book', {'name': 'a' + chr(1) + 'b', 'title': 'A tale'}), on='i'),
              send('GET', '/v1/books/a#b', on='j'),
              answered(result('Book', {'name': 'a#b', 'title': 'A tale'}), on='j')]),
    exchange("a body past maximumBodyBytes as it comes, 413", ['9.3', '10.1', '10.1.10'],
             [{'send': {'head': 'POST /api/Transcoding/echo HTTP/1.1' + chr(13) + chr(10) + 'host: {host}' + chr(13) + chr(10)
                        + 'content-type: application/json' + chr(13) + chr(10) + 'transfer-encoding: chunked'
                        + chr(13) + chr(10) + 'connection: close' + chr(13) + chr(10) + chr(13) + chr(10),
                        'body': hexadecimal(b'18\r\n{"aString":"0123456789"}\r\n0\r\n\r\n')}, 'on': 'a'},
              refused_own(413, 'too-large', 'a body past maximumBodyBytes 16')],
             options={'maximumBodyBytes': 16}),
    exchange("a dot segment matches nothing", ['3.6', '3.10'],
             [send('POST', '/api/Transcoding/../Transcoding/echo', ['content-type: application/json'], '{}'),
              refused_own(404, 'path-unknown', 'a path no route matches')]),
    exchange("a method no route of its path takes, 405, allow naming those that do", ['3.10', '10.1.7'],
             [send('PUT', '/v1/shelves/1/books/2', ['content-type: application/json'], '{}'),
              refused_own(405, 'method-refused', METHOD_WORDS, fields={'allow': 'GET, HEAD, PATCH'})]),
    exchange("a body declared past maximumBodyBytes, 413", ['9.3', '10.1.9'],
             [json_post('/api/Transcoding/echo', '{"aString":"0123456789"}'),
              refused_own(413, 'too-large', 'a body declared past maximumBodyBytes 16')],
             options={'maximumBodyBytes': 16}),
    exchange("the document, as its builder wrote it, and a 304 to its etag", ['11.1'],
             [send('GET', '/openapi.json', on='a'),
              {'expect': {'status': 200, 'fields': {'content-type': 'application/json', 'cache-control': 'no-cache',
                                                    'etag': {'capture': 'etag', 'shape': 'etag'},
                                                    'x-content-type-options': 'nosniff', 'vary': 'Origin'},
                          'body': DOCUMENT}, 'on': 'a'},
              send('GET', '/openapi.json', ['if-none-match: {etag}'], on='b'),
              {'expect': {'status': 304, 'fields': {'etag': {'shape': 'etag'}, 'cache-control': 'no-cache',
                                                    'x-content-type-options': 'nosniff', 'vary': 'Origin'}, 'body': ''},
               'on': 'b'}]),
    exchange("an if-none-match that holds * among other tags, 304", ['11.1'],
             [send('GET', '/openapi.json', ['if-none-match: "other", *']),
              {'expect': {'status': 304, 'fields': {'etag': {'shape': 'etag'}, 'cache-control': 'no-cache',
                                                    'x-content-type-options': 'nosniff', 'vary': 'Origin'}, 'body': ''},
               'on': 'a'}]),
    exchange("calls held per address, apart from streams", ['10.3'],
             [json_post('/api/Transcoding/hang', '{}', on='a'), {'until': {'hanging': 1}},
              json_post('/api/Transcoding/echo', '{}', on='b'),
              refused_own(503, 'busy', 'the calls of its address hold maximumExchangesPerAddress',
                          fields={'retry-after': '1'}, on='b')],
             options={'maximumExchangesPerAddress': 1}, real_time=True),
    exchange("streams held per address, apart from calls", ['10.3'],
             [json_post('/api/Transcoding/watch', '{}', [EVENT_STREAM], on='a'),
              {'expect': {'status': 200, 'fields': {**CALL_FIELDS, 'content-type': 'text/event-stream'},
                          'stream': event_text('result', 1, '{}')}, 'on': 'a'},
              json_post('/api/Transcoding/watch', '{}', [EVENT_STREAM], on='b'),
              refused_own(503, 'busy', 'the streams of its address hold maximumConnectionsPerAddress',
                          fields={'retry-after': '1'}, on='b'),
              json_post('/api/Transcoding/echo', '{}', on='c'), answered('{}', on='c')],
             options={'maximumConnectionsPerAddress': 1}, real_time=True),
]


# ── The file ────────────────────────────────────────────────────────────────────────────────────

GATEWAY_DEFAULTS = {
    'hosts': [], 'origins': [ORIGIN], 'trustedProxies': [], 'unnamedProxies': 0, 'authorization': 'elsewhere',
    'challenge': 'Bearer', 'timeout': 5_000, 'window': 16, 'heartbeat': 30_000, 'maximumExchanges': 10_000,
    'maximumExchangesPerAddress': 256, 'maximumConnections': DEFAULTS['maximumConnections'],
    'maximumConnectionsPerAddress': DEFAULTS['maximumConnectionsPerAddress'],
    **{name: DEFAULTS[name] for name in ('bodyBytesBudget', 'maximumBodyBytes', 'headersTimeout', 'minimumBodyBytesPerSecond',
                                         'bodyGracePeriod', 'minimumSendBytesPerSecond', 'sendGracePeriod',
                                         'maximumUnsentBytes')},
    'problemTypes': PROBLEM_TYPES, 'document': True,
}

SERVICE_TEXT = {
    'name': SERVICE,
    'procedures': {procedure.name: procedure.note for procedure in PROCEDURES},
    'verifier': "ELSEWHERE: the value Bearer good resolves to a credential's session of the identifier ada; any "
                'other does not hold. The server is given no JWT verifier.',
    'counts': {'hanging': "the calls of hang its resolver took, which an exchange's until waits on"},
}


def unit_order(unit):
    """A unit's place among an entry's: the companion's own in its order, then the spec's behind spec:."""
    document, _, number = unit.rpartition(':')

    return document, tuple(int(part) for part in number.split('.'))


def ordered(entries, group):
    """A group's entries, each name once, each entry's units once and in the companion's order."""
    names = [entry['name'] for entry in entries]
    twice = sorted({name for name in names if names.count(name) > 1})

    if twice:
        raise SystemExit(f'{group}: two entries named {", ".join(twice)}')

    for entry in entries:
        entry['clauses'] = sorted(set(entry['clauses']), key=unit_order)

    return entries


cross_check()

DOCUMENT_JSON = {
    '$schema': 'schemas/transcoding.schema.json',
    '$comment': [
        "Bead's HTTP/JSON transcoding: what a gateway answers over HTTP of a service's procedures (spec/transcoding.md, decision 0037), which every implementation that offers a gateway plays through its own modules and its gateway: templates and bindings through its routes, readings and writings through its mapping of protobuf's JSON, failures through its problems, events through its streams, and exchanges through its gateway over a real socket.",
        "Every message is spec/transcoding.proto's, by its full name, and its service TranscodingService, named Transcoding, each procedure by its name; each side's tests take their code of it from beadc, an output with http: true, whose route table and document they read, which tools/check-transcoding.mjs holds to what beadc writes.",
        "templates are templates and raw paths: route, the index of the template that answers a path by 3.5's precedence, null where none matches; variables, each variable's value by its field path, decoded as 3.8 decodes one; verb, the path's, where it has one; refused, where a variable's value does not decode, which a gateway answers 400 PAYLOAD_UNDECODABLE. An entry of one template and refused is a template refused as it is parsed; one of two templates and tie says whether they tie (3.9).",
        "readings are bodies read as 5.2 reads a proto request's: body, its text, or bodyBytes, its bytes in hexadecimal where they are no UTF-8; then payload, the message read, as its binary payload in hexadecimal, which a harness reads through its stock library and compares with the message its mapping read, as messages, since protobuf fixes no message's bytes whole; or refused, the reason it is refused for, the mapping's own words, and pointer, where it met it as 7.4 places it, the body the request whole, none for the text's own.",
        "writings are results written as 5.6 writes one: payload, the result's bytes, which a harness reads through its stock library; then body, the text Bead's proto JSON form writes of it, byte for byte, or refused, the reason 5.7 refuses it for, which a gateway answers 500 (7.6).",
        "upb, on a reading or a writing, is how protobuf's own Python library, which the generator runs beside its own reading and writing, parts from it, D and its number where a row of decision 0037's table says the stock libraries part there too: informative, read by no harness.",
        "bindings are requests bound by section 4: procedure, its procedure; route, its method, its template and its body as its rule gives them; target, the request's target, raw; body, its body's text where it has one; then payload, the request's message as its binary payload, compared as a reading's is, or refused, the reason, which a gateway answers 400 PAYLOAD_UNDECODABLE, and pointer or parameter, where the request carried it, as 7.4 places it, none for its text or its query whole.",
        "failures are a call's failure as a gateway answers it (section 7). failure is its code; its scope, protocol where none is given; its detail as the gateway's client read it; where it arose, arose: server, its server answered it of the request; client, its client raised it before the call went; answer, its client raised it of a result or a notification; gateway, the gateway's own reading of the request; encoding, of a request its server could not read, proto where none is given; credential, true where its call presented one; challenge, where the gateway is given one, Bearer otherwise; pointer or parameter, where the gateway's reading met what it refuses. Or own, a failure of the gateway's own — timeout, closed, unwritable, jwt, scheme or failed — with its detail, its words, empty for none. procedure and route, for PAYLOAD_INVALID, its procedure and the route its request came by; problemTypes, the problem types its definitions give, https://example.com/problems/ where none is given, null for none. status, fields beside it, and problem, the body's text, byte for byte.",
        "events are a stream's call as a gateway writes it (section 8): steps, what its call gives, in their order — result and notification, each its data: a JSON text, a text, as text, or bytes in hexadecimal, as raw, which 8.4 writes as JSON strings; heartbeat, its heartbeat's timer firing; failure, a problem's status and its text — then status, contentType and body, the response's, byte for byte.",
        "exchanges are HTTP exchanges with a gateway of the Transcoding service, in process, its server joined, over a real socket, each step as spec/transports.json plays one. send writes a request on a socket of its own, opened for the exchange it names with on: head, its octets as text, each character one octet, as ISO-8859-1 writes it, in which {host} is the gateway's host and port, an IP literal, and {etag}, or any other name a field captured, the value captured under it; body, its octets in hexadecimal. expect reads the response on that exchange: its status; its fields, by name in any case, each its value, null for one absent, {\"shape\": \"etag\"} for a strong entity tag of 64 lower-case hexadecimal digits, the sha256 of the document, {\"capture\"} keeping it under that name; its body, its text exactly, or bodyBytes, in hexadecimal, read by its content-length or de-chunked to its end; or stream, the octets a body that does not end begins with. In a body, {document} stands for the document beadc wrote of spec/transcoding.proto, byte for byte; a refusal's words are the companion's (7.7), each in its body as it is. close drops a socket; until waits, on the real clock and within a patience, for a count the service keeps to reach its value.",
        "defaults are the gateway's options where a case gives none, by the names of transcoding 2.4, 7.6, 8.7, 8.8, 9.2, 10.3 and 11.1, and of spec 15.12, in milliseconds for a time; options, where given, are a case's beside them. service is what each procedure's resolver does, by its name, what its server verifies, and the counts an exchange waits on. A case marked realTime plays on the real clock.",
        "clauses are the units of transcoding.md an entry checks: a clause, 5.2; an item of its numbered list, 5.2.1; a row of its table, counted from 1, 7.6.8; and a unit of spec.md behind spec:, spec:9.2.5, after them.",
    ],
    'transcodingVersion': transcoding_version(),
    'defaults': GATEWAY_DEFAULTS,
    'service': SERVICE_TEXT,
    'templates': ordered(TEMPLATES, 'templates'),
    'readings': ordered(READINGS, 'readings'),
    'writings': ordered(WRITINGS, 'writings'),
    'bindings': ordered(BINDINGS, 'bindings'),
    'failures': ordered(FAILURES, 'failures'),
    'events': ordered(EVENTS, 'events'),
    'exchanges': ordered(EXCHANGES, 'exchanges'),
}

if __name__ == '__main__':
    with open(ROOT + 'transcoding.proto', 'w', encoding='utf-8', newline='\n') as file:
        file.write(proto_file())

    with open(ROOT + 'transcoding.json', 'w', encoding='utf-8', newline='\n') as file:
        json.dump(DOCUMENT_JSON, file, ensure_ascii=False, indent=2)
        file.write('\n')

    print(', '.join(f'{len(DOCUMENT_JSON[group])} {group}' for group in
                    ('templates', 'readings', 'writings', 'bindings', 'failures', 'events', 'exchanges')) +
          f'; upb parts from {len(UPB_READS)} readings and {len(UPB_WRITES)} writings, each as its entry names')
