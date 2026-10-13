"""Writes spec/transports.json: what a transport's server does at its edge, over HTTP, with what a
peer of the test's own sends it in exact octets."""
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re

from bounds import DEFAULTS
from spec_version import spec_version

# the conformance files sit one folder up from their generators
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '')
# the interop service's API, its one service in its blueprint (decision 0022)
API = json.load(open(ROOT + 'interop-blueprint.json', encoding='utf8'))['services'][0]
SERVICE_ID = API['serviceId']
PROCEDURES = {procedure['procedureName']: procedure['procedureId'] for procedure in API['procedures']}

REQUEST, RESULT, FAILURE, NOTIFICATION = 16, 17, 18, 19
PROTOCOL = 0
DESTINATION_UNREACHABLE, SUBSCRIPTION_UNSUPPORTED, SESSION_REQUIRED, PAYLOAD_TOO_LARGE = 17, 22, 32, 34
PROCEDURE_FAILED, DESTINATION_LOST = 64, 65

BEAD = 'application/prs.bead'
BATCH = 'application/prs.bead-batch'
SLOW = '{"milliseconds":3600000}'
# a page of another origin, which a server answers CORS to when origins names it (spec 15.12)
PAGE = 'https://page.test'


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


# what an answer announces, by the scheme of its CREDENTIAL block: a session's token, or its end
OPENED, ENDED = 'OPAQUE', 'NONE'


def result(call_id, value, credential=None):
    return {'kind': RESULT, 'callId': call_id, 'payload': text(value), **({'credential': credential} if credential else {})}


def failure(call_id, code, scope=PROTOCOL, credential=None, detail=None):
    return {'kind': FAILURE, 'callId': call_id,
            'failure': {'code': code, 'scope': scope, 'relays': 0, **({'detail': detail} if detail is not None else {})},
            **({'credential': credential} if credential else {})}


def notification(call_id, value):
    return {'kind': NOTIFICATION, 'callId': call_id, 'payload': text(value)}


# ── Exchanges ───────────────────────────────────────────────────────────────────────────────────


def pairs(fields):
    """A request's fields in their order: a dict's, or a list of pairs, where a name may come twice."""
    return list(fields.items()) if isinstance(fields, dict) else list(fields or [])


def lines_of(name, value):
    """A field's lines: none when its value is None, a line a value when it is a list, else one."""
    values = [] if value is None else value if isinstance(value, list) else [value]
    return [f'{name}: {each}' for each in values]


def send(on, method, target='/bead', *, fields=None, body=None, host='{host}', length=None, http='HTTP/1.1'):
    """A request, of HTTP/1.1 unless told otherwise, rendered to its octets: its line, its target as
    given, in absolute-form among them, its fields in their order — its host, or none, or several,
    those given, its body's length when it has one or posts, or the length given, written as it is —
    and a socket closed once answered."""
    lines = [f'{method} {target} {http}', *lines_of('host', host)]
    lines += [f'{name}: {value}' for name, value in pairs(fields)]

    # ! a length given takes the place of the one counted: two would be refused by HTTP itself
    if length is not None:
        lines.append(f'content-length: {length}')
    elif body is not None or method in ('POST', 'DELETE'):
        lines.append(f'content-length: {length_of(body or "")}')

    lines.append('connection: close')
    return {'send': {'head': '\r\n'.join(lines) + '\r\n\r\n', **({'body': body} if body else {})}, 'on': on}


def connect(on='connect', *, listen=False, fields=None, host='{host}', body=None):
    # a POST of Bead's type with no token, which draws a connection when it has no body
    return send(on, 'POST', fields={'content-type': BEAD, **({'bead-listen': '?1'} if listen else {}), **(fields or {})},
                host=host, body=body)


def post(on, body, *, fields=None):
    return send(on, 'POST', fields=[('bead-connection-token', '{token}'), ('content-type', BEAD), *pairs(fields)], body=body)


def listen(on, after=None, wait=None, *, fields=None, target='/bead'):
    """A listen at the connection's one URL, its cursor in bead-after and its wait in bead-wait (spec
    15.9), each left out when None and written as given otherwise, a malformed count among them."""
    counts = [(name, value) for name, value in (('bead-after', after), ('bead-wait', wait)) if value is not None]
    return send(on, 'GET', target, fields=[('bead-connection-token', '{token}'), *counts, *pairs(fields)])


def expect(on, status, *, fields=None, **body):
    return {'expect': {'status': status, **({'fields': fields} if fields else {}), **body}, 'on': on}


def gone(on):
    """The 404 marked connection-unknown that ends an exchange or a listen already taken as its
    connection closes (spec 15.7): a close, which the server tells as one, never a refusal."""
    return expect(on, 404, fields={'bead-refusal': 'connection-unknown'}, body='', told=None)


def refused(on, status, refusal, fields=None):
    return expect(on, status, fields={'bead-refusal': refusal, **(fields or {})}, body='')


def unmarked(on):
    """HTTP's own 400, which its server writes as it does: no mark, its body empty, and none of the
    fields every response on the path carries."""
    return expect(on, 400, fields={'bead-refusal': None, 'cache-control': None,
                                   'x-content-type-options': None, 'vary': None,
                                   'access-control-allow-origin': None}, body='')


