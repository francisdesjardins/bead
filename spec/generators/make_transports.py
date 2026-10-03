"""Writes spec/transports.json: what a transport's server does at its edge, over HTTP, with what a
peer of the test's own sends it in exact octets."""
import json
import os

from spec_version import spec_version

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')
SERVICE = json.load(open(ROOT + 'interop-service.json', encoding='utf8'))
SERVICE_ID = SERVICE['serviceId']
PROCEDURES = {procedure['procedureName']: procedure['procedureId'] for procedure in SERVICE['procedures']}

MAXIMUM_ENVELOPE_BYTES = 16_778_240
REQUEST, RESULT, FAILURE, NOTIFICATION = 16, 17, 18, 19
PROTOCOL = 0
SUBSCRIPTION_UNSUPPORTED, PAYLOAD_TOO_LARGE, PROCEDURE_FAILED = 22, 34, 64

BEAD = 'application/prs.bead'
BATCH = 'application/prs.bead-batch'
SLOW = '{"milliseconds":3600000}'


def hexadecimal(data):
    return ' '.join(f'{byte:02X}' for byte in data)


def word(value, length):
    return hexadecimal(value.to_bytes(length, 'big'))


def text(value):
    return hexadecimal(value.encode('utf-8'))


def length_of(data):
    return len(data.replace('|', ' ').split())


# ── Envelopes ───────────────────────────────────────────────────────────────────────────────────


def request(call_id, procedure, value, *, flags=0, words=3, tail=''):
    head = f'A1 10 {flags:02X} {words:02X}  {word(call_id, 4)}  {word(SERVICE_ID, 2)} {word(PROCEDURES[procedure], 2)}'
    head += f'  {tail}' if tail else ''
    return head + (f' | {text(value)}' if value else '')


def cancel(call_id):
    return f'A1 16 00 02  {word(call_id, 4)}'


def result(call_id, value):
    return {'kind': RESULT, 'callId': call_id, 'payload': text(value)}


def failure(call_id, code, scope=PROTOCOL):
    return {'kind': FAILURE, 'callId': call_id, 'failure': {'code': code, 'scope': scope, 'relays': 0}}


def notification(call_id, value):
    return {'kind': NOTIFICATION, 'callId': call_id, 'payload': text(value)}


# ── Exchanges ───────────────────────────────────────────────────────────────────────────────────


def send(on, method, target='/bead', *, fields=None, body=None, host='{host}'):
    """A request of HTTP/1.1, rendered to its octets: its line, its fields in their order — its host,
    those given, its body's length when it has one or posts — and a socket closed once answered."""
    lines = [f'{method} {target} HTTP/1.1', f'host: {host}']
    lines += [f'{name}: {value}' for name, value in (fields or {}).items()]

    if body is not None or method in ('POST', 'DELETE'):
        lines.append(f'content-length: {length_of(body or "")}')

    lines.append('connection: close')
    return {'send': {'head': '\r\n'.join(lines) + '\r\n\r\n', **({'body': body} if body else {})}, 'on': on}


def connect(on='connect', *, listen=False, fields=None, host='{host}', body=None):
    # a POST of Bead's type with no token, which draws a connection when it has no body
    return send(on, 'POST', fields={'content-type': BEAD, **({'bead-listen': '?1'} if listen else {}), **(fields or {})},
                host=host, body=body)


def post(on, body, *, fields=None):
    return send(on, 'POST', fields={'bead-connection-token': '{token}', 'content-type': BEAD, **(fields or {})}, body=body)


def listen(on, after, wait):
    return send(on, 'GET', f'/bead?after={after}&wait={wait}', fields={'bead-connection-token': '{token}'})


def expect(on, status, *, fields=None, **body):
    return {'expect': {'status': status, **({'fields': fields} if fields else {}), **body}, 'on': on}


def refused(on, status, refusal, fields=None):
    return expect(on, status, fields={'bead-refusal': refusal, **(fields or {})}, body='')


