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
    return {'send': head + (f' | {payload}' if payload else '')}


def json_request(call_id, procedure, value, **options):
    return request(call_id, procedure, text(value), **options)


def cancel(call_id):
    return {'send': f'A1 16 00 02  {word(call_id, 4)}'}


def raw(data):
    return {'send': data}


def result(call_id, value, credential=None):
    return {'expect': {'kind': RESULT, 'callId': call_id, 'payload': text(value),
                    **({'credential': credential} if credential else {})}}


def failure(call_id, code, scope=PROTOCOL, credential=None, relays=0):
    return {'expect': {'kind': FAILURE, 'callId': call_id, 'failure': {'code': code, 'scope': scope, 'relays': relays},
                    **({'credential': credential} if credential else {})}}


def report(code):
    return {'report': code}


def command(call_id, procedure, value):
    return {'expect': {'kind': REQUEST, 'callId': call_id, 'flags': 0, 'serviceId': SERVICE_ID,
                    'procedureId': PROCEDURES[procedure], 'payload': text(value)}}


def cancelled(call_id):
    return {'expect': {'kind': CANCEL, 'callId': call_id}}


def answer(call_id, value):
    return {'send': f'A1 11 00 02  {word(call_id, 4)} | {text(value)}'}


def armed(milliseconds):
    """A timer armed on the server's clock, due that many milliseconds from now."""
    return {'until': {'timer': milliseconds}}


def advance(milliseconds):
    return {'advance': milliseconds}


def refusal(call_id, code, scope=PROTOCOL):
    return {'send': f'A1 12 00 02  {word(call_id, 4)} | {word(code, 2)} 00 {scope:02X}'}


QUESTION = '"What time is it where you are?"'


def subscribe(call_id, *, paced=False, hold=None, fail=False):
    payload = 'null' if hold is None else ('{"hold":%d,"fail":true}' % hold if fail else '{"hold":%d}' % hold)
    return json_request(call_id, 'ticks', payload, flags=0x30 if paced else 0x10)


def tick(call_id, value, key=None):
    payload = '{"value":%s}' % value if key is None else '{"value":%s,"key":"%s"}' % (value, key)
    return json_request(call_id, 'tick', payload)


def notification(call_id, value):
    return {'expect': {'kind': NOTIFICATION, 'callId': call_id, 'payload': text(value)}}


def credit(call_id, end):
    return {'send': f'A1 15 20 04  {word(call_id, 4)}  {word(end, 8)}'}


QUEUE_OF_TWO = {'maximumQueuedNotifications': 2}

SESSION_REQUIRED = 32
TOKEN_BYTES = '00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F'

# what an answer announces, by the scheme of its CREDENTIAL block: a session's token, or its end
OPENED, ENDED = 'OPAQUE', 'NONE'


def presenting(call_id, procedure, value, block):
    # a request whose CREDENTIAL block, the last, follows its procedure
    words = 3 + len(block.split()) // 4
    return json_request(call_id, procedure, value, flags=0x08, words=words, tail=block)


def login(call_id, name):
    return json_request(call_id, 'login', '{"name":"%s"}' % name)


SMALL = {'maximumEnvelopeBytes': 64, 'chunkBytes': 64, 'windowBytes': 128}

# transfers in chunks of 64 bytes: an opening of a request carries 44 bytes of its payload, one of a
# result 28 — the 20 bytes of an announcement counted — and a chunk 48
CHUNKED = {'chunkBytes': 64, 'windowBytes': 128}
CHUNK, CREDIT = 20, 21
CHUNK_INVALID, CREDIT_EXCEEDED, TRANSFER_STALLED = 48, 49, 51


def json_string(length):
    # a JSON string of `length` bytes, quotes included, which echo answers byte for byte
    return '"' + ''.join(chr(ord('a') + index % 26) for index in range(length - 2)) + '"'


def opening(call_id, procedure, data, total):
    # a request that opens a transfer: TRANSFER, the total on 8 bytes, its first bytes
    return request(call_id, procedure, hexadecimal(data), flags=0x04, words=5, tail=word(total, 8))


def chunk_in(call_id, offset, data, last):
    return {'send': f'A1 14 {0x00 if last else 0x40:02X} 04  {word(call_id, 4)}  {word(offset, 8)} | {hexadecimal(data)}'}


def credit_in(call_id, end):
    return {'send': f'A1 15 00 04  {word(call_id, 4)}  {word(end, 8)}'}


def credited(call_id, end):
    return {'expect': {'kind': CREDIT, 'callId': call_id, 'creditEnd': end}}


def result_opening(call_id, data, total):
    return {'expect': {'kind': RESULT, 'callId': call_id, 'payload': hexadecimal(data), 'total': total}}


def result_opening_in(call_id, data, total):
    # a result the client sends that opens a transfer, as answer to a command: TRANSFER, the total on
    # 8 bytes, its first bytes
    return {'send': f'A1 11 04 04  {word(call_id, 4)}  {word(total, 8)} | {hexadecimal(data)}'}