def drawn(on='connect', *, listening=False, fields=None):
    """A connection drawn, its token captured."""
    return [connect(on, listen=listening, fields=fields), expect(on, 201, fields={
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
# what every answer to an origin the server names carries once that origin is judged, and what one
# to any other carries of it (spec 15.6, 15.12)
CORS = {'access-control-allow-origin': PAGE, 'access-control-expose-headers': '*', 'vary': 'Origin',
        'access-control-allow-credentials': None}
NO_CORS = {'access-control-allow-origin': None, 'access-control-expose-headers': None, 'vary': 'Origin'}
# a preflight's answer, whatever method it asks for: the browser judges its request against it
# (Fetch §4.8)
PREFLIGHT = {**CORS,
             'access-control-allow-methods': 'GET, POST, DELETE',
             'access-control-max-age': '7200', 'cache-control': 'no-store',
             'x-content-type-options': 'nosniff', 'bead-refusal': None}


def preflighted(asked=None):
    """The answer to a preflight from a listed origin (spec 15.12): authorization named, the names the
    preflight asks as they came, then any."""
    return {**PREFLIGHT, 'access-control-allow-headers': ', '.join(['authorization', *([asked] if asked else []), '*'])}


def preflight(on, method, *, origin=PAGE, fields=None, target='/bead', host='{host}'):
    """A CORS-preflight request (Fetch §3.3.2): an OPTIONS naming the method it asks for and the
    fields it would write, a name among them given in several lines when it is."""
    return send(on, 'OPTIONS', target, host=host,
                fields=[('origin', origin), ('access-control-request-method', method), *pairs(fields)])


# a bearer credential, RFC 6750's own example, its auth-scheme included
BEARER = 'Bearer mF_9.B5f-4.1JqM'
# what a 503 busy carries besides its mark
BUSY = {'retry-after': {'shape': 'delay-seconds'}}
# what SESSION_REQUIRED's detail says of an ELSEWHERE whose transport carried nothing (9.2, step 5)
NO_CREDENTIAL = 'no credential came'


def elsewhere(call_id):
    # whoami, presenting ELSEWHERE: a CREDENTIAL block of the scheme 3 and no bytes, its credential
    # what the transport carries beside it, which the interop server's verifier reads
    # (interop-service.json, credentials.elsewhere)
    return request(call_id, 'whoami', 'null', flags=0x08, words=4, tail='00 03 00 00')
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
    ('a connect that says it listens is told back that it does, a parameter of its bead-listen ignored', ['15.8', '15.6.2'], None, [
        connect(listen=True), expect('connect', 201, fields={'bead-listen': '?1'}),
        connect('parameter', fields={'bead-listen': '?1;x'}), expect('parameter', 201, fields={'bead-listen': '?1'})]),
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
    # 15.5: a request's Authorization, which the transport hands on with it, and two refused
    ('a request carries its credential in its Authorization, or none in an empty one, and is handed on as any other',
     ['15.5'], None, [
         *drawn(), post('bearer', ECHO, fields={'authorization': BEARER}), answered('bearer', result(1, '"x"')),
         post('empty', request(3, 'echo', '"y"'), fields={'authorization': ''}), answered('empty', result(3, '"y"'))]),
    ('a POST with two Authorization fields is refused 400, marked, and hands the router nothing', ['15.5', '15.6.4'], None, [
        *drawn(), post('twice', ECHO, fields=[('authorization', BEARER), ('authorization', BEARER)]),
        refused('twice', 400, 'malformed'),
        post('once', ECHO, fields={'authorization': BEARER}), answered('once', result(1, '"x"'))]),
    # the verifier holds a value of its grammar alone, so whoami answers only if its auth-scheme came
    # with it and the spaces and tabs around it went
    ('a request presenting ELSEWHERE hands the verifier its Authorization as it came, its auth-scheme included and its surrounding whitespace removed: whoami answers the sub it names',
     ['15.1', '15.5'], None, [
         *drawn(), post('ada', elsewhere(1), fields={'authorization': 'Interop sub=ada'}),
         answered('ada', result(1, '"ada"')),
         post('bob', elsewhere(3), fields={'authorization': ' \tInterop sub=bob\t '}), answered('bob', result(3, '"bob"'))]),
    ('a request presenting ELSEWHERE whose POST carries no Authorization, or an empty one, is answered SESSION_REQUIRED: no other exchange\'s Authorization is read',
     ['15.1', '15.5'], None, [
         connect(fields={'authorization': 'Interop sub=ada'}),
         expect('connect', 201, fields={'bead-connection-token': {'capture': 'token', 'shape': 'token'}}),
         post('none', elsewhere(1)), answered('none', failure(1, SESSION_REQUIRED, detail=NO_CREDENTIAL)),
         post('empty', elsewhere(3), fields={'authorization': ''}),
         answered('empty', failure(3, SESSION_REQUIRED, detail=NO_CREDENTIAL))]),
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
    # 15.6: a request at the path that holds two faults, answered by the first in 15.6's order
    ('a request at the path that holds two faults is answered by the first that applies, in the order section 15.6 gives',
     ['15.5', '15.6'], {'maximumBodyBytes': 64}, [
         send('origin', 'POST', fields={'origin': 'https://elsewhere.test', 'bead-connection-token': 'x',
                                        'content-type': BEAD}, body=ECHO),
         refused('origin', 403, 'origin-refused'),
         send('path', 'POST', '/elsewhere', fields={'bead-connection-token': 'x', 'content-type': BEAD}, body=ECHO),
         refused('path', 404, 'path-unknown'),
         send('method', 'PUT', fields={'bead-connection-token': 'x'}, body='A1'),
         refused('method', 405, 'method-refused', {'allow': 'GET, POST, DELETE'}),
         connect('typed', fields={'content-type': 'text/plain'}, body='A1'), refused('typed', 415, 'type-refused'),
         send('untyped', 'POST', body='A1'), refused('untyped', 415, 'type-refused'),
         send('form', 'POST', fields={'bead-connection-token': 'x', 'content-type': 'text/plain'}, body=ECHO),
         refused('form', 400, 'malformed'),
         send('unknown', 'POST', fields={'bead-connection-token': 'AAAAAAAAAAAAAAAAAAAAAA', 'content-type': 'text/plain'},
              body=ECHO),
         refused('unknown', 404, 'connection-unknown'),
         *drawn(),
         send('both', 'POST', fields=[('bead-connection-token', '{token}'), ('content-type', 'text/plain'),
                                      ('authorization', BEARER), ('authorization', BEARER)], body=ECHO),
         refused('both', 415, 'type-refused'),
         post('large', request(1, 'echo', '"' + 'x' * 60 + '"'),
              fields=[('authorization', BEARER), ('authorization', BEARER)]),
         refused('large', 400, 'malformed'),
         listen('listen', 'x', 0), refused('listen', 409, 'listen-undeclared'),
         post('echo', ECHO), answered('echo', result(1, '"x"'))]),
    # 15.5: a connect carries no request, and its Authorization is read by no one
    ('a connect with two Authorization fields draws its connection: only a POST that presents a token is refused for them',
     ['15.5'], None, [
         send('connect', 'POST', fields=[('content-type', BEAD), ('authorization', BEARER), ('authorization', BEARER)]),
         expect('connect', 201, fields={'bead-connection-token': {'capture': 'token', 'shape': 'token'}}),
         post('echo', ECHO), answered('echo', result(1, '"x"'))]),
    # 15.4: a Content-Length is the number its digits write (RFC 9110 §8.6), so 00 is no body
    ('a request whose Content-Length is 00 has no body: its connect is drawn, and its listen held',
     ['15.4', '15.9'], None, [
         send('connect', 'POST', fields={'content-type': BEAD, 'bead-listen': '?1'}, length='00'),
         expect('connect', 201, fields={'bead-connection-token': {'capture': 'token', 'shape': 'token'},
                                        'bead-listen': '?1'}),
         send('listen', 'GET', fields=[('bead-connection-token', '{token}'), ('bead-after', '0'), ('bead-wait', '0')],
              length='00'),
         expect('listen', 204, body='')]),
    ('a host the server does not take is refused 403, marked', ['15.6.5', '15.12'], {'hosts': ['bead.test']}, [
        connect(host='elsewhere.test'), refused('connect', 403, 'host-refused'),
        connect('taken', host='bead.test'), expect('taken', 201)]),
    # 15.12: the hosts every server takes, each by its host on any port, and no other
    ('a server given no hosts takes localhost, a name under .localhost and an IP literal, on any port or none, and refuses any other host 403, marked, a page that rebinds its name among them',
     ['15.6.5', '15.12'], None, [
         connect('localhost', host='localhost:8080'), expect('localhost', 201),
         connect('under', host='Bead.LocalHost'), expect('under', 201),
         connect('ipv4', host='192.0.2.1:80'), expect('ipv4', 201),
         connect('ipv6', host='[::1]:8443'), expect('ipv6', 201),
         connect('rebound', host='rebind.example:8080', fields={'origin': 'http://rebind.example:8080'}),
         refused('rebound', 403, 'host-refused'),
         connect('suffixed', host='localhost.example'), refused('suffixed', 403, 'host-refused'),
         connect('final', host='localhost.'), refused('final', 403, 'host-refused'),
         connect('short', host='127.1'), refused('short', 403, 'host-refused'),
         connect('octal', host='0177.0.0.1'), refused('octal', 403, 'host-refused'),
         connect('named', host='127.0.0.1.example'), refused('named', 403, 'host-refused'),
         connect('empty', host=''), refused('empty', 403, 'host-refused'),
         send('none', 'POST', http='HTTP/1.0', host=None, fields={'content-type': BEAD}),
         refused('none', 403, 'host-refused')]),
    ('hosts given takes the hosts it lists besides those every server takes, each by its host on any port, in any ASCII case',
     ['15.6.5', '15.12'], {'hosts': ['bead.test']}, [
         connect('bare', host='bead.test'), expect('bare', 201),
         connect('port', host='Bead.Test:8443'), expect('port', 201),
         connect('default', host='bead.test:80'), expect('default', 201),
         connect('loopback', host='localhost'), expect('loopback', 201),
         connect('literal'), expect('literal', 201),
         connect('other', host='rebind.example'), refused('other', 403, 'host-refused')]),
    ('hosts empty takes the hosts every server takes, and no other', ['15.12'], {'hosts': []}, [
        connect('literal'), expect('literal', 201),
        connect('other', host='bead.test'), refused('other', 403, 'host-refused')]),
    ('hosts * takes every host, an empty one and none among them, and makes none of their origins its own: a page that rebinds its name is refused 403 origin-refused, marked',
     ['15.6.5', '15.12'], {'hosts': ['*']}, [
         connect('rebound', host='rebind.example:8080', fields={'origin': 'http://rebind.example:8080'}),
         refused('rebound', 403, 'origin-refused'),
         connect('plain', host='rebind.example:8080'), expect('plain', 201),
         connect('empty', host=''), expect('empty', 201),
         send('none', 'POST', http='HTTP/1.0', host=None, fields={'content-type': BEAD}), expect('none', 201)]),
    # 15.12: a request's authority, an absolute-form target's before its Host (RFC 9112 §3.2.2)
    ('a request whose target is in absolute-form names its host by the target, its Host ignored, a differing one that no client should send among them, and its own origin with it',
     ['15.6.5', '15.12'], None, [
         send('own', 'POST', 'http://{host}/bead', fields={'content-type': BEAD}), expect('own', 201),
         send('rebound', 'POST', 'http://rebind.example:8080/bead', fields={'content-type': BEAD}),
         refused('rebound', 403, 'host-refused'),
         send('hosted', 'POST', 'http://{host}/bead', host='rebind.example:8080',
              fields={'content-type': BEAD, 'origin': 'http://{host}'}), expect('hosted', 201)]),
    # RFC 9112 §3.2: what HTTP refuses of its own, answered as HTTP answers it, before hosts is read;
    # a host is of 15.12's grammar, narrower than RFC 3986's
    ('an HTTP/1.1 request without a Host, with two, or with one that is no host, is answered 400 as HTTP answers it, unmarked, before its host is judged',
     ['15.12'], {'hosts': ['bead.test']}, [
         connect('none', host=None), unmarked('none'),
         connect('two', host=['bead.test', 'elsewhere.test']), unmarked('two'),
         connect('bad', host='bad host'), unmarked('bad'),
         connect('encoded', host='a%41.test'), unmarked('encoded'),
         connect('starred', host='a*b.test'), unmarked('starred'),
         connect('parameter', host='a;b=c'), unmarked('parameter'),
         connect('future', host='[v1.bead]'), unmarked('future'),
         connect('portless', host='localhost:'), unmarked('portless')]),
    # 15.12: a field value of visible ASCII, spaces and tabs, as both HTTP servers take it; the
    # escape, the bell and the delete are the octets themselves, and so is the one past ASCII
    ('a field holding a control character other than HTAB, or an octet past ASCII, is answered 400 unmarked, in Origin and in a field the transport never reads, and no refusal is told; a tab is taken',
     ['15.1', '15.12'], None, [
         connect('escape', fields={'origin': 'http://a.example\x1b[2J'}), unmarked('escape'),
         connect('bell', fields={'x-other': 'a\x07b'}), unmarked('bell'),
         connect('delete', fields={'origin': 'http://a.example\x7f'}), unmarked('delete'),
         connect('latin', fields={'origin': 'http://café.example'}), unmarked('latin'),
         connect('other', fields={'x-other': 'café'}), unmarked('other'),
         connect('tab', fields={'origin': 'http://a.example	b'}), refused('tab', 403, 'origin-refused')]),
    ('an exchange from an origin the server does not take is refused 403, marked', ['15.6.5', '15.12'], None, [
        connect(fields={'origin': 'https://elsewhere.test'}), refused('connect', 403, 'origin-refused')]),
    ('an exchange from an origin the server takes is served', ['15.12'], {'origins': ['https://bead.test']}, [
        connect(fields={'origin': 'https://bead.test'}), expect('connect', 201)]),
    ('a host and an origin are compared in any ASCII case', ['15.12'], {'hosts': ['bead.test']}, [
        connect(host='Bead.Test', fields={'origin': 'http://bead.test'}), expect('connect', 201)]),
    # 15.12: the field read as it came, a serialized origin, never parsed: a browser on an IDN host
    # sends its Host and its Origin in punycode, and a Host of invalid punycode is a host as any other
    ('a Host of invalid punycode is taken under hosts *, and its Origin is none of the server\'s own',
     ['15.6.5', '15.12'], {'hosts': ['*']}, [
         connect('invalid', host='xn--a', fields={'origin': 'http://xn--a'}), refused('invalid', 403, 'origin-refused'),
         connect('dotted', host='xn--a.test'), expect('dotted', 201),
         connect('hyphen', host='xn---bad-cpa.test'), expect('hyphen', 201)]),
    ('hosts names an IDN host in punycode, as the Host field carries it, and refuses a Host of invalid punycode, marked',
     ['15.6.5', '15.12'], {'hosts': ['xn--bad-bma.test']}, [
         connect('idn', host='xn--bad-bma.test', fields={'origin': 'http://xn--bad-bma.test'}), expect('idn', 201),
         connect('port', host='xn--bad-bma.test:8443', fields={'origin': 'https://xn--bad-bma.test:8443'}),
         expect('port', 201),
         connect('invalid', host='xn--a'), refused('invalid', 403, 'host-refused'),
         connect('dotted', host='xn--a.test'), refused('dotted', 403, 'host-refused'),
         connect('hyphen', host='xn---bad-cpa.test'), refused('hyphen', 403, 'host-refused')]),
    ('an Origin of null, of a blob: URL, of ws: or with a path, naming the server\'s host, is none of its own, refused 403, marked; https:// and its Host is its own',
     ['15.6.5', '15.12'], None, [
         connect('null', fields={'origin': 'null'}), refused('null', 403, 'origin-refused'),
         connect('blob', fields={'origin': 'blob:http://{host}/'}), refused('blob', 403, 'origin-refused'),
         connect('ws', fields={'origin': 'ws://{host}'}), refused('ws', 403, 'origin-refused'),
         connect('path', fields={'origin': 'http://{host}/'}), refused('path', 403, 'origin-refused'),
         connect('own', fields={'origin': 'https://{host}'}), expect('own', 201)]),
    # 15.12: CORS, to the origins a server names (Fetch §3.3), and to no other
    ('a preflight from an origin the server names is answered 204, naming that origin, the methods, Authorization, the fields it asks for in its lines joined and any other field, for 7200 seconds, whatever method it asks for',
     ['15.6', '15.6.3', '15.12'], {'origins': [PAGE]}, [
         preflight('connect', 'POST', fields={'access-control-request-headers': 'bead-listen,content-type,traceparent'}),
         expect('connect', 204, fields=preflighted('bead-listen,content-type,traceparent'), body=''),
         preflight('listen', 'GET', fields={'access-control-request-headers': 'bead-after,bead-connection-token,bead-wait'}),
         expect('listen', 204, fields=preflighted('bead-after,bead-connection-token,bead-wait'), body=''),
         preflight('lines', 'GET', fields=[('access-control-request-headers', 'bead-after'),
                                           ('access-control-request-headers', 'bead-wait')]),
         expect('lines', 204, fields=preflighted('bead-after, bead-wait'), body=''),
         preflight('put', 'PUT'), expect('put', 204, fields=preflighted(), body='')]),
    # the 415 is sent whole, since post writes Bead's type before the fields it is given; whoami takes
    # the call id 5, the subscription keeping 1
    ('every answer to an origin the server names carries that origin and exposes every field: a connect, a request with its Authorization, a batch, a refusal and a DELETE',
     ['15.4', '15.5', '15.9', '15.12'], {'origins': [PAGE]}, [
         connect('connect', listen=True, fields={'origin': PAGE}),
         expect('connect', 201, fields={**CORS, 'bead-connection-token': {'capture': 'token', 'shape': 'token'},
                                        'bead-listen': '?1'}),
         post('ada', elsewhere(5), fields={'authorization': 'Interop sub=ada', 'origin': PAGE}),
         expect('ada', 200, fields={**CORS, 'content-type': BEAD}, envelope=result(5, '"ada"')),
         post('subscribe', SUBSCRIBE, fields={'origin': PAGE}), answered('subscribe', result(1, 'null')),
         post('tick', tick(3, 1), fields={'origin': PAGE}), answered('tick', result(3, 'null')),
         listen('listen', 0, 0, fields={'origin': PAGE}),
         expect('listen', 200, fields={**CORS, 'content-type': BATCH, 'bead-sequence': '1'},
                batch=[notification(1, '1')]),
         send('plain', 'POST', fields={'bead-connection-token': '{token}', 'content-type': 'text/plain', 'origin': PAGE},
              body=ECHO),
         expect('plain', 415, fields={**CORS, 'bead-refusal': 'type-refused'}, body=''),
         send('delete', 'DELETE', fields={'bead-connection-token': '{token}', 'origin': PAGE}),
         expect('delete', 204, fields=CORS, body=''),
         post('after', ECHO, fields={'origin': PAGE}),
         expect('after', 404, fields={**CORS, 'bead-refusal': 'connection-unknown'}, body='')]),
    ('a preflight is judged as every request before its origin is answered: by a host the server does not take 403, at another path 404, from an origin it does not take 403, each marked and naming no origin',
     ['15.6', '15.6.5', '15.6.6', '15.12'], {'origins': [PAGE]}, [
         preflight('rebound', 'POST', host='rebind.example'),
         expect('rebound', 403, fields={**NO_CORS, 'bead-refusal': 'host-refused',
                                        'access-control-allow-methods': None}, body=''),
         preflight('elsewhere', 'POST', target='/elsewhere'),
         expect('elsewhere', 404, fields={**NO_CORS, 'bead-refusal': 'path-unknown',
                                          'access-control-allow-methods': None}, body=''),
         preflight('stranger', 'POST', origin='https://elsewhere.test'),
         expect('stranger', 403, fields={**NO_CORS, 'bead-refusal': 'origin-refused',
                                         'access-control-allow-methods': None}, body='')]),
    ('an OPTIONS that is no preflight, or one from the server\'s own origin or from none, is refused 405 as any method but GET, POST or DELETE, its Allow naming them; an exchange from its own origin or from none names no origin',
     ['15.6', '15.6.7', '15.12'], {'origins': [PAGE]}, [
         send('bare', 'OPTIONS', fields={'origin': PAGE}),
         expect('bare', 405, fields={**CORS, 'bead-refusal': 'method-refused', 'allow': 'GET, POST, DELETE',
                                     'access-control-allow-methods': None}, body=''),
         send('own', 'OPTIONS', fields={'origin': 'http://{host}', 'access-control-request-method': 'POST'}),
         expect('own', 405, fields={**NO_CORS, 'bead-refusal': 'method-refused', 'allow': 'GET, POST, DELETE'},
                body=''),
         send('none', 'OPTIONS', fields={'access-control-request-method': 'POST'}),
         expect('none', 405, fields={**NO_CORS, 'bead-refusal': 'method-refused'}, body=''),
         connect('ownconnect', fields={'origin': 'http://{host}'}), expect('ownconnect', 201, fields=NO_CORS),
         connect('noorigin'), expect('noorigin', 201, fields=NO_CORS)]),
    # 15.12: the bounds, past which the server answers 429 or 503
    ('past the connections a server holds, a connect is refused 503, with Retry-After',
     ['15.6.13', '15.12.1'], {'maximumConnections': 1}, [
         *drawn('first'), connect('second'),
         refused('second', 503, 'busy', {'retry-after': {'shape': 'delay-seconds'}})]),
    ('past the connections one address holds, behind a proxy it names, a connect is refused 503',
     ['15.6.13', '15.12', '15.12.2'], {'maximumConnectionsPerAddress': 1, 'trustedProxies': ['127.0.0.1']}, [
         connect('first', fields={'x-forwarded-for': '192.0.2.1'}), expect('first', 201),
         connect('second', fields={'x-forwarded-for': '198.51.100.7, 192.0.2.1'}),
         refused('second', 503, 'busy', BUSY),
         connect('other', fields={'x-forwarded-for': '192.0.2.2'}), expect('other', 201)]),
    # 15.12: the client's address, walked from the right past each proxy a server names, every
    # runner's socket on 127.0.0.1
    ('an X-Forwarded-For from a socket no trustedProxies entry holds is not read: every client behind that proxy is its address, past whose bound a connect is refused 503',
     ['15.6.13', '15.12', '15.12.2'], {'maximumConnectionsPerAddress': 1, 'trustedProxies': ['192.0.2.0/24']}, [
         connect('first', fields={'x-forwarded-for': '192.0.2.1'}), expect('first', 201),
         connect('second', fields={'x-forwarded-for': '192.0.2.2'}), refused('second', 503, 'busy', BUSY)]),
    ('behind proxies it names, the client is the rightmost X-Forwarded-For entry none of them holds, what a client wrote to its left never read',
     ['15.6.13', '15.12', '15.12.2'],
     {'maximumConnectionsPerAddress': 1, 'trustedProxies': ['127.0.0.0/8', '10.0.0.0/8']}, [
         connect('first', fields={'x-forwarded-for': '198.51.100.7, 10.0.0.5'}), expect('first', 201),
         connect('second', fields={'x-forwarded-for': '203.0.113.9, 198.51.100.7, 10.0.0.6'}),
         refused('second', 503, 'busy', BUSY),
         connect('other', fields={'x-forwarded-for': '198.51.100.8'}), expect('other', 201)]),
    ('an X-Forwarded-For entry that is no address ends the walk at the proxy that wrote it',
     ['15.6.13', '15.12', '15.12.2'], {'maximumConnectionsPerAddress': 1, 'trustedProxies': ['127.0.0.1', '10.0.0.0/8']}, [
         connect('first', fields={'x-forwarded-for': 'evil, 10.0.0.5'}), expect('first', 201),
         connect('second', fields={'x-forwarded-for': '10.0.0.5'}), refused('second', 503, 'busy', BUSY)]),
    ('a refusal behind a proxy it names tells the client\'s address, and its port the proxy\'s connection\'s',
     ['15.6.5', '15.12', '15.12.2'], {'trustedProxies': ['127.0.0.1']}, [
         connect('rebound', host='rebind.example', fields={'x-forwarded-for': '203.0.113.9'}),
         refused('rebound', 403, 'host-refused')]),
    ('an X-Forwarded-For entry is read in RFC 7239\'s node forms, its port dropped, and held in one form, an IPv4-mapped one as IPv4 and IPv6 as RFC 5952 writes it; a zone, a name or unknown ends the walk at the proxy',
     ['15.6.13', '15.12', '15.12.2'], {'maximumConnectionsPerAddress': 1, 'trustedProxies': ['127.0.0.1']}, [
         connect('ported', fields={'x-forwarded-for': '192.0.2.7:51234'}), expect('ported', 201),
         connect('mapped', fields={'x-forwarded-for': '::ffff:192.0.2.7'}), refused('mapped', 503, 'busy', BUSY),
         connect('bracketed', fields={'x-forwarded-for': '[2001:DB8::1]:443'}), expect('bracketed', 201),
         connect('expanded', fields={'x-forwarded-for': '2001:db8:0:0:0:0:0:1'}),
         refused('expanded', 503, 'busy', BUSY),
         connect('portless', fields={'x-forwarded-for': '[2001:db8::3]'}), expect('portless', 201),
         connect('zoned', fields={'x-forwarded-for': '2001:db8::2%eth0'}), expect('zoned', 201),
         connect('unknown', fields={'x-forwarded-for': 'unknown'}), refused('unknown', 503, 'busy', BUSY)]),
    ('past the requests waiting on one connection, a request is refused 429, marked',
     ['15.6.12', '15.12.3'], {'maximumWaitingExchanges': 1}, [
         *drawn(), post('slow', request(1, 'slow', SLOW)), expect('slow', 200),
         post('more', request(3, 'slow', SLOW)), refused('more', 429, 'busy')]),
    ('a DELETE ends its connection, and an exchange after it is refused 404', ['15.4', '15.6.3', '15.6.6'], None, [
        *drawn(), send('delete', 'DELETE', fields={'bead-connection-token': '{token}'}), expect('delete', 204, body=''),
        post('after', ECHO), refused('after', 404, 'connection-unknown')]),
    ('a listen held is answered the 404 marked connection-unknown as its client closes the connection, and no refusal is told',
     ['15.1', '15.7'], None, [
         *drawn(listening=True), listen('listen', 0, 60000), until('listens', 1),
         send('delete', 'DELETE', fields={'bead-connection-token': '{token}'}), expect('delete', 204, body=''),
         gone('listen')]),
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
        listen('none', 'x', 0), refused('none', 400, 'malformed'), listen('past', 5, 0), refused('past', 400, 'malformed')]),
    # 15.9: each count an Item of RFC 9651 whose bare item is an Integer, 0 or more, its parameters
    # ignored (§2.3); a parse failure (§4.2) or a violated constraint (§2.2) malformed
    ('a listen whose bead-after does not parse as an Item, is no Integer or is below 0 is refused 400, marked; its parameters are ignored, -0 is 0, and spaces around it are no part of it',
     ['15.6.4', '15.9'], None, [
        *drawn(listening=True),
        listen('empty', '', 0), refused('empty', 400, 'malformed'),
        listen('sixteen', '0' * 16, 0), refused('sixteen', 400, 'malformed'),
        listen('plus', '+0', 0), refused('plus', 400, 'malformed'),
        listen('key', '0;X=1', 0), refused('key', 400, 'malformed'),
        listen('decimal', '0.0', 0), refused('decimal', 400, 'malformed'),
        listen('string', '"0"', 0), refused('string', 400, 'malformed'),
        listen('negative', '-1', 0), refused('negative', 400, 'malformed'),
        listen('minus', '-0', 0), expect('minus', 204, body=''),
        listen('parameter', '0;x=1', '0;y="a;b"'), expect('parameter', 204, body=''),
        listen('spaced', '  0 ', '\t0'), expect('spaced', 204, body='')]),
    ('a listen whose bead-after or bead-wait comes in two field lines, alike or not, or as a list, is refused 400, marked',
     ['15.6.4', '15.9'], None, [
        *drawn(listening=True),
        send('after', 'GET', fields=[('bead-connection-token', '{token}'), ('bead-after', '0'), ('bead-after', '0'),
                                     ('bead-wait', '0')]),
        refused('after', 400, 'malformed'),
        send('wait', 'GET', fields=[('bead-connection-token', '{token}'), ('bead-after', '0'), ('bead-wait', '0'),
                                    ('bead-wait', '1')]),
        refused('wait', 400, 'malformed'),
        listen('list', '0, 0', 0), refused('list', 400, 'malformed'),
        listen('one', 0, 0), expect('one', 204, body='')]),
    ('a listen without bead-after is refused 400, marked, whatever its target holds; one with it is taken whatever its query, and a bead-wait left out is 0',
     ['15.6.4', '15.9'], None, [
        *drawn(listening=True),
        listen('stale', target='/bead?after=0&wait=0'), refused('stale', 400, 'malformed'),
        listen('bare', None, 0), refused('bare', 400, 'malformed'),
        listen('query', 0, 0, target='/bead?after=5&x=1'), expect('query', 204, body=''),
        listen('empty', 0, 0, target='/bead?'), expect('empty', 204, body=''),
        listen('nowait', 0), expect('nowait', 204, body='')]),
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
    # 13.7, 15.7 and 15.9: what times a connection out, and a listen held, on the clock the server is
    # given. Each close is told by the connections gone, before the exchange that finds it gone
    ('a listen with nothing to bring back is held for its wait, and ends 204', ['15.6.3', '15.9'], None, [
        *drawn(listening=True), listen('listen', 0, 1000), armed(1000), advance(1000), expect('listen', 204, body='')]),
    ('a listen is held no longer than the server\'s bound, whatever its wait', ['15.9', '15.12.7'], {'maximumWait': 1000}, [
        *drawn(listening=True), listen('listen', 0, 60000), armed(1000), advance(1000), expect('listen', 204, body='')]),
    ('a connection with no exchange under way closes past its inactivity timeout, a listen held holding it off',
     ['15.1', '15.7', '15.12.9'], {'inactivityTimeout': 5000}, [
         *drawn(listening=True), listen('listen', 0, 10000), armed(10_000), advance(10_000), expect('listen', 204, body=''),
         armed(5000), advance(5000), until('connections', 0),
         post('after', ECHO), refused('after', 404, 'connection-unknown')]),
    # the 200 head goes as the request is handed on; the 404 after the close stands for the cut that
    # follows it
    ('a request unanswered past the exchange timeout closes its connection', ['15.7', '15.12.8'], {'exchangeTimeout': 10_000}, [
        *drawn(), post('slow', request(1, 'slow', SLOW)), expect('slow', 200),
        armed(10_000), advance(10_000), until('connections', 0),
        post('after', request(3, 'echo', '"x"')), refused('after', 404, 'connection-unknown')]),
    ('a connection with no session is closed once silent past the server\'s own connection timeout, 30 s by default',
     ['13.7', '15.12.10'], None, [
         *drawn(), armed(30_000), advance(30_000), until('connections', 0),
         post('after', ECHO), refused('after', 404, 'connection-unknown')]),
    ('a listen held keeps a connection with no session from the server\'s own timeout, which counts anew from the listen\'s end',
     ['13.7', '15.1', '15.9', '15.12.10'], {'connectionInactivityTimeout': 10_000}, [
         *drawn(listening=True), armed(10_000), advance(4000),
         listen('listen', 0, 20000), armed(20_000), advance(20_000), expect('listen', 204, body=''),
         armed(10_000), advance(10_000), until('connections', 0),
         post('after', ECHO), refused('after', 404, 'connection-unknown')]),
    ('a listen held keeps a session\'s connection from its connection timeout, which counts anew from the listen\'s end',
     ['13.7', '15.1', '15.9'], None, [
         *drawn(listening=True), post('login', request(1, 'login', '{"name":"ada","connectionTimeout":10000}')),
         answered('login', result(1, '"ada"', OPENED)), armed(10_000), advance(4000),
         listen('listen', 0, 20000), armed(20_000), advance(20_000), expect('listen', 204, body=''),
         armed(10_000), advance(10_000), until('connections', 0),
         post('after', request(3, 'echo', '"x"')), refused('after', 404, 'connection-unknown')]),
    ('a session\'s connection outlives the server\'s own connection timeout, and once its session ends takes it, counted from the end',
     ['13.7', '15.12.10'], {'connectionInactivityTimeout': 10_000}, [
         *drawn(), post('login', request(1, 'login', '{"name":"ada","sessionTimeout":20000}')),
         answered('login', result(1, '"ada"', OPENED)),
         armed(20_000), advance(15_000),
         post('echo', request(3, 'echo', '"x"')), answered('echo', result(3, '"x"')),
         armed(20_000), advance(20_000), armed(10_000), advance(10_000), until('connections', 0),
         post('after', request(5, 'echo', '"x"')), refused('after', 404, 'connection-unknown')]),
    # ! each listen held first, as listens tells: the session's timer, armed at login, would meet the
    # until before the listen came; the first listen, ended, shows the session timeout restarted by none
    ('a session\'s session timeout ends it during a held listen, which brings back its subscriptions\' failure',
     ['13.6', '13.7', '15.1'], None, [
         *drawn(listening=True), post('subscribe', SUBSCRIBE), answered('subscribe', result(1, 'null')),
         post('login', request(3, 'login', '{"name":"ada","sessionTimeout":15000}')),
         answered('login', result(3, '"ada"', OPENED)),
         listen('first', 0, 5000), until('listens', 1), armed(5000), advance(5000), expect('first', 204, body=''),
         listen('listen', 0, 20000), until('listens', 1), armed(10_000), advance(10_000),
         expect('listen', 200, fields={'content-type': BATCH, 'bead-sequence': '1'},
                batch=[failure(1, SESSION_REQUIRED, credential=ENDED)])]),
]