def drawn(on='connect', *, listening=False):
    """A connection drawn, its token captured."""
    return [connect(on, listen=listening), expect(on, 201, fields={
        'bead-connection-token': {'capture': 'token', 'shape': 'token'},
        'bead-listen': '?1' if listening else None})]


def until(gauge, value):
    return {'until': {'gauge': gauge, 'is': value}}


def armed(milliseconds):
    """A timer armed on the server's clock, due that many milliseconds from now."""
    return {'until': {'timer': milliseconds}}


def advance(milliseconds):
    return {'advance': milliseconds}


def answered(on, envelope):
    return expect(on, 200, fields={'content-type': BEAD}, envelope=envelope)


ECHO = request(1, 'echo', '"x"')
SUBSCRIBE = request(1, 'ticks', 'null', flags=0x10)


def tick(call_id, value):
    return request(call_id, 'tick', '{"value":%d}' % value)


cases = [
    # 15.4 and 15.6: a connection drawn, and what every response carries
    ('a connect is answered 201, its token drawn, the response neither stored nor sniffed',
     ['15.4', '15.6', '15.6.2'], None, [
         connect(), expect('connect', 201, fields={
             'bead-connection-token': {'shape': 'token'}, 'cache-control': 'no-store',
             'x-content-type-options': 'nosniff', 'bead-listen': None}, body='')]),
    ('a connect that says it listens is told back that it does', ['15.8', '15.6.2'], None, [
        connect(listen=True), expect('connect', 201, fields={'bead-listen': '?1'})]),
    # 15.5: one envelope a POST
    ('a request is answered in the body of a 200', ['15.5.1', '15.6.1'], None, [
        *drawn(), post('echo', ECHO), answered('echo', result(1, '"x"'))]),
    ('an envelope other than a request ends 204 at once, handed on', ['15.5.2', '15.6.3'], None, [
        *drawn(), post('cancel', cancel(5)), expect('cancel', 204, body='')]),
    ('a request on the server\'s own parity is refused 400, marked', ['15.5.3', '15.6.4'], None, [
        *drawn(), post('even', request(2, 'echo', '"x"')), refused('even', 400, 'malformed')]),
    ('a request on a call id already waiting is refused 409, marked', ['15.5.3', '15.6.8'], None, [
        *drawn(), post('slow', request(1, 'slow', SLOW)), expect('slow', 200),
        post('again', ECHO), refused('again', 409, 'call-waiting')]),
    ('a cancel that comes before its request buries its call id, and the request ends 204, never handed on',
     ['15.5'], None, [
         *drawn(), post('cancel', cancel(1)), expect('cancel', 204, body=''), until('buriedCallIds', 1),
         post('buried', ECHO), expect('buried', 204, body=''),
         post('echo', request(3, 'echo', '"y"')), answered('echo', result(3, '"y"'))]),
    ('a call id stays buried 5 seconds, after which a request on it is handed on', ['15.5'], None, [
        *drawn(), post('cancel', cancel(1)), expect('cancel', 204, body=''), until('buriedCallIds', 1),
        armed(5000), advance(5000), until('buriedCallIds', 0),
        post('echo', ECHO), answered('echo', result(1, '"x"'))]),
    ('HTTP carries no transfer: a request that opens one is answered PAYLOAD_TOO_LARGE', ['15.11'], None, [
        *drawn(), post('opening', request(1, 'echo', '"', flags=0x04, words=5, tail=word(256, 8))),
        answered('opening', failure(1, PAYLOAD_TOO_LARGE))]),
    # 15.6: the transport's own refusals, marked, with empty bodies
    ('a connect with a body is refused 400, marked', ['15.6.4'], None, [
        connect(body='A1'), refused('connect', 400, 'malformed')]),
    ('an exchange with no token, or one that is none, is refused 400, marked', ['15.6.4'], None, [
        send('none', 'POST', fields={'content-type': BEAD}, body=ECHO), refused('none', 400, 'malformed'),
        send('bad', 'POST', fields={'bead-connection-token': 'x', 'content-type': BEAD}, body=ECHO),
        refused('bad', 400, 'malformed')]),
    ('an exchange of a connection the server does not hold is refused 404, connection-unknown', ['15.6.6'], None, [
        send('gone', 'POST', fields={'bead-connection-token': 'AAAAAAAAAAAAAAAAAAAAAA', 'content-type': BEAD},
             body=ECHO), refused('gone', 404, 'connection-unknown')]),
    ('a path the server does not serve is refused 404, path-unknown', ['15.6.6'], None, [
        send('elsewhere', 'POST', '/elsewhere'), refused('elsewhere', 404, 'path-unknown')]),
    ('a method the server does not take is refused 405, its Allow naming those it does', ['15.6.7'], None, [
        send('put', 'PUT', body='A1'), refused('put', 405, 'method-refused', {'allow': 'GET, POST, DELETE'})]),
    ('a body of another type, or encoded, is refused 415, marked', ['15.6.10'], None, [
        *drawn(),
        send('plain', 'POST', fields={'bead-connection-token': '{token}', 'content-type': 'text/plain'}, body=ECHO),
        refused('plain', 415, 'type-refused'),
        post('encoded', ECHO, fields={'content-encoding': 'gzip'}), refused('encoded', 415, 'type-refused')]),
    ('a body past its bound is refused 413, marked', ['15.6.9', '15.12.5'], {'maximumBodyBytes': 64}, [
        *drawn(), post('large', request(1, 'echo', '"' + 'x' * 60 + '"')), refused('large', 413, 'too-large')]),
    ('a host the server does not take is refused 403, marked', ['15.6.5', '15.12'], {'hosts': ['bead.test']}, [
        connect(host='elsewhere.test'), refused('connect', 403, 'host-refused'),
        connect('taken', host='bead.test'), expect('taken', 201)]),
    ('an exchange from an origin the server does not take is refused 403, marked', ['15.6.5', '15.12'], None, [
        connect(fields={'origin': 'https://elsewhere.test'}), refused('connect', 403, 'origin-refused')]),
    ('an exchange from an origin the server takes is served', ['15.12'], {'origins': ['https://bead.test']}, [
        connect(fields={'origin': 'https://bead.test'}), expect('connect', 201)]),
    # 15.12: the bounds, past which the server answers 429 or 503
    ('past the connections a server holds, a connect is refused 503, with Retry-After',
     ['15.6.12', '15.12.1'], {'maximumConnections': 1}, [
         *drawn('first'), connect('second'),
         refused('second', 503, 'busy', {'retry-after': {'shape': 'delay-seconds'}})]),
    ('past the connections one address holds, behind a proxy trusted, a connect is refused 503',
     ['15.6.12', '15.12', '15.12.2'], {'maximumConnectionsPerAddress': 1, 'isProxyTrusted': True}, [
         connect('first', fields={'x-forwarded-for': '192.0.2.1'}), expect('first', 201),
         connect('second', fields={'x-forwarded-for': '198.51.100.7, 192.0.2.1'}),
         refused('second', 503, 'busy', {'retry-after': {'shape': 'delay-seconds'}}),
         connect('other', fields={'x-forwarded-for': '192.0.2.2'}), expect('other', 201)]),
    ('past the requests waiting on one connection, a request is refused 429, marked',
     ['15.6.11', '15.12.3'], {'maximumWaitingExchanges': 1}, [
         *drawn(), post('slow', request(1, 'slow', SLOW)), expect('slow', 200),
         post('more', request(3, 'slow', SLOW)), refused('more', 429, 'busy')]),
    ('a DELETE ends its connection, and an exchange after it is refused 404', ['15.4', '15.6.3', '15.6.6'], None, [
        *drawn(), send('delete', 'DELETE', fields={'bead-connection-token': '{token}'}), expect('delete', 204, body=''),
        post('after', ECHO), refused('after', 404, 'connection-unknown')]),
    # 15.8 and 15.9: what the server sends of its own, to a client that listens
    ('what the server sends of its own waits, numbered, for a listen, which brings it back in a batch',
     ['15.8', '15.9', '15.6.1'], None, [
         *drawn(listening=True), post('subscribe', SUBSCRIBE), answered('subscribe', result(1, 'null')),
         post('tick', tick(3, 1)), answered('tick', result(3, 'null')),
         listen('listen', 0, 0),
         expect('listen', 200, fields={'content-type': BATCH, 'bead-sequence': '1'},
                batch=[notification(1, '1')])]),
    ('a listen holds until something comes, and a second listen takes the first one\'s place',
     ['15.9', '15.6.3'], None, [
         *drawn(listening=True), post('subscribe', SUBSCRIBE), answered('subscribe', result(1, 'null')),
         listen('first', 0, 60000), until('listens', 1),
         listen('second', 0, 60000), expect('first', 204, body=''),
         post('tick', tick(3, 1)), answered('tick', result(3, 'null')),
         expect('second', 200, fields={'bead-sequence': '1'}, batch=[notification(1, '1')])]),
    ('a listen acknowledges what came up to after, and brings back what is left', ['15.9'], None, [
        *drawn(listening=True), post('subscribe', SUBSCRIBE), answered('subscribe', result(1, 'null')),
        post('one', tick(3, 1)), answered('one', result(3, 'null')),
        post('two', tick(5, 2)), answered('two', result(5, 'null')),
        listen('all', 0, 0), expect('all', 200, fields={'bead-sequence': '1'},
                                    batch=[notification(1, '1'), notification(1, '2')]),
        listen('left', 1, 0), expect('left', 200, fields={'bead-sequence': '2'}, batch=[notification(1, '2')]),
        listen('none', 2, 0), expect('none', 204, body='')]),
    ('a listen of a client that did not say it listens is refused 409, marked', ['15.6.8', '15.8'], None, [
        *drawn(), listen('listen', 0, 0), refused('listen', 409, 'listen-undeclared')]),
    ('a listen whose count is none, or past what was sent, is refused 400, marked', ['15.6.4', '15.9'], None, [
        *drawn(listening=True),
        send('none', 'GET', '/bead?after=x&wait=0', fields={'bead-connection-token': '{token}'}),
        refused('none', 400, 'malformed'), listen('past', 5, 0), refused('past', 400, 'malformed')]),
    ('an outbox past its bound closes its connection, and cuts the exchange whose request it was handed',
     ['15.7', '15.9', '15.12.6'], {'maximumOutboxBytes': 16}, [
        *drawn(listening=True), post('subscribe', SUBSCRIBE), answered('subscribe', result(1, 'null')),
        post('one', tick(3, 1)), answered('one', result(3, 'null')),
        post('two', tick(5, 2)), expect('two', 200, orLost=True), until('connections', 0),
        post('after', request(7, 'echo', '"x"')), refused('after', 404, 'connection-unknown')]),
    ('to a client that does not listen, a request that opens a subscription is answered SUBSCRIPTION_UNSUPPORTED',
     ['15.8', '9.2.6'], None, [
         *drawn(), post('subscribe', SUBSCRIBE), answered('subscribe', failure(1, SUBSCRIPTION_UNSUPPORTED))]),
    ('to a client that does not listen, a request of the server\'s own fails before it goes', ['15.8'], None, [
        *drawn(), post('ask', request(1, 'ask', 'null')), answered('ask', failure(1, PROCEDURE_FAILED)),
        {'report': 'exception'}]),
]