def chunk_out(call_id, offset, data, last):
    return {'expect': {'kind': CHUNK, 'callId': call_id, 'offset': offset, 'isLast': last, 'payload': hexadecimal(data)}}


ECHOED = json_string(100).encode('utf-8')
LONG = json_string(300).encode('utf-8')

conversations = [
    # 9.2: a request routed, admitted and answered
    ('echo answers with its request\'s payload', ['9.2.8', '9.3'], None, [
        json_request(1, 'echo', '{"a":1}'), result(1, '{"a":1}')]),
    ('fail answers with its own failure, of the application', ['9.5'], None, [
        json_request(3, 'fail', 'null'), failure(3, 7, APPLICATION)]),
    ('a service unknown is answered SERVICE_UNKNOWN', ['9.2.4'], None, [
        json_request(1, 1, '{}', service_id=9), failure(1, SERVICE_UNKNOWN)]),
    ('a procedure unknown, in a service known, is answered PROCEDURE_UNKNOWN', ['9.2.4'], None, [
        json_request(1, 99, '{}'), failure(1, PROCEDURE_UNKNOWN)]),
    ('an admission that refuses is answered with its refusal', ['9.2.5'], None, [
        json_request(1, 'denied', 'null'), failure(1, ACCESS_DENIED)]),
    ('a request with a destination, to a server that relays nothing, is answered DESTINATION_UNKNOWN', ['9.2.3', '14.1'], None, [
        json_request(1, 'echo', 'null', flags=0x02, words=4, tail='00 00 00 05'), failure(1, DESTINATION_UNKNOWN)]),
    ('a request that opens a transfer, to a server that takes none, is answered PAYLOAD_TOO_LARGE', ['9.2.7', '12.2.6'],
     {'maximumTransfers': 0}, [
         json_request(1, 'echo', '"', flags=0x04, words=5, tail='00 00 00 00 00 00 01 00'),
         failure(1, PAYLOAD_TOO_LARGE)]),
    ('a request that opens a subscription to a procedure that notifies nothing is answered, and holds nothing', ['11.2'], None, [
        json_request(1, 'echo', '"x"', flags=0x10), result(1, '"x"'),
        json_request(1, 'echo', '"y"'), result(1, '"y"')]),
    # 9.5: what the resolver fails at
    ('a resolver that throws before it answers is answered PROCEDURE_FAILED, and reported', ['9.5'], None, [
        json_request(1, 'broken', 'null'), failure(1, PROCEDURE_FAILED), report('exception')]),
    ('a payload that is not JSON is answered PAYLOAD_UNDECODABLE', ['9.5'], None, [
        request(1, 'echo', 'FF'), failure(1, PAYLOAD_UNDECODABLE)]),
    ('an admission is asked before the payload is read: one that is not JSON is refused by it, not undecodable', ['9.2.5'], None, [
        request(1, 'denied', 'FF'), failure(1, ACCESS_DENIED),
        request(3, 'whoami', 'FF'), failure(3, SESSION_REQUIRED)]),
    ('an answer too large for one envelope, from a server that sends no transfer, is answered PROCEDURE_FAILED, and reported PAYLOAD_TOO_LARGE', ['12.1'],
     {**SMALL, 'maximumTransfers': 0}, [
         json_request(1, 'bytes', '{"length":60}'), failure(1, PROCEDURE_FAILED), report(PAYLOAD_TOO_LARGE)]),
    # 8 bytes of prefix, 20 of an announcement and 36 of payload fill an envelope of 64; 37 do not
    ('a result is counted with the 20 bytes of an announcement: one that fits only without them is refused as one that does not',
     ['12.1'], {**SMALL, 'maximumTransfers': 0}, [
         json_request(1, 'bytes', '{"length":34}'), result(1, '"' + 'x' * 34 + '"'),
         json_request(3, 'bytes', '{"length":35}'), failure(3, PROCEDURE_FAILED), report(PAYLOAD_TOO_LARGE)]),
    # 9.1: a server opens calls of its own, a command to its client, on its even call ids
    ('the server asks its client a command, and answers with what the client answered', ['9.1'], None, [
        json_request(1, 'ask', 'null'), command(2, 'clock', QUESTION), answer(2, '"noon"'), result(1, '"noon"')]),
    ('a command the client fails fails the call that asked it, which is reported', ['9.1'], None, [
        json_request(1, 'ask', 'null'), command(2, 'clock', QUESTION), refusal(2, 7, APPLICATION),
        failure(1, PROCEDURE_FAILED), report(7)]),
    # 9.6, steps 3 and 5: an answer that does not read ends its call, cancelled; a late one is dropped
    ('an answer to a command that does not read ends the command and cancels it, and a late one is dropped in silence', ['9.6.3', '9.6.5'], None, [
        json_request(1, 'ask', 'null'), command(2, 'clock', QUESTION), raw('A1 11 40 02  00 00 00 02'),
        cancelled(2), failure(1, PROCEDURE_FAILED), report(MALFORMED), answer(2, '"late"')]),
    # 10.3: a command past its time is cancelled and its call id reserved as long as the command was
    # given, 10 s; an answer within is late, and dropped in silence, one after is for no call
    ('a command past its time is cancelled and its call id reserved as long: an answer within is dropped in silence, one after is reported CALL_UNKNOWN',
     ['9.7', '9.9', '10.1', '10.3'], None, [
         json_request(1, 'ask', 'null'), command(2, 'clock', QUESTION), armed(10_000), advance(10_000),
         cancelled(2), failure(1, PROCEDURE_FAILED), report('exception'), answer(2, '"late"'),
         armed(10_000), advance(10_000), answer(2, '"late"'), report(CALL_UNKNOWN)]),
    # 11: subscriptions, one per procedure and connection, on the call id that took it first
    ('a request that opens a subscription to ticks is answered, and each tick notifies it on its call id', ['11.1', '11.2'], None, [
        subscribe(1), result(1, 'null'), tick(3, 1), notification(1, '1'), result(3, 'null')]),
    ('a request to ticks that opens no subscription subscribes nothing', ['11.2'], None, [
        json_request(1, 'ticks', 'null'), result(1, 'null'), tick(3, 1), result(3, 'null')]),
    ('a call id a subscription holds is in use: a request on it is reported, never answered', ['9.2.2', '11.5'], None, [
        subscribe(1), result(1, 'null'), json_request(1, 'echo', '"again"'), report(MALFORMED),
        tick(3, 1), notification(1, '1'), result(3, 'null')]),
    ('a cancel ends a subscription, and nothing more goes on its call id', ['11.7.1'], None, [
        subscribe(1), result(1, 'null'), cancel(1), tick(3, 1), result(3, 'null')]),
    ('a later subscription to the same procedure is answered and holds nothing: the first keeps it', ['11.3'], None, [
        subscribe(1), result(1, 'null'), subscribe(3), result(3, 'null'), tick(5, 1), notification(1, '1'),
        result(5, 'null')]),
    ('a notification may come before the answer of the call it travels on', ['11.4'], None, [
        subscribe(1, hold=1), tick(3, 1), notification(1, '1'), result(1, 'null'), result(3, 'null')]),
    ('a call answered while the first is unanswered waits, and takes the place when the first is cancelled', ['11.3'], None, [
        subscribe(1, hold=1), subscribe(3), result(3, 'null'), cancel(1), tick(5, 1), notification(3, '1'),
        result(5, 'null')]),
    ('a call answered while the first is unanswered waits, and takes the place when the first fails', ['11.3'], None, [
        subscribe(1, hold=1, fail=True), subscribe(3), result(3, 'null'), tick(5, 1), notification(1, '1'),
        failure(1, 7, APPLICATION), result(5, 'null'), tick(7, 2), notification(3, '2'), result(7, 'null')]),
    # 11.8 to 11.10: pacing
    ('a paced subscription is sent a notification per credit, the first credited by its request', ['11.8'], None, [
        subscribe(1, paced=True), result(1, 'null'), tick(3, 1), notification(1, '1'), result(3, 'null'),
        tick(5, 2), result(5, 'null'), credit(1, 2), notification(1, '2')]),
    ('a keyed notification replaces the one of its key waiting, in its place', ['11.9'], None, [
        subscribe(1, paced=True), result(1, 'null'), tick(3, 1), notification(1, '1'), result(3, 'null'),
        tick(5, 2, 'a'), result(5, 'null'), tick(7, 3), result(7, 'null'), tick(9, 4, 'a'), result(9, 'null'),
        credit(1, 3), notification(1, '4'), notification(1, '3')]),
    ('a credit no higher than the last grants nothing', ['11.8'], None, [
        subscribe(1, paced=True), result(1, 'null'), tick(3, 1), notification(1, '1'), result(3, 'null'),
        tick(5, 2), result(5, 'null'), credit(1, 1), credit(1, 2), notification(1, '2')]),
    ('a credit lower than the last takes nothing back: the highest stands', ['11.8'], None, [
        subscribe(1, paced=True), result(1, 'null'), tick(3, 1), notification(1, '1'), result(3, 'null'),
        credit(1, 3), credit(1, 2), tick(5, 2), notification(1, '2'), result(5, 'null'), tick(7, 3),
        notification(1, '3'), result(7, 'null'), tick(9, 4), result(9, 'null')]),
    ('a queue past its bounds ends an answered subscription with a failure on its call id', ['11.10'], None, QUEUE_OF_TWO, [
        subscribe(1, paced=True), result(1, 'null'), tick(3, 1), notification(1, '1'), result(3, 'null'),
        tick(5, 2), result(5, 'null'), tick(7, 3), result(7, 'null'), tick(9, 4), failure(1, CAPACITY_EXCEEDED),
        result(9, 'null'), tick(11, 5), result(11, 'null')]),
    ('a queue past its bounds while its call is unanswered is that call\'s answer', ['11.10'], None, QUEUE_OF_TWO, [
        subscribe(1, paced=True, hold=4), tick(3, 1), notification(1, '1'), result(3, 'null'), tick(5, 2),
        result(5, 'null'), tick(7, 3), result(7, 'null'), tick(9, 4), failure(1, CAPACITY_EXCEEDED),
        result(9, 'null')]),
    # 13: sessions, announced by the next answer after they change, and only by it
    ('a procedure that requires a session refuses a connection without one with SESSION_REQUIRED', ['13.5'], None, [
        json_request(1, 'whoami', 'null'), failure(1, SESSION_REQUIRED)]),
    ('a session opened is announced by the next answer, and only by it', ['13.3'], None, [
        login(1, 'ada'), result(1, '"ada"', OPENED), json_request(3, 'whoami', 'null'), result(3, '"ada"')]),
    ('a session ended is announced by the next answer, and only by it', ['13.3', '13.5'], None, [
        login(1, 'ada'), result(1, '"ada"', OPENED), json_request(3, 'logout', 'null'),
        result(3, 'null', ENDED), json_request(5, 'whoami', 'null'), failure(5, SESSION_REQUIRED)]),
    ('a session opened again is announced again, its token drawn anew', ['13.2', '13.3'], None, [
        login(1, 'ada'), result(1, '"ada"', OPENED), login(3, 'bob'), result(3, '"bob"', OPENED)]),
    ('a session that ends ends its connection\'s subscriptions, the first answer to go out announcing it', ['13.6'], None, [
        login(1, 'ada'), result(1, '"ada"', OPENED), subscribe(3), result(3, 'null'),
        json_request(5, 'logout', 'null'), failure(3, SESSION_REQUIRED, credential=ENDED), result(5, 'null'),
        tick(7, 1), result(7, 'null')]),
    ('a request presenting a credential is read, and its credential ignored, whatever its scheme', ['13.4'], None, [
        presenting(1, 'echo', '"x"', f'00 01 00 10  {TOKEN_BYTES}'), result(1, '"x"'),
        presenting(3, 'echo', '"y"', '00 02 00 05  61 2E 62 2E 63  00 00 00'), result(3, '"y"'),
        presenting(5, 'echo', '"z"', '00 03 00 00'), result(5, '"z"'),
        presenting(7, 'echo', '"w"', '00 07 00 02  01 02  00 00'), result(7, '"w"')]),
    # 9.2, steps 1 and 2: what would answer another call
    ('a request on the server\'s own parity is reported, never answered', ['9.2.1'], None, [
        json_request(2, 'echo', 'null'), report(MALFORMED)]),
    ('a request on a call id still open is reported, never answered', ['9.2.2'], None, [
        json_request(1, 'slow', SLOW), json_request(1, 'echo', '"again"'), report(MALFORMED),
        cancel(1), json_request(3, 'cancellations', 'null'), result(3, '1')]),
    # 9.4 and 10: the cancel, and the answer that goes out only while its call is open
    ('a cancel ends its call, and the answer its resolver gives after goes nowhere', ['9.4', '10.2'], None, [
        json_request(1, 'slow', SLOW), cancel(1), json_request(3, 'cancellations', 'null'), result(3, '1')]),
    ('a call id cancelled is opened again, and the first call\'s answer does not answer the second', ['9.4'], None, [
        json_request(1, 'slow', SLOW), cancel(1), json_request(1, 'echo', '"again"'), result(1, '"again"'),
        json_request(3, 'cancellations', 'null'), result(3, '1')]),
    ('a connection that closes ends its calls, and their answers go nowhere', ['9.10'], None, [
        json_request(1, 'slow', SLOW), {'close': True}]),
    ('a cancel on the server\'s own parity is reported', ['10.2'], None, [cancel(2), report(MALFORMED)]),
    ('a cancel for no call crossed its answer, and is dropped in silence', ['10.2'], None, [cancel(5)]),
    # 9.6: the gate
    ('a message shorter than a prefix is reported', ['2.2', '9.6.1'], None, [raw('A1 10 00'), report(MALFORMED)]),
    ('a first byte no layout is, is reported', ['9.6.1'], None, [
        raw('0A 10 00 03  00 00 00 03  00 01 00 01'), report(MALFORMED)]),
    ('a request of a layout to come is answered LAYOUT_UNSUPPORTED, on its call id', ['9.6.2'], None, [
        raw('A2 10 00 03  00 00 00 07  00 01 00 01'), failure(7, LAYOUT_UNSUPPORTED)]),
    ('a request of a layout to come, on the server\'s own parity, is reported', ['9.6.6'], None, [
        raw('A2 10 00 03  00 00 00 08  00 01 00 01'), report(LAYOUT_UNSUPPORTED)]),
    ('a malformed request is answered ENVELOPE_MALFORMED, on its call id', ['9.6.2'], None, [
        raw('A1 10 01 03  00 00 00 09  00 01 00 01'), failure(9, MALFORMED)]),
    ('a malformed request on a call id still open is reported, never answered', ['9.6.6'], None, [
        json_request(1, 'slow', SLOW), raw('A1 10 01 03  00 00 00 01  00 01 00 01'), report(MALFORMED),
        cancel(1)]),
    ('a request past the envelope\'s bound is answered ENVELOPE_TOO_LARGE, on its call id', ['9.6.2'], SMALL, [
        json_request(1, 'echo', '"' + 'x' * 60 + '"'), failure(1, TOO_LARGE)]),
    ('a kind to come is reported KIND_UNSUPPORTED', ['3.3', '9.6.6'], None, [raw('A1 17 00 02  00 00 00 05'), report(KIND_UNSUPPORTED)]),
    ('an advisory kind is skipped', ['3.4'], None, [raw('A1 80 00 02  00 00 00 03')]),
    ('a result for no call is reported CALL_UNKNOWN', ['9.7'], None, [raw('A1 11 00 02  00 00 00 04'), report(CALL_UNKNOWN)]),
    ('a failure for no call is reported CALL_UNKNOWN', ['9.7'], None, [
        raw('A1 12 00 02  00 00 00 06 | 00 13 00 00'), report(CALL_UNKNOWN)]),
    ('a notification is reported KIND_UNSUPPORTED by a server, which takes none', ['9.8'], None, [
        raw('A1 13 00 02  00 00 00 03'), report(KIND_UNSUPPORTED)]),
    ('a chunk for no call is reported CALL_UNKNOWN', ['12.9.4'], None, [
        raw('A1 14 00 04  00 00 00 03  00 00 00 00 00 00 00 00 | 01'), report(CALL_UNKNOWN)]),
    ('a chunk on a call open without a transfer is reported ENVELOPE_MALFORMED', ['12.9.4'], None, [
        json_request(1, 'slow', SLOW), raw('A1 14 00 04  00 00 00 01  00 00 00 00 00 00 00 00 | 01'),
        report(MALFORMED), cancel(1)]),
    # 9.8: the credits that find nothing
    ('a credit of notifications, for no subscription, is dropped in silence by a server, which sends them', ['9.8'], None, [
        raw('A1 15 20 04  00 00 00 03  00 00 00 00 00 00 00 01')]),
    ('a credit of bytes, for no transfer, is dropped in silence', ['9.8'], None, [
        raw('A1 15 00 04  00 00 00 03  00 00 00 00 00 00 00 10')]),
    # 12: transfers
    ('a request that comes as a transfer is credited to its total, then answered by a transfer its client credits', ['12.3', '12.4', '12.5'], CHUNKED, [
        opening(1, 'echo', ECHOED[:44], 100), credited(1, 100),
        chunk_in(1, 44, ECHOED[44:92], False), chunk_in(1, 92, ECHOED[92:], True),
        result_opening(1, ECHOED[:28], 100),
        credit_in(1, 100), chunk_out(1, 28, ECHOED[28:76], False), chunk_out(1, 76, ECHOED[76:], True)]),
    ('a transfer is credited a window past the bytes received from the start, once half a window can go', ['12.4'], CHUNKED, [
        opening(1, 'echo', LONG[:44], 300), credited(1, 172),
        chunk_in(1, 44, LONG[44:92], False), chunk_in(1, 92, LONG[92:140], False), credited(1, 268),
        chunk_in(1, 188, LONG[188:236], False), chunk_in(1, 140, LONG[140:188], False), credited(1, 300),
        cancel(1)]),
    ('a result is sent as far as its credit, a full chunk at a time, and a credit lower than the last grants nothing', ['12.4', '12.5'], CHUNKED, [
        json_request(1, 'echo', ECHOED.decode('utf-8')), result_opening(1, ECHOED[:28], 100),
        credit_in(1, 75), credit_in(1, 76), chunk_out(1, 28, ECHOED[28:76], False),
        credit_in(1, 60), credit_in(1, 100), chunk_out(1, 76, ECHOED[76:], True)]),
    ('a chunk past its credit is answered CREDIT_EXCEEDED, and a late one under it is dropped in silence', ['12.6.2', '12.9.4'], CHUNKED, [
        opening(1, 'echo', LONG[:44], 300), credited(1, 172),
        chunk_in(1, 172, LONG[172:220], False), failure(1, CREDIT_EXCEEDED),
        chunk_in(1, 44, LONG[44:92], False),
        chunk_in(1, 172, LONG[172:220], False), report(CREDIT_EXCEEDED)]),
    ('a chunk before the last that is not full is answered CHUNK_INVALID', ['12.6.1'], CHUNKED, [
        opening(1, 'echo', LONG[:44], 300), credited(1, 172),
        chunk_in(1, 44, LONG[44:60], False), failure(1, CHUNK_INVALID)]),
    ('a chunk that says more follow though it reaches the total is answered CHUNK_INVALID', ['12.6.1'], CHUNKED, [
        opening(1, 'echo', ECHOED[:44], 100), credited(1, 100),
        chunk_in(1, 44, ECHOED[44:92], False), chunk_in(1, 92, ECHOED[92:], False), failure(1, CHUNK_INVALID)]),
    ('a chunk over bytes received in part is answered CHUNK_INVALID, and one received whole is dropped in silence', ['12.6.3', '12.6.4'], CHUNKED, [
        opening(1, 'echo', LONG[:44], 300), credited(1, 172),
        chunk_in(1, 44, LONG[44:92], False), chunk_in(1, 44, LONG[44:92], False),
        chunk_in(1, 68, LONG[68:116], False), failure(1, CHUNK_INVALID)]),
    ('a chunk that does not read ends its transfer as CHUNK_INVALID', ['9.6.4'], CHUNKED, [
        opening(1, 'echo', LONG[:44], 300), credited(1, 172),
        raw('A1 14 40 04  00 00 00 01  00 20 00 00 00 00 00 00 | 01'), failure(1, CHUNK_INVALID)]),
    ('an opening that holds its whole total is answered CHUNK_INVALID', ['12.3.3'], CHUNKED, [
        opening(1, 'echo', b'"ab"', 4), failure(1, CHUNK_INVALID)]),
    ('an opening that declares a total of 0 is answered PAYLOAD_TOO_LARGE', ['12.3.3'], CHUNKED, [
        opening(1, 'echo', b'', 0), failure(1, PAYLOAD_TOO_LARGE)]),
    ('a transfer past those a connection receives at once is answered CAPACITY_EXCEEDED', ['12.3.3'], {**CHUNKED, 'maximumTransfers': 1}, [
        opening(1, 'echo', LONG[:44], 300), credited(1, 172),
        opening(3, 'echo', LONG[:44], 300), failure(3, CAPACITY_EXCEEDED), cancel(1)]),
    ('an opening past the budget left is answered CAPACITY_EXCEEDED, and a transfer it starves is credited once it frees', ['12.3.3', '12.4'], {
        **CHUNKED, 'bufferedBytesBudget': 256, 'maximumPayloadBytes': 256}, [
        opening(1, 'echo', LONG[:44], 200), credited(1, 172),
        opening(3, 'echo', LONG[:44], 200),
        opening(5, 'echo', LONG[:44], 200), failure(5, CAPACITY_EXCEEDED),
        cancel(1), credited(3, 172)]),
    ('a cancel ends the transfer of a result, and a credit after it is dropped in silence', ['12.7', '12.9.5'], CHUNKED, [
        json_request(1, 'echo', ECHOED.decode('utf-8')), result_opening(1, ECHOED[:28], 100),
        cancel(1), credit_in(1, 100)]),
    # 12.7 to 12.9: a transfer's inactivity, on the server's clock. A restart shows by an advance past
    # the first due and short of the second, then a send, before which nothing more went. The first
    # keeps the 30 s by default; the others set their own, apart from every other timer they arm
    ('a request whose transfer goes silent is answered TRANSFER_STALLED, each chunk placed setting it going again, its call then held abandoned as long',
     ['12.2.8', '12.7', '12.8', '12.9', '12.9.4'], CHUNKED, [
         opening(1, 'echo', LONG[:44], 300), credited(1, 172),
         armed(30_000), advance(20_000), chunk_in(1, 44, LONG[44:92], False),
         armed(30_000), advance(10_000), json_request(3, 'echo', '"y"'), result(3, '"y"'),
         armed(20_000), advance(20_000), failure(1, TRANSFER_STALLED),
         chunk_in(1, 92, LONG[92:140], False),
         armed(30_000), advance(30_000), chunk_in(1, 92, LONG[92:140], False), report(CALL_UNKNOWN)]),
    # the command ask gives 10 s, which the transfer's 20 s takes over from
    ('a command whose result comes as a transfer waits on the transfer\'s inactivity, not its own time; gone silent it ends as timed out, its call id reserved as long',
     ['9.9', '10.3', '12.7', '12.8', '12.9', '12.9.1', '12.9.4'], {**CHUNKED, 'transferInactivityTimeout': 20_000}, [
         json_request(1, 'ask', 'null'), command(2, 'clock', QUESTION),
         result_opening_in(2, LONG[:28], 300), credited(2, 156),
         armed(20_000), advance(10_000), chunk_in(2, 28, LONG[28:76], False),
         armed(20_000), advance(20_000), cancelled(2), failure(1, PROCEDURE_FAILED), report('exception'),
         chunk_in(2, 76, LONG[76:124], False), answer(2, '"late"'),
         armed(20_000), advance(20_000), chunk_in(2, 76, LONG[76:124], False), report(CALL_UNKNOWN)]),
    ('a result that gets no credit is ended TRANSFER_STALLED, a credit that grants setting it going again, one that grants nothing not',
     ['12.7', '12.8'], {**CHUNKED, 'transferInactivityTimeout': 15_000}, [
         json_request(1, 'echo', ECHOED.decode('utf-8')), result_opening(1, ECHOED[:28], 100),
         armed(15_000), advance(5_000), credit_in(1, 76), chunk_out(1, 28, ECHOED[28:76], False),
         armed(15_000), advance(12_000), credit_in(1, 60),
         armed(3_000), advance(3_000), failure(1, TRANSFER_STALLED), report(TRANSFER_STALLED)]),
]