def interop_jwt():
    """The interop service's HS256 issuer's access token for carol, of RFC 9068's profile, signed with
    HMAC-SHA256 (RFC 7518 §3.2) by Python's own hmac, and its CREDENTIAL block: what a relay forwards
    by default, to a destination registered with the interop's audience."""
    # the issuer, its key RFC 7515's A.1, a published test key, and its audience
    issuer, audience = 'https://hs256.interop.bead.example', INTEROP_AUDIENCE
    secret = 'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow'
    # the wall clock's start, 2026-01-01T00:00:00Z, in seconds since the epoch
    wall = 1_767_225_600

    def base64url(data):
        return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')

    def part(value):
        return base64url(json.dumps(value, separators=(',', ':')).encode('ascii'))

    claims = {'iss': issuer, 'sub': 'carol', 'aud': audience, 'exp': wall + 3600, 'iat': wall, 'jti': 'at-relay',
              'client_id': 'bead-client'}
    signing_input = part({'alg': 'HS256', 'typ': 'at+jwt'}) + '.' + part(claims)
    key = base64.urlsafe_b64decode(secret + '=' * (-len(secret) % 4))
    token = signing_input + '.' + base64url(hmac.new(key, signing_input.encode('ascii'), hashlib.sha256).digest())

    # its block: the scheme 2, its length, its characters a byte each, then zero bytes to a word
    data = token.encode('ascii')
    return token, f'00 02 {word(len(data), 2)}  {hexadecimal(data)}' + ''.join(' 00' for _ in range(-len(data) % 4))


