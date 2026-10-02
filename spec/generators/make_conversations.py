"""Writes spec/conversations.json: what a server of the interop service does with what a client sends."""
import json
import os

from spec_version import spec_version

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')
SERVICE = json.load(open(ROOT + 'interop-service.json', encoding='utf8'))
SERVICE_ID = SERVICE['serviceId']
PROCEDURES = {procedure['procedureName']: procedure['procedureId'] for procedure in SERVICE['procedures']}

MALFORMED, LAYOUT_UNSUPPORTED, KIND_UNSUPPORTED, TOO_LARGE = 1, 2, 3, 4
DESTINATION_UNKNOWN, SERVICE_UNKNOWN, PROCEDURE_UNKNOWN, CALL_UNKNOWN = 16, 18, 19, 20
ACCESS_DENIED, PAYLOAD_TOO_LARGE = 33, 34
PAYLOAD_UNDECODABLE, PROCEDURE_FAILED = 50, 64
REQUEST, RESULT, FAILURE, NOTIFICATION, CANCEL = 16, 17, 18, 19, 22
CAPACITY_EXCEEDED = 35
PROTOCOL, APPLICATION = 0, 1

SLOW = '{"milliseconds":3600000}'


def hexadecimal(data):
    return ' '.join(f'{byte:02X}' for byte in data)


def word(value, length):
    return hexadecimal(value.to_bytes(length, 'big'))


def text(value):
    return hexadecimal(value.encode('utf-8'))


def request(call_id, procedure, payload, *, service_id=SERVICE_ID, flags=0, words=3, tail=''):
    procedure_id = PROCEDURES[procedure] if isinstance(procedure, str) else procedure
    head = f'A1 10 {flags:02X} {words:02X}  {word(call_id, 4)}  {word(service_id, 2)} {word(procedure_id, 2)}'
    head += f'  {tail}' if tail else ''
    return {'in': head + (f' | {payload}' if payload else '')}


def json_request(call_id, procedure, value, **options):
    return request(call_id, procedure, text(value), **options)


def cancel(call_id):
    return {'in': f'A1 16 00 02  {word(call_id, 4)}'}


def raw(data):
    return {'in': data}


def result(call_id, value, session=None):
    return {'out': {'kind': RESULT, 'callId': call_id, 'payload': text(value),
                    **({'session': session} if session else {})}}


def failure(call_id, code, scope=PROTOCOL, session=None):
    return {'out': {'kind': FAILURE, 'callId': call_id, 'failure': {'code': code, 'scope': scope},
                    **({'session': session} if session else {})}}


def report(code):
    return {'report': code}


def command(call_id, procedure, value):
    return {'out': {'kind': REQUEST, 'callId': call_id, 'serviceId': SERVICE_ID,
                    'procedureId': PROCEDURES[procedure], 'payload': text(value)}}


def cancelled(call_id):
    return {'out': {'kind': CANCEL, 'callId': call_id}}


def answer(call_id, value):
    return {'in': f'A1 11 00 02  {word(call_id, 4)} | {text(value)}'}


def refusal(call_id, code, scope=PROTOCOL):
    return {'in': f'A1 12 00 02  {word(call_id, 4)} | {word(code, 2)} 00 {scope:02X}'}


QUESTION = '"What time is it where you are?"'


def subscribe(call_id, *, paced=False, hold=None, fail=False):
    payload = 'null' if hold is None else ('{"hold":%d,"fail":true}' % hold if fail else '{"hold":%d}' % hold)
    return json_request(call_id, 'ticks', payload, flags=0x30 if paced else 0x10)


def tick(call_id, value, key=None):
    payload = '{"value":%s}' % value if key is None else '{"value":%s,"key":"%s"}' % (value, key)
    return json_request(call_id, 'tick', payload)


def notification(call_id, value):
    return {'out': {'kind': NOTIFICATION, 'callId': call_id, 'payload': text(value)}}


def credit(call_id, end):
    return {'in': f'A1 15 20 04  {word(call_id, 4)}  {word(end, 8)}'}


QUEUE_OF_TWO = {'maximumQueuedNotifications': 2}

SESSION_REQUIRED = 32
TOKEN_BYTES = '00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F'


def login(call_id, name):
    return json_request(call_id, 'login', '{"name":"%s"}' % name)


SMALL = {'maximumEnvelopeBytes': 64, 'chunkBytes': 64, 'windowBytes': 128}