# 14: relays, across a conversation's connections: a client, and a device the server relays to, which
# registers its own connection as a destination on the wire
DESTINATION_UNREACHABLE, SUBSCRIPTION_UNSUPPORTED, DESTINATION_LOST = 17, 22, 65
DEVICE = 12


def on(step, connection):
    return {**step, 'on': connection}


def opened(connection, two_way=True):
    return {'open': connection, **({} if two_way else {'twoWay': False})}


def closed(connection):
    return {'close': True, 'on': connection}


def relayed(call_id, procedure, value, destination=DEVICE, flags=0x02):
    # a request that names a destination: its 4 bytes after the procedure
    return json_request(call_id, procedure, value, flags=flags, words=4, tail=word(destination, 4))


def registered(call_id=1, destination=DEVICE):
    return [on(json_request(call_id, 'register', '{"destination":%d}' % destination), 'device'),
            on(result(call_id, str(destination)), 'device')]


def logged_in(call_id=1):
    return [on(login(call_id, 'ada'), 'client'), on(result(call_id, '"ada"', OPENED), 'client')]


def leg_b(call_id, procedure, value):
    return on(command(call_id, procedure, value), 'device')


conversations += [
    ('a destination registered on the wire takes a request relayed, and its result crosses back',
     ['14.1', '14.2', '14.5.1'], None, [
         opened('client'), opened('device'), *logged_in(), *registered(),
         on(relayed(3, 'echo', '"x"'), 'client'), leg_b(2, 'echo', '"x"'),
         on(answer(2, '"x"'), 'device'), on(result(3, '"x"'), 'client')]),
    ('a failure of the destination\'s crosses one relay more', ['14.5.2', '14.6'], None, [
        opened('client'), opened('device'), *logged_in(), *registered(),
        on(relayed(3, 'fail', 'null'), 'client'), leg_b(2, 'fail', 'null'),
        on(refusal(2, 7, APPLICATION), 'device'), on(failure(3, 7, APPLICATION, relays=1), 'client')]),
    ('a failure that crossed 255 relays crosses at 255', ['7.5', '14.6'], None, [
        opened('client'), opened('device'), *logged_in(), *registered(),
        on(relayed(3, 'fail', 'null'), 'client'), leg_b(2, 'fail', 'null'),
        on({'send': 'A1 12 00 02  00 00 00 02 | 00 07 FF 01'}, 'device'),
        on(failure(3, 7, APPLICATION, relays=255), 'client')]),
    ('a relay asks for a session by default, and its own failure crosses no relay', ['14.3.1', '14.6'], None, [
        opened('client'), opened('device'), *registered(),
        on(relayed(1, 'echo', '"x"'), 'client'), on(failure(1, SESSION_REQUIRED), 'client')]),
    ('a destination not registered, to a requester admitted, is answered DESTINATION_UNKNOWN', ['14.3.2'], None, [
        opened('client'), opened('device'), *logged_in(), *registered(),
        on(relayed(3, 'echo', '"x"', destination=99), 'client'), on(failure(3, DESTINATION_UNKNOWN), 'client')]),
    ('a request that opens a subscription through a relay is answered SUBSCRIPTION_UNSUPPORTED', ['14.3.3'], None, [
        opened('client'), opened('device'), *logged_in(), *registered(),
        on(relayed(3, 'ticks', 'null', flags=0x12), 'client'), on(failure(3, SUBSCRIPTION_UNSUPPORTED), 'client')]),
    ('a destination whose connection carries nothing back is answered DESTINATION_UNREACHABLE', ['14.3.4'], None, [
        opened('client'), opened('device', two_way=False), *logged_in(), *registered(),
        on(relayed(3, 'echo', '"x"'), 'client'), on(failure(3, DESTINATION_UNREACHABLE), 'client')]),
    ('a destination dies with its connection, whoever opens it next, until it is registered anew',
     ['14.3.4', '14.4'], None, [
         opened('client'), opened('device'), *logged_in(), *registered(), closed('device'),
         on(relayed(3, 'echo', '"x"'), 'client'), on(failure(3, DESTINATION_UNREACHABLE), 'client'),
         opened('device'), on(relayed(5, 'echo', '"y"'), 'client'), on(failure(5, DESTINATION_UNREACHABLE), 'client'),
         on(json_request(1, 'register', '{"destination":%d}' % DEVICE), 'device'), on(failure(1, 8, APPLICATION), 'device'),
         on(json_request(3, 'unregister', 'null'), 'device'), on(result(3, 'true'), 'device'),
         *registered(5), on(relayed(7, 'echo', '"z"'), 'client'), leg_b(2, 'echo', '"z"'),
         on(answer(2, '"z"'), 'device'), on(result(7, '"z"'), 'client')]),
    ('a destination taken out is answered DESTINATION_UNKNOWN', ['14.1'], None, [
        opened('client'), opened('device'), *logged_in(), *registered(),
        on(json_request(3, 'unregister', 'null'), 'device'), on(result(3, 'true'), 'device'),
        on(relayed(3, 'echo', '"x"'), 'client'), on(failure(3, DESTINATION_UNKNOWN), 'client')]),
    ('a cancel on leg A cancels leg B, and leg A is answered nothing', ['14.4', '14.5.6'], None, [
        opened('client'), opened('device'), *logged_in(), *registered(),
        on(relayed(3, 'echo', '"x"'), 'client'), leg_b(2, 'echo', '"x"'),
        on(cancel(3), 'client'), on(cancelled(2), 'device'), on(answer(2, '"late"'), 'device')]),
    ('leg A\'s connection gone cancels leg B', ['14.4'], None, [
        opened('client'), opened('device'), *logged_in(), *registered(),
        on(relayed(3, 'echo', '"x"'), 'client'), leg_b(2, 'echo', '"x"'),
        closed('client'), on(cancelled(2), 'device')]),
    ('leg B\'s connection gone once it had the request is answered DESTINATION_LOST, and reported with leg A\'s connection',
     ['14.5.5', '14.6'], None, [
         opened('client'), opened('device'), *logged_in(), *registered(),
         on(relayed(3, 'echo', '"x"'), 'client'), leg_b(2, 'echo', '"x"'),
         closed('device'), on(failure(3, DESTINATION_LOST), 'client'), on(report('exception'), 'client')]),
    ('leg B past its destination\'s timeout is cancelled, and leg A answered DESTINATION_LOST', ['14.4', '14.5.5'], None, [
        opened('client'), opened('device'), *logged_in(),
        on(json_request(1, 'register', '{"destination":%d,"timeout":2000}' % DEVICE), 'device'),
        on(result(1, str(DEVICE)), 'device'),
        on(relayed(3, 'echo', '"x"'), 'client'), leg_b(2, 'echo', '"x"'),
        armed(2_000), advance(2_000),
        on(cancelled(2), 'device'), on(failure(3, DESTINATION_LOST), 'client'), on(report('exception'), 'client')]),
]