INTEROP_AUDIENCE = 'bead-interop'
RELAY_JWT, RELAY_JWT_BLOCK = interop_jwt()
# the destination a relay's case registers
DESTINATION = 12


def relayed(call_id, block):
    # a request that names the destination, then presents a credential, the last block
    return request(call_id, 'echo', '"x"', flags=0x0A, words=4 + len(block.split()) // 4,
                   tail=f'{word(DESTINATION, 4)}  {block}')


# the request leg B sends the destination: the JWT leg A presented, its same bytes
LEG_B = {'kind': REQUEST, 'callId': 2, 'flags': 0x08, 'serviceId': SERVICE_ID, 'procedureId': PROCEDURES['echo'],
         'payload': text('"x"'), 'credential': {'scheme': 'JWT', 'token': RELAY_JWT}}


def relayed_over_http():
    """14 and 15.9: a relay over HTTP, whose destination is a connection of the peer's: what it sends
    one that listens goes in a batch, which carries a credential in its block alone; one that does
    not listen takes none of its requests; and a request past its outbox is lost with it. Leg A
    presents a JWT, which a server's relay admits by default (14.3, step 1)."""
    audience, destination = INTEROP_AUDIENCE, DESTINATION
    jwt_block, elsewhere_block = RELAY_JWT_BLOCK, '00 03 00 00'

    def as_device(on, method, target='/bead', body=None, fields=None):
        return send(on, method, target, fields=[('bead-connection-token', '{device}'),
                                                *([('content-type', BEAD)] if method == 'POST' else []), *pairs(fields)],
                    body=body)

    # the destination, registered with the audience leg A's JWT names
    registered = as_device('register', 'POST',
                           body=request(1, 'register', '{"destination":%d,"audience":"%s"}' % (destination, audience)))

    return [
        # the destination listens: the relay's request to it waits in its outbox for a listen, which
        # carries no credential beside its envelopes
        ('a relay over HTTP sends a JWT to a destination that listens in its batch, its same bytes, and answers an ELSEWHERE DESTINATION_UNREACHABLE, since a batch carries no credential',
         ['14.2.2', '14.3.5', '15.9'], None, [
             connect('device', listen=True), expect('device', 201, fields={
                 'bead-connection-token': {'capture': 'device', 'shape': 'token'}, 'bead-listen': '?1'}),
             registered, answered('register', result(1, str(destination))),
             *drawn(),
             post('elsewhere', relayed(1, elsewhere_block), fields={'authorization': BEARER}),
             answered('elsewhere', failure(1, DESTINATION_UNREACHABLE)),
             post('jwt', relayed(3, jwt_block)),
             as_device('listen', 'GET', fields=[('bead-after', '0'), ('bead-wait', '60000')]),
             expect('listen', 200, fields={'content-type': BATCH, 'bead-sequence': '1'}, batch=[LEG_B]),
             as_device('answer', 'POST', body='A1 11 00 02  00 00 00 02 | ' + text('"x"')),
             expect('answer', 204, body=''),
             answered('jwt', result(3, '"x"'))]),
        # 14.3.4 and 15.8: a destination over HTTP that does not listen carries no request of the
        # relay's, which answers before trying, and reports nothing
        ('a relay answers DESTINATION_UNREACHABLE for a destination over HTTP that does not listen, nothing tried',
         ['14.3.4', '14.5.4', '15.8'], None, [
             connect('device'), expect('device', 201, fields={
                 'bead-connection-token': {'capture': 'device', 'shape': 'token'}, 'bead-listen': None}),
             registered, answered('register', result(1, str(destination))),
             *drawn(), post('relayed', relayed(1, jwt_block)),
             answered('relayed', failure(1, DESTINATION_UNREACHABLE,
                                         detail=f'destination {destination} is unreachable: its connection carries no request'))]),
        # 14.5.5 and 15.9: leg B's request past the outbox of a destination that listens is one its
        # transport had: the connection closes, and the request is lost with it
        ('a relay\'s request past its destination\'s outbox closes that connection, and leg A is answered DESTINATION_LOST, reported',
         ['14.5.5', '15.9'], {'maximumOutboxBytes': 12}, [
             connect('device', listen=True), expect('device', 201, fields={
                 'bead-connection-token': {'capture': 'device', 'shape': 'token'}, 'bead-listen': '?1'}),
             registered, answered('register', result(1, str(destination))),
             *drawn(), post('relayed', relayed(1, jwt_block)), answered('relayed', failure(1, DESTINATION_LOST)),
             {'report': 'exception'},
             until('connections', 1),
             as_device('after', 'POST', body=request(3, 'echo', '"x"')), refused('after', 404, 'connection-unknown')]),
    ]