# transfers in chunks of 64 bytes: an opening of a request carries 44 bytes of its payload, one of a
# result 32 — its session counted — and a chunk 48
CHUNKED = {'chunkBytes': 64, 'windowBytes': 128}
CHUNK, CREDIT = 20, 21
CHUNK_INVALID, CREDIT_EXCEEDED = 48, 49


def json_string(length):
    # a JSON string of `length` bytes, quotes included, which echo answers byte for byte
    return '"' + ''.join(chr(ord('a') + index % 26) for index in range(length - 2)) + '"'


def opening(call_id, procedure, data, total):
    # a request that opens a transfer: TRANSFER, the total on 8 bytes, its first bytes
    return request(call_id, procedure, hexadecimal(data), flags=0x04, words=5, tail=word(total, 8))


def chunk_in(call_id, offset, data, last):
    return {'in': f'A1 14 {0x00 if last else 0x40:02X} 04  {word(call_id, 4)}  {word(offset, 8)} | {hexadecimal(data)}'}


def credit_in(call_id, end):
    return {'in': f'A1 15 00 04  {word(call_id, 4)}  {word(end, 8)}'}


def credited(call_id, end):
    return {'out': {'kind': CREDIT, 'callId': call_id, 'creditEnd': end}}


def result_opening(call_id, data, total):
    return {'out': {'kind': RESULT, 'callId': call_id, 'payload': hexadecimal(data), 'total': total}}


def chunk_out(call_id, offset, data, last):
    return {'out': {'kind': CHUNK, 'callId': call_id, 'offset': offset, 'isLast': last, 'payload': hexadecimal(data)}}


ECHOED = json_string(100).encode('utf-8')
LONG = json_string(300).encode('utf-8')