document = {
    '$schema': 'schemas/conversations.schema.json',
    '$comment': [
        "Bead's conversations: what a server of the interop service (interop-service.json) does with what its clients send, played by every implementation's tests against its own server.",
        'A step is what the test does, or what the server under test does next. send is what the client sends, in hexadecimal as vectors.json writes it; close closes the client\'s connection.',
        'expect is the next envelope the server sends: its kind, its call id, and its payload or its failure; a request, its flags, its service and its procedure too. A failure compares its code, its scope and the relays it crossed; its detail is informative. credential, on an answer, is the scheme of the CREDENTIAL block it carried, what it announced: OPAQUE for a session\'s token, which is random, NONE for its end; none, it carried no block. A result that opens a transfer gives its total too; a chunk, its offset, whether it is the last, and its payload; a credit, its end.',
        'report is the next thing the server reports to its application: a protocol code, or exception for an error that carries none.',
        'A step may move time, on the clock the server is given (decision 0011): until timer waits, on the real clock and within a patience, for a timer armed on it, due exactly that many milliseconds from now; advance steps it that many milliseconds from due to due, as spec/clocks.json states and holds the test clocks of both sides to, and follows an until timer since the last send, expect or advance; wall moves the wall clock alone, forward or back. wallClock is where the wall clock starts.',
        'A conversation that opens its connections, open, plays them all at once: every other step names its connection, on, but a step that moves time, which is the server\'s, and each connection has its own expectations; one that opens none plays one connection, opened before its first step. twoWay false beside open declares a connection that carries nothing back, as an HTTP client that does not listen. A connection closed and opened again is a new connection under the same name.',
        'Before each send, after close, and at the end, nothing more was sent or reported: what a conversation does not expect, a server does not do.',
        'limits, where given, are the server\'s limits, by the names section 12.2 gives them, in milliseconds for a time; any other is its default. pacing, where given, bounds the queues of its paced subscriptions.',
        'clauses are the units of spec.md an entry checks: a clause, 9.2; an item of its numbered list, 9.2.5; a row of its table, counted from 1, 15.6.8.',
    ],
    'specVersion': spec_version(),
    'wallClock': '2026-01-01T00:00:00Z',
    'conversations': [
        {'name': name, 'clauses': clauses, **({'limits': limits} if limits else {}),
         **({'pacing': rest[0]} if len(rest) > 1 else {}), 'steps': rest[-1]}
        for name, clauses, limits, *rest in conversations
    ],
}

with open(ROOT + 'conversations.json', 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=False, indent=2)
    file.write('\n')

print(len(conversations), 'conversations')