# ── WebSocket ───────────────────────────────────────────────────────────────────────────────────

# RFC 6455 §1.3's own key, and the accept it gives
KEY, ACCEPT = 'dGhlIHNhbXBsZSBub25jZQ==', 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
SMALL = {'maximumEnvelopeBytes': 64, 'chunkBytes': 64, 'windowBytes': 128}
CONTINUATION, BINARY = 0x0, 0x2
NORMAL, GOING_AWAY, TOO_BIG = 1000, 1001, 1009


def upgrade(on='socket'):
    """An opening handshake, on a socket the exchange keeps as its WebSocket once answered 101."""
    head = (f'GET / HTTP/1.1\r\nhost: {{host}}\r\nupgrade: websocket\r\nconnection: Upgrade\r\n'
            f'sec-websocket-key: {KEY}\r\nsec-websocket-version: 13\r\n\r\n')
    return [{'send': {'head': head}, 'on': on},
            expect(on, 101, fields={'upgrade': 'websocket', 'sec-websocket-accept': ACCEPT})]


def message(on, **sent):
    return {'send': sent, 'on': on}


def heard(on, within=None, **received):
    return {'expect': received, 'on': on, **({'within': within} if within else {})}


ECHO_HEADER, ECHO_PAYLOAD = ECHO.split(' | ')