cases += relayed_over_http()

# ── WebSocket ───────────────────────────────────────────────────────────────────────────────────

# RFC 6455 §1.3's own key, and the accept it gives
KEY, ACCEPT = 'dGhlIHNhbXBsZSBub25jZQ==', 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
SMALL = {'maximumEnvelopeBytes': 64, 'chunkBytes': 64, 'windowBytes': 128}
CONTINUATION, BINARY = 0x0, 0x2
NORMAL, GOING_AWAY, TOO_BIG = 1000, 1001, 1009


def asked(on='socket', fields=None, *, method='GET', target='/', http='HTTP/1.1', host='{host}',
          upgrade='websocket', connection='Upgrade', key=KEY, version=13, body=None):
    """A request at a WebSocket's address, on a socket of its own: an opening handshake unless told
    otherwise, at the target given, in absolute-form among them. Its host and each field of a
    handshake are left out when None, and written a line a value when a list; the fields given come
    after them, and the body's octets after its head."""
    lines = [f'{method} {target} {http}', *lines_of('host', host), *lines_of('upgrade', upgrade),
             *lines_of('connection', connection), *lines_of('sec-websocket-key', key),
             *lines_of('sec-websocket-version', version), *(f'{name}: {value}' for name, value in pairs(fields))]
    return {'send': {'head': '\r\n'.join(lines) + '\r\n\r\n', **({'body': body} if body else {})}, 'on': on}


# a request that asks no WebSocket: none of a handshake's fields
PLAIN = {'upgrade': None, 'connection': None, 'key': None, 'version': None}


