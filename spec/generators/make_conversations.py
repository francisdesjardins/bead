"""Writes spec/conversations.json: what a server of the interop service does with what a client sends."""
import base64
import hashlib
import hmac
import json
import os
import re
from datetime import datetime

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

# a backslash, which opens a JSON escape, and a JSON string outside ASCII with what a lenient writer escapes
BACKSLASH = chr(92)
OUTSIDE_ASCII = '"Jos' + chr(0xE9) + ' a+b <x>"'


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


def failure(call_id, code, scope=PROTOCOL, credential=None, relays=0, detail=None):
    return {'expect': {'kind': FAILURE, 'callId': call_id,
                       'failure': {'code': code, 'scope': scope, 'relays': relays,
                                   **({'detail': detail} if detail is not None else {})},
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


def on(step, connection):
    return {**step, 'on': connection}


def opened(connection, two_way=True):
    return {'open': connection, **({} if two_way else {'twoWay': False})}


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

SESSION_REQUIRED, CREDENTIAL_UNSUPPORTED = 32, 36

# a token no session holds: the server draws its own from a cryptographic source (13.2)
TOKEN_BYTES = '00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F'

# what an answer announces, by the scheme of its CREDENTIAL block: a session's token, or its end
OPENED, ENDED = 'OPAQUE', 'NONE'

# the schemes the interop server takes, which code 36's detail names (9.2, step 5), in the order of
# their numbers: a request that presents none is always taken, and names no scheme
SCHEMES_TAKEN = 'OPAQUE, JWT, ELSEWHERE'

# what SESSION_REQUIRED's detail says of a credential that does not resolve (9.2, step 5)
NO_CREDENTIAL, DOES_NOT_HOLD = 'no credential came', 'the credential does not hold'


def presenting(call_id, procedure, value, block):
    # a request whose CREDENTIAL block, the last, follows its procedure; a token named between angle
    # brackets stands for its 16 bytes
    length = sum(16 if part.startswith('<') else 1 for part in block.split())
    return json_request(call_id, procedure, value, flags=0x08, words=3 + length // 4, tail=block)


def opaque(token):
    # an OPAQUE block: the scheme 1, the length 16, then the token, its bytes or its name
    return f'00 01 00 10  {token}'


def named(step, token):
    # an answer that announced OPAQUE, whose token a later send presents as <token>
    return {**step, 'token': token}


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

# ── 13.8 and 13.9: a JWT's session, its end, and the key set ────────────────────────────────────

# where the server's wall clock starts, and the second it is
WALL_CLOCK = '2026-01-01T00:00:00Z'
START = int(datetime.fromisoformat(WALL_CLOCK.replace('Z', '+00:00')).timestamp())

# what the interop server verifies a JWT with, its test keys among it
CREDENTIALS = SERVICE['credentials']['jwt']
AUDIENCE = CREDENTIALS['audience']
ISSUERS = {key['algorithm']: key['issuer'] for key in CREDENTIALS['keys']}
HS_KEY = next(key['jwk'] for key in CREDENTIALS['keys'] if key['algorithm'] == 'HS256')
KEY_SET = CREDENTIALS['keySet']
# the issuers the key set answers for: one that answers its key at every ask, one that answers it at
# the first ask alone, under the first one's kid, one whose ask never settles, and one whose one key
# carries no kid
SET, ROTATED, STALLED, KIDLESS = KEY_SET['issuers']
SET_KEY = SET['keys'][0]['jwk']
ROTATED_KEY = ROTATED['keys'][0]['jwk']
KIDLESS_KEY = KIDLESS['keys'][0]['jwk']
assert ROTATED_KEY['kid'] == SET_KEY['kid'] and ROTATED_KEY['k'] != SET_KEY['k'] and STALLED['keys'] == []
assert len(KIDLESS['keys']) == 1 and 'kid' not in KIDLESS_KEY

# the most calls that wait for one issuer's deadline at once (13.8): the conversation that passes them
# plays two waiting, each on a connection of its own, and a third on another
WAITING_CALLS = KEY_SET['maximumWaitingCalls']
assert WAITING_CALLS == 2

# how long the key set takes to answer, on the server's clock, as its words say; an ask's deadline,
# a minute after it went; and how long the keys an answer gave are held, ten minutes from it (13.8)
KEY_SET_WAIT = 1_000
KEY_SET_DEADLINE = 60_000
KEYS_HELD = 600_000

LEEWAY = 60_000
HOUR, DAY = 3_600, 86_400


def base64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def unbase64url(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def compact(value):
    """JSON as a token carries it: no space, its members in the order written, ASCII escaped."""
    return json.dumps(value, separators=(',', ':')).encode('ascii')


def access(issuer=ISSUERS['HS256'], *, exp=START + HOUR, iat=START, jti, aud=AUDIENCE, sub='grace'):
    """An access token's claims (RFC 9068 §2.2), exp and iat in seconds since the epoch."""
    return {'iss': issuer, 'sub': sub, 'aud': aud, 'exp': exp, 'iat': iat, 'jti': jti, 'client_id': 'bead-interop-client'}


def hs256(claims, jwk=HS_KEY):
    """A JWS signed with HMAC-SHA256 (RFC 7518 §3.2), with Python's own hmac, typed at+jwt, and named
    by its key's kid when the key has one."""
    header = {'alg': 'HS256', 'typ': 'at+jwt', **({'kid': jwk['kid']} if 'kid' in jwk else {})}
    signing_input = base64url(compact(header)) + '.' + base64url(compact(claims))
    signature = hmac.new(unbase64url(jwk['k']), signing_input.encode('ascii'), hashlib.sha256).digest()
    return signing_input + '.' + base64url(signature)


def jwt(token):
    # a JWT block: the scheme 2, the token's length, its characters, then zero bytes to the next word
    data = token.encode('ascii')
    return f'00 02 {word(len(data), 2)}  {hexadecimal(data + bytes(-len(data) % 4))}'


def subscribing(call_id, block):
    # a request to ticks that opens a subscription, presenting a credential: SUBSCRIPTION and CREDENTIAL
    return json_request(call_id, 'ticks', 'null', flags=0x18, words=3 + len(block.split()) // 4, tail=block)


def ticked(call_id, value, block):
    return presenting(call_id, 'tick', '{"value":%d}' % value, block)


def wall(milliseconds):
    return {'wall': milliseconds}


# an ES256 token is a constant, by choice: signed once under RFC 7515's A.3 key, verified with its
# public half before it was written here. Its claims: the ES256 issuer's, for grace, issued at the wall
# clock's start, expiring an hour later
ES_GRACE = (
    'eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCJ9.eyJpc3MiOiJodHRwczovL2VzMjU2LmludGVyb3AuYmVhZC5leGFtcGxlIiwic3ViIjoiZ3JhY2UiLC'
    'JhdWQiOiJiZWFkLWludGVyb3AiLCJleHAiOjE3NjcyMjkyMDAsImlhdCI6MTc2NzIyNTYwMCwianRpIjoiYXQtZXMyNTYtMDAwMSIsImNsaWVudF9pZCI6ImJlYW'
    'QtaW50ZXJvcC1jbGllbnQifQ.6NqV2v1wyZaEZsGSXU7imZm9zUu5Gsz21sxFIERvcEVzVJqKM9itRJcY5TgeSoaQrZgk25S-8pie9bxFcudB8g')
assert json.loads(unbase64url(ES_GRACE.split('.')[1])) == access(ISSUERS['ES256'], jti='at-es256-0001')

# the HS256 issuer's tokens for grace: one ending an hour after the wall clock's start, one two hours
# after, one at the start, one 30 days after, and one for another audience
HS_GRACE = hs256(access(jti='at-hs256-0001'))
HS_RENEWED = hs256(access(exp=START + 2 * HOUR, jti='at-hs256-0002'))
HS_AT_START = hs256(access(exp=START, iat=START - HOUR, jti='at-hs256-0003'))
HS_30_DAYS = hs256(access(exp=START + 30 * DAY, jti='at-hs256-0004'))
HS_OTHER_AUDIENCE = hs256(access(aud='bead-other', jti='at-hs256-0005'))

# the HS256 issuer's token for carol, another session of that issuer than grace's
HS_CAROL = hs256(access(sub='carol', jti='at-hs256-0007'))

# the key set's first issuer's tokens, under its one key: one its kid names, and one whose kid no key
# names, which that key would verify
SET_GRACE = hs256(access(SET['issuer'], jti='at-keys-0001'), SET_KEY)
SET_UNNAMED = hs256(access(SET['issuer'], jti='at-keys-0002'), {**SET_KEY, 'kid': '2026-01'})

# the rotated issuer's tokens, under its key: one whose kid the first issuer's key names too, and one
# whose kid no key names
ROTATED_GRACE = hs256(access(ROTATED['issuer'], jti='at-rotated-0001'), ROTATED_KEY)
ROTATED_UNNAMED = hs256(access(ROTATED['issuer'], jti='at-rotated-0002'), {**ROTATED_KEY, 'kid': '2026-01'})

# the kid-less issuer's token, under its one key, which carries no kid
KIDLESS_GRACE = hs256(access(KIDLESS['issuer'], jti='at-kidless-0001'), KIDLESS_KEY)
assert 'kid' not in json.loads(unbase64url(KIDLESS_GRACE.split('.')[0]))

# the stalled issuer's token, whose kid no key names: its signature is never reached
STALLED_GRACE = hs256(access(STALLED['issuer'], jti='at-stalled-0001'), {**SET_KEY, 'kid': '2026-01'})

# tokens of issuers the key set does not name, whose kid no key names: one of an issuer nothing names,
# and one of the HS256 issuer, whose key the application gave
UNNAMED_ISSUER = 'https://unnamed.interop.bead.example'
assert UNNAMED_ISSUER not in {*ISSUERS.values(), *(entry['issuer'] for entry in KEY_SET['issuers'])}
UNNAMED_GRACE = hs256(access(UNNAMED_ISSUER, jti='at-unnamed-0001'), {**SET_KEY, 'kid': '2026-01'})
HS_UNNAMED = hs256(access(jti='at-hs256-0006'), {**HS_KEY, 'kid': '2026-01'})

# the ends these tokens give their sessions, from the wall clock's start, in milliseconds
HOUR_END = HOUR * 1000 + LEEWAY
assert HOUR_END == 3_660_000
assert 30 * DAY * 1000 + LEEWAY - (2 ** 31 - 1) == 444_576_353

# the identifier HS_GRACE resolves to, which endSession ends, and its issuer, which endSessionsOf
# ends every session of
GRACE = '{"issuer":"%s","sub":"grace"}' % ISSUERS['HS256']
HS_ISSUER = '{"issuer":"%s"}' % ISSUERS['HS256']


def slow(call_id, milliseconds):
    """slow, which answers once that many milliseconds passed on the server's clock: a way to move it
    past an instant no timer of the side's own is sure to be armed for."""
    return [json_request(call_id, 'slow', '{"milliseconds":%d}' % milliseconds), armed(milliseconds),
            advance(milliseconds), result(call_id, str(milliseconds))]


def jwt_conversations():
    """A JWT taken and refused, its session kept while it bounds a subscription, timed to its end,
    renewed, ended by its identifier or its issuer, and its key found through the key set, for as
    many calls at once as it lets wait."""
    return [
        ('a request presenting a JWT that verifies runs in its credential\'s session, never its connection\'s',
         ['9.2.5', '13.1', '13.5', '13.8'], None, [
             login(1, 'ada'), result(1, '"ada"', OPENED),
             presenting(3, 'whoami', 'null', jwt(HS_GRACE)), result(3, '"grace"'),
             presenting(5, 'whoami', 'null', jwt(ES_GRACE)), result(5, '"grace"'),
             json_request(7, 'whoami', 'null'), result(7, '"ada"')]),
        # its exp at the wall clock's start: it holds 60 s past it, and not a millisecond more; echo admits
        # anyone, so its refusal is the credential's
        ('a JWT holds while the server\'s wall clock is before its exp plus 60 s, a millisecond either side',
         ['9.2.5', '13.8.9', '13.9.1'], None, [
             presenting(1, 'whoami', 'null', jwt(HS_AT_START)), result(1, '"grace"'),
             wall(LEEWAY - 1),
             presenting(3, 'whoami', 'null', jwt(HS_AT_START)), result(3, '"grace"'),
             wall(1),
             presenting(5, 'echo', '"x"', jwt(HS_AT_START)), failure(5, SESSION_REQUIRED, detail=DOES_NOT_HOLD)]),
        ('a JWT for another audience is refused SESSION_REQUIRED, whatever its procedure requires', ['9.2.5', '13.8.11'], None, [
            presenting(1, 'echo', '"x"', jwt(HS_OTHER_AUDIENCE)), failure(1, SESSION_REQUIRED, detail=DOES_NOT_HOLD),
            presenting(3, 'echo', '"y"', jwt(HS_GRACE)), result(3, '"y"')]),
        ('logout, in a credential\'s session, is refused ACCESS_DENIED, and its connection\'s session stays',
         ['9.2.5', '13.5'], None, [
             login(1, 'ada'), result(1, '"ada"', OPENED),
             presenting(3, 'logout', 'null', jwt(HS_GRACE)), failure(3, ACCESS_DENIED),
             json_request(5, 'whoami', 'null'), result(5, '"ada"')]),
        # one subscription per procedure and per session: none, two issuers' sessions, and a later request
        # of one of them, which holds nothing
        ('sessions of one connection subscribing to one procedure each hold their own: its connection\'s, and each credential\'s',
         ['11.3', '13.9'], None, [
             subscribe(1), result(1, 'null'),
             subscribing(3, jwt(HS_GRACE)), result(3, 'null'),
             subscribing(5, jwt(ES_GRACE)), result(5, 'null'),
             subscribing(7, jwt(HS_GRACE)), result(7, 'null'),
             tick(9, 1), notification(1, '1'), result(9, 'null'),
             ticked(11, 2, jwt(HS_GRACE)), notification(3, '2'), result(11, 'null'),
             ticked(13, 3, jwt(ES_GRACE)), notification(5, '3'), result(13, 'null')]),
        # one sub under two issuers names two sessions: the second, ending later, moves nothing of the
        # first's end, and its tick reaches no subscription of the first's
        ('two issuers presenting one sub are two sessions: the second moves nothing of the first\'s subscription',
         ['11.3', '13.9'], None, [
             subscribing(1, jwt(ES_GRACE)), result(1, 'null'),
             presenting(3, 'whoami', 'null', jwt(HS_RENEWED)), result(3, '"grace"'),
             ticked(5, 1, jwt(HS_RENEWED)), result(5, 'null'),
             ticked(7, 2, jwt(ES_GRACE)), notification(1, '2'), result(7, 'null'),
             armed(HOUR_END), advance(HOUR_END), failure(1, SESSION_REQUIRED)]),
        # renewed by whoami under the same identifier, its end moves to the later token's, its timer armed
        # anew from a fresh reading: the first token no longer holds, and its subscription does
        ('a JWT renewed under a subscription keeps it past the first token\'s end, until the renewed one\'s',
         ['11.3', '13.6', '13.9', '13.9.3'], None, [
             subscribing(1, jwt(HS_GRACE)), result(1, 'null'),
             armed(HOUR_END),
             presenting(3, 'whoami', 'null', jwt(HS_RENEWED)), result(3, '"grace"'),
             armed(HOUR_END + HOUR * 1000), advance(HOUR_END),
             presenting(5, 'whoami', 'null', jwt(HS_GRACE)), failure(5, SESSION_REQUIRED, detail=DOES_NOT_HOLD),
             ticked(7, 1, jwt(HS_RENEWED)), notification(1, '1'), result(7, 'null'),
             armed(HOUR * 1000), advance(HOUR * 1000), failure(1, SESSION_REQUIRED)]),
        ('a credential\'s session whose end lies past a timer\'s ceiling is timed in two steps, the wall clock read again at each',
         ['13.9', '13.9.3'], None, [
             subscribing(1, jwt(HS_30_DAYS)), result(1, 'null'),
             armed(2 ** 31 - 1), advance(2 ** 31 - 1),
             ticked(3, 1, jwt(HS_30_DAYS)), notification(1, '1'), result(3, 'null'),
             armed(444_576_353), advance(444_576_353), failure(1, SESSION_REQUIRED)]),
        # the wall clock set back takes effect at the next due, which reads it again and arms what is left
        ('a wall clock set by hand takes effect at the next due: a credential\'s session\'s end is read again, never counted down',
         ['13.9.2', '13.9.3'], None, [
             subscribing(1, jwt(HS_GRACE)), result(1, 'null'),
             armed(HOUR_END), wall(-1_000_000), advance(HOUR_END),
             armed(1_000_000), advance(1_000_000), failure(1, SESSION_REQUIRED)]),
        # endSession, on a connection of its own, ends grace's session under the HS256 issuer on both
        # connections that keep it, and nothing of the ES256 issuer's; the token still holds, and opens
        # it anew, since ending a session refuses no credential
        ('a credential\'s session ended by its identifier ends on every connection that keeps it, and a credential that still holds opens it anew',
         ['13.6', '13.9'], None, [
             opened('client'), opened('other'), opened('admin'),
             on(subscribing(1, jwt(HS_GRACE)), 'client'), on(result(1, 'null'), 'client'),
             on(subscribing(3, jwt(ES_GRACE)), 'client'), on(result(3, 'null'), 'client'),
             on(subscribing(1, jwt(HS_GRACE)), 'other'), on(result(1, 'null'), 'other'),
             on(json_request(1, 'endSession', GRACE), 'admin'), on(result(1, 'null'), 'admin'),
             on(failure(1, SESSION_REQUIRED), 'client'), on(failure(1, SESSION_REQUIRED), 'other'),
             on(ticked(5, 1, jwt(HS_GRACE)), 'client'), on(result(5, 'null'), 'client'),
             on(subscribing(7, jwt(HS_GRACE)), 'client'), on(result(7, 'null'), 'client'),
             on(ticked(9, 2, jwt(HS_GRACE)), 'client'), on(notification(7, '2'), 'client'), on(result(9, 'null'), 'client'),
             on(ticked(11, 3, jwt(ES_GRACE)), 'client'), on(notification(3, '3'), 'client'), on(result(11, 'null'), 'client')]),
        # endSessionsOf, on a connection of its own, ends every session of the HS256 issuer on every
        # connection that keeps one, grace's and carol's, and nothing of the ES256 issuer's under the
        # same sub; grace's token still holds, and its tick runs in a session no longer kept
        ('every credential\'s session of an issuer, ended by that issuer, ends on every connection that keeps one, and nothing of another issuer\'s, whatever its sub',
         ['13.6', '13.9'], None, [
             opened('client'), opened('other'), opened('admin'),
             on(subscribing(1, jwt(HS_GRACE)), 'client'), on(result(1, 'null'), 'client'),
             on(subscribing(3, jwt(ES_GRACE)), 'client'), on(result(3, 'null'), 'client'),
             on(subscribing(1, jwt(HS_CAROL)), 'other'), on(result(1, 'null'), 'other'),
             on(json_request(1, 'endSessionsOf', HS_ISSUER), 'admin'), on(result(1, 'null'), 'admin'),
             on(failure(1, SESSION_REQUIRED), 'client'), on(failure(1, SESSION_REQUIRED), 'other'),
             on(ticked(5, 1, jwt(ES_GRACE)), 'client'), on(notification(3, '1'), 'client'), on(result(5, 'null'), 'client'),
             on(ticked(7, 2, jwt(HS_GRACE)), 'client'), on(result(7, 'null'), 'client'),
             on(ticked(3, 3, jwt(HS_CAROL)), 'other'), on(result(3, 'null'), 'other')]),
        # the key set answers on the server's clock: a call presenting none, sent meanwhile, is answered first
        ('a call presenting none, sent while a JWT call resolves, is answered first', ['9.2'], None, [
            presenting(1, 'whoami', 'null', jwt(SET_GRACE)),
            json_request(3, 'echo', '"x"'), result(3, '"x"'),
            armed(KEY_SET_WAIT), advance(KEY_SET_WAIT), result(1, '"grace"')]),
        # each ask waits on the server's clock, and the rotated issuer answers its key at its first ask
        # alone, so a second ask would leave its token no key: a call whose kid the keys held name is
        # answered at once, inside each wait, which shows that no ask went before the minute's end. A
        # kid none names, a second after the first ask answered, waits for that ask's deadline, 59 s
        # on, then for the ask that goes then, its own
        ('a key set is asked once a minute at most for an issuer: a kid only it names is taken from its answer, then from the keys held; a kid none names within the minute waits for its end and the ask then, no ask going before, and is refused once that ask\'s answer does not name it',
         ['13.8', '13.8.4'], None, [
             presenting(1, 'whoami', 'null', jwt(ROTATED_GRACE)),
             json_request(3, 'echo', '"x"'), result(3, '"x"'),
             armed(KEY_SET_WAIT), advance(KEY_SET_WAIT), result(1, '"grace"'),
             presenting(5, 'whoami', 'null', jwt(ROTATED_GRACE)), result(5, '"grace"'),
             presenting(7, 'echo', '"y"', jwt(ROTATED_UNNAMED)), armed(KEY_SET_DEADLINE - KEY_SET_WAIT),
             advance(KEY_SET_DEADLINE // 2 - KEY_SET_WAIT),
             presenting(9, 'whoami', 'null', jwt(ROTATED_GRACE)), result(9, '"grace"'),
             armed(KEY_SET_DEADLINE // 2), advance(KEY_SET_DEADLINE // 2),
             presenting(11, 'whoami', 'null', jwt(ROTATED_GRACE)), result(11, '"grace"'),
             armed(KEY_SET_WAIT), advance(KEY_SET_WAIT),
             failure(7, SESSION_REQUIRED, detail=DOES_NOT_HOLD)]),
        # the call cancelled waited for the deadline, which no call waits for once it left: no ask goes
        # then, so the next kid none names, past it, asks at once, and is refused on that ask's answer.
        # A side that asked at that deadline would find call 11 waiting on an ask that went before it
        # came, and hold it for the next deadline; one that asked within the minute would leave call 7
        # no key
        ('a call waiting for its issuer\'s minute to end leaves on its cancel, answered nothing, and no ask goes at a deadline no call waits for',
         ['10.2', '13.8'], None, [
             presenting(1, 'whoami', 'null', jwt(ROTATED_GRACE)),
             json_request(3, 'echo', '"x"'), result(3, '"x"'),
             armed(KEY_SET_WAIT), advance(KEY_SET_WAIT), result(1, '"grace"'),
             presenting(5, 'echo', '"y"', jwt(ROTATED_UNNAMED)), armed(KEY_SET_DEADLINE - KEY_SET_WAIT),
             advance(KEY_SET_DEADLINE // 2 - KEY_SET_WAIT),
             presenting(7, 'whoami', 'null', jwt(ROTATED_GRACE)), result(7, '"grace"'),
             cancel(5),
             presenting(5, 'whoami', 'null', jwt(ROTATED_GRACE)), result(5, '"grace"'),
             *slow(9, KEY_SET_DEADLINE // 2),
             presenting(11, 'echo', '"z"', jwt(ROTATED_UNNAMED)), armed(KEY_SET_WAIT), advance(KEY_SET_WAIT),
             failure(11, SESSION_REQUIRED, detail=DOES_NOT_HOLD)]),
        # the key set fails at once when asked for an issuer it does not name, so an ask would show as
        # PROCEDURE_FAILED; none goes, and nothing waits on the server's clock
        ('a key set is asked for the issuers it names alone: a token of another, whose kid no key names, is refused at once, asking nothing, the application\'s own issuers among them',
         ['9.2.5', '13.8', '13.8.4'], None, [
             presenting(1, 'echo', '"x"', jwt(UNNAMED_GRACE)), failure(1, SESSION_REQUIRED, detail=DOES_NOT_HOLD),
             presenting(3, 'echo', '"y"', jwt(HS_UNNAMED)), failure(3, SESSION_REQUIRED, detail=DOES_NOT_HOLD),
             presenting(5, 'whoami', 'null', jwt(HS_GRACE)), result(5, '"grace"')]),
        # the stalled issuer's ask never settles: it fails at its deadline, for the call that waits on
        # it; a call that came meanwhile and cancelled left its own wait alone; past the deadline, the
        # next ask goes at once, with a deadline of its own
        ('a key set\'s ask that never settles fails at its deadline, a minute after it went, for the calls that wait on it, and the next ask goes',
         ['9.2.5', '10.2', '13.8'], None, [
             presenting(1, 'whoami', 'null', jwt(STALLED_GRACE)), armed(KEY_SET_DEADLINE), advance(KEY_SET_DEADLINE // 2),
             presenting(3, 'whoami', 'null', jwt(STALLED_GRACE)), cancel(3),
             armed(KEY_SET_DEADLINE // 2), advance(KEY_SET_DEADLINE // 2),
             failure(1, PROCEDURE_FAILED), report('exception'),
             presenting(5, 'whoami', 'null', jwt(STALLED_GRACE)), armed(KEY_SET_DEADLINE), advance(KEY_SET_DEADLINE),
             failure(5, PROCEDURE_FAILED), report('exception')]),
        # the rotated issuer's kid is the first issuer's too: its ask goes all the same, and its key
        # is held beside the first issuer's, which still serves
        ('a kid that another issuer\'s key names asks the key set for the token\'s own issuer, whose answer verifies it',
         ['13.8', '13.8.4'], None, [
             presenting(1, 'whoami', 'null', jwt(SET_GRACE)), armed(KEY_SET_WAIT), advance(KEY_SET_WAIT), result(1, '"grace"'),
             presenting(3, 'whoami', 'null', jwt(ROTATED_GRACE)), armed(KEY_SET_WAIT), advance(KEY_SET_WAIT), result(3, '"grace"'),
             presenting(5, 'whoami', 'null', jwt(SET_GRACE)), result(5, '"grace"')]),
        # the rotated issuer answers its key at the first ask alone: held from its answer, a second in,
        # it serves until ten minutes past that answer, and a millisecond short of them; at them, the
        # token waits on a new ask, whose answer no longer names its kid
        ('a key set\'s keys are held ten minutes from its answer, a millisecond either side: past them, a token they would serve waits on a new ask, whose answer replaces them, a key it no longer answers refused',
         ['13.8', '13.8.4'], None, [
             presenting(1, 'whoami', 'null', jwt(ROTATED_GRACE)), armed(KEY_SET_WAIT), advance(KEY_SET_WAIT), result(1, '"grace"'),
             *slow(3, KEYS_HELD - 1),
             presenting(5, 'whoami', 'null', jwt(ROTATED_GRACE)), result(5, '"grace"'),
             *slow(7, 1),
             presenting(9, 'echo', '"x"', jwt(ROTATED_GRACE)), armed(KEY_SET_WAIT), advance(KEY_SET_WAIT),
             failure(9, SESSION_REQUIRED, detail=DOES_NOT_HOLD)]),
        # the kid-less issuer's key and tokens carry no kid: at a cold start no key of its issuer serves,
        # so its token asks, and is verified by the answer; held ten minutes from it, a second in, they
        # serve until then, and past them the token asks again
        ('a token without a kid, of an issuer the key set names, waits on that issuer\'s keys while none of them serve: at a cold start it asks, and once the keys answered are past their ten minutes it asks again',
         ['13.8', '13.8.4'], None, [
             presenting(1, 'whoami', 'null', jwt(KIDLESS_GRACE)),
             json_request(3, 'echo', '"x"'), result(3, '"x"'),
             armed(KEY_SET_WAIT), advance(KEY_SET_WAIT), result(1, '"grace"'),
             presenting(5, 'whoami', 'null', jwt(KIDLESS_GRACE)), result(5, '"grace"'),
             *slow(7, KEYS_HELD),
             presenting(9, 'whoami', 'null', jwt(KIDLESS_GRACE)), armed(KEY_SET_WAIT), advance(KEY_SET_WAIT),
             result(9, '"grace"')]),
        # the interop key set lets two calls wait for one issuer's deadline at once, and counts no call
        # that waits on its ask. At a cold start three wait on the one ask, none refused. Within the
        # minute two wait for the deadline and a third is refused at once, unreported; a call whose key
        # serves waits for nothing, and a call that leaves frees its place. At the deadline the two wait
        # on the ask then, holding no place, and three more come while it is under way: its answer
        # refuses the two, which it judges, and moves the three onto the deadline, the first two taking
        # the places and the third refused as it moves, as a call that comes after them is. The calls
        # answered at one instant are each on a connection of their own, so that each is expected on
        # its own
        ('a key set lets maximumWaitingCalls calls wait for an issuer\'s deadline at once, a call that waits on its ask never counted: however many wait on an ask, none is refused; one more for the deadline is refused CAPACITY_EXCEEDED at once, and one an answer moves onto a deadline that holds them as it moves, neither reported, while a call whose key serves and a call that comes once one left are not',
         ['8.2', '9.2.5', '13.8'], None, [
             opened('a'), opened('b'), opened('c'), opened('d'),
             on(presenting(1, 'whoami', 'null', jwt(SET_GRACE)), 'a'), armed(KEY_SET_WAIT),
             on(presenting(1, 'whoami', 'null', jwt(SET_GRACE)), 'b'),
             on(presenting(1, 'whoami', 'null', jwt(SET_GRACE)), 'c'),
             armed(KEY_SET_WAIT), advance(KEY_SET_WAIT),
             on(result(1, '"grace"'), 'a'), on(result(1, '"grace"'), 'b'), on(result(1, '"grace"'), 'c'),
             on(presenting(3, 'echo', '"x"', jwt(SET_UNNAMED)), 'a'), armed(KEY_SET_DEADLINE - KEY_SET_WAIT),
             on(presenting(3, 'echo', '"y"', jwt(SET_UNNAMED)), 'b'),
             on(presenting(3, 'echo', '"z"', jwt(SET_UNNAMED)), 'c'), on(failure(3, CAPACITY_EXCEEDED), 'c'),
             on(presenting(5, 'whoami', 'null', jwt(SET_GRACE)), 'c'), on(result(5, '"grace"'), 'c'),
             on(cancel(3), 'a'),
             on(presenting(7, 'echo', '"z"', jwt(SET_UNNAMED)), 'c'),
             armed(KEY_SET_DEADLINE - KEY_SET_WAIT), advance(KEY_SET_DEADLINE - KEY_SET_WAIT), armed(KEY_SET_WAIT),
             on(presenting(5, 'echo', '"x"', jwt(SET_UNNAMED)), 'a'),
             on(presenting(1, 'echo', '"w"', jwt(SET_UNNAMED)), 'd'),
             on(presenting(3, 'echo', '"w"', jwt(SET_UNNAMED)), 'd'),
             armed(KEY_SET_WAIT), advance(KEY_SET_WAIT),
             on(failure(3, SESSION_REQUIRED, detail=DOES_NOT_HOLD), 'b'),
             on(failure(7, SESSION_REQUIRED, detail=DOES_NOT_HOLD), 'c'),
             on(failure(3, CAPACITY_EXCEEDED), 'd'),
             on(presenting(9, 'echo', '"z"', jwt(SET_UNNAMED)), 'c'), on(failure(9, CAPACITY_EXCEEDED), 'c'),
             armed(KEY_SET_DEADLINE - KEY_SET_WAIT), advance(KEY_SET_DEADLINE - KEY_SET_WAIT),
             armed(KEY_SET_WAIT), advance(KEY_SET_WAIT),
             on(failure(5, SESSION_REQUIRED, detail=DOES_NOT_HOLD), 'a'),
             on(failure(1, SESSION_REQUIRED, detail=DOES_NOT_HOLD), 'd')]),
    ]


# the wall clock's start in milliseconds since the epoch, which an ELSEWHERE's end is written against
EPOCH = START * 1000

# an ELSEWHERE's block: the scheme 3 and no bytes, its credential what its transport carried
ELSEWHERE_BLOCK = '00 03 00 00'


def elsewhere(call_id, procedure, value, carried=None):
    # a request presenting ELSEWHERE, beside which its transport carried that credential, or none
    return {**presenting(call_id, procedure, value, ELSEWHERE_BLOCK), **({'carried': carried} if carried else {})}


def carrying(step, carried):
    # a send beside which its transport carried a credential, whatever its envelope presents
    return {**step, 'carried': carried}


def elsewhere_opening(call_id, procedure, data, total, carried):
    # a request that opens a transfer and presents ELSEWHERE: TRANSFER, the total on 8 bytes, then the
    # CREDENTIAL block, the last; its first bytes after
    return carrying(request(call_id, procedure, hexadecimal(data), flags=0x0C, words=6,
                            tail=f'{word(total, 8)}  {ELSEWHERE_BLOCK}'), carried)


def elsewhere_conversations():
    """9.2, step 5, 10.2 and 13.10: an ELSEWHERE, which the interop server's verifier resolves from what
    its transport carried (interop-service.json, credentials.elsewhere): at once, or once the timer a
    value asks for fires on the server's clock, whatever its call's signal, so that a settling can
    come once its call ended. None subscribes, so no credential's session is kept past its call."""
    return [
        # an auth-scheme is compared case-insensitively (RFC 9110 §11.1), and a call presenting none
        # runs in its connection's session, whatever its transport carried
        ('an ELSEWHERE is resolved by the server\'s verifier from what its transport carried, and its call runs in that credential\'s session, never announced: whoami answers the sub it names',
         ['9.2.5', '13.1', '13.10', '15.1'], None, [
             elsewhere(1, 'whoami', 'null', 'Interop sub=ada'), result(1, '"ada"'),
             elsewhere(3, 'whoami', 'null', 'interop sub=bob'), result(3, '"bob"'),
             carrying(json_request(5, 'whoami', 'null'), 'Interop sub=ada'), failure(5, SESSION_REQUIRED)]),
        # echo admits anyone: a credential that does not hold is refused all the same. The first is a
        # bearer token, RFC 6750's own example, of which the verifier's grammar holds nothing
        ('an ELSEWHERE its verifier does not hold is refused SESSION_REQUIRED, whatever its procedure requires, its detail saying the credential does not hold',
         ['9.2.5', '13.5', '13.10'], None, [
             elsewhere(1, 'echo', '"x"', 'Bearer mF_9.B5f-4.1JqM'), failure(1, SESSION_REQUIRED, detail=DOES_NOT_HOLD),
             elsewhere(3, 'echo', '"y"', 'Interop sub=Ada'), failure(3, SESSION_REQUIRED, detail=DOES_NOT_HOLD)]),
        ('an ELSEWHERE whose verifier fails is answered PROCEDURE_FAILED, and reported, never SESSION_REQUIRED',
         ['9.2.5', '13.10'], None, [
             elsewhere(1, 'whoami', 'null', 'Interop fail=true'), failure(1, PROCEDURE_FAILED), report('exception')]),
        # the first timer is armed before the cancel goes, so its verifier was asked; the second call on
        # call id 1 still resolves when the first one's settling comes, which must not answer it
        ('a verifier that settles late, its call cancelled meanwhile: the call is answered nothing, its call id is free again at once, and the late settling is dropped in silence',
         ['9.4', '10.2', '13.10'], None, [
             elsewhere(1, 'whoami', 'null', 'Interop sub=ada, after=1000'), armed(1000), cancel(1),
             elsewhere(1, 'whoami', 'null', 'Interop sub=bob, after=2000'), armed(2000), advance(1000),
             armed(1000), advance(1000), result(1, '"bob"')]),
        ('a verifier that fails late, its call cancelled meanwhile, is dropped in silence: neither answered nor reported',
         ['10.2'], None, [
             elsewhere(1, 'whoami', 'null', 'Interop fail=true, after=1000'), armed(1000), cancel(1),
             armed(1000), advance(1000), json_request(3, 'echo', '"y"'), result(3, '"y"')]),
        ('a connection that closes while a credential resolves ends its call, and its verifier\'s late failure is dropped in silence',
         ['9.10'], None, [
             elsewhere(1, 'whoami', 'null', 'Interop fail=true, after=1000'), armed(1000), {'close': True},
             advance(1000)]),
        # 9.2: a resolution holds back no other call of its connection
        ('a call presenting none, sent while an ELSEWHERE call resolves, is answered first', ['9.2'], None, [
            elsewhere(1, 'whoami', 'null', 'Interop sub=ada, after=1000'), armed(1000),
            json_request(3, 'echo', '"y"'), result(3, '"y"'),
            armed(1000), advance(1000), result(1, '"ada"')]),
        # an opening of 64 bytes carries 40 of its payload behind 24 of header; nothing goes out before
        # the echo's answer, no credit among it
        ('a transfer\'s opening presenting ELSEWHERE gets no credit until its verifier settles', ['12.3', '12.3.1'], CHUNKED, [
            elsewhere_opening(1, 'echo', ECHOED[:40], 100, 'Interop sub=ada, after=1000'), armed(1000),
            json_request(3, 'echo', '"y"'), result(3, '"y"'),
            armed(1000), advance(1000), credited(1, 100),
            chunk_in(1, 40, ECHOED[40:88], False), chunk_in(1, 88, ECHOED[88:], True),
            result_opening(1, ECHOED[:28], 100),
            credit_in(1, 100), chunk_out(1, 28, ECHOED[28:76], False), chunk_out(1, 76, ECHOED[76:], True)]),
        # the second comes while its end lies a second ahead, and settles as the wall clock reaches it
        ('an ELSEWHERE whose end the wall clock has reached as its verifier settles does not hold, and one a millisecond short of it holds',
         ['13.10'], None, [
             elsewhere(1, 'whoami', 'null', f'Interop sub=ada, after=1000, end={EPOCH + 1001}'), armed(1000),
             advance(1000), result(1, '"ada"'),
             elsewhere(3, 'whoami', 'null', f'Interop sub=bob, after=1000, end={EPOCH + 2000}'), armed(1000),
             advance(1000), failure(3, SESSION_REQUIRED, detail=DOES_NOT_HOLD)]),
    ]

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
    # 17: a json payload read as section 17.5 reads it, and written in its canonical form, whichever side
    # answers; each of these reaches another outcome on a side that reads and writes as its platform does
    ('a payload outside ASCII is answered in its own characters, none escaped', ['17.7.3'], None, [
        json_request(1, 'echo', OUTSIDE_ASCII), result(1, OUTSIDE_ASCII)]),
    ('a payload is answered in its canonical form, whatever form it came in', ['17.8'], None, [
        json_request(1, 'echo', '{ "b" : "Jos' + BACKSLASH + 'u00e9", "a" : 1.0 }'),
        result(1, '{"a":1,"b":"Jos' + chr(0xE9) + '"}')]),
    ('a payload that starts with a byte order mark is answered PAYLOAD_UNDECODABLE', ['17.2.1', '17.5.2'], None, [
        request(1, 'echo', 'EF BB BF 31'), failure(1, PAYLOAD_UNDECODABLE)]),
    ('a payload that names a member twice is answered PAYLOAD_UNDECODABLE', ['17.2.1', '17.5.4'], None, [
        json_request(1, 'echo', '{"a":1,"a":2}'), failure(1, PAYLOAD_UNDECODABLE)]),
    ('a payload whose string holds a byte that is not UTF-8 is answered PAYLOAD_UNDECODABLE', ['17.2.1', '17.5.1'], None, [
        request(1, 'echo', '22 FF 22'), failure(1, PAYLOAD_UNDECODABLE)]),
    ('a payload whose string holds a surrogate alone is answered PAYLOAD_UNDECODABLE', ['17.2.1', '17.5.5'], None, [
        json_request(1, 'echo', '"' + BACKSLASH + 'uD800"'), failure(1, PAYLOAD_UNDECODABLE)]),
    ('a payload nested past 64 is answered PAYLOAD_UNDECODABLE', ['17.2.1', '17.5.7'], None, [
        json_request(1, 'echo', '[' * 65 + ']' * 65), failure(1, PAYLOAD_UNDECODABLE)]),
    ('a payload whose number is past a double is answered PAYLOAD_UNDECODABLE', ['17.2.1', '17.5.6'], None, [
        json_request(1, 'echo', '1E400'), failure(1, PAYLOAD_UNDECODABLE)]),
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
    ('a procedure that requires a session refuses a call in none with SESSION_REQUIRED', ['13.5'], None, [
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
    # 13.8 and 13.9: a JWT's session, kept while it bounds a subscription, and its end
    *jwt_conversations(),
    # 9.2, step 5: a request's credential resolves to its call's session, which its admission reads
    ('a request presenting its connection\'s OPAQUE is taken, and runs in that session', ['9.2.5', '13.1', '13.4'], None, [
        login(1, 'ada'), named(result(1, '"ada"', OPENED), 'ada'),
        presenting(3, 'whoami', 'null', opaque('<ada>')), result(3, '"ada"'),
        presenting(5, 'logout', 'null', opaque('<ada>')), result(5, 'null', ENDED)]),
    # echo admits anyone: a credential that does not hold is refused all the same
    ('a request presenting an OPAQUE no session holds is refused SESSION_REQUIRED, whatever its procedure requires, and its connection\'s session stays',
     ['9.2.5', '13.5'], None, [
         presenting(1, 'echo', '"x"', opaque(TOKEN_BYTES)), failure(1, SESSION_REQUIRED),
         login(3, 'ada'), result(3, '"ada"', OPENED),
         presenting(5, 'echo', '"y"', opaque(TOKEN_BYTES)), failure(5, SESSION_REQUIRED),
         json_request(7, 'whoami', 'null'), result(7, '"ada"')]),
    ('a request presenting another connection\'s OPAQUE is refused SESSION_REQUIRED: a token holds on its own connection alone',
     ['9.2.5', '13.2'], None, [
         opened('client'), opened('other'),
         on(login(1, 'ada'), 'client'), on(named(result(1, '"ada"', OPENED), 'ada'), 'client'),
         on(login(1, 'bob'), 'other'), on(named(result(1, '"bob"', OPENED), 'bob'), 'other'),
         on(presenting(3, 'whoami', 'null', opaque('<ada>')), 'other'), on(failure(3, SESSION_REQUIRED), 'other'),
         on(presenting(5, 'whoami', 'null', opaque('<bob>')), 'other'), on(result(5, '"bob"'), 'other'),
         on(presenting(3, 'whoami', 'null', opaque('<ada>')), 'client'), on(result(3, '"ada"'), 'client')]),
    ('a request presenting the OPAQUE of a session ended is refused SESSION_REQUIRED', ['9.2.5', '13.4'], None, [
        login(1, 'ada'), named(result(1, '"ada"', OPENED), 'ada'),
        json_request(3, 'logout', 'null'), result(3, 'null', ENDED),
        presenting(5, 'echo', '"x"', opaque('<ada>')), failure(5, SESSION_REQUIRED),
        json_request(7, 'echo', '"y"'), result(7, '"y"')]),
    # login opens its connection's session whatever its call presents, under a token drawn anew
    ('a request presenting the OPAQUE of a session opened anew under a new token is refused SESSION_REQUIRED',
     ['9.2.5', '13.2', '13.4'], None, [
         login(1, 'ada'), named(result(1, '"ada"', OPENED), 'ada'),
         presenting(3, 'login', '{"name":"bob"}', opaque('<ada>')), named(result(3, '"bob"', OPENED), 'bob'),
         presenting(5, 'whoami', 'null', opaque('<ada>')), failure(5, SESSION_REQUIRED),
         presenting(7, 'whoami', 'null', opaque('<bob>')), result(7, '"bob"')]),
    # a scheme the server takes none of is refused after its procedure is known and before its
    # admission, whatever its length
    ('a credential scheme to come is answered CREDENTIAL_UNSUPPORTED, its detail naming the schemes the server takes, before its admission',
     ['9.2.4', '9.2.5'], None, [
         presenting(1, 'echo', '"x"', '00 04 00 00'), failure(1, CREDENTIAL_UNSUPPORTED, detail=SCHEMES_TAKEN),
         presenting(3, 'whoami', 'null', 'FF FF 00 02  01 02  00 00'),
         failure(3, CREDENTIAL_UNSUPPORTED, detail=SCHEMES_TAKEN),
         presenting(5, 99, '{}', '00 07 00 00'), failure(5, PROCEDURE_UNKNOWN)]),
    # a.b.c reads as no token (13.8, step 1): a credential that came and does not hold
    ('a JWT that does not verify is refused SESSION_REQUIRED, whatever its procedure requires, its detail saying one came and did not hold',
     ['9.2.5', '13.8.1'], None, [
         presenting(1, 'echo', '"x"', '00 02 00 05  61 2E 62 2E 63  00 00 00'),
         failure(1, SESSION_REQUIRED, detail=DOES_NOT_HOLD)]),
    # echo admits anyone: an ELSEWHERE that carried nothing is refused all the same, and its verifier
    # is never asked
    ('an ELSEWHERE whose transport carried nothing is refused SESSION_REQUIRED, whatever its procedure requires, its detail saying no credential came',
     ['9.2.5', '15.1'], None, [
         elsewhere(1, 'echo', '"x"'), failure(1, SESSION_REQUIRED, detail=NO_CREDENTIAL)]),
    *elsewhere_conversations(),
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
    ('an opening that carries no byte of its payload is answered CHUNK_INVALID', ['12.3', '12.3.3'], CHUNKED, [
        opening(1, 'echo', b'', 100), failure(1, CHUNK_INVALID)]),
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

# the relay's options a conversation sets, by its name
RELAY_OPTIONS = {}


def credentials_through_a_relay():
    """14: what a relay does with the credential a request presents — its table, its first step, the
    route it cannot carry, and leg B's header — with the interop service's HS256 issuer and audience."""
    # the interop service's audience, and another a destination may be registered with, which no
    # credential names
    audience, other = AUDIENCE, 'bead-other'
    taken = SCHEMES_TAKEN
    # a credential its transport carried: RFC 6750's own example, its auth-scheme included
    bearer = 'Bearer mF_9.B5f-4.1JqM'
    elsewhere = '00 03 00 00'

    def as_jwt(token):
        return {'scheme': 'JWT', 'token': token}

    as_elsewhere = {'scheme': 'ELSEWHERE'}

    def to(call_id, value, block, destination=DEVICE, carried=None, procedure='echo'):
        # a request that names a destination, then presents a credential: its DESTINATION block, then
        # its CREDENTIAL block, the last; a token named between angle brackets stands for its 16 bytes
        length = sum(16 if piece.startswith('<') else 1 for piece in block.split())
        step = json_request(call_id, procedure, value, flags=0x0A, words=4 + length // 4,
                            tail=f'{word(destination, 4)}  {block}')
        return on({**step, **({'carried': carried} if carried else {})}, 'client')

    def leg_b_presenting(call_id, value, credential=None, carried=None, connection='device', procedure='echo'):
        # the request leg B sends: what it presents in its CREDENTIAL block, and what its transport
        # carried beside it
        step = command(call_id, procedure, value)
        step['expect'].update({'flags': 0x08, 'credential': credential} if credential else {})
        return {**on(step, connection), **({'carried': carried} if carried else {})}

    def crosses(call_id, leg_b_call_id, value, *leg_b, connection='device', answer_value=None):
        # leg B's request expected, then answered by its destination, and that answer crossing back
        answered = value if answer_value is None else answer_value
        return [*leg_b, on(answer(leg_b_call_id, answered), connection), on(result(call_id, answered), 'client')]

    def registered_as(destination, audience_=None, connection='device', call_id=1):
        value = json.dumps({'destination': destination, **({'audience': audience_} if audience_ else {})},
                           separators=(',', ':'))
        return [on(json_request(call_id, 'register', value), connection), on(result(call_id, str(destination)), connection)]

    def logged_in_as_ada(call_id=1):
        return [on(login(call_id, 'ada'), 'client'), on(named(result(call_id, '"ada"', OPENED), 'ada'), 'client')]

    def opened_as(connection, **declared):
        return {'open': connection, **declared}

    def refused_with(call_id, code, detail=None):
        return on(failure(call_id, code, detail=detail), 'client')

    def with_relay(options, conversation):
        # a conversation whose server's relay takes these options
        RELAY_OPTIONS[conversation[0]] = options
        return conversation

    # the HS256 issuer's tokens for carol: one that holds, and one an hour expired
    token = hs256(access(sub='carol', jti='at-relay-0001'))
    expired = hs256(access(sub='carol', exp=START - HOUR, iat=START - 2 * HOUR, jti='at-relay-0002'))
    # a JWT whose parts do not read: its aud names nothing
    unreadable = '00 02 00 05  61 2E 62 2E 63  00 00 00'
    no_credential_came, does_not_hold = NO_CREDENTIAL, DOES_NOT_HOLD

    # leg B's header with this token: the prefix, the service and the procedure, then its CREDENTIAL
    # block; the largest payload an envelope of 1,024 bytes holds behind it
    leg_b_header = 12 + 4 + len(token) + -len(token) % 4
    fits = 1024 - leg_b_header
    assert 12 + fits + 1 <= 1024, 'a payload a byte past it fits behind a header that presents none'

    relayed_conversations = [
        # 14.2's table, row by row
        ('a call presenting none or OPAQUE crosses a relay to leg B presenting none, over any leg B, what its transport carried staying at the relay',
         ['14.2.1', '14.3.1', '14.7'], None, [
             opened('client'), opened('device'), opened_as('plain', carries=False, secure=False),
             *logged_in_as_ada(), *registered_as(DEVICE), *registered_as(13, connection='plain'),
             on({**relayed(3, 'echo', '"x"'), 'carried': bearer}, 'client'),
             *crosses(3, 2, '"x"', leg_b_presenting(2, '"x"')),
             to(5, '"y"', opaque('<ada>')), *crosses(5, 4, '"y"', leg_b_presenting(4, '"y"')),
             on(relayed(7, 'echo', '"z"', destination=13), 'client'),
             *crosses(7, 6, '"z"', leg_b_presenting(6, '"z"', connection='plain'), connection='plain')]),
        ('an OPAQUE no session holds is answered SESSION_REQUIRED at a relay\'s first step, before its destination is looked up',
         ['14.3.1'], None, [
             opened('client'), opened('device'), *logged_in_as_ada(), *registered_as(DEVICE),
             to(3, '"x"', opaque(TOKEN_BYTES)), refused_with(3, SESSION_REQUIRED, does_not_hold),
             to(5, '"x"', opaque(TOKEN_BYTES), destination=99), refused_with(5, SESSION_REQUIRED, does_not_hold)]),
        ('a JWT crosses a relay, its same bytes, to a destination whose audience its aud names, read without verifying it: one expired crosses too, for its destination to verify',
         ['14.1', '14.2.2', '14.3.1', '14.3.5'], None, [
             opened('client'), opened('device'), *registered_as(DEVICE, audience),
             to(1, '"x"', jwt(token), carried=bearer),
             *crosses(1, 2, '"x"', leg_b_presenting(2, '"x"', as_jwt(token))),
             to(3, '"y"', jwt(expired)), *crosses(3, 4, '"y"', leg_b_presenting(4, '"y"', as_jwt(expired)))]),
        ('a JWT to a destination of another audience, or of none, is answered DESTINATION_UNREACHABLE: its credential may hold, and its route does not',
         ['14.1', '14.3.5'], None, [
             opened('client'), opened('device'), opened('other'),
             *registered_as(DEVICE, other), *registered_as(13, connection='other'),
             to(1, '"x"', jwt(token)), refused_with(1, DESTINATION_UNREACHABLE),
             to(3, '"x"', jwt(token), destination=13), refused_with(3, DESTINATION_UNREACHABLE)]),
        ('a JWT passes the default admission of a relay that does not verify on its scheme alone: one whose aud does not read learns which destinations exist, and none takes it',
         ['14.3.1', '14.3.2', '14.3.5'], None, [
             opened('client'), opened('device'), *registered_as(DEVICE, audience),
             to(1, '"x"', unreadable, destination=99), refused_with(1, DESTINATION_UNKNOWN),
             to(3, '"x"', unreadable), refused_with(3, DESTINATION_UNREACHABLE)]),
        ('an ELSEWHERE its transport carried crosses a relay to a destination registered with an audience, its credential moved to leg B\'s transport as it came',
         ['14.2.3', '14.3.1', '14.3.5'], None, [
             opened('client'), opened('device'), *registered_as(DEVICE, audience),
             to(1, '"x"', elsewhere, carried=bearer),
             *crosses(1, 2, '"x"', leg_b_presenting(2, '"x"', as_elsewhere, carried=bearer))]),
        ('an ELSEWHERE over a leg B whose transport carries none, or to a destination registered with no audience, is answered DESTINATION_UNREACHABLE, where a JWT crosses in its block',
         ['14.2.2', '14.3.5'], None, [
             opened('client'), opened_as('device', carries=False), opened('other'),
             *registered_as(DEVICE, audience), *registered_as(13, connection='other'),
             to(1, '"x"', elsewhere, carried=bearer), refused_with(1, DESTINATION_UNREACHABLE),
             to(3, '"x"', elsewhere, destination=13, carried=bearer), refused_with(3, DESTINATION_UNREACHABLE),
             to(5, '"y"', jwt(token)), *crosses(5, 2, '"y"', leg_b_presenting(2, '"y"', as_jwt(token)))]),
        ('a JWT or an ELSEWHERE to a leg B in the clear off the machine is answered DESTINATION_UNREACHABLE, nothing tried, where a call presenting none crosses',
         ['14.2.1', '14.3.5'], None, [
             opened('client'), opened_as('device', secure=False), *logged_in_as_ada(), *registered_as(DEVICE, audience),
             to(3, '"x"', jwt(token)), refused_with(3, DESTINATION_UNREACHABLE),
             to(5, '"x"', elsewhere, carried=bearer), refused_with(5, DESTINATION_UNREACHABLE),
             on(relayed(7, 'echo', '"y"'), 'client'), *crosses(7, 2, '"y"', leg_b_presenting(2, '"y"'))]),
        # 14.3, step 1: what the relay neither resolves nor forwards, before its destination is looked up
        ('a credential scheme to come is answered CREDENTIAL_UNSUPPORTED at a relay\'s first step, before its admission and its destination, its detail naming the schemes it takes',
         ['14.3.1'], None, [
             opened('client'), opened('device'), *logged_in_as_ada(), *registered_as(DEVICE, audience),
             to(3, '"x"', '00 04 00 00'), refused_with(3, CREDENTIAL_UNSUPPORTED, taken),
             to(5, '"x"', 'FF FF 00 02  01 02  00 00', destination=99), refused_with(5, CREDENTIAL_UNSUPPORTED, taken)]),
        ('an ELSEWHERE whose transport carried nothing is answered SESSION_REQUIRED at a relay\'s first step, whatever leg A\'s connection\'s session',
         ['14.3.1'], None, [
             opened('client'), opened('device'), *logged_in_as_ada(), *registered_as(DEVICE, audience),
             to(3, '"x"', elsewhere), refused_with(3, SESSION_REQUIRED, no_credential_came),
             to(5, '"x"', elsewhere, destination=99), refused_with(5, SESSION_REQUIRED, no_credential_came)]),
        # 14.3, step 6: leg B's header, with the token's block, leaves an envelope of 1,024 bytes `fits`
        # bytes of payload, and 4 more without it; leg A's request comes whole, past chunkBytes and
        # within maximumEnvelopeBytes, since the server takes no transfer
        ('leg B\'s header counts its credential, call by call, against the smaller of the two legs\' limits, once its route holds',
         ['14.3.5', '14.3.6'], {'maximumEnvelopeBytes': 2048, 'chunkBytes': 1024, 'maximumTransfers': 0}, [
             opened('client'), opened('device'), opened('other'), *logged_in_as_ada(),
             *registered_as(DEVICE, audience), *registered_as(13, other, connection='other'),
             to(3, json_string(fits), jwt(token)),
             *crosses(3, 2, json_string(fits), leg_b_presenting(2, json_string(fits), as_jwt(token)), answer_value='"ok"'),
             to(5, json_string(fits + 1), jwt(token)), refused_with(5, PAYLOAD_TOO_LARGE),
             on(relayed(7, 'echo', json_string(fits + 1)), 'client'),
             *crosses(7, 4, json_string(fits + 1), leg_b_presenting(4, json_string(fits + 1)), answer_value='"ok"'),
             to(9, json_string(fits + 1), jwt(token), destination=13), refused_with(9, DESTINATION_UNREACHABLE)]),
        # 14.3: a relay that verifies, at its first step, against its destinations' audiences
        with_relay({'verifies': True}, ('a relay that verifies answers a JWT that does not hold SESSION_REQUIRED at its first step, before its destination is looked up, and forwards one that holds',
         ['14.3.1'], None, [
             opened('client'), opened('device'), *registered_as(DEVICE, audience),
             to(1, '"x"', jwt(expired)), refused_with(1, SESSION_REQUIRED, does_not_hold),
             to(3, '"x"', unreadable, destination=99), refused_with(3, SESSION_REQUIRED, does_not_hold),
             to(5, '"y"', jwt(token)), *crosses(5, 2, '"y"', leg_b_presenting(2, '"y"', as_jwt(token)))])),
        with_relay({'verifies': True}, ('a relay that verifies answers a JWT that names none of its destinations\' audiences SESSION_REQUIRED, its server\'s own audience not among them until a destination holds it',
         ['13.8.11', '14.3.1'], None, [
             opened('client'), opened('device'), opened('other'), *registered_as(DEVICE, other),
             to(1, '"x"', jwt(token)), refused_with(1, SESSION_REQUIRED, does_not_hold),
             *registered_as(13, audience, connection='other'),
             to(3, '"y"', jwt(token), destination=13),
             *crosses(3, 2, '"y"', leg_b_presenting(2, '"y"', as_jwt(token), connection='other'), connection='other')])),
        with_relay({'verifies': True}, ('a relay that verifies holds the aud it verified to its destination\'s own audience: another is answered DESTINATION_UNREACHABLE',
         ['14.3.5'], None, [
             opened('client'), opened('device'), opened('other'),
             *registered_as(DEVICE, audience), *registered_as(13, other, connection='other'),
             to(1, '"x"', jwt(token), destination=13), refused_with(1, DESTINATION_UNREACHABLE),
             to(3, '"y"', jwt(token)), *crosses(3, 2, '"y"', leg_b_presenting(2, '"y"', as_jwt(token)))])),
        # 14.3, step 1: the admission reads the call's session, which a relay that verifies resolves
        with_relay({'verifies': True, 'beforeRoute': 'requireSession'}, ('a relay that verifies hands its admission the credential\'s session: requireSession admits a JWT that holds, and refuses a call in none',
         ['14.3.1'], None, [
             opened('client'), opened('device'), *registered_as(DEVICE, audience),
             to(1, '"x"', jwt(token)), *crosses(1, 2, '"x"', leg_b_presenting(2, '"x"', as_jwt(token))),
             on(relayed(3, 'echo', '"y"'), 'client'), refused_with(3, SESSION_REQUIRED)])),
        # ACCESS_DENIED, never SESSION_REQUIRED, which would have the client withdraw a credential
        # that may hold (9.2, step 5)
        with_relay({'beforeRoute': 'requireSession'}, ('a relay whose admission is requireSession refuses every credential it forwards without verifying with ACCESS_DENIED, whatever leg A\'s connection\'s session',
         ['9.2.5', '13.5', '14.3.1'], None, [
             opened('client'), opened('device'), *logged_in_as_ada(), *registered_as(DEVICE, audience),
             to(3, '"x"', jwt(token)), refused_with(3, ACCESS_DENIED),
             to(5, '"x"', elsewhere, carried=bearer), refused_with(5, ACCESS_DENIED),
             to(7, '"y"', opaque('<ada>')), *crosses(7, 2, '"y"', leg_b_presenting(2, '"y"')),
             on(relayed(9, 'echo', '"z"'), 'client'), *crosses(9, 4, '"z"', leg_b_presenting(4, '"z"'))])),
    ]

    return relayed_conversations


conversations += credentials_through_a_relay()

# a token a send presents is one an earlier step named
for name, _, _, *rest in conversations:
    tokens = set()

    for step in rest[-1]:
        for token in re.findall(r'<([a-z][a-z0-9]*)>', step.get('send', '')):
            assert token in tokens, f'{name}: presents <{token}>, which no step before it named'

        tokens |= {step['token']} if 'token' in step else set()

document = {
    '$schema': 'schemas/conversations.schema.json',
    '$comment': [
        "Bead's conversations: what a server of the interop service (interop-service.json) does with what its clients send, played by every implementation's tests against its own server.",
        'A step is what the test does, or what the server under test does next. send is what the client sends, in hexadecimal as vectors.json writes it; close closes the client\'s connection.',
        'carried, beside a send, is the credential the client\'s transport carried beside that envelope, as the transport hands it on: over HTTP, its Authorization\'s value, its surrounding whitespace removed; beside an expect of a request leg B sends to a destination\'s connection, what leg B\'s transport carried beside it. Absent, it carried none.',
        'token, beside an expect whose answer announced OPAQUE, names the token that answer carried, which is random; a later send of the conversation writes that token, its 16 bytes, as its name between angle brackets, <ada>.',
        'expect is the next envelope the server sends: its kind, its call id, and its payload or its failure; a request, its flags, its service and its procedure too, and credential, the CREDENTIAL block it presents, as vectors.json writes a header\'s, a JWT\'s token a character a byte; none, it presents none. A failure compares its code, its scope and the relays it crossed, and its detail where it gives one, the detail the spec states; elsewhere its detail is informative. credential, on an answer, is the scheme of the CREDENTIAL block it carried, what it announced: OPAQUE for a session\'s token, which is random, NONE for its end; none, it carried no block. A result that opens a transfer gives its total too; a chunk, its offset, whether it is the last, and its payload; a credit, its end.',
        'report is the next thing the server reports to its application: a protocol code, or exception for an error that carries none.',
        'A step may move time, on the clock the server is given (decision 0011): until timer waits, on the real clock and within a patience, for a timer armed on it, due exactly that many milliseconds from now; advance steps it that many milliseconds from due to due, as spec/clocks.json states and holds the test clocks of both sides to, and follows an until timer since the last send, expect or advance; wall moves the wall clock alone, forward or back. wallClock is where the wall clock starts.',
        'A conversation that opens its connections, open, plays them all at once: every other step names its connection, on, but a step that moves time, which is the server\'s, and each connection has its own expectations; one that opens none plays one connection, opened before its first step. twoWay false beside open declares a connection that carries nothing back, as an HTTP client that does not listen; carries false, one whose transport carries no credential beside an envelope, as a WebSocket\'s or a listen\'s batch; secure false, one that reaches off the machine in the clear, neither over TLS nor within the machine. By default a connection carries a credential and is secure. A connection closed and opened again is a new connection under the same name.',
        'Before each send, after close, and at the end, nothing more was sent or reported: what a conversation does not expect, a server does not do.',
        'limits, where given, are the server\'s limits, by the names section 12.2 gives them, in milliseconds for a time; any other is its default. pacing, where given, bounds the queues of its paced subscriptions. relay, where given, sets the options of the server\'s relay: verifies true has it verify what it forwards (decision 0010); beforeRoute names its admission, requireSessionOrCredential by default, or requireSession.',
        'The server is given the interop service\'s credentials: credentials.jwt, its keys, its audience, and its key set with the issuers it answers for, which answers on the server\'s clock as its words say, and with maximumWaitingCalls, the most calls that wait for one issuer\'s deadline at once; and credentials.elsewhere, its verifier, which settles on the server\'s clock as its words say. A server whose limits hold chunkBytes or maximumEnvelopeBytes under 1,024 bytes is given no JWT key and no key set, which section 12.2 forbids beside them, and takes no JWT. A JWT a send presents is written as its characters\' bytes, as any header byte is.',
        'clauses are the units of spec.md an entry checks: a clause, 9.2; an item of its numbered list, 9.2.5; a row of its table, counted from 1, 15.6.8.',
    ],
    'specVersion': spec_version(),
    'wallClock': WALL_CLOCK,
    'conversations': [
        {'name': name, 'clauses': clauses, **({'limits': limits} if limits else {}),
         **({'pacing': rest[0]} if len(rest) > 1 else {}), **({'relay': RELAY_OPTIONS[name]} if name in RELAY_OPTIONS else {}),
         'steps': rest[-1]}
        for name, clauses, limits, *rest in conversations
    ],
}

# written when run, and not when make_metrics.py takes its steps from here
if __name__ == '__main__':
    with open(ROOT + 'conversations.json', 'w', encoding='utf-8', newline='\n') as file:
        json.dump(document, file, ensure_ascii=False, indent=2)
        file.write('\n')

    print(len(conversations), 'conversations')