websocket = [
    ('a binary message is one envelope, and its answer one binary message', ['15.2'], {}, [
        *upgrade(), message('socket', binary=ECHO), heard('socket', envelope=result(1, '"x"'))]),
    ('a message in fragments is one envelope', ['15.2'], {}, [
        *upgrade(), message('socket', frames=[
            {'opcode': BINARY, 'fin': False, 'payload': ECHO_HEADER},
            {'opcode': CONTINUATION, 'fin': True, 'payload': ECHO_PAYLOAD}]),
        heard('socket', envelope=result(1, '"x"'))]),
    ('a text message is no envelope: it is reported ENVELOPE_MALFORMED, and answered nothing', ['15.2'], {}, [
        *upgrade(), message('socket', text='x'), {'report': 1, 'on': 'socket'},
        message('socket', binary=request(3, 'echo', '"y"')), heard('socket', envelope=result(3, '"y"'))]),
    ('a message past the side\'s own limit closes its connection with 1009', ['15.3', '12.2.1'], {'limits': SMALL}, [
        *upgrade(), message('socket', binary=request(1, 'echo', '"' + 'x' * 51 + '"')), heard('socket', close=TOO_BIG)]),
    ('a peer that closes with 1000 is answered 1000, the clean close', ['15.3'], {}, [
        *upgrade(), message('socket', close=NORMAL), heard('socket', close=NORMAL)]),
    ('a server that stops closes its connections with 1001', ['15.3'], {}, [
        *upgrade('first'), *upgrade('second'), {'stop': True},
        heard('first', close=GOING_AWAY), heard('second', close=GOING_AWAY)]),
    # played on the real clock: no clock given reaches the ping the C# side's platform times
    ('a side pings its peer every heartbeat', ['15.3'], {'options': {'heartbeat': 200}, 'realTime': True}, [
        *upgrade(), heard('socket', within=1000, ping=True), heard('socket', within=1000, ping=True)]),
    ('a peer that leaves a ping unanswered is dropped', ['15.3'],
     {'options': {'heartbeat': 200}, 'realTime': True, 'answersPings': False}, [
         *upgrade(), heard('socket', within=1000, ping=True), heard('socket', within=2000, end=True)]),
]