def handshake(on='socket', fields=None, host='{host}', version=13, target='/'):
    """An opening handshake, on a socket of its own, at the target given, naming the host given, of
    the version given, or of none when None, with the fields given besides."""
    return asked(on, fields, target=target, host=host, version=version)


def taken(on='socket'):
    return expect(on, 101, fields={'upgrade': 'websocket', 'sec-websocket-accept': ACCEPT})


def upgrade(on='socket', fields=None, host='{host}', target='/'):
    """A handshake the server takes, its socket kept as its WebSocket once answered 101."""
    return [handshake(on, fields, host, target=target), taken(on)]


# what a WebSocket server's refusal of an upgrade carries besides its mark, as an HTTP exchange's
UPGRADE_REFUSED = {'cache-control': 'no-store', 'x-content-type-options': 'nosniff'}
# a 426 names the protocol it asks for (RFC 9110 §15.5.22), and the version's the one it speaks
UPGRADE_REQUIRED = {**UPGRADE_REFUSED, 'upgrade': 'websocket'}
VERSION_REFUSED = {**UPGRADE_REQUIRED, 'sec-websocket-version': '13'}
# a 405 names the methods it takes (RFC 9110 §15.5.6)
METHOD_REFUSED = {**UPGRADE_REFUSED, 'allow': 'GET, HEAD'}
# a key of 4 bytes, "test", where an opening handshake's is 16
SHORT_KEY = 'dGVzdA=='


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
    ('a WebSocket carries no credential, nor does its upgrade\'s Authorization: a request presenting ELSEWHERE is answered SESSION_REQUIRED',
     ['15.2'], {}, [
         *upgrade(fields={'authorization': 'Interop sub=ada'}), message('socket', binary=elsewhere(1)),
         heard('socket', envelope=failure(1, SESSION_REQUIRED, detail=NO_CREDENTIAL))]),
    # 15.2 and 15.12: what HTTP refuses of its own, answered as HTTP answers it, before hosts is read;
    # a host is of 15.12's grammar, narrower than RFC 3986's
    ('a request at a WebSocket\'s address without a Host, with two, or with one that is no host, is answered 400 as HTTP answers it, unmarked',
     ['15.2', '15.2.1', '15.12'], {'options': {'hosts': ['bead.test']}}, [
         asked('none', host=None), unmarked('none'),
         asked('two', host=['bead.test', 'elsewhere.test']), unmarked('two'),
         asked('bad', host='bad host'), unmarked('bad'),
         asked('encoded', host='a%41.test'), unmarked('encoded'),
         asked('starred', host='a*b.test'), unmarked('starred'),
         asked('parameter', host='a;b=c'), unmarked('parameter'),
         asked('future', host='[v1.bead]'), unmarked('future'),
         asked('portless', host='localhost:'), unmarked('portless')]),
    ('a request at a WebSocket\'s address with a field holding a control character other than HTAB, or an octet past ASCII, is answered 400 unmarked, in Origin and in a field the transport never reads, and no refusal is told; a tab is taken',
     ['15.1', '15.2', '15.2.1', '15.12'], {}, [
         handshake('escape', {'origin': 'http://a.example\x1b[2J'}), unmarked('escape'),
         handshake('bell', {'x-other': 'a\x07b'}), unmarked('bell'),
         handshake('delete', {'origin': 'http://a.example\x7f'}), unmarked('delete'),
         handshake('latin', {'origin': 'http://café.example'}), unmarked('latin'),
         handshake('other', {'x-other': 'café'}), unmarked('other'),
         handshake('tab', {'origin': 'http://a.example	b'}), refused('tab', 403, 'origin-refused', UPGRADE_REFUSED)]),
    # 15.2 and 15.12: a request is taken from the hosts an HTTP exchange is, whatever else it holds,
    # and an upgrade from its origins
    ('a request naming a host the server does not take is refused 403, marked, whatever its method, its upgrade or its form',
     ['15.2', '15.2.2', '15.6.5', '15.12'], {'options': {'hosts': ['bead.test']}}, [
         handshake('elsewhere', host='elsewhere.test'), refused('elsewhere', 403, 'host-refused', UPGRADE_REFUSED),
         asked('post', method='POST', host='elsewhere.test'), refused('post', 403, 'host-refused', UPGRADE_REFUSED),
         asked('plain', host='elsewhere.test', **PLAIN), refused('plain', 403, 'host-refused', UPGRADE_REFUSED),
         asked('short', host='elsewhere.test', key=SHORT_KEY), refused('short', 403, 'host-refused', UPGRADE_REFUSED),
         handshake('eighth', host='elsewhere.test', version=8),
         refused('eighth', 403, 'host-refused', UPGRADE_REFUSED),
         *upgrade('taken', host='bead.test'), message('taken', binary=ECHO), heard('taken', envelope=result(1, '"x"'))]),
    ('an upgrade from an origin the server does not take is refused 403, marked, before its handshake; one from its own origin, or with none, is taken',
     ['15.2', '15.2.7', '15.6.5', '15.12'], {}, [
         handshake('elsewhere', {'origin': 'https://elsewhere.test'}),
         refused('elsewhere', 403, 'origin-refused', UPGRADE_REFUSED),
         *upgrade('own', {'origin': 'http://{host}'}), message('own', binary=ECHO), heard('own', envelope=result(1, '"x"')),
         *upgrade('none'), message('none', binary=ECHO), heard('none', envelope=result(1, '"x"'))]),
    # a WebSocket answers no CORS, which no browser asks of an upgrade (spec 15.12)
    ('an upgrade from an origin the server takes is served', ['15.12'], {'options': {'origins': ['https://bead.test']}}, [
        handshake('socket', {'origin': 'https://bead.test'}),
        expect('socket', 101, fields={'upgrade': 'websocket', 'sec-websocket-accept': ACCEPT,
                                      'access-control-allow-origin': None, 'vary': None}),
        message('socket', binary=ECHO), heard('socket', envelope=result(1, '"x"'))]),
    ('an upgrade\'s host and origin are compared in any ASCII case', ['15.2', '15.2.2', '15.2.7', '15.12'], {'options': {'hosts': ['bead.test']}}, [
        *upgrade(host='Bead.Test', fields={'origin': 'http://bead.test'}), message('socket', binary=ECHO),
        heard('socket', envelope=result(1, '"x"'))]),
    ('an upgrade naming a Host of invalid punycode is taken under hosts *, and its Origin is none of the server\'s own',
     ['15.2', '15.2.2', '15.2.7', '15.6.5', '15.12'], {'options': {'hosts': ['*']}}, [
         handshake('invalid', {'origin': 'http://xn--a'}, host='xn--a'),
         refused('invalid', 403, 'origin-refused', UPGRADE_REFUSED),
         *upgrade('dotted', host='xn--a.test'),
         *upgrade('hyphen', host='xn---bad-cpa.test')]),
    ('an upgrade naming an IDN host that hosts names in punycode is taken, and one naming a Host of invalid punycode refused, marked',
     ['15.2', '15.2.2', '15.2.7', '15.6.5', '15.12'], {'options': {'hosts': ['xn--bad-bma.test']}}, [
         *upgrade('idn', {'origin': 'http://xn--bad-bma.test'}, host='xn--bad-bma.test'),
         message('idn', binary=ECHO), heard('idn', envelope=result(1, '"x"')),
         *upgrade('port', {'origin': 'https://xn--bad-bma.test:8443'}, host='xn--bad-bma.test:8443'),
         handshake('invalid', host='xn--a'), refused('invalid', 403, 'host-refused', UPGRADE_REFUSED),
         handshake('dotted', host='xn--a.test'), refused('dotted', 403, 'host-refused', UPGRADE_REFUSED),
         handshake('hyphen', host='xn---bad-cpa.test'), refused('hyphen', 403, 'host-refused', UPGRADE_REFUSED)]),
    # 15.12: the hosts every server takes, judged before the method and the upgrade
    ('a WebSocket server given no hosts takes localhost, a name under .localhost and an IP literal, and refuses any other host 403, marked, whatever its method, its upgrade or its form',
     ['15.2', '15.2.2', '15.6.5', '15.12'], {}, [
         *upgrade('localhost', host='localhost:8080'), message('localhost', binary=ECHO),
         heard('localhost', envelope=result(1, '"x"')),
         *upgrade('under', host='a.localhost'), *upgrade('ipv6', host='[::1]'),
         handshake('rebound', {'origin': 'http://rebind.example:8080'}, host='rebind.example:8080'),
         refused('rebound', 403, 'host-refused', UPGRADE_REFUSED),
         asked('post', method='POST', host='rebind.example'), refused('post', 403, 'host-refused', UPGRADE_REFUSED),
         asked('final', host='localhost.'), refused('final', 403, 'host-refused', UPGRADE_REFUSED),
         asked('empty', host=''), refused('empty', 403, 'host-refused', UPGRADE_REFUSED),
         asked('old', http='HTTP/1.0', host=None), refused('old', 403, 'host-refused', UPGRADE_REFUSED)]),
    ('an upgrade is taken from the hosts listed besides those every server takes, each by its host on any port',
     ['15.2', '15.2.2', '15.6.5', '15.12'], {'options': {'hosts': ['bead.test']}}, [
         *upgrade('port', host='bead.test:8443'), message('port', binary=ECHO), heard('port', envelope=result(1, '"x"')),
         *upgrade('loopback', host='localhost'),
         handshake('other', host='rebind.example'), refused('other', 403, 'host-refused', UPGRADE_REFUSED)]),
    ('a WebSocket server whose hosts is * takes an upgrade naming any host that carries no Origin, refuses one whose Origin is its authority\'s 403 origin-refused, and judges one naming none by its version',
     ['15.2', '15.2.2', '15.2.5', '15.2.7', '15.6.5', '15.6.11', '15.12'], {'options': {'hosts': ['*']}}, [
         handshake('rebound', {'origin': 'http://rebind.example:8080'}, host='rebind.example:8080'),
         refused('rebound', 403, 'origin-refused', UPGRADE_REFUSED),
         *upgrade('plain', host='rebind.example:8080'),
         *upgrade('empty', host=''),
         asked('old', http='HTTP/1.0', host=None), refused('old', 426, 'upgrade-required', UPGRADE_REQUIRED)]),
    # 15.12: an upgrade's authority, an absolute-form target's before its Host (RFC 9112 §3.2.2)
    ('an upgrade whose target is in absolute-form names its host by the target, its Host ignored',
     ['15.2', '15.2.2', '15.6.5', '15.12'], {}, [
         *upgrade('own', target='http://{host}/'),
         asked('rebound', target='http://rebind.example:8080/'),
         refused('rebound', 403, 'host-refused', UPGRADE_REFUSED),
         *upgrade('hosted', target='http://{host}/', host='rebind.example:8080')]),
    ('an upgrade with an Origin of null, of a blob: URL, of ws: or with a path, naming the server\'s host, is refused 403, marked; one from https:// and its Host is taken',
     ['15.2', '15.2.7', '15.6.5', '15.12'], {}, [
         handshake('null', {'origin': 'null'}), refused('null', 403, 'origin-refused', UPGRADE_REFUSED),
         handshake('blob', {'origin': 'blob:http://{host}/'}), refused('blob', 403, 'origin-refused', UPGRADE_REFUSED),
         handshake('ws', {'origin': 'ws://{host}'}), refused('ws', 403, 'origin-refused', UPGRADE_REFUSED),
         handshake('path', {'origin': 'http://{host}/'}), refused('path', 403, 'origin-refused', UPGRADE_REFUSED),
         *upgrade('own', {'origin': 'https://{host}'}), message('own', binary=ECHO),
         heard('own', envelope=result(1, '"x"'))]),
    # 15.2: the method, then whether a WebSocket is asked at all, then its version, then its form
    ('a request at a WebSocket\'s address of a method but GET or HEAD is refused 405, its Allow naming GET and HEAD, before its handshake is read',
     ['15.2', '15.2.3', '15.6.7'], {}, [
         asked('post', method='POST'), refused('post', 405, 'method-refused', METHOD_REFUSED),
         asked('put', method='PUT'), refused('put', 405, 'method-refused', METHOD_REFUSED),
         asked('options', method='OPTIONS'), refused('options', 405, 'method-refused', METHOD_REFUSED),
         asked('delete', method='DELETE', **PLAIN), refused('delete', 405, 'method-refused', METHOD_REFUSED),
         asked('eighth', method='POST', version=8), refused('eighth', 405, 'method-refused', METHOD_REFUSED)]),
    # ! a HEAD's answer has no body: the peers read it by its length, which both sides write 0
    ('a request at a WebSocket\'s address that asks no WebSocket is answered 426, marked, its Upgrade naming websocket',
     ['15.2', '15.2.4', '15.6.11'], {}, [
         asked('plain', **PLAIN), refused('plain', 426, 'upgrade-required', UPGRADE_REQUIRED),
         asked('unupgraded', upgrade=None), refused('unupgraded', 426, 'upgrade-required', UPGRADE_REQUIRED),
         asked('h2c', upgrade='h2c'), refused('h2c', 426, 'upgrade-required', UPGRADE_REQUIRED),
         asked('versioned', upgrade='websocket/13'), refused('versioned', 426, 'upgrade-required', UPGRADE_REQUIRED),
         asked('unconnected', connection=None), refused('unconnected', 426, 'upgrade-required', UPGRADE_REQUIRED),
         asked('kept', connection='keep-alive'), refused('kept', 426, 'upgrade-required', UPGRADE_REQUIRED),
         asked('eighth', upgrade='h2c', version=8), refused('eighth', 426, 'upgrade-required', UPGRADE_REQUIRED),
         asked('head', method='HEAD'), refused('head', 426, 'upgrade-required', UPGRADE_REQUIRED),
         asked('plainhead', method='HEAD', **PLAIN),
         refused('plainhead', 426, 'upgrade-required', UPGRADE_REQUIRED),
         asked('old', http='HTTP/1.0'), refused('old', 426, 'upgrade-required', UPGRADE_REQUIRED)]),
    # 15.2: an upgrade is judged by its Origin, the field an exchange is, so one of another version,
    # which may carry its origin elsewhere, is never taken, and is told the version before its form
    ('an upgrade of a version but 13, or of none, is refused 426, marked, naming 13 and websocket, whatever its Origin or its key',
     ['15.2', '15.2.5', '15.6.11'], {}, [
         handshake('foreign', {'origin': 'https://elsewhere.test'}, version=8),
         refused('foreign', 426, 'version-refused', VERSION_REFUSED),
         handshake('none', version=8), refused('none', 426, 'version-refused', VERSION_REFUSED),
         handshake('seventh', {'origin': 'https://elsewhere.test'}, version=7),
         refused('seventh', 426, 'version-refused', VERSION_REFUSED),
         handshake('unversioned', version=None), refused('unversioned', 426, 'version-refused', VERSION_REFUSED),
         handshake('padded', version='013'), refused('padded', 426, 'version-refused', VERSION_REFUSED),
         handshake('listed', version='13, 8'), refused('listed', 426, 'version-refused', VERSION_REFUSED),
         asked('short', key=SHORT_KEY, version=8), refused('short', 426, 'version-refused', VERSION_REFUSED)]),
    ('an upgrade whose key is not one field of 16 bytes in base64, whose version comes twice, whose subprotocols are no list of tokens, or that has content, is refused 400, marked, before its origin is judged',
     ['15.2', '15.2.5', '15.2.6', '15.6.4'], {}, [
         asked('keyless', key=None), refused('keyless', 400, 'malformed', UPGRADE_REFUSED),
         asked('unencoded', key='not a key at all!!!!!=='), refused('unencoded', 400, 'malformed', UPGRADE_REFUSED),
         asked('short', key=SHORT_KEY), refused('short', 400, 'malformed', UPGRADE_REFUSED),
         asked('keys', key=[KEY, KEY]), refused('keys', 400, 'malformed', UPGRADE_REFUSED),
         asked('spaced', key='dGhlIHNhbXBs ZSBub25jZQ=='), refused('spaced', 400, 'malformed', UPGRADE_REFUSED),
         asked('versions', version=[13, 13]), refused('versions', 400, 'malformed', UPGRADE_REFUSED),
         asked('protocols', {'sec-websocket-protocol': 'a b'}),
         refused('protocols', 400, 'malformed', UPGRADE_REFUSED),
         asked('content', {'content-length': '5'}, body=text('hello')),
         refused('content', 400, 'malformed', UPGRADE_REFUSED),
         asked('chunked', {'transfer-encoding': 'chunked'}, body=text('5\r\nhello\r\n0\r\n\r\n')),
         refused('chunked', 400, 'malformed', UPGRADE_REFUSED),
         asked('foreign', {'origin': 'https://elsewhere.test'}, key=SHORT_KEY),
         refused('foreign', 400, 'malformed', UPGRADE_REFUSED)]),
    # RFC 9110 §7.8 and §5.3: Upgrade and Connection are lists, read across their lines
    ('an upgrade is taken whose Upgrade lists websocket in any case, in one field line or several, whose Connection names upgrade among other tokens, with no content',
     ['15.2', '15.2.4'], {}, [
         asked('cased', upgrade='WebSocket'), taken('cased'),
         asked('listed', upgrade='h2c, websocket'), taken('listed'),
         asked('lines', upgrade=['h2c', 'websocket']), taken('lines'),
         asked('kept', connection='keep-alive, upgrade'), taken('kept'),
         asked('connections', connection=['keep-alive', 'upgrade']), taken('connections'),
         asked('empty', {'content-length': '0'}), taken('empty'),
         message('empty', binary=ECHO), heard('empty', envelope=result(1, '"x"'))]),
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
    # 13.7: a session's timeouts, which login gives, on the clock the server is given
    ('a session idle past its session timeout ends, its connection staying, its subscriptions with it',
     ['11.7.2', '13.6', '13.7'], {}, [
         *upgrade(),
         message('socket', binary=request(1, 'login', '{"name":"ada","sessionTimeout":10000,"connectionTimeout":20000}')),
         heard('socket', envelope=result(1, '"ada"', OPENED)),
         message('socket', binary=request(3, 'ticks', 'null', flags=0x10)), heard('socket', envelope=result(3, 'null')),
         armed(10_000), advance(10_000), heard('socket', envelope=failure(3, SESSION_REQUIRED, credential=ENDED)),
         message('socket', binary=request(5, 'whoami', 'null')), heard('socket', envelope=failure(5, SESSION_REQUIRED))]),
    ('a session\'s connection, silent past its connection timeout, is closed with 1000, each message starting it anew',
     ['13.7', '15.3'], {}, [
         *upgrade(),
         message('socket', binary=request(1, 'login', '{"name":"ada","connectionTimeout":10000}')),
         heard('socket', envelope=result(1, '"ada"', OPENED)),
         armed(10_000), advance(6000),
         message('socket', binary=request(3, 'echo', '"x"')), heard('socket', envelope=result(3, '"x"')),
         armed(10_000), advance(6000),
         message('socket', binary=request(5, 'echo', '"y"')), heard('socket', envelope=result(5, '"y"')),
         armed(10_000), advance(10_000), heard('socket', close=NORMAL), until('connections', 0)]),
    # 14.5.5 and 14.6: a destination over WebSocket that closes once it had leg B's request
    ('a relay\'s destination over WebSocket that closes as leg B goes is lost: leg A is answered DESTINATION_LOST, reported',
     ['14.5.5', '14.6', '15.3'], {}, [
         *upgrade('client'), *upgrade('device'),
         message('device', binary=request(1, 'register', '{"destination":%d,"audience":"%s"}' % (DESTINATION, INTEROP_AUDIENCE))),
         heard('device', envelope=result(1, str(DESTINATION))),
         message('client', binary=relayed(1, RELAY_JWT_BLOCK)), heard('device', envelope=LEG_B),
         message('device', close=NORMAL), heard('device', close=NORMAL),
         heard('client', envelope=failure(1, DESTINATION_LOST)), {'report': 'exception', 'on': 'client'}]),
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