conversations = [
    # 9.2: a request routed, admitted and answered
    ('echo answers with its request\'s payload', None, [
        json_request(1, 'echo', '{"a":1}'), result(1, '{"a":1}')]),
    ('fail answers with its own failure, of the application', None, [
        json_request(3, 'fail', 'null'), failure(3, 7, APPLICATION)]),
    ('a service unknown is answered SERVICE_UNKNOWN', None, [
        json_request(1, 1, '{}', service_id=9), failure(1, SERVICE_UNKNOWN)]),
    ('a procedure unknown, in a service known, is answered PROCEDURE_UNKNOWN', None, [
        json_request(1, 99, '{}'), failure(1, PROCEDURE_UNKNOWN)]),
    ('an admission that refuses is answered with its refusal', None, [
        json_request(1, 'denied', 'null'), failure(1, ACCESS_DENIED)]),
    ('a request with a destination, to a server that relays nothing, is answered DESTINATION_UNKNOWN', None, [
        json_request(1, 'echo', 'null', flags=0x02, words=4, tail='00 00 00 05'), failure(1, DESTINATION_UNKNOWN)]),
    ('a request that opens a transfer, to a server that takes none, is answered PAYLOAD_TOO_LARGE',
     {'maximumTransfers': 0}, [
         json_request(1, 'echo', '"', flags=0x04, words=5, tail='00 00 00 00 00 00 01 00'),
         failure(1, PAYLOAD_TOO_LARGE)]),
    ('a request that opens a subscription to a procedure that notifies nothing is answered, and holds nothing', None, [
        json_request(1, 'echo', '"x"', flags=0x10), result(1, '"x"'),
        json_request(1, 'echo', '"y"'), result(1, '"y"')]),
    # 9.5: what the resolver fails at
    ('a resolver that throws before it answers is answered PROCEDURE_FAILED, and reported', None, [
        json_request(1, 'broken', 'null'), failure(1, PROCEDURE_FAILED), report('exception')]),
    ('a payload that is not JSON is answered PAYLOAD_UNDECODABLE', None, [
        request(1, 'echo', 'FF'), failure(1, PAYLOAD_UNDECODABLE)]),
    ('an admission is asked before the payload is read: one that is not JSON is refused by it, not undecodable', None, [
        request(1, 'denied', 'FF'), failure(1, ACCESS_DENIED),
        request(3, 'whoami', 'FF'), failure(3, SESSION_REQUIRED)]),
    ('an answer too large for one envelope, from a server that sends no transfer, is answered PROCEDURE_FAILED, and reported PAYLOAD_TOO_LARGE',
     {**SMALL, 'maximumTransfers': 0}, [
         json_request(1, 'bytes', '{"length":60}'), failure(1, PROCEDURE_FAILED), report(PAYLOAD_TOO_LARGE)]),
    ('a result that fits in one envelope only without the session an answer may announce is refused as one that does not',
     {**SMALL, 'maximumTransfers': 0}, [
         json_request(1, 'bytes', '{"length":45}'), failure(1, PROCEDURE_FAILED), report(PAYLOAD_TOO_LARGE)]),
    # 9.1: a server opens calls of its own, a command to its client, on its even call ids
    ('the server asks its client a command, and answers with what the client answered', None, [
        json_request(1, 'ask', 'null'), command(2, 'clock', QUESTION), answer(2, '"noon"'), result(1, '"noon"')]),
    ('a command the client fails fails the call that asked it, which is reported', None, [
        json_request(1, 'ask', 'null'), command(2, 'clock', QUESTION), refusal(2, 7, APPLICATION),
        failure(1, PROCEDURE_FAILED), report(7)]),
    # 9.6, steps 3 and 5: an answer that does not read ends its call, cancelled; a late one is dropped
    ('an answer to a command that does not read ends the command and cancels it, and a late one is dropped in silence', None, [
        json_request(1, 'ask', 'null'), command(2, 'clock', QUESTION), raw('A1 11 40 02  00 00 00 02'),
        cancelled(2), failure(1, PROCEDURE_FAILED), report(MALFORMED), answer(2, '"late"')]),
    # 11: subscriptions, one per procedure and connection, on the call id that took it first
    ('a request that opens a subscription to ticks is answered, and each tick notifies it on its call id', None, [
        subscribe(1), result(1, 'null'), tick(3, 1), notification(1, '1'), result(3, 'null')]),
    ('a request to ticks that opens no subscription subscribes nothing', None, [
        json_request(1, 'ticks', 'null'), result(1, 'null'), tick(3, 1), result(3, 'null')]),
    ('a call id a subscription holds is in use: a request on it is reported, never answered', None, [
        subscribe(1), result(1, 'null'), json_request(1, 'echo', '"again"'), report(MALFORMED),
        tick(3, 1), notification(1, '1'), result(3, 'null')]),
    ('a cancel ends a subscription, and nothing more goes on its call id', None, [
        subscribe(1), result(1, 'null'), cancel(1), tick(3, 1), result(3, 'null')]),
    ('a later subscription to the same procedure is answered and holds nothing: the first keeps it', None, [
        subscribe(1), result(1, 'null'), subscribe(3), result(3, 'null'), tick(5, 1), notification(1, '1'),
        result(5, 'null')]),
    ('a notification may come before the answer of the call it travels on', None, [
        subscribe(1, hold=1), tick(3, 1), notification(1, '1'), result(1, 'null'), result(3, 'null')]),
    ('a call answered while the first is unanswered waits, and takes the place when the first is cancelled', None, [
        subscribe(1, hold=1), subscribe(3), result(3, 'null'), cancel(1), tick(5, 1), notification(3, '1'),
        result(5, 'null')]),
    ('a call answered while the first is unanswered waits, and takes the place when the first fails', None, [
        subscribe(1, hold=1, fail=True), subscribe(3), result(3, 'null'), tick(5, 1), notification(1, '1'),
        failure(1, 7, APPLICATION), result(5, 'null'), tick(7, 2), notification(3, '2'), result(7, 'null')]),
    # 11.8 to 11.10: pacing
    ('a paced subscription is sent a notification per credit, the first credited by its request', None, [
        subscribe(1, paced=True), result(1, 'null'), tick(3, 1), notification(1, '1'), result(3, 'null'),
        tick(5, 2), result(5, 'null'), credit(1, 2), notification(1, '2')]),
    ('a keyed notification replaces the one of its key waiting, in its place', None, [
        subscribe(1, paced=True), result(1, 'null'), tick(3, 1), notification(1, '1'), result(3, 'null'),
        tick(5, 2, 'a'), result(5, 'null'), tick(7, 3), result(7, 'null'), tick(9, 4, 'a'), result(9, 'null'),
        credit(1, 3), notification(1, '4'), notification(1, '3')]),
    ('a credit no higher than the last grants nothing', None, [
        subscribe(1, paced=True), result(1, 'null'), tick(3, 1), notification(1, '1'), result(3, 'null'),
        tick(5, 2), result(5, 'null'), credit(1, 1), credit(1, 2), notification(1, '2')]),
    ('a credit lower than the last takes nothing back: the highest stands', None, [
        subscribe(1, paced=True), result(1, 'null'), tick(3, 1), notification(1, '1'), result(3, 'null'),
        credit(1, 3), credit(1, 2), tick(5, 2), notification(1, '2'), result(5, 'null'), tick(7, 3),
        notification(1, '3'), result(7, 'null'), tick(9, 4), result(9, 'null')]),
    ('a queue past its bounds ends an answered subscription with a failure on its call id', None, QUEUE_OF_TWO, [
        subscribe(1, paced=True), result(1, 'null'), tick(3, 1), notification(1, '1'), result(3, 'null'),
        tick(5, 2), result(5, 'null'), tick(7, 3), result(7, 'null'), tick(9, 4), failure(1, CAPACITY_EXCEEDED),
        result(9, 'null'), tick(11, 5), result(11, 'null')]),
    ('a queue past its bounds while its call is unanswered is that call\'s answer', None, QUEUE_OF_TWO, [
        subscribe(1, paced=True, hold=4), tick(3, 1), notification(1, '1'), result(3, 'null'), tick(5, 2),
        result(5, 'null'), tick(7, 3), result(7, 'null'), tick(9, 4), failure(1, CAPACITY_EXCEEDED),
        result(9, 'null')]),
    # 13: sessions, announced by the next answer after they change, and only by it
    ('a procedure that requires a session refuses a connection without one with SESSION_REQUIRED', None, [
        json_request(1, 'whoami', 'null'), failure(1, SESSION_REQUIRED)]),
    ('a session opened is announced by the next answer, and only by it', None, [
        login(1, 'ada'), result(1, '"ada"', 'announced'), json_request(3, 'whoami', 'null'), result(3, '"ada"')]),
    ('a session ended is announced by the next answer, and only by it', None, [
        login(1, 'ada'), result(1, '"ada"', 'announced'), json_request(3, 'logout', 'null'),
        result(3, 'null', 'ended'), json_request(5, 'whoami', 'null'), failure(5, SESSION_REQUIRED)]),
    ('a session opened again is announced again, its token drawn anew', None, [
        login(1, 'ada'), result(1, '"ada"', 'announced'), login(3, 'bob'), result(3, '"bob"', 'announced')]),
    ('a session that ends ends its connection\'s subscriptions, the first answer to go out announcing it', None, [
        login(1, 'ada'), result(1, '"ada"', 'announced'), subscribe(3), result(3, 'null'),
        json_request(5, 'logout', 'null'), failure(3, SESSION_REQUIRED, session='ended'), result(5, 'null'),
        tick(7, 1), result(7, 'null')]),
    ('a request presenting a session is read, and its session ignored', None, [
        json_request(1, 'echo', '"x"', flags=0x01, words=7, tail=TOKEN_BYTES), result(1, '"x"')]),
    # 9.2, steps 1 and 2: what would answer another call
    ('a request on the server\'s own parity is reported, never answered', None, [
        json_request(2, 'echo', 'null'), report(MALFORMED)]),
    ('a request on a call id still open is reported, never answered', None, [
        json_request(1, 'slow', SLOW), json_request(1, 'echo', '"again"'), report(MALFORMED),
        cancel(1), json_request(3, 'cancellations', 'null'), result(3, '1')]),
    # 9.4 and 10: the cancel, and the answer that goes out only while its call is open
    ('a cancel ends its call, and the answer its resolver gives after goes nowhere', None, [
        json_request(1, 'slow', SLOW), cancel(1), json_request(3, 'cancellations', 'null'), result(3, '1')]),
    ('a call id cancelled is opened again, and the first call\'s answer does not answer the second', None, [
        json_request(1, 'slow', SLOW), cancel(1), json_request(1, 'echo', '"again"'), result(1, '"again"'),
        json_request(3, 'cancellations', 'null'), result(3, '1')]),
    ('a connection that closes ends its calls, and their answers go nowhere', None, [
        json_request(1, 'slow', SLOW), {'close': True}]),
    ('a cancel on the server\'s own parity is reported', None, [cancel(2), report(MALFORMED)]),
    ('a cancel for no call crossed its answer, and is dropped in silence', None, [cancel(5)]),
    # 9.6: the gate
    ('a message shorter than a prefix is reported', None, [raw('A1 10 00'), report(MALFORMED)]),
    ('a first byte no layout is, is reported', None, [
        raw('0A 10 00 03  00 00 00 03  00 01 00 01'), report(MALFORMED)]),
    ('a request of a layout to come is answered LAYOUT_UNSUPPORTED, on its call id', None, [
        raw('A2 10 00 03  00 00 00 07  00 01 00 01'), failure(7, LAYOUT_UNSUPPORTED)]),
    ('a request of a layout to come, on the server\'s own parity, is reported', None, [
        raw('A2 10 00 03  00 00 00 08  00 01 00 01'), report(LAYOUT_UNSUPPORTED)]),
    ('a malformed request is answered ENVELOPE_MALFORMED, on its call id', None, [
        raw('A1 10 08 03  00 00 00 09  00 01 00 01'), failure(9, MALFORMED)]),
    ('a malformed request on a call id still open is reported, never answered', None, [
        json_request(1, 'slow', SLOW), raw('A1 10 08 03  00 00 00 01  00 01 00 01'), report(MALFORMED),
        cancel(1)]),
    ('a request past the envelope\'s bound is answered ENVELOPE_TOO_LARGE, on its call id', SMALL, [
        json_request(1, 'echo', '"' + 'x' * 60 + '"'), failure(1, TOO_LARGE)]),
    ('a kind to come is reported KIND_UNSUPPORTED', None, [raw('A1 17 00 02  00 00 00 05'), report(KIND_UNSUPPORTED)]),
    ('an advisory kind is skipped', None, [raw('A1 80 00 02  00 00 00 03')]),
    ('a result for no call is reported CALL_UNKNOWN', None, [raw('A1 11 00 02  00 00 00 04'), report(CALL_UNKNOWN)]),
    ('a failure for no call is reported CALL_UNKNOWN', None, [
        raw('A1 12 00 02  00 00 00 06 | 00 13 00 00'), report(CALL_UNKNOWN)]),
    ('a notification is reported KIND_UNSUPPORTED by a server, which takes none', None, [
        raw('A1 13 00 02  00 00 00 03'), report(KIND_UNSUPPORTED)]),
    ('a chunk for no call is reported CALL_UNKNOWN', None, [
        raw('A1 14 00 04  00 00 00 03  00 00 00 00 00 00 00 00 | 01'), report(CALL_UNKNOWN)]),
    ('a chunk on a call open without a transfer is reported ENVELOPE_MALFORMED', None, [
        json_request(1, 'slow', SLOW), raw('A1 14 00 04  00 00 00 01  00 00 00 00 00 00 00 00 | 01'),
        report(MALFORMED), cancel(1)]),
    # 9.8: the credits that find nothing
    ('a credit of notifications, for no subscription, is dropped in silence by a server, which sends them', None, [
        raw('A1 15 20 04  00 00 00 03  00 00 00 00 00 00 00 01')]),
    ('a credit of bytes, for no transfer, is dropped in silence', None, [
        raw('A1 15 00 04  00 00 00 03  00 00 00 00 00 00 00 10')]),
    # 12: transfers
    ('a request that comes as a transfer is credited to its total, then answered by a transfer its client credits', CHUNKED, [
        opening(1, 'echo', ECHOED[:44], 100), credited(1, 100),
        chunk_in(1, 44, ECHOED[44:92], False), chunk_in(1, 92, ECHOED[92:], True),
        result_opening(1, ECHOED[:32], 100),
        credit_in(1, 100), chunk_out(1, 32, ECHOED[32:80], False), chunk_out(1, 80, ECHOED[80:], True)]),
    ('a transfer is credited a window past the bytes received from the start, once half a window can go', CHUNKED, [
        opening(1, 'echo', LONG[:44], 300), credited(1, 172),
        chunk_in(1, 44, LONG[44:92], False), chunk_in(1, 92, LONG[92:140], False), credited(1, 268),
        chunk_in(1, 188, LONG[188:236], False), chunk_in(1, 140, LONG[140:188], False), credited(1, 300),
        cancel(1)]),
    ('a result is sent as far as its credit, a full chunk at a time, and a credit lower than the last grants nothing', CHUNKED, [
        json_request(1, 'echo', ECHOED.decode('utf-8')), result_opening(1, ECHOED[:32], 100),
        credit_in(1, 79), credit_in(1, 80), chunk_out(1, 32, ECHOED[32:80], False),
        credit_in(1, 60), credit_in(1, 100), chunk_out(1, 80, ECHOED[80:], True)]),
    ('a chunk past its credit is answered CREDIT_EXCEEDED, and a late one under it is dropped in silence', CHUNKED, [
        opening(1, 'echo', LONG[:44], 300), credited(1, 172),
        chunk_in(1, 172, LONG[172:220], False), failure(1, CREDIT_EXCEEDED),
        chunk_in(1, 44, LONG[44:92], False),
        chunk_in(1, 172, LONG[172:220], False), report(CREDIT_EXCEEDED)]),
    ('a chunk before the last that is not full is answered CHUNK_INVALID', CHUNKED, [
        opening(1, 'echo', LONG[:44], 300), credited(1, 172),
        chunk_in(1, 44, LONG[44:60], False), failure(1, CHUNK_INVALID)]),
    ('a chunk that says more follow though it reaches the total is answered CHUNK_INVALID', CHUNKED, [
        opening(1, 'echo', ECHOED[:44], 100), credited(1, 100),
        chunk_in(1, 44, ECHOED[44:92], False), chunk_in(1, 92, ECHOED[92:], False), failure(1, CHUNK_INVALID)]),
    ('a chunk over bytes received in part is answered CHUNK_INVALID, and one received whole is dropped in silence', CHUNKED, [
        opening(1, 'echo', LONG[:44], 300), credited(1, 172),
        chunk_in(1, 44, LONG[44:92], False), chunk_in(1, 44, LONG[44:92], False),
        chunk_in(1, 68, LONG[68:116], False), failure(1, CHUNK_INVALID)]),
    ('a chunk that does not read ends its transfer as CHUNK_INVALID', CHUNKED, [
        opening(1, 'echo', LONG[:44], 300), credited(1, 172),
        raw('A1 14 40 04  00 00 00 01  00 20 00 00 00 00 00 00 | 01'), failure(1, CHUNK_INVALID)]),
    ('an opening that holds its whole total is answered CHUNK_INVALID', CHUNKED, [
        opening(1, 'echo', b'"ab"', 4), failure(1, CHUNK_INVALID)]),
    ('an opening that declares a total of 0 is answered PAYLOAD_TOO_LARGE', CHUNKED, [
        opening(1, 'echo', b'', 0), failure(1, PAYLOAD_TOO_LARGE)]),
    ('a transfer past those a connection receives at once is answered CAPACITY_EXCEEDED', {**CHUNKED, 'maximumTransfers': 1}, [
        opening(1, 'echo', LONG[:44], 300), credited(1, 172),
        opening(3, 'echo', LONG[:44], 300), failure(3, CAPACITY_EXCEEDED), cancel(1)]),
    ('an opening past the budget left is answered CAPACITY_EXCEEDED, and a transfer it starves is credited once it frees', {
        **CHUNKED, 'bufferedBytesBudget': 256, 'maximumPayloadBytes': 256}, [
        opening(1, 'echo', LONG[:44], 200), credited(1, 172),
        opening(3, 'echo', LONG[:44], 200),
        opening(5, 'echo', LONG[:44], 200), failure(5, CAPACITY_EXCEEDED),
        cancel(1), credited(3, 172)]),
    ('a cancel ends the transfer of a result, and a credit after it is dropped in silence', CHUNKED, [
        json_request(1, 'echo', ECHOED.decode('utf-8')), result_opening(1, ECHOED[:32], 100),
        cancel(1), credit_in(1, 100)]),
]