# responses as a server may cut them, which every side's reader reads alike
responses = [
    ('a body by its length', ['48 54 54 50 2F 31 2E 31 20 32 30 30 20 4F 4B 0D 0A',
                              text('Content-Type: application/prs.bead\r\nContent-Length: 3\r\n\r\n') + ' 01 02 03'],
     200, {'content-type': BEAD, 'content-length': '3'}, '01 02 03'),
    ('a body in chunks, cut across reads', [text('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nab'),
                                            text('c\r\n2\r\nde\r\n0\r\n\r\n')],
     200, {'transfer-encoding': 'chunked'}, text('abcde')),
    ('a field cut across reads, its name in any case', [text('HTTP/1.1 204 No Content\r\nBEAD-Refusal: bu'),
                                                        text('sy\r\n\r\n')],
     204, {'bead-refusal': 'busy'}, ''),
]

document = {
    '$schema': 'schemas/transports.schema.json',
    '$comment': [
        "Bead's transports' cases: what a server of the interop service (interop-service.json) does at its transport's edge, over HTTP and over WebSocket, with what a peer of the test's own sends it, played by every implementation's tests against its own server.",
        'A step is what the test does — send, close, until — or what the server under test does next — expect, report. send writes a request to a socket of its own, opened for the exchange it names with on: head, its octets as text, in which {host} is the server\'s host and port and {token} the token captured; body, its octets in hexadecimal. close drops that socket.',
        'expect reads the response on the exchange it names: its status; its fields, by name in any case, each its value, null for one absent, {"shape"} for a value of that shape, {"capture", "shape"} to keep it under that name; its body, exactly, in hexadecimal; or envelope, the one envelope it holds, as conversations.json expects one; or batch, the envelopes of a batch in order. A response is read by its content-length, or de-chunked, as responses checks every reader. orLost true lets the exchange be lost instead, its socket ending before any status, as a request handed on may be when its connection closes (spec 15.7).',
        'Over WebSocket, an exchange answered 101 keeps its socket as a WebSocket. send then writes a message: binary, in hexadecimal; text; frames, each with its opcode, its fin and its payload; or close and its code; every frame masked, as a client\'s is. expect then reads the next thing the server sends on it: envelope, one binary message holding that envelope; binary, its bytes; close, a close frame and its code; ping, a ping; end, the socket ended. The peer answers every ping with a pong, unless its case says answersPings false. within bounds an expect\'s wait, in milliseconds. stop stops the server under test. A case marked realTime plays on the real clock what no clock given reaches.',
        'until waits, on the real clock and within a patience, for a gauge of the transport, which both sides name alike, to reach its value. report is the next thing the server reports to its application, as in conversations.json.',
        'Before each send and close, and at the end, the server reported nothing a case does not expect.',
        'A step may move time, on the clock the server is given (decision 0011): until timer waits, on the real clock and within a patience, for a timer armed on it, due exactly that many milliseconds from now; advance steps it that many milliseconds from due to due — it settles the side, takes the earliest timer due within them, sets both readings to its due, fires it, settles, and so on, then sets the readings to their end — and follows an until timer since the last send, expect or advance; wall moves the wall clock alone, forward or back. wallClock is where the wall clock starts.',
        'options, where given, are the server\'s bounds by the names sections 15.3 and 15.12 give them, and its hosts, origins and isProxyTrusted; any other is its default, as defaults states them, in milliseconds for a time. limits, where given, are its router\'s, as in conversations.json.',
        'Shapes: token, 16 bytes in base64url without padding; delay-seconds, a number of seconds in ASCII digits.',
        'clauses are the units of spec.md an entry checks: a clause, 9.2; an item of its numbered list, 9.2.5; a row of its table, counted from 1, 15.6.8.',
    ],
    'specVersion': spec_version(),
    'wallClock': '2026-01-01T00:00:00Z',
    'defaults': {
        'maximumConnections': 10_000,
        'maximumConnectionsPerAddress': 64,
        'maximumWaitingExchanges': 64,
        'bodyBytesBudget': 268_435_456,
        'maximumBodyBytes': MAXIMUM_ENVELOPE_BYTES,
        'maximumOutboxBytes': 2 * MAXIMUM_ENVELOPE_BYTES,
        'maximumWait': 30_000,
        'exchangeTimeout': 300_000,
        'inactivityTimeout': 300_000,
        'maximumMessageBytes': MAXIMUM_ENVELOPE_BYTES,
        'heartbeat': 30_000,
    },
    'responses': [
        {'name': name, 'pieces': pieces, 'status': status, 'fields': fields, 'body': body}
        for name, pieces, status, fields, body in responses
    ],
    'cases': [
        {'name': name, 'clauses': clauses, 'transport': 'http', **({'options': options} if options else {}), 'steps': steps}
        for name, clauses, options, steps in cases
    ] + [
        {'name': name, 'clauses': clauses, 'transport': 'websocket', **fields, 'steps': steps}
        for name, clauses, fields, steps in websocket
    ],
}

with open(ROOT + 'transports.json', 'w', encoding='utf-8', newline='\n') as file:
    json.dump(document, file, ensure_ascii=False, indent=2)
    file.write('\n')

print(len(cases), 'cases over HTTP,', len(websocket), 'over WebSocket,', len(responses), 'responses')