# ── What a refusal tells ────────────────────────────────────────────────────────────────────────


def field_lines(head, name):
    """The values of a head's field lines of that name, in their order."""
    return [line.split(': ', 1)[1] for line in head.split('\r\n')[1:] if line.lower().startswith(name + ': ')]


def address_of_entry(entry):
    """An X-Forwarded-For entry read as spec 15.12 reads one, in its one form, or None for an entry
    that is no address: a bare IPv4 address, or an IPv6 address without a zone, bare or in brackets,
    each with or without its port (RFC 7239 §6's node unquoted), the port dropped; an IPv4-mapped
    address as its IPv4 address, an IPv6 one as RFC 5952 §4 writes it. Python's parser takes a zone
    and neither brackets nor a port, so the grammar is read here."""
    entry = entry.strip(' \t')

    if '%' in entry:
        return None

    bracketed = re.fullmatch(r'\[([^\[\]]+)\](?::[0-9]{1,5})?', entry)
    ported = re.fullmatch(r'([0-9.]+):[0-9]{1,5}', entry)
    text_, family = (bracketed[1], 6) if bracketed else (ported[1], 4) if ported else (entry, None)

    try:
        address = ipaddress.ip_address(text_)
    except ValueError:
        return None

    if family is not None and address.version != family:
        return None

    if address.version == 6 and address.ipv4_mapped is not None:
        return str(address.ipv4_mapped)

    return address.compressed