document = {
    '$schema': 'schemas/conversations.schema.json',
    '$comment': [
        "Bead's conversations: what a server of the interop service (interop-service.json) does with what one client sends, played by every implementation's tests against its own server.",
        'in is what the client sends, in hexadecimal as vectors.json writes it; close closes the client\'s connection.',
        'out is the next envelope the server sends: its kind, its call id, and its payload or its failure; a request, its service and its procedure too. A failure compares its code and its scope; its detail is informative. session, on an answer, says what it announced: announced for a token, which is random, ended for 16 zero bytes; none, nothing. A result that opens a transfer gives its total too; a chunk, its offset, whether it is the last, and its payload; a credit, its end.',
        'report is the next thing the server reports to its application: a protocol code, or exception for an error that carries none.',
        'Before each in, after close, and at the end, nothing more was sent or reported: what a conversation does not expect, a server does not do.',
        'limits, where given, are the server\'s limits; any other is its default. pacing, where given, bounds the queues of its paced subscriptions.',
    ],
    'specVersion': spec_version(),
    'conversations': [
        {'name': name, **({'limits': limits} if limits else {}), **({'pacing': rest[0]} if len(rest) > 1 else {}),
         'steps': rest[-1]}
        for name, limits, *rest in conversations
    ],
}

with open(ROOT + 'conversations.json', 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=False, indent=2)
    file.write('\n')

print(len(conversations), 'conversations')