def client_address_of(head, options):
    """The client's address (spec 15.12): the socket's, 127.0.0.1, where every runner serves and
    connects, then, while the address reached is one trustedProxies holds, the next X-Forwarded-For
    entry from the right, its lines joined by ", ", when it is an address."""
    networks = [ipaddress.ip_network(entry) for entry in (options or {}).get('trustedProxies', [])]
    lines = field_lines(head, 'x-forwarded-for')
    entries = ', '.join(lines).split(',') if lines else []
    address = '127.0.0.1'

    while entries and any(ipaddress.ip_address(address) in network for network in networks):
        read = address_of_entry(entries.pop())

        if read is None:
            break

        address = read

    return address


def told_of(head, status, reason, options):
    """What a server's transport tells of a refusal it judges of its own (spec 15.1), from the
    request it refused: the authority as it came, an absolute-form target's before its Host (spec
    15.12); the Origin's lines joined by ", "; the client's address, walked past the proxies the
    server names; and its port, {port}, the local port of the socket the step sent from."""
    target = head.split('\r\n', 1)[0].split(' ')[1]
    hosts = field_lines(head, 'host')

    if target.startswith(('http://', 'https://')):
        authority = target.split('://', 1)[1].split('/', 1)[0]
    elif len(hosts) > 1:
        raise ValueError(f'a refusal told of a request with {len(hosts)} Host lines, which HTTP answers itself')
    else:
        authority = hosts[0] if hosts else None

    origins = field_lines(head, 'origin')
    address = client_address_of(head, options)

    return {'status': status, 'reason': reason, 'authority': authority,
            'origin': ', '.join(origins) if origins else None, 'address': address, 'port': '{port}'}


def tell(steps, options):
    """Gives every expect marked in bead-refusal what its server tells of it, from the request its
    exchange sent; one that sets its own, null where nothing is told, keeps it."""
    heads = {}

    for step in steps:
        if 'send' in step and 'head' in step['send']:
            heads[step['on']] = step['send']['head']
            continue

        expectation = step.get('expect', {})
        reason = expectation.get('fields', {}).get('bead-refusal')

        if not isinstance(reason, str) or 'told' in expectation:
            continue

        if step['on'] not in heads:
            raise ValueError(f'a refusal on {step["on"]!r} that no request of its own sent')

        expectation['told'] = told_of(heads[step['on']], expectation['status'], reason, options)


for _name, _clauses, _options, _steps in cases:
    tell(_steps, _options)

for _name, _clauses, _fields, _steps in websocket:
    tell(_steps, _fields.get('options'))

document = {
    '$schema': 'schemas/transports.schema.json',
    '$comment': [
        "Bead's transports' cases: what a server of the interop service (its blueprint, interop-blueprint.json, and what it does, interop-service.json) does at its transport's edge, over HTTP and over WebSocket, with what a peer of the test's own sends it, played by every implementation's tests against its own server.",
        'A step is what the test does — send, close, until — or what the server under test does next — expect, report. send writes a request to a socket of its own, opened for the exchange it names with on: head, its octets as text, in which {host} is the server\'s host and port, an IP literal, which every server takes, and {token}, or any other name a field captured, the value captured under it, each of its characters one octet, its code point (ISO-8859-1), so that a character past U+007F is an octet past ASCII; body, its octets in hexadecimal. close drops that socket.',
        'expect reads the response on the exchange it names: its status; its fields, by name in any case, each its value, null for one absent, {"shape"} for a value of that shape, {"capture", "shape"} to keep it under that name; its body, exactly, in hexadecimal; or envelope, the one envelope it holds, as conversations.json expects one; or batch, the envelopes of a batch in order. told, on a marked refusal, is what the server\'s transport tells of it (spec 15.1): its status, its reason, the request\'s authority and origin as they came, or null, the client\'s address and the port it sent from, {port}, the local port of the socket the exchange was sent on, {host} put in as in a head; null where it tells nothing, as of the 404 that ends an exchange or a listen already taken as its connection closes (spec 15.7). A response is read by its content-length, or de-chunked, as responses checks every reader. orLost true lets the exchange be lost instead, its socket ending before any status, as a request handed on may be when its connection closes (spec 15.7). The cut that follows a head is no step\'s to read: an exchange of that connection after its close, refused 404 connection-unknown, stands for it.',
        'Over WebSocket, an exchange answered 101 keeps its socket as a WebSocket. send then writes a message: binary, in hexadecimal; text; frames, each with its opcode, its fin and its payload; or close and its code; every frame masked, as a client\'s is. expect then reads the next thing the server sends on it: envelope, one binary message holding that envelope; binary, its bytes; close, a close frame and its code; ping, a ping; end, the socket ended. The peer answers every ping with a pong, unless its case says answersPings false. within bounds an expect\'s wait, in milliseconds. stop stops the server under test. A case marked realTime plays on the real clock what no clock given reaches.',
        'until waits, on the real clock and within a patience, for a gauge of the transport, which both sides name alike, to reach its value. report is the next thing the server reports to its application, as in conversations.json.',
        'Before each send and close, and at the end, the server reported nothing, and told no refusal, that a case does not expect.',
        'A step may move time, on the clock the server is given (decision 0011): until timer waits, on the real clock and within a patience, for a timer armed on it, due exactly that many milliseconds from now; advance steps it that many milliseconds from due to due, as spec/clocks.json states and holds the test clocks of both sides to, and follows an until timer since the last send, expect or advance; wall moves the wall clock alone, forward or back. wallClock is where the wall clock starts.',
        'Here an advance goes no further than the due its until timer named, and one meant to fire that timer ends on it: what a timer fired leads to, on the platform\'s threads, reads the clock, which must not have run past it. Here an until timer waits for the earliest timer armed to be due as it names, and the only one so due: one armed before it and not yet cleared, on the platform\'s threads, would fire first.',
        'options, where given, are the server\'s bounds by the names sections 15.3 and 15.12 give them, and its hosts, * among them, and origins, for either transport, and trustedProxies, the HTTP server\'s; any other is its default, as defaults states them, in milliseconds for a time. connectionInactivityTimeout is the HTTP server\'s own connection timeout (spec 13.7), which its server layer holds, not its transport. limits, where given, are its router\'s, as in conversations.json.',
        'Shapes: token, 16 bytes in base64url without padding; delay-seconds, a number of seconds in ASCII digits; http-date, an IMF-fixdate (RFC 9110, section 5.6.7).',
        'clauses are the units of spec.md an entry checks: a clause, 9.2; an item of its numbered list, 9.2.5; a row of its table, counted from 1, 15.6.8.',
    ],
    'specVersion': spec_version(),
    'wallClock': '2026-01-01T00:00:00Z',
    'defaults': DEFAULTS,
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
